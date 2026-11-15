import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// G4 — the timesheet action tests: the draft save (owner self-service vs
// HR-on-behalf, the full line replace, the Σ hours materialization, the
// re-save-after-rejection path), the guarded submit flip, the four-eyes
// decision (approve / reject-with-reason), and the reader standings.
// The pure kernel is covered in lib/hr/__tests__/timesheets.test.ts.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["user", "timesheet", "timesheetLine", "auditLog"];
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
const getSessionOrThrowMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  getSessionOrThrow: (...a: unknown[]) => getSessionOrThrowMock(...a),
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
  saveTimesheet,
  submitTimesheet,
  decideTimesheet,
  getMyTimesheets,
  getTimesheetDetail,
  getTimesheetsForReview,
  getEmployeeTimesheets,
} from "../timesheets";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MEMBER_AUTH = { userId: "u-yuki", role: "MEMBER" as const, name: "Yuki Tanaka", email: "yuki@x.co" };

const EMPLOYEE = { id: "u-yuki", name: "Yuki Tanaka", email: "yuki@x.co", deletedAt: null };

function sheetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ts-1",
    employeeId: "u-yuki",
    periodStart: new Date("2026-11-01T00:00:00Z"),
    periodEnd: new Date("2026-11-30T00:00:00Z"),
    status: "DRAFT",
    submittedAt: null,
    approvedById: null,
    approvedAt: null,
    rejectedById: null,
    rejectedAt: null,
    rejectReason: "",
    totalHours: 0,
    payrollRunId: null,
    createdAt: new Date("2026-11-10T00:00:00Z"),
    createdById: "u-yuki",
    employee: { name: "Yuki Tanaka" },
    lines: [],
    ...overrides,
  };
}

const LINES_INPUT = [
  { workDate: "2026-11-10", hours: 8, isBillable: true },
  { workDate: "2026-11-11", hours: 7.5 },
  { workDate: "2026-11-12", hours: 2, isOvertime: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  getSessionOrThrowMock.mockResolvedValue(MEMBER_AUTH);
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockResolvedValue(EMPLOYEE);
  db.timesheet.findUnique.mockResolvedValue(null);
  db.timesheet.findFirst.mockResolvedValue(null);
  db.timesheet.findMany.mockResolvedValue([]);
  db.timesheet.updateMany.mockResolvedValue({ count: 1 });
  db.timesheet.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ts-1", ...data }));
  db.timesheet.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ts-new", ...data }));
  db.timesheetLine.create.mockResolvedValue({ id: "tl-1" });
  db.timesheetLine.deleteMany.mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// saveTimesheet
// ---------------------------------------------------------------------------

describe("saveTimesheet", () => {
  it("creates a DRAFT with the Σ hours materialized and the lines written in one transaction", async () => {
    const res = await saveTimesheet({
      employeeId: "u-yuki",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      lines: LINES_INPUT,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.totalHours).toBe(17.5);
    expect(db.timesheet.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          employeeId: "u-yuki",
          status: "DRAFT",
          totalHours: 17.5,
          createdById: "u-yuki", // the owner self-served
        }),
      }),
    );
    expect(db.timesheetLine.create).toHaveBeenCalledTimes(3);
    expect(db.timesheetLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hours: 2, isOvertime: true, isBillable: false }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.timesheet_created", entityType: "TIMESHEET" }),
    );
  });

  it("the owner self-serves with NO permission; a non-owner needs attendance:manage", async () => {
    // Owner (session === employee): no permission call at all.
    await saveTimesheet({ employeeId: "u-yuki", periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: LINES_INPUT });
    expect(requirePermissionMock).not.toHaveBeenCalled();

    // HR on behalf: the gate fires.
    getSessionOrThrowMock.mockResolvedValue(HR_AUTH);
    await saveTimesheet({ employeeId: "u-yuki", periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: LINES_INPUT });
    expect(requirePermissionMock).toHaveBeenCalledWith("attendance:manage");

    // A different MEMBER on someone else's sheet: denied.
    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const res = await saveTimesheet({ employeeId: "u-yuki", periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: LINES_INPUT });
    expect(res.ok).toBe(false);
  });

  it("re-saving a REJECTED window returns it to DRAFT and clears the rejection", async () => {
    db.timesheet.findFirst.mockResolvedValue(
      sheetRow({ status: "REJECTED", rejectReason: "Missing the 13th", rejectedById: "u-hr" }),
    );
    const res = await saveTimesheet({
      employeeId: "u-yuki",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      lines: LINES_INPUT,
    });
    expect(res.ok).toBe(true);
    expect(db.timesheet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ts-1" },
        data: expect.objectContaining({
          status: "DRAFT",
          totalHours: 17.5,
          rejectReason: "",
          rejectedById: null,
        }),
      }),
    );
    // The full replace: old lines deleted, new lines written.
    expect(db.timesheetLine.deleteMany).toHaveBeenCalledWith({ where: { timesheetId: "ts-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.timesheet_updated" }),
    );
  });

  it("refuses to edit a SUBMITTED sheet (reject it first) and a LOCKED one (payroll consumed it)", async () => {
    db.timesheet.findFirst.mockResolvedValue(sheetRow({ status: "SUBMITTED" }));
    const submitted = await saveTimesheet({ employeeId: "u-yuki", periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: LINES_INPUT });
    expect(submitted.ok).toBe(false);
    if (!submitted.ok) expect(submitted.error).toMatch(/awaiting review/i);

    db.timesheet.findFirst.mockResolvedValue(sheetRow({ status: "LOCKED", payrollRunId: "run-9" }));
    const locked = await saveTimesheet({ employeeId: "u-yuki", periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: LINES_INPUT });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toMatch(/locked/i);
  });

  it("refuses lines outside the window and non-positive hours (the kernel twin)", async () => {
    const outside = await saveTimesheet({
      employeeId: "u-yuki",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      lines: [{ workDate: "2026-12-05", hours: 8 }],
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error).toMatch(/inside the timesheet's period/i);

    const zero = await saveTimesheet({
      employeeId: "u-yuki",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      lines: [{ workDate: "2026-11-10", hours: 0 }],
    });
    expect(zero.ok).toBe(false);
    // Caught either by the zod gate (positive()) or the kernel twin — both
    // refuse the line before any write.
    if (!zero.ok) expect(zero.error).toMatch(/Too small|between 0 and 24/i);
  });

  it("refuses an unknown or soft-deleted employee and an inverted window", async () => {
    db.user.findUnique.mockResolvedValue({ ...EMPLOYEE, deletedAt: new Date() });
    const gone = await saveTimesheet({ employeeId: "u-yuki", periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: LINES_INPUT });
    expect(gone.ok).toBe(false);

    db.user.findUnique.mockResolvedValue(EMPLOYEE);
    const inverted = await saveTimesheet({ employeeId: "u-yuki", periodStart: "2026-11-30", periodEnd: "2026-11-01", lines: LINES_INPUT });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.error).toMatch(/start must not be after/i);
  });
});

