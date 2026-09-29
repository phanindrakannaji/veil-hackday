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
  getRightsGraph,
  clearClipsAndEdges,
} from "./rights-graph.js";

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

api.get("/rights-graph", (_req, res) => {
  res.json({ edges: getRightsGraph(), clips: listClips() });
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

  const promo = req.body?.promotional_use;
  if (typeof promo === "boolean" && clip.token_id && clip.token_id !== "none") {
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

// --- Health / LAN info ---

api.get("/health", (_req, res) => {
  res.json({ ok: true, service: "veil-hackday" });
});
