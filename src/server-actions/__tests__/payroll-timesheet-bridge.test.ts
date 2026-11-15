import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// G4 — the reviewed payroll hook tests (the three held tests + the task's
// additions A and B):
//
//   • payroll-uses-timesheet-hours — an APPROVED timesheet whose window IS
//     the run's window prices the slip's paid days from its recorded hours
//     (paidDays = totalHours / 8, the LOP derivation replaced — no double
//     charge), the gross formula untouched.
//   • timesheet-locked-when-consumed — the lock transaction flips every
//     sheet the run consumed APPROVED → LOCKED.
//   • one-run-per-timesheet — a consumed sheet can never feed or be
//     stamped by a second run: the consumption read only considers
//     UNCONSUMED sheets, and the guarded payrollRunId flip refuses a
//     mid-flight race by aborting the whole run creation.
//   • addition A — the edit family (save / submit / decide) refuses a
//     consumed sheet with the explicit "active payroll run" refusal.
//   • addition B — deleting the OPEN run releases its consumed sheets in
//     the same transaction, and a fresh run for the period re-consumes
//     them (the full consume → delete → re-consume cycle).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "salaryStructure", "salaryComponent",
    "payrollRun", "payslip", "payAdjustment", "leaveEncashment", "benefitElection",
    "benefitAccrual", "auditLog", "holidayCalendarEntry", "salaryWithholding",
    "attendanceRecord", "leaveRequest", "leaveType", "mailOutbox", "leaveBalance",
    "statutoryRule", "employeeTaxProfile", "taxYear",
    "salaryStructureAssignment",
    "ledgerAccount", "accountingPeriod", "journalEntry", "journalEntryLine",
    "loan", "loanSchedule", "loanRepayment", "loanType",
    // The hook's own surface.
    "timesheet", "timesheetLine",
  ];
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
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
const deliverOutboxMailMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  queueOutboxMail: async (
    tx: { mailOutbox: { create: (a: unknown) => Promise<Record<string, unknown>> } },
    input: { kind: string; toAddress: string; subject: string; text: string; sentById: string },
  ) =>
    tx.mailOutbox.create({
      data: {
        kind: input.kind,
        toAddress: input.toAddress,
        subject: input.subject,
        body: input.text,
        status: "QUEUED",
        sentById: input.sentById,
      },
    }),
  deliverOutboxMail: (...a: unknown[]) => deliverOutboxMailMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const getWorkspaceConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
  bumpConfigCache: vi.fn(),
}));

import { createPayrollRun, lockPayrollRun, deletePayrollRun } from "../payroll";
import { saveTimesheet, submitTimesheet, decideTimesheet } from "../timesheets";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MEMBER_AUTH = { userId: "u-yuki", role: "MEMBER" as const, name: "Yuki Tanaka", email: "yuki@x.co" };

const COMPONENTS = [
  { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78_000 },
  { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 2_400 },
];

const STRUCTURE_ROW = {
  id: "ss-1", userId: "u-yuki", components: JSON.stringify(COMPONENTS), notes: "",
  effectiveFrom: new Date("2026-07-01T00:00:00Z"), isActive: true, createdById: "u-hr",
  createdAt: new Date("2026-07-01T00:00:00Z"),
};

const OPEN_RUN = {
  id: "run-1", period: "2026-11", status: "OPEN", lockedById: "", lockedAt: null,
  createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
};

/** An APPROVED November-2026 timesheet for Yuki (140 h over the month —
 * 17.5 paid days against November's 21 working days). */
function sheetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ts-1",
    employeeId: "u-yuki",
    periodStart: new Date("2026-11-01T00:00:00Z"),
    periodEnd: new Date("2026-11-30T00:00:00Z"),
    status: "APPROVED",
    totalHours: 140,
    payrollRunId: null as string | null,
    createdAt: new Date("2026-11-25T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  getSessionOrThrowMock.mockResolvedValue(MEMBER_AUTH);
  db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
  db.salaryStructureAssignment.findMany.mockResolvedValue([]);
  // F1.4/S5 — the LOP derivation reads employment windows from the profiles
  // (no hireDate/exit = unbounded window = full-period paid days).
  db.employeeProfile.findMany.mockResolvedValue([{ userId: "u-yuki" }, { userId: "u-hana" }]);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.leaveType.findMany.mockResolvedValue([]);
  db.payrollRun.findUnique.mockResolvedValue(null);
  db.payrollRun.findMany.mockResolvedValue([]);
  db.payrollRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "run-new", createdAt: new Date(), lockedById: "", lockedAt: null, ...data,
    payslips: (((data.payslips as { create?: unknown[] } | undefined)?.create) ?? []).map((_: unknown, i: number) => ({ id: `ps-${i}` })),
  }));
  db.payrollRun.update.mockResolvedValue({});
  db.payrollRun.delete.mockResolvedValue({ id: "run-new" });
  db.payslip.findMany.mockResolvedValue([]);
  db.payslip.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ps-new", ...data }));
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.leaveEncashment.updateMany.mockResolvedValue({ count: 0 });
  db.benefitElection.findMany.mockResolvedValue([]);
  db.benefitAccrual.create.mockResolvedValue({});
  db.salaryWithholding.findMany.mockResolvedValue([]);
  db.statutoryRule.findMany.mockResolvedValue([]);
  db.employeeTaxProfile.findMany.mockResolvedValue([]);
  db.taxYear.findMany.mockResolvedValue([]);
  db.ledgerAccount.findUnique.mockImplementation(async ({ where }: { where: { code: string } }) =>
    where.code === "MISSING" ? null : { id: `acc-${where.code}`, code: where.code, name: `Chart ${where.code}`, type: "LIABILITY", isActive: true, isSystem: true },
  );
  db.journalEntry.findFirst.mockResolvedValue(null);
  db.journalEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "je-new", ...data }));
  db.loanSchedule.findMany.mockResolvedValue([]);
  db.loan.findMany.mockResolvedValue([]);
  db.loanSchedule.updateMany.mockResolvedValue({ count: 0 });
  db.loan.updateMany.mockResolvedValue({ count: 0 });
  db.loanRepayment.create.mockResolvedValue({ id: "lr-new" });
  // G4 — the hook's defaults: no sheets to consume; a successful guarded
  // flip whenever one is seeded.
  db.timesheet.findMany.mockResolvedValue([]);
  db.timesheet.findFirst.mockResolvedValue(null);
  db.timesheet.findUnique.mockResolvedValue(null);
  db.timesheet.updateMany.mockResolvedValue({ count: 1 });
  db.timesheet.update.mockResolvedValue({});
  getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED" } });
});

// ---------------------------------------------------------------------------
// The read the hook makes (shared assertion helper).
// ---------------------------------------------------------------------------

function consumptionReadWhere() {
  const call = db.timesheet.findMany.mock.calls.find(
    (c) => (c[0] as { where?: { status?: string; payrollRunId?: unknown } }).where?.status === "APPROVED",
  );
  return call ? (call[0] as { where: Record<string, unknown> }).where : null;
}

