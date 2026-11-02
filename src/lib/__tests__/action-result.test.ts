import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isOk,
  isErr,
  type ActionResult,
} from "@/lib/action-result";

describe("ok()", () => {
  it("wraps data in the success shape", () => {
    expect(ok({ id: 7 })).toEqual({ ok: true, data: { id: 7 } });
  });

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

  it("supports every ActionErrorCode value", () => {
    const codes = [
      "AUTH",
      "VALIDATION",
      "NOT_FOUND",
      "CONFLICT",
      "INTERNAL",
    ] as const;
    for (const code of codes) {
      const r = err(code, "detail");
      expect(r).toEqual({ ok: false, code, error: "detail" });
    }
  });
});

describe("isOk / isErr type guards", () => {
  it("narrow the success branch so res.data is accessible", () => {
    const r: ActionResult<number> = ok(42);
    expect(isErr(r)).toBe(false);
    if (!isOk(r)) {
      throw new Error("isOk must narrow ok:true results to the success branch");
    }
    // TypeScript has narrowed `r` to ActionOk<number> here.
    expect(r.data).toBe(42);
  });

  it("narrow the failure branch so code/error are accessible", () => {
    const r: ActionResult<number> = err("NOT_FOUND", "task 42 missing");
    expect(isOk(r)).toBe(false);
    if (!isErr(r)) {
      throw new Error("isErr must narrow ok:false results to the failure branch");
    }
    // TypeScript has narrowed `r` to ActionErr here.
    expect(r.code).toBe("NOT_FOUND");
    expect(r.error).toBe("task 42 missing");
  });

  it("disagree on the same result (exactly one guard matches)", () => {
    const success: ActionResult<string> = ok("hi");
    const failure: ActionResult<string> = err("AUTH", "signed out");
    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isOk(failure)).toBe(false);
    expect(isErr(failure)).toBe(true);
  });
});
