import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// G4 — the shift + roster action tests: the master CRUD (overnight
// derived, name uniqueness surfaced), the roster writers (assign with the
// no-double-booking guard, status corrections, the swap transaction, the
// drag-drop move), the absence-detection pass and the roster readers.
// The pure clock math is covered in lib/hr/__tests__/shifts.test.ts.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["user", "shift", "shiftAssignment", "attendanceRecord", "auditLog"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
    "groupBy",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[]),
  );
  return obj;
});
vi.mock("@/lib/infra/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) {
      super(m);
      this.name = "AuthorizationError";
    }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createShift,
  updateShift,
  assignShift,
  unassignShift,
  setAssignmentStatus,
  swapShift,
  moveShift,
  markRosterAbsencesForDay,
  getRoster,
  getShifts,
} from "../shifts";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const EMPLOYEE = { id: "u-yuki", name: "Yuki Tanaka", deletedAt: null };
const OTHER_EMPLOYEE = { id: "u-theo", name: "Theo Vance", deletedAt: null };

function shiftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sh-1",
    name: "Day shift",
    startTime: "09:00",
    endTime: "17:00",
    isOvernight: false,
    breakMinutes: 30,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function assignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sa-1",
    employeeId: "u-yuki",
    shiftId: "sh-1",
    rosterDate: new Date("2026-11-16T00:00:00Z"),
    status: "SCHEDULED",
    note: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    employee: { name: "Yuki Tanaka" },
    shift: { name: "Day shift" },
    ...overrides,
  };
}

/** A Prisma P2002-shaped unique-constraint rejection. */
function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockResolvedValue(EMPLOYEE);
  db.shift.findUnique.mockResolvedValue(shiftRow());
  db.shift.findMany.mockResolvedValue([]);
  db.shiftAssignment.findUnique.mockResolvedValue(null);
  db.shiftAssignment.findMany.mockResolvedValue([]);
  db.shiftAssignment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "sa-new",
    employee: { name: "Yuki Tanaka" },
    shift: { name: "Day shift" },
    ...data,
  }));
  db.shiftAssignment.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "sa-1",
    employee: { name: "Yuki Tanaka" },
    shift: { name: "Day shift" },
    ...data,
  }));
  db.shiftAssignment.updateMany.mockResolvedValue({ count: 1 });
  db.shiftAssignment.delete.mockResolvedValue({ id: "sa-1" });
  db.shiftAssignment.groupBy.mockResolvedValue([]);
  db.shift.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sh-new", ...data }));
  db.shift.update.mockResolvedValue(shiftRow());
  db.attendanceRecord.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Shift master
// ---------------------------------------------------------------------------

