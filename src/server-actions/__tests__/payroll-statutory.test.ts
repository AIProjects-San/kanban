import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Phase 2 (engine wiring) — payroll action tests: PayrollRun.rateSetId
// resolution, payslip statutory snapshots (lines + JSON), KiwiSaver
// auto-enrolment persistence with its audit entry, and the updatePayslip /
// addPayslip recompute paths. The engine's own math is covered by the nz
// suite; these tests assert the WIRING (what lands in the create/update
// calls, the transactions and the audit log).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "salaryStructure", "salaryComponent",
    "payrollRun", "payslip", "payAdjustment", "auditLog", "holidayCalendarEntry",
    "attendanceRecord", "leaveRequest", "leaveType", "salaryWithholding",
    "fullAndFinalStatement", "mailOutbox", "leaveBalance",
    "statutoryRule", "employeeTaxProfile", "taxYear",
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

vi.mock("@/lib/db", () => ({ db }));

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
vi.mock("@/lib/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
  bumpConfigCache: vi.fn(),
}));

import { createPayrollRun, updatePayslip, addPayslip, getPayrollRun } from "../payroll";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** The FY2026-27 rate set exactly as the resolver's include returns it. */
const RATE_SET_ROW = {
  id: "rs-fy2026",
  label: "NZ FY2026-27 (test)",
  effectiveFrom: new Date("2026-04-01T00:00:00Z"),
  effectiveTo: null,
  isCurrent: true,
  payeTiers: [
    { fromAnnual: 0, toAnnual: 15600, rate: 0.105 },
    { fromAnnual: 15600, toAnnual: 53500, rate: 0.175 },
    { fromAnnual: 53500, toAnnual: 78100, rate: 0.3 },
    { fromAnnual: 78100, toAnnual: 180000, rate: 0.33 },
    { fromAnnual: 180000, toAnnual: null, rate: 0.39 },
  ],
  secondaryRates: [
    { code: "SB", rate: 0.105, accInclusive: false },
    { code: "S", rate: 0.175, accInclusive: false },
    { code: "SH", rate: 0.3, accInclusive: false },
    { code: "ST", rate: 0.33, accInclusive: false },
    { code: "SA", rate: 0.39, accInclusive: false },
    { code: "ND", rate: 0.45, accInclusive: false },
  ],
  accLevy: { rate: 0.0175, maxEarnings: 156641, maxLevy: 2741.22 },
  ietc: { annualAmount: 520, lowerBound: 24000, abateFrom: 66000, upperBound: 70000, abateRate: 0.13 },
  kiwiSaver: { defaultEmployeeRate: 0.035, allowedEmployeeRates: [3, 3.5, 4, 6, 8, 10], employerRate: 0.035 },
  esctTiers: [
    { fromAnnual: 0, toAnnual: 18720, rate: 0.105 },
    { fromAnnual: 18720, toAnnual: 64200, rate: 0.175 },
    { fromAnnual: 64200, toAnnual: 93720, rate: 0.3 },
    { fromAnnual: 93720, toAnnual: 216000, rate: 0.33 },
    { fromAnnual: 216000, toAnnual: null, rate: 0.39 },
  ],
  studentLoan: { rate: 0.12, annualThreshold: 24128 },
};

function taxProfileRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    taxCode: "M",
    isCasual: false,
    kiwiSaverStatus: "ACTIVE",
    kiwiSaverEmployeeRate: null,
    employerKiwiSaverRate: null,
    taxCodeSpecialRate: null,
    stcAccTreatment: "INC",
    stcStudentLoanRate: null,
    employmentType: "PERMANENT",
    casualHolidayPayInWages: true,
    employmentStartDate: null,
    employmentEndDate: null,
    esctRateOverride: null,
    ...overrides,
  };
}

