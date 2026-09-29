/**
 * Unit tests for policy decide(token, audience) → allow|blur|deny|…
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  signToken,
  verifyToken,
  type PolicyToken,
  defaultPermissions,
} from "../server/policy.js";

function makeToken(overrides: Partial<PolicyToken> = {}): PolicyToken {
  const now = Date.now();
  return {
    token_id: "tok-test-1",
    subject: "ephemeral-abc",
    event_id: "hackday-demo",
    valid_from: new Date(now - 60_000).toISOString(),
    valid_until: new Date(now + 3_600_000).toISOString(),
    permissions: defaultPermissions(),
    treatment: { public: "blur", internal: "allow" },
    revocable: true,
    revoked: false,
    ...overrides,
  };
}

describe("decide — unknown / null token", () => {
  it("blurs public for unknown", () => {
    const d = decide(null, "public");
    assert.equal(d.action, "blur");
    assert.equal(d.reason, "unknown_or_opt_out");
  });

  it("allows internal for unknown (operator default)", () => {
    const d = decide(null, "internal");
    assert.equal(d.action, "allow");
  });

  it("blocks export for unknown", () => {
    const d = decide(null, "export");
    assert.equal(d.action, "block_export");
  });
});

describe("decide — valid token treatments", () => {
  it("public follows treatment.blur", () => {
    const t = makeToken({
      permissions: { ...defaultPermissions(), public_livestream: true },
      treatment: { public: "blur", internal: "allow" },
    });
    assert.equal(decide(t, "public").action, "blur");
  });

  it("public allow when treatment.allow", () => {
    const t = makeToken({
      permissions: { ...defaultPermissions(), public_livestream: true },
      treatment: { public: "allow", internal: "allow" },
    });
    assert.equal(decide(t, "public").action, "allow");
  });

  it("public deny when treatment.deny", () => {
    const t = makeToken({
      permissions: { ...defaultPermissions(), public_livestream: true },
      treatment: { public: "deny", internal: "allow" },
    });
    assert.equal(decide(t, "public").action, "deny");
  });

  it("denies public when permission off", () => {
    const t = makeToken({
      permissions: { ...defaultPermissions(), public_livestream: false },
      treatment: { public: "allow", internal: "allow" },
    });
    assert.equal(decide(t, "public").action, "deny");
    assert.equal(decide(t, "public").reason, "permission_denied");
  });

  it("internal allow by default", () => {
    const t = makeToken();
    assert.equal(decide(t, "internal").action, "allow");
  });
});

describe("decide — revoked / expired", () => {
  it("revoked → deny public, block export", () => {
    const t = makeToken({ revoked: true });
    assert.equal(decide(t, "public").action, "deny");
    assert.equal(decide(t, "export").action, "block_export");
  });

  it("expired → blur public", () => {
    const t = makeToken({
      valid_from: new Date(Date.now() - 10_000_000).toISOString(),
      valid_until: new Date(Date.now() - 5_000).toISOString(),
    });
    assert.equal(decide(t, "public").action, "blur");
    assert.equal(decide(t, "public").reason, "expired");
  });
});

describe("decide — export / post-capture", () => {
  it("blocks when no promo and no retention", () => {
    const t = makeToken({
      permissions: {
        ...defaultPermissions(),
        promotional_use: false,
        retention: false,
      },
    });
    assert.equal(decide(t, "export").action, "block_export");
  });

  it("transforms when retention only", () => {
    const t = makeToken({
      permissions: {
        ...defaultPermissions(),
        promotional_use: false,
        retention: true,
      },
    });
    assert.equal(decide(t, "export").action, "transform_export");
  });

  it("allows when promotional_use", () => {
    const t = makeToken({
      permissions: {
        ...defaultPermissions(),
        promotional_use: true,
        retention: true,
      },
    });
    assert.equal(decide(t, "export").action, "allow");
  });
});

describe("sign / verify", () => {
  it("round-trips signature", () => {
    const t = makeToken();
    const signed = signToken(t);
    assert.equal(verifyToken(signed), true);
    assert.equal(verifyToken({ ...signed, sig: "deadbeef" }), false);
  });
});
