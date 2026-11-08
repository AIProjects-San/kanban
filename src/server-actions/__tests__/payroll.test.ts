import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Recruitment R7 — payroll action tests (docs/RECRUITMENT_MODULE_PLAN.md §5):
// payroll:manage gating (ADMIN+HR only), structure lifecycle (manual + from
// signed offer), run creation snapshotting structures ÷12, payslip editing
// with the auto LOP line, lock immutability, and YTD accumulation.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "candidate", "offerRecord", "salaryStructure",
    "salaryComponent", "payrollRun", "payslip", "payAdjustment", "auditLog", "holidayCalendarEntry",
    "attendanceRecord", "leaveRequest", "leaveType", "fullAndFinalStatement",
  ];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
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
  getPayrollRun,
  getPayrollRuns,
  updatePayslip,
  addPayslip,
  lockPayrollRun,
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
      createPayrollRun({ period: "2026-11" }),
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
    const bad = await createPayrollRun({ period: "2026-13" });
    expect(bad.ok).toBe(false);
    db.payrollRun.findUnique.mockResolvedValue({ id: "run-1" });
    const dup = await createPayrollRun({ period: "2026-11" });
    expect(dup.ok).toBe(false);
    expect(db.payrollRun.create).not.toHaveBeenCalled();
  });

  it("createPayrollRun refuses to run with zero active structures", async () => {
    db.salaryStructure.findMany.mockResolvedValue([]);
    const res = await createPayrollRun({ period: "2026-11" });
    expect(res.ok).toBe(false);
  });

  it("createPayrollRun snapshots every ACTIVE structure ÷12 with sequential slip numbers", async () => {
    db.salaryStructure.findMany.mockResolvedValue([
      STRUCTURE_ROW,
      { ...STRUCTURE_ROW, id: "ss-2", userId: "u-hana" },
    ]);
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayrollRun({ period: "2026-10" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayrollRun({ period: "2026-11" });
    expect(res.ok).toBe(true);
    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ lopDays: number; deductions: string }> } };
    };
    expect(createArg.data.payslips.create[0].lopDays).toBe(0);
    expect(createArg.data.payslips.create[0].deductions).toBe("[]");
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
  it("getPayrollRun computes YTD across same-year periods up to and including this run", async () => {
    // Two runs in 2026 (10 LOCKED + 11 OPEN) — the year query returns both.
    db.payrollRun.findUnique.mockResolvedValue({
      ...OPEN_RUN,
      payslips: [payslipRow({ net: 6_700 })],
    });
    db.payrollRun.findMany.mockImplementation(async ({ where }: { where?: { period?: { startsWith?: string } } }) =>
      where?.period?.startsWith === "2026"
        ? [{ id: "run-0", period: "2026-10" }, { id: "run-1", period: "2026-11" }]
        : [],
    );
    db.payslip.findMany.mockResolvedValue([
      { userId: "u-yuki", net: 6_700 }, // October (locked)
      { userId: "u-yuki", net: 6_600 }, // November (current)
    ]);
    const res = await getPayrollRun("run-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.payslips[0].ytdNet).toBe(13_300);
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res2 = await createPayrollRun({ period: "2026-12" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
    const res = await createPayAdjustment({ userId: "u-ghost", side: "EARNING", period: "2026-12", amount: 5 });
    expect(res.ok).toBe(false);
  });
});

describe("P1 — createPayrollRun consumes the adapter transactionally", () => {
  it("a ONE_SHOT earning lands on its employee's slip and flips the row CONSUMED", async () => {
    db.salaryStructure.findMany.mockResolvedValue([STRUCTURE_ROW]);
    db.payAdjustment.findMany.mockResolvedValue([adjustmentRow()]);
    const res = await createPayrollRun({ period: "2026-12" });
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
    const res = await createPayrollRun({ period: "2026-12" });
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
    const final = await createPayrollRun({ period: "2027-02" });
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
    const res = await createPayrollRun({ period: "2026-12" });
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
    const res = await createPayrollRun({ period: "2026-12" });
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
    const res = await createPayrollRun({ period: "2026-11" });
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
