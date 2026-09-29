/**
 * Organizer console — judge-friendly iPad UI.
 * Same API endpoints; plain-language copy only.
 */

const API = "/api";
const DEFAULT_EVENT = "hackday-demo";
const DEFAULT_TTL = 120;

let latestClipId = null;
/** @type {Map<string, string>} token_id → subject */
const subjectByToken = new Map();
/** @type {Map<string, string>} track_id → subject (from clips) */
const subjectByTrack = new Map();

/** Cached for metric strip */
let lastPassCount = 0;
let lastActivePasses = 0;
let lastCaptureCount = 0;
let lastDecisionLabel = "—";

document.getElementById("btnIssue").onclick = issuePass;
document.getElementById("btnReset").onclick = demoReset;
document.getElementById("btnPrep").onclick = demoPrep;
document.getElementById("btnRefreshActivity").onclick = () => loadActivity();
document.getElementById("btnDenyPromoExport").onclick = () => policyExport(false);
document.getElementById("btnAllowPromoExport").onclick = () => policyExport(true);
document.getElementById("btnExportOnly").onclick = () => exportOnly();
document.getElementById("btnExplain").onclick = () => explainDecision();
document.getElementById("btnConsentBrief").onclick = () => runConsentBrief();
document.getElementById("btnJudgePanel").onclick = () => runJudgePanel();

function setHeroStatus(html) {
  const el = document.getElementById("heroStatus");
  el.hidden = !html;
  el.innerHTML = html || "";
}

function setExportResult(html) {
  const el = document.getElementById("exportResult");
  el.hidden = !html;
  el.innerHTML = html || "";
}

function updateMetrics() {
  const passesEl = document.getElementById("metricPasses");
  const capturesEl = document.getElementById("metricCaptures");
  const decisionEl = document.getElementById("metricDecision");
  if (passesEl) {
    passesEl.innerHTML =
      lastActivePasses > 0
        ? `<span class="live-dot"></span>${lastActivePasses}`
        : String(lastActivePasses);
  }
  if (capturesEl) capturesEl.textContent = String(lastCaptureCount);
  if (decisionEl) decisionEl.textContent = lastDecisionLabel;
}

