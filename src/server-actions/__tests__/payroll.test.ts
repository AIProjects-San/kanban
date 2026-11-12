import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Recruitment R7 — payroll action tests (docs/RECRUITMENT_MODULE_PLAN.md §5):
// payroll:manage gating (ADMIN+HR only), structure lifecycle (manual + from
// signed offer), run creation snapshotting structures ÷12, payslip editing
// with the auto LOP line, lock immutability, and YTD accumulation.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "candidate", "offerRecord", "salaryStructure",
    "salaryComponent", "payrollRun", "payslip", "payAdjustment", "leaveEncashment", "benefitElection", "benefitAccrual", "auditLog", "holidayCalendarEntry", "salaryWithholding",
    "attendanceRecord", "leaveRequest", "leaveType", "fullAndFinalStatement",
    "mailOutbox", "leaveBalance",
    // Phase 2 (engine wiring) — the statutory reads createPayrollRun makes.
    "statutoryRateSet", "employeeTaxProfile",
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
// P18 (PR-B16) — the outbox pair mirrors the real semantics: queue writes
// through the GIVEN client (tx in the mock === db), deliver resolves
// best-effort and never throws. Tests flip deliverStatus per case.
const deliverOutboxMailMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  queueOutboxMail: async (
    tx: { mailOutbox: { create: (a: unknown) => Promise<Record<string, unknown>> } },
    input: { kind: string; candidateId?: string | null; toAddress: string; subject: string; text: string; sentById: string },
  ) =>
    tx.mailOutbox.create({
      data: {
        kind: input.kind,
        candidateId: input.candidateId ?? null,
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

// S4 (PR-B07) — the LOP derivation reads the workspace unmarked-day
// policy through the cached config loader; mocked so tests can flip it.
const getWorkspaceConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
  bumpConfigCache: vi.fn(),
}));

import {
  getSalaryStructures,
  saveSalaryStructure,
  createStructureFromOffer,
  createPayrollRun,
  bulkAssignStructure,
  getPayrollRun,
  getPayrollRuns,
  updatePayslip,
  addPayslip,
  lockPayrollRun,
  exportPayrollRunCsv,
  getPayrollData,
  getMyPayslips,
  createPayAdjustment,
  listPayAdjustments,
  applyPayAdjustmentsToRun,
} from "../payroll";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

function denyFor(perm: string) {
  return async (p: string) => {
    if (p === perm) {
      throw new (class extends Error { digest = "AuthorizationError"; })("denied");
    }
    return HR_AUTH;
  };
}

const COMPONENTS = [
  { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78_000 },
  { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 2_400 },
  { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
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

const LOCKED_RUN = {
  id: "run-0", period: "2026-10", status: "LOCKED", lockedById: "u-hr", lockedAt: new Date(),
  createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
};

function payslipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ps-1", runId: "run-1", userId: "u-yuki", slipNo: "PS-2026-11-001",
    earnings: JSON.stringify([
      { key: "basic", label: "Basic Salary", amount: 6_500 },
      { key: "transport", label: "Transport Allowance", amount: 200 },
    ]),
    deductions: "[]",
    note: "", lopDays: 0, lopSource: "AUTO", version: 0, paidDays: null, gross: 6_700, net: 6_700,
    createdAt: new Date(), updatedAt: new Date(),
    run: OPEN_RUN,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  getSessionOrThrowMock.mockResolvedValue({ ...HR_AUTH, userId: "u-yuki", role: "MEMBER" as const, name: "Yuki Tanaka" });
  db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka" }, { id: "u-hr", name: "Remy" }]);
  db.user.findUnique.mockResolvedValue({ id: "u-yuki", name: "Yuki Tanaka" });
  db.employeeProfile.findMany.mockResolvedValue([{ userId: "u-yuki", jobTitle: "Data Engineer", department: "ENGINEERING" }]);
  db.candidate.findMany.mockResolvedValue([]);
  db.candidate.findFirst.mockResolvedValue(null);
  db.offerRecord.findFirst.mockResolvedValue(null);
  db.salaryStructure.findMany.mockResolvedValue([]);
  db.salaryStructure.findFirst.mockResolvedValue(null);
  db.salaryStructure.findUnique.mockResolvedValue(null);
  db.salaryStructure.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ss-new", ...data }));
  db.salaryStructure.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ss-1", ...data }));
  db.salaryStructure.updateMany.mockResolvedValue({ count: 0 });
  // F1.5 — the component catalog: empty by default (createStructureFromOffer
  // then auto-registers every offer code, which the F1.5 tests assert).
  db.salaryComponent.findMany.mockResolvedValue([]);
  db.salaryComponent.findUnique.mockResolvedValue(null);
  db.salaryComponent.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sc-new", createdAt: new Date(), updatedAt: new Date(), ...data }));
  db.salaryComponent.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sc-1", createdAt: new Date(), updatedAt: new Date(), ...data }));
  db.salaryComponent.delete.mockResolvedValue({ id: "sc-1" });
  // F1.1 — createPayrollRun reads the period's holiday entries; default to
  // an empty calendar (denominator falls back to the calendar month length).
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  // F1.4 — derivation inputs default to "no attendance, no leave".
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.leaveType.findMany.mockResolvedValue([]);
  db.payrollRun.findMany.mockResolvedValue([]);
  db.payrollRun.findUnique.mockResolvedValue(null);
  db.payrollRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "run-new", createdAt: new Date(), lockedById: "", lockedAt: null, ...data,
    payslips: (((data.payslips as { create?: unknown[] } | undefined)?.create) ?? []).map((_: unknown, i: number) => ({ id: `ps-${i}` })),
  }));
  db.payrollRun.update.mockResolvedValue({});
  db.payslip.findMany.mockResolvedValue([]);
  db.payslip.findUnique.mockResolvedValue(null);
  db.payslip.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ps-new", ...data }));
  db.payslip.update.mockResolvedValue({});
  db.payslip.count.mockResolvedValue(0);
  // P1 (F2.3) — the adjustment adapter: empty by default (existing run
  // creation tests must stay byte-identical — no adjustments consumed).
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.payAdjustment.findUnique.mockResolvedValue(null);
  db.payAdjustment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "adj-new", createdAt: new Date(), updatedAt: new Date(), ...data }));
  db.payAdjustment.update.mockResolvedValue({});
  db.leaveEncashment.updateMany.mockResolvedValue({ count: 0 });
  // P5 (F3.2) — no benefit elections by default (locks accrue nothing).
  db.benefitElection.findMany.mockResolvedValue([]);
  db.benefitAccrual.create.mockResolvedValue({});
  db.benefitAccrual.groupBy.mockResolvedValue([]);
  // P8 (F3.3) — no hold windows by default (slips stay unstamped).
  db.salaryWithholding.findMany.mockResolvedValue([]);
  db.salaryWithholding.findFirst.mockResolvedValue(null);
  // S4 — default policy: IGNORED (pre-S4 semantics byte-for-byte).
  getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED" } });
});

describe("R7 — RBAC (payroll:manage = ADMIN + HR only)", () => {
  it("MANAGER is denied on every payroll action", async () => {
    requirePermissionMock.mockImplementation(denyFor("payroll:manage"));
    const results = await Promise.all([
      getSalaryStructures(),
      getPayrollRuns(),
      saveSalaryStructure({ userId: "u-yuki", components: COMPONENTS }),
      createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" }),
      updatePayslip({ payslipId: "ps-1", expectedVersion: 0, earnings: [], deductions: [], lopDays: 0 }),
      lockPayrollRun({ runId: "run-1" }),
      getPayrollData(),
    ]);
    for (const r of results) expect(r.ok).toBe(false);
    expect(db.payrollRun.create).not.toHaveBeenCalled();
  });
});

describe("R7 — salary structures", () => {
  it("getSalaryStructures serializes with names, profiles and the offer-source hint", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.candidate.findMany.mockResolvedValue([{ userId: "u-yuki" }]);
    const res = await getSalaryStructures();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]).toMatchObject({
        id: "ss-1", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
        source: "OFFER", isActive: true,
      });
      expect(res.data[0].components).toHaveLength(3);
    }
  });

  it("saveSalaryStructure creates + retires the previous active structure", async () => {
    const res = await saveSalaryStructure({ userId: "u-yuki", components: COMPONENTS, notes: "band A" });
    expect(res.ok).toBe(true);
    expect(db.salaryStructure.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-yuki", isActive: true } }),
    );
    expect(db.salaryStructure.create).toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.structure_saved" }));
  });

  it("saveSalaryStructure refuses an empty component list and a no-op deactivate", async () => {
    const empty = await saveSalaryStructure({ userId: "u-yuki", components: [] });
    expect(empty.ok).toBe(false);
    const deactivate = await saveSalaryStructure({ userId: "u-yuki", components: COMPONENTS, isActive: false });
    expect(deactivate.ok).toBe(false);
    expect(db.salaryStructure.create).not.toHaveBeenCalled();
  });

  it("createStructureFromOffer copies the SIGNED offer components", async () => {
    db.candidate.findFirst.mockResolvedValue({ id: "cand-1", fullName: "Priyanka Menon" });
    db.offerRecord.findFirst.mockResolvedValue({
      id: "or-1", candidateId: "cand-1", status: "SIGNED", signedAt: new Date(),
      templateLabel: "Designer Band", components: JSON.stringify(COMPONENTS),
    });
    const res = await createStructureFromOffer({ userId: "u-yuki" });
    expect(res.ok).toBe(true);
    const createArg = db.salaryStructure.create.mock.calls[0][0] as { data: { components: string } };
    expect(JSON.parse(createArg.data.components)).toEqual(COMPONENTS);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.structure_from_offer" }));
  });

  it("createStructureFromOffer refuses employees without a signed offer", async () => {
    db.candidate.findFirst.mockResolvedValue(null);
    const noCandidate = await createStructureFromOffer({ userId: "u-yuki" });
    expect(noCandidate.ok).toBe(false);
    db.candidate.findFirst.mockResolvedValue({ id: "cand-1", fullName: "X" });
    db.offerRecord.findFirst.mockResolvedValue(null);
    const noOffer = await createStructureFromOffer({ userId: "u-yuki" });
    expect(noOffer.ok).toBe(false);
  });
});

