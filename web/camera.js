/**
 * Camera page — MacBook capture station.
 * MediaPipe face tracks (multi-person) + dual Internal/Public panes.
 * Identity still from Pass bind — detection is geometry only.
 * Polls decide() every 800ms so Public flips within ~1s after bind/revoke/policy.
 */

import { loadFaceDetector, syncTracksFromVideo, faceTrackerStatus } from "./face-tracker.js";

const API = "/api";
const POLL_MS = 800;
const BIND_KEY = "veil_camera_bound_token";
const tracks = []; // { id, x, y, w, h, token_id, subject, label, policySummary, ... }

const vidIn = document.getElementById("vidInternal");
const vidPub = document.getElementById("vidPublic");
const stillIn = document.getElementById("stillInternal");
const stillPub = document.getElementById("stillPublic");
const boxesIn = document.getElementById("boxesInternal");
const boxesPub = document.getElementById("boxesPublic");
const trackList = document.getElementById("trackList");
const camStatus = document.getElementById("camStatus");
const tokenInput = document.getElementById("tokenInput");
const degradeBanner = document.getElementById("degradeBanner");
const chipInternal = document.getElementById("chipInternal");
const chipPublic = document.getElementById("chipPublic");
const camHint = document.getElementById("camHint");
const crowdCount = document.getElementById("crowdCount");
const panePublic = document.getElementById("panePublic");
let lastPublicAction = null;

let stream = null;
let pollTimer = null;
let demoEpoch = 1;
let dragging = false;
let dragMode = null; // "move" | "resize"
let dragTrackId = null;
let dragStart = null; // { px, py, x, y, w, h, paneW, paneH }
let autoTrack = true;
let trackRaf = null;
let faceReady = false;

const SAMPLE_STILL =
  "data:image/svg+xml," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#1a2740"/><stop offset="100%" stop-color="#0d1524"/>
  </linearGradient></defs>
  <rect width="960" height="600" fill="url(#g)"/>
  <circle cx="480" cy="220" r="70" fill="#c4a882"/>
  <rect x="390" y="300" width="180" height="220" rx="20" fill="#3d5a80"/>
  <text x="480" y="560" text-anchor="middle" fill="#8b9bb0" font-family="sans-serif" font-size="22">Sample still (camera backup)</text>
