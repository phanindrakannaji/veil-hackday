/**
 * REST API for Veil Hack Day demo.
 */

import { Router, type Request, type Response } from "express";
import {
  issuePass,
  getToken,
  listTokens,
  revokeToken,
  updateTokenPolicy,
  getLatestActive,
  clearAllTokens,
} from "./credentials.js";
import { decide, verifyToken, type Audience } from "./policy.js";
import { writeReceipt, listReceipts, clearReceipts } from "./receipts.js";
import {
  createClip,
  listClips,
  getClip,
  getLatestClip,
  updateClipExport,
  clearClipsAndEdges,
  getRightsGraphPayload,
  getRightsGraph,
  memoryRevokeImpact,
} from "./rights-graph.js";
import { isNeo4jReady, getNeo4jUri, initNeo4j, queryRevokeImpact } from "./neo4j.js";
import {
  isOpenRouterReady,
  getOpenRouterModel,
} from "./openrouter.js";
import {
  isCrusoeReady,
  getCrusoeModel,
} from "./crusoe.js";
import {
  explainDecision,
  consentBrief,
  revokeImpactNarrative,
  runJudgePanel,
  aiStatusPayload,
} from "./ai.js";
import { detectAnomalies } from "./anomalies.js";

export const api = Router();

/** Bumped on demo reset so Camera can re-seed an unknown track. */
let demoEpoch = 1;

// --- Pass / credentials ---

api.post("/pass/issue", (req: Request, res: Response) => {
  const signed = issuePass(req.body ?? {});
  res.json(signed);
});

api.get("/pass", (_req, res) => {
  res.json(listTokens());
});

/** One-tap bind target: most recently issued active pass. */
api.get("/pass/latest", (_req, res) => {
  const t = getLatestActive();
  if (!t) return res.status(404).json({ error: "no_active_pass" });
  res.json(t);
});

api.get("/pass/:tokenId", (req, res) => {
  const t = getToken(req.params.tokenId);
  if (!t) return res.status(404).json({ error: "not_found" });
  res.json(t);
});

api.post("/pass/:tokenId/revoke", (req, res) => {
  const t = revokeToken(req.params.tokenId);
  if (!t) return res.status(404).json({ error: "not_found" });
  writeReceipt({
    token_id: t.payload.token_id,
    track_id: "n/a",
    audience: "all",
    action: "revoke",
    reason: "user_revoked",
  });
  res.json(t);
});

api.patch("/pass/:tokenId", (req, res) => {
  const t = updateTokenPolicy(req.params.tokenId, req.body ?? {});
  if (!t) return res.status(404).json({ error: "not_found" });
  writeReceipt({
    token_id: t.payload.token_id,
    track_id: "n/a",
    audience: "policy",
    action: "policy_update",
    reason: JSON.stringify(req.body ?? {}),
  });
  res.json(t);
});

// Quick toggles from Pass page
api.post("/pass/:tokenId/public", (req, res) => {
  const mode = (req.body?.mode as string) || "blur"; // allow | blur | deny
  const treatment =
    mode === "allow" ? "allow" : mode === "deny" ? "deny" : "blur";
  const permissions =
    mode === "allow"
      ? { public_livestream: true }
      : mode === "deny"
        ? { public_livestream: false }
        : { public_livestream: true };

  const t = updateTokenPolicy(req.params.tokenId, {
    permissions,
    treatment: { public: treatment as "allow" | "blur" | "deny" },
  });
  if (!t) return res.status(404).json({ error: "not_found" });
  writeReceipt({
    token_id: t.payload.token_id,
    track_id: "n/a",
    audience: "public",
    action: treatment,
    reason: "pass_toggle",
  });
  res.json(t);
});

// --- Policy decide ---