describe("R7 — payroll runs", () => {
  it("createPayrollRun validates the period format and rejects duplicates", async () => {
    const bad = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-13-01" });
    expect(bad.ok).toBe(false);
    db.payrollRun.findUnique.mockResolvedValue({ id: "run-1" });
    const dup = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(dup.ok).toBe(false);
    expect(db.payrollRun.create).not.toHaveBeenCalled();
  });

  it("createPayrollRun refuses to run with zero active structures", async () => {
    db.salaryStructure.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(false);
  });

  it("createPayrollRun snapshots every ACTIVE structure ÷12 with sequential slip numbers", async () => {
    db.salaryStructure.findMany.mockResolvedValue([
      STRUCTURE_ROW,
      { ...STRUCTURE_ROW, id: "ss-2", userId: "u-hana" },
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.payslipCount).toBe(2);

    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: {
        period: string;
        status: string;
        payslips: { create: Array<{ userId: string; slipNo: string; earnings: string; gross: number; net: number; lopDays: number; lopSource: string }> };
      };
    };
    expect(createArg.data.period).toBe("2026-11");
    expect(createArg.data.status).toBe("OPEN");
    const slips = createArg.data.payslips.create;
    expect(slips.map((s) => s.slipNo)).toEqual(["PS-2026-11-001", "PS-2026-11-002"]);
    // Monthly: 78,000/12 + 2,400/12 = 6,700 gross; employer KiwiSaver stays
    // OFF the payslip.
    const lines = JSON.parse(slips[0].earnings);
    expect(lines).toEqual([
      { key: "basic", label: "Basic Salary", amount: 6_500 },
      { key: "transport", label: "Transport Allowance", amount: 200 },
    ]);
    expect(slips[0].gross).toBe(6_700);
    expect(slips[0].net).toBe(6_700);
    // F1.4 — no attendance/leave facts → zero LOP, AUTO provenance.
    expect(slips[0].lopDays).toBe(0);
    expect(slips[0].lopSource).toBe("AUTO");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.run_created" }));
  });

  it("createPayrollRun denormalizes the holiday-aware working-day count (F1.1)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    // Labour Day Mon 2026-10-26: October 2026 has 22 Mon–Fri days − 1 = 21
    // working days.
    db.holidayCalendarEntry.findMany.mockResolvedValue([
      { date: new Date("2026-10-26T00:00:00.000Z"), isHalfDay: false },
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-10-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { workingDays: number } };
    expect(createArg.data.workingDays).toBe(21);
    // And the period's holiday range is what was read.
    const where = db.holidayCalendarEntry.findMany.mock.calls[0][0].where;
    expect(where.date.gte).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(where.date.lte).toEqual(new Date("2026-10-31T00:00:00.000Z"));
  });

  it("createPayrollRun with an empty calendar stores the plain Mon–Fri count", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { workingDays: number } };
    // No holidays seeded — working-day semantics still apply: November 2026
    // has 21 Mon–Fri days (vs the 30-day calendar length pre-F1.1 runs used).
    expect(createArg.data.workingDays).toBe(21);
  });

  it("F1.4 — createPayrollRun derives lopDays from ABSENT/HALF_DAY attendance + unpaid leave and materializes the LOP line", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    // Mon 2 ABSENT (1) + Tue 3 HALF_DAY (0.5) + unpaid leave Thu 5→Fri 6 (2)
    // = 3.5 days over November 2026's 21 working days.
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-11-02T00:00:00.000Z"), status: "ABSENT" },
      { userId: "u-yuki", date: new Date("2026-11-03T00:00:00.000Z"), status: "HALF_DAY" },
    ]);
    db.leaveRequest.findMany.mockResolvedValue([
      { userId: "u-yuki", startDate: new Date("2026-11-05T00:00:00.000Z"), endDate: new Date("2026-11-06T00:00:00.000Z"), leaveTypeId: "lt-unpaid" },
    ]);
    db.leaveType.findMany.mockResolvedValue([{ id: "lt-unpaid", paid: false }]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ lopDays: number; lopSource: string; deductions: string; net: number }> } };
    };
    const slip = createArg.data.payslips.create[0];
    expect(slip.lopDays).toBe(3.5);
    expect(slip.lopSource).toBe("AUTO");
    // The LOP line exists at creation: 6,700 × 3.5 / 21 = 1,116.67.
    const deductions = JSON.parse(slip.deductions) as Array<{ key: string; label: string; amount: number }>;
    const lop = deductions.find((l) => l.key === "lop");
    expect(lop?.amount).toBe(1_116.67);
    expect(lop?.label).toBe("Loss of pay (3.5 days)");
    expect(slip.net).toBeCloseTo(6_700 - 1_116.67, 2);
    // The run audit names the auto-derived count.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_created",
      detail: expect.stringContaining("1 with auto-derived loss-of-pay"),
    }));
  });

  it("F1.4 — paid approved leave shields a day with an ABSENT mark (no double charge)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-11-02T00:00:00.000Z"), status: "ABSENT" },
    ]);
    db.leaveRequest.findMany.mockResolvedValue([
      { userId: "u-yuki", startDate: new Date("2026-11-02T00:00:00.000Z"), endDate: new Date("2026-11-04T00:00:00.000Z"), leaveTypeId: "lt-annual" },
    ]);
    db.leaveType.findMany.mockResolvedValue([{ id: "lt-annual", paid: true }]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ lopDays: number; deductions: string }> } };
    };
    expect(createArg.data.payslips.create[0].lopDays).toBe(0);
    expect(createArg.data.payslips.create[0].deductions).toBe("[]");
  });

  it("P15 (PR-06) — partially-paid leave charges (1 − fraction) days and freezes the lopDetail breakdown", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    // Half-pay study leave Mon 2 → Tue 3 (2 working days at 50% salary →
    // 1 day docked) + an ABSENT day Thu 5 (1) = 2 days.
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-11-05T00:00:00.000Z"), status: "ABSENT" },
    ]);
    db.leaveRequest.findMany.mockResolvedValue([
      { userId: "u-yuki", startDate: new Date("2026-11-02T00:00:00.000Z"), endDate: new Date("2026-11-03T00:00:00.000Z"), leaveTypeId: "lt-half" },
    ]);
    db.leaveType.findMany.mockResolvedValue([
      { id: "lt-half", paid: true, salaryFraction: 0.5, code: "HALF_PAY", name: "Half-pay Study Leave" },
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ lopDays: number; lopSource: string; lopDetail: unknown }> } };
    };
    const slip = createArg.data.payslips.create[0];
    expect(slip.lopDays).toBe(2);
    expect(slip.lopSource).toBe("AUTO");
    // The frozen breakdown names the type, its fraction, and the
    // attendance-side dock (the Salary Slip Leave child, Fernly-shaped).
    expect(slip.lopDetail).toEqual({
      absentDays: 1,
      halfDays: 0,
      unmarkedDays: 0,
      leave: [{
        leaveTypeId: "lt-half",
        code: "HALF_PAY",
        name: "Half-pay Study Leave",
        takenDays: 2,
        chargedDays: 1,
        fraction: 0.5,
        paid: true,
      }],
    });
    // The LOP line materializes from the fractional total: 6,700 × 2 / 21
    // = 638.10 (the half-pay days dock at 0.5 each, so the money is honest
    // to the fraction).
    const deductions = JSON.parse(
      (createArg.data.payslips.create[0] as unknown as { deductions: string }).deductions,
    ) as Array<{ key: string; amount: number }>;
    expect(deductions.find((l) => l.key === "lop")?.amount).toBe(638.1);
  });

  it("P15 (PR-06) — a fully-paid type (fraction 1, the default) writes no lopDetail", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    db.attendanceRecord.findMany.mockResolvedValue([]);
    db.leaveRequest.findMany.mockResolvedValue([
      { userId: "u-yuki", startDate: new Date("2026-11-02T00:00:00.000Z"), endDate: new Date("2026-11-03T00:00:00.000Z"), leaveTypeId: "lt-annual" },
    ]);
    db.leaveType.findMany.mockResolvedValue([
      { id: "lt-annual", paid: true, salaryFraction: 1, code: "ANNUAL", name: "Annual Leave" },
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ lopDays: number; lopDetail: unknown }> } };
    };
    // Zero charge → nothing was docked → no detail (an all-zero breakdown
    // is noise, not honesty).
    expect(createArg.data.payslips.create[0].lopDays).toBe(0);
    expect(createArg.data.payslips.create[0].lopDetail).toBeUndefined();
  });

  it("P15 (PR-06) — a MANUAL lopDays override clears the frozen breakdown", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow({
      lopDays: 1.5,
      lopSource: "AUTO",
      lopDetail: {
        absentDays: 1, halfDays: 0, unmarkedDays: 0,
        leave: [{ leaveTypeId: "lt-half", code: "HALF_PAY", name: "Half-pay Study Leave", takenDays: 2, chargedDays: 1, fraction: 0.5, paid: true }],
      },
    }));
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 2,
      note: "",
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as {
      data: { lopDays: number; lopSource: string; lopDetail: unknown };
    };
    expect(updateArg.data.lopDays).toBe(2);
    expect(updateArg.data.lopSource).toBe("MANUAL");
    // The override replaces the derivation — the stale breakdown must not
    // survive it (the modal honestly says "manually set by HR").
    expect(updateArg.data.lopDetail).toBe(Prisma.DbNull);
  });

  it("P15 (PR-06) — saving the SAME lopDays keeps the frozen breakdown", async () => {
    const detail = {
      absentDays: 1, halfDays: 0, unmarkedDays: 0,
      leave: [{ leaveTypeId: "lt-half", code: "HALF_PAY", name: "Half-pay Study Leave", takenDays: 2, chargedDays: 1, fraction: 0.5, paid: true }],
    };
    db.payslip.findUnique.mockResolvedValue(payslipRow({ lopDays: 1.5, lopSource: "AUTO", lopDetail: detail }));
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 1.5,
      note: "",
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as {
      data: { lopDetail: unknown };
    };
    // An unchanged save is not an override — the detail survives untouched
    // (undefined = Prisma "leave the column alone").
    expect(updateArg.data.lopDetail).toBeUndefined();
  });

  it("getPayrollRuns aggregates totals and names the locker", async () => {
    db.payrollRun.findMany.mockResolvedValue([
      { ...OPEN_RUN, payslips: [{ gross: 6_700, net: 6_700 }] },
      { ...LOCKED_RUN, payslips: [{ gross: 5_000, net: 4_000 }] },
    ]);
    const res = await getPayrollRuns();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]).toMatchObject({ period: "2026-11", status: "OPEN", payslipCount: 1, totalGross: 6_700, totalNet: 6_700 });
      expect(res.data[1]).toMatchObject({ period: "2026-10", status: "LOCKED", lockedBy: "Remy" });
    }
  });
});