function structureRow(userId: string) {
  return {
    id: `ss-${userId}`,
    userId,
    components: JSON.stringify([
      { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78_000 },
    ]),
    notes: "",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    frequency: "MONTHLY",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  getSessionOrThrowMock.mockResolvedValue({ ...HR_AUTH, userId: "u-yuki", role: "MEMBER" as const, name: "Yuki Tanaka" });
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
  db.user.findMany.mockResolvedValue([
    { id: "u-yuki", name: "Yuki Tanaka" },
    { id: "u-temp", name: "Tess Temp" },
    { id: "u-hr", name: "Remy" },
  ]);
  db.employeeProfile.findMany.mockResolvedValue([]);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.leaveType.findMany.mockResolvedValue([]);
  db.salaryComponent.findMany.mockResolvedValue([]);
  db.employeeTaxProfile.findMany.mockResolvedValue([]);
  db.employeeTaxProfile.findUnique.mockResolvedValue(null);
  db.employeeTaxProfile.updateMany.mockResolvedValue({ count: 1 });
  db.statutoryRule.findFirst.mockResolvedValue(null);
  db.statutoryRule.findUnique.mockResolvedValue(null);
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.salaryWithholding.findMany.mockResolvedValue([]);
  db.fullAndFinalStatement.findFirst.mockResolvedValue(null);
  db.payrollRun.findUnique.mockResolvedValue(null);
  db.payrollRun.findMany.mockResolvedValue([]);
  db.payrollRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "run-new",
    createdAt: new Date(),
    lockedById: "",
    lockedAt: null,
    ...data,
    payslips: (((data.payslips as { create?: unknown[] } | undefined)?.create) ?? []).map((_: unknown, i: number) => ({ id: `ps-${i}` })),
  }));
  db.payslip.findUnique.mockResolvedValue(null);
  db.payslip.findMany.mockResolvedValue([]);
  db.payslip.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ps-new", ...data }));
  db.payslip.update.mockResolvedValue({});
  db.payslip.count.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// createPayrollRun — rate set resolution + statutory snapshots.
// ---------------------------------------------------------------------------

