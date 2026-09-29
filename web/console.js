/**
 * Organizer console — iPad.
 */

const API = "/api";

let latestClipId = null;

document.getElementById("btnIssue").onclick = issuePass;
document.getElementById("btnReset").onclick = demoReset;
document.getElementById("btnRefreshReceipts").onclick = () => {
  loadReceipts();
  loadGraph();
};
document.getElementById("btnDenyPromoExport").onclick = () => policyExport(false);
document.getElementById("btnAllowPromoExport").onclick = () => policyExport(true);
document.getElementById("btnExportOnly").onclick = () => exportOnly();

async function issuePass() {
  const event_id = document.getElementById("eventId").value || "hackday-demo";
  const ttl_minutes = Number(document.getElementById("ttl").value) || 120;
  const res = await fetch(`${API}/pass/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id,
      ttl_minutes,
      permissions: {
        internal_recording: true,
        public_livestream: true,
        promotional_use: false,
        retention: true,
      },
      treatment: { public: "blur", internal: "allow" },
    }),
  });
  const signed = await res.json();
  const out = document.getElementById("issuedOut");
  out.innerHTML =
    `Issued <strong>${esc(signed.payload.subject)}</strong> — now the bindable Pass<br/>` +
    `token_id: <code>${signed.payload.token_id}</code><br/>` +
    `<span class="muted">On Camera tap <strong>Scan / bind latest Pass</strong> (or open /pass on phone).</span>`;
  await loadPasses();
}

async function demoReset() {
  if (!confirm("Clear all tokens, clips, and receipts?")) return;
  const res = await fetch(`${API}/demo/reset`, { method: "POST" });
  const data = await res.json();
  document.getElementById("issuedOut").textContent =
    `Reset ok (epoch ${data.epoch}). Camera will re-seed Unknown.`;
  document.getElementById("exportResult").textContent = "";
  latestClipId = null;
  await refreshAll();
}

async function loadPasses() {
  const res = await fetch(`${API}/pass`);
  const list = await res.json();
  const el = document.getElementById("passTable");
  if (!list.length) {
    el.textContent = "No passes yet.";
    return;
  }
  el.innerHTML =
    `<table><thead><tr><th>Subject</th><th>Token</th><th>Public</th><th>Promo</th><th>Status</th><th></th></tr></thead><tbody>` +
    list
      .map((s) => {
        const p = s.payload;
        return `<tr>
          <td>${esc(p.subject)}</td>
          <td class="mono">${p.token_id.slice(0, 8)}…</td>
          <td><span class="badge ${p.treatment.public}">${p.treatment.public}</span></td>
          <td>${p.permissions.promotional_use ? "yes" : "no"}</td>
          <td>${p.revoked ? '<span class="badge deny">revoked</span>' : "active"}</td>
          <td>
            <button class="btn" data-act="promo-on" data-id="${p.token_id}">Allow promo</button>
            <button class="btn" data-act="promo-off" data-id="${p.token_id}">Deny promo</button>
            <button class="btn bad" data-act="revoke" data-id="${p.token_id}">Revoke</button>
          </td>
        </tr>`;
      })
      .join("") +
    `</tbody></table>`;

  el.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "revoke") {
        await fetch(`${API}/pass/${id}/revoke`, { method: "POST" });
      } else if (act === "promo-on") {
        await fetch(`${API}/pass/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissions: { promotional_use: true } }),
        });
      } else if (act === "promo-off") {
        await fetch(`${API}/pass/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissions: { promotional_use: false } }),
        });
      }
      await refreshAll();
    };
  });
}

async function loadLatestClip() {
  const el = document.getElementById("latestClip");
  const actions = document.getElementById("latestClipActions");
  const res = await fetch(`${API}/clips/latest`);
  if (!res.ok) {
    latestClipId = null;
    el.textContent = "No clips yet. Capture from Camera.";
    actions.hidden = true;
    return;
  }
  const c = await res.json();
  latestClipId = c.clip_id;
  el.innerHTML =
    `<strong>${esc(c.label)}</strong><br/>` +
    `person=${esc(c.subject)} · token=${c.token_id.slice(0, 8)}… · v${c.policy_version}<br/>` +
    `export=<span class="badge ${exportBadge(c.export_status)}">${c.export_status}</span>`;
  actions.hidden = false;
}

function exportBadge(status) {
  if (status === "blocked") return "deny";
  if (status === "allowed") return "allow";
  return "blur";
}

async function policyExport(promotional_use) {
  if (!latestClipId) return;
  const res = await fetch(`${API}/clips/${latestClipId}/policy-export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promotional_use }),
  });
  const data = await res.json();
  showExportResult(data);
  await refreshAll();
}

async function exportOnly() {
  if (!latestClipId) return;
  const res = await fetch(`${API}/clips/${latestClipId}/export`, { method: "POST" });
  const data = await res.json();
  showExportResult(data);
  await refreshAll();
}

function showExportResult(data) {
  const d = data.decision;
  const status = data.clip?.export_status ?? "?";
  document.getElementById("exportResult").innerHTML =
    `Result: <span class="badge ${exportBadge(status)}">${status}</span> · ` +
    `action=<strong>${esc(d.action)}</strong> · reason=${esc(d.reason)} · receipt written`;
}

async function loadClips() {
  const res = await fetch(`${API}/clips`);
  const clips = await res.json();
  const el = document.getElementById("clipTable");
  if (!clips.length) {
    el.textContent = "No clips yet.";
    return;
  }
  el.innerHTML =
    `<table><thead><tr><th>Label</th><th>Person</th><th>Token</th><th>v</th><th>Export</th><th></th></tr></thead><tbody>` +
    clips
      .map(
        (c) => `<tr>
        <td>${esc(c.label)}</td>
        <td>${esc(c.subject)}</td>
        <td class="mono">${c.token_id.slice(0, 8)}…</td>
        <td>${c.policy_version}</td>
        <td><span class="badge ${exportBadge(c.export_status)}">${c.export_status}</span></td>
        <td><button class="btn primary" data-export="${c.clip_id}">Try export</button></td>
      </tr>`
      )
      .join("") +
    `</tbody></table>`;

  el.querySelectorAll("button[data-export]").forEach((btn) => {
    btn.onclick = async () => {
      const res = await fetch(`${API}/clips/${btn.dataset.export}/export`, { method: "POST" });
      const data = await res.json();
      latestClipId = btn.dataset.export;
      showExportResult(data);
      await refreshAll();
    };
  });
}

async function loadReceipts() {
  const res = await fetch(`${API}/receipts`);
  const list = await res.json();
  const el = document.getElementById("receipts");
  if (!list.length) {
    el.textContent = "No receipts yet.";
    return;
  }
  el.innerHTML = [...list]
    .reverse()
    .slice(0, 40)
    .map(
      (r) =>
        `${r.ts} · ${r.audience} · ${r.action} · track=${r.track_id} · token=${r.token_id}`
    )
    .join("<br/>");
}

async function loadGraph() {
  const res = await fetch(`${API}/rights-graph`);
  const data = await res.json();
  document.getElementById("graph").textContent = JSON.stringify(data, null, 2);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function refreshAll() {
  await Promise.all([
    loadPasses(),
    loadLatestClip(),
    loadClips(),
    loadReceipts(),
    loadGraph(),
  ]);
}

refreshAll();
setInterval(refreshAll, 2000);