describe("R7 — payslips", () => {
  it("getPayrollRun computes YTD + the P11 aggregates across same-year periods up to and including this run", async () => {
    // Two runs in 2026 (10 LOCKED + 11 OPEN) — the year query returns both.
    db.payrollRun.findUnique.mockResolvedValue({
      ...OPEN_RUN,
      payslips: [payslipRow({ id: "ps-nov", net: 6_700, gross: 6_700 })],
    });
    db.payrollRun.findMany.mockResolvedValue([
      { id: "run-0", period: "2026-10", startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-10-31T00:00:00Z") },
      { id: "run-1", period: "2026-11", startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-30T00:00:00Z") },
    ]);
    // The mock mirrors the DB: every slip of the up-to runs (any withhold
    // status) carries the columns the P11 aggregate kernel reads.
    db.payslip.findMany.mockResolvedValue([
      { id: "ps-oct", userId: "u-yuki", slipNo: "PS-2026-10-001", runId: "run-0", gross: 6_700, net: 6_700, withholdStatus: "", earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 6_700 }]), deductions: "[]" },
      { id: "ps-nov", userId: "u-yuki", slipNo: "PS-2026-11-001", runId: "run-1", gross: 6_600, net: 6_600, withholdStatus: "", earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 6_600 }]), deductions: "[]" },
    ]);
    const res = await getPayrollRun("run-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.payslips[0].ytdNet).toBe(13_300);
      // P11 — gross YTD accumulates alongside; MTD resets with the month
      // (the November slip alone); component YTD merges the basic rows.
      expect(res.data.payslips[0].ytdGross).toBe(13_300);
      expect(res.data.payslips[0].mtdNet).toBe(6_600);
      expect(res.data.payslips[0].componentYtd.find((r) => r.key === "basic")?.amount).toBe(13_300);
      expect(res.data.payslips[0].userName).toBe("Yuki Tanaka");
      expect(res.data.payslips[0].lopSource).toBe("AUTO");
      expect(res.data.run.totalNet).toBe(6_700);
    }
  });

  it("F1.4 — getPayrollRun serializes the LOP provenance (MANUAL rows read back as MANUAL)", async () => {
    db.payrollRun.findUnique.mockResolvedValue({
      ...OPEN_RUN,
      payslips: [payslipRow({ lopDays: 2, lopSource: "MANUAL" })],
    });
    db.payrollRun.findMany.mockResolvedValue([]);
    const res = await getPayrollRun("run-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.payslips[0].lopSource).toBe("MANUAL");
      expect(res.data.payslips[0].lopDays).toBe(2);
    }
  });

  it("updatePayslip recomputes gross/net and manages the auto LOP line", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow());
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [
        { key: "basic", label: "Basic Salary", amount: 6_500 },
        { key: "bonus", label: "Bonus", amount: 500 },
      ],
      deductions: [{ key: "tax", label: "Tax", amount: 100 }],
      lopDays: 2, // November: 7,000 × 2 / 30 = 466.67
      note: "Includes one-off bonus",
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as {
      data: { earnings: string; deductions: string; gross: number; net: number; lopDays: number };
    };
    expect(updateArg.data.gross).toBe(7_000);
    const deductions = JSON.parse(updateArg.data.deductions) as Array<{ key: string; amount: number }>;
    expect(deductions.find((l) => l.key === "lop")?.amount).toBeCloseTo(466.67, 2);
    expect(updateArg.data.net).toBeCloseTo(7_000 - 100 - 466.67, 2);
    expect(updateArg.data.lopDays).toBe(2);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.payslip_updated" }));
  });

  it("updatePayslip refuses a LOCKED run and duplicate line keys", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow({ run: LOCKED_RUN }));
    const locked = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0, earnings: [], deductions: [], lopDays: 0,
    });
    expect(locked.ok).toBe(false);

    db.payslip.findUnique.mockResolvedValue(payslipRow());
    const dup = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [
        { key: "basic", label: "A", amount: 1 },
        { key: "basic", label: "B", amount: 2 },
      ],
      deductions: [],
      lopDays: 0,
    });
    expect(dup.ok).toBe(false);
    expect(db.payslip.update).not.toHaveBeenCalled();
  });

  // F2.1 — settlement locks editing: a SETTLED full-and-final froze the
  // exit money the OPEN run's net feeds, so the payslip behind that number
  // is final even while the run itself is still OPEN.
  it("F2.1 — updatePayslip is refused for an employee with a SETTLED full-and-final", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow());
    db.fullAndFinalStatement.findFirst.mockResolvedValueOnce({ id: "fnf-1", status: "SETTLED" });
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0, earnings: [], deductions: [], lopDays: 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("full-and-final statement is settled");
    expect(db.payslip.update).not.toHaveBeenCalled();
  });

  it("F2.1 — addPayslip is refused for an employee with a SETTLED full-and-final", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, payslips: [] });
    db.payslip.findUnique.mockResolvedValue(null);
    db.fullAndFinalStatement.findFirst.mockResolvedValueOnce({ id: "fnf-1", status: "SETTLED" });
    const res = await addPayslip({ runId: "run-1", userId: "u-soren" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("settled");
    expect(db.payslip.create).not.toHaveBeenCalled();
  });

  it("updatePayslip rejects LOP days beyond the run period's day count (persona-audit P0 fix)", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow()); // run period 2026-11 → 30 days
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 31,
    });
    expect(res.ok).toBe(false);
    // F1.1 — the cap is now the run's working-day count when the run carries
    // one (this fixture run has none → calendar length fallback, but the
    // message says "working days" either way).
    if (!res.ok) expect(res.error).toMatch(/can't exceed the 30 working days of 2026-11/);
    expect(db.payslip.update).not.toHaveBeenCalled();
  });

  it("updatePayslip caps LOP days by the run's working-day count and divides by it (F1.1)", async () => {
    // A post-F1.1 run for 2026-11 with a holiday calendar behind it: 21
    // working days denormalized at creation.
    db.payslip.findUnique.mockResolvedValue(payslipRow({ run: { ...OPEN_RUN, workingDays: 21 } }));
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 1,
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as {
      data: { deductions: string; gross: number; net: number };
    };
    const lines = JSON.parse(updateArg.data.deductions) as Array<{ key: string; amount: number }>;
    const lop = lines.find((l) => l.key === "lop");
    // 6,700 × 1 / 21 = 319.05 — the holiday-aware denominator, not 30.
    expect(lop?.amount).toBe(319.05);
    expect(updateArg.data.net).toBe(6_380.95);

    // The cap uses the same denominator: 22 days in a 21-working-day period.
    const over = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 22,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/can't exceed the 21 working days of 2026-11/);
  });

  it("updatePayslip rejects a deduction set that would make net pay negative (persona-audit P0 fix)", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow());
    // gross 6,700 — LOP 30/30 = 6,700 plus a 500 manual line → net −500.
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [{ key: "adv", label: "Advance recovery", amount: 500 }],
      lopDays: 30,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/net pay can't be negative/);
    expect(db.payslip.update).not.toHaveBeenCalled();
  });

  it("F1.4 — changing lopDays flips lopSource to MANUAL and the audit records the override", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow({ lopDays: 2, lopSource: "AUTO" }));
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 3,
      note: "",
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as {
      data: { lopDays: number; lopSource: string };
    };
    expect(updateArg.data.lopDays).toBe(3);
    expect(updateArg.data.lopSource).toBe("MANUAL");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.payslip_updated",
      detail: expect.stringContaining("manually set — the auto-derived value was 2 days"),
    }));
  });

  it("F1.4 — saving the SAME lopDays keeps the existing provenance (AUTO stays AUTO, MANUAL stays MANUAL)", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow({ lopDays: 2, lopSource: "AUTO" }));
    const sameAuto = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 2,
      note: "",
    });
    expect(sameAuto.ok).toBe(true);
    expect((db.payslip.update.mock.calls[0][0] as { data: { lopSource: string } }).data.lopSource).toBe("AUTO");

    db.payslip.findUnique.mockResolvedValue(payslipRow({ lopDays: 2, lopSource: "MANUAL" }));
    const sameManual = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 2,
      note: "",
    });
    expect(sameManual.ok).toBe(true);
    expect((db.payslip.update.mock.calls[1][0] as { data: { lopSource: string } }).data.lopSource).toBe("MANUAL");
    // No override note in the audit — nothing changed.
    expect(logAuditMock).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "payroll.payslip_updated",
      detail: expect.not.stringContaining("manually set"),
    }));
  });

  it("F1.4 — half-day overrides pass validation and compute fractional LOP", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow({ run: { ...OPEN_RUN, workingDays: 21 } }));
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 1.5,
      note: "",
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as {
      data: { lopDays: number; lopSource: string; deductions: string };
    };
    expect(updateArg.data.lopDays).toBe(1.5);
    expect(updateArg.data.lopSource).toBe("MANUAL");
    // 6,700 × 1.5 / 21 = 478.57.
    const deductions = JSON.parse(updateArg.data.deductions) as Array<{ key: string; amount: number }>;
    expect(deductions.find((l) => l.key === "lop")?.amount).toBe(478.57);
  });

  it("F-R2 — a stale expectedVersion refuses the save, writes nothing, audits nothing", async () => {
    // Editor A loaded version 0; editor B saved first (version now 1).
    db.payslip.findUnique.mockResolvedValue(payslipRow({ version: 1, gross: 9_999, net: 9_999 }));
    db.payslip.update.mockClear();
    logAuditMock.mockClear();
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 0,
      note: "stale edit",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("saved by someone else");
      expect(res.error).toContain("PS-2026-11-001");
    }
    expect(db.payslip.update).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("F-R2 — a fresh save increments the version (the next editor must reload)", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow());
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 0,
      note: "",
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as { data: { version: number } };
    expect(updateArg.data.version).toBe(1);
    // The persisted row now carries version 1 — the second save on the same
    // stale expectation (editor A re-saving without reopening) is refused.
    db.payslip.findUnique.mockResolvedValue(payslipRow({ version: 1 }));
    const res2 = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 0,
      note: "",
    });
    expect(res2.ok).toBe(false);
  });

  it("F-R2 — expectedVersion is required (no silent last-write-wins fallback)", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow());
    const res = await updatePayslip({
      payslipId: "ps-1",
      earnings: [],
      deductions: [],
      lopDays: 0,
      note: "",
    });
    expect(res.ok).toBe(false);
    expect(db.payslip.update).not.toHaveBeenCalled();
  });

  it("PR-B07 (S4) — ABSENT mode charges unmarked working days at run creation; marks shield", async () => {
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "ABSENT" } });
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-yuki", jobTitle: "Data Engineer", department: "ENGINEERING", hireDate: new Date("2026-11-01T00:00:00Z"), lastWorkingDay: null },
    ]);
    // PRESENT on Nov 2–6 (5 working days) → 21 − 5 = 16 unmarked charge.
    db.attendanceRecord.findMany.mockResolvedValue(
      ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((date) => ({
        userId: "u-yuki", date: new Date(`${date}T00:00:00Z`), status: "PRESENT",
      })),
    );
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const created = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ userId: string; lopDays: number; lopSource: string }> } };
    };
    const slip = created.data.payslips.create.find((p: { userId: string }) => p.userId === "u-yuki");
    expect(slip?.lopDays).toBe(16);
    expect(slip?.lopSource).toBe("AUTO");
  });

  it("PR-B07 (S4) — IGNORED default keeps unmarked days at zero (zero-behavior change)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    db.attendanceRecord.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const created = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ userId: string; lopDays: number }> } };
    };
    expect(created.data.payslips.create.every((p: { lopDays: number }) => p.lopDays === 0)).toBe(true);
  });

  it("PR-B06 (S5) — a mid-month joiner's earnings scale to the employment window at run creation", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    // Hired Tue Nov 10 → paidDays 15 of 21: 6,500 → 4,642.86; 200 → 142.86.
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-yuki", jobTitle: "Data Engineer", department: "ENGINEERING", hireDate: new Date("2026-11-10T00:00:00Z"), lastWorkingDay: null },
    ]);
    db.attendanceRecord.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const created = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; paidDays: number; gross: number; net: number }> } };
    };
    const slip = created.data.payslips.create[0];
    expect(slip.paidDays).toBe(15);
    const lines = JSON.parse(slip.earnings) as Array<{ key: string; amount: number }>;
    expect(lines.find((l) => l.key === "basic")?.amount).toBe(4_642.86);
    expect(lines.find((l) => l.key === "transport")?.amount).toBe(142.86);
    // gross = 4,642.86 + 142.86 = 4,785.72 (rounded per line, summed).
    expect(slip.gross).toBe(4_785.72);
    expect(slip.net).toBe(4_785.72);
  });

  it("PR-B06 (S5) — a mid-month leaver (LWD) scales too; LOP rides the scaled gross", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-yuki", jobTitle: "Data Engineer", department: "ENGINEERING", hireDate: null, lastWorkingDay: new Date("2026-11-06T00:00:00Z") },
    ]);
    // One ABSENT day inside the window (Nov 4).
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-11-04T00:00:00Z"), status: "ABSENT" },
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const created = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ paidDays: number; lopDays: number; deductions: string; net: number }> } };
    };
    const slip = created.data.payslips.create[0];
    expect(slip.paidDays).toBe(5);
    expect(slip.lopDays).toBe(1);
    // Scaled gross = 6,700 × 5/21 = 1,595.24; LOP line = 1,595.24 × 1/21 = 75.96.
    const deductions = JSON.parse(slip.deductions) as Array<{ key: string; amount: number }>;
    expect(deductions.find((l) => l.key === "lop")?.amount).toBe(75.96);
    expect(slip.net).toBe(1_519.28);
  });

  it("PR-B06 (S5) — updatePayslip caps LOP at the PAID days of a clipped slip", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow({
      paidDays: 5,
      earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 4_642.86 }]),
      deductions: "[]",
      gross: 4_642.86, net: 4_642.86,
      run: { ...OPEN_RUN, workingDays: 21 },
    }));
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [{ key: "basic", label: "Basic Salary", amount: 4_642.86 }],
      deductions: [],
      lopDays: 6, // > 5 paid days
      note: "",
    });
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("can't exceed the 5 paid days");
    expect(res.error).toContain("clipped to the employment window");
  });

  it("PR-B06 (S5) — addPayslip scales a mid-period joiner (pre-join days are no longer manual)", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, workingDays: 21 });
    db.payslip.findUnique.mockResolvedValue(null);
    db.payslip.count.mockResolvedValue(3);
    db.salaryStructure.findFirst.mockResolvedValue(STRUCTURE_ROW);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-yuki", jobTitle: "Data Engineer", department: "ENGINEERING", hireDate: new Date("2026-11-16T00:00:00Z"), lastWorkingDay: null },
    ]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    db.attendanceRecord.findMany.mockResolvedValue([]);
    const res = await addPayslip({ runId: "run-1", userId: "u-yuki" });
    expect(res.ok).toBe(true);
    const createArg = db.payslip.create.mock.calls[0][0] as { data: { paidDays: number; gross: number; earnings: string } };
    // Hired Mon Nov 16 → paidDays 11 of 21 → gross 6,700 × 11/21 = 3,509.52.
    expect(createArg.data.paidDays).toBe(11);
    expect(createArg.data.gross).toBe(3_509.52);
  });

  it("PR-B02 (S6) — a window-exempt line stays flat and out of the LOP basis at run creation", async () => {
    db.salaryStructure.findMany.mockResolvedValue([{
      ...STRUCTURE_ROW,
      components: JSON.stringify([
        ...COMPONENTS,
        { key: "car", label: "Car Allowance", kind: "EARNING", mode: "FIXED", amount: 3_600, dependsOnPaymentDays: false },
      ]),
    }]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    // LWD Fri Nov 6 → paidDays 5 of 21.
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-yuki", jobTitle: "Data Engineer", department: "ENGINEERING", hireDate: null, lastWorkingDay: new Date("2026-11-06T00:00:00Z") },
    ]);
    // One ABSENT day (Nov 4) inside the window.
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-11-04T00:00:00Z"), status: "ABSENT" },
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const created = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; deductions: string; gross: number; net: number }> } };
    };
    const slip = created.data.payslips.create[0];
    const lines = JSON.parse(slip.earnings) as Array<{ key: string; amount: number; dependsOnPaymentDays?: boolean }>;
    // Day-scaled: 6,500 × 5/21 = 1,547.62; 200 × 5/21 = 47.62.
    expect(lines.find((l) => l.key === "basic")?.amount).toBe(1_547.62);
    expect(lines.find((l) => l.key === "transport")?.amount).toBe(47.62);
    // Exempt: flat 300 (3,600/12) with the sparse snapshot flag.
    const car = lines.find((l) => l.key === "car");
    expect(car?.amount).toBe(300);
    expect(car?.dependsOnPaymentDays).toBe(false);
    // gross = 1,547.62 + 47.62 + 300 = 1,895.24.
    expect(slip.gross).toBe(1_895.24);
    // LOP basis = day-scaled lines only (1,595.24) × 1/21 = 75.96.
    const deductions = JSON.parse(slip.deductions) as Array<{ key: string; amount: number }>;
    expect(deductions.find((l) => l.key === "lop")?.amount).toBe(75.96);
    expect(slip.net).toBe(1_819.28);
  });

  it("PR-B02 (S6) — updatePayslip computes the LOP line on the day-scaled basis only", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow({
      run: { ...OPEN_RUN, workingDays: 21 },
      earnings: JSON.stringify([
        { key: "basic", label: "Basic Salary", amount: 6_500 },
        { key: "car", label: "Car Allowance", amount: 300, dependsOnPaymentDays: false },
      ]),
    }));
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [
        { key: "basic", label: "Basic Salary", amount: 6_500 },
        { key: "car", label: "Car Allowance", amount: 300, dependsOnPaymentDays: false },
      ],
      deductions: [],
      lopDays: 2,
      note: "",
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as { data: { deductions: string } };
    const deductions = JSON.parse(updateArg.data.deductions) as Array<{ key: string; amount: number }>;
    // LOP = 6,500 (basis) × 2 / 21 = 619.05 — NOT 6,800 × 2 / 21.
    expect(deductions.find((l) => l.key === "lop")?.amount).toBe(619.05);
  });

  it("PR-B23 (S7) — ROUND_NET_NEAREST appends the auto rounding line so net lands whole", async () => {
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED", payrollRoundingMode: "ROUND_NET_NEAREST" } });
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    db.attendanceRecord.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const created = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; gross: number; net: number }> } };
    };
    const slip = created.data.payslips.create[0];
    // 6,700.00 is already whole — no rounding line, byte-identical default
    // path for whole-dollar slips.
    const lines = JSON.parse(slip.earnings) as Array<{ key: string }>;
    expect(lines.some((l) => l.key === "rounding")).toBe(false);
    expect(slip.net).toBe(6_700);

    // December run with a half-day LOP: 23 working days → 6,700 × 0.5/23
    // = 145.65 docked → net 6,554.35 → rounding line −0.35 (deduction side),
    // final net 6,554.00.
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-12-02T00:00:00Z"), status: "HALF_DAY" },
    ]);
    const res2 = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res2.ok).toBe(true);
    // The SECOND create call is the December run.
    const created2 = db.payrollRun.create.mock.calls[1][0] as {
      data: { payslips: { create: Array<{ earnings: string; deductions: string; net: number }> } };
    };
    const slip2 = created2.data.payslips.create[0];
    const deductions2 = JSON.parse(slip2.deductions) as Array<{ key: string; amount: number }>;
    expect(deductions2.find((l) => l.key === "rounding")?.amount).toBe(0.35);
    expect(slip2.net).toBe(6_554);
  });

  it("PR-B03 (S8) — statistical structure lines reach the payslip as info rows, money unchanged", async () => {
    db.salaryStructure.findMany.mockResolvedValue([{
      ...STRUCTURE_ROW,
      components: JSON.stringify([
        ...COMPONENTS,
        { key: "package_note", label: "Total package", kind: "STATISTICAL", mode: "FIXED", amount: 120_000 },
      ]),
    }]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    db.attendanceRecord.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const created = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; gross: number; net: number }> } };
    };
    const slip = created.data.payslips.create[0];
    const lines = JSON.parse(slip.earnings) as Array<{ key: string; statistical?: boolean }>;
    const note = lines.find((l) => l.key === "package_note");
    expect(note?.statistical).toBe(true);
    // Money unchanged: 6,700 gross/net as without the info line.
    expect(slip.gross).toBe(6_700);
    expect(slip.net).toBe(6_700);
  });

  it("PR-B03 (S8) — updatePayslip preserves the stored statistical lines (never editable)", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow({
      earnings: JSON.stringify([
        { key: "basic", label: "Basic Salary", amount: 6_500 },
        { key: "transport", label: "Transport Allowance", amount: 200 },
        { key: "package_note", label: "Total package", amount: 10_000, statistical: true },
      ]),
    }));
    const res = await updatePayslip({
      payslipId: "ps-1", expectedVersion: 0,
      earnings: [
        { key: "basic", label: "Basic Salary", amount: 6_500 },
        { key: "transport", label: "Transport Allowance", amount: 200 },
      ],
      deductions: [],
      lopDays: 0,
      note: "",
    });
    expect(res.ok).toBe(true);
    const updateArg = db.payslip.update.mock.calls[0][0] as { data: { earnings: string } };
    const lines = JSON.parse(updateArg.data.earnings) as Array<{ key: string; statistical?: boolean }>;
    expect(lines.find((l) => l.key === "package_note")?.statistical).toBe(true);
    expect(lines.filter((l) => !l.statistical)).toHaveLength(2);
  });

  it("addPayslip appends a mid-period joiner with the next slip number", async () => {
    db.payrollRun.findUnique.mockResolvedValue(OPEN_RUN);
    db.payslip.findUnique.mockResolvedValue(null);
    db.payslip.count.mockResolvedValue(3);
    db.salaryStructure.findFirst.mockResolvedValue(STRUCTURE_ROW);
    const res = await addPayslip({ runId: "run-1", userId: "u-yuki" });
    expect(res.ok).toBe(true);
    const createArg = db.payslip.create.mock.calls[0][0] as { data: { slipNo: string; gross: number } };
    expect(createArg.data.slipNo).toBe("PS-2026-11-004");
    expect(createArg.data.gross).toBe(6_700);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.payslip_added" }));
  });

  it("F1.4 — addPayslip derives the joiner's LOP from the period's attendance facts", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, workingDays: 21 });
    db.payslip.findUnique.mockResolvedValue(null);
    db.payslip.count.mockResolvedValue(3);
    db.salaryStructure.findFirst.mockResolvedValue(STRUCTURE_ROW);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-11-02T00:00:00.000Z"), status: "ABSENT" },
    ]);
    const res = await addPayslip({ runId: "run-1", userId: "u-yuki" });
    expect(res.ok).toBe(true);
    const createArg = db.payslip.create.mock.calls[0][0] as {
      data: { lopDays: number; lopSource: string; deductions: string };
    };
    expect(createArg.data.lopDays).toBe(1);
    expect(createArg.data.lopSource).toBe("AUTO");
    // 6,700 × 1 / 21 = 319.05 — the run's holiday-aware denominator.
    const deductions = JSON.parse(createArg.data.deductions) as Array<{ key: string; amount: number }>;
    expect(deductions.find((l) => l.key === "lop")?.amount).toBe(319.05);
  });

  it("addPayslip refuses duplicates, locked runs and structure-less employees", async () => {
    db.payrollRun.findUnique.mockResolvedValue(OPEN_RUN);
    db.payslip.findUnique.mockResolvedValue({ id: "existing" });
    const dup = await addPayslip({ runId: "run-1", userId: "u-yuki" });
    expect(dup.ok).toBe(false);

    db.payslip.findUnique.mockResolvedValue(null);
    db.payrollRun.findUnique.mockResolvedValue(LOCKED_RUN);
    const locked = await addPayslip({ runId: "run-0", userId: "u-yuki" });
    expect(locked.ok).toBe(false);

    db.payrollRun.findUnique.mockResolvedValue(OPEN_RUN);
    db.salaryStructure.findFirst.mockResolvedValue(null);
    const noStructure = await addPayslip({ runId: "run-1", userId: "u-yuki" });
    expect(noStructure.ok).toBe(false);
    expect(db.payslip.create).not.toHaveBeenCalled();
  });

  it("lockPayrollRun freezes the period with the payer + total in the audit", async () => {
    db.payrollRun.findUnique.mockResolvedValue({
      ...OPEN_RUN,
      payslips: [{ net: 6_700 }, { net: 3_300 }],
    });
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(db.payrollRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "LOCKED", lockedById: "u-hr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_locked",
      detail: expect.stringContaining("$10,000"),
    }));
  });

  it("lockPayrollRun refuses an already-locked or empty run", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...LOCKED_RUN, payslips: [{ net: 1 }] });
    const locked = await lockPayrollRun({ runId: "run-0" });
    expect(locked.ok).toBe(false);

    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, payslips: [] });
    const empty = await lockPayrollRun({ runId: "run-1" });
    expect(empty.ok).toBe(false);
    expect(db.payrollRun.update).not.toHaveBeenCalled();
  });

  it("P5 (F3.2) — locking accrues ACTIVE benefit elections (annual ÷ 12, paid-days-scaled)", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, payslips: [{ net: 6_700 }] });
    db.benefitElection.findMany.mockResolvedValue([
      { id: "be-1", userId: "u-yuki", year: 2026, componentCode: "HEALTH", label: "Health insurance", annualAmount: 1_200, status: "ACTIVE", createdById: "u-hr", createdAt: new Date(), updatedAt: new Date() },
    ]);
    db.payslip.findMany.mockResolvedValue([{ userId: "u-yuki", paidDays: 22 }]);
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(db.benefitAccrual.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-yuki", year: 2026, componentCode: "HEALTH",
          entryType: "ACCRUAL", delta: 100, sourceId: "run-1",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.benefits_accrued",
      detail: expect.stringContaining("1 benefit row(s)"),
    }));
  });

  it("P2 (LV-09) — locking flips the run's consumed ENCASHMENT adjustments' source rows PAID, in the same transaction", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, payslips: [{ net: 6_700 }] });
    db.payAdjustment.findMany.mockResolvedValue([
      { sourceId: "enc-1" },
      { sourceId: "enc-2" },
      { sourceId: "" }, // a MANUAL row riding the run — no encashment flip
    ]);
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(db.leaveEncashment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["enc-1", "enc-2"] }, status: "APPROVED" },
        data: expect.objectContaining({ status: "PAID", paidRunId: "run-1" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_locked",
      detail: expect.stringContaining("2 leave encashment(s) marked paid"),
    }));
  });
});