api.post("/decide", (req, res) => {
  const { token_id, track_id, audience } = req.body as {
    token_id?: string;
    track_id?: string;
    audience: Audience;
  };
  const signed = token_id ? getToken(token_id) : undefined;
  if (signed && !verifyToken(signed)) {
    return res.status(400).json({ error: "bad_signature" });
  }
  const decision = decide(signed?.payload ?? null, audience ?? "public");
  const receipt = writeReceipt({
    token_id: decision.token_id,
    track_id: track_id ?? "unknown",
    audience: decision.audience,
    action: decision.action,
    reason: decision.reason,
  });
  res.json({ decision, receipt });
});

// --- Receipts & rights graph ---

api.get("/receipts", (_req, res) => {
  res.json(listReceipts());
});

api.get("/rights-graph", async (_req, res) => {
  res.json(await getRightsGraphPayload());
});

api.get("/neo4j/status", async (_req, res) => {
  // Soft re-try if previously disabled but Neo4j came up later
  if (!isNeo4jReady()) {
    await initNeo4j();
  }
  const ok = isNeo4jReady();
  res.json({
    ok,
    uri: getNeo4jUri(),
    backend: ok ? "neo4j" : "memory",
  });
});

// --- AI status / explain / Crusoe + OpenRouter ---

api.get("/openrouter/status", (_req, res) => {
  const ok = isOpenRouterReady();
  if (ok) {
    res.json({ ok: true, model: getOpenRouterModel() });
  } else {
    res.json({ ok: false });
  }
});

api.get("/crusoe/status", (_req, res) => {
  const ok = isCrusoeReady();
  if (ok) {
    res.json({ ok: true, model: getCrusoeModel() });
  } else {
    res.json({ ok: false });
  }
});

api.get("/ai/status", async (_req, res) => {
  if (!isNeo4jReady()) {
    await initNeo4j();
  }
  const neoOk = isNeo4jReady();
  res.json(
    aiStatusPayload({
      ok: neoOk,
      uri: getNeo4jUri(),
      backend: neoOk ? "neo4j" : "memory",
    })
  );
});

api.post("/ai/explain", async (req, res) => {
  if (!isCrusoeReady() && !isOpenRouterReady()) {
    return res.status(503).json({ error: "No AI backend configured" });
  }

  const clipId = typeof req.body?.clip_id === "string" ? req.body.clip_id : undefined;
  let clip = clipId ? getClip(clipId) : getLatestClip();
  if (clipId && !clip) {
    return res.status(404).json({ error: "clip_not_found" });
  }
  if (!clip) {
    clip = getLatestClip() ?? undefined;
  }

  const receipts = listReceipts().slice(-8);
  let edges: ReturnType<typeof getRightsGraph> = [];
  try {
    const graph = await getRightsGraphPayload();
    edges = (graph.edges ?? []).slice(-12);
  } catch {
    edges = getRightsGraph().slice(-12);
  }

  try {
    const { text, model, backend } = await explainDecision({
      clip: clip ?? null,
      receipts,
      edges,
      question: typeof req.body?.question === "string" ? req.body.question : undefined,
    });
    res.json({ text, model, backend });
  } catch (err) {
    const msg = (err as Error).message || "explain_failed";
    const status = /not configured/i.test(msg) ? 503 : 502;
    res.status(status).json({ error: msg });
  }
});

api.post("/ai/consent-brief", async (_req, res) => {
  if (!isCrusoeReady() && !isOpenRouterReady()) {
    return res.status(503).json({ error: "No AI backend configured" });
  }
  const passes = listTokens()
    .filter((t) => !t.payload.revoked)
    .map((t) => ({
      subject: t.payload.subject,
      token_id: t.payload.token_id,
      public: t.payload.treatment?.public,
      promotional_use: !!t.payload.permissions?.promotional_use,
    }));
  const clips = listClips();
  const bySubject: Record<string, number> = {};
  for (const c of clips) {
    bySubject[c.subject] = (bySubject[c.subject] || 0) + 1;
  }
  const context = {
    active_passes: passes,
    clip_counts_by_subject: bySubject,
    total_clips: clips.length,
    pending_exports: clips.filter((c) => c.export_status === "pending").length,
  };
  try {
    const { text, model, backend } = await consentBrief(context);
    res.json({ text, model, backend, context });
  } catch (err) {
    const msg = (err as Error).message || "consent_brief_failed";
    const status = /not configured/i.test(msg) ? 503 : 502;
    res.status(status).json({ error: msg });
  }
});

