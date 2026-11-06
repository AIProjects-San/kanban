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
    "payrollRun", "payslip", "auditLog", "holidayCalendarEntry",
    "attendanceRecord", "leaveRequest", "leaveType",
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
    note: "", lopDays: 0, lopSource: "AUTO", gross: 6_700, net: 6_700,
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
});

describe("R7 — RBAC (payroll:manage = ADMIN + HR only)", () => {
  it("MANAGER is denied on every payroll action", async () => {
    requirePermissionMock.mockImplementation(denyFor("payroll:manage"));
    const results = await Promise.all([
      getSalaryStructures(),
      getPayrollRuns(),
      saveSalaryStructure({ userId: "u-yuki", components: COMPONENTS }),
      createPayrollRun({ period: "2026-11" }),
      updatePayslip({ payslipId: "ps-1", earnings: [], deductions: [], lopDays: 0 }),
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
      payslipId: "ps-1",
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
      payslipId: "ps-1", earnings: [], deductions: [], lopDays: 0,
    });
    expect(locked.ok).toBe(false);

    db.payslip.findUnique.mockResolvedValue(payslipRow());
    const dup = await updatePayslip({
      payslipId: "ps-1",
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

  it("updatePayslip rejects LOP days beyond the run period's day count (persona-audit P0 fix)", async () => {
    db.payslip.findUnique.mockResolvedValue(payslipRow()); // run period 2026-11 → 30 days
    const res = await updatePayslip({
      payslipId: "ps-1",
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
      payslipId: "ps-1",
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
      payslipId: "ps-1",
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
      payslipId: "ps-1",
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
      payslipId: "ps-1",
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
      payslipId: "ps-1",
      earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
      deductions: [],
      lopDays: 2,
      note: "",
    });
    expect(sameAuto.ok).toBe(true);
    expect((db.payslip.update.mock.calls[0][0] as { data: { lopSource: string } }).data.lopSource).toBe("AUTO");

    db.payslip.findUnique.mockResolvedValue(payslipRow({ lopDays: 2, lopSource: "MANUAL" }));
    const sameManual = await updatePayslip({
      payslipId: "ps-1",
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
      payslipId: "ps-1",
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