async function issuePass() {
  const res = await fetch(`${API}/pass/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: DEFAULT_EVENT,
      ttl_minutes: DEFAULT_TTL,
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
  const name = signed.payload?.subject ?? "Guest";
  setHeroStatus(
    `Added a Pass for <strong>${esc(name)}</strong>. On Camera, show Pass QR or tap a face.`
  );
  await refreshAll();
}

async function demoPrep() {
  const res = await fetch(`${API}/demo/prep`, { method: "POST" });
  const data = await res.json();
  const name = data.pass?.payload?.subject ?? "Guest";
  setHeroStatus(
    `Ready. Fresh Pass for <strong>${esc(name)}</strong> — open Camera and bind when they join.`
  );
  setExportResult("");
  latestClipId = null;
  await refreshAll();
}

async function demoReset() {
  if (!confirm("Wipe all Passes, captures, and history? This cannot be undone.")) return;
  await fetch(`${API}/demo/reset`, { method: "POST" });
  setHeroStatus("Everything wiped. Start a clean demo when you’re ready.");
  setExportResult("");
  latestClipId = null;
  await refreshAll();
}

function treatmentLabel(t) {
  if (t === "allow") return { text: "Visible in public", cls: "chip-ok" };
  if (t === "blur") return { text: "Blurred in public", cls: "chip-warn" };
  if (t === "deny") return { text: "Hidden in public", cls: "chip-bad" };
  return { text: String(t), cls: "" };
}

function promoChip(ok) {
  return ok
    ? { text: "Promo OK", cls: "chip-ok" }
    : { text: "Promo blocked", cls: "chip-bad" };
}

function statusChip(revoked) {
  return revoked
    ? { text: "Revoked", cls: "chip-bad" }
    : { text: "Active", cls: "chip-ok" };
}

function exportChip(status) {
  if (status === "allowed") return { text: "Export OK", cls: "chip-ok" };
  if (status === "blocked") return { text: "Export blocked", cls: "chip-bad" };
  if (status === "transformed") return { text: "Export limited", cls: "chip-warn" };
  return { text: "Export pending", cls: "chip-muted" };
}

function chipHtml({ text, cls }) {
  return `<span class="console-chip ${cls}">${esc(text)}</span>`;
}

async function loadPasses() {
  const res = await fetch(`${API}/pass`);
  const list = await res.json();
  const el = document.getElementById("passList");
  subjectByToken.clear();

  lastPassCount = list.length;
  lastActivePasses = list.filter((s) => !s.payload?.revoked).length;
  updateMetrics();

  if (!list.length) {
    el.innerHTML = `<p class="muted small">No Passes yet — start a clean demo above.</p>`;
    return;
  }

  for (const s of list) {
    subjectByToken.set(s.payload.token_id, s.payload.subject);
  }

  el.innerHTML = list
    .map((s) => {
      const p = s.payload;
      const pub = treatmentLabel(p.treatment?.public);
      const promo = promoChip(!!p.permissions?.promotional_use);
      const st = statusChip(!!p.revoked);
      const disabled = p.revoked ? "disabled" : "";
      return `<article class="person-card${p.revoked ? " is-revoked" : ""}">
        <div class="person-card-head">
          <h3>${esc(p.subject)}</h3>
          <div class="person-card-chips">
            ${chipHtml(st)}
            ${chipHtml(pub)}
            ${chipHtml(promo)}
          </div>
        </div>
        <div class="person-card-actions">
          <button class="btn good" data-act="promo-on" data-id="${esc(p.token_id)}" ${disabled}>Allow promo</button>
          <button class="btn warn" data-act="promo-off" data-id="${esc(p.token_id)}" ${disabled}>Block promo</button>
          <button class="btn ghost" data-act="impact" data-id="${esc(p.token_id)}">Revoke impact</button>
          <button class="btn bad" data-act="revoke" data-id="${esc(p.token_id)}" ${disabled}>Revoke Pass</button>
        </div>
      </article>`;
    })
    .join("");

  el.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "impact") {
        await runRevokeImpact(id);
        return;
      } else if (act === "revoke") {
        if (!confirm("Revoke this Pass? They’ll be treated as opted out.")) return;
        await fetch(`${API}/pass/${id}/revoke`, { method: "POST" });
        await runRevokeImpact(id);
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
  const tiny = document.getElementById("btnExportOnly");
  const res = await fetch(`${API}/clips/latest`);
  if (!res.ok) {
    latestClipId = null;
    el.className = "console-empty";
    el.textContent = "No capture yet — press Capture on the Camera.";
    actions.hidden = true;
    tiny.hidden = true;
    const explainRow = document.getElementById("explainRow");
    const explainPanel = document.getElementById("explainPanel");
    if (explainRow) explainRow.hidden = true;
    if (explainPanel) explainPanel.hidden = true;
    updateSteps({ hasClip: false, hasExport: false });
    return;
  }
  const c = await res.json();
  latestClipId = c.clip_id;
  if (c.token_id) subjectByToken.set(c.token_id, c.subject);
  if (c.track_id) subjectByTrack.set(c.track_id, c.subject);

  const ex = exportChip(c.export_status);
  el.className = "console-capture-body";
  el.innerHTML = `
    <div class="console-capture-name">${esc(c.subject || c.label || "Guest")}</div>
    <div class="console-capture-meta">${chipHtml(ex)}</div>
  `;
  actions.hidden = false;
  tiny.hidden = false;
  const explainRow = document.getElementById("explainRow");
  if (explainRow) explainRow.hidden = false;
  updateSteps({ hasClip: true, hasExport: c.export_status && c.export_status !== "pending" });
}

async function policyExport(promotional_use) {
  if (!latestClipId) return;
  const res = await fetch(`${API}/clips/${latestClipId}/policy-export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promotional_use }),
  });
  const data = await res.json();
  if (!res.ok) {
    setExportResult(
      data.error === "clip_unbound"
        ? "This capture isn’t linked to a Pass yet. Bind on Camera, capture again, then retry."
        : `Couldn’t update: ${esc(data.error || "something went wrong")}`
    );
    return;
  }
  showExportResult(data, promotional_use);
  await refreshAll();
}

async function exportOnly() {
  if (!latestClipId) return;
  const res = await fetch(`${API}/clips/${latestClipId}/export`, { method: "POST" });
  const data = await res.json();
  showExportResult(data, null);
  await refreshAll();
}