describe("P0-1 — payslip self-service (getMyPayslips, persona-audit D-02)", () => {
  const LOCKED_RUN_SEPT = { id: "run-sept", period: "2026-09", status: "LOCKED" };

  it("requires a session but NO permission — a MEMBER session is enough", async () => {
    getSessionOrThrowMock.mockRejectedValue(new Error("You must be signed in."));
    const anon = await getMyPayslips();
    expect(anon.ok).toBe(false);

    getSessionOrThrowMock.mockResolvedValue({ userId: "u-yuki", role: "MEMBER", name: "Yuki Tanaka", email: "yuki@x.co" });
    db.payslip.findMany.mockResolvedValue([]);
    db.employeeProfile.findUnique.mockResolvedValue({ jobTitle: "Data Engineer" });
    const member = await getMyPayslips();
    expect(member.ok).toBe(true);
    if (member.ok) expect(member.data).toEqual([]);
    // The self-service read must never consult payroll:manage — it is the
    // caller's own data, so a MEMBER must not be blocked by the ADMIN+HR gate.
    expect(requirePermissionMock).not.toHaveBeenCalled();
  });

  it("scopes the query to the caller's own payslips in LOCKED runs only", async () => {
    db.payslip.findMany.mockResolvedValue([
      { ...payslipRow({ id: "ps-oct", runId: "run-0", slipNo: "PS-2026-10-002", run: LOCKED_RUN }) },
    ]);
    db.employeeProfile.findUnique.mockResolvedValue({ jobTitle: "Data Engineer" });
    const res = await getMyPayslips();
    expect(res.ok).toBe(true);
    expect(db.payslip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "u-yuki", run: { status: "LOCKED" } },
    }));
  });

  it("maps newest-first with running YTD per calendar year on the locked-only basis", async () => {
    // Simulates the DB honouring the LOCKED filter: Sep/Oct 2026 + Dec 2025
    // locked slips. The OPEN November draft is not in the result set at all.
    db.payslip.findMany.mockResolvedValue([
      payslipRow({ id: "ps-25-12", runId: "run-dec25", slipNo: "PS-2025-12-001", net: 5_000, gross: 5_000, run: { id: "run-dec25", period: "2025-12", status: "LOCKED" } }),
      payslipRow({ id: "ps-26-09", runId: "run-sept", slipNo: "PS-2026-09-001", net: 6_500, gross: 6_500, run: LOCKED_RUN_SEPT }),
      payslipRow({ id: "ps-26-10", runId: "run-0", slipNo: "PS-2026-10-002", net: 6_700, gross: 6_700, run: LOCKED_RUN }),
    ]);
    db.employeeProfile.findUnique.mockResolvedValue({ jobTitle: "Data Engineer" });
    const res = await getMyPayslips();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((p) => p.runPeriod)).toEqual(["2026-10", "2026-09", "2025-12"]);
    // YTD restarts each calendar year and accumulates ascending:
    //   2025: Dec = 5,000 | 2026: Sep = 6,500, Oct = 13,200.
    const byPeriod = new Map(res.data.map((p) => [p.runPeriod, p.ytdNet] as const));
    expect(byPeriod.get("2025-12")).toBe(5_000);
    expect(byPeriod.get("2026-09")).toBe(6_500);
    expect(byPeriod.get("2026-10")).toBe(13_200);
    // P11 — gross YTD alongside the net; MTD resets with each calendar
    // month (Sep and Oct are separate months, so each is its own MTD).
    const byGross = new Map(res.data.map((p) => [p.runPeriod, p.ytdGross] as const));
    expect(byGross.get("2026-10")).toBe(13_200);
    const byMtd = new Map(res.data.map((p) => [p.runPeriod, p.mtdNet] as const));
    expect(byMtd.get("2026-09")).toBe(6_500);
    expect(byMtd.get("2026-10")).toBe(6_700);
    // Component YTD rows ride every slip (the payslipRow default lines are
    // basic + transport on the earnings side).
    const oct = res.data.find((p) => p.runPeriod === "2026-10");
    expect(oct?.componentYtd.find((r) => r.key === "basic")?.amount).toBe(13_000);
    expect(oct?.componentYtd.find((r) => r.key === "transport")?.amount).toBe(400);
    // Every mapped slip is a LOCKED record with the caller's own identity.
    for (const p of res.data) {
      expect(p.runStatus).toBe("LOCKED");
      expect(p.userId).toBe("u-yuki");
      expect(p.userName).toBe("Yuki Tanaka");
      expect(p.jobTitle).toBe("Data Engineer");
    }
  });

  it("survives a missing employee profile (empty job title, not an error)", async () => {
    db.payslip.findMany.mockResolvedValue([
      payslipRow({ id: "ps-oct", runId: "run-0", slipNo: "PS-2026-10-002", run: LOCKED_RUN }),
    ]);
    db.employeeProfile.findUnique.mockResolvedValue(null);
    const res = await getMyPayslips();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data[0].jobTitle).toBe("");
  });
});

// ---------------------------------------------------------------------------
// P1 (PR-12/PR-B10, F2.3) — the PayAdjustment universal adapter
// ---------------------------------------------------------------------------

function adjustmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "adj-1",
    userId: "u-yuki",
    sourceType: "MANUAL",
    sourceId: "",
    componentCode: "",
    label: "Q4 bonus",
    side: "EARNING",
    recurrence: "ONE_SHOT",
    calcMode: "FIXED",
    percent: null,
    amount: 800,
    period: "2026-12",
    endPeriod: null,
    lastConsumedPeriod: "",
    status: "PENDING",
    skipReason: "",
    note: "",
    createdById: "u-hr",
    consumedRunId: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("P1 — createPayAdjustment (the manual writer)", () => {
  it("requires payroll:manage", async () => {
    requirePermissionMock.mockRejectedValueOnce(new Error("denied"));
    const res = await createPayAdjustment({ userId: "u-yuki", side: "EARNING", period: "2026-12", amount: 500 });
    expect(res.ok).toBe(false);
  });

  it("creates a well-formed ONE_SHOT FIXED earning and audits it", async () => {
    const res = await createPayAdjustment({
      userId: "u-yuki", side: "EARNING", period: "2026-12", amount: 500, label: "Q4 bonus",
    });
    expect(res.ok).toBe(true);
    const createArg = db.payAdjustment.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data).toMatchObject({
      userId: "u-yuki", sourceType: "MANUAL", side: "EARNING", recurrence: "ONE_SHOT",
      calcMode: "FIXED", amount: 500, period: "2026-12",
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.adjustment_created" }));
  });

  it("refuses a percent-of-net EARNING (deduction-only mode, kernel rule shared with the UI)", async () => {
    const res = await createPayAdjustment({
      userId: "u-yuki", side: "EARNING", calcMode: "PERCENT_OF_NET", percent: 5, period: "2026-12",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("deduction-only");
    expect(db.payAdjustment.create).not.toHaveBeenCalled();
  });

  it("refuses a target period whose run is already LOCKED (paid runs take no new inputs)", async () => {
    db.payrollRun.findUnique.mockResolvedValueOnce({ status: "LOCKED" });
    const res = await createPayAdjustment({
      userId: "u-yuki", side: "EARNING", period: "2026-10", amount: 500, label: "X",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already locked");
  });

  it("refuses an unknown employee", async () => {
    db.user.findUnique.mockResolvedValueOnce(null);
    // (A label is required too — without one the schema gate fires BEFORE
    // the employee lookup and the once-mock leaks into the next test.)
    const res = await createPayAdjustment({ userId: "u-ghost", side: "EARNING", period: "2026-12", amount: 5, label: "Ghost pay" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Employee not found/i);
  });
});

describe("P1 — createPayrollRun consumes the adapter transactionally", () => {
  it("a ONE_SHOT earning lands on its employee's slip and flips the row CONSUMED", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.payAdjustment.findMany.mockResolvedValue([adjustmentRow()]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.adjustmentsApplied).toBe(1);
      expect(res.data.adjustmentsSkipped).toBe(0);
    }
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ userId: string; earnings: string; gross: number; net: number }> } };
    };
    const slip = createArg.data.payslips.create[0];
    const lines = JSON.parse(slip.earnings);
    expect(lines.find((l: { key: string }) => l.key === "adj:adj-1")).toMatchObject({
      label: "Q4 bonus", amount: 800,
    });
    expect(slip.gross).toBe(6_700 + 800);
    expect(slip.net).toBe(6_700 + 800);
    // The row update rode the same transaction (tx === db in the mock).
    expect(db.payAdjustment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "adj-1" },
        data: expect.objectContaining({ status: "CONSUMED", lastConsumedPeriod: "2026-12", consumedRunId: "run-new" }),
      }),
    );
  });

  it("a RECURRING row consumed before its endPeriod watermarks but stays PENDING; final period flips CONSUMED", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    const recurring = adjustmentRow({
      id: "adj-r", recurrence: "RECURRING", period: "2026-10", endPeriod: "2027-02", amount: 50,
    });
    db.payAdjustment.findMany.mockResolvedValue([recurring]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res.ok).toBe(true);
    expect(db.payAdjustment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "adj-r" },
        data: expect.objectContaining({ status: "PENDING", lastConsumedPeriod: "2026-12", consumedRunId: "run-new" }),
      }),
    );
    // Final period: endPeriod === consumption period → CONSUMED.
    db.payAdjustment.update.mockClear();
    db.payrollRun.findUnique.mockResolvedValue(null);
    const final = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2027-02-01" });
    expect(final.ok).toBe(true);
    expect(db.payAdjustment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "adj-r" },
        data: expect.objectContaining({ status: "CONSUMED", lastConsumedPeriod: "2027-02" }),
      }),
    );
  });

  it("a due row whose employee has NO slip in the run is SKIPPED with a reason (RECURRING stays PENDING)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]); // u-yuki only
    db.payAdjustment.findMany.mockResolvedValue([
      adjustmentRow({ id: "adj-ghost", userId: "u-elsewhere", amount: 100 }),
      adjustmentRow({ id: "adj-rec", userId: "u-elsewhere", recurrence: "RECURRING", period: "2026-10", endPeriod: null }),
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.adjustmentsSkipped).toBe(1);
    expect(db.payAdjustment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "adj-ghost" },
        data: expect.objectContaining({ status: "SKIPPED", skipReason: expect.stringContaining("no payslip") }),
      }),
    );
    // The RECURRING row was never touched — future periods may include them.
    const touched = db.payAdjustment.update.mock.calls.map((c: Array<{ where: { id: string } }>) => c[0].where.id);
    expect(touched).not.toContain("adj-rec");
  });

  it("PERCENT_OF_NET deduction resolves on the slip's post-LOP running net", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-12-07T00:00:00.000Z"), status: "ABSENT" },
    ]);
    db.payAdjustment.findMany.mockResolvedValue([
      adjustmentRow({
        id: "adj-net", label: "Net levy", side: "DEDUCTION", calcMode: "PERCENT_OF_NET", percent: 10, amount: 0,
      }),
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { workingDays: number; payslips: { create: Array<{ earnings: string; deductions: string; net: number }> } };
    };
    const deductions = JSON.parse(createArg.data.payslips.create[0].deductions);
    // December 2026: 23 Mon–Fri days; 1 ABSENT → LOP = 6700 × 1/23 ≈ 291.30;
    // net after LOP = 6408.70 → levy = 640.87.
    expect(deductions.find((l: { key: string }) => l.key === "lop")?.amount).toBeCloseTo(291.3, 2);
    expect(deductions.find((l: { key: string }) => l.key === "adj:adj-net")?.amount).toBeCloseTo(640.87, 2);
    expect(createArg.data.payslips.create[0].net).toBeCloseTo(5767.83, 2);
  });

  it("an empty adapter table keeps run creation byte-identical (zero-behavior change)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.adjustmentsApplied).toBe(0);
    expect(db.payAdjustment.update).not.toHaveBeenCalled();
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; gross: number }> } };
    };
    expect(JSON.parse(createArg.data.payslips.create[0].earnings)).toHaveLength(2);
    expect(createArg.data.payslips.create[0].gross).toBe(6_700);
  });
});

