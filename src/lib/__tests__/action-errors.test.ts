import { describe, it, expect } from "vitest";
import {
  isActionError,
  actionErrorMessage,
} from "@/lib/action-errors";

// ---------------------------------------------------------------------------
// isActionError / actionErrorMessage — client-safe error classification.
// ---------------------------------------------------------------------------

describe("isActionError", () => {
  it("returns false for non-object input", () => {
    expect(isActionError(null)).toBe(false);
    expect(isActionError(undefined)).toBe(false);
    expect(isActionError("AuthorizationError")).toBe(false);
    expect(isActionError(42)).toBe(false);
  });

  it("returns true for an object with digest=AuthorizationError", () => {
    const e = new Error("nope") as Error & { digest?: string };
    e.digest = "AuthorizationError";
    expect(isActionError(e)).toBe(true);
  });

  it("returns true for an object with digest=ValidationError", () => {
    const e = new Error("bad input") as Error & { digest?: string };
    e.digest = "ValidationError";
    expect(isActionError(e)).toBe(true);
  });

  it("returns true for an object with name=AuthorizationError", () => {
    const e = new Error("nope");
    e.name = "AuthorizationError";
    expect(isActionError(e)).toBe(true);
  });

  it("returns true for an object with name=ValidationError", () => {
    const e = new Error("bad input");
    e.name = "ValidationError";
    expect(isActionError(e)).toBe(true);
  });

  it("returns false for an unrelated error (TypeError, network, etc.)", () => {
    expect(isActionError(new TypeError("x is undefined"))).toBe(false);
    expect(isActionError(new Error("Network down"))).toBe(false);
    expect(isActionError({ digest: "SomethingElse" })).toBe(false);
    expect(isActionError({ name: "RangeError" })).toBe(false);
  });

  it("returns false when digest/name are present but not strings", () => {
    expect(isActionError({ digest: 123 })).toBe(false);
    expect(isActionError({ name: null })).toBe(false);
  });
});

describe("actionErrorMessage", () => {
  it("returns the error message for an AuthorizationError with a real message", () => {
    const e = new Error("You can only edit tasks that are assigned to you.");
    e.name = "AuthorizationError";
    expect(actionErrorMessage(e)).toBe(
      "You can only edit tasks that are assigned to you.",
    );
  });

  it("returns a permission-style fallback when the message starts with 'An unexpected'", () => {
    const e = new Error("An unexpected error occurred.");
    e.name = "AuthorizationError";
    expect(actionErrorMessage(e)).toBe("You don't have permission to do that.");
  });

  it("returns a permission-style fallback when the message is empty", () => {
    const e = new Error("");
    e.name = "AuthorizationError";
    expect(actionErrorMessage(e)).toBe("You don't have permission to do that.");
  });

  it("returns the supplied fallback for non-action errors", () => {
    expect(actionErrorMessage(new Error("Network down"), "Try again later."))
      .toBe("Try again later.");
  });

  it("defaults to 'Something went wrong.' when no fallback is supplied", () => {
    expect(actionErrorMessage(new Error("Network down"))).toBe(
      "Something went wrong.",
    );
    expect(actionErrorMessage(null)).toBe("Something went wrong.");
    expect(actionErrorMessage(undefined)).toBe("Something went wrong.");
  });

  it("returns the fallback for non-error objects", () => {
    expect(actionErrorMessage({ foo: "bar" }, "Fallback")).toBe("Fallback");
  });
});
