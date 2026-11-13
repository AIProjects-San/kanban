import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isActionError,
  isValidationError,
  actionErrorMessage,
  type ActionResult,
} from "@/lib/shared/action-result";

// ---------------------------------------------------------------------------
// The result envelope + the boundary-safe error classification.
// ---------------------------------------------------------------------------

describe("ok()", () => {
  it("supports falsy data (0, empty string, null) without collapsing to an error", () => {
    expect(ok(0)).toEqual({ ok: true, data: 0 });
    expect(ok("")).toEqual({ ok: true, data: "" });
    expect(ok(null)).toEqual({ ok: true, data: null });
  });
});

describe("err()", () => {
  it("wraps code + message in the failure shape", () => {
    expect(err("VALIDATION", "Title is required")).toEqual({
      ok: false,
      code: "VALIDATION",
      error: "Title is required",
    });
  });
});

describe("isActionError", () => {
  it("returns false for non-object input", () => {
    expect(isActionError(null)).toBe(false);
    expect(isActionError(undefined)).toBe(false);
    expect(isActionError("AuthorizationError")).toBe(false);
    expect(isActionError(42)).toBe(false);
  });

  it("returns true for an object with a boundary marker as digest or name", () => {
    const digestErr = new Error("nope") as Error & { digest?: string };
    digestErr.digest = "AuthorizationError";
    expect(isActionError(digestErr)).toBe(true);
    const nameErr = new Error("bad input");
    nameErr.name = "ValidationError";
    expect(isActionError(nameErr)).toBe(true);
  });

  it("returns false for an ordinary error", () => {
    expect(isActionError(new Error("P2002"))).toBe(false);
    expect(isActionError({ digest: "OTHER" })).toBe(false);
  });
});

describe("isValidationError", () => {
  it("matches by name or digest marker only", () => {
    const byName = new Error("bad");
    byName.name = "ValidationError";
    expect(isValidationError(byName)).toBe(true);
    const byDigest = { name: "Error", digest: "ValidationError" };
    expect(isValidationError(byDigest)).toBe(true);
    expect(isValidationError(new Error("plain"))).toBe(false);
    expect(isValidationError({ digest: "AuthorizationError" })).toBe(false);
  });
});

describe("actionErrorMessage", () => {
  it("returns the classified error's message", () => {
    const e = new Error("You must be signed in.") as Error & { digest?: string };
    e.digest = "AuthorizationError";
    expect(actionErrorMessage(e)).toBe("You must be signed in.");
  });

  it("falls back for unexpected errors and empty messages", () => {
    expect(actionErrorMessage(new Error("P2002"), "Try again.")).toBe("Try again.");
    const empty = new Error("") as Error & { digest?: string };
    empty.digest = "AuthorizationError";
    expect(actionErrorMessage(empty, "Try again.")).toBe("Try again.");
    expect(actionErrorMessage(null)).toBe("Something went wrong.");
  });
});

// Compile-time: the envelope stays a discriminated union.
const _r: ActionResult<number> = ok(1);
void _r;
