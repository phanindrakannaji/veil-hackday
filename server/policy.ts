/**
 * Veil Policy Service — ephemeral signed tokens + decision engine.
 * Keep it simple: HMAC-SHA256 over JSON payload (no heavy JWT lib).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type Permission =
  | "internal_recording"
  | "public_livestream"
  | "promotional_use"
  | "retention";

export type Treatment = "allow" | "blur" | "deny";

export type Audience = "internal" | "public" | "export";

export interface PolicyToken {
  token_id: string;
  subject: string; // ephemeral person id
  event_id: string;
  valid_from: string; // ISO
  valid_until: string; // ISO
  permissions: Record<Permission, boolean>;
  treatment: {
    public: Treatment;
    internal: Treatment;
  };
  revocable: boolean;
  revoked?: boolean;
}

export interface SignedToken {
  payload: PolicyToken;
  sig: string;
}

export type DecisionAction = "allow" | "blur" | "deny" | "block_export" | "transform_export";

export interface PolicyDecision {
  action: DecisionAction;
  reason: string;
  token_id: string;
  audience: Audience;
}

const SECRET = process.env.VEIL_HMAC_SECRET || "veil-hackday-demo-secret-change-me";

export function signToken(payload: PolicyToken): SignedToken {
  const body = canonical(payload);
  const sig = createHmac("sha256", SECRET).update(body).digest("hex");
  return { payload, sig };
}

export function verifyToken(signed: SignedToken): boolean {
  const expected = createHmac("sha256", SECRET)
    .update(canonical(signed.payload))
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signed.sig));
  } catch {
    return false;
  }
}

function canonical(payload: PolicyToken): string {
  return JSON.stringify(payload);
}

/**
 * Core decision: given a (possibly revoked/expired) token + audience → action.
 */
export function decide(
  token: PolicyToken | null,
  audience: Audience,
  now: Date = new Date()
): PolicyDecision {
  if (!token) {
    // Unknown / opt-out default: blur on public, allow internal for operator safety
    if (audience === "public") {
      return { action: "blur", reason: "unknown_or_opt_out", token_id: "none", audience };
    }
    if (audience === "export") {
      return { action: "block_export", reason: "unknown_or_opt_out", token_id: "none", audience };
    }
    return { action: "allow", reason: "unknown_internal_default", token_id: "none", audience };
  }

  if (token.revoked) {
    if (audience === "export") {
      return { action: "block_export", reason: "revoked", token_id: token.token_id, audience };
    }
    return { action: "deny", reason: "revoked", token_id: token.token_id, audience };
  }

  const from = new Date(token.valid_from).getTime();
  const until = new Date(token.valid_until).getTime();
  const t = now.getTime();
  if (t < from || t > until) {
    if (audience === "export") {
      return { action: "block_export", reason: "expired", token_id: token.token_id, audience };
    }
    return { action: "blur", reason: "expired", token_id: token.token_id, audience };
  }

  if (audience === "public") {
    if (!token.permissions.public_livestream) {
      return { action: "deny", reason: "permission_denied", token_id: token.token_id, audience };
    }
    return {
      action: token.treatment.public,
      reason: `treatment_${token.treatment.public}`,
      token_id: token.token_id,
      audience,
    };
  }

  if (audience === "internal") {
    if (!token.permissions.internal_recording) {
      return { action: "blur", reason: "permission_denied", token_id: token.token_id, audience };
    }
    return {
      action: token.treatment.internal,
      reason: `treatment_${token.treatment.internal}`,
      token_id: token.token_id,
      audience,
    };
  }

  // export / post-capture
  if (!token.permissions.promotional_use && !token.permissions.retention) {
    return { action: "block_export", reason: "no_export_rights", token_id: token.token_id, audience };
  }
  if (!token.permissions.promotional_use && token.permissions.retention) {
    return { action: "transform_export", reason: "retention_only", token_id: token.token_id, audience };
  }
  return { action: "allow", reason: "export_allowed", token_id: token.token_id, audience };
}

export function defaultPermissions(): Record<Permission, boolean> {
  return {
    internal_recording: true,
    public_livestream: false,
    promotional_use: false,
    retention: true,
  };
}
