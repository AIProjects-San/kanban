import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { signJwt, verifyJwt, resolveJwtSecret } from "@/lib/auth/jwt";

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
    // Flip a character in the MIDDLE of the signature. (The old version
    // flipped the LAST base64 char, which occasionally lands in the
    // ignored padding bits — the decoded 32 bytes stay identical and the
    // test flakes. A mid-string flip always changes the decoded bytes.)
    const MID = Math.floor(signatureB64.length / 2);
    const orig = signatureB64[MID];
    const flipped = orig === "A" ? "B" : "A";
    const flippedSig =
      signatureB64.slice(0, MID) + flipped + signatureB64.slice(MID + 1);
    expect(flippedSig).not.toBe(signatureB64); // guard against no-op flips
    // Decode both and confirm the tampered bytes actually differ.
    const origBytes = Buffer.from(signatureB64, "base64url");
    const flippedBytes = Buffer.from(flippedSig, "base64url");
    expect(flippedBytes.equals(origBytes)).toBe(false);
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

  it("rejects a token whose header is not valid JSON", () => {
    // Three base64url parts but the header doesn't decode to a JSON object —
    // verifyJwt must reject at the header JSON.parse catch (line 127), not
    // proceed to compare signatures against an undefined alg.
    const garbageHeader = Buffer.from("not json").toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(PAYLOAD)).toString("base64url");
    const sigB64 = Buffer.from("0".repeat(64), "utf8").toString("base64url");
    expect(verifyJwt(`${garbageHeader}.${payloadB64}.${sigB64}`)).toBeNull();
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

  // -------------------------------------------------------------------------
  // PR-56 — the per-claim type guards at the tail of verifyJwt. Each test
  // builds a VALIDLY-SIGNED token whose payload deliberately violates one
  // claim's type, so the rejection is attributable to the guard itself and
  // not to the signature check earlier in the function.
  // -------------------------------------------------------------------------

  /** Re-sign an arbitrary payload object with the correct header + secret. */
  function signRawPayload(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const input = `${header}.${payloadB64}`;
    const sig = createHmac("sha256", resolveJwtSecret()).update(input).digest();
    return `${input}.${Buffer.from(sig).toString("base64url")}`;
  }

  const VALID_CLAIMS = {
    sub: "u-mia",
    role: "MEMBER",
    name: "Mia Member",
    email: "mia@fernly.dev",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("rejects a signature of the wrong byte length (length check before timing-safe compare)", () => {
    // Valid header + payload, but a truncated signature: the length guard
    // (L135) must reject rather than hand mismatched buffers to
    // timingSafeEqual, which throws on length mismatch.
    const token = signJwt(PAYLOAD);
    const [headerB64, payloadB64, sigB64] = token.split(".");
    const shortSig = Buffer.from(sigB64, "base64url").subarray(0, 10).toString("base64url");
    expect(verifyJwt(`${headerB64}.${payloadB64}.${shortSig}`)).toBeNull();
  });

  it("rejects a payload whose exp is not a number (L146)", () => {
    expect(verifyJwt(signRawPayload({ ...VALID_CLAIMS, exp: "9999999999" }))).toBeNull();
    expect(verifyJwt(signRawPayload({ ...VALID_CLAIMS, exp: undefined }))).toBeNull();
  });

  it("rejects a payload whose iat is not a number (L151)", () => {
    expect(verifyJwt(signRawPayload({ ...VALID_CLAIMS, iat: "now" }))).toBeNull();
  });

  it("rejects a payload whose role is not a string (L152)", () => {
    expect(verifyJwt(signRawPayload({ ...VALID_CLAIMS, role: 42 }))).toBeNull();
  });

  it("rejects a payload whose name is not a string (L153)", () => {
    expect(verifyJwt(signRawPayload({ ...VALID_CLAIMS, name: null }))).toBeNull();
  });

  it("rejects a payload whose email is not a string (L154)", () => {
    expect(verifyJwt(signRawPayload({ ...VALID_CLAIMS, email: { s: "x" } }))).toBeNull();
  });
});