describe("P1 — addPayslip consumes the joiner's due adjustments", () => {
  it("the joiner's ONE_SHOT rows land on the new slip in the same transaction", async () => {
    db.payrollRun.findUnique.mockResolvedValue(OPEN_RUN);
    db.salaryStructure.findFirst.mockResolvedValue(STRUCTURE_ROW);
    db.fullAndFinalStatement.findFirst.mockResolvedValue(null);
    db.payslip.findUnique.mockResolvedValue(null);
    db.payslip.count.mockResolvedValue(3);
    db.payAdjustment.findMany.mockResolvedValue([adjustmentRow({ period: "2026-11" })]);
    const res = await addPayslip({ runId: "run-1", userId: "u-yuki" });
    expect(res.ok).toBe(true);
    const createArg = db.payslip.create.mock.calls[0][0] as { data: { earnings: string; gross: number } };
    const lines = JSON.parse(createArg.data.earnings);
    expect(lines.find((l: { key: string }) => l.key === "adj:adj-1")?.amount).toBe(800);
    expect(createArg.data.gross).toBe(7_500);
    expect(db.payAdjustment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "adj-1" },
        data: expect.objectContaining({ status: "CONSUMED", consumedRunId: "run-1" }),
      }),
    );
  });
});

describe("P1 — applyPayAdjustmentsToRun (the explicit OPEN-run application)", () => {
  it("applies pending rows onto stored lines, bumps versions, and re-derives rounding", async () => {
    db.payrollRun.findUnique.mockResolvedValue(OPEN_RUN);
    db.payslip.findMany.mockResolvedValue([
      payslipRow({ id: "ps-1", version: 2, earnings: JSON.stringify([
        { key: "basic", label: "Basic Salary", amount: 6_500 },
        { key: "transport", label: "Transport Allowance", amount: 200 },
      ]) }),
    ]);
    db.payAdjustment.findMany.mockResolvedValue([adjustmentRow({ period: "2026-11" })]);
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { payrollRoundingMode: "ROUND_NET_NEAREST" } });
    const res = await applyPayAdjustmentsToRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.applied).toBe(1);
      expect(res.data.slipsTouched).toBe(1);
    }
    const updateArg = db.payslip.update.mock.calls[0][0] as {
      where: { id: string };
      data: { earnings: string; deductions: string; gross: number; net: number; version: number };
    };
    expect(updateArg.where.id).toBe("ps-1");
    expect(updateArg.data.version).toBe(3);
    expect(updateArg.data.gross).toBe(7_500);
    // ROUND_NET_NEAREST: 7500 is already whole — no rounding line.
    expect(JSON.parse(updateArg.data.deductions)).toHaveLength(0);
    expect(db.payAdjustment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "adj-1" }, data: expect.objectContaining({ status: "CONSUMED" }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.adjustments_applied" }));
  });

  it("refuses a LOCKED run (paid slips are immutable)", async () => {
    db.payrollRun.findUnique.mockResolvedValue(LOCKED_RUN);
    const res = await applyPayAdjustmentsToRun({ runId: "run-0" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("locked");
  });

  it("no pending due rows → a clean no-op (nothing written, nothing audited)", async () => {
    db.payrollRun.findUnique.mockResolvedValue(OPEN_RUN);
    db.payAdjustment.findMany.mockResolvedValue([]);
    const res = await applyPayAdjustmentsToRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ applied: 0, skipped: 0, slipsTouched: 0 });
    expect(db.payslip.update).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.adjustments_applied" }));
  });
});

describe("P1 — listPayAdjustments", () => {
  it("serializes names, statuses and the consuming run's period", async () => {
    db.payAdjustment.findMany.mockResolvedValue([
      adjustmentRow({ id: "adj-9", consumedRunId: "run-9", status: "CONSUMED" }),
    ]);
    db.payrollRun.findMany.mockResolvedValue([{ id: "run-9", period: "2026-12" }]);
    const res = await listPayAdjustments();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        id: "adj-9", userName: "Yuki Tanaka", status: "CONSUMED", consumedRunPeriod: "2026-12",
        side: "EARNING", recurrence: "ONE_SHOT", calcMode: "FIXED",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// P8 (PR-19/PR-B13, F3.3) — ACTIVE hold windows stamp slips WITHHELD at
// creation; YTD excludes withheld/released nets.
// ---------------------------------------------------------------------------

describe("P8 — createPayrollRun stamps WITHHELD slips inside an ACTIVE hold window", () => {
  it("a slip whose employee is held in the period is born WITHHELD; others stay normal", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.salaryWithholding.findMany.mockResolvedValue([
      { userId: "u-yuki", fromPeriod: "2026-11", untilPeriod: "2027-01", status: "ACTIVE" },
      { userId: "u-elsewhere", fromPeriod: "2026-01", untilPeriod: "2026-02", status: "ACTIVE" }, // window closed
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ userId: string; withholdStatus: string }> } };
    };
    expect(createArg.data.payslips.create[0].withholdStatus).toBe("WITHHELD");
  });

  it("a period outside every window stays unstamped", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.salaryWithholding.findMany.mockResolvedValue([
      { userId: "u-yuki", fromPeriod: "2026-11", untilPeriod: "2026-11", status: "ACTIVE" },
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2027-06-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ withholdStatus: string }> } };
    };
    expect(createArg.data.payslips.create[0].withholdStatus).toBe("");
  });

  it("the YTD basis excludes withheld/released slips (money counts once, at release)", async () => {
    db.payrollRun.findUnique.mockResolvedValue({
      ...OPEN_RUN,
      payslips: [payslipRow({ id: "ps-held", withholdStatus: "WITHHELD" })],
    });
    db.payrollRun.findMany.mockResolvedValue([
      { id: "run-0", period: "2026-11", startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-30T00:00:00Z") },
      { id: "run-1", period: "2026-12", startDate: new Date("2026-12-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z") },
    ]);
    // The mock mirrors the DB: the kernel sees BOTH slips (any withhold
    // status) — the held December one carries the last paid values forward
    // instead of accumulating.
    db.payslip.findMany.mockResolvedValue([
      { id: "ps-nov", userId: "u-yuki", slipNo: "PS-2026-11-001", runId: "run-0", gross: 6_700, net: 6_700, withholdStatus: "", earnings: "[]", deductions: "[]" },
      { id: "ps-held", userId: "u-yuki", slipNo: "PS-2026-12-001", runId: "run-1", gross: 6_700, net: 6_700, withholdStatus: "WITHHELD", earnings: "[]", deductions: "[]" },
    ]);
    const res = await getPayrollRun("run-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.payslips[0].withholdStatus).toBe("WITHHELD");
      expect(res.data.payslips[0].ytdNet).toBe(6_700); // the held net never counts — the November value carries forward
      expect(res.data.payslips[0].mtdNet).toBe(0); // a held month pays nothing so far
    }
  });

  it("getMyPayslips — a held slip lists (badged) but never adds to YTD; a released one pays where it released", async () => {
    db.payslip.findMany.mockResolvedValue([
      payslipRow({ id: "ps-oct", runId: "run-0", slipNo: "PS-2026-10-002", net: 6_700, gross: 6_700, run: LOCKED_RUN }),
      payslipRow({ id: "ps-nov", runId: "run-1", slipNo: "PS-2026-11-001", net: 6_700, gross: 6_700, withholdStatus: "WITHHELD", run: { ...LOCKED_RUN, period: "2026-11" } }),
      payslipRow({ id: "ps-dec", runId: "run-2", slipNo: "PS-2026-12-001", net: 6_700, gross: 6_700, withholdStatus: "RELEASED", run: { ...LOCKED_RUN, period: "2026-12" } }),
    ]);
    db.employeeProfile.findUnique.mockResolvedValue({ jobTitle: "Data Engineer" });
    const res = await getMyPayslips();
    expect(res.ok).toBe(true);
    if (res.ok) {
      const byPeriod = new Map(res.data.map((p) => [p.runPeriod, p.ytdNet] as const));
      expect(byPeriod.get("2026-10")).toBe(6_700);
      expect(byPeriod.get("2026-11")).toBe(6_700); // held: carries the last paid value
      expect(byPeriod.get("2026-12")).toBe(6_700); // released: its money pays at release, not here
      expect(res.data.find((p) => p.runPeriod === "2026-11")?.withholdStatus).toBe("WITHHELD");
      expect(res.data.find((p) => p.runPeriod === "2026-12")?.withholdStatus).toBe("RELEASED");
    }
  });
});

// ---------------------------------------------------------------------------
// P9 (PR-B26, AT-09 lite) — the overtime → payslip bridge at run creation.
// ---------------------------------------------------------------------------

describe("P9 — createPayrollRun emits the Overtime earning line when the knob is on", () => {
  it("120 derived minutes price at gross ÷ working days ÷ 8h onto the slip", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    getWorkspaceConfigMock.mockResolvedValue({
      workspace: { unmarkedAttendanceMode: "IGNORED", payrollRoundingMode: "ROUND_2DP", overtimePayEnabled: true },
    });
    // The overtime query (where.overtimeMinutes) vs the LOP marks query
    // (where.status) — the mock honours the distinction the DB would.
    db.attendanceRecord.findMany.mockImplementation(
      async ({ where }: { where?: { overtimeMinutes?: unknown; status?: { in?: string[] } } }) =>
        where?.overtimeMinutes !== undefined
          ? [{ userId: "u-yuki", overtimeMinutes: 90 }, { userId: "u-yuki", overtimeMinutes: 30 }]
          : [],
    );
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ userId: string; earnings: string; gross: number; net: number }> } };
    };
    const slip = createArg.data.payslips.create[0];
    const lines = JSON.parse(slip.earnings) as Array<{ key: string; label: string; amount: number }>;
    const ot = lines.find((l) => l.key === "overtime");
    // STRUCTURE_ROW's monthly gross is 6,700 (78,000 + 2,400 annual ÷ 12);
    // December 2026 has 23 Mon–Fri days → rate 6,700/23/8 = 36.41; 2h → 72.82.
    expect(ot).toMatchObject({ amount: 72.82 });
    expect(ot?.label).toContain("2h");
    expect(ot?.label).toContain("$36.41/h");
    expect(slip.gross).toBe(6_700 + 72.82);
    expect(slip.net).toBe(6_700 + 72.82);
  });

  it("the knob off → byte-identical pre-P9 run creation (no overtime query)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    getWorkspaceConfigMock.mockResolvedValue({
      workspace: { unmarkedAttendanceMode: "IGNORED", payrollRoundingMode: "ROUND_2DP", overtimePayEnabled: false },
    });
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; gross: number }> } };
    };
    const slip = createArg.data.payslips.create[0];
    expect(JSON.parse(slip.earnings).some((l: { key: string }) => l.key === "overtime")).toBe(false);
    expect(slip.gross).toBe(6_700);
    // The disabled path never queries the overtime facts (only the LOP marks).
    const otQueries = db.attendanceRecord.findMany.mock.calls.filter(
      (c: Array<{ where?: { overtimeMinutes?: unknown } }>) => c[0]?.where?.overtimeMinutes !== undefined,
    );
    expect(otQueries).toHaveLength(0);
  });

  it("minutes without a computable rate produce NO line (never a fake zero)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    getWorkspaceConfigMock.mockResolvedValue({
      workspace: { unmarkedAttendanceMode: "IGNORED", payrollRoundingMode: "ROUND_2DP", overtimePayEnabled: true },
    });
    db.attendanceRecord.findMany.mockImplementation(
      async ({ where }: { where?: { overtimeMinutes?: unknown } }) =>
        where?.overtimeMinutes !== undefined ? [{ userId: "u-ghost", overtimeMinutes: 60 }] : [],
    );
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-12-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; gross: number }> } };
    };
    expect(JSON.parse(createArg.data.payslips.create[0].earnings).some((l: { key: string }) => l.key === "overtime")).toBe(false);
    expect(createArg.data.payslips.create[0].gross).toBe(6_700);
  });
});