</svg>`);

document.getElementById("btnStart").onclick = () => startCamera({ manual: true });
document.getElementById("btnFallback").onclick = () => useFallback("Sample still selected.");
document.getElementById("btnAddPerson").onclick = () =>
  addTrack({ manualLock: true, auto: false, label: "Manual" });
document.getElementById("btnBindLatest").onclick = bindLatestPass;
document.getElementById("btnBindManual").onclick = bindManual;
document.getElementById("btnCapture").onclick = captureClip;
document.getElementById("btnJudge").onclick = () => runJudgeMode();
document.getElementById("btnAutoTrack").onclick = toggleAutoTrack;

function toggleAutoTrack() {
  autoTrack = !autoTrack;
  const btn = document.getElementById("btnAutoTrack");
  btn.textContent = autoTrack ? "Auto-track ON" : "Auto-track OFF";
  btn.classList.toggle("good", autoTrack);
  camStatus.textContent = autoTrack
    ? "Face auto-track on — boxes follow faces (Pass still sets identity)."
    : "Auto-track off — drag boxes manually.";
  if (autoTrack && stream) startFaceLoop();
}

async function startCamera({ manual = false } = {}) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    vidIn.srcObject = stream;
    vidPub.srcObject = stream;
    vidIn.classList.add("mirrored");
    vidPub.classList.add("mirrored");
    stillIn.hidden = true;
    stillPub.hidden = true;
    vidIn.hidden = false;
    vidPub.hidden = false;
    degradeBanner.hidden = true;
    camStatus.textContent = "Camera live — loading face tracker…";
    startFaceLoop();
  } catch (err) {
    const msg = manual
      ? `Camera failed (${err.message}). Using sample still.`
      : "Camera unavailable — using sample still. Demo still works.";
    useFallback(msg);
  }
}

function useFallback(statusMsg) {
  stopFaceLoop();
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  vidIn.classList.remove("mirrored");
  vidPub.classList.remove("mirrored");
  vidIn.hidden = true;
  vidPub.hidden = true;
  stillIn.src = SAMPLE_STILL;
  stillPub.src = SAMPLE_STILL;
  stillIn.hidden = false;
  stillPub.hidden = false;
  degradeBanner.hidden = false;
  degradeBanner.textContent =
    statusMsg || "Camera unavailable — using sample still. Demo still works.";
  camStatus.textContent = statusMsg || "Sample still active.";
}

function addTrack(opts = {}) {
  const n = tracks.length + 1;
  const track = {
    id: `track-${Date.now()}-${n}`,
    x: opts.x ?? 37 + (n - 1) * 8,
    y: opts.y ?? 10 + (n - 1) * 4,
    w: opts.w ?? 26,
    h: opts.h ?? 55,
    token_id: opts.token_id ?? null,
    subject: opts.subject ?? "unknown",
    label: opts.label ?? `Person ${n}`,
    internalAction: "allow",
    publicAction: "blur",
    policySummary: "unknown · public=blur",
    auto: opts.auto ?? false,
    manualLock: opts.manualLock ?? false,
    misses: 0,
  };
  tracks.push(track);
  renderTracks();
  decideAll();
  ensurePoll();
  return track;
}

function ensurePoll() {
  if (!pollTimer) pollTimer = setInterval(decideAll, POLL_MS);
}

function pickBindTarget() {
  const unbound = tracks.filter((t) => !t.token_id);
  if (!unbound.length) return null;
  // Prefer largest face near center (likely the demo speaker)
  return unbound
    .slice()
    .sort((a, b) => {
      const ac = Math.hypot(a.x + a.w / 2 - 50, a.y + a.h / 2 - 40);
      const bc = Math.hypot(b.x + b.w / 2 - 50, b.y + b.h / 2 - 40);
      const as = a.w * a.h - ac * 0.5;
      const bs = b.w * b.h - bc * 0.5;
      return bs - as;
    })[0];
}

function applyBind(tokenId, signed) {
  let track = pickBindTarget();
  if (!track) {
    track = addTrack({
      token_id: tokenId,
      subject: signed.payload.subject,
      label: "Attendee",
      auto: true,
    });
  } else {
    track.token_id = tokenId;
    track.subject = signed.payload.subject;
    track.label = "Attendee";
  }
  try {
    sessionStorage.setItem(BIND_KEY, tokenId);
  } catch {
    /* ignore */
  }
  renderTracks();
  decideAll();
  camStatus.textContent = `Bound Pass ${tokenId.slice(0, 8)}… → ${track.subject}`;
}

async function restoreBind() {
  let saved = null;
  try {
    saved = sessionStorage.getItem(BIND_KEY);
  } catch {
    saved = null;
  }
  if (!saved) return false;
  const res = await fetch(`${API}/pass/${saved}`);
  if (!res.ok) {
    try {
      sessionStorage.removeItem(BIND_KEY);
    } catch {
      /* ignore */
    }
    return false;
  }
  const signed = await res.json();
  if (signed.payload?.revoked) return false;
  applyBind(saved, signed);
  return true;
}

async function fetchUnboundPass() {
  const res = await fetch(`${API}/pass`);
  if (!res.ok) return null;
  const list = await res.json();
  const used = new Set(tracks.map((t) => t.token_id).filter(Boolean));
  const free = list
    .filter((s) => s.payload && !s.payload.revoked && !used.has(s.payload.token_id))
    .sort(
      (a, b) =>
        new Date(b.payload.valid_from).getTime() -
        new Date(a.payload.valid_from).getTime()
    );
  return free[0] || null;
}

async function bindLatestPass() {
  const signed = await fetchUnboundPass();
  if (!signed) {
    camStatus.textContent =
      "No unbound Pass left — open another phone /pass or Prep on Console.";
    return;
  }
  applyBind(signed.payload.token_id, signed);
}

async function bindManual() {
  const tokenId = tokenInput.value.trim();
  if (!tokenId) {
    camStatus.textContent = "Paste a token_id, or use Scan / bind latest Pass.";
    return;
  }
  const res = await fetch(`${API}/pass/${tokenId}`);
  if (!res.ok) {
    camStatus.textContent = "Token not found.";
    return;
  }
  const signed = await res.json();
  applyBind(tokenId, signed);
}

async function decideAll() {
  for (const track of tracks) {
    for (const audience of ["internal", "public"]) {
      const body = {
        token_id: track.token_id || undefined,
        track_id: track.id,
        audience,
      };
      try {
        const res = await fetch(`${API}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (audience === "internal") track.internalAction = data.decision.action;
        else {
          track.publicAction = data.decision.action;
          track.policySummary = summarizePolicy(track, data.decision);
        }
      } catch {
        /* ignore transient */
      }
    }
    // Enrich summary from token when bound
    if (track.token_id) {
      try {
        const res = await fetch(`${API}/pass/${track.token_id}`);
        if (res.ok) {
          const signed = await res.json();
          const p = signed.payload;
          const pub = p.revoked ? "deny" : track.publicAction;
          track.policySummary =
            `${p.revoked ? "REVOKED" : "bound"} · public=${pub}` +
            ` · promo=${p.permissions.promotional_use ? "yes" : "no"}`;
        }
      } catch {
        /* ignore */
      }
    }
  }
  renderTracks();
}