describe("createPayrollRun — statutory wiring", () => {
  it("resolves the rate set, stores rateSetId, and snapshots statutory lines + JSON per slip", async () => {
    db.statutoryRule.findFirst.mockResolvedValue(RATE_SET_ROW);
    db.employeeTaxProfile.findMany.mockResolvedValue([taxProfileRow("u-yuki")]);
    db.salaryStructure.findMany.mockResolvedValue([structureRow("u-yuki")]);

    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);

    // The resolver looked for the set covering the window START (2026-11-01).
    const rsWhere = db.statutoryRule.findFirst.mock.calls[0][0].where;
    expect(rsWhere.effectiveFrom.lte).toEqual(new Date("2026-11-01T00:00:00Z"));

    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: {
        rateSetId: string;
        payslips: { create: Array<{ slipNo: string; deductions: string; statutory: unknown; gross: number; net: number }> };
      };
    };
    expect(createArg.data.rateSetId).toBe("rs-fy2026");

    const slip = createArg.data.payslips.create[0];
    // Employee-side lines ride the deductions JSON, keyed paye/acc/ks.
    expect(JSON.parse(slip.deductions)).toEqual([
      { key: "paye", label: "PAYE income tax (M)", amount: 1301.71 },
      { key: "acc", label: "ACC earners' levy", amount: 113.75 },
      { key: "ks", label: "KiwiSaver employee 3.5%", amount: 227.5 },
    ]);
    // The full snapshot (incl. employer-side money) rides Payslip.statutory.
    const snap = slip.statutory as Record<string, unknown>;
    expect(snap.taxCode).toBe("M");
    expect(snap.rateSetId).toBe("rs-fy2026");
    expect(snap.rateSetLabel).toBe("NZ FY2026-27 (test)");
    expect(snap.taxableGross).toBe(6500);
    expect(snap.defaultedProfile).toBe(false);
    expect((snap.kiwiSaver as Record<string, number>).employerGross).toBe(227.5);
    expect((snap.kiwiSaver as Record<string, number>).esct).toBe(68.25);
    expect(snap.statutoryNet).toBe(4857.04);
    // gross/net math: gross 6500, net 6500 − 1642.96 = 4857.04.
    expect(slip.gross).toBe(6500);
    expect(slip.net).toBe(4857.04);

    if (res.ok) {
      expect(res.data.statutorySkipped).toEqual([]);
      expect(res.data.autoEnrolled).toBe(0);
      expect(res.data.statutoryDefaulted).toBe(0);
    }
    // The run audit names the rate set.
    const runAudit = logAuditMock.mock.calls.find((c) => c[0].action === "payroll.run_created");
    expect(runAudit?.[0].detail).toContain('priced on "NZ FY2026-27 (test)"');
  });

  it("resolves by the window START (a set effective mid-window does not cover it)", async () => {
    db.statutoryRule.findFirst.mockResolvedValue(null);
    db.salaryStructure.findMany.mockResolvedValue([structureRow("u-yuki")]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { rateSetId: string } & { payslips: { create: Array<{ deductions: string; statutory: unknown }> } } };
    expect(createArg.data.rateSetId).toBe("");
    const slip = createArg.data.payslips.create[0];
    expect(JSON.parse(slip.deductions)).toEqual([]); // pre-engine behaviour
    expect(slip.statutory).toBeUndefined();
    // No profile/classification reads when no set covers the window.
    expect(db.employeeTaxProfile.findMany).not.toHaveBeenCalled();
  });

  it("never resolves a rate set for DAILY cadences (IRD publishes no daily table)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([{ ...structureRow("u-yuki"), frequency: "DAILY" }]);
    const res = await createPayrollRun({ frequency: "DAILY", anchorDate: "2026-11-09" });
    expect(res.ok).toBe(true);
    expect(db.statutoryRule.findFirst).not.toHaveBeenCalled();
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { rateSetId: string } };
    expect(createArg.data.rateSetId).toBe("");
  });

  it("flags system-default profiles when the employee has no tax profile row", async () => {
    db.statutoryRule.findFirst.mockResolvedValue(RATE_SET_ROW);
    db.employeeTaxProfile.findMany.mockResolvedValue([]); // no rows at all
    db.salaryStructure.findMany.mockResolvedValue([structureRow("u-yuki")]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.statutoryDefaulted).toBe(1);
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { payslips: { create: Array<{ statutory: unknown }> } } };
    const snap = createArg.data.payslips.create[0].statutory as Record<string, unknown>;
    expect(snap.defaultedProfile).toBe(true);
    // The run audit names the defaulted slips.
    const runAudit = logAuditMock.mock.calls.find((c) => c[0].action === "payroll.run_created");
    expect(runAudit?.[0].detail).toContain("system-default tax profiles");
  });
});

// ---------------------------------------------------------------------------
// createPayrollRun — KiwiSaver auto-enrolment persistence.
// ---------------------------------------------------------------------------