describe("createShift / updateShift", () => {
  it("creates a shift with isOvernight DERIVED from the clock times", async () => {
    const res = await createShift({ name: "Night owls", startTime: "22:00", endTime: "06:00", breakMinutes: 0 });
    expect(res.ok).toBe(true);
    expect(db.shift.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Night owls", isOvernight: true, breakMinutes: 0 }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.shift_created", entityType: "SHIFT" }),
    );
  });

  it("refuses bad clock times and an over-long break (the kernel twin)", async () => {
    const bad = await createShift({ name: "Broken", startTime: "9am", endTime: "17:00", breakMinutes: 30 });
    expect(bad.ok).toBe(false);

    const longBreak = await createShift({ name: "Broken", startTime: "09:00", endTime: "10:00", breakMinutes: 90 });
    expect(longBreak.ok).toBe(false);
  });

  it("surfaces a duplicate name as the friendly error", async () => {
    db.shift.create.mockRejectedValue(uniqueViolation());
    const res = await createShift({ name: "Day shift", startTime: "09:00", endTime: "17:00", breakMinutes: 30 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already exists/i);
  });

  it("updateShift refuses an unknown shift and audits the change", async () => {
    db.shift.findUnique.mockResolvedValue(null);
    const missing = await updateShift({ shiftId: "sh-x", name: "X", startTime: "09:00", endTime: "17:00", breakMinutes: 30 });
    expect(missing.ok).toBe(false);

    db.shift.findUnique.mockResolvedValue(shiftRow());
    const res = await updateShift({ shiftId: "sh-1", name: "Day shift", startTime: "08:00", endTime: "16:00", breakMinutes: 30 });
    expect(res.ok).toBe(true);
    expect(db.shift.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sh-1" },
        data: expect.objectContaining({ startTime: "08:00", isOvernight: false }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Roster writers
// ---------------------------------------------------------------------------

describe("assignShift (the no-double-booking guard)", () => {
  it("creates the slot and audits it", async () => {
    const res = await assignShift({ employeeId: "u-yuki", shiftId: "sh-1", rosterDate: "2026-11-16" });
    expect(res.ok).toBe(true);
    expect(db.shiftAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          employeeId: "u-yuki",
          shiftId: "sh-1",
          rosterDate: new Date("2026-11-16T00:00:00Z"),
          // status rides the DB default (SCHEDULED)
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.roster_assigned", entityType: "SHIFT_ASSIGNMENT" }),
    );
  });

  it("the unique constraint's collision becomes the friendly one-slot-per-day error", async () => {
    db.shiftAssignment.create.mockRejectedValue(uniqueViolation());
    const res = await assignShift({ employeeId: "u-yuki", shiftId: "sh-1", rosterDate: "2026-11-16" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already rostered on 2026-11-16/i);
  });

  it("refuses an inactive shift and a deleted employee", async () => {
    db.shift.findUnique.mockResolvedValue(shiftRow({ isActive: false }));
    const inactive = await assignShift({ employeeId: "u-yuki", shiftId: "sh-1", rosterDate: "2026-11-16" });
    expect(inactive.ok).toBe(false);

    db.shift.findUnique.mockResolvedValue(shiftRow());
    db.user.findUnique.mockResolvedValue({ ...EMPLOYEE, deletedAt: new Date() });
    const gone = await assignShift({ employeeId: "u-yuki", shiftId: "sh-1", rosterDate: "2026-11-16" });
    expect(gone.ok).toBe(false);
  });
});

describe("setAssignmentStatus / unassignShift", () => {
  it("flips the status with the guard (a same-status flip is refused)", async () => {
    db.shiftAssignment.findUnique.mockResolvedValue(assignmentRow());
    const res = await setAssignmentStatus({ assignmentId: "sa-1", status: "COMPLETED" });
    expect(res.ok).toBe(true);
    expect(db.shiftAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sa-1", status: { not: "COMPLETED" } },
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );

    db.shiftAssignment.updateMany.mockResolvedValue({ count: 0 });
    const same = await setAssignmentStatus({ assignmentId: "sa-1", status: "COMPLETED" });
    expect(same.ok).toBe(false);
  });

  it("unassign removes the slot and audits it", async () => {
    db.shiftAssignment.findUnique.mockResolvedValue(assignmentRow());
    const res = await unassignShift({ assignmentId: "sa-1" });
    expect(res.ok).toBe(true);
    expect(db.shiftAssignment.delete).toHaveBeenCalledWith({ where: { id: "sa-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.roster_unassigned" }),
    );
  });
});

describe("swapShift (one transaction: SWAPPED original + fresh target slot)", () => {
  it("flips the original SWAPPED and creates the target's SCHEDULED slot atomically", async () => {
    db.shiftAssignment.findUnique.mockResolvedValue(assignmentRow());
    db.user.findUnique.mockResolvedValue(OTHER_EMPLOYEE);
    const res = await swapShift({ assignmentId: "sa-1", toEmployeeId: "u-theo" });
    expect(res.ok).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.shiftAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sa-1", status: "SCHEDULED" },
        data: expect.objectContaining({ status: "SWAPPED" }),
      }),
    );
    expect(db.shiftAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          employeeId: "u-theo",
          shiftId: "sh-1",
          status: "SCHEDULED",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.roster_swapped" }),
    );
  });

  it("refuses a self-swap and a target already rostered that day", async () => {
    db.shiftAssignment.findUnique.mockResolvedValue(assignmentRow());
    const self = await swapShift({ assignmentId: "sa-1", toEmployeeId: "u-yuki" });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toMatch(/different employee/i);

    db.user.findUnique.mockResolvedValue(OTHER_EMPLOYEE);
    db.shiftAssignment.create.mockRejectedValue(uniqueViolation());
    const conflict = await swapShift({ assignmentId: "sa-1", toEmployeeId: "u-theo" });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toMatch(/already rostered/i);
  });
});

describe("moveShift (the drag-drop writer)", () => {
  it("re-dates the slot and audits the move", async () => {
    db.shiftAssignment.findUnique.mockResolvedValue(assignmentRow());
    const res = await moveShift({ assignmentId: "sa-1", toRosterDate: "2026-11-18" });
    expect(res.ok).toBe(true);
    expect(db.shiftAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sa-1" },
        data: { rosterDate: new Date("2026-11-18T00:00:00Z") },
      }),
    );
  });

  it("refuses a same-day move and surfaces the target-day collision", async () => {
    db.shiftAssignment.findUnique.mockResolvedValue(assignmentRow());
    const same = await moveShift({ assignmentId: "sa-1", toRosterDate: "2026-11-16" });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toMatch(/already on that day/i);

    db.shiftAssignment.update.mockRejectedValue(uniqueViolation());
    const conflict = await moveShift({ assignmentId: "sa-1", toRosterDate: "2026-11-18" });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toMatch(/already rostered on 2026-11-18/i);
  });
});

// ---------------------------------------------------------------------------
// Absence detection (§4)
// ---------------------------------------------------------------------------

describe("markRosterAbsencesForDay", () => {
  it("flips SCHEDULED-but-unmarked slots ABSENT; marked employees and other statuses stay", async () => {
    db.shiftAssignment.findMany.mockResolvedValue([
      assignmentRow({ id: "sa-1", employeeId: "u-yuki" }),
      assignmentRow({ id: "sa-2", employeeId: "u-theo" }),
      assignmentRow({ id: "sa-3", employeeId: "u-ada", status: "COMPLETED" }),
      assignmentRow({ id: "sa-4", employeeId: "u-rex", status: "SWAPPED" }),
    ]);
    // Theo HAS an attendance mark; Yuki does not.
    db.attendanceRecord.findMany.mockResolvedValue([{ userId: "u-theo" }]);
    const res = await markRosterAbsencesForDay({ date: "2026-11-16" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.marked).toBe(1);
    expect(db.shiftAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sa-1", status: "SCHEDULED" },
        data: expect.objectContaining({ status: "ABSENT" }),
      }),
    );
    // Only Yuki's flip was attempted (one guarded update per candidate).
    expect(db.shiftAssignment.updateMany).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.roster_absences_marked", detail: expect.stringContaining("1 rostered slot(s) flipped ABSENT") }),
    );
  });

  it("a fully-marked day marks nothing", async () => {
    db.shiftAssignment.findMany.mockResolvedValue([assignmentRow({ employeeId: "u-yuki" })]);
    db.attendanceRecord.findMany.mockResolvedValue([{ userId: "u-yuki" }]);
    const res = await markRosterAbsencesForDay({ date: "2026-11-16" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.marked).toBe(0);
    expect(db.shiftAssignment.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

describe("the readers", () => {
  it("getShifts gates on attendance:manage and counts each shift's slots", async () => {
    db.shift.findMany.mockResolvedValue([shiftRow()]);
    db.shiftAssignment.groupBy.mockResolvedValue([{ shiftId: "sh-1", _count: { _all: 3 } }]);
    const res = await getShifts();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0].assignmentCount).toBe(3);
    expect(res.data[0].expectedHours).toBe(7.5);
  });

  it("getRoster groups by day and renders empty days inside the window", async () => {
    db.shiftAssignment.findMany.mockResolvedValue([
      assignmentRow({ rosterDate: new Date("2026-11-17T00:00:00Z") }),
    ]);
    const res = await getRoster({ from: "2026-11-16", to: "2026-11-18" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.days.map((d) => d.day)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(res.data.days[0].assignments).toEqual([]);
    expect(res.data.days[1].assignments[0].employeeName).toBe("Yuki Tanaka");
    expect(res.data.days[1].assignments[0].rosterDate).toBe("2026-11-17");
  });

  it("getRoster refuses an inverted window", async () => {
    const res = await getRoster({ from: "2026-11-18", to: "2026-11-16" });
    expect(res.ok).toBe(false);
  });
});
