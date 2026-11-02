import { describe, it, expect, vi, afterEach } from "vitest";
import { timeAgo } from "@/lib/time";

describe("timeAgo", () => {
  afterEach(() => vi.useRealTimers());

  it("returns 'just now' for timestamps less than a minute old", () => {
    expect(timeAgo(new Date(Date.now() - 5_000).toISOString())).toBe("just now");
    expect(timeAgo(new Date(Date.now() - 59_000).toISOString())).toBe("just now");
  });

  it("returns minutes for up to an hour", () => {
    expect(timeAgo(new Date(Date.now() - 60_000).toISOString())).toBe("1m ago");
    expect(timeAgo(new Date(Date.now() - 3 * 60_000).toISOString())).toBe("3m ago");
    expect(timeAgo(new Date(Date.now() - 59 * 60_000).toISOString())).toBe("59m ago");
  });

  it("returns hours for up to a day", () => {
    expect(timeAgo(new Date(Date.now() - 60 * 60_000).toISOString())).toBe("1h ago");
    expect(timeAgo(new Date(Date.now() - 5 * 60 * 60_000).toISOString())).toBe("5h ago");
  });

  it("returns days for up to a week", () => {
    expect(timeAgo(new Date(Date.now() - 24 * 60 * 60_000).toISOString())).toBe("1d ago");
    expect(timeAgo(new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString())).toBe("6d ago");
  });

  it("falls back to an absolute date beyond a week", () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const result = timeAgo(old);
    // Format: "12 Oct 2026" / "29 Sept 2026" — day, short month, year
    expect(result).toMatch(/^\d{1,2} [A-Z][a-z]{2,4} \d{4}$/);
  });
});