describe("G4 — the reviewed payroll hook (timesheet → paid days)", () => {
  it("payroll-uses-timesheet-hours — an approved sheet for the exact window prices paidDays = hours / 8 and REPLACES the LOP derivation (no double charge), the gross formula untouched", async () => {
    db.timesheet.findMany.mockResolvedValue([sheetRow()]);
    // The same absence facts that would derive 2 LOP days without a sheet —
    // the recorded hours already net them out, so the slip must NOT also
    // carry an LOP line (the F1.4 no-double-charge rule, window-level).
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-11-02T00:00:00Z"), status: "ABSENT" },
      { userId: "u-yuki", date: new Date("2026-11-03T00:00:00Z"), status: "ABSENT" },
    ]);

    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);

    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ paidDays: number; lopDays: number; lopSource: string; earnings: string; deductions: string; gross: number; net: number }> } };
    };
    const slip = createArg.data.payslips.create[0];
    // 140 h ÷ 8 = 17.5 paid days against November 2026's 21 working days.
    expect(slip.paidDays).toBe(17.5);
    expect(slip.lopDays).toBe(0);
    expect(slip.lopSource).toBe("AUTO");
    // The gross formula is untouched: per-line paidDays / workingDays —
    // 6,500 × 17.5/21 = 5,416.67 and 200 × 17.5/21 = 166.67.
    const earnings = JSON.parse(slip.earnings) as Array<{ key: string; amount: number }>;
    expect(earnings).toEqual([
      { key: "basic", label: "Basic Salary", amount: 5_416.67 },
      { key: "transport", label: "Transport Allowance", amount: 166.67 },
    ]);
    // No LOP line rides the hours-priced slip.
    const deductions = JSON.parse(slip.deductions) as Array<{ key: string }>;
    expect(deductions.find((l) => l.key === "lop")).toBeUndefined();
    expect(slip.gross).toBe(5_583.34);
    expect(slip.net).toBe(5_583.34);
    // The run audit names the consumption.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_created",
      detail: expect.stringContaining("1 approved timesheet(s) consumed"),
    }));
  });

  it("payroll-uses-timesheet-hours — the consumption is transactional: the guarded payrollRunId flip stamps the run inside the creation transaction", async () => {
    db.timesheet.findMany.mockResolvedValue([sheetRow()]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    expect(db.timesheet.updateMany).toHaveBeenCalledWith({
      where: { id: "ts-1", payrollRunId: null },
      data: { payrollRunId: "run-new" },
    });
  });

  it("only an APPROVED, unconsumed, EXACT-window sheet is consumed — a DRAFT or a weekly sheet inside the month prices nothing", async () => {
    const sheets = [
      sheetRow({ id: "ts-draft", status: "DRAFT", totalHours: 80 }),
      sheetRow({ id: "ts-weekly", periodStart: new Date("2026-11-02T00:00:00Z"), periodEnd: new Date("2026-11-08T00:00:00Z"), totalHours: 40 }),
    ];
    // The mock db honors the where (status APPROVED + unconsumed) — the
    // DRAFT row is never even returned; the weekly row IS returned and the
    // action's own window bound declines it.
    db.timesheet.findMany.mockImplementation(async ({ where }: { where: { status?: string; payrollRunId?: unknown } }) =>
      sheets.filter((s) =>
        (where.status == null || s.status === where.status)
        && (where.payrollRunId === undefined || s.payrollRunId === where.payrollRunId),
      ),
    );
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    // Nothing consumed, nothing stamped.
    expect(db.timesheet.updateMany).not.toHaveBeenCalled();
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ paidDays: number; lopDays: number }> } };
    };
    // The standard working-day derivation priced the slip (full period, no LOP).
    expect(createArg.data.payslips.create[0].paidDays).toBe(21);
    expect(createArg.data.payslips.create[0].lopDays).toBe(0);
    // The read's window filter (day-granularity bounds) — a coarser sheet's
    // totalHours price the SHEET's window, never the run's. The weekly row
    // WAS returned by the (where-honoring) read; the exact-window bound is
    // the action's own refusal.
    const where = consumptionReadWhere();
    expect(where).toEqual({ status: "APPROVED", payrollRunId: null, employeeId: { in: ["u-yuki"] } });
  });

  it("one-run-per-timesheet — the consumption read only ever considers UNCONSUMED sheets, so a run can never re-consume another run's sheet", async () => {
    // A consumed sheet (run-1 stamped it) plus a fresh APPROVED sheet for a
    // second employee. The read's payrollRunId: null filter is what keeps
    // run-2's pricing honest — the mock db HONORS the filter, so dropping
    // it from the action would surface here as a re-consumption.
    const sheets = [
      sheetRow({ id: "ts-consumed", payrollRunId: "run-1" }),
      sheetRow({ id: "ts-hana", employeeId: "u-hana", totalHours: 160 }),
    ];
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW, { ...STRUCTURE_ROW, id: "ss-2", userId: "u-hana" }]);
    db.timesheet.findMany.mockImplementation(async ({ where }: { where: { status?: string; payrollRunId?: unknown; employeeId?: { in?: string[] } } }) =>
      sheets.filter((s) =>
        (where.status == null || s.status === where.status)
        && (where.payrollRunId === undefined || s.payrollRunId === where.payrollRunId)
        && (where.employeeId?.in == null || where.employeeId.in.includes(s.employeeId)),
      ),
    );
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    expect(consumptionReadWhere()).toMatchObject({ status: "APPROVED", payrollRunId: null });
    // Only the unconsumed sheet is stamped...
    const stamped = db.timesheet.updateMany.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(stamped).toEqual(["ts-hana"]);
    // ...and the run audit counts exactly the one consumption.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_created",
      detail: expect.stringContaining("1 approved timesheet(s) consumed"),
    }));
  });

  it("one-run-per-timesheet — a mid-flight consumption race (the guarded flip matches zero rows) refuses the WHOLE run creation", async () => {
    db.timesheet.findMany.mockResolvedValue([sheetRow()]);
    db.timesheet.updateMany.mockResolvedValue({ count: 0 });
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/consumed by another payroll run/i);
    // The audit never describes money that rolled back.
    expect(logAuditMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.run_created" }));
  });

  it("timesheet-locked-when-consumed — the lock transaction flips every consumed sheet APPROVED → LOCKED and the audit counts them", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, payslips: [{ net: 5_583.34 }] });
    db.timesheet.updateMany.mockResolvedValue({ count: 1 });
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(db.timesheet.updateMany).toHaveBeenCalledWith({
      where: { payrollRunId: "run-1", status: "APPROVED" },
      data: { status: "LOCKED" },
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_locked",
      detail: expect.stringContaining("1 timesheet(s) locked with the run"),
    }));
  });

  it("timesheet-locked-when-consumed — the flip is guarded on the consumption stamp: a sheet from another run (or already LOCKED) never moves", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, payslips: [{ net: 1 }] });
    await lockPayrollRun({ runId: "run-1" });
    const where = (db.timesheet.updateMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ payrollRunId: "run-1", status: "APPROVED" });
  });
});