describe("createPayrollRun — KiwiSaver auto-enrolment", () => {
  it("persists the 28-day TEMPORARY enrolment in the run transaction and audits it after commit", async () => {
    db.statutoryRule.findFirst.mockResolvedValue(RATE_SET_ROW);
    db.employeeTaxProfile.findMany.mockResolvedValue([
      taxProfileRow("u-yuki"),
      taxProfileRow("u-temp", {
        employmentType: "TEMPORARY",
        employmentStartDate: new Date("2026-09-01T00:00:00Z"), // day 29 = 2026-09-29
      }),
    ]);
    db.salaryStructure.findMany.mockResolvedValue([structureRow("u-yuki"), structureRow("u-temp")]);

    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.autoEnrolled).toBe(1);

    // The guarded write: ACTIVE + no election → the default rate, sticky.
    expect(db.employeeTaxProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: "u-temp", kiwiSaverStatus: "ACTIVE", kiwiSaverEmployeeRate: null },
      data: { kiwiSaverEmployeeRate: 0.035 },
    });
    // Exactly one enrolment write (the permanent employee never triggers).
    expect(db.employeeTaxProfile.updateMany).toHaveBeenCalledTimes(1);

    // The audit entry (after commit) with the reason and the rate.
    const enrol = logAuditMock.mock.calls.find((c) => c[0].action === "payroll.kiwisaver_auto_enrolled");
    expect(enrol).toBeDefined();
    expect(enrol![0].entityType).toBe("EMPLOYEE_TAX_PROFILE");
    expect(enrol![0].detail).toContain("28 days");
    expect(enrol![0].detail).toContain("3.5%");

    // The temp's slip prices KiwiSaver at the default and snapshots the trigger.
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { payslips: { create: Array<{ userId: string; deductions: string; statutory: unknown }> } } };
    const tempSlip = createArg.data.payslips.create.find((s) => s.userId === "u-temp")!;
    expect(JSON.parse(tempSlip.deductions).find((l: { key: string }) => l.key === "ks").amount).toBe(227.5);
    const snap = tempSlip.statutory as { kiwiSaver: { autoEnrolTriggered: boolean } };
    expect(snap.kiwiSaver.autoEnrolTriggered).toBe(true);
  });

  it("skips a broken STC profile loudly: slip created WITHOUT statutory lines, reason surfaced", async () => {
    db.statutoryRule.findFirst.mockResolvedValue(RATE_SET_ROW);
    db.employeeTaxProfile.findMany.mockResolvedValue([
      taxProfileRow("u-yuki", { taxCode: "STC", taxCodeSpecialRate: null }),
    ]);
    db.salaryStructure.findMany.mockResolvedValue([structureRow("u-yuki")]);

    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true); // the run itself is NOT aborted
    if (res.ok) {
      expect(res.data.statutorySkipped).toHaveLength(1);
      expect(res.data.statutorySkipped[0].reason).toContain("STC");
      expect(res.data.statutorySkipped[0].slipNo).toBe("PS-2026-11-001");
    }
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { payslips: { create: Array<{ deductions: string; statutory: unknown; net: number }> } } };
    const slip = createArg.data.payslips.create[0];
    expect(JSON.parse(slip.deductions)).toEqual([]); // no statutory lines
    expect(slip.statutory).toBeUndefined();
    expect(slip.net).toBe(6500); // untouched money math
    const runAudit = logAuditMock.mock.calls.find((c) => c[0].action === "payroll.run_created");
    expect(runAudit?.[0].detail).toContain("WITHOUT statutory lines");
  });
});

// ---------------------------------------------------------------------------
// updatePayslip — the OPEN-run recompute.
// ---------------------------------------------------------------------------