function showExportResult(data, intendedPromo) {
  const status = data.clip?.export_status ?? "";
  const action = data.decision?.action ?? "";
  let msg;
  if (status === "allowed" || action === "allow") {
    msg = "Promo export allowed.";
  } else if (action === "transform_export" || status === "transformed") {
    msg = "Export limited — kept for records, not for marketing.";
  } else if (intendedPromo === false) {
    msg = "Promo export blocked — their Pass doesn’t allow marketing use.";
  } else {
    msg = "Promo export blocked — their Pass doesn’t allow marketing use.";
  }
  const chip = exportChip(status || (action === "allow" ? "allowed" : "blocked"));
  setExportResult(`${chipHtml(chip)} <span>${esc(msg)}</span>`);
  updateSteps({ hasClip: true, hasExport: true });
}

async function loadClips() {
  const res = await fetch(`${API}/clips`);
  const clips = await res.json();
  const section = document.getElementById("earlierSection");
  const el = document.getElementById("clipList");

  lastCaptureCount = clips.length;
  updateMetrics();

  for (const c of clips) {
    if (c.token_id) subjectByToken.set(c.token_id, c.subject);
    if (c.track_id) subjectByTrack.set(c.track_id, c.subject);
  }

  const earlier = clips.filter((c) => c.clip_id !== latestClipId);
  if (!earlier.length) {
    section.hidden = true;
    el.innerHTML = "";
    return;
  }

  section.hidden = false;
  el.innerHTML = earlier
    .map((c) => {
      const ex = exportChip(c.export_status);
      return `<div class="console-earlier-row">
        <div>
          <strong>${esc(c.subject || c.label || "Guest")}</strong>
          ${chipHtml(ex)}
        </div>
        <button class="btn" data-export="${esc(c.clip_id)}">Check export</button>
      </div>`;
    })
    .join("");

  el.querySelectorAll("button[data-export]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.export;
      const res = await fetch(`${API}/clips/${id}/export`, { method: "POST" });
      const data = await res.json();
      latestClipId = id;
      showExportResult(data, null);
      await refreshAll();
    };
  });
}

function resolveName(r) {
  if (r.token_id && subjectByToken.has(r.token_id)) {
    return subjectByToken.get(r.token_id);
  }
  if (r.track_id && subjectByTrack.has(r.track_id)) {
    return subjectByTrack.get(r.track_id);
  }
  return null;
}

function friendlyReceipt(r) {
  const who = resolveName(r);
  const name = who ? esc(who) : null;
  const a = r.audience;
  const act = r.action;

  if (a === "demo" && act === "reset") return "Demo wiped — starting fresh.";
  if (a === "demo" && act === "prep") return "Clean demo started — fresh Pass ready.";
  if (a === "capture") {
    return name ? `Captured ${name}` : "Captured someone on Camera";
  }
  if (a === "public") {
    if (act === "blur") return name ? `Public stream: blurred ${name}` : "Public stream: blurred a person";
    if (act === "allow") return name ? `Public stream: showed ${name}` : "Public stream: showed a person";
    if (act === "deny") return name ? `Public stream: hid ${name}` : "Public stream: hid a person";
  }
  if (a === "internal") {
    if (act === "allow") return name ? `Operator view: showed ${name}` : "Operator view: showed a person";
    if (act === "blur") return name ? `Operator view: blurred ${name}` : "Operator view: blurred a person";
  }
  if (a === "export") {
    if (act === "allow") return name ? `Allowed a promo export for ${name}` : "Allowed a promo export";
    if (act === "block_export") return name ? `Blocked a promo export for ${name}` : "Blocked a promo export";
    if (act === "transform_export") return name ? `Limited export for ${name} (records only)` : "Limited export (records only)";
  }
  if (a === "policy") {
    if (act === "policy_update") {
      try {
        const parsed = JSON.parse(r.reason || "{}");
        if (parsed.promotional_use === true) {
          return name ? `Promo turned on for ${name}` : "Promo turned on";
        }
        if (parsed.promotional_use === false) {
          return name ? `Promo turned off for ${name}` : "Promo turned off";
        }
      } catch { /* ignore */ }
      return name ? `Pass updated for ${name}` : "Pass updated";
    }
    if (act === "attach_latest_pass") {
      return name ? `Linked capture to ${name}’s Pass` : "Linked capture to a Pass";
    }
  }
  if (act === "revoke" || r.reason === "revoked") {
    return name ? `Pass revoked for ${name}` : "Pass revoked";
  }
  // Fallback: skip noisy unknown lines lightly
  if (a === "all") return null;
  return null;
}