describe("G4 — addition A (the edit guard after consumption)", () => {
  it("saveTimesheet refuses a consumed sheet with the explicit active-run refusal", async () => {
    db.timesheet.findFirst.mockResolvedValue(sheetRow({ payrollRunId: "run-1" }));
    db.user.findUnique.mockResolvedValue({ id: "u-yuki", name: "Yuki Tanaka", deletedAt: null });
    const res = await saveTimesheet({
      employeeId: "u-yuki",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      lines: [{ workDate: "2026-11-02", hours: 8 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Timesheet is consumed by an active payroll run — cannot edit");
    expect(db.timesheet.update).not.toHaveBeenCalled();
    expect(db.timesheet.create).not.toHaveBeenCalled();
  });

  it("submitTimesheet refuses a consumed sheet (after the standing check)", async () => {
    db.timesheet.findUnique.mockResolvedValue({
      ...sheetRow({ payrollRunId: "run-1", status: "APPROVED" }),
      employee: { name: "Yuki Tanaka" },
    });
    const res = await submitTimesheet({ timesheetId: "ts-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Timesheet is consumed by an active payroll run — cannot edit");
    expect(db.timesheet.updateMany).not.toHaveBeenCalled();
  });

  it("decideTimesheet refuses a consumed sheet on both sides of the review", async () => {
    db.timesheet.findUnique.mockResolvedValue({
      ...sheetRow({ payrollRunId: "run-1", status: "APPROVED" }),
      employee: { name: "Yuki Tanaka" },
    });
    const approved = await decideTimesheet({ timesheetId: "ts-1", decision: "APPROVE" });
    expect(approved.ok).toBe(false);
    if (!approved.ok) expect(approved.error).toBe("Timesheet is consumed by an active payroll run — cannot edit");

    db.timesheet.findUnique.mockResolvedValue({
      ...sheetRow({ payrollRunId: "run-1", status: "APPROVED" }),
      employee: { name: "Yuki Tanaka" },
    });
    const rejected = await decideTimesheet({ timesheetId: "ts-1", decision: "REJECT", reason: "payroll owns it now" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toBe("Timesheet is consumed by an active payroll run — cannot edit");
    expect(db.timesheet.updateMany).not.toHaveBeenCalled();
  });
});

describe("G4 — addition B (the release on run cancellation/deletion)", () => {
  it("deletePayrollRun releases the run's consumed APPROVED sheets inside the deletion transaction and audits it", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN });
    db.timesheet.updateMany.mockResolvedValue({ count: 2 });
    const res = await deletePayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.releasedTimesheets).toBe(2);
    // The user-specified release, verbatim semantics: only still-APPROVED
    // sheets of THIS run, payrollRunId cleared.
    expect(db.timesheet.updateMany).toHaveBeenCalledWith({
      where: { payrollRunId: "run-1", status: "APPROVED" },
      data: { payrollRunId: null },
    });
    expect(db.payrollRun.delete).toHaveBeenCalledWith({ where: { id: "run-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_deleted",
      detail: expect.stringContaining("released 2 consumed timesheet(s)"),
    }));
  });

  it("the full cycle: consume → delete → the fresh run re-consumes the released sheet", async () => {
    // Run #1 consumes the sheet.
    db.timesheet.findMany.mockResolvedValue([sheetRow()]);
    const first = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(first.ok).toBe(true);
    expect(db.timesheet.updateMany).toHaveBeenCalledWith({
      where: { id: "ts-1", payrollRunId: null },
      data: { payrollRunId: "run-new" },
    });
    const consumedCalls = db.timesheet.updateMany.mock.calls.length;
    expect(consumedCalls).toBe(1);

    // The deletion (the period lookup must keep returning null so the fresh
    // run passes the duplicate guard; only the id lookup finds the run).
    db.payrollRun.findUnique.mockImplementation(async ({ where }: { where: { id?: string; period?: string } }) =>
      where.id === "run-new" ? { ...OPEN_RUN, id: "run-new" } : null,
    );
    db.timesheet.updateMany.mockResolvedValueOnce({ count: 1 }); // the release
    const deleted = await deletePayrollRun({ runId: "run-new" });
    expect(deleted.ok).toBe(true);
    expect(db.timesheet.updateMany).toHaveBeenLastCalledWith({
      where: { payrollRunId: "run-new", status: "APPROVED" },
      data: { payrollRunId: null },
    });

    // Run #2 for the same period re-consumes the released sheet.
    db.payrollRun.create.mockClear();
    db.timesheet.updateMany.mockClear();
    db.timesheet.updateMany.mockResolvedValue({ count: 1 });
    const second = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(second.ok).toBe(true);
    expect(db.timesheet.updateMany).toHaveBeenCalledWith({
      where: { id: "ts-1", payrollRunId: null },
      data: { payrollRunId: "run-new" },
    });
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ paidDays: number }> } };
    };
    expect(createArg.data.payslips.create[0].paidDays).toBe(17.5);
  });

  it("refuses a LOCKED run (history), an unknown run, and a run with consumed pay adjustments", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, status: "LOCKED" });
    const locked = await deletePayrollRun({ runId: "run-1" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toMatch(/payroll history/i);

    db.payrollRun.findUnique.mockResolvedValue(null);
    const missing = await deletePayrollRun({ runId: "run-404" });
    expect(missing.ok).toBe(false);

    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN });
    db.payAdjustment.findMany.mockResolvedValue([{ id: "adj-1" }, { id: "adj-2" }]);
    const adjusted = await deletePayrollRun({ runId: "run-1" });
    expect(adjusted.ok).toBe(false);
    if (!adjusted.ok) expect(adjusted.error).toMatch(/2 pay adjustment\(s\)/);
    expect(db.payrollRun.delete).not.toHaveBeenCalled();
    expect(db.timesheet.updateMany).not.toHaveBeenCalled();
  });
});
