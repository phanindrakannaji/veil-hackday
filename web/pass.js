/**
 * Pass page — iPhone Veil Pass (QR + toggles + revoke).
 */

const API = "/api";
const LS_KEY = "veil_pass_token_id";

const subjectEl = document.getElementById("subject");
const metaEl = document.getElementById("tokenMeta");
const badgeEl = document.getElementById("publicBadge");
const qrCanvas = document.getElementById("qr");

let tokenId = localStorage.getItem(LS_KEY);
let signed = null;
let rotateTimer = null;

document.getElementById("btnAllow").onclick = () => setPublic("allow");
document.getElementById("btnBlur").onclick = () => setPublic("blur");
document.getElementById("btnDeny").onclick = () => setPublic("deny");
document.getElementById("btnRevoke").onclick = revoke;
document.getElementById("btnNew").onclick = () => issueSelf();

async function init() {
  if (tokenId) {
    const ok = await load(tokenId);
    if (!ok) await issueSelf();
  } else {
    await issueSelf();
  }
  // "Rotating" QR: re-draw every 20s with a nonce in the payload (token_id stays)
  rotateTimer = setInterval(() => drawQR(), 20000);
}

async function issueSelf() {
  const res = await fetch(`${API}/pass/issue`, {
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
  signed = await res.json();
  tokenId = signed.payload.token_id;
  localStorage.setItem(LS_KEY, tokenId);
  render();
}

async function load(id) {
  const res = await fetch(`${API}/pass/${id}`);
  if (!res.ok) return false;
  signed = await res.json();
  render();
  return true;
}

function render() {
  if (!signed) return;
  const p = signed.payload;
  subjectEl.textContent = p.revoked ? "REVOKED" : p.subject;
  metaEl.textContent = `token ${p.token_id.slice(0, 8)}… · until ${new Date(p.valid_until).toLocaleTimeString()}`;
  const mode = p.revoked ? "deny" : p.treatment.public;
  badgeEl.textContent = mode;
  badgeEl.className = "badge " + mode;
  drawQR();
}

function drawQR() {
  if (!signed || typeof QRCode === "undefined") return;
  const payload = JSON.stringify({
    veil: 1,
    token_id: signed.payload.token_id,
    subject: signed.payload.subject,
    nonce: Date.now(),
  });
  QRCode.toCanvas(qrCanvas, payload, {
    width: 280,
    margin: 1,
    color: { dark: "#0b0f14", light: "#ffffff" },
  });
}

async function setPublic(mode) {
  if (!tokenId) return;
  const res = await fetch(`${API}/pass/${tokenId}/public`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  signed = await res.json();
  render();
}

async function revoke() {
  if (!tokenId) return;
  if (!confirm("Revoke this Pass? Public view will deny you.")) return;
  const res = await fetch(`${API}/pass/${tokenId}/revoke`, { method: "POST" });
  signed = await res.json();
  render();
}

init();