/** Map receipt → timeline marker class + short metric label */
function receiptVisual(r) {
  const a = r.audience;
  const act = r.action;
  if (act === "allow") return { mk: "mk-allow", label: "Allow" };
  if (act === "blur") return { mk: "mk-blur", label: "Blur" };
  if (act === "deny" || act === "block_export" || act === "revoke") return { mk: "mk-deny", label: act === "block_export" ? "Blocked" : act === "revoke" ? "Revoked" : "Deny" };
  if (act === "transform_export") return { mk: "mk-warn", label: "Limited" };
  if (a === "capture") return { mk: "mk-info", label: "Capture" };
  if (a === "demo") return { mk: "mk-info", label: act === "prep" ? "Prep" : "Reset" };
  if (a === "policy") return { mk: "mk-info", label: "Policy" };
  if (a === "export") return { mk: "mk-warn", label: "Export" };
  return { mk: "mk-info", label: "Update" };
}

function shortDecisionLabel(r) {
  const a = r.audience;
  const act = r.action;
  if (a === "export" && act === "allow") return "Promo allowed";
  if (a === "export" && (act === "block_export" || act === "deny")) return "Promo blocked";
  if (a === "export" && act === "transform_export") return "Export limited";
  if (a === "public" && act === "allow") return "Public allow";
  if (a === "public" && act === "blur") return "Public blur";
  if (a === "public" && act === "deny") return "Public deny";
  if (a === "capture") return "Captured";
  if (act === "revoke") return "Revoked";
  if (a === "demo" && act === "prep") return "Demo ready";
  if (a === "demo" && act === "reset") return "Wiped";
  if (a === "policy") return "Policy edit";
  return act || "—";
}

