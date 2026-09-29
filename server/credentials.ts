/**
 * Ephemeral credential / Pass store (in-memory).
 */

import { v4 as uuid } from "uuid";
import {
  type PolicyToken,
  type SignedToken,
  type Treatment,
  type Permission,
  signToken,
  defaultPermissions,
} from "./policy.js";

const tokens = new Map<string, SignedToken>();
/** Most recently issued token id — used to find unbound Passes for tap-face binding. */
let latestIssuedId: string | null = null;

export interface IssuePassInput {
  event_id?: string;
  subject?: string;
  ttl_minutes?: number;
  permissions?: Partial<Record<Permission, boolean>>;
  treatment?: Partial<{ public: Treatment; internal: Treatment }>;
}

export function issuePass(input: IssuePassInput = {}): SignedToken {
  const now = Date.now();
  const ttl = (input.ttl_minutes ?? 60) * 60 * 1000;
  const payload: PolicyToken = {
    token_id: uuid(),
    subject: input.subject ?? `ephemeral-${uuid().slice(0, 8)}`,
    event_id: input.event_id ?? "hackday-demo",
    valid_from: new Date(now).toISOString(),
    valid_until: new Date(now + ttl).toISOString(),
    permissions: { ...defaultPermissions(), ...input.permissions },
    treatment: {
      public: input.treatment?.public ?? "blur",
      internal: input.treatment?.internal ?? "allow",
    },
    revocable: true,
    revoked: false,
  };
  const signed = signToken(payload);
  tokens.set(payload.token_id, signed);
  latestIssuedId = payload.token_id;
  return signed;
}

export function getToken(tokenId: string): SignedToken | undefined {
  return tokens.get(tokenId);
}

export function listTokens(): SignedToken[] {
  return Array.from(tokens.values());
}

/** Latest non-revoked issued pass (bind target for one-tap Camera bind). */
export function getLatestActive(): SignedToken | null {
  if (latestIssuedId) {
    const t = tokens.get(latestIssuedId);
    if (t && !t.payload.revoked) return t;
  }
  // Fallback: most recently valid_from among active
  const active = Array.from(tokens.values())
    .filter((t) => !t.payload.revoked)
    .sort(
      (a, b) =>
        new Date(b.payload.valid_from).getTime() -
        new Date(a.payload.valid_from).getTime()
    );
  return active[0] ?? null;
}

export function revokeToken(tokenId: string): SignedToken | null {
  const existing = tokens.get(tokenId);
  if (!existing) return null;
  const updated: PolicyToken = { ...existing.payload, revoked: true };
  const signed = signToken(updated);
  tokens.set(tokenId, signed);
  if (latestIssuedId === tokenId) latestIssuedId = null;
  return signed;
}

export function updateTokenPolicy(
  tokenId: string,
  patch: {
    permissions?: Partial<Record<Permission, boolean>>;
    treatment?: Partial<{ public: Treatment; internal: Treatment }>;
  }
): SignedToken | null {
  const existing = tokens.get(tokenId);
  if (!existing) return null;
  const updated: PolicyToken = {
    ...existing.payload,
    permissions: { ...existing.payload.permissions, ...patch.permissions },
    treatment: {
      public: patch.treatment?.public ?? existing.payload.treatment.public,
      internal: patch.treatment?.internal ?? existing.payload.treatment.internal,
    },
  };
  const signed = signToken(updated);
  tokens.set(tokenId, signed);
  return signed;
}

export function clearAllTokens(): void {
  tokens.clear();
  latestIssuedId = null;
}
