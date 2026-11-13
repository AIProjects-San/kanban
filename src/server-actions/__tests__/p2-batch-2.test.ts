import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// L-P2-31 (bulk ops) + L-P2-32 (i18n) + L-P2-38 (ICS export) — P2 batch 2.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  // "teamMember", "project", "projectAssignment" are needed by the
  // project-association rule in bulkUpdateTasks (new-assignee resolution).
  const models = ["task", "calendarEvent", "teamMember", "project", "projectAssignment"];
  const methods = ["findUnique", "findFirst", "findMany", "create", "update", "updateMany", "delete", "deleteMany", "count"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

// $transaction mock — takes an array of PrismaPromises, awaits them all,
// returns their results in order (matches Prisma's batch-transaction API).
db.$transaction = vi.fn((arr: unknown[]) => Promise.all(arr as Promise<unknown>[])) as never;

const getSessionMock = vi.fn();
const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => {
  class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  }
  return {
    getSession: () => getSessionMock(),
    getSessionOrThrow: async () => {
      const a = await getSessionMock();
      if (!a) throw new AuthorizationError("You must be signed in.");
      return a;
    },
  
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError,
  };
});

const logAuditMock = vi.fn();
const recalcMemberStatsMock = vi.fn();
const getProjectAssociatedUserIdsMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  recalcMemberStats: (...a: unknown[]) => recalcMemberStatsMock(...a),
  getProjectAssociatedUserIds: (...a: unknown[]) => getProjectAssociatedUserIdsMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { bulkUpdateTasks } from "../bulk";
import { exportCalendarIcs } from "../ics-export";
import { t } from "@/lib/i18n";

const MEMBER_AUTH = { userId: "u-mia", role: "MEMBER" as const, name: "Mia", email: "mia@x.co" };
const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Admin", email: "a@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(MEMBER_AUTH);
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  db.task.findMany.mockResolvedValue([]);
  // updateMany returns a BatchPayload `{ count }` — the test fixtures
  // override this per-test to return the count of permitted tasks.
  db.task.updateMany.mockResolvedValue({ count: 0 });
  db.calendarEvent.findMany.mockResolvedValue([]);
  logAuditMock.mockResolvedValue(undefined);
  recalcMemberStatsMock.mockResolvedValue(undefined);
  // Project association rule — by default the new assignee's user is
  // associated with every task's project. Individual tests override.
  db.teamMember.findUnique.mockResolvedValue({ userId: "u-2", deletedAt: null });
  getProjectAssociatedUserIdsMock.mockResolvedValue(new Set(["u-1", "u-2"]));
});

// ---------------------------------------------------------------------------
// L-P2-31 — bulkUpdateTasks
// ---------------------------------------------------------------------------

