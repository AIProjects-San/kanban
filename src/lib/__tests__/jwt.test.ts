import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { signJwt, verifyJwt, resolveJwtSecret } from "@/lib/jwt";

// PR-54 — JWT sign/verify unit tests. Purely cryptographic (no DB); the
// session-resolution integration is covered by auth-better.test.ts.

const PAYLOAD = {
  sub: "u-mia",
  role: "MEMBER",
  name: "Mia Member",
  email: "mia@fernly.dev",
};

describe("PR-54 signJwt / verifyJwt", () => {
  beforeEach(() => {
    // Pin a stable secret so sign + verify use the same value. The dev
    // fallback caches a UUID, but pinning the env var makes the tests
    // deterministic and independent of module-load order.
    process.env.BETTER_AUTH_SECRET = "test-secret-for-jwt-tests-32chars!!";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips: verify returns the payload that was signed", () => {
    const token = signJwt(PAYLOAD);
    const decoded = verifyJwt(token);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.sub).toBe("u-mia");
    expect(decoded.role).toBe("MEMBER");
    expect(decoded.name).toBe("Mia Member");
    expect(decoded.email).toBe("mia@fernly.dev");
    expect(decoded.iat).toBeTypeOf("number");
    expect(decoded.exp).toBe(decoded.iat + 3600); // 1h default
  });

  it("produces a three-part compact serialization", () => {
    const token = signJwt(PAYLOAD);
    expect(token.split(".")).toHaveLength(3);
    // Header should declare HS256.
    const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");
  });

  it("honours a custom ttl", () => {
    const token = signJwt(PAYLOAD, 120); // 2 minutes
    const decoded = verifyJwt(token);
    if (!decoded) throw new Error("expected decoded");
    expect(decoded.exp - decoded.iat).toBe(120);
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const token = signJwt(PAYLOAD);
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    // Flip the role claim in the payload.
    const tamperedPayload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    );
    tamperedPayload.role = "ADMIN";
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url");
    const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;
    expect(verifyJwt(tamperedToken)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signJwt(PAYLOAD);
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    // Flip a character in the signature.
    const flippedSig =
      signatureB64.slice(0, -1) +
      (signatureB64.endsWith("A") ? "B" : "A");
    expect(verifyJwt(`${headerB64}.${payloadB64}.${flippedSig}`)).toBeNull();
  });

  it("rejects an expired token", () => {
    // Sign with ttl=0 → exp = now, which is <= now at verify time.
    const token = signJwt(PAYLOAD, -10); // expired 10 seconds ago
    expect(verifyJwt(token)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    process.env.BETTER_AUTH_SECRET = "first-secret-aaaaaaaaaaaaaaaaaaaaaa";
    const token = signJwt(PAYLOAD);
    process.env.BETTER_AUTH_SECRET = "second-secret-bbbbbbbbbbbbbbbbbbbbbb";
    expect(verifyJwt(token)).toBeNull();
  });

  it("rejects the `alg: none` confusion attack", () => {
    const token = signJwt(PAYLOAD);
    const [, payloadB64, signatureB64] = token.split(".");
    // Forge a header with alg: none — the signature should now be ignored
    // by a vulnerable verifier, but verifyJwt rejects non-HS256 algs.
    const forgedHeader = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    expect(verifyJwt(`${forgedHeader}.${payloadB64}.${signatureB64}`)).toBeNull();
  });

  it("rejects a malformed token (not three parts)", () => {
    expect(verifyJwt("not.a.jwt.token")).toBeNull();
    expect(verifyJwt("onlyonepart")).toBeNull();
    expect(verifyJwt("")).toBeNull();
  });

  it("rejects a token with a non-JSON payload", () => {
    const token = signJwt(PAYLOAD);
    const [headerB64] = token.split(".");
    const garbagePayload = Buffer.from("not json").toString("base64url");
    // Re-sign the garbage payload so the signature is valid — verifyJwt
    // must still reject it at the JSON-parse step.
    const input = `${headerB64}.${garbagePayload}`;
    const sig = createHmac("sha256", resolveJwtSecret()).update(input).digest();
    const sigB64 = Buffer.from(sig).toString("base64url");
    expect(verifyJwt(`${input}.${sigB64}`)).toBeNull();
  });

  it("rejects a token missing required claims", () => {
    const token = signJwt(PAYLOAD);
    const [headerB64, payloadB64] = token.split(".");
    // Remove the sub claim.
    const partial = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    delete partial.sub;
    const partialB64 = Buffer.from(JSON.stringify(partial)).toString("base64url");
    // Re-sign with the correct key so the signature is valid, but the
    // payload lacks `sub`. (A real attacker can't re-sign without the
    // secret, but this confirms verifyJwt validates claim presence.)
    const input = `${headerB64}.${partialB64}`;
    const sig = createHmac("sha256", resolveJwtSecret()).update(input).digest();
    const sigB64 = Buffer.from(sig).toString("base64url");
    expect(verifyJwt(`${input}.${sigB64}`)).toBeNull();
  });

  it("caches the dev-fallback secret so sign + verify round-trip without BETTER_AUTH_SECRET", () => {
    delete process.env.BETTER_AUTH_SECRET;
    const token = signJwt(PAYLOAD);
    expect(verifyJwt(token)).not.toBeNull();
  });
});