// ---------------------------------------------------------------------------
// submitTimesheet
// ---------------------------------------------------------------------------

describe("submitTimesheet", () => {
  it("flips DRAFT → SUBMITTED with the status in the WHERE clause and stamps submittedAt", async () => {
    db.timesheet.findUnique.mockResolvedValue(sheetRow({ totalHours: 17.5 }));
    const res = await submitTimesheet({ timesheetId: "ts-1" });
    expect(res.ok).toBe(true);
    expect(db.timesheet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ts-1", status: "DRAFT" },
        data: expect.objectContaining({ status: "SUBMITTED" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.timesheet_submitted" }),
    );
  });

  it("refuses an empty draft (no hours), a SUBMITTED double-submit and a LOCKED sheet", async () => {
    db.timesheet.findUnique.mockResolvedValue(sheetRow({ totalHours: 0 }));
    const empty = await submitTimesheet({ timesheetId: "ts-1" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/at least one line/i);

    db.timesheet.findUnique.mockResolvedValue(sheetRow({ status: "SUBMITTED", totalHours: 17.5 }));
    const again = await submitTimesheet({ timesheetId: "ts-1" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already awaiting review/i);

    db.timesheet.findUnique.mockResolvedValue(sheetRow({ status: "LOCKED", totalHours: 17.5 }));
    const locked = await submitTimesheet({ timesheetId: "ts-1" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toMatch(/locked/i);
  });

  it("a concurrent flip (0 rows) aborts loudly instead of double-submitting", async () => {
    db.timesheet.findUnique.mockResolvedValue(sheetRow({ totalHours: 17.5 }));
    db.timesheet.updateMany.mockResolvedValue({ count: 0 });
    const res = await submitTimesheet({ timesheetId: "ts-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer in its recorded state/i);
  });
});

// ---------------------------------------------------------------------------
// decideTimesheet (the four-eyes decision)
// ---------------------------------------------------------------------------

describe("decideTimesheet", () => {
  it("approves SUBMITTED → APPROVED with the approver stamped, guarded", async () => {
    db.timesheet.findUnique.mockResolvedValue(sheetRow({ status: "SUBMITTED", totalHours: 17.5 }));
    const res = await decideTimesheet({ timesheetId: "ts-1", decision: "APPROVE" });
    expect(res.ok).toBe(true);
    expect(db.timesheet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ts-1", status: "SUBMITTED" },
        data: expect.objectContaining({ status: "APPROVED", approvedById: "u-hr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.timesheet_approved" }),
    );
  });

  it("four-eyes: the employee cannot review their own hours", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH); // even with the permission, subject != approver
    db.timesheet.findUnique.mockResolvedValue(sheetRow({ status: "SUBMITTED", totalHours: 17.5 }));
    const res = await decideTimesheet({ timesheetId: "ts-1", decision: "APPROVE" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot review your own/i);
    expect(db.timesheet.updateMany).not.toHaveBeenCalled();
  });

  it("rejects with a reason (required) and returns the sheet to its author", async () => {
    db.timesheet.findUnique.mockResolvedValue(sheetRow({ status: "SUBMITTED", totalHours: 17.5 }));
    const noReason = await decideTimesheet({ timesheetId: "ts-1", decision: "REJECT" });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error).toMatch(/needs a reason/i);

    const res = await decideTimesheet({ timesheetId: "ts-1", decision: "REJECT", reason: "Missing the 13th" });
    expect(res.ok).toBe(true);
    expect(db.timesheet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ts-1", status: "SUBMITTED" },
        data: expect.objectContaining({ status: "REJECTED", rejectReason: "Missing the 13th" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.timesheet_rejected" }),
    );
  });

  it("only a SUBMITTED sheet can be decided, and only with attendance:manage", async () => {
    db.timesheet.findUnique.mockResolvedValue(sheetRow({ status: "DRAFT" }));
    const draft = await decideTimesheet({ timesheetId: "ts-1", decision: "APPROVE" });
    expect(draft.ok).toBe(false);

    db.timesheet.findUnique.mockResolvedValue(sheetRow({ status: "SUBMITTED" }));
    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const denied = await decideTimesheet({ timesheetId: "ts-1", decision: "APPROVE" });
    expect(denied.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

describe("the readers", () => {
  it("getMyTimesheets is session-scoped (the signed-in user's own sheets only)", async () => {
    db.timesheet.findMany.mockResolvedValue([
      sheetRow({ totalHours: 17.5, lines: [{ hours: 17.5, isOvertime: false, isBillable: false }] }),
    ]);
    const res = await getMyTimesheets();
    expect(res.ok).toBe(true);
    expect(db.timesheet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: "u-yuki" } }),
    );
    if (res.ok) {
      expect(res.data[0].totalHours).toBe(17.5);
      expect(res.data[0].overtimeHours).toBe(0);
    }
  });

  it("getTimesheetDetail: the owner's standing on their own draft", async () => {
    db.timesheet.findUnique.mockResolvedValue(
      sheetRow({
        totalHours: 17.5,
        lines: [
          { id: "tl-1", workDate: new Date("2026-11-12T00:00:00Z"), hours: 2, projectId: null, taskId: null, description: null, isBillable: true, isOvertime: true },
        ],
      }),
    );
    const res = await getTimesheetDetail({ timesheetId: "ts-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.viewer).toEqual({ isOwner: true, canEdit: true, canSubmit: true, canDecide: false });
    expect(res.data.overtimeHours).toBe(2);
    expect(res.data.lines[0].workDate).toBe("2026-11-12");
  });

  it("getTimesheetDetail: HR on someone else's submitted sheet can decide; a stranger is refused", async () => {
    getSessionOrThrowMock.mockResolvedValue(HR_AUTH);
    db.timesheet.findUnique.mockResolvedValue(sheetRow({ status: "SUBMITTED", totalHours: 17.5 }));
    const hr = await getTimesheetDetail({ timesheetId: "ts-1" });
    expect(hr.ok).toBe(true);
    if (hr.ok) expect(hr.data.viewer.canDecide).toBe(true);

    getSessionOrThrowMock.mockResolvedValue({ ...MEMBER_AUTH, userId: "u-stranger" });
    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const stranger = await getTimesheetDetail({ timesheetId: "ts-1" });
    expect(stranger.ok).toBe(false);
  });

  it("getTimesheetsForReview gates on attendance:manage and passes the status filter through", async () => {
    db.timesheet.findMany.mockResolvedValue([]);
    const res = await getTimesheetsForReview({ status: "SUBMITTED" });
    expect(res.ok).toBe(true);
    expect(requirePermissionMock).toHaveBeenCalledWith("attendance:manage");
    expect(db.timesheet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "SUBMITTED" } }),
    );

    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const denied = await getTimesheetsForReview();
    expect(denied.ok).toBe(false);
  });

  it("getEmployeeTimesheets gates on attendance:manage", async () => {
    db.timesheet.findMany.mockResolvedValue([]);
    const res = await getEmployeeTimesheets("u-yuki");
    expect(res.ok).toBe(true);
    expect(db.timesheet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: "u-yuki" } }),
    );
  });
});
