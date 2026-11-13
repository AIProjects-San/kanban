import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Phase 3 — tax-admin action tests: statutory:manage gating, the slab
// editor's validation + locked-run refusal, the versioned rule flow
// (createRuleVersion / archive / delete), the component mapping read-only
// rows, and the Task 3.4 profile guardrails (STC block, casual warning,
// the TEMPORARY→PERMANENT auto-enrolment audit entry).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeTaxProfile", "salaryComponent", "payrollRun", "auditLog",
    "statutoryRule", "taxSlab", "statutorySecondaryRate", "taxYear",
    "statutoryEsctTier", "statutoryAccLevy", "statutoryIetc",
    "statutoryKiwiSaver", "statutoryStudentLoan",
  ];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate", "groupBy",
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
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  archiveTaxYear,
  createRuleVersion,
  deleteTaxYear,
  getComponentTaxMappings,
  getEmployeeTaxProfileAdmin,
  getTaxYears,
  saveComponentTaxMapping,
  saveEmployeeTaxProfile,
  saveTaxYearSlabs,
  simulateTax,
} from "../tax-admin";
import { AuthorizationError } from "@/server-actions/auth-guard";
import { isValidIrdNumber } from "@/lib/payroll/tax-profile-preview";

const SUPER = { userId: "u-super", role: "SUPER_ADMIN" as const, name: "Nova Kaur", email: "super@x.co" };

// ---------------------------------------------------------------------------
// Fixtures — a Prisma-shaped FY2026-27 rate set (children included) in the
// SPLIT secondary form (accInclusive false — an admin-editable row shape;
// the canonical seed stores the IR340 combined rates). Split rows keep this
// action test exercising the levy-on-top path through the admin UI.
// ---------------------------------------------------------------------------

const RATE_SET_ROW = {
  id: "set-fy2026",
  label: "NZ FY2026-27 (1 Apr 2026 – 31 Mar 2027)",
  country: "NZ",
  effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
  effectiveTo: new Date("2027-04-01T00:00:00.000Z"),
  isCurrent: true,
  notes: "",
  createdById: "",
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  payeTiers: [
    { id: "pt1", setId: "set-fy2026", fromAnnual: 0, toAnnual: 15600, rate: 0.105, sortOrder: 0 },
    { id: "pt2", setId: "set-fy2026", fromAnnual: 15600, toAnnual: 53500, rate: 0.175, sortOrder: 10 },
    { id: "pt3", setId: "set-fy2026", fromAnnual: 53500, toAnnual: 78100, rate: 0.3, sortOrder: 20 },
    { id: "pt4", setId: "set-fy2026", fromAnnual: 78100, toAnnual: 180000, rate: 0.33, sortOrder: 30 },
    { id: "pt5", setId: "set-fy2026", fromAnnual: 180000, toAnnual: null, rate: 0.39, sortOrder: 40 },
  ],
  secondaryRates: [
    { id: "sr1", setId: "set-fy2026", code: "SB", rate: 0.105, label: "", accInclusive: false },
    { id: "sr2", setId: "set-fy2026", code: "S", rate: 0.175, label: "", accInclusive: false },
    { id: "sr3", setId: "set-fy2026", code: "SH", rate: 0.3, label: "", accInclusive: false },
    { id: "sr4", setId: "set-fy2026", code: "ST", rate: 0.33, label: "", accInclusive: false },
    { id: "sr5", setId: "set-fy2026", code: "SA", rate: 0.39, label: "", accInclusive: false },
    { id: "sr6", setId: "set-fy2026", code: "ND", rate: 0.45, label: "", accInclusive: false },
  ],
  accLevy: { setId: "set-fy2026", rate: 0.0175, maxEarnings: 156641, maxLevy: 2741.22, createdAt: new Date(), updatedAt: new Date() },
  ietc: { setId: "set-fy2026", annualAmount: 520, lowerBound: 24000, abateFrom: 66000, upperBound: 70000, abateRate: 0.13, createdAt: new Date(), updatedAt: new Date() },
  kiwiSaver: { setId: "set-fy2026", defaultEmployeeRate: 0.035, allowedEmployeeRates: [3, 3.5, 4, 6, 8, 10], employerRate: 0.035, createdAt: new Date(), updatedAt: new Date() },
  esctTiers: [
    { id: "et1", setId: "set-fy2026", fromAnnual: 0, toAnnual: 18720, rate: 0.105, sortOrder: 0 },
    { id: "et2", setId: "set-fy2026", fromAnnual: 18720, toAnnual: 64200, rate: 0.175, sortOrder: 10 },
    { id: "et3", setId: "set-fy2026", fromAnnual: 64200, toAnnual: 93720, rate: 0.3, sortOrder: 20 },
    { id: "et4", setId: "set-fy2026", fromAnnual: 93720, toAnnual: 216000, rate: 0.33, sortOrder: 30 },
    { id: "et5", setId: "set-fy2026", fromAnnual: 216000, toAnnual: null, rate: 0.39, sortOrder: 40 },
  ],
  studentLoan: { setId: "set-fy2026", rate: 0.12, annualThreshold: 24128, createdAt: new Date(), updatedAt: new Date() },
};