function summarizePolicy(track, decision) {
  if (!track.token_id) return `unknown · public=${decision.action}`;
  return `bound · public=${decision.action} (${decision.reason})`;
}

function renderTracks() {
  // Don't rebuild DOM mid-drag (would drop pointer capture)
  if (dragging) {
    syncBoxStyles();
    renderTrackList();
    return;
  }
  boxesIn.innerHTML = "";
  boxesPub.innerHTML = "";
  for (const t of tracks) {
    boxesIn.appendChild(boxEl(t, t.internalAction, "INTERNAL"));
    boxesPub.appendChild(boxEl(t, t.publicAction, "PUBLIC"));
  }
  renderTrackList();
}

function renderTrackList() {
  if (crowdCount) crowdCount.textContent = `${tracks.length} tracked`;
  if (!tracks.length) {
    trackList.textContent = "No tracks yet.";
    updateChrome();
    return;
  }
  trackList.innerHTML = tracks
    .map(
      (t) =>
        `<div class="track-row" data-id="${esc(t.id)}">` +
        `<strong>${esc(t.label)}</strong> · ${esc(t.subject)} · ` +
        `${t.auto && !t.manualLock ? "face · " : t.manualLock ? "manual · " : ""}` +
        `token=${t.token_id ? t.token_id.slice(0, 8) + "…" : "none"}` +
        `<br/>` +
        `int=<span class="badge ${badgeClass(t.internalAction)}">${t.internalAction}</span> ` +
        `pub=<span class="badge ${badgeClass(t.publicAction)}">${t.publicAction}</span>` +
        `<div class="policy-sum">${esc(t.policySummary || "")}</div>` +
        (t.token_id
          ? ""
          : `<button class="btn primary bind-face" data-bind="${esc(t.id)}" type="button">Bind Pass to this face</button>`) +
        `</div>`
    )
    .join("");
  trackList.querySelectorAll("button[data-bind]").forEach((btn) => {
    btn.onclick = () => bindLatestToTrack(btn.dataset.bind);
  });
  updateChrome();
}

