import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SalaryStructureAssignment } from "@prisma/client";

// ---------------------------------------------------------------------------
// Phase 1B (G8) — resolve-assignment unit tests. The async variant takes the
// client as a parameter (no module mocking needed); the sync variant is pure.
// The payroll-run and revision-atomicity cases live in the lower describe
// blocks (they exercise the server actions with the mocked db).
// ---------------------------------------------------------------------------

import {
  resolveAssignmentAt,
  resolveAssignmentFromList,
  assignmentInForce,
  assignmentsInForceWhere,
  type AssignmentReader,
} from "../resolve-assignment";

const d = (iso: string) => new Date(iso);

function assignment(over: Partial<SalaryStructureAssignment>): SalaryStructureAssignment {
  return {
    id: "a1",
    employeeId: "emp1",
    structureId: "st1",
    fromDate: d("2026-01-01"),
    toDate: null,
    base: {} as SalaryStructureAssignment["base"],
    variable: {} as SalaryStructureAssignment["variable"],
    reason: null,
    approvedById: null,
    approvedAt: null,
    createdAt: d("2026-01-01"),
    createdById: "system-backfill",
    ...over,
  } as SalaryStructureAssignment;
}

describe("resolveAssignmentAt (async, db)", () => {
  function readerFor(rows: SalaryStructureAssignment[]): AssignmentReader {
    // Mirrors the SQL contract the helper relies on: the where-filter and
    // the fromDate-desc ordering the real client applies.
    const findFirst = vi.fn(async (args: {
      where: { employeeId: string; fromDate: { lte: Date }; OR: Array<{ toDate: null } | { toDate: { gt: Date } }> };
    }) => {
      const date = args.where.fromDate.lte;
      const inForce = rows
        .filter((r) => r.employeeId === args.where.employeeId)
        .filter((r) => r.fromDate.getTime() <= date.getTime())
        .filter((r) => r.toDate == null || r.toDate.getTime() > date.getTime())
        .sort((a, b) => b.fromDate.getTime() - a.fromDate.getTime());
      return inForce[0] ?? null;
    });
    return {
      salaryStructureAssignment: { findFirst },
    } as unknown as AssignmentReader;
  }

  it("returns the single open assignment for its employee", async () => {
    const a = assignment({ id: "only" });
    const prisma = readerFor([a]);
    const got = await resolveAssignmentAt(prisma, "emp1", d("2026-06-15"));
    expect(got?.id).toBe("only");
  });

  it("returns the earlier assignment when the date falls between two windows", async () => {
    const earlier = assignment({ id: "first", fromDate: d("2026-01-01"), toDate: d("2026-07-01") });
    const later = assignment({ id: "second", fromDate: d("2026-07-01"), toDate: null });
    const prisma = readerFor([earlier, later]);
    const got = await resolveAssignmentAt(prisma, "emp1", d("2026-06-30"));
    expect(got?.id).toBe("first");
  });

  it("returns the second assignment once its fromDate has arrived", async () => {
    const earlier = assignment({ id: "first", fromDate: d("2026-01-01"), toDate: d("2026-07-01") });
    const later = assignment({ id: "second", fromDate: d("2026-07-01"), toDate: null });
    const prisma = readerFor([earlier, later]);
    const got = await resolveAssignmentAt(prisma, "emp1", d("2026-07-01"));
    expect(got?.id).toBe("second");
  });

  it("returns null for an employee with no assignment", async () => {
    const prisma = readerFor([]);
    const got = await resolveAssignmentAt(prisma, "emp1", d("2026-06-15"));
    expect(got).toBeNull();
  });

  it("issues the spec query: lte fromDate, open window, desc ordering", async () => {
    const findFirst = vi.fn(async () => null);
    const prisma = { salaryStructureAssignment: { findFirst } } as unknown as AssignmentReader;
    await resolveAssignmentAt(prisma, "emp9", d("2026-11-01"));
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        employeeId: "emp9",
        fromDate: { lte: d("2026-11-01") },
        OR: [{ toDate: null }, { toDate: { gt: d("2026-11-01") } }],
      },
      orderBy: { fromDate: "desc" },
    });
  });
});