// ---------------------------------------------------------------------------
// P10 (PR-B05) — payroll cadences: weekly/fortnightly/bimonthly/daily/
// quarterly/annual windows via the pure windows kernel; period keys stay
// unique; amounts = annual ÷ windowsInYear; structures are frequency-matched.
// ---------------------------------------------------------------------------
describe("P10 — payroll cadences (createPayrollRun)", () => {
  beforeEach(() => {
    db.payrollRun.findUnique.mockResolvedValue(null);
    db.payrollRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "run-p10",
      ...data,
      payslips: (((data.payslips as { create?: unknown[] } | undefined)?.create) ?? []).map((_: unknown, i: number) => ({ id: `ps-${i}` })),
    }));
  });

  it("creates a WEEKLY run: ISO-week key, 5-day window, amounts ÷ 53 (2026)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    // Mon 2026-11-09 sits in ISO week 46 (Nov 9 – Nov 15); 2026 has 53 weeks.
    const res = await createPayrollRun({ frequency: "WEEKLY", anchorDate: "2026-11-09" });
    expect(res.ok).toBe(true);

    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: {
        period: string; frequency: string; startDate: Date; endDate: Date; workingDays: number;
        payslips: { create: Array<{ slipNo: string; earnings: string; gross: number }> };
      };
    };
    expect(createArg.data.period).toBe("2026-W46");
    expect(createArg.data.frequency).toBe("WEEKLY");
    expect(createArg.data.startDate).toEqual(new Date("2026-11-09T00:00:00.000Z"));
    expect(createArg.data.endDate).toEqual(new Date("2026-11-15T00:00:00.000Z"));
    expect(createArg.data.workingDays).toBe(5); // Mon–Fri of the week
    // Only WEEKLY structures join a weekly run (frequency-matched).
    expect(db.salaryStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, frequency: "WEEKLY" } }),
    );
    const slips = createArg.data.payslips.create;
    expect(slips[0].slipNo).toBe("PS-2026-W46-001");
    // Annual ÷ 53: basic 78,000/53 = 1471.7; transport 2,400/53 = 45.28.
    const lines = JSON.parse(slips[0].earnings);
    expect(lines).toEqual([
      { key: "basic", label: "Basic Salary", amount: 1471.7 },
      { key: "transport", label: "Transport Allowance", amount: 45.28 },
    ]);
    expect(slips[0].gross).toBe(1516.98);
    // The attendance/LOP derivation reads the run's window, not a month.
    const attWhere = db.attendanceRecord.findMany.mock.calls[0][0].where;
    expect(attWhere.date.gte).toEqual(new Date("2026-11-09T00:00:00.000Z"));
    expect(attWhere.date.lte).toEqual(new Date("2026-11-15T00:00:00.000Z"));
  });

  it("creates the two BIMONTHLY halves with ÷ 24 amounts", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    const a = await createPayrollRun({ frequency: "BIMONTHLY", anchorDate: "2026-11-01" });
    expect(a.ok).toBe(true);
    let createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { period: string; startDate: Date; endDate: Date; payslips: { create: Array<{ earnings: string; gross: number }> } };
    };
    expect(createArg.data.period).toBe("2026-11-A");
    expect(createArg.data.startDate).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(createArg.data.endDate).toEqual(new Date("2026-11-15T00:00:00.000Z"));
    expect(JSON.parse(createArg.data.payslips.create[0].earnings)[0].amount).toBe(3250); // 78,000/24

    db.payrollRun.findUnique.mockResolvedValue(null);
    const b = await createPayrollRun({ frequency: "BIMONTHLY", anchorDate: "2026-11-30" });
    expect(b.ok).toBe(true);
    createArg = db.payrollRun.create.mock.calls[1][0] as typeof createArg;
    expect(createArg.data.period).toBe("2026-11-B");
    expect(createArg.data.startDate).toEqual(new Date("2026-11-16T00:00:00.000Z"));
    expect(createArg.data.endDate).toEqual(new Date("2026-11-30T00:00:00.000Z"));
  });

  it("creates DAILY and QUARTERLY and ANNUAL windows with the right divisors", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    const day = await createPayrollRun({ frequency: "DAILY", anchorDate: "2026-11-09" });
    expect(day.ok).toBe(true);
    let arg = db.payrollRun.create.mock.calls[0][0] as { data: { period: string; startDate: Date; endDate: Date; payslips: { create: Array<{ earnings: string }> } } };
    expect(arg.data.period).toBe("2026-11-09");
    expect(arg.data.startDate).toEqual(arg.data.endDate);
    // 78,000/365 = 213.70.
    expect(JSON.parse(arg.data.payslips.create[0].earnings)[0].amount).toBe(213.7);

    db.payrollRun.findUnique.mockResolvedValue(null);
    const q = await createPayrollRun({ frequency: "QUARTERLY", anchorDate: "2026-11-09" });
    expect(q.ok).toBe(true);
    arg = db.payrollRun.create.mock.calls[1][0] as typeof arg;
    expect(arg.data.period).toBe("2026-Q4");
    expect(JSON.parse(arg.data.payslips.create[0].earnings)[0].amount).toBe(19_500); // ÷ 4

    db.payrollRun.findUnique.mockResolvedValue(null);
    const annual = await createPayrollRun({ frequency: "ANNUAL", anchorDate: "2026-07-04" });
    expect(annual.ok).toBe(true);
    arg = db.payrollRun.create.mock.calls[2][0] as typeof arg;
    expect(arg.data.period).toBe("2026");
    expect(JSON.parse(arg.data.payslips.create[0].earnings)[0].amount).toBe(78_000); // ÷ 1
  });

  it("refuses a run when no structure matches the cadence", async () => {
    db.salaryStructure.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "FORTNIGHTLY", anchorDate: "2026-11-09" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("fortnightly");
    expect(db.payrollRun.create).not.toHaveBeenCalled();
  });

  it("refuses an impossible anchor date before any read", async () => {
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-02-30" });
    expect(res.ok).toBe(false);
    expect(db.payrollRun.findUnique).not.toHaveBeenCalled();
  });
});

describe("P10 — mixed-cadence self-service (getMyPayslips)", () => {
  it("orders slips by the run's REAL window end and attributes YTD by end year", async () => {
    // A weekly slip (W45: Nov 2–8), the November month slip and the December
    // month slip — lexicographic period order would put "2026-W45" LAST;
    // real time puts it first.
    db.payslip.findMany.mockResolvedValue([
      payslipRow({ id: "ps-w45", runId: "run-w45", slipNo: "PS-2026-W45-001", net: 1_515.09, gross: 1_515.09, run: { id: "run-w45", period: "2026-W45", status: "LOCKED", startDate: new Date("2026-11-02T00:00:00Z"), endDate: new Date("2026-11-08T00:00:00Z") } }),
      payslipRow({ id: "ps-nov", runId: "run-1", slipNo: "PS-2026-11-001", net: 6_700, gross: 6_700, run: { id: "run-1", period: "2026-11", status: "LOCKED", startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-30T00:00:00Z") } }),
      payslipRow({ id: "ps-dec", runId: "run-dec", slipNo: "PS-2026-12-001", net: 6_700, gross: 6_700, run: { id: "run-dec", period: "2026-12", status: "LOCKED", startDate: new Date("2026-12-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z") } }),
    ]);
    db.employeeProfile.findUnique.mockResolvedValue({ jobTitle: "Data Engineer" });
    const res = await getMyPayslips();
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Newest window end first: December, November, then the Nov 8 week.
      expect(res.data.map((p) => p.id)).toEqual(["ps-dec", "ps-nov", "ps-w45"]);
      // YTD is chronological: the week counts (1515.09), then November adds
      // 6,700 (8215.09), then December adds 6,700 (14915.09).
      expect(res.data.find((p) => p.id === "ps-w45")?.ytdNet).toBe(1515.09);
      expect(res.data.find((p) => p.id === "ps-nov")?.ytdNet).toBe(8215.09);
      expect(res.data.find((p) => p.id === "ps-dec")?.ytdNet).toBe(14915.09);
    }
  });
});

// ---------------------------------------------------------------------------
// P13 (PR-B14 / PR-09) — chunked batch processing with per-slip error
// isolation: the first 30 ride the run-creation transaction (byte-identical
// to the pre-P13 world); every slip beyond the 30th writes in its OWN
// transaction, isolated per slip — one failure never aborts the payroll,
// the summary is loud, the counts honest.
// ---------------------------------------------------------------------------
describe("P13 — chunked batch >30 with per-slip isolation", () => {
  const STRUCTURES_32 = Array.from({ length: 32 }, (_, i) => ({
    ...STRUCTURE_ROW,
    id: `ss-${i + 1}`,
    userId: `u-${i + 1}`,
  }));

  beforeEach(() => {
    db.payrollRun.findUnique.mockResolvedValue(null);
    db.payrollRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "run-p13",
      ...data,
      payslips: (((data.payslips as { create?: unknown[] } | undefined)?.create) ?? []).map((_: unknown, i: number) => ({ id: `ps-${i}` })),
    }));
    db.payslip.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ps-overflow", ...data }));
  });

  it("≤30 structures ride the single nested create — no overflow writes", async () => {
    db.salaryStructure.findMany.mockResolvedValue(STRUCTURES_32.slice(0, 30));
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { payslips: { create: unknown[] } } };
    expect(createArg.data.payslips.create).toHaveLength(30);
    // The overflow path never ran: no standalone payslip creates.
    expect(db.payslip.create).not.toHaveBeenCalled();
    if (res.ok) {
      expect(res.data.payslipCount).toBe(30);
      expect(res.data.failures).toEqual([]);
    }
  });

  it(">30: the first 30 nest with the run; the overflow writes per slip in its own transaction", async () => {
    db.salaryStructure.findMany.mockResolvedValue(STRUCTURES_32);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as { data: { payslips: { create: Array<{ slipNo: string }> } } };
    expect(createArg.data.payslips.create).toHaveLength(30);
    // Two overflow slips, each with runId + its own slipNo (031, 032).
    expect(db.payslip.create).toHaveBeenCalledTimes(2);
    const overflow1 = db.payslip.create.mock.calls[0][0].data as { runId: string; slipNo: string };
    const overflow2 = db.payslip.create.mock.calls[1][0].data as { runId: string; slipNo: string };
    expect(overflow1).toMatchObject({ runId: "run-p13", slipNo: "PS-2026-11-031" });
    expect(overflow2).toMatchObject({ runId: "run-p13", slipNo: "PS-2026-11-032" });
    if (res.ok) {
      expect(res.data.payslipCount).toBe(32);
      expect(res.data.failures).toEqual([]);
    }
    // The audit names the chunking.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining("30 in the creation batch + 2 chunked beyond 30"),
    }));
  });

  it("a failing overflow slip is isolated: recorded with a reason, counts stay honest, the rest succeed", async () => {
    db.salaryStructure.findMany.mockResolvedValue(STRUCTURES_32);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    // The FIRST overflow slip (u-31) hits a duplicate-key violation; the
    // second (u-32) succeeds.
    let call = 0;
    db.payslip.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      call += 1;
      if (call === 1) {
        const e = new Error("Unique constraint failed on the fields: (`slipNo`)") as Error & { code: string };
        e.code = "P2002";
        throw e;
      }
      return { id: "ps-overflow", ...data };
    });
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Honest counts: 30 nested + 1 overflow success; the failed one named.
      expect(res.data.payslipCount).toBe(31);
      expect(res.data.failures).toEqual([
        { userId: "u-31", slipNo: "PS-2026-11-031", reason: "a payslip already exists for this employee in the run (duplicate)" },
      ]);
    }
    // The audit carries the loud failure summary.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining("1 payslip(s) FAILED with reasons: PS-2026-11-031 (a payslip already exists"),
    }));
  });

  it("a failed overflow slip's adjustments are never consumed (PENDING for the addPayslip retry)", async () => {
    db.salaryStructure.findMany.mockResolvedValue(STRUCTURES_32);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
    // One ONE_SHOT adjustment due for u-31 (the slip that will fail).
    db.payAdjustment.findMany.mockResolvedValue([
      {
        id: "adj-31", userId: "u-31", sourceType: "MANUAL", sourceId: "", componentCode: "",
        label: "Relocation", side: "EARNING", recurrence: "ONE_SHOT", calcMode: "FIXED",
        percent: null, amount: 500, period: "2026-11", endPeriod: null,
        lastConsumedPeriod: "", status: "PENDING", skipReason: "", note: "",
      },
    ]);
    db.payslip.create.mockRejectedValue(new Error("boom"));
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.payslipCount).toBe(30);
    // u-31's row was never consumed and never skipped — it stays PENDING so
    // the joiner path (addPayslip) can pick it up after the fix.
    const updateCalls = db.payAdjustment.update.mock.calls as Array<[{ where: { id: string } }]>;
    expect(updateCalls.find((c) => c[0].where.id === "adj-31")).toBeUndefined();
    const skipCalls = updateCalls.filter((c) => (c[0] as { data?: { status?: string } }).data?.status === "SKIPPED");
    expect(skipCalls.find((c) => c[0].where.id === "adj-31")).toBeUndefined();
    if (res.ok) expect(res.data.adjustmentsApplied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P14 (PR-33 / PR-04) — the bulk tools: bulk structure assignment with
// per-employee isolation + the run's optional employee filter.
// ---------------------------------------------------------------------------
describe("P14 — bulkAssignStructure (PR-33)", () => {
  beforeEach(() => {
    db.user.findMany.mockResolvedValue([
      { id: "u-yuki", name: "Yuki Tanaka" },
      { id: "u-hana", name: "Hana Park" },
      { id: "u-new", name: "New Person" },
    ]);
    db.salaryStructure.findMany.mockResolvedValue([
      { userId: "u-yuki" }, // Yuki has an active structure → replace
    ]);
    db.salaryStructure.updateMany.mockResolvedValue({ count: 1 });
    db.salaryStructure.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ss-bulk", ...data }));
  });

  it("requires payroll:manage", async () => {
    requirePermissionMock.mockImplementation(denyFor("payroll:manage"));
    const res = await bulkAssignStructure({ userIds: ["u-yuki"], components: COMPONENTS });
    expect(res.ok).toBe(false);
  });

  it("replaces existing actives and creates fresh ones — per-employee transactions, honest counts", async () => {
    const res = await bulkAssignStructure({
      userIds: ["u-yuki", "u-hana", "u-new"],
      components: COMPONENTS,
      frequency: "WEEKLY",
      effectiveFrom: "2026-11-01",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.replaced).toBe(1); // Yuki had an active structure
      expect(res.data.createdFresh).toBe(2); // Hana + New Person
      expect(res.data.failures).toEqual([]);
    }
    // Three creates, one per employee.
    expect(db.salaryStructure.create).toHaveBeenCalledTimes(3);
    // Only Yuki's active structure was retired.
    expect(db.salaryStructure.updateMany).toHaveBeenCalledTimes(1);
    expect(db.salaryStructure.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-yuki", isActive: true } }),
    );
    // The created rows carry the cadence + effective date.
    const first = db.salaryStructure.create.mock.calls[0][0].data as { userId: string; frequency: string; effectiveFrom: Date; components: string };
    expect(first).toMatchObject({ userId: "u-yuki", frequency: "WEEKLY" });
    expect(first.effectiveFrom).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(JSON.parse(first.components)).toHaveLength(3);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.structures_bulk_assigned",
      detail: expect.stringContaining("3 employee(s) — 1 replaced an active structure, 2 first structure"),
    }));
  });

  it("an unknown employee id is a per-employee failure, not a silent skip; total failure refuses loudly", async () => {
    const res = await bulkAssignStructure({ userIds: ["u-ghost"], components: COMPONENTS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("created no structures");
    expect(db.salaryStructure.create).not.toHaveBeenCalled();

    // Mixed: one good + one ghost → the good one lands, the ghost is named.
    const mixed = await bulkAssignStructure({ userIds: ["u-yuki", "u-ghost"], components: COMPONENTS });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.data.replaced + mixed.data.createdFresh).toBe(1);
      expect(mixed.data.failures).toEqual([{ userId: "u-ghost", reason: "employee not found" }]);
    }
  });

  it("a per-employee write failure is isolated (the rest succeed)", async () => {
    db.salaryStructure.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if ((data as { userId: string }).userId === "u-hana") throw new Error("disk on fire");
      return { id: "ss-bulk", ...data };
    });
    const res = await bulkAssignStructure({ userIds: ["u-yuki", "u-hana", "u-new"], components: COMPONENTS });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.failures).toEqual([{ userId: "u-hana", reason: "disk on fire" }]);
      expect(res.data.replaced + res.data.createdFresh).toBe(2);
    }
  });

  it("validates the input shape", async () => {
    expect((await bulkAssignStructure({ userIds: [], components: COMPONENTS })).ok).toBe(false);
    expect((await bulkAssignStructure({ userIds: ["u-yuki"], components: [] })).ok).toBe(false);
    expect((await bulkAssignStructure({ userIds: ["u-yuki"], components: COMPONENTS, frequency: "WEEKLY", anchorDate: "2026-11-01" })).ok).toBe(false); // strict: unknown key
  });
});