function updateChrome() {
  const bound = tracks.some((t) => t.token_id);
  const pubActions = tracks.map((t) => t.publicAction);
  let pub = "blur";
  if (pubActions.some((a) => a === "deny" || a === "block_export")) pub = "deny";
  else if (pubActions.length && pubActions.every((a) => a === "allow")) pub = "allow";
  else if (pubActions.some((a) => a === "allow") && pubActions.some((a) => a !== "allow")) pub = "blur";
  else if (pubActions[0]) pub = pubActions[0] === "allow" ? "allow" : pubActions[0] === "deny" ? "deny" : "blur";

  if (chipPublic) {
    chipPublic.textContent = pub;
    chipPublic.className = "pane-chip chip-" + (pub === "allow" ? "allow" : pub === "deny" ? "deny" : "blur");
  }
  if (chipInternal) {
    chipInternal.textContent = "operator";
    chipInternal.className = "pane-chip chip-allow";
  }
  if (panePublic && lastPublicAction && lastPublicAction !== pub) {
    panePublic.classList.remove("flash-allow", "flash-blur", "flash-deny");
    void panePublic.offsetWidth;
    panePublic.classList.add("flash-" + (pub === "allow" ? "allow" : pub === "deny" ? "deny" : "blur"));
  }
  lastPublicAction = pub;

  const steps = document.querySelectorAll("#demoSteps .step");
  const setStep = (n, state) => {
    const el = document.querySelector(`#demoSteps .step[data-step="${n}"]`);
    if (!el) return;
    el.classList.remove("active", "done");
    if (state) el.classList.add(state);
  };
  const hasFaces = tracks.length > 0;
  const hasClipHint = !!bound; // capture enabled after bind
  setStep(1, hasFaces ? "done" : "active");
  setStep(2, bound ? "done" : hasFaces ? "active" : "");
  setStep(3, bound ? "active" : "");
  setStep(4, "");
  if (camHint) {
    if (!hasFaces) camHint.textContent = "Point the camera at people — faces get boxes automatically.";
    else if (!bound) camHint.textContent = "Tap a face to bind. Crowd: each person needs their own Pass (2nd phone or Issue).";
    else camHint.textContent = "PUBLIC should match Pass policy. Capture when ready, then use Console.";
  }
}

async function bindLatestToTrack(trackId) {
  const signed = await fetchUnboundPass();
  if (!signed) {
    camStatus.textContent =
      "No unbound Pass left — each face needs its own Pass (second phone or Issue).";
    return;
  }
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return applyBind(signed.payload.token_id, signed);
  track.token_id = signed.payload.token_id;
  track.subject = signed.payload.subject;
  track.label = "Attendee";
  try {
    sessionStorage.setItem(BIND_KEY, signed.payload.token_id);
  } catch { /* ignore */ }
  renderTracks();
  decideAll();
  camStatus.textContent = `Bound ${signed.payload.token_id.slice(0, 8)}… → this face (${tracks.filter(t=>t.token_id).length} bound)`;
}

function badgeClass(action) {
  if (action === "allow") return "allow";
  if (action === "blur" || action === "transform_export") return "blur";
  return "deny";
}

function applyActionClasses(el, action) {
  el.classList.remove("blurred", "denied", "allowed");
  if (action === "blur") el.classList.add("blurred");
  if (action === "deny" || action === "block_export") el.classList.add("denied");
  if (action === "allow") el.classList.add("allowed");
}