describe("resolveAssignmentFromList (sync, bulk)", () => {
  const rows = [
    assignment({ id: "first", employeeId: "emp1", fromDate: d("2026-01-01"), toDate: d("2026-07-01") }),
    assignment({ id: "second", employeeId: "emp1", fromDate: d("2026-07-01"), toDate: null }),
    assignment({ id: "other", employeeId: "emp2", fromDate: d("2026-02-01"), toDate: null }),
  ];

  it("resolves the window in force at a mid-timeline date", () => {
    expect(resolveAssignmentFromList(rows, "emp1", d("2026-03-01"))?.id).toBe("first");
  });

  it("resolves the latest window once opened (fromDate inclusive, toDate exclusive)", () => {
    expect(resolveAssignmentFromList(rows, "emp1", d("2026-07-01"))?.id).toBe("second");
    expect(resolveAssignmentFromList(rows, "emp1", d("2026-06-30T23:59:59.999Z"))?.id).toBe("first");
  });

  it("never crosses employees", () => {
    expect(resolveAssignmentFromList(rows, "emp2", d("2026-08-01"))?.id).toBe("other");
    expect(resolveAssignmentFromList(rows, "emp3", d("2026-08-01"))).toBeNull();
  });

  it("returns null before the first window and after a closed one", () => {
    const closed = [assignment({ employeeId: "emp9", fromDate: d("2026-01-01"), toDate: d("2026-03-01") })];
    expect(resolveAssignmentFromList(closed, "emp9", d("2025-12-31"))).toBeNull();
    expect(resolveAssignmentFromList(closed, "emp9", d("2026-03-01"))).toBeNull();
  });
});