api.post("/ai/revoke-impact", async (req, res) => {
  const tokenId =
    typeof req.body?.token_id === "string" ? req.body.token_id.trim() : "";
  if (!tokenId) {
    return res.status(400).json({ error: "token_id required" });
  }

  let graph = await queryRevokeImpact(tokenId);
  if (!graph) {
    graph = memoryRevokeImpact(tokenId);
  }
  // Enrich subject from credentials if Neo4j missed it
  if (!graph.subject) {
    const t = getToken(tokenId);
    if (t) {
      graph = { ...graph, subject: t.payload.subject, pass_found: true };
    }
  }

  let narrative: { text: string; model: string; backend: string } | null = null;
  if (isCrusoeReady() || isOpenRouterReady()) {
    try {
      narrative = await revokeImpactNarrative(graph);
    } catch (err) {
      narrative = {
        text: `Impact preview unavailable from AI (${(err as Error).message}). ${graph.clip_count} clip(s), ${graph.export_count} export edge(s).`,
        model: "none",
        backend: graph.backend,
      };
    }
  } else {
    narrative = {
      text: `${graph.subject || "This Pass"} has ${graph.clip_count} linked clip(s) and ${graph.export_count} export record(s). Revoking opts them out of live public treatment.`,
      model: "heuristic",
      backend: graph.backend,
    };
  }

  res.json({ graph, narrative });
});

api.post("/ai/judge-panel", async (req, res) => {
  if (!isOpenRouterReady()) {
    return res.status(503).json({ error: "OpenRouter not configured" });
  }

  const clipId = typeof req.body?.clip_id === "string" ? req.body.clip_id : undefined;
  let clip = clipId ? getClip(clipId) : getLatestClip();
  const receipts = listReceipts().slice(-8);
  let edges: ReturnType<typeof getRightsGraph> = [];
  try {
    const graph = await getRightsGraphPayload();
    edges = (graph.edges ?? []).slice(-12);
  } catch {
    edges = getRightsGraph().slice(-12);
  }

  const context = {
    clip: clip ?? null,
    recent_receipts: receipts,
    rights_graph_edges: edges,
    question:
      typeof req.body?.question === "string"
        ? req.body.question
        : "Judge panel: short take on this consent/export decision.",
  };

  try {
    const { cards, models } = await runJudgePanel(context);
    res.json({ cards, models });
  } catch (err) {
    const msg = (err as Error).message || "judge_panel_failed";
    const status = /not configured/i.test(msg) ? 503 : 502;
    res.status(status).json({ error: msg });
  }
});

api.get("/ai/anomalies", (_req, res) => {
  const anomalies = detectAnomalies();
  res.json({ anomalies, count: anomalies.length });
});

// --- Clip stubs (post-capture) ---

api.post("/clips", (req, res) => {
  const { track_id, subject, token_id, label } = req.body ?? {};
  if (!track_id || !subject || !token_id) {
    return res.status(400).json({ error: "track_id, subject, token_id required" });
  }
  const clip = createClip({ track_id, subject, token_id, label });
  writeReceipt({
    token_id,
    track_id,
    audience: "capture",
    action: "clip_created",
    reason: clip.clip_id,
  });
  res.json(clip);
});

api.get("/clips", (_req, res) => {
  res.json(listClips());
});

api.get("/clips/latest", (_req, res) => {
  const clip = getLatestClip();
  if (!clip) return res.status(404).json({ error: "no_clips" });
  res.json(clip);
});

