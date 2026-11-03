import { describe, it, expect } from "vitest";
import { hashPii } from "@/lib/pii";
import { createHash } from "node:crypto";

// PR-56 — the PII hashing helper had no direct suite; the falsy-input
// branch ("unknown") and the 8-hex-char truncation contract were untested.

describe("hashPii (L-P1 observability support)", () => {
  it("hashes a value to the first 8 hex chars of its SHA-256 digest", () => {
    const expected = createHash("sha256").update("ada@fernly.dev").digest("hex").slice(0, 8);
    expect(hashPii("ada@fernly.dev")).toBe(expected);
    expect(hashPii("ada@fernly.dev")).toHaveLength(8);
    expect(hashPii("ada@fernly.dev")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable across calls (correlation, not randomness)", () => {
    expect(hashPii("203.0.113.10")).toBe(hashPii("203.0.113.10"));
  });

  it("distinct inputs hash to distinct tokens", () => {
    expect(hashPii("a@x.co")).not.toBe(hashPii("b@x.co"));
  });

  it("maps missing values to the literal 'unknown' token", () => {
    expect(hashPii(undefined)).toBe("unknown");
    expect(hashPii(null)).toBe("unknown");
    expect(hashPii("")).toBe("unknown");
  });
});