describe("assignmentInForce / assignmentsInForceWhere (predicate)", () => {
  it("half-open window semantics", () => {
    const a = assignment({ fromDate: d("2026-01-01"), toDate: d("2026-07-01") });
    expect(assignmentInForce(a, d("2025-12-31"))).toBe(false);
    expect(assignmentInForce(a, d("2026-01-01"))).toBe(true);
    expect(assignmentInForce(a, d("2026-06-30"))).toBe(true);
    expect(assignmentInForce(a, d("2026-07-01"))).toBe(false);
  });

  it("null toDate stays in force forever", () => {
    const a = assignment({ fromDate: d("2026-01-01"), toDate: null });
    expect(assignmentInForce(a, d("2030-01-01"))).toBe(true);
  });

  it("predicate shape mirrors the spec (optional employee filter)", () => {
    const date = d("2026-11-01");
    expect(assignmentsInForceWhere(date)).toEqual({
      fromDate: { lte: date },
      OR: [{ toDate: null }, { toDate: { gt: date } }],
    });
    expect(assignmentsInForceWhere(date, ["e1", "e2"])).toEqual({
      fromDate: { lte: date },
      OR: [{ toDate: null }, { toDate: { gt: date } }],
      employeeId: { in: ["e1", "e2"] },
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 1B step 4/7 — the payroll run consumes the ASSIGNMENT in force at
// run.startDate (createPayrollRun through the mocked-db harness, the same
// discipline as the payroll server-action suites).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "salaryStructure", "salaryStructureAssignment",
    "salaryComponent", "payrollRun", "payslip", "payAdjustment", "auditLog",
    "holidayCalendarEntry", "salaryWithholding", "attendanceRecord",
    "leaveRequest", "leaveType", "fullAndFinalStatement", "mailOutbox",
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
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  getSessionOrThrow: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  queueOutboxMail: vi.fn(),
  deliverOutboxMail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const getWorkspaceConfigMock = vi.fn();
vi.mock("@/lib/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
  bumpConfigCache: vi.fn(),
}));

// Imported AFTER the mocks (vi hoists vi.mock, but keep the discipline).
import { createPayrollRun } from "@/server-actions/payroll";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

/** Per-test assignment fixtures (the mocked findMany filters these by the
 *  in-force window, mirroring the real client). */
const ASSIGNMENT_ROWS: ReturnType<typeof assignmentRow>[] = [];

/** A structure row (annual components JSON) with the given basic amount. */
function structureRow(id: string, basic: number, isActive: boolean) {
  return {
    id,
    userId: "u-hana",
    components: JSON.stringify([
      { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: basic },
    ]),
    notes: "",
    maxBenefits: 0,
    frequency: "MONTHLY",
    isDefault: false,
    openingYtd: null,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    isActive,
    createdById: "u-hr",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** An assignment row with its structure included (the run's include shape). */
function assignmentRow(
  id: string,
  fromDate: string,
  toDate: string | null,
  structure: ReturnType<typeof structureRow>,
  base: number,
) {
  return {
    id,
    employeeId: "u-hana",
    structureId: structure.id,
    fromDate: new Date(fromDate),
    toDate: toDate == null ? null : new Date(toDate),
    base,
    variable: 0,
    reason: "HIRE",
    approvedById: null,
    approvedAt: null,
    createdAt: new Date(fromDate),
    createdById: "system-backfill",
    structure,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ASSIGNMENT_ROWS.length = 0;
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
  db.user.findMany.mockResolvedValue([{ id: "u-hana", name: "Hana Park" }]);
  db.employeeProfile.findMany.mockResolvedValue([]);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.leaveType.findMany.mockResolvedValue([]);
  db.salaryComponent.findMany.mockResolvedValue([]);
  db.employeeTaxProfile.findMany.mockResolvedValue([]);
  db.statutoryRule.findFirst.mockResolvedValue(null);
  db.taxYear.findFirst.mockResolvedValue(null);
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.salaryWithholding.findMany.mockResolvedValue([]);
  db.payrollRun.findUnique.mockResolvedValue(null);
  db.payrollRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "run-new",
    ...data,
    payslips: (((data.payslips as { create?: unknown[] } | undefined)?.create) ?? []).map(
      (_: unknown, i: number) => ({ id: `ps-${i}` }),
    ),
  }));
  db.payslip.findUnique.mockResolvedValue(null);
  // The assignment read mirrors the real client's where-filter (the in-force
  // window at the queried date) so the action sees exactly what SQL would
  // return. Per-test rows land in ASSIGNMENT_ROWS.
  db.salaryStructureAssignment.findMany.mockImplementation(
    async (args: { where: { fromDate: { lte: Date }; structure?: { frequency?: string } } }) => {
      const at = args.where.fromDate.lte;
      const freq = args.where.structure?.frequency;
      return ASSIGNMENT_ROWS.filter(
        (a) => a.fromDate.getTime() <= at.getTime(),
      ).filter((a) => a.toDate == null || a.toDate.getTime() > at.getTime())
        .filter((a) => freq == null || a.structure.frequency === freq);
    },
  );
});

describe("createPayrollRun uses the assignment in force at run.startDate", () => {
  it("pays from the CURRENT assignment's structure when a revision is in force", async () => {
    // Timeline: historical 2024-07-15 → 2026-11-01 at $84,000; the November
    // revision (basic $90,000) in force from 2026-11-01.
    const oldStructure = structureRow("ss-old", 84_000, false);
    const newStructure = structureRow("ss-new", 90_000, true);
    ASSIGNMENT_ROWS.push(
      assignmentRow("ssa-old", "2024-07-15", "2026-11-01", oldStructure, 84_000),
      assignmentRow("ssa-new", "2026-11-01", null, newStructure, 90_000),
    );
    db.salaryStructure.findMany.mockResolvedValue([]); // no legacy actives

    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);

    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ userId: string; earnings: string }> } };
    };
    const slip = createArg.data.payslips.create[0];
    expect(slip.userId).toBe("u-hana");
    // The NOVEMBER structure prices the November window: 90,000 / 12 = 7,500.
    expect(JSON.parse(slip.earnings)).toEqual([
      { key: "basic", label: "Basic Salary", amount: 7_500 },
    ]);
    // The resolution query is dated by the window START and frequency-matched.
    const where = db.salaryStructureAssignment.findMany.mock.calls[0][0].where;
    expect(where.fromDate.lte).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(where.structure).toEqual({ frequency: "MONTHLY" });
  });

  it("pays from the HISTORICAL assignment when the run predates the revision", async () => {
    // Same timeline, but the run is the OCTOBER window — the revision
    // (from 2026-11-01) must NOT leak backwards.
    const oldStructure = structureRow("ss-old", 84_000, true);
    const newStructure = structureRow("ss-new", 90_000, true);
    ASSIGNMENT_ROWS.push(
      assignmentRow("ssa-old", "2024-07-15", "2026-11-01", oldStructure, 84_000),
      assignmentRow("ssa-new", "2026-11-01", null, newStructure, 90_000),
    );
    db.salaryStructure.findMany.mockResolvedValue([]);

    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-10-01" });
    expect(res.ok).toBe(true);

    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string }> } };
    };
    // 84,000 / 12 = 7,000 — the assignment in force on 2026-10-01.
    expect(JSON.parse(createArg.data.payslips.create[0].earnings)).toEqual([
      { key: "basic", label: "Basic Salary", amount: 7_000 },
    ]);
  });

  it("falls back to the legacy active structure when no assignment exists", async () => {
    db.salaryStructure.findMany.mockResolvedValue([structureRow("ss-legacy", 78_000, true)]);

    const res = await createPayrollRun({ frequency: "MONTHLY", anchorDate: "2026-11-01" });
    expect(res.ok).toBe(true);

    const createArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ earnings: string }> } };
    };
    expect(JSON.parse(createArg.data.payslips.create[0].earnings)).toEqual([
      { key: "basic", label: "Basic Salary", amount: 6_500 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 1B step 5/7 — the revision writer: close-previous + open-new in ONE
// transaction, with the structure clone when the base changed.
// ---------------------------------------------------------------------------

import { createSalaryRevision } from "@/server-actions/salary-assignments";

/** Prisma-Decimal-shaped value for the mocked rows. */
const dec = (n: number) => ({ toNumber: () => n });

function currentAssignmentFixture(over: Record<string, unknown> = {}) {
  return {
    id: "ssa-cur",
    employeeId: "u-hana",
    structureId: "ss-old",
    fromDate: new Date("2024-07-15T00:00:00Z"),
    toDate: null,
    base: dec(84_000),
    variable: dec(0),
    reason: "HIRE",
    approvedById: null,
    approvedAt: null,
    createdAt: new Date("2024-07-15T00:00:00Z"),
    createdById: "system-backfill",
    structure: {
      id: "ss-old",
      userId: "u-hana",
      components: JSON.stringify([
        { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 84_000 },
        { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
      ]),
      notes: "",
      maxBenefits: 0,
      frequency: "MONTHLY",
      isDefault: false,
      openingYtd: null,
      effectiveFrom: new Date("2026-07-15T00:00:00Z"),
      isActive: true,
      createdById: "u-hr",
      createdAt: new Date("2026-07-15T00:00:00Z"),
      updatedAt: new Date("2026-07-15T00:00:00Z"),
    },
    ...over,
  };
}

beforeEach(() => {
  db.salaryStructureAssignment.findFirst.mockResolvedValue(currentAssignmentFixture());
  db.salaryStructureAssignment.findUnique.mockResolvedValue(null);
  db.salaryStructureAssignment.update.mockResolvedValue({});
  db.salaryStructureAssignment.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: "ssa-new", ...data }),
  );
  db.salaryStructure.update.mockResolvedValue({});
  db.salaryStructure.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: "ss-clone", ...data }),
  );
  db.payrollRun.findMany.mockResolvedValue([]);
});