function relativeTime(iso) {
  try {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 10) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const d = new Date(t);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function loadActivity() {
  const res = await fetch(`${API}/receipts`);
  const list = await res.json();
  const el = document.getElementById("activityList");
  if (!list.length) {
    lastDecisionLabel = "—";
    updateMetrics();
    el.innerHTML = `<li class="muted">Nothing yet — run the demo to see decisions here.</li>`;
    return;
  }

  // Newest first for metric
  const newest = list[list.length - 1];
  if (newest) lastDecisionLabel = shortDecisionLabel(newest);
  updateMetrics();

  const lines = [];
  for (const r of [...list].reverse()) {
    const text = friendlyReceipt(r);
    if (!text) continue;
    const vis = receiptVisual(r);
    lines.push({ text, ts: r.ts, mk: vis.mk });
    if (lines.length >= 16) break;
  }

  if (!lines.length) {
    el.innerHTML = `<li class="muted">Nothing yet — run the demo to see decisions here.</li>`;
    return;
  }

  el.innerHTML = lines
    .map(
      (l) =>
        `<li>
          <span class="activity-marker ${l.mk}" aria-hidden="true"></span>
          <div class="activity-body">
            <span class="activity-time">${esc(relativeTime(l.ts))}</span>
            <span class="activity-text">${l.text}</span>
          </div>
        </li>`
    )
    .join("");
}

function updateSteps({ hasClip, hasExport }) {
  const steps = document.querySelectorAll("#demoSteps .step");
  if (steps.length < 4) return;
  const mark = (i, state) => {
    const s = steps[i];
    s.classList.remove("done", "active");
    if (state === "done") {
      s.classList.add("done");
      s.querySelector("span").textContent = "✓";
    } else if (state === "active") {
      s.classList.add("active");
      s.querySelector("span").textContent = String(i + 1);
    } else {
      s.querySelector("span").textContent = String(i + 1);
    }
  };
  mark(0, "done");
  if (!hasClip) {
    mark(1, "active");
    mark(2, "");
    mark(3, "");
  } else if (!hasExport) {
    mark(1, "done");
    mark(2, "active");
    mark(3, "");
  } else {
    mark(1, "done");
    mark(2, "done");
    mark(3, "active");
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}



async function loadAiStatus() {
  const crusoeEl = document.getElementById("crusoeChip");
  const orEl = document.getElementById("openRouterChip");
  const rightsEl = document.getElementById("rightsBackendChip");
  try {
    const res = await fetch(`${API}/ai/status`);
    const data = await res.json();
    if (crusoeEl) {
      if (data.crusoe?.ok) {
        crusoeEl.textContent = "AI · Crusoe";
        crusoeEl.className = "console-chip chip-ok";
        crusoeEl.title = data.crusoe.model
          ? `Crusoe primary · ${data.crusoe.model}`
          : "Crusoe ready";
      } else {
        crusoeEl.textContent = "AI · Crusoe";
        crusoeEl.className = "console-chip chip-muted";
        crusoeEl.title = "Crusoe not configured";
      }
    }
    if (orEl) {
      if (data.openrouter?.ok) {
        orEl.textContent = "AI · OpenRouter";
        orEl.className = "console-chip chip-ok";
        orEl.title = data.openrouter.model
          ? `OpenRouter fallback · ${data.openrouter.model}`
          : "OpenRouter ready";
      } else {
        orEl.textContent = "AI · OpenRouter";
        orEl.className = "console-chip chip-muted";
        orEl.title = "OpenRouter not configured";
      }
    }
    if (rightsEl && data.neo4j) {
      if (data.neo4j.ok && data.neo4j.backend === "neo4j") {
        rightsEl.textContent = "Rights graph · Neo4j";
        rightsEl.className = "console-chip chip-ok";
        rightsEl.title = data.neo4j.uri ? `Neo4j · ${data.neo4j.uri}` : "Neo4j connected";
      } else {
        rightsEl.textContent = "Rights graph · memory";
        rightsEl.className = "console-chip chip-muted";
        rightsEl.title = "In-memory fallback (Neo4j unavailable)";
      }
    }
  } catch {
    if (crusoeEl) {
      crusoeEl.className = "console-chip chip-muted";
      crusoeEl.title = "Could not reach /api/ai/status";
    }
    if (orEl) {
      orEl.className = "console-chip chip-muted";
      orEl.title = "Could not reach /api/ai/status";
    }
  }
}

async function loadAnomalies() {
  const strip = document.getElementById("anomalyStrip");
  if (!strip) return;
  try {
    const res = await fetch(`${API}/ai/anomalies`);
    const data = await res.json();
    const list = data.anomalies || [];
    if (!list.length) {
      strip.hidden = true;
      strip.innerHTML = "";
      return;
    }
    strip.hidden = false;
    strip.innerHTML = list
      .map((a) => {
        const cls =
          a.severity === "critical"
            ? "chip-bad"
            : a.severity === "warn"
              ? "chip-warn"
              : "chip-muted";
        return `<span class="console-chip ${cls}" title="${esc(a.detail)}">${esc(a.title)}</span>`;
      })
      .join("");
  } catch {
    /* keep prior strip */
  }
}

async function explainDecision() {
  const panel = document.getElementById("explainPanel");
  const textEl = document.getElementById("explainText");
  const modelChip = document.getElementById("explainModelChip");
  const btn = document.getElementById("btnExplain");
  if (!panel || !textEl) return;

  panel.hidden = false;
  textEl.textContent = "Thinking…";
  if (modelChip) {
    modelChip.textContent = "Crusoe→OpenRouter";
    modelChip.className = "console-chip chip-muted";
  }
  if (btn) btn.disabled = true;

  try {
    const body = latestClipId ? { clip_id: latestClipId } : {};
    const res = await fetch(`${API}/ai/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      textEl.textContent =
        data.error === "No AI backend configured"
          ? "No AI backend configured (Crusoe / OpenRouter)."
          : `Couldn’t explain: ${data.error || "something went wrong"}`;
      return;
    }
    textEl.textContent = data.text || "(empty)";
    if (modelChip) {
      const be = data.backend === "crusoe" ? "Crusoe" : "OpenRouter";
      modelChip.textContent = `${be} · ${data.model || ""}`.trim();
      modelChip.className = "console-chip chip-ok";
    }
  } catch (err) {
    textEl.textContent = "Couldn’t reach the explain API.";
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runConsentBrief() {
  const panel = document.getElementById("consentBriefPanel");
  const textEl = document.getElementById("consentBriefText");
  const chip = document.getElementById("consentBriefChip");
  const btn = document.getElementById("btnConsentBrief");
  if (!panel || !textEl) return;
  panel.hidden = false;
  textEl.textContent = "Gathering consent snapshot…";
  if (chip) {
    chip.textContent = "Crusoe";
    chip.className = "console-chip chip-muted";
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API}/ai/consent-brief`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      textEl.textContent = `Couldn’t brief: ${data.error || "error"}`;
      return;
    }
    textEl.textContent = data.text || "(empty)";
    if (chip) {
      const be = data.backend === "crusoe" ? "Crusoe" : "OpenRouter";
      chip.textContent = `${be} · ${data.model || ""}`.trim();
      chip.className = "console-chip chip-ok";
    }
  } catch {
    textEl.textContent = "Couldn’t reach consent-brief API.";
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runJudgePanel() {
  const panel = document.getElementById("judgePanel");
  const cardsEl = document.getElementById("judgeCards");
  const btn = document.getElementById("btnJudgePanel");
  if (!panel || !cardsEl) return;
  panel.hidden = false;
  cardsEl.innerHTML = `<p class="muted small">Asking models…</p>`;
  if (btn) btn.disabled = true;
  try {
    const body = latestClipId ? { clip_id: latestClipId } : {};
    const res = await fetch(`${API}/ai/judge-panel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      cardsEl.innerHTML = `<p class="muted small">${esc(data.error || "Judge panel failed")}</p>`;
      return;
    }
    cardsEl.innerHTML = (data.cards || [])
      .map((c) => {
        if (c.error) {
          return `<article class="judge-card judge-card-err">
            <div class="judge-card-model">${esc(c.model)}</div>
            <p class="judge-card-text">${esc(c.error)}</p>
          </article>`;
        }
        return `<article class="judge-card">
          <div class="judge-card-model">${esc(c.model)}</div>
          <p class="judge-card-text">${esc(c.text || "")}</p>
        </article>`;
      })
      .join("");
  } catch {
    cardsEl.innerHTML = `<p class="muted small">Couldn’t reach judge-panel API.</p>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runRevokeImpact(tokenId) {
  const panel = document.getElementById("revokeImpactPanel");
  const textEl = document.getElementById("revokeImpactText");
  const chip = document.getElementById("revokeImpactChip");
  const graphEl = document.getElementById("revokeImpactGraph");
  if (!panel || !textEl) return;
  panel.hidden = false;
  textEl.textContent = "Computing blast radius…";
  if (chip) {
    chip.textContent = "preview";
    chip.className = "console-chip chip-muted";
  }
  if (graphEl) {
    graphEl.hidden = true;
    graphEl.textContent = "";
  }
  try {
    const res = await fetch(`${API}/ai/revoke-impact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: tokenId }),
    });
    const data = await res.json();
    if (!res.ok) {
      textEl.textContent = `Couldn’t preview: ${data.error || "error"}`;
      return;
    }
    const g = data.graph || {};
    const n = data.narrative || {};
    textEl.textContent =
      n.text ||
      `${g.subject || "Pass"}: ${g.clip_count || 0} clip(s), ${g.export_count || 0} export(s).`;
    if (chip) {
      const be = n.backend === "crusoe" ? "Crusoe" : n.backend === "openrouter" ? "OpenRouter" : g.backend || "graph";
      chip.textContent = `${be} · ${g.clip_count || 0} clips`;
      chip.className = "console-chip chip-warn";
    }
    if (graphEl && g.clips) {
      graphEl.hidden = false;
      graphEl.textContent = JSON.stringify(
        {
          backend: g.backend,
          subject: g.subject,
          clip_count: g.clip_count,
          export_count: g.export_count,
          clips: g.clips,
        },
        null,
        2
      );
    }
  } catch {
    textEl.textContent = "Couldn’t reach revoke-impact API.";
  }
}

async function loadRightsBackend() {
  // Prefer unified /ai/status which also sets Neo4j chip
  await loadAiStatus();
}

async function refreshAll() {
  await loadPasses();
  await loadLatestClip();
  await loadClips();
  await loadActivity();
  await loadAiStatus();
  await loadAnomalies();
}

refreshAll();
setInterval(refreshAll, 2500);
