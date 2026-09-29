/**
 * Camera page — MacBook capture station.
 * Manual person tracks + dual Internal/Public panes.
 */

const API = "/api";
const tracks = []; // { id, x, y, w, h, token_id, subject, label }

const vidIn = document.getElementById("vidInternal");
const vidPub = document.getElementById("vidPublic");
const stillIn = document.getElementById("stillInternal");
const stillPub = document.getElementById("stillPublic");
const boxesIn = document.getElementById("boxesInternal");
const boxesPub = document.getElementById("boxesPublic");
const trackList = document.getElementById("trackList");
const camStatus = document.getElementById("camStatus");
const tokenInput = document.getElementById("tokenInput");

let stream = null;
let pollTimer = null;

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

document.getElementById("btnStart").onclick = startCamera;
document.getElementById("btnFallback").onclick = useFallback;
document.getElementById("btnAddPerson").onclick = () => addTrack();
document.getElementById("btnBind").onclick = bindPass;
document.getElementById("btnCapture").onclick = captureClip;

async function startCamera() {
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
    camStatus.textContent = "Camera live.";
  } catch (err) {
    camStatus.textContent = `Camera failed: ${err.message}. Using sample still.`;
    useFallback();
  }
}

function useFallback() {
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
  camStatus.textContent = "Sample still active (backup plan).";
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
  };
  tracks.push(track);
  renderTracks();
  decideAll();
  if (!pollTimer) pollTimer = setInterval(decideAll, 1500);
}

async function bindPass() {
  const tokenId = tokenInput.value.trim();
  if (!tokenId) {
    alert("Paste a token_id from the Pass page or Console.");
    return;
  }
  const res = await fetch(`${API}/pass/${tokenId}`);
  if (!res.ok) {
    alert("Token not found");
    return;
  }
  const signed = await res.json();
  // Bind to first unknown track, or create one
  let track = tracks.find((t) => !t.token_id);
  if (!track) {
    addTrack({ token_id: tokenId, subject: signed.payload.subject, label: "Attendee" });
    track = tracks[tracks.length - 1];
  } else {
    track.token_id = tokenId;
    track.subject = signed.payload.subject;
    track.label = "Attendee";
  }
  renderTracks();
  await decideAll();
  camStatus.textContent = `Bound Pass ${tokenId.slice(0, 8)}… → ${track.subject}`;
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
        else track.publicAction = data.decision.action;
      } catch {
        /* ignore transient */
      }
    }
  }
  renderTracks();
}

function renderTracks() {
  boxesIn.innerHTML = "";
  boxesPub.innerHTML = "";
  for (const t of tracks) {
    boxesIn.appendChild(boxEl(t, t.internalAction));
    boxesPub.appendChild(boxEl(t, t.publicAction));
  }
  if (!tracks.length) {
    trackList.textContent = "No tracks yet.";
    return;
  }
  trackList.innerHTML = tracks
    .map(
      (t) =>
        `${t.id} · ${t.label} · subject=${t.subject} · token=${t.token_id ?? "none"} · ` +
        `int=<span class="badge ${t.internalAction}">${t.internalAction}</span> ` +
        `pub=<span class="badge ${t.publicAction}">${t.publicAction}</span>`
    )
    .join("<br/>");
}

function boxEl(t, action) {
  const el = document.createElement("div");
  el.className = "person-box";
  if (action === "blur") el.classList.add("blurred");
  if (action === "deny") el.classList.add("denied");
  el.style.left = t.x + "%";
  el.style.top = t.y + "%";
  el.style.width = t.w + "%";
  el.style.height = t.h + "%";
  const tag = document.createElement("div");
  tag.className = "tag";
  tag.textContent = `${t.label} · ${action}`;
  el.appendChild(tag);
  return el;
}

async function captureClip() {
  const track = tracks.find((t) => t.token_id) || tracks[0];
  if (!track) {
    alert("Add a person track first.");
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
  camStatus.textContent = `Captured clip stub ${clip.clip_id?.slice(0, 8)}… — manage export on Console.`;
}

// Demo-friendly: one unknown person on load with fallback still
useFallback();
addTrack({ label: "Unknown", subject: "unknown" });
