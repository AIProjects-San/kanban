import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// L-P2-31 (bulk ops) + L-P2-32 (i18n) + L-P2-38 (ICS export) — P2 batch 2.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["task", "calendarEvent"];
  const methods = ["findUnique", "findFirst", "findMany", "create", "update", "updateMany", "delete", "deleteMany", "count"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const getSessionMock = vi.fn();
const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  getSession: () => getSessionMock(),
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
const recalcMemberStatsMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  recalcMemberStats: (...a: unknown[]) => recalcMemberStatsMock(...a),
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
  db.task.update.mockResolvedValue({});
  db.calendarEvent.findMany.mockResolvedValue([]);
  logAuditMock.mockResolvedValue(undefined);
  recalcMemberStatsMock.mockResolvedValue(undefined);
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
    const res = await bulkUpdateTasks(["t-1", "t-2"], { status: "DONE" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ requested: 2, updated: 2, skipped: 0 });
    expect(db.task.update).toHaveBeenCalledTimes(2);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t-1" }, data: { status: "DONE" } }),
    );
  });

  it("skips tasks the caller cannot edit (MEMBER can only bulk-edit their own)", async () => {
    // MEMBER (task:edit:own) — only t-1 is assigned to them.
    db.task.findMany.mockResolvedValue([
      { id: "t-1", assigneeId: "m-mia", assignee: { userId: "u-mia" } },
      { id: "t-2", assigneeId: "m-other", assignee: { userId: "u-other" } },
    ]);
    const res = await bulkUpdateTasks(["t-1", "t-2"], { status: "DONE" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ requested: 2, updated: 1, skipped: 1 });
    expect(db.task.update).toHaveBeenCalledTimes(1);
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t-1" } }),
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
      { id: "t-1", assigneeId: "m-1", assignee: { userId: "u-1" } },
    ]);
    await bulkUpdateTasks(["t-1"], { assigneeId: "m-2" });
    // Both the old assignee (m-1) and the new assignee (m-2) are recalculated.
    expect(recalcMemberStatsMock).toHaveBeenCalledWith("m-1");
    expect(recalcMemberStatsMock).toHaveBeenCalledWith("m-2");
  });

  it("writes a single bulk audit entry", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.task.findMany.mockResolvedValue([
      { id: "t-1", assigneeId: null, assignee: null },
    ]);
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