describe("updatePayslip — statutory recompute", () => {
  const RUN = {
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
    deductions: JSON.stringify([
      { key: "paye", label: "PAYE income tax (M)", amount: 1301.71 },
      { key: "acc", label: "ACC earners' levy", amount: 113.75 },
      { key: "ks", label: "KiwiSaver employee 3.5%", amount: 227.5 },
    ]),
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

  it("recomputes statutory lines from the EDITED earnings against the run's frozen set", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.employeeTaxProfile.findUnique.mockResolvedValue(taxProfileRow("u-yuki"));
    db.payslip.findUnique.mockResolvedValue({ ...SLIP, run: RUN });

    // HR raised the basic to 7,000 and a stale client echoed the old paye line.
    const res = await updatePayslip({
      payslipId: "ps-1",
      expectedVersion: 3,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 7000 }],
      deductions: [{ key: "paye", label: "PAYE income tax (M)", amount: 1301.71 }],
      lopDays: 0,
      note: "",
    });
    expect(res.ok).toBe(true);

    // The rate set was resolved EXPLICITLY by the run's frozen id.
    expect(db.statutoryRule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rs-fy2026" } }),
    );

    const updateArg = db.payslip.update.mock.calls[0][0] as {
      data: { deductions: string; statutory: unknown; gross: number; net: number; version: number };
    };
    // Stale statutory keys stripped, fresh lines recomputed on 7,000:
    // PAYE 1466.46 / ACC 122.50 / KS 245.00 (annualised 84,000 → slab tax
    // 17,597.50 ÷ 12).
    expect(JSON.parse(updateArg.data.deductions)).toEqual([
      { key: "paye", label: "PAYE income tax (M)", amount: 1466.46 },
      { key: "acc", label: "ACC earners' levy", amount: 122.5 },
      { key: "ks", label: "KiwiSaver employee 3.5%", amount: 245 },
    ]);
    const snap = updateArg.data.statutory as Record<string, unknown>;
    expect(snap.taxableGross).toBe(7000);
    expect(snap.statutoryNet).toBe(5166.04);
    expect(updateArg.data.gross).toBe(7000);
    expect(updateArg.data.net).toBe(5166.04);
    expect(updateArg.data.version).toBe(4);
    // No enrolment fired (permanent, election already sticky by default posture).
    expect(db.employeeTaxProfile.updateMany).not.toHaveBeenCalled();
    const audit = logAuditMock.mock.calls.find((c) => c[0].action === "payroll.payslip_updated");
    expect(audit?.[0].detail).toContain("Statutory lines recomputed");
  });

  it("refuses the save when the engine cannot re-derive (broken STC) — nothing stored", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.employeeTaxProfile.findUnique.mockResolvedValue(taxProfileRow("u-yuki", { taxCode: "STC" }));
    db.payslip.findUnique.mockResolvedValue({ ...SLIP, run: RUN });

    const res = await updatePayslip({
      payslipId: "ps-1",
      expectedVersion: 3,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6500 }],
      deductions: [],
      lopDays: 0,
      note: "",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("STC");
      expect(res.error).toContain("fix the tax profile");
    }
    expect(db.payslip.update).not.toHaveBeenCalled();
  });

  it("keeps pre-engine runs byte-identical (no rateSetId → no statutory recompute)", async () => {
    db.payslip.findUnique.mockResolvedValue({
      ...SLIP,
      deductions: JSON.stringify([{ key: "union", label: "Union fees", amount: 10 }]),
      run: { ...RUN, rateSetId: "" },
    });
    const res = await updatePayslip({
      payslipId: "ps-1",
      expectedVersion: 3,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6500 }],
      deductions: [{ key: "union", label: "Union fees", amount: 10 }],
      lopDays: 0,
      note: "",
    });
    expect(res.ok).toBe(true);
    expect(db.statutoryRule.findUnique).not.toHaveBeenCalled();
    const updateArg = db.payslip.update.mock.calls[0][0] as { data: { deductions: string; statutory?: unknown } };
    expect(JSON.parse(updateArg.data.deductions)).toEqual([{ key: "union", label: "Union fees", amount: 10 }]);
    expect(updateArg.data.statutory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// addPayslip — the joiner.
// ---------------------------------------------------------------------------

describe("addPayslip — joiner statutory wiring", () => {
  const RUN = {
    id: "run-engine",
    period: "2026-11",
    status: "OPEN",
    workingDays: 21,
    frequency: "MONTHLY",
    startDate: new Date("2026-11-01T00:00:00Z"),
    endDate: new Date("2026-11-30T00:00:00Z"),
    rateSetId: "rs-fy2026",
    createdAt: new Date("2026-11-01T00:00:00Z"),
  };

  it("computes the joiner's statutory lines + snapshot and persists a triggered enrolment", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.employeeTaxProfile.findUnique.mockResolvedValue(
      taxProfileRow("u-temp", {
        employmentType: "TEMPORARY",
        employmentStartDate: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    db.payrollRun.findUnique.mockResolvedValue(RUN);
    db.salaryStructure.findFirst.mockResolvedValue(structureRow("u-temp"));

    const res = await addPayslip({ runId: "run-engine", userId: "u-temp" });
    expect(res.ok).toBe(true);

    const createArg = db.payslip.create.mock.calls[0][0] as {
      data: { deductions: string; statutory: unknown; gross: number; net: number };
    };
    expect(JSON.parse(createArg.data.deductions)).toEqual([
      { key: "paye", label: "PAYE income tax (M)", amount: 1301.71 },
      { key: "acc", label: "ACC earners' levy", amount: 113.75 },
      { key: "ks", label: "KiwiSaver employee 3.5%", amount: 227.5 },
    ]);
    const snap = createArg.data.statutory as Record<string, unknown>;
    expect(snap.taxableGross).toBe(6500);
    expect((snap.kiwiSaver as Record<string, unknown>).autoEnrolTriggered).toBe(true);

    // The enrolment landed inside the slip's transaction, audited after.
    expect(db.employeeTaxProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: "u-temp", kiwiSaverStatus: "ACTIVE", kiwiSaverEmployeeRate: null },
      data: { kiwiSaverEmployeeRate: 0.035 },
    });
    const enrol = logAuditMock.mock.calls.find((c) => c[0].action === "payroll.kiwisaver_auto_enrolled");
    expect(enrol).toBeDefined();
    const added = logAuditMock.mock.calls.find((c) => c[0].action === "payroll.payslip_added");
    expect(added?.[0].detail).toContain("Statutory lines computed");
  });

  it("fails loudly when the joiner's profile cannot compute (broken STC)", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.employeeTaxProfile.findUnique.mockResolvedValue(taxProfileRow("u-temp", { taxCode: "STC" }));
    db.payrollRun.findUnique.mockResolvedValue(RUN);
    db.salaryStructure.findFirst.mockResolvedValue(structureRow("u-temp"));

    const res = await addPayslip({ runId: "run-engine", userId: "u-temp" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("STC");
    expect(db.payslip.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getPayrollRun — statutory serialization.
// ---------------------------------------------------------------------------

describe("getPayrollRun — statutory serialization", () => {
  it("exposes the parsed statutory snapshot on each payslip", async () => {
    const snapshot = {
      taxCode: "M",
      rateSetId: "rs-fy2026",
      rateSetLabel: "NZ FY2026-27 (test)",
      ruleVersion: "nz1:abc",
      frequency: "MONTHLY",
      payPeriodEnd: "2026-11-30",
      taxableGross: 6500,
      defaultedProfile: false,
      paye: { tax: 1301.71, acc: 113.75, total: 1415.46, method: "M", ietc: 0, annualised: 78000 },
      kiwiSaver: {
        status: "ENROLLED", reason: "r", autoEnrolTriggered: false,
        employee: 227.5, employerGross: 227.5, esct: 68.25, employerNet: 159.25,
        employeeRate: 0.035, employerRate: 0.035, esctRate: 0.3,
      },
      studentLoan: 0,
      statutoryNet: 4857.04,
    };
    db.payrollRun.findUnique.mockResolvedValue({
      id: "run-engine",
      period: "2026-11",
      status: "LOCKED",
      frequency: "MONTHLY",
      startDate: new Date("2026-11-01T00:00:00Z"),
      endDate: new Date("2026-11-30T00:00:00Z"),
      workingDays: 21,
      rateSetId: "rs-fy2026",
      lockedById: "",
      lockedAt: null,
      createdAt: new Date("2026-11-01T00:00:00Z"),
      payslips: [{
        id: "ps-1",
        runId: "run-engine",
        userId: "u-yuki",
        slipNo: "PS-2026-11-001",
        earnings: "[]",
        deductions: "[]",
        note: "",
        lopDays: 0,
        lopSource: "AUTO",
        lopDetail: null,
        version: 0,
        paidDays: null,
        gross: 6500,
        net: 4857.04,
        withholdStatus: "",
        statutory: snapshot,
      }],
    });
    db.payrollRun.findMany.mockResolvedValue([]);
    db.payslip.findMany.mockResolvedValue([]);
    const res = await getPayrollRun("run-engine");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.payslips[0].statutory?.taxCode).toBe("M");
      expect(res.data.payslips[0].statutory?.kiwiSaver.esct).toBe(68.25);
    }
  });
});