function syncBoxStyles() {
  for (const t of tracks) {
    for (const root of [boxesIn, boxesPub]) {
      const el = root.querySelector(`[data-track-id="${CSS.escape(t.id)}"]`);
      if (!el) continue;
      el.style.left = t.x + "%";
      el.style.top = t.y + "%";
      el.style.width = t.w + "%";
      el.style.height = t.h + "%";
      const action = root === boxesIn ? t.internalAction : t.publicAction;
      applyActionClasses(el, action);
      const tag = el.querySelector(".tag");
      if (tag) {
        tag.className = "tag tag-" + badgeClass(action);
        tag.textContent = `${t.label} · ${action}`;
      }
      const sum = el.querySelector(".box-policy");
      if (sum) sum.textContent = t.policySummary || action;
    }
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function boxEl(t, action, side) {
  const el = document.createElement("div");
  el.className = "person-box soft-mask";
  el.dataset.trackId = t.id;
  applyActionClasses(el, action);
  el.style.left = t.x + "%";
  el.style.top = t.y + "%";
  el.style.width = t.w + "%";
  el.style.height = t.h + "%";
  const tag = document.createElement("div");
  tag.className = "tag tag-" + badgeClass(action);
  tag.textContent = `${t.label} · ${action}`;
  el.appendChild(tag);
  const sum = document.createElement("div");
  sum.className = "box-policy";
  sum.textContent = t.policySummary || `${side}: ${action}`;
  el.appendChild(sum);

  // Only INTERNAL box is interactive — PUBLIC mirrors it
  if (side === "INTERNAL") {
    el.classList.add("draggable");
    if (!t.token_id) el.classList.add("bindable");
    el.title = t.token_id
      ? "Drag to adjust · bound"
      : "Tap to bind Pass · drag to adjust · corner to resize";
    const handle = document.createElement("div");
    handle.className = "resize-handle";
    handle.title = "Resize";
    el.appendChild(handle);
    el.addEventListener("pointerdown", (ev) => {
      startDrag(ev, t.id, "move");
    });
    el.addEventListener("pointerup", () => {
      if (!dragMoved && !t.token_id) {
        bindLatestToTrack(t.id);
      }
    });
    handle.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      startDrag(ev, t.id, "resize");
    });
  }
  return el;
}

let dragMoved = false;
let dragMoveCb = null;

function startDrag(ev, trackId, mode, onMove) {
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return;
  const pane = document.getElementById("paneInternal");
  const rect = pane.getBoundingClientRect();
  dragging = true;
  dragMoved = false;
  dragMoveCb = onMove || null;
  dragMode = mode;
  dragTrackId = trackId;
  if (mode === "resize") {
    track.manualLock = true;
    track.auto = false;
  }
  dragStart = {
    px: ev.clientX,
    py: ev.clientY,
    x: track.x,
    y: track.y,
    w: track.w,
    h: track.h,
    paneW: rect.width,
    paneH: rect.height,
  };
  ev.currentTarget.setPointerCapture?.(ev.pointerId);
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  ev.preventDefault();
}

function onDragMove(ev) {
  if (!dragging || !dragStart) return;
  const track = tracks.find((t) => t.id === dragTrackId);
  if (!track) return;
  const dx = ((ev.clientX - dragStart.px) / dragStart.paneW) * 100;
  const dy = ((ev.clientY - dragStart.py) / dragStart.paneH) * 100;
  if (Math.abs(dx) + Math.abs(dy) > 0.8) {
    dragMoved = true;
    // Real drag — lock off auto-track for this box
    track.manualLock = true;
    track.auto = false;
    if (dragMoveCb) dragMoveCb();
  }
  if (dragMode === "move") {
    track.x = clamp(dragStart.x + dx, 0, 100 - track.w);
    track.y = clamp(dragStart.y + dy, 0, 100 - track.h);
  } else {
    track.w = clamp(dragStart.w + dx, 8, 100 - track.x);
    track.h = clamp(dragStart.h + dy, 12, 100 - track.y);
  }
  syncBoxStyles();
}

