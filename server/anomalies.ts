/**
 * Heuristic anomaly detection from receipts / clips / passes (no LLM required).
 */

import { listTokens } from "./credentials.js";
import { listReceipts } from "./receipts.js";
import { listClips } from "./rights-graph.js";

export type Anomaly = {
  id: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
};

export function detectAnomalies(): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const receipts = listReceipts();
  const clips = listClips();
  const tokens = listTokens();
  const activeIds = new Set(
    tokens.filter((t) => !t.payload.revoked).map((t) => t.payload.token_id)
  );
  const revokedIds = new Set(
    tokens.filter((t) => t.payload.revoked).map((t) => t.payload.token_id)
  );

  // Unbound risk: clips without Pass, or recent capture/decide receipts unbound
  const unboundClips = clips.filter(
    (c) => !c.token_id || c.token_id === "none" || c.token_id === "unknown"
  );
  const recentWindow = receipts.slice(-30);
  const unboundRecent = recentWindow.filter(
    (r) =>
      (!r.token_id || r.token_id === "none" || r.token_id === "unknown") &&
      (r.audience === "capture" || r.audience === "export") &&
      r.track_id !== "n/a"
  );
  if (unboundClips.length || unboundRecent.length >= 2) {
    anomalies.push({
      id: "unbound_risk",
      severity: "warn",
      title: "Unbound risk",
      detail: `${unboundClips.length} unbound clip(s); ${unboundRecent.length} recent capture/export receipt(s) without a Pass.`,
    });
  }

  // Deny spikes on public (recent window)
  const recent = receipts.slice(-40);
  const publicDenies = recent.filter(
    (r) => r.audience === "public" && r.action === "deny"
  );
  if (publicDenies.length >= 4) {
    anomalies.push({
      id: "deny_spike",
      severity: "warn",
      title: "Deny spike (public)",
      detail: `${publicDenies.length} public deny decisions in the recent window.`,
    });
  }

  // Pending exports
  const pending = clips.filter((c) => c.export_status === "pending");
  if (pending.length >= 1) {
    anomalies.push({
      id: "pending_exports",
      severity: pending.length >= 3 ? "warn" : "info",
      title: "Pending exports",
      detail: `${pending.length} capture(s) still awaiting export decision.`,
    });
  }

  // Revoked passes still with clips
  const revokedWithClips = clips.filter((c) => revokedIds.has(c.token_id));
  if (revokedWithClips.length) {
    const subjects = [
      ...new Set(revokedWithClips.map((c) => c.subject).filter(Boolean)),
    ];
    anomalies.push({
      id: "revoked_with_clips",
      severity: "critical",
      title: "Revoked Pass still has clips",
      detail: `${revokedWithClips.length} clip(s) linked to revoked Pass(es)${
        subjects.length ? ` (${subjects.slice(0, 3).join(", ")})` : ""
      }.`,
    });
  }

  // Orphan clips whose token is gone from store (neither active nor revoked)
  const orphan = clips.filter(
    (c) =>
      c.token_id &&
      c.token_id !== "none" &&
      c.token_id !== "unknown" &&
      !activeIds.has(c.token_id) &&
      !revokedIds.has(c.token_id)
  );
  if (orphan.length) {
    anomalies.push({
      id: "orphan_clips",
      severity: "info",
      title: "Orphan clips",
      detail: `${orphan.length} clip(s) reference tokens no longer in the Pass store.`,
    });
  }

  return anomalies;
}