describe("P14 — createPayrollRun employee filter (PR-04)", () => {
  beforeEach(() => {
    db.payrollRun.findUnique.mockResolvedValue(null);
    db.payrollRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "run-p14",
      ...data,
      payslips: (((data.payslips as { create?: unknown[] } | undefined)?.create) ?? []).map((_: unknown, i: number) => ({ id: `ps-${i}` })),
    }));
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  });

  it("userIds restricts the snapshot to the selected employees (frequency still applies)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]); // the mock ignores where; assert it instead
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01", userIds: ["u-yuki", "u-hana"] });
    expect(res.ok).toBe(true);
    expect(db.salaryStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, frequency: "MONTHLY", userId: { in: ["u-yuki", "u-hana"] } },
      }),
    );
    // The audit names the filter.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining("(filtered to 2 selected employee(s))"),
    }));
  });

  it("omitted userIds = every active structure of the cadence (no userId clause)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    expect(db.salaryStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, frequency: "MONTHLY" } }),
    );
  });

  it("a filtered run with no matching structures names the filter in the error", async () => {
    db.salaryStructure.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ frequency: "WEEKLY", anchorDate: "2026-11-09", userIds: ["u-yuki"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("for the selected employees");
    expect(db.payrollRun.create).not.toHaveBeenCalled();
  });
});

describe("P16 (PR-11 + PR-04) — fiscal basis, openings, effective windows", () => {
  it("saveSalaryStructure refuses a second structure on the same effective date (duplicate guard)", async () => {
    db.salaryStructure.findFirst.mockResolvedValue({ id: "ss-existing" });
    db.salaryComponent.findMany.mockResolvedValue([]);
    const res = await saveSalaryStructure({
      userId: "u-yuki", components: COMPONENTS, effectiveFrom: "2026-11-01",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already has a structure effective 2026-11-01/);
    expect(db.salaryStructure.create).not.toHaveBeenCalled();
  });

  it("the duplicate guard keeps its own row on update (same id passes)", async () => {
    db.salaryStructure.findFirst.mockResolvedValue({ id: "ss-1" });
    db.salaryComponent.findMany.mockResolvedValue([]);
    const res = await saveSalaryStructure({
      id: "ss-1", userId: "u-yuki", components: COMPONENTS, effectiveFrom: "2026-11-01",
    });
    expect(res.ok).toBe(true);
    expect(db.salaryStructure.update).toHaveBeenCalled();
  });

  it("saveSalaryStructure refuses a component outside its catalog window at the effective date", async () => {
    db.salaryStructure.findFirst.mockResolvedValue(null);
    db.salaryComponent.findMany.mockResolvedValue([
      { code: "basic", effectiveFrom: null, effectiveTo: new Date("2026-06-30T00:00:00Z") },
    ]);
    const res = await saveSalaryStructure({
      userId: "u-yuki", components: COMPONENTS, effectiveFrom: "2026-11-01",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/Component "basic" is not in its catalog window/);
      expect(res.error).toMatch(/2026-11-01/);
    }
    expect(db.salaryStructure.create).not.toHaveBeenCalled();
  });

  it("a component whose window COVERS the effective date passes", async () => {
    db.salaryStructure.findFirst.mockResolvedValue(null);
    db.salaryComponent.findMany.mockResolvedValue([
      { code: "basic", effectiveFrom: new Date("2026-04-01T00:00:00Z"), effectiveTo: new Date("2027-03-31T00:00:00Z") },
    ]);
    const res = await saveSalaryStructure({
      userId: "u-yuki", components: COMPONENTS, effectiveFrom: "2026-11-01",
    });
    expect(res.ok).toBe(true);
    expect(db.salaryStructure.create).toHaveBeenCalled();
  });

  it("persists openingYtd rows on create; omitted key never touches the column; emptied clears", async () => {
    db.salaryStructure.findFirst.mockResolvedValue(null);
    db.salaryComponent.findMany.mockResolvedValue([]);
    const openings = [
      { key: "basic", label: "Basic (prior employer)", side: "EARNING", amount: 39_000 },
      { key: "student_loan", label: "SL", side: "DEDUCTION", amount: 1_300 },
    ];
    const res = await saveSalaryStructure({
      userId: "u-yuki", components: COMPONENTS, effectiveFrom: "2026-10-05",
      openingYtd: openings,
    });
    expect(res.ok).toBe(true);
    const createData = (db.salaryStructure.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(createData.openingYtd).toEqual(openings);

    // Emptied list → DbNull (the clear).
    await saveSalaryStructure({
      userId: "u-yuki", components: COMPONENTS, effectiveFrom: "2026-10-05",
      openingYtd: [],
    });
    const cleared = (db.salaryStructure.create.mock.calls[1][0] as { data: Record<string, unknown> }).data;
    expect(cleared.openingYtd).toBe(Prisma.DbNull);
  });

  it("getPayrollRun seeds YTD from the opening rows and names the fiscal basis", async () => {
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED", fiscalYearStartMonth: 4 } });
    db.payrollRun.findUnique.mockResolvedValue({
      ...OPEN_RUN,
      payslips: [payslipRow({ id: "ps-nov", net: 6_700, gross: 6_700 })],
    });
    db.payrollRun.findMany.mockResolvedValue([
      { id: "run-1", period: "2026-11", startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-30T00:00:00Z") },
    ]);
    db.payslip.findMany.mockResolvedValue([
      { id: "ps-nov", userId: "u-yuki", slipNo: "PS-2026-11-001", runId: "run-1", gross: 6_700, net: 6_700, withholdStatus: "", earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 6_700 }]), deductions: "[]" },
    ]);
    db.salaryStructure.findMany.mockResolvedValue([
      { userId: "u-yuki", effectiveFrom: new Date("2026-10-05T00:00:00Z"), openingYtd: [{ key: "basic", label: "Basic (prior)", side: "EARNING", amount: 39_000 }] },
    ]);
    const res = await getPayrollRun("run-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Opening (39,000) + the November slip (6,700) — same FY 2026/27.
      expect(res.data.payslips[0].ytdGross).toBe(45_700);
      expect(res.data.payslips[0].ytdNet).toBe(45_700);
      expect(res.data.fiscalYearStartMonth).toBe(4);
      expect(res.data.payslips[0].fiscalYearStartMonth).toBe(4);
    }
  });

  it("getPayrollRun spans the calendar boundary under an April basis (Dec + Jan same FY; Apr next FY)", async () => {
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED", fiscalYearStartMonth: 4 } });
    db.payrollRun.findUnique.mockResolvedValue({
      ...OPEN_RUN,
      id: "run-jan",
      period: "2027-01",
      payslips: [payslipRow({ id: "ps-jan", net: 700, gross: 700, slipNo: "PS-2027-01-001" })],
    });
    db.payrollRun.findMany.mockResolvedValue([
      { id: "run-dec", period: "2026-12", startDate: new Date("2026-12-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z") },
      { id: "run-jan", period: "2027-01", startDate: new Date("2027-01-01T00:00:00Z"), endDate: new Date("2027-01-31T00:00:00Z") },
      { id: "run-apr", period: "2027-04", startDate: new Date("2027-04-01T00:00:00Z"), endDate: new Date("2027-04-30T00:00:00Z") },
      { id: "run-mar", period: "2027-03", startDate: new Date("2027-03-01T00:00:00Z"), endDate: new Date("2027-03-31T00:00:00Z") },
    ]);
    db.payslip.findMany.mockImplementation(async ({ where }: { where: { runId: { in: string[] } } }) =>
      where.runId.in.includes("run-dec")
        ? [
            { id: "ps-dec", userId: "u-yuki", slipNo: "PS-2026-12-001", runId: "run-dec", gross: 300, net: 300, withholdStatus: "", earnings: "[]", deductions: "[]" },
            { id: "ps-jan", userId: "u-yuki", slipNo: "PS-2027-01-001", runId: "run-jan", gross: 700, net: 700, withholdStatus: "", earnings: "[]", deductions: "[]" },
          ]
        : [],
    );
    db.salaryStructure.findMany.mockResolvedValue([]);
    const res = await getPayrollRun("run-jan");
    expect(res.ok).toBe(true);
    if (res.ok) {
      // December 2026 + January 2027 are ONE fiscal year (Apr 2026 – Mar 2027):
      // the Dec slip counts toward the Jan run's YTD; the Apr run never does.
      expect(res.data.payslips[0].ytdNet).toBe(1_000);
    }
  });

  it("getMyPayslips carries the fiscal basis + the employee's own openings", async () => {
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED", fiscalYearStartMonth: 4 } });
    db.payslip.findMany.mockResolvedValue([
      {
        id: "ps-nov", runId: "run-1", userId: "u-yuki", slipNo: "PS-2026-11-001",
        gross: 6_700, net: 6_700, withholdStatus: "", lopDays: 0, lopSource: "AUTO", version: 0,
        paidDays: null, note: "",
        earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 6_700 }]),
        deductions: "[]",
        run: { period: "2026-11", workingDays: 21, startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-30T00:00:00Z") },
      },
    ]);
    db.salaryStructure.findMany.mockResolvedValue([
      { userId: "u-yuki", effectiveFrom: new Date("2026-10-05T00:00:00Z"), openingYtd: [{ key: "basic", label: "Basic (prior)", side: "EARNING", amount: 39_000 }, { key: "student_loan", label: "SL", side: "DEDUCTION", amount: 1_300 }] },
    ]);
    const res = await getMyPayslips();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0].ytdGross).toBe(45_700);
      expect(res.data[0].ytdNet).toBe(44_400);
      expect(res.data[0].fiscalYearStartMonth).toBe(4);
    }
  });
});

// ---------------------------------------------------------------------------
// P18 (PR-B16) — payslip email on lock: one PAYSLIP outbox row per slip
// queued in the lock transaction (no email without its lock), delivered
// best-effort after it; subjects carry no amounts, bodies are the audit
// copy; the PDF itself stays download-only (decision §9.2).
// ---------------------------------------------------------------------------

describe("P18 (PR-B16) — payslip email on lock", () => {
  const EMAIL_RUN = () => ({
    ...OPEN_RUN,
    payslips: [{ net: 6_700 }, { net: 3_300 }],
  });
  const EMAIL_SLIPS = () => ([
    { slipNo: "PS-2026-11-001", userId: "u-yuki", gross: 6_700, net: 6_592, lopDays: 0, withholdStatus: "", deductions: JSON.stringify([{ key: "tax", label: "Tax", amount: 108 }]), paidDays: 21 },
    { slipNo: "PS-2026-11-002", userId: "u-ingrid", gross: 3_400, net: 3_300, lopDays: 1, withholdStatus: "WITHHELD", deductions: JSON.stringify([{ key: "tax", label: "Tax", amount: 100 }]), paidDays: 21 },
  ]);

  beforeEach(() => {
    deliverOutboxMailMock.mockResolvedValue({ status: "SENT", providerMessageId: "mid-1", error: "" });
    let n = 0;
    db.mailOutbox.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `mo-${++n}`, ...data }));
    db.mailOutbox.findMany.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) =>
      (where?.id?.in ?? []).map((id) => ({ id, toAddress: `to-${id}`, subject: "Your 2026-11 payslip is ready", body: "body" })),
    );
  });

  it("knob OFF (the default) — no PAYSLIP outbox rows, the pre-P18 silence", async () => {
    db.payrollRun.findUnique.mockResolvedValue(EMAIL_RUN());
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED" } });
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(db.mailOutbox.create).not.toHaveBeenCalled();
    expect(deliverOutboxMailMock).not.toHaveBeenCalled();
    // The audit stays byte-identical (no email clause).
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_locked",
      detail: expect.not.stringContaining("email"),
    }));
  });

  it("knob ON — one PAYSLIP row per slip queued in the lock transaction, delivered after it", async () => {
    db.payrollRun.findUnique.mockResolvedValue(EMAIL_RUN());
    db.payslip.findMany.mockResolvedValue(EMAIL_SLIPS());
    db.user.findMany.mockResolvedValue([
      { id: "u-yuki", name: "Yuki Tanaka", email: "yuki@x.co" },
      { id: "u-ingrid", name: "Ingrid Solberg", email: "ingrid@x.co" },
    ]);
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED", emailPayslipsOnLock: true } });
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    // Queued one row per payslip, inside the transaction (tx === db here).
    expect(db.mailOutbox.create).toHaveBeenCalledTimes(2);
    expect(db.mailOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "PAYSLIP", toAddress: "yuki@x.co", sentById: "u-hr", status: "QUEUED" }),
    }));
    expect(db.mailOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "PAYSLIP", toAddress: "ingrid@x.co" }),
    }));
    // Delivered once per row, by id, with the HTML built off the body.
    expect(deliverOutboxMailMock).toHaveBeenCalledTimes(2);
    expect(deliverOutboxMailMock).toHaveBeenCalledWith(
      "mo-1",
      expect.objectContaining({ toAddress: "to-mo-1", subject: expect.any(String), html: expect.stringContaining("body") }),
    );
    // The audit names the counts.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_locked",
      detail: expect.stringContaining("2 payslip email(s) queued (2 sent, 0 skipped, 0 failed)"),
    }));
  });

  it("the queued body carries the money; the subject never does (subjects leak in previews)", async () => {
    db.payrollRun.findUnique.mockResolvedValue(EMAIL_RUN());
    db.payslip.findMany.mockResolvedValue(EMAIL_SLIPS());
    db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka", email: "yuki@x.co" }, { id: "u-ingrid", name: "Ingrid Solberg", email: "ingrid@x.co" }]);
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { emailPayslipsOnLock: true } });
    await lockPayrollRun({ runId: "run-1" });
    const subjects = db.mailOutbox.create.mock.calls.map((c) => (c[0] as { data: { subject: string } }).data.subject);
    for (const subject of subjects) expect(subject).not.toMatch(/\\$|\\d{3}/);
    expect(subjects[0]).toBe("Your 2026-11 payslip is ready");
    const bodies = db.mailOutbox.create.mock.calls.map((c) => (c[0] as { data: { body: string } }).data.body);
    expect(bodies[0]).toContain("Net pay: $6,592.00");
    expect(bodies[0]).toContain("Total deductions: $108.00");
    expect(bodies[0]).toContain("My payslips");
    // LOP + withheld notes ride the second slip's body.
    expect(bodies[1]).toContain("Loss of pay: 1 day");
    expect(bodies[1]).toContain("withheld");
  });

  it("a delivery failure never fails the lock — counted failed in the audit", async () => {
    db.payrollRun.findUnique.mockResolvedValue(EMAIL_RUN());
    db.payslip.findMany.mockResolvedValue(EMAIL_SLIPS().slice(0, 1));
    db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka", email: "yuki@x.co" }]);
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { emailPayslipsOnLock: true } });
    deliverOutboxMailMock.mockRejectedValue(new Error("provider exploded"));
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_locked",
      detail: expect.stringContaining("1 payslip email(s) queued (0 sent, 0 skipped, 1 failed)"),
    }));
  });

  it("a slip whose user is gone is skipped — no crash, no email for a ghost", async () => {
    db.payrollRun.findUnique.mockResolvedValue(EMAIL_RUN());
    db.payslip.findMany.mockResolvedValue(EMAIL_SLIPS().slice(0, 1));
    db.user.findMany.mockResolvedValue([]); // the user was deleted
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { emailPayslipsOnLock: true } });
    const res = await lockPayrollRun({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(db.mailOutbox.create).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_locked",
      detail: expect.not.stringContaining("email"),
    }));
  });
});