function endDrag() {
  dragging = false;
  dragMode = null;
  dragTrackId = null;
  dragStart = null;
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);
  renderTracks();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function captureClip() {
  const track = tracks.find((t) => t.token_id);
  if (!track) {
    camStatus.textContent =
      "Bind a Pass first (Scan / bind latest Pass), then Capture — clip needs a real token.";
    return;
  }
  const res = await fetch(`${API}/clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      track_id: track.id,
      subject: track.subject,
      token_id: track.token_id,
      label: `hackday-${new Date().toISOString()}`,
    }),
  });
  const clip = await res.json();
  camStatus.textContent = `Captured clip ${clip.clip_id?.slice(0, 8)}… (token ${track.token_id.slice(0, 8)}…) — open Console.`;
}

async function maybeAutoBindFromQuery() {
  const params = new URLSearchParams(location.search);
  const bindId = params.get("bind");
  if (!bindId) return;
  const res = await fetch(`${API}/pass/${bindId}`);
  if (!res.ok) {
    camStatus.textContent = `Bind link token not found: ${bindId.slice(0, 8)}…`;
    return;
  }
  const signed = await res.json();
  applyBind(bindId, signed);
  // Clean URL without reload
  history.replaceState({}, "", "/camera");
}

async function watchDemoEpoch() {
  try {
    const res = await fetch(`${API}/demo/epoch`);
    const data = await res.json();
    if (data.epoch !== demoEpoch) {
      demoEpoch = data.epoch;
      // Re-seed: clear local tracks, one unknown
      tracks.length = 0;
      try {
        sessionStorage.removeItem(BIND_KEY);
      } catch {
        /* ignore */
      }
      addTrack({ label: "Unknown", subject: "unknown", auto: true });
      camStatus.textContent = "Demo reset — re-seeded; face auto-track will refill.";
      if (stream) startFaceLoop();
    }
  } catch {
    /* ignore */
  }
}


async function startFaceLoop() {
  if (!autoTrack || !stream) return;
  if (!faceReady) {
    try {
      await loadFaceDetector();
      faceReady = true;
      camStatus.textContent =
        "Face auto-track live — up to 12 people. Bind Pass on the person you choose.";
    } catch (err) {
      faceReady = false;
      camStatus.textContent =
        `Face tracker failed (${err.message || err}). Drag boxes manually.`;
      return;
    }
  }
  if (trackRaf) return;
  const tick = () => {
    trackRaf = requestAnimationFrame(tick);
    if (!autoTrack || !stream || dragging) return;
    const pane = document.getElementById("paneInternal");
    const result = syncTracksFromVideo({
      video: vidIn,
      pane,
      tracks,
      mirrored: true,
      addTrack,
      maxFaces: 12,
      autoTrack,
      dragging,
    });
    if (result.faces >= 0) {
      if (!dragging) {
        if (boxesIn.children.length !== tracks.length) renderTracks();
        else syncBoxStyles();
      }
    }
  };
  trackRaf = requestAnimationFrame(tick);
}

function stopFaceLoop() {
  if (trackRaf) {
    cancelAnimationFrame(trackRaf);
    trackRaf = null;
  }
}


let tickerTimer = null;
let judgeRunning = false;

function actClass(action) {
  if (action === "allow" || action === "clip_created" || action === "export_allowed") return "act-allow";
  if (action === "blur" || action === "transform_export" || action === "policy_update") return "act-blur";
  return "act-deny";
}

async function refreshTicker() {
  const body = document.getElementById("tickerBody");
  const meta = document.getElementById("tickerMeta");
  if (!body) return;
  try {
    const res = await fetch(`${API}/receipts`);
    const list = await res.json();
    const slice = [...list].reverse().slice(0, 12);
    if (meta) meta.textContent = `${list.length} receipts`;
    if (!slice.length) {
      body.textContent = "Waiting for decisions…";
      return;
    }
    body.innerHTML = slice
      .map((r) => {
        const t = (r.ts || "").slice(11, 19);
        return `<div class="tick-row"><span class="${actClass(r.action)}">${esc(r.action)}</span> · ${esc(r.audience)} · ${esc(r.reason)} · <span class="muted">${t}</span></div>`;
      })
      .join("");
  } catch {
    /* ignore */
  }
}

function ensureTicker() {
  if (!tickerTimer) tickerTimer = setInterval(refreshTicker, 1000);
  refreshTicker();
}

function setJudge(msg) {
  const el = document.getElementById("judgeBanner");
  if (!el) return;
  el.classList.add("on");
  el.textContent = msg;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runJudgeMode() {
  if (judgeRunning) {
    camStatus.textContent = "Judge mode already running…";
    return;
  }
  judgeRunning = true;
  const btn = document.getElementById("btnJudge");
  if (btn) btn.disabled = true;
  try {
    setJudge("Judge mode · 1/6 — Prep clean demo…");
    await fetch(`${API}/demo/prep`, { method: "POST" });
    tracks.length = 0;
    try { sessionStorage.removeItem(BIND_KEY); } catch { /* ignore */ }
    addTrack({ label: "Unknown", subject: "unknown", auto: true });
    if (stream) startFaceLoop();
    await sleep(1200);

    setJudge("Judge mode · 2/6 — Waiting for a face…");
    for (let i = 0; i < 40; i++) {
      if (tracks.length > 0 && tracks.some((t) => (t.w || 0) > 5)) break;
      await sleep(250);
    }
    const target = pickBindTarget() || tracks[0];
    if (!target) {
      setJudge("Judge mode stopped — no face. Stand in frame and retry.");
      return;
    }

    setJudge("Judge mode · 3/6 — Issuing Pass + Allow (simulating phone)…");
    let signed = await fetchUnboundPass();
    if (!signed) {
      const issued = await fetch(`${API}/pass/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: "hackday-demo",
          ttl_minutes: 120,
          permissions: {
            internal_recording: true,
            public_livestream: true,
            promotional_use: false,
            retention: true,
          },
          treatment: { public: "blur", internal: "allow" },
        }),
      });
      signed = await issued.json();
    }
    const tid = signed.payload.token_id;
    await fetch(`${API}/pass/${tid}/public`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "allow" }),
    });
    const refreshed = await (await fetch(`${API}/pass/${tid}`)).json();
    applyBind(tid, refreshed);
    await decideAll();
    await sleep(900);

    setJudge("Judge mode · 4/6 — PUBLIC should be ALLOW — capturing clip…");
    await captureClip();
    await sleep(700);

    setJudge("Judge mode · 5/6 — Deny promo → re-export…");
    const latestRes = await fetch(`${API}/clips/latest`);
    if (latestRes.ok) {
      const latest = await latestRes.json();
      if (latest.clip_id) {
        await fetch(`${API}/clips/${latest.clip_id}/policy-export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ promotional_use: false }),
        });
        await sleep(800);
        setJudge("Judge mode · 6/6 — Allow promo → re-export…");
        await fetch(`${API}/clips/${latest.clip_id}/policy-export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ promotional_use: true }),
        });
      }
    }
    await refreshTicker();
    setJudge("Judge mode · done — optional: Pass → Revoke for live deny kicker.");
    camStatus.textContent = "Judge mode finished. Check ticker + Console receipts.";
  } catch (err) {
    setJudge(`Judge mode error: ${err.message || err}`);
  } finally {
    judgeRunning = false;
    if (btn) btn.disabled = false;
  }
}

async function boot() {
  // Never blank: show still immediately, then try camera
  useFallback("Starting camera…");
  await startCamera({ manual: false });
  // Placeholder until faces appear (or manual drag if tracker off)
  addTrack({ label: "Unknown", subject: "unknown", auto: true });
  camStatus.textContent = stream
    ? "Camera live — starting face auto-track…"
    : "Sample still — add/drag tracks manually.";
  ensurePoll();
  await maybeAutoBindFromQuery();
  if (!tracks.some((t) => t.token_id)) {
    const restored = await restoreBind();
    if (restored) {
      camStatus.textContent =
        "Restored bound Pass after refresh. Face track will follow; then Capture.";
    }
  }
  if (stream) startFaceLoop();
  ensureTicker();
  try {
    const res = await fetch(`${API}/demo/epoch`);
    const data = await res.json();
    demoEpoch = data.epoch;
  } catch {
    /* ignore */
  }
  setInterval(watchDemoEpoch, 2000);
}

boot();