describe("createSalaryRevision — atomic close + open", () => {
  it("closes the previous assignment, opens the new one, and clones the structure when the base changed", async () => {
    const res = await createSalaryRevision({
      employeeId: "u-hana",
      fromDate: "2026-12-01",
      base: 90_000,
      reason: "PROMOTION",
    });
    expect(res.ok).toBe(true);

    // The old structure was retired and a CLONE was created with the basic
    // anchor re-priced (the percent-of-basic employer line rides untouched).
    expect(db.salaryStructure.update).toHaveBeenCalledWith({
      where: { id: "ss-old" },
      data: { isActive: false },
    });
    const cloneArg = db.salaryStructure.create.mock.calls[0][0] as {
      data: { components: string; isActive: boolean; effectiveFrom: Date };
    };
    expect(JSON.parse(cloneArg.data.components)).toEqual([
      { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 90_000 },
      { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
    ]);
    expect(cloneArg.data.isActive).toBe(true);
    expect(cloneArg.data.effectiveFrom).toEqual(new Date("2026-12-01T00:00:00Z"));

    // Close previous + open new — both inside the ONE transaction.
    expect(db.salaryStructureAssignment.update).toHaveBeenCalledWith({
      where: { id: "ssa-cur" },
      data: { toDate: new Date("2026-12-01T00:00:00Z") },
    });
    expect(db.salaryStructureAssignment.create).toHaveBeenCalledWith({
      data: {
        employeeId: "u-hana",
        structureId: "ss-clone",
        fromDate: new Date("2026-12-01T00:00:00Z"),
        toDate: null,
        base: 90_000,
        variable: 0,
        reason: "PROMOTION",
        approvedById: "u-hr",
        approvedAt: expect.any(Date),
        createdById: "u-hr",
      },
    });
    // The audit entry landed after the commit.
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payroll.salary_revision" }),
    );
  });

  it("reuses the same structure for a metadata-only revision (base unchanged)", async () => {
    const res = await createSalaryRevision({
      employeeId: "u-hana",
      fromDate: "2026-12-01",
      base: 84_000, // unchanged
      reason: "TRANSFER",
    });
    expect(res.ok).toBe(true);
    expect(db.salaryStructure.create).not.toHaveBeenCalled();
    expect(db.salaryStructure.update).not.toHaveBeenCalled();
    expect(db.salaryStructureAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ structureId: "ss-old", reason: "TRANSFER" }),
      }),
    );
  });

  it("refuses a fromDate at or before the current assignment's start", async () => {
    const res = await createSalaryRevision({
      employeeId: "u-hana",
      fromDate: "2024-07-15",
      base: 90_000,
      reason: "REVISION",
      backdate: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("must be after the current assignment's start");
    expect(db.salaryStructureAssignment.update).not.toHaveBeenCalled();
    expect(db.salaryStructureAssignment.create).not.toHaveBeenCalled();
  });

  it("refuses a past fromDate without the explicit backdate flag", async () => {
    const res = await createSalaryRevision({
      employeeId: "u-hana",
      fromDate: "2026-06-01", // after the current start (2024-07-15), before today
      base: 90_000,
      reason: "REVISION",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("backdate");
  });
});

// ---------------------------------------------------------------------------
// Phase 1B step 6 — arrears DETECTION (surface only, never post).
// ---------------------------------------------------------------------------

import { detectArrears } from "@/lib/payroll/detect-arrears";

describe("detectArrears — locked windows a backdated revision leaves behind", () => {
  it("returns one prorated row per affected locked period", async () => {
    // Revision effective 2026-10-15 (mid-October): the LOCKED 2026-10 run
    // (window 2026-10-01 → 10-31, 22 working days) was paid on the old base.
    db.salaryStructureAssignment.findUnique.mockResolvedValue({
      id: "ssa-rev",
      employeeId: "u-hana",
      fromDate: new Date("2026-10-15T00:00:00Z"),
      toDate: null,
      base: dec(96_000),
      variable: dec(0),
    });
    db.salaryStructureAssignment.findFirst.mockResolvedValue({
      id: "ssa-prev",
      employeeId: "u-hana",
      fromDate: new Date("2024-07-15T00:00:00Z"),
      toDate: new Date("2026-10-15T00:00:00Z"),
      base: dec(84_000),
      variable: dec(0),
    });
    db.payrollRun.findMany.mockResolvedValue([
      {
        id: "run-oct",
        period: "2026-10",
        status: "LOCKED",
        frequency: "MONTHLY",
        startDate: new Date("2026-10-01T00:00:00Z"),
        endDate: new Date("2026-10-31T00:00:00Z"),
        workingDays: 22,
      },
    ]);
    db.holidayCalendarEntry.findMany.mockResolvedValue([]);

    const rows = await detectArrears("u-hana", "ssa-rev");
    // The predicate catches the run CONTAINING the revision date (partial
    // coverage), not just runs starting after it.
    const runWhere = db.payrollRun.findMany.mock.calls[0][0].where;
    expect(runWhere.status).toBe("LOCKED");
    expect(runWhere.startDate.gte).toEqual(new Date("2024-07-15T00:00:00Z"));
    expect(runWhere.endDate.gte).toEqual(new Date("2026-10-15T00:00:00Z"));
    expect(rows).toHaveLength(1);
    // (96,000 − 84,000) / 12 = 1,000 per month; Oct 15–31 2026 has 12
    // weekdays and the mocked calendar has no holidays, so coverage =
    // 12 / 22 (the run's working-days denominator).
    expect(rows[0].periodKey).toBe("2026-10");
    expect(rows[0].paidBase).toBe(84_000);
    expect(rows[0].dueBase).toBe(96_000);
    expect(rows[0].delta).toBe(Math.round(1000 * (12 / 22) * 100) / 100); // 545.45
  });

  it("returns nothing when the base did not change or no locked window is covered", async () => {
    db.salaryStructureAssignment.findUnique.mockResolvedValue({
      id: "ssa-rev",
      employeeId: "u-hana",
      fromDate: new Date("2026-11-01T00:00:00Z"),
      toDate: null,
      base: dec(84_000), // same base
      variable: dec(0),
    });
    db.salaryStructureAssignment.findFirst.mockResolvedValue({
      id: "ssa-prev",
      employeeId: "u-hana",
      fromDate: new Date("2024-07-15T00:00:00Z"),
      toDate: new Date("2026-11-01T00:00:00Z"),
      base: dec(84_000),
      variable: dec(0),
    });
    expect(await detectArrears("u-hana", "ssa-rev")).toEqual([]);

    // Base changed but the locked October window predates the revision.
    db.salaryStructureAssignment.findUnique.mockResolvedValue({
      id: "ssa-rev2",
      employeeId: "u-hana",
      fromDate: new Date("2026-11-01T00:00:00Z"),
      toDate: null,
      base: dec(96_000),
      variable: dec(0),
    });
    db.payrollRun.findMany.mockResolvedValue([
      {
        id: "run-oct",
        period: "2026-10",
        status: "LOCKED",
        frequency: "MONTHLY",
        startDate: new Date("2026-10-01T00:00:00Z"),
        endDate: new Date("2026-10-31T00:00:00Z"),
        workingDays: 22,
      },
    ]);
    expect(await detectArrears("u-hana", "ssa-rev2")).toEqual([]);
  });
});
