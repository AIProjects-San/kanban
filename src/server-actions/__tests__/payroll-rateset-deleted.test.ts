import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Pre-check A (R-P0 batch) — the GREEN sub-path pin: a rate set deleted while
// a PayrollRun is OPEN. `updatePayslip` keeps the slip's STORED statutory
// lines + snapshot (documented cache use — payroll.ts:1336-1343): the slip
// was priced with those values, recomputation is impossible once the set is
// gone, and dropping the lines would silently under-deduct. This test pins
// that behavior so the R-P0-7 guard work cannot regress it.
//
// The FAILING sub-paths found by the same pre-check (addPayslip creating a
// zero-statutory joiner slip with plain success; lockPayrollRun freezing it)
// are specced as R-P0-7 in docs/REVIEW_TRIAGE.md §7 — their regression tests
// land with that implementation, not here (they would pin the bug).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "salaryStructure", "salaryComponent",
    "payrollRun", "payslip", "payAdjustment", "auditLog", "holidayCalendarEntry",
    "attendanceRecord", "leaveRequest", "leaveType", "salaryWithholding",
    "fullAndFinalStatement", "mailOutbox", "leaveBalance",
    "statutoryRule", "employeeTaxProfile", "taxYear",
    "salaryStructureAssignment", "ledgerAccount", "accountingPeriod",
    "journalEntry", "journalEntryLine", "timesheet",
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
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  queueOutboxMail: vi.fn(),
  deliverOutboxMail: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const getWorkspaceConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
  bumpConfigCache: vi.fn(),
}));

import { updatePayslip } from "../payroll";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const STORED_STATUTORY = [
  { key: "paye", label: "PAYE income tax (M)", amount: 1301.71 },
  { key: "acc", label: "ACC earners' levy", amount: 113.75 },
  { key: "ks", label: "KiwiSaver employee 3.5%", amount: 227.5 },
];

const OPEN_RUN = {
  id: "run-engine",
  period: "2026-11",
  status: "OPEN",
  workingDays: 21,
  frequency: "MONTHLY",
  startDate: new Date("2026-11-01T00:00:00Z"),
  endDate: new Date("2026-11-30T00:00:00Z"),
  rateSetId: "rs-fy2026",
};

const SLIP = {
  id: "ps-1",
  runId: "run-engine",
  userId: "u-yuki",
  slipNo: "PS-2026-11-001",
  earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 6500 }]),
  deductions: JSON.stringify(STORED_STATUTORY),
  note: "",
  lopDays: 0,
  lopSource: "AUTO",
  lopDetail: null,
  version: 3,
  paidDays: null,
  gross: 6500,
  net: 4857.04,
  withholdStatus: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.timesheet.findMany.mockResolvedValue([]);
  db.timesheet.updateMany.mockResolvedValue({ count: 1 });
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  getWorkspaceConfigMock.mockResolvedValue({
    workspace: {
      unmarkedAttendanceMode: "IGNORED",
      lopBasisMode: "HYBRID",
      payrollRoundingMode: "ROUND_2DP",
      overtimePayEnabled: false,
      fiscalYearStartMonth: 1,
      showLeaveBalancesOnSlip: false,
      emailPayslipsOnLock: false,
    },
  });
  db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka" }]);
  db.employeeProfile.findMany.mockResolvedValue([]);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.leaveType.findMany.mockResolvedValue([]);
  db.salaryComponent.findMany.mockResolvedValue([]);
  db.employeeTaxProfile.findUnique.mockResolvedValue(null);
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.salaryWithholding.findMany.mockResolvedValue([]);
  db.salaryStructureAssignment.findMany.mockResolvedValue([]);
  db.salaryStructureAssignment.findFirst.mockResolvedValue(null);
  db.fullAndFinalStatement.findFirst.mockResolvedValue(null);
  db.payslip.findUnique.mockResolvedValue(null);
  db.payslip.update.mockResolvedValue({});
  db.statutoryRule.findUnique.mockResolvedValue(null); // the rate set is GONE
});

describe("rate set deleted while the run is OPEN — updatePayslip (documented cache use)", () => {
  it("keeps the stored statutory lines verbatim; no duplication, no silent drop", async () => {
    db.payslip.findUnique.mockResolvedValue({ ...SLIP, run: OPEN_RUN });

    // HR edits the earnings; a stale client echoes the slip's OLD statutory
    // lines back in the submission.
    const res = await updatePayslip({
      payslipId: "ps-1",
      expectedVersion: 3,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 7000 }],
      deductions: STORED_STATUTORY.map((l) => ({ ...l })),
      lopDays: 0,
      note: "",
    });
    expect(res.ok).toBe(true);

    const updateArg = db.payslip.update.mock.calls[0][0] as {
      data: { deductions: string; statutory?: unknown };
    };
    // The stored statutory lines ride along EXACTLY ONCE each — replaced,
    // never duplicated (the strip-then-replace discipline), never dropped.
    const stored = JSON.parse(updateArg.data.deductions) as Array<{ key: string; amount: number }>;
    expect(stored.filter((l) => ["paye", "acc", "ks", "sl"].includes(l.key))).toEqual(STORED_STATUTORY);
    // The snapshot column is NOT rewritten (undefined = column unchanged) —
    // the slip keeps the pricing it was computed with.
    expect(updateArg.data.statutory).toBeUndefined();
    // And the audit does not claim a recomputation that did not happen.
    const audit = logAuditMock.mock.calls.find((c) => c[0].action === "payroll.payslip_updated");
    expect(audit?.[0].detail).not.toContain("Statutory lines recomputed");
  });
});