/** A valid saveTaxYearSlabs payload (wire format — rates in percent). */
function slabPayload(overrides: Record<string, unknown> = {}) {
  return {
    setId: "set-fy2026",
    slabs: [
      { group: "PAYE", code: "M/ME", label: "", lower: 0, upper: 15600, rate: 10.5, accInclusive: false, order: 0 },
      { group: "PAYE", code: "M/ME", label: "", lower: 15600, upper: 53500, rate: 17.5, accInclusive: false, order: 10 },
      { group: "PAYE", code: "M/ME", label: "", lower: 53500, upper: 78100, rate: 30, accInclusive: false, order: 20 },
      { group: "PAYE", code: "M/ME", label: "", lower: 78100, upper: 180000, rate: 33, accInclusive: false, order: 30 },
      { group: "PAYE", code: "M/ME", label: "", lower: 180000, upper: null, rate: 39, accInclusive: false, order: 40 },
      { group: "SECONDARY", code: "SB", label: "", lower: null, upper: null, rate: 10.5, accInclusive: false, order: 0 },
      { group: "SECONDARY", code: "S", label: "", lower: null, upper: null, rate: 17.5, accInclusive: false, order: 0 },
      { group: "SECONDARY", code: "SH", label: "", lower: null, upper: null, rate: 30, accInclusive: false, order: 0 },
      { group: "SECONDARY", code: "ST", label: "", lower: null, upper: null, rate: 33, accInclusive: false, order: 0 },
      { group: "SECONDARY", code: "SA", label: "", lower: null, upper: null, rate: 39, accInclusive: false, order: 0 },
      { group: "SECONDARY", code: "ND", label: "", lower: null, upper: null, rate: 45, accInclusive: false, order: 0 },
      { group: "ESCT", code: "ESCT", label: "", lower: 0, upper: 18720, rate: 10.5, accInclusive: false, order: 0 },
      { group: "ESCT", code: "ESCT", label: "", lower: 18720, upper: 64200, rate: 17.5, accInclusive: false, order: 10 },
      { group: "ESCT", code: "ESCT", label: "", lower: 64200, upper: 93720, rate: 30, accInclusive: false, order: 20 },
      { group: "ESCT", code: "ESCT", label: "", lower: 93720, upper: 216000, rate: 33, accInclusive: false, order: 30 },
      { group: "ESCT", code: "ESCT", label: "", lower: 216000, upper: null, rate: 39, accInclusive: false, order: 40 },
    ],
    acc: { rate: 1.75, maxEarnings: 156641, maxLevy: 2741.22 },
    ietc: { annualAmount: 520, lowerBound: 24000, abateFrom: 66000, upperBound: 70000, abateRate: 13 },
    kiwiSaver: { defaultEmployeeRate: 3.5, allowedEmployeeRates: [3, 3.5, 4, 6, 8, 10], employerRate: 3.5 },
    studentLoan: { rate: 12, annualThreshold: 24128 },
    notes: "",
    ...overrides,
  };
}