describe("P18 — the payslip email builders (pure)", () => {
  it("payslipEmailSubject names the period only", async () => {
    const { payslipEmailSubject } = await import("@/lib/payslip-email");
    expect(payslipEmailSubject("2026-11")).toBe("Your 2026-11 payslip is ready");
  });

  it("payslipEmailText summarizes the money with LOP and withheld notes", async () => {
    const { payslipEmailText } = await import("@/lib/payslip-email");
    const text = payslipEmailText({
      slipNo: "PS-2026-11-004", gross: 3_400, net: 3_300, lopDays: 1.5, withholdStatus: "WITHHELD",
      deductions: JSON.stringify([{ key: "tax", label: "Tax", amount: 100 }]),
      user: { name: "Ingrid Solberg" },
    }, "2026-11");
    expect(text).toContain("Hi Ingrid Solberg,");
    expect(text).toContain("Your payslip PS-2026-11-004 for 2026-11 is ready.");
    expect(text).toContain("Gross earnings: $3,400.00");
    expect(text).toContain("Total deductions: $100.00");
    expect(text).toContain("Net pay: $3,300.00");
    expect(text).toContain("Loss of pay: 1.5 days applied.");
    expect(text).toContain("withheld");
    expect(text).toContain("Payroll → My payslips");
  });

  it("payslipEmailHtml mirrors the text, bolds the net line, escapes HTML", async () => {
    const { payslipEmailHtml } = await import("@/lib/payslip-email");
    const html = payslipEmailHtml("Hi <b>Ingrid</b>,\nNet pay: $3,300.00\n— Fernly Payroll");
    expect(html).toContain("&lt;b&gt;Ingrid&lt;/b&gt;");
    expect(html).toContain("<strong>Net pay: $3,300.00</strong>");
    expect(html).toContain("<br />");
  });
});

// ---------------------------------------------------------------------------
// P20 (PR-R01/PR-R02) — the per-run CSV exports: LOCKED-only gate, the
// register's rows, the bank file's withheld-money rule, the audit.
// ---------------------------------------------------------------------------

describe("P20 (PR-R01/PR-R02) — exportPayrollRunCsv", () => {
  it("refuses OPEN runs (paid money only) and unknown kinds", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...OPEN_RUN, status: "OPEN" });
    const res = await exportPayrollRunCsv({ runId: "run-1", kind: "REGISTER" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Only paid (locked) runs export");

    const badKind = await exportPayrollRunCsv({ runId: "run-1", kind: "GARBAGE" as unknown as "REGISTER" });
    expect(badKind.ok).toBe(false);
    expect(db.mailOutbox.create).not.toHaveBeenCalled();
  });

  it("REGISTER — one row per slip with identity joins, CRLF output, audited", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...LOCKED_RUN, id: "run-1", period: "2026-11", status: "LOCKED" });
    db.payslip.findMany.mockResolvedValue([
      { slipNo: "PS-2026-11-001", userId: "u-yuki", gross: 6_700, net: 6_592, lopDays: 0, withholdStatus: "", deductions: JSON.stringify([{ key: "tax", label: "Tax", amount: 108 }]) },
      { slipNo: "PS-2026-11-002", userId: "u-ingrid", gross: 3_400, net: 3_300, lopDays: 1, withholdStatus: "WITHHELD", deductions: "[]" },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-yuki", name: "Yuki Tanaka" },
      { id: "u-ingrid", name: "Ingrid Solberg" },
    ]);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-yuki", employeeNumber: "EMP-0003", jobTitle: "Data Engineer" },
      { userId: "u-ingrid", employeeNumber: null, jobTitle: "Research Analyst" },
    ]);
    const res = await exportPayrollRunCsv({ runId: "run-1", kind: "REGISTER" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.filename).toBe("salary-register-2026-11.csv");
      expect(res.data.mime).toContain("text/csv");
      const lines = res.data.csv.split("\r\n");
      expect(lines[0]).toContain("Salary register");
      expect(lines[2]).toContain("Slip no");
      expect(lines[3]).toBe("PS-2026-11-001,EMP-0003,Yuki Tanaka,Data Engineer,6700.00,108.00,6592.00,0,");
      expect(lines[4]).toBe('PS-2026-11-002,,Ingrid Solberg,Research Analyst,3400.00,0.00,3300.00,1,WITHHELD');
      expect(lines[5]).toBe("TOTAL,,2 payslip(s),,10100.00,108.00,9892.00,,");
    }
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_exported",
      detail: expect.stringContaining("salary register"),
    }));
  });

  it("BANK_REMITTANCE — withheld nets stay out; the filename names the shape", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...LOCKED_RUN, id: "run-1", period: "2026-11", status: "LOCKED" });
    db.payslip.findMany.mockResolvedValue([
      { slipNo: "PS-2026-11-001", userId: "u-yuki", gross: 6_700, net: 6_592, lopDays: 0, withholdStatus: "", deductions: "[]" },
      { slipNo: "PS-2026-11-002", userId: "u-ingrid", gross: 3_400, net: 3_300, lopDays: 1, withholdStatus: "WITHHELD", deductions: "[]" },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-yuki", name: "Yuki Tanaka" }, { id: "u-ingrid", name: "Ingrid Solberg" }]);
    db.employeeProfile.findMany.mockResolvedValue([{ userId: "u-yuki", employeeNumber: "EMP-0003", jobTitle: "" }, { userId: "u-ingrid", employeeNumber: null, jobTitle: "" }]);
    const res = await exportPayrollRunCsv({ runId: "run-1", kind: "BANK_REMITTANCE" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.filename).toBe("bank-remittance-2026-11.csv");
      expect(res.data.csv).not.toContain("3300.00"); // the withheld net never pays
      expect(res.data.csv).toContain("6592.00");
      expect(res.data.csv).toContain("Bank account");
    }
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.run_exported",
      detail: expect.stringContaining("bank remittance"),
    }));
  });

  it("a deleted user degrades honestly — the row names the ghost", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...LOCKED_RUN, id: "run-1", period: "2026-11", status: "LOCKED" });
    db.payslip.findMany.mockResolvedValue([
      { slipNo: "PS-2026-11-001", userId: "u-gone", gross: 1, net: 1, lopDays: 0, withholdStatus: "", deductions: "[]" },
    ]);
    db.user.findMany.mockResolvedValue([]); // the user was deleted
    db.employeeProfile.findMany.mockResolvedValue([]);
    const res = await exportPayrollRunCsv({ runId: "run-1", kind: "REGISTER" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.csv).toContain("(deleted user)");
  });
});

// ---------------------------------------------------------------------------
// P23 (PR-02/PR-03) — the catalog percent modes + the isDefault structure
// flag (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2): percent-of-gross
// resolves annually (computeOffer) and divides by the cadence's windows;
// percent-of-net rides the run's two-pass kernel (structure rows prepended
// before the adapter's); the structure's flat DEDUCTION lines materialize on
// every slip (previously silently dropped — the PR-02 remainder); at most
// one structure is the workspace DEFAULT PACKAGE (prefill source).
// ---------------------------------------------------------------------------

describe("P23 — percent modes materialize on payslips (run creation)", () => {
  const P23_COMPONENTS = [
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 66_000 },
    { key: "variable_pay", label: "Variable Pay Allowance", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 8 },
    { key: "student_loan", label: "Student Loan Repayment", kind: "DEDUCTION", mode: "FIXED", amount: 2_400 },
    { key: "advance_recovery", label: "Advance Recovery", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 6 },
  ];
  const P23_STRUCTURE = {
    ...STRUCTURE_ROW,
    components: JSON.stringify(P23_COMPONENTS),
  };

  it("percent-of-gross earnings ÷ windows + flat deductions + percent-of-net through the two-pass kernel", async () => {
    db.salaryStructure.findMany.mockResolvedValue([P23_STRUCTURE]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; deductions: string; gross: number; net: number }> } };
    };
    const slip = createArg.data.payslips.create[0];
    // Annual: basic 66,000 → variable_pay = 8% × 66,000 = 5,280 → earnings
    // 71,280. Monthly: 5,500 + 440 = 5,940 gross. Flat deduction: 2,400 ÷ 12
    // = 200. Percent-of-net on the running net (no LOP, no adjustments):
    // 6% × (5,940 − 200) = 344.40 → net 5,940 − 200 − 344.40 = 5,395.60.
    expect(JSON.parse(slip.earnings)).toEqual([
      { key: "basic", label: "Basic Salary", amount: 5_500 },
      { key: "variable_pay", label: "Variable Pay Allowance", amount: 440 },
    ]);
    expect(JSON.parse(slip.deductions)).toEqual([
      { key: "student_loan", label: "Student Loan Repayment", amount: 200 },
      { key: "advance_recovery", label: "Advance Recovery", amount: 344.4 },
    ]);
    expect(slip.gross).toBe(5_940);
    expect(slip.net).toBe(5_395.6);
  });

  it("percent-of-net sees the LOP-docked net (the LOP line rides the base first)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([P23_STRUCTURE]);
    // One ABSENT working day in the window → auto LOP 1 day, holiday-aware
    // denominator = the run's workingDays (empty calendar → Mon–Fri).
    db.attendanceRecord.findMany.mockResolvedValue([
      { userId: "u-yuki", date: new Date("2026-11-02T00:00:00Z"), status: "ABSENT", overtimeMinutes: null },
    ]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { workingDays: number; payslips: { create: Array<{ deductions: string; gross: number; net: number; lopDays: number }> } };
    };
    const slip = createArg.data.payslips.create[0];
    const lines = JSON.parse(slip.deductions) as Array<{ key: string; amount: number }>;
    const lop = lines.find((l) => l.key === "lop");
    const advance = lines.find((l) => l.key === "advance_recovery");
    // Earnings dock 1 working day (day-scaled), the LOP line prices from the
    // docked basis, and the percent-of-net line sees what remains after BOTH.
    expect(slip.lopDays).toBe(1);
    expect(lop).toBeDefined();
    const gross = slip.gross;
    const netAfterLopAndLoan = gross - (lop?.amount ?? 0) - 200;
    expect(advance?.amount).toBe(Math.round(netAfterLopAndLoan * 0.06 * 100) / 100);
    expect(slip.net).toBe(Math.round((netAfterLopAndLoan - (advance?.amount ?? 0)) * 100) / 100);
  });

  it("a pre-P23 structure (no deduction lines) stays byte-identical (empty deduction base)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string; deductions: string; gross: number; net: number }> } };
    };
    const slip = createArg.data.payslips.create[0];
    expect(JSON.parse(slip.earnings)).toEqual([
      { key: "basic", label: "Basic Salary", amount: 6_500 },
      { key: "transport", label: "Transport Allowance", amount: 200 },
    ]);
    expect(JSON.parse(slip.deductions)).toEqual([]);
    expect(slip.gross).toBe(6_700);
    expect(slip.net).toBe(6_700);
  });
});

describe("P23 — saveSalaryStructure: the workspace default package flag", () => {
  it("creating with isDefault clears every other holder atomically (one transaction)", async () => {
    const res = await saveSalaryStructure({ userId: "u-yuki", components: COMPONENTS, isDefault: true });
    expect(res.ok).toBe(true);
    // The clear ran inside the SAME transaction as retire + create.
    const updateManyCalls = db.salaryStructure.updateMany.mock.calls.map((c) => c[0]);
    const clear = updateManyCalls.find((c) => (c as { data?: { isDefault?: unknown } }).data?.isDefault === false);
    expect(clear).toMatchObject({ where: { isDefault: true } });
    const createCall = db.salaryStructure.create.mock.calls[0][0] as { data: { isDefault?: boolean } };
    expect(createCall.data.isDefault).toBe(true);
  });

  it("updating with isDefault clears the OTHER holders (never this row)", async () => {
    const res = await saveSalaryStructure({ id: "ss-1", userId: "u-yuki", components: COMPONENTS, isDefault: true });
    expect(res.ok).toBe(true);
    const clear = db.salaryStructure.updateMany.mock.calls.map((c) => c[0]).find(
      (c) => (c as { data?: { isDefault?: unknown } }).data?.isDefault === false,
    );
    expect(clear).toMatchObject({ where: { isDefault: true, id: { not: "ss-1" } } });
  });

  it("an update that omits isDefault keeps the stored value (the maxBenefits wire convention)", async () => {
    const res = await saveSalaryStructure({ id: "ss-1", userId: "u-yuki", components: COMPONENTS });
    expect(res.ok).toBe(true);
    const updateCall = db.salaryStructure.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect("isDefault" in updateCall.data).toBe(false);
    expect(db.salaryStructure.updateMany).not.toHaveBeenCalled();
  });

  it("the audit line names the default package hand-off", async () => {
    await saveSalaryStructure({ userId: "u-yuki", components: COMPONENTS, isDefault: true });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.structure_saved",
      detail: expect.stringContaining("workspace default package"),
    }));
  });

  it("getSalaryStructures serializes the flag (pre-P23 rows read false)", async () => {
    db.salaryStructure.findMany.mockResolvedValue([
      { ...STRUCTURE_ROW, isDefault: true },
      { ...STRUCTURE_ROW, id: "ss-2" },
    ]);
    const res = await getSalaryStructures();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0].isDefault).toBe(true);
      expect(res.data[1].isDefault).toBe(false);
    }
  });
});

describe("P23 — component-line validation (the shared refinements)", () => {
  it("a percent-of-net EARNING is refused (deduction-only — the kernel rule)", async () => {
    const res = await saveSalaryStructure({
      userId: "u-yuki",
      components: [
        { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
        { key: "weird", label: "Weird", kind: "EARNING", mode: "PERCENT_OF_NET", amount: 6 },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("deduction-only");
  });

  it("percent modes outside (0, 100] are refused", async () => {
    const tooBig = await saveSalaryStructure({
      userId: "u-yuki",
      components: [
        { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
        { key: "vp", label: "VP", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 150 },
      ],
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain("between 0 and 100");

    const zero = await saveSalaryStructure({
      userId: "u-yuki",
      components: [
        { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 60_000 },
        { key: "adv", label: "Adv", kind: "DEDUCTION", mode: "PERCENT_OF_NET", amount: 0 },
      ],
    });
    expect(zero.ok).toBe(false);
  });

  it("the catalog CRUD refuses the same shapes (one rule, both surfaces)", async () => {
    const { saveSalaryComponent } = await import("../payroll-components");
    const res = await saveSalaryComponent({
      code: "bad_net", label: "Bad", kind: "EARNING", mode: "PERCENT_OF_NET", defaultAmount: 6,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("deduction-only");
  });
});
