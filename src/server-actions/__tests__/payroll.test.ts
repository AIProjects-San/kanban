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
    "payrollRun", "payslip", "auditLog",
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
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
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
    note: "", lopDays: 0, gross: 6_700, net: 6_700,
    createdAt: new Date(), updatedAt: new Date(),
    run: OPEN_RUN,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
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
        payslips: { create: Array<{ userId: string; slipNo: string; earnings: string; gross: number; net: number }> };
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
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.run_created" }));
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
      expect(res.data.run.totalNet).toBe(6_700);
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