api.post("/clips/:clipId/export", (req, res) => {
  const clip = getClip(req.params.clipId);
  if (!clip) return res.status(404).json({ error: "not_found" });

  const signed = getToken(clip.token_id);
  const decision = decide(signed?.payload ?? null, "export");

  let status: "allowed" | "blocked" | "transformed" = "blocked";
  if (decision.action === "allow") status = "allowed";
  else if (decision.action === "transform_export") status = "transformed";
  else status = "blocked";

  const updated = updateClipExport(clip.clip_id, status, decision.action);
  writeReceipt({
    token_id: clip.token_id,
    track_id: clip.track_id,
    audience: "export",
    action: decision.action,
    reason: decision.reason,
  });
  res.json({ clip: updated, decision });
});

/**
 * Change policy on a clip's token then re-export in one shot.
 * body: { promotional_use?: boolean }
 */
api.post("/clips/:clipId/policy-export", (req, res) => {
  const clip = getClip(req.params.clipId);
  if (!clip) return res.status(404).json({ error: "not_found" });

  // Heal demo clips captured before bind (token_id "none")
  if (!clip.token_id || clip.token_id === "none") {
    const latest = getLatestActive();
    if (!latest) {
      return res.status(400).json({
        error: "clip_unbound",
        hint: "Bind a Pass on Camera, Capture again, then retry export.",
      });
    }
    clip.token_id = latest.payload.token_id;
    clip.subject = latest.payload.subject;
    writeReceipt({
      token_id: clip.token_id,
      track_id: clip.track_id,
      audience: "policy",
      action: "attach_latest_pass",
      reason: "healed_unbound_clip",
    });
  }

  const promo = req.body?.promotional_use;
  if (typeof promo === "boolean") {
    const patched = updateTokenPolicy(clip.token_id, {
      permissions: { promotional_use: promo },
    });
    if (patched) {
      writeReceipt({
        token_id: clip.token_id,
        track_id: clip.track_id,
        audience: "policy",
        action: "policy_update",
        reason: JSON.stringify({ promotional_use: promo }),
      });
    }
  }

  const signed = getToken(clip.token_id);
  const decision = decide(signed?.payload ?? null, "export");

  let status: "allowed" | "blocked" | "transformed" = "blocked";
  if (decision.action === "allow") status = "allowed";
  else if (decision.action === "transform_export") status = "transformed";
  else status = "blocked";

  const updated = updateClipExport(clip.clip_id, status, decision.action);
  writeReceipt({
    token_id: clip.token_id,
    track_id: clip.track_id,
    audience: "export",
    action: decision.action,
    reason: decision.reason,
  });
  res.json({ clip: updated, decision });
});

// --- Demo reset ---

api.get("/demo/epoch", (_req, res) => {
  res.json({ epoch: demoEpoch });
});

api.post("/demo/reset", (_req, res) => {
  clearAllTokens();
  clearClipsAndEdges();
  clearReceipts();
  demoEpoch += 1;
  writeReceipt({
    token_id: "none",
    track_id: "n/a",
    audience: "demo",
    action: "reset",
    reason: `epoch_${demoEpoch}`,
  });
  res.json({
    ok: true,
    epoch: demoEpoch,
    note: "Cleared tokens/clips/receipts. Camera will re-seed one unknown person.",
  });
});

/** Reset + issue a fresh Pass ready for Camera bind. */
api.post("/demo/prep", (_req, res) => {
  clearAllTokens();
  clearClipsAndEdges();
  clearReceipts();
  demoEpoch += 1;
  const signed = issuePass({
    event_id: "hackday-demo",
    ttl_minutes: 120,
    permissions: {
      internal_recording: true,
      public_livestream: true,
      promotional_use: false,
      retention: true,
    },
    treatment: { public: "blur", internal: "allow" },
  });
  writeReceipt({
    token_id: signed.payload.token_id,
    track_id: "n/a",
    audience: "demo",
    action: "prep",
    reason: `epoch_${demoEpoch}`,
  });
  res.json({
    ok: true,
    epoch: demoEpoch,
    pass: signed,
    note: "Clean slate + Pass issued. Camera re-seeds Unknown; tap Scan / bind latest Pass.",
  });
});

// --- Health / LAN info ---

api.get("/health", (_req, res) => {
  res.json({ ok: true, service: "veil-hackday" });
});
