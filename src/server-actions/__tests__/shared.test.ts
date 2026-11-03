import { describe, it, expect, vi, beforeEach } from "vitest";

// PR-56 — the two shared.ts helpers with zero direct coverage:
//   • getClientInfo — x-forwarded-for / user-agent extraction for audit rows
//   • getWorkspaceLimit — admin-editable display limits with a DB-error
//     fallback to the previous hardcoded default

const db = vi.hoisted(() => ({
  workspace: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db }));

const logErrorSpy = vi.fn();
vi.mock("@/lib/observability", async (importOriginal) => {
  // Partial mock: shared.ts (and its transitive imports) use more of the
  // module than logError — keep the real implementations for everything else.
  const actual = await importOriginal<typeof import("@/lib/observability")>();
  return {
    ...actual,
    logError: (...args: unknown[]) => logErrorSpy(...args),
  };
});

const mockHeaderBag = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => mockHeaderBag.current,
}));

import { getClientInfo, getWorkspaceLimit, fmtDay } from "../shared";

describe("getClientInfo (P1 audit context)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaderBag.current = new Headers();
  });

  it("reads the first x-forwarded-for hop and the user agent", async () => {
    mockHeaderBag.current = new Headers({
      "x-forwarded-for": "203.0.113.10, 10.0.0.1, 10.0.0.2",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64)",
    });
    expect(await getClientInfo()).toEqual({
      ip: "203.0.113.10",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    });
  });

  it("falls back to 'unknown' for both fields when headers are absent", async () => {
    expect(await getClientInfo()).toEqual({ ip: "unknown", userAgent: "unknown" });
  });

  it("caps the user agent at 500 chars (audit column bound)", async () => {
    mockHeaderBag.current = new Headers({ "user-agent": "A".repeat(600) });
    const info = await getClientInfo();
    expect(info.userAgent).toHaveLength(500);
  });

  it("returns unknown/unknown when headers() throws (outside a request context)", async () => {
    // PR-22 — headers() throws outside a request context (background jobs,
    // tests); the helper must degrade to unknown, never crash the caller.
    const orig = mockHeaderBag.current;
    // @ts-expect-error — deliberately poison the bag for one call
    mockHeaderBag.current = { get() { throw new Error("no request context"); } };
    try {
      expect(await getClientInfo()).toEqual({ ip: "unknown", userAgent: "unknown" });
      expect(logErrorSpy).toHaveBeenCalledWith(
        "[shared] getClientInfo failed (outside request context?):",
        expect.any(Error),
      );
    } finally {
      mockHeaderBag.current = orig;
    }
  });
});

describe("getWorkspaceLimit (PR-18)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the configured value when set", async () => {
    db.workspace.findFirst.mockResolvedValue({ auditLogLimit: 250 });
    expect(await getWorkspaceLimit("auditLogLimit", 300, 500)).toBe(250);
    expect(db.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: "default" },
      select: { auditLogLimit: true },
    });
  });

  it("returns the fallback when the workspace row is missing", async () => {
    db.workspace.findFirst.mockResolvedValue(null);
    expect(await getWorkspaceLimit("entityHistoryLimit", 50, 500)).toBe(50);
  });

  it("returns the fallback when the configured value is invalid (0 / negative)", async () => {
    db.workspace.findFirst.mockResolvedValue({ dashboardNotifLimit: 0 });
    expect(await getWorkspaceLimit("dashboardNotifLimit", 20, 100)).toBe(20);
    db.workspace.findFirst.mockResolvedValue({ dashboardNotifLimit: -5 });
    expect(await getWorkspaceLimit("dashboardNotifLimit", 20, 100)).toBe(20);
  });

  it("clamps a fat-fingered large value to max", async () => {
    db.workspace.findFirst.mockResolvedValue({ auditLogLimit: 1_000_000 });
    expect(await getWorkspaceLimit("auditLogLimit", 300, 500)).toBe(500);
  });

  it("floors fractional values", async () => {
    db.workspace.findFirst.mockResolvedValue({ auditLogLimit: 99.9 });
    expect(await getWorkspaceLimit("auditLogLimit", 300, 500)).toBe(99);
  });

  it("returns the fallback when the DB query throws (read paths must not 500)", async () => {
    db.workspace.findFirst.mockRejectedValue(new Error("P1001 connection refused"));
    expect(await getWorkspaceLimit("auditLogLimit", 300, 500)).toBe(300);
  });
});

describe("fmtDay", () => {
  it("formats a Date as 'D Mon' (en-GB)", () => {
    expect(fmtDay(new Date(Date.UTC(2026, 9, 5)))).toBe("5 Oct");
  });
});
