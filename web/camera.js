/**
 * Camera page — MacBook capture station.
 * Manual person tracks + dual Internal/Public panes.
 * Polls decide() every 800ms so Public flips within ~1s after bind/revoke/policy.
 */

const API = "/api";
const POLL_MS = 800;
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

let stream = null;
let pollTimer = null;
let demoEpoch = 1;

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
document.getElementById("btnAddPerson").onclick = () => addTrack();
document.getElementById("btnBindLatest").onclick = bindLatestPass;
document.getElementById("btnBindManual").onclick = bindManual;
document.getElementById("btnCapture").onclick = captureClip;

async function startCamera({ manual = false } = {}) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    vidIn.srcObject = stream;
    vidPub.srcObject = stream;
    stillIn.hidden = true;
    stillPub.hidden = true;
    vidIn.hidden = false;
    vidPub.hidden = false;
    degradeBanner.hidden = true;
    camStatus.textContent = "Camera live.";
  } catch (err) {
    const msg = manual
      ? `Camera failed (${err.message}). Using sample still.`
      : "Camera unavailable — using sample still. Demo still works.";
    useFallback(msg);
  }
}

function useFallback(statusMsg) {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
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
    x: opts.x ?? 30 + n * 5,
    y: opts.y ?? 20 + n * 3,
    w: opts.w ?? 22,
    h: opts.h ?? 45,
    token_id: opts.token_id ?? null,
    subject: opts.subject ?? "unknown",
    label: opts.label ?? `Person ${n}`,
    internalAction: "allow",
    publicAction: "blur",
    policySummary: "unknown · public=blur",
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

function applyBind(tokenId, signed) {
  let track = tracks.find((t) => !t.token_id);
  if (!track) {
    track = addTrack({
      token_id: tokenId,
      subject: signed.payload.subject,
      label: "Attendee",
    });
  } else {
    track.token_id = tokenId;
    track.subject = signed.payload.subject;
    track.label = "Attendee";
  }
  renderTracks();
  decideAll();
  camStatus.textContent = `Bound Pass ${tokenId.slice(0, 8)}… → ${track.subject}`;
}

async function bindLatestPass() {
  const res = await fetch(`${API}/pass/latest`);
  if (!res.ok) {
    camStatus.textContent = "No active Pass yet — Issue on Console or open /pass on phone.";
    return;
  }
  const signed = await res.json();
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
  boxesIn.innerHTML = "";
  boxesPub.innerHTML = "";
  for (const t of tracks) {
    boxesIn.appendChild(boxEl(t, t.internalAction, "INTERNAL"));
    boxesPub.appendChild(boxEl(t, t.publicAction, "PUBLIC"));
  }
  if (!tracks.length) {
    trackList.textContent = "No tracks yet.";
    return;
  }
  trackList.innerHTML = tracks
    .map(
      (t) =>
        `<div class="track-row">` +
        `<strong>${esc(t.label)}</strong> · ${esc(t.subject)} · ` +
        `token=${t.token_id ? t.token_id.slice(0, 8) + "…" : "none"}` +
        `<br/>` +
        `int=<span class="badge ${badgeClass(t.internalAction)}">${t.internalAction}</span> ` +
        `pub=<span class="badge ${badgeClass(t.publicAction)}">${t.publicAction}</span>` +
        `<div class="policy-sum">${esc(t.policySummary || "")}</div>` +
        `</div>`
    )
    .join("");
}

function badgeClass(action) {
  if (action === "allow") return "allow";
  if (action === "blur" || action === "transform_export") return "blur";
  return "deny";
}

function boxEl(t, action, side) {
  const el = document.createElement("div");
  el.className = "person-box";
  if (action === "blur") el.classList.add("blurred");
  if (action === "deny" || action === "block_export") el.classList.add("denied");
  if (action === "allow") el.classList.add("allowed");
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
  return el;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function captureClip() {
  const track = tracks.find((t) => t.token_id) || tracks[0];
  if (!track) {
    camStatus.textContent = "Add a person track first.";
    return;
  }
  const res = await fetch(`${API}/clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      track_id: track.id,
      subject: track.subject,
      token_id: track.token_id || "none",
      label: `hackday-${new Date().toISOString()}`,
    }),
  });
  const clip = await res.json();
  camStatus.textContent = `Captured clip ${clip.clip_id?.slice(0, 8)}… — open Console to change policy & re-export.`;
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
      addTrack({ label: "Unknown", subject: "unknown" });
      camStatus.textContent = "Demo reset — re-seeded one unknown person.";
    }
  } catch {
    /* ignore */
  }
}

async function boot() {
  // Never blank: show still immediately, then try camera
  useFallback("Starting camera…");
  await startCamera({ manual: false });
  addTrack({ label: "Unknown", subject: "unknown" });
  ensurePoll();
  await maybeAutoBindFromQuery();
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