describe("L-P2-31 bulkUpdateTasks", () => {
  it("updates every permitted task and reports the counts", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.task.findMany.mockResolvedValue([
      { id: "t-1", assigneeId: "m-1", assignee: { userId: "u-1" } },
      { id: "t-2", assigneeId: null, assignee: null },
    ]);
    // updateMany returns a BatchPayload — count = number of rows touched.
    db.task.updateMany.mockResolvedValue({ count: 2 });
    const res = await bulkUpdateTasks(["t-1", "t-2"], { status: "DONE" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ requested: 2, updated: 2, skipped: 0 });
    // One atomic updateMany call covering both permitted tasks.
    expect(db.task.updateMany).toHaveBeenCalledTimes(1);
    expect(db.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["t-1", "t-2"] } },
        data: { status: "DONE" },
      }),
    );
  });

  it("skips tasks the caller cannot edit (MEMBER can only bulk-edit their own)", async () => {
    // MEMBER (task:edit:own) — only t-1 is assigned to them.
    db.task.findMany.mockResolvedValue([
      { id: "t-1", assigneeId: "m-mia", assignee: { userId: "u-mia" } },
      { id: "t-2", assigneeId: "m-other", assignee: { userId: "u-other" } },
    ]);
    db.task.updateMany.mockResolvedValue({ count: 1 });
    const res = await bulkUpdateTasks(["t-1", "t-2"], { status: "DONE" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ requested: 2, updated: 1, skipped: 1 });
    // Single atomic updateMany covering only the permitted task.
    expect(db.task.updateMany).toHaveBeenCalledTimes(1);
    expect(db.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["t-1"] } } }),
    );
  });

  it("excludes tasks in soft-deleted projects (L-P0-14)", async () => {
    await bulkUpdateTasks(["t-1"], { status: "DONE" });
    expect(db.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["t-1"] },
          project: { deletedAt: null },
        }),
      }),
    );
  });

  it("recalculates workload for every affected assignee", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.task.findMany.mockResolvedValue([
      { id: "t-1", projectId: "p-1", assigneeId: "m-1", assignee: { userId: "u-1" } },
    ]);
    db.task.updateMany.mockResolvedValue({ count: 1 });
    await bulkUpdateTasks(["t-1"], { assigneeId: "m-2" });
    // Both the old assignee (m-1) and the new assignee (m-2) are recalculated.
    expect(recalcMemberStatsMock).toHaveBeenCalledWith("m-1");
    expect(recalcMemberStatsMock).toHaveBeenCalledWith("m-2");
  });

  it("skips tasks whose project the new assignee is NOT associated with (project association rule)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.task.findMany.mockResolvedValue([
      { id: "t-1", projectId: "p-1", assigneeId: null, assignee: null },
      { id: "t-2", projectId: "p-2", assigneeId: null, assignee: null },
    ]);
    // u-2 is staffed on p-1 only — the task in p-2 must be skipped.
    getProjectAssociatedUserIdsMock.mockImplementation((projectId: string) =>
      Promise.resolve(projectId === "p-1" ? new Set(["u-2"]) : new Set(["u-9"])),
    );
    db.task.updateMany.mockResolvedValue({ count: 1 });
    const res = await bulkUpdateTasks(["t-1", "t-2"], { assigneeId: "m-2" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ requested: 2, updated: 1, skipped: 1 });
    // Only the conforming task is in the atomic update.
    expect(db.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["t-1"] } } }),
    );
  });

  it("skips tasks without a project when bulk-assigning (legacy rows)", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.task.findMany.mockResolvedValue([
      { id: "t-1", projectId: null, assigneeId: null, assignee: null },
    ]);
    db.task.updateMany.mockResolvedValue({ count: 0 });
    const res = await bulkUpdateTasks(["t-1"], { assigneeId: "m-2" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ requested: 1, updated: 0, skipped: 1 });
    expect(db.task.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a bulk assignee with no linked user account", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.task.findMany.mockResolvedValue([
      { id: "t-1", projectId: "p-1", assigneeId: null, assignee: null },
    ]);
    db.teamMember.findUnique.mockResolvedValue({ userId: null, deletedAt: null });
    const res = await bulkUpdateTasks(["t-1"], { assigneeId: "m-ghost" });
    expect(res.ok).toBe(false);
    expect(db.task.updateMany).not.toHaveBeenCalled();
  });

  it("writes a single bulk audit entry", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.task.findMany.mockResolvedValue([
      { id: "t-1", assigneeId: null, assignee: null },
    ]);
    db.task.updateMany.mockResolvedValue({ count: 1 });
    await bulkUpdateTasks(["t-1"], { status: "DONE" });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.updated",
        detail: expect.stringMatching(/Bulk update: 1 task/),
      }),
    );
  });

  it("rejects an empty selection", async () => {
    const res = await bulkUpdateTasks([], { status: "DONE" });
    expect(res.ok).toBe(false);
  });

  it("rejects a patch with no fields", async () => {
    const res = await bulkUpdateTasks(["t-1"], {});
    expect(res.ok).toBe(false);
  });

  it("rejects selections over the 100-task cap", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `t-${i}`);
    const res = await bulkUpdateTasks(ids, { status: "DONE" });
    expect(res.ok).toBe(false);
  });

  it("requires task:edit:own", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await bulkUpdateTasks(["t-1"], { status: "DONE" });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L-P2-38 — exportCalendarIcs
// ---------------------------------------------------------------------------

describe("L-P2-38 exportCalendarIcs", () => {
  it("renders a valid VCALENDAR with one VEVENT per calendar event", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      {
        id: "evt-1",
        title: "Sprint planning",
        description: "Weekly sync; notes inside",
        location: "Room 4",
        type: "MEETING",
        date: new Date(Date.UTC(2026, 9, 30, 0, 0, 0)),
        time: "09:30",
        durationMin: 60,
        createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0, 0)),
      },
    ]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.eventCount).toBe(1);
    const ics = res.data.ics;
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//Fernly//Calendar//EN");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:evt-1@fernly.app");
    expect(ics).toContain("DTSTART:20261030T093000Z");
    expect(ics).toContain("DTEND:20261030T103000Z");
    expect(ics).toContain("SUMMARY:Sprint planning");
    expect(ics).toContain("DESCRIPTION:Weekly sync\\; notes inside");
    expect(ics).toContain("LOCATION:Room 4");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
    // CRLF line endings per RFC 5545
    expect(ics).toContain("\r\n");
  });

  it("escapes special characters in text values", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      {
        id: "evt-2",
        title: "Commas, semicolons; and backslashes \\",
        description: "",
        location: "",
        type: "FOCUS",
        date: new Date(Date.UTC(2026, 9, 30)),
        time: "10:00",
        durationMin: 30,
        createdAt: new Date(Date.UTC(2026, 9, 1)),
      },
    ]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.ics).toContain("SUMMARY:Commas\\, semicolons\\; and backslashes \\\\");
  });

  it("PR-56: folds lines longer than 75 octets with a leading space (RFC 5545 §3.1)", async () => {
    // A summary long enough that "SUMMARY:<title>" exceeds the 74-char
    // single-line budget — csFoldLine must split it into CRLF-joined
    // continuations, each continuation starting with a single space.
    const longTitle = "A very long sprint planning session to review the quarterly roadmap and every workstream in flight".slice(0, 90);
    db.calendarEvent.findMany.mockResolvedValue([
      {
        id: "evt-fold",
        title: longTitle,
        description: "",
        location: "",
        type: "MEETING",
        date: new Date(Date.UTC(2026, 9, 30)),
        time: "09:00",
        durationMin: 30,
        createdAt: new Date(Date.UTC(2026, 9, 1)),
      },
    ]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    const lines = res.data.ics.split("\r\n");
    // Find the SUMMARY start + its continuation lines (leading space).
    const summaryIdx = lines.findIndex((l) => l.startsWith("SUMMARY:"));
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    const first = lines[summaryIdx];
    const second = lines[summaryIdx + 1];
    // First segment is exactly 74 chars; the continuation starts with " ".
    expect(first.length).toBe(74);
    expect(second.startsWith(" ")).toBe(true);
    // Reassembling (strip continuation spaces) recovers the full title.
    const reassembled = (first + second).replace(/^SUMMARY:/, "").replace(/^ |^ /g, (m) => (m === " " ? "" : m));
    expect(reassembled.startsWith("A very long sprint planning session")).toBe(true);
    // No physical line exceeds the 75-octet limit anywhere in the document.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(75);
  });

  it("PR-56: tolerates a malformed HH:MM time by defaulting to 09:00", async () => {
    db.calendarEvent.findMany.mockResolvedValue([
      {
        id: "evt-badtime",
        title: "Bad time event",
        description: "",
        location: "",
        type: "FOCUS",
        date: new Date(Date.UTC(2026, 9, 30)),
        time: "not-a-time",
        durationMin: 60,
        createdAt: new Date(Date.UTC(2026, 9, 1)),
      },
    ]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    // isNaN(hh) → 9, isNaN(mm) → 0 → 09:00.
    expect(res.data.ics).toContain("DTSTART:20261030T090000Z");
    expect(res.data.ics).toContain("DTEND:20261030T100000Z");
  });

  it("returns an empty (but valid) calendar when there are no events", async () => {
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.eventCount).toBe(0);
    expect(res.data.ics).toContain("BEGIN:VCALENDAR");
    expect(res.data.ics).not.toContain("BEGIN:VEVENT");
  });

  it("requires a signed-in session", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await exportCalendarIcs();
    expect(res.ok).toBe(false);
  });

  it("PR-05: caps the export at 1000 events and flags it as truncated", async () => {
    // 1000 rows back from the DB (the cap itself) → truncated: true.
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: `evt-${i}`,
      title: `Event ${i}`,
      description: "",
      location: "",
      type: "FOCUS",
      date: new Date(Date.UTC(2026, 9, 30)),
      time: "09:00",
      durationMin: 30,
      createdAt: new Date(Date.UTC(2026, 9, 1)),
    }));
    db.calendarEvent.findMany.mockResolvedValue(rows);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.eventCount).toBe(1000);
    expect(res.data.truncated).toBe(true);
    // The query itself carries the take cap.
    expect(db.calendarEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1000 }),
    );
  });

  it("PR-05: a partial export reports truncated: false", async () => {
    db.calendarEvent.findMany.mockResolvedValue([]);
    const res = await exportCalendarIcs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L-P2-32 — i18n scaffolding
// ---------------------------------------------------------------------------

describe("L-P2-32 t() indirection", () => {
  it("returns the English string for a known key", () => {
    expect(t("auth.signIn")).toBe("Sign in");
    expect(t("errors.notFound")).toBe("Page not found");
  });

  it("interpolates {params} into the translation", () => {
    expect(t("errors.required", { field: "Email" })).toBe("Email is required.");
  });

  it("falls back to the key itself for an unknown key at runtime (visible bug, not silent)", () => {
    // The typed dictionary makes this a compile error in practice; the
    // runtime fallback keeps a bug visible instead of rendering "".
    expect(t("nope.doesNotExist" as never)).toBe("nope.doesNotExist");
  });

  it("the boundary files use t() for their strings (extraction started)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const f of ["error.tsx", "not-found.tsx", "loading.tsx", "global-error.tsx"]) {
      const src = readFileSync(resolve(__dirname, "../../app", f), "utf-8");
      expect(src).toMatch(/t\("errors\.|t\("loading\./);
    }
  });
});
