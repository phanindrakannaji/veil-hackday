/**
 * Pass page — iPhone Veil Pass (QR + toggles + revoke).
 * QR payload is a Camera auto-bind URL: http://host/camera?bind=<token_id>
 */

const API = "/api";
const LS_KEY = "veil_pass_token_id";

const subjectEl = document.getElementById("subject");
const metaEl = document.getElementById("tokenMeta");
const badgeEl = document.getElementById("publicBadge");
const bindingBadgeEl = document.getElementById("bindingBadge");
const tokenFullEl = document.getElementById("tokenFull");
const qrImg = document.getElementById("qr");
const qrError = document.getElementById("qrError");

let tokenId = localStorage.getItem(LS_KEY);
let signed = null;
let rotateTimer = null;
let bindingPollTimer = null;

document.getElementById("btnAllow").onclick = () => setPublic("allow");
document.getElementById("btnBlur").onclick = () => setPublic("blur");
document.getElementById("btnDeny").onclick = () => setPublic("deny");
document.getElementById("btnRevoke").onclick = revoke;
document.getElementById("btnNew").onclick = () => issueSelf();
document.getElementById("btnCopy").onclick = copyToken;

async function init() {
  if (tokenId) {
    const ok = await load(tokenId);
    if (!ok) await issueSelf();
  } else {
    await issueSelf();
  }
  rotateTimer = setInterval(() => drawQR(), 20000);
  bindingPollTimer = setInterval(() => checkBinding(), 2000);
  checkBinding();
}

async function issueSelf() {
  // Reset binding badge immediately before issuing new Pass
  if (bindingBadgeEl) {
    bindingBadgeEl.textContent = "Not linked";
    bindingBadgeEl.className = "badge";
  }
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
  metaEl.textContent = `until ${new Date(p.valid_until).toLocaleTimeString()}`;
  tokenFullEl.textContent = p.token_id;
  const mode = p.revoked ? "deny" : p.treatment.public;
  badgeEl.textContent = mode;
  badgeEl.className = "badge " + mode;
  drawQR();
}

function drawQR() {
  if (!signed || !qrImg) return;
  const id = signed.payload.token_id;
  const timestamp = Date.now();
  qrImg.src = `${API}/pass/${encodeURIComponent(id)}/qr?t=${timestamp}`;
  qrImg.onerror = () => {
    if (qrError) {
      qrError.style.display = "block";
      qrError.textContent = "QR load failed";
    }
  };
  qrImg.onload = () => {
    if (qrError) qrError.style.display = "none";
  };
}

async function copyToken() {
  if (!signed) return;
  const id = signed.payload.token_id;
  try {
    await navigator.clipboard.writeText(id);
    document.getElementById("btnCopy").textContent = "Copied!";
    setTimeout(() => {
      document.getElementById("btnCopy").textContent = "Copy";
    }, 1200);
  } catch {
    // Fallback
    prompt("Copy token_id:", id);
  }
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

async function checkBinding() {
  if (!tokenId || !bindingBadgeEl) return;
  try {
    const res = await fetch(`${API}/pass/${tokenId}/binding`);
    if (res.ok) {
      const binding = await res.json();
      // Check actual bound status: must have bound===true AND bound_at present
      if (binding.bound === true && binding.bound_at) {
        bindingBadgeEl.textContent = "Linked to Camera";
        bindingBadgeEl.className = "badge allow";
      } else {
        bindingBadgeEl.textContent = "Not linked";
        bindingBadgeEl.className = "badge";
      }
    } else {
      // Fallback for old 404-not-bound shape (backward compat)
      bindingBadgeEl.textContent = "Not linked";
      bindingBadgeEl.className = "badge";
    }
  } catch {
    bindingBadgeEl.textContent = "Not linked";
    bindingBadgeEl.className = "badge";
  }
}

init();