/** A valid Task 3.4 profile payload. */
function profilePayload(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u-1",
    irdNumber: "583639136",
    taxCodeBase: "M",
    studentLoan: false,
    taxCodeEffectiveFrom: null,
    stcCertificateRate: null,
    stcAccTreatment: "INC",
    stcStudentLoanRate: null,
    stcCertificateExpiry: null,
    kiwiSaverStatus: "ACTIVE",
    kiwiSaverEmployeeRate: 3.5,
    kiwiSaverEmployerRate: null,
    esctRateOverride: null,
    employmentType: "PERMANENT",
    casualHolidayPayInWages: true,
    employmentStartDate: "2026-08-01",
    employmentEndDate: null,
    notes: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(SUPER);
});

// ---------------------------------------------------------------------------
// Guard.
// ---------------------------------------------------------------------------

describe("Phase 3 — statutory:manage gate", () => {
  it("every action refuses callers without the permission", async () => {
    requirePermissionMock.mockRejectedValue(new AuthorizationError("denied"));
    const results = await Promise.all([
      getTaxYears(),
      saveTaxYearSlabs(slabPayload()),
      simulateTax({ rateSetId: "set-fy2026", code: "M", gross: 1000, frequency: "WEEKLY" }),
      createRuleVersion({ sourceSetId: "s", category: "ACC", effectiveFrom: "2026-06-01", label: "x", values: {} }),
      archiveTaxYear({ setId: "s" }),
      deleteTaxYear({ setId: "s" }),
      getComponentTaxMappings(),
      saveComponentTaxMapping({ id: "c", taxApplicable: true, statutoryCategory: "TAXABLE_EARNING", wageBaseRef: "GROSS" }),
      getEmployeeTaxProfileAdmin("u-1"),
      saveEmployeeTaxProfile(profilePayload()),
    ]);
    expect(requirePermissionMock).toHaveBeenCalledTimes(results.length);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("AUTH");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.1 — tax years + slabs.
// ---------------------------------------------------------------------------

describe("Task 3.1 — getTaxYears", () => {
  it("serialises sets with percent rates and locked-run counts", async () => {
    db.statutoryRule.findMany.mockResolvedValue([RATE_SET_ROW]);
    db.payrollRun.groupBy.mockResolvedValue([{ rateSetId: "set-fy2026", _count: { _all: 2 } }]);
    const res = await getTaxYears();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    const year = res.data[0];
    expect(year.label).toContain("FY2026-27");
    expect(year.lockedRunCount).toBe(2);
    expect(year.slabs.filter((s) => s.group === "PAYE")).toHaveLength(5);
    expect(year.slabs.find((s) => s.group === "SECONDARY" && s.code === "ND")?.rate).toBe(45);
    expect(year.params.acc?.rate).toBe(1.75);
    expect(year.params.kiwiSaver?.allowedEmployeeRates).toEqual([3, 3.5, 4, 6, 8, 10]);
  });
});

describe("Task 3.1 — saveTaxYearSlabs", () => {
  it("rewrites the child tables and audits when no locked run references the set", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.payrollRun.groupBy.mockResolvedValue([]);
    const res = await saveTaxYearSlabs(slabPayload());
    expect(res.ok).toBe(true);
    expect(db.taxSlab.deleteMany).toHaveBeenCalledWith({ where: { setId: "set-fy2026" } });
    expect(db.taxSlab.createMany).toHaveBeenCalled();
    expect(db.statutorySecondaryRate.createMany).toHaveBeenCalled();
    // percent → decimal conversion on the wire
    const secondary = db.statutorySecondaryRate.createMany.mock.calls[0][0].data as Array<{ code: string; rate: number }>;
    expect(secondary.find((s) => s.code === "ND")?.rate).toBeCloseTo(0.45, 6);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "statutory.rate_set_updated" }),
    );
  });

  it("refuses when a locked payroll run references the set", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.payrollRun.groupBy.mockResolvedValue([{ rateSetId: "set-fy2026", _count: { _all: 1 } }]);
    const res = await saveTaxYearSlabs(slabPayload());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("AUTH");
      expect(res.error).toContain("locked payroll run");
      expect(res.error).toContain("new version");
    }
    expect(db.taxSlab.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects non-contiguous PAYE tiers", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.payrollRun.groupBy.mockResolvedValue([]);
    const res = await saveTaxYearSlabs(
      slabPayload({
        slabs: slabPayload().slabs.map((s) =>
          s.group === "PAYE" && s.lower === 53500 ? { ...s, lower: 60000 } : s,
        ),
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("VALIDATION");
      expect(res.error).toContain("contiguous");
    }
  });

  it("rejects a secondary table missing a canonical IRD code", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.payrollRun.groupBy.mockResolvedValue([]);
    const res = await saveTaxYearSlabs(
      slabPayload({ slabs: slabPayload().slabs.filter((s) => !(s.group === "SECONDARY" && s.code === "SH")) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("SH");
  });

  it("rejects a closed top PAYE tier", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.payrollRun.groupBy.mockResolvedValue([]);
    const res = await saveTaxYearSlabs(
      slabPayload({
        slabs: slabPayload().slabs.map((s) =>
          s.group === "PAYE" && s.upper === null ? { ...s, upper: 500000 } : s,
        ),
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("open-ended");
  });
});

describe("Task 3.1 — simulateTax (the Simulate button)", () => {
  it("M, weekly $1,000 — the IRD-verified split 154.00 / 17.50 / 171.50", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    const res = await simulateTax({ rateSetId: "set-fy2026", code: "M", gross: 1000, frequency: "WEEKLY" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.tax).toBe(154.0);
      expect(res.data.acc).toBe(17.5);
      expect(res.data.total).toBe(171.5);
      expect(res.data.method).toBe("PRIMARY");
      expect(res.data.annualised).toBe(52_000);
    }
  });

  it("STC without a certificate rate surfaces the engine guardrail as validation", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    const res = await simulateTax({ rateSetId: "set-fy2026", code: "STC", gross: 5000, frequency: "MONTHLY" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("VALIDATION");
      expect(res.error).toContain("IR23 certificate");
    }
  });

  it("SB, weekly $1,000 — flat 10.5% + levy on top (IRD spec §5.6)", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    const res = await simulateTax({ rateSetId: "set-fy2026", code: "SB", gross: 1000, frequency: "WEEKLY" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.tax).toBe(105.0);
      expect(res.data.acc).toBe(17.5);
      expect(res.data.total).toBe(122.5);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.2 — versioned rules.
// ---------------------------------------------------------------------------

describe("Task 3.2 — createRuleVersion", () => {
  it("clones the untouched categories, writes the edited one and closes the source window", async () => {
    // First findUnique = loadRateSet (the source); second = the label
    // uniqueness probe (free).
    db.statutoryRule.findUnique
      .mockResolvedValueOnce(RATE_SET_ROW)
      .mockResolvedValueOnce(null);
    db.statutoryRule.findFirst.mockResolvedValue(null); // no colliding set
    db.statutoryRule.create.mockResolvedValue({ id: "set-new", label: "ACC change" });
    const res = await createRuleVersion({
      sourceSetId: "set-fy2026",
      category: "ACC",
      effectiveFrom: "2026-07-01",
      label: "ACC levy mid-year change",
      values: { acc: { rate: 1.8, maxEarnings: 160000, maxLevy: 2880 } },
      notes: "Gazetted change",
    });
    expect(res.ok).toBe(true);
    // New set created with the new window + edited ACC values.
    expect(db.statutoryRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          label: "ACC levy mid-year change",
          effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
          effectiveTo: new Date("2027-04-01T00:00:00.000Z"),
        }),
      }),
    );
    // Untouched categories cloned…
    expect(db.taxSlab.createMany).toHaveBeenCalled();
    expect(db.statutorySecondaryRate.createMany).toHaveBeenCalled();
    // …edited ACC written from the percent wire values…
    expect(db.statutoryAccLevy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ setId: "set-new", rate: 0.018, maxEarnings: 160000, maxLevy: 2880 }),
      }),
    );
    // …and the source window closed at the new date.
    expect(db.statutoryRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "set-fy2026" },
        data: expect.objectContaining({ effectiveTo: new Date("2026-07-01T00:00:00.000Z") }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "statutory.rate_set_version_created" }),
    );
  });

  it("refuses an effective date before the source set's start", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    const res = await createRuleVersion({
      sourceSetId: "set-fy2026",
      category: "ACC",
      effectiveFrom: "2026-01-01",
      label: "Backdated",
      values: { acc: { rate: 1.8, maxEarnings: 160000, maxLevy: 2880 } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("VALIDATION");
      expect(res.error).toContain("after the source set's");
    }
  });

  it("refuses a date that would overlap another set's window", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.statutoryRule.findFirst.mockResolvedValue({
      label: "NZ FY2027-28",
      effectiveFrom: new Date("2026-06-15T00:00:00.000Z"),
    });
    const res = await createRuleVersion({
      sourceSetId: "set-fy2026",
      category: "ACC",
      effectiveFrom: "2026-07-01",
      label: "Clash",
      values: { acc: { rate: 1.8, maxEarnings: 160000, maxLevy: 2880 } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("NZ FY2027-28");
  });
});

describe("Task 3.2 — archive / delete (the archive-only guard)", () => {
  it("delete is blocked for a set referenced by locked runs", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.payrollRun.groupBy.mockResolvedValue([{ rateSetId: "set-fy2026", _count: { _all: 3 } }]);
    const res = await deleteTaxYear({ setId: "set-fy2026" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("AUTH");
      expect(res.error).toContain("3 locked payroll runs");
      expect(res.error).toContain("Archive it instead");
    }
    expect(db.statutoryRule.delete).not.toHaveBeenCalled();
  });

  it("delete proceeds for unreferenced sets and audits", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.payrollRun.groupBy.mockResolvedValue([]);
    db.payrollRun.count.mockResolvedValue(0);
    const res = await deleteTaxYear({ setId: "set-fy2026" });
    expect(res.ok).toBe(true);
    expect(db.statutoryRule.delete).toHaveBeenCalledWith({ where: { id: "set-fy2026" } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "statutory.rate_set_deleted" }),
    );
  });

  it("archive refuses when it would leave no set covering today", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.statutoryRule.findFirst.mockResolvedValue(null); // no other set covers now
    const res = await archiveTaxYear({ setId: "set-fy2026" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("create a new version first");
  });

  it("archive closes the window when another set covers today", async () => {
    db.statutoryRule.findUnique.mockResolvedValue(RATE_SET_ROW);
    db.statutoryRule.findFirst.mockResolvedValue({ id: "other" });
    const res = await archiveTaxYear({ setId: "set-fy2026" });
    expect(res.ok).toBe(true);
    expect(db.statutoryRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "set-fy2026" },
        data: expect.objectContaining({ isCurrent: false }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3.3 — component mapping.
// ---------------------------------------------------------------------------

const COMPONENT_ROW = {
  id: "sc-1", code: "relocation", label: "Relocation Allowance",
  kind: "EARNING", mode: "FIXED", defaultAmount: 5000,
  dependsOnPaymentDays: true, effectiveFrom: null, effectiveTo: null,
  isActive: true, sortOrder: 70,
  taxApplicable: true, statutoryCategory: "TAXABLE_EARNING", wageBaseRef: "GROSS",
  isSystemGenerated: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("Task 3.3 — component mapping", () => {
  it("lists active components with the mapping fields", async () => {
    db.salaryComponent.findMany.mockResolvedValue([COMPONENT_ROW]);
    const res = await getComponentTaxMappings();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0].statutoryCategory).toBe("TAXABLE_EARNING");
      expect(res.data[0].isSystemGenerated).toBe(false);
    }
  });

  it("system-generated rows are read-only", async () => {
    db.salaryComponent.findUnique.mockResolvedValue({ ...COMPONENT_ROW, isSystemGenerated: true });
    const res = await saveComponentTaxMapping({
      id: "sc-1", taxApplicable: false, statutoryCategory: "NON_TAXABLE", wageBaseRef: "NONE",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("system-generated");
      expect(res.error).toContain("read-only");
    }
    expect(db.salaryComponent.update).not.toHaveBeenCalled();
  });

  it("contradictory mappings are rejected (taxable but NON_TAXABLE)", async () => {
    db.salaryComponent.findUnique.mockResolvedValue(COMPONENT_ROW);
    const res = await saveComponentTaxMapping({
      id: "sc-1", taxApplicable: true, statutoryCategory: "NON_TAXABLE", wageBaseRef: "GROSS",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });

  it("a valid mapping saves and audits", async () => {
    db.salaryComponent.findUnique.mockResolvedValue(COMPONENT_ROW);
    const res = await saveComponentTaxMapping({
      id: "sc-1", taxApplicable: false, statutoryCategory: "NON_TAXABLE", wageBaseRef: "NONE",
    });
    expect(res.ok).toBe(true);
    expect(db.salaryComponent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { taxApplicable: false, statutoryCategory: "NON_TAXABLE", wageBaseRef: "NONE" },
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tax.component_mapping_updated" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3.4 — employee tax profile guardrails.
// ---------------------------------------------------------------------------

describe("Task 3.4 — getEmployeeTaxProfileAdmin", () => {
  it("returns defaults for an employee with no profile yet", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    db.employeeTaxProfile.findUnique.mockResolvedValue(null);
    db.statutoryRule.findFirst.mockResolvedValue(RATE_SET_ROW);
    const res = await getEmployeeTaxProfileAdmin("u-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.exists).toBe(false);
      expect(res.data.taxCodeBase).toBe("M");
      expect(res.data.employmentType).toBe("PERMANENT");
      expect(res.data.allowedEmployeeRates).toEqual([3, 3.5, 4, 6, 8, 10]);
      expect(res.data.defaultEmployeeRate).toBe(3.5);
    }
  });

  it("decomposes an existing M SL profile into base + studentLoan", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    db.employeeTaxProfile.findUnique.mockResolvedValue({
      taxCode: "M SL",
      irdNumber: "583639136",
      isCasual: false,
      kiwiSaverStatus: "ACTIVE",
      kiwiSaverEmployeeRate: 0.035,
      kiwiSaverEmployerRate: null,
      taxCodeSpecialRate: null,
      stcAccTreatment: "INC",
      stcStudentLoanRate: null,
      stcCertificateExpiry: null,
      taxCodeEffectiveFrom: null,
      esctRateOverride: null,
      employmentType: "TEMPORARY",
      casualHolidayPayInWages: true,
      employmentStartDate: new Date("2026-10-31T00:00:00.000Z"),
      employmentEndDate: null,
      notes: "",
    });
    db.statutoryRule.findFirst.mockResolvedValue(RATE_SET_ROW);
    const res = await getEmployeeTaxProfileAdmin("u-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.taxCodeBase).toBe("M");
      expect(res.data.studentLoan).toBe(true);
      expect(res.data.kiwiSaverEmployeeRate).toBe(3.5);
      expect(res.data.employmentType).toBe("TEMPORARY");
    }
  });
});

describe("Task 3.4 — saveEmployeeTaxProfile guardrails", () => {
  it("STC without a certificate rate is blocked with the exact spec message", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    db.employeeTaxProfile.findUnique.mockResolvedValue(null);
    const res = await saveEmployeeTaxProfile(profilePayload({ taxCodeBase: "STC", stcCertificateRate: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("VALIDATION");
      expect(res.error).toBe("STC requires a tailored rate from the IR23 certificate — no default exists.");
    }
    expect(db.employeeTaxProfile.upsert).not.toHaveBeenCalled();
  });

  it("an IRD number failing the mod-11 check is rejected", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    db.employeeTaxProfile.findUnique.mockResolvedValue(null);
    const res = await saveEmployeeTaxProfile(profilePayload({ irdNumber: "583639137" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("mod-11");
  });

  it("composes the SL suffix, derives isCasual and saves with the audit entry", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    db.employeeTaxProfile.findUnique.mockResolvedValue(null);
    const res = await saveEmployeeTaxProfile(
      profilePayload({ studentLoan: true, employmentType: "CASUAL", casualHolidayPayInWages: true }),
    );
    expect(res.ok).toBe(true);
    const payload = db.employeeTaxProfile.upsert.mock.calls[0][0].update as Record<string, unknown>;
    expect(payload.taxCode).toBe("M SL");
    expect(payload.isCasual).toBe(true);
    expect(payload.kiwiSaverEmployeeRate).toBeCloseTo(0.035, 6);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tax.profile_updated" }),
    );
  });

  it("casual without holiday-pay-in-wages SAVES and returns the exact warning", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    db.employeeTaxProfile.findUnique.mockResolvedValue(null);
    const res = await saveEmployeeTaxProfile(
      profilePayload({ employmentType: "CASUAL", casualHolidayPayInWages: false }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.warnings).toContain(
        "Casual exemption requires holiday pay to be paid with wages. If holiday pay is paid on leave, consider TEMPORARY or PERMANENT.",
      );
    }
  });

  it("TEMPORARY → PERMANENT after 28 days writes the REQUIRED auto-enrolment audit entry", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    // An existing TEMPORARY profile started 40 days ago.
    db.employeeTaxProfile.findUnique.mockResolvedValue({
      employmentType: "TEMPORARY",
      employmentStartDate: new Date(Date.now() - 40 * 86_400_000),
      kiwiSaverEmployeeRate: null,
      createdById: "u-hr",
    });
    const res = await saveEmployeeTaxProfile(profilePayload({ employmentType: "PERMANENT" }));
    expect(res.ok).toBe(true);
    const enrolmentAudit = logAuditMock.mock.calls.find(
      (c) => (c[0] as { action: string }).action === "tax.auto_enrolment_audited",
    );
    expect(enrolmentAudit).toBeDefined();
    expect((enrolmentAudit![0] as { detail: string }).detail).toContain("28-day rule");
    expect((enrolmentAudit![0] as { detail: string }).detail).toContain("Required audit entry recorded");
  });

  it("TEMPORARY → PERMANENT within 28 days does not write the enrolment audit", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    db.employeeTaxProfile.findUnique.mockResolvedValue({
      employmentType: "TEMPORARY",
      employmentStartDate: new Date(Date.now() - 10 * 86_400_000),
      kiwiSaverEmployeeRate: null,
      createdById: "u-hr",
    });
    const res = await saveEmployeeTaxProfile(profilePayload({ employmentType: "PERMANENT" }));
    expect(res.ok).toBe(true);
    expect(
      logAuditMock.mock.calls.some((c) => (c[0] as { action: string }).action === "tax.auto_enrolment_audited"),
    ).toBe(false);
  });

  it("a KiwiSaver rate outside the allowed elections is rejected (3% is pre-existing only)", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    db.employeeTaxProfile.findUnique.mockResolvedValue(null);
    db.statutoryRule.findFirst.mockResolvedValue(RATE_SET_ROW);
    const res = await saveEmployeeTaxProfile(profilePayload({ kiwiSaverEmployeeRate: 5 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("KiwiSaver employee rate");
  });

  it("an unchanged 3% election passes the membership check (pre-existing elections stay legal)", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u-1", name: "Ada", email: "ada@x.co" });
    // Stored 3% (a pre-Phase-3 election) — resubmitting it unchanged is fine.
    db.employeeTaxProfile.findUnique.mockResolvedValue({ kiwiSaverEmployeeRate: 0.03, employmentType: "PERMANENT", employmentStartDate: null, createdById: "u-hr" });
    db.statutoryRule.findFirst.mockResolvedValue(RATE_SET_ROW);
    const res = await saveEmployeeTaxProfile(profilePayload({ kiwiSaverEmployeeRate: 3 }));
    expect(res.ok).toBe(true);
  });
});

describe("Task 3.4 — IRD mod-11 helper", () => {
  it("accepts the seeded demo numbers and rejects a corrupted check digit", () => {
    for (const ird of ["583639136", "752783373", "760841838", "915801951", "566400642", "561381593"]) {
      expect(isValidIrdNumber(ird)).toBe(true);
    }
    expect(isValidIrdNumber("583639137")).toBe(false);
    expect(isValidIrdNumber("12345")).toBe(false);
    expect(isValidIrdNumber("")).toBe(true); // not recorded
  });
});
