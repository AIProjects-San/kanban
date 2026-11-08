import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F1.5 — salary component catalog action tests (docs/
// Fernly_HR_Payroll_Enhancement_Plan.md §7.1): payroll:manage gating, catalog
// CRUD with the duplicate-code friendly error, the structure-editor picker
// roundtrip (catalog row → structure line → payslip line),
// createStructureFromOffer's mapping through the catalog (canonical
// label/kind/mode, amount stays the offer's, unknown codes auto-registered),
// and F-R1 — retire+create as ONE transaction in both structure actions.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "candidate", "offerRecord", "salaryStructure",
    "salaryComponent", "payrollRun", "payslip", "payAdjustment", "auditLog", "holidayCalendarEntry",
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

// S4 (PR-B07) — createPayrollRun reads the workspace unmarked-day policy
// through the cached config loader; default IGNORED = pre-S4 semantics.
const getWorkspaceConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
  bumpConfigCache: vi.fn(),
}));

import {
  getSalaryComponents,
  saveSalaryComponent,
  deleteSalaryComponent,
} from "../payroll-components";
import type { SalaryComponentT } from "@/lib/types";
import {
  saveSalaryStructure,
  createStructureFromOffer,
  createPayrollRun,
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

const CATALOG_ROW = {
  id: "sc-1", code: "senior_basic", label: "Senior Basic Salary",
  kind: "EARNING", mode: "FIXED", defaultAmount: 84_000,
  isActive: true, sortOrder: 10,
  createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const OFFER_COMPONENTS = [
  { key: "senior_basic", label: "Basic (stale label)", kind: "EARNING", mode: "FIXED", amount: 90_000 },
  { key: "car_allowance", label: "Car Allowance", kind: "EARNING", mode: "FIXED", amount: 4_800 },
];

beforeEach(() => {
  getWorkspaceConfigMock.mockResolvedValue({ workspace: { unmarkedAttendanceMode: "IGNORED" } });
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  getSessionOrThrowMock.mockResolvedValue({ ...HR_AUTH, userId: "u-yuki", role: "MEMBER" as const, name: "Yuki Tanaka" });
  db.user.findUnique.mockResolvedValue({ id: "u-yuki", name: "Yuki Tanaka" });
  db.candidate.findFirst.mockResolvedValue({ id: "cand-1", fullName: "Priyanka Menon" });
  db.offerRecord.findFirst.mockResolvedValue({
    id: "or-1", candidateId: "cand-1", status: "SIGNED", signedAt: new Date(),
    templateLabel: "Designer Band", components: JSON.stringify(OFFER_COMPONENTS),
  });
  db.salaryComponent.findMany.mockResolvedValue([]);
  db.salaryComponent.findUnique.mockResolvedValue(null);
  db.salaryComponent.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "sc-new", createdAt: new Date(), updatedAt: new Date(), ...data,
  }));
  db.salaryComponent.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...CATALOG_ROW, ...data,
  }));
  db.salaryComponent.delete.mockResolvedValue({ id: CATALOG_ROW.id });
  db.salaryStructure.findMany.mockResolvedValue([]);
  db.salaryStructure.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ss-new", ...data }));
  db.salaryStructure.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ss-1", ...data }));
  db.salaryStructure.updateMany.mockResolvedValue({ count: 0 });
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  // S4 — the derivation reads employment windows from profiles.
  db.employeeProfile.findMany.mockResolvedValue([]);
  db.leaveType.findMany.mockResolvedValue([]);
  db.payrollRun.findUnique.mockResolvedValue(null);
  // P1 (F2.3) — the adjustment adapter stays empty by default.
  db.payAdjustment.findMany.mockResolvedValue([]);
  db.payrollRun.findMany.mockResolvedValue([]);
  db.payrollRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "run-new", period: "2026-11", createdAt: new Date(), lockedById: "", lockedAt: null, ...data,
    payslips: (((data.payslips as { create?: unknown[] } | undefined)?.create) ?? []).map((_: unknown, i: number) => ({ id: `ps-${i}` })),
  }));
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("F1.5 — RBAC (payroll:manage = ADMIN + HR only)", () => {
  it("MANAGER is denied on every catalog action", async () => {
    requirePermissionMock.mockImplementation(denyFor("payroll:manage"));
    const a = await getSalaryComponents();
    const b = await saveSalaryComponent({ code: "x", label: "X", kind: "EARNING", mode: "FIXED", defaultAmount: 1 });
    const c = await deleteSalaryComponent({ id: "sc-1" });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(c.ok).toBe(false);
    expect(db.salaryComponent.findMany).not.toHaveBeenCalled();
    expect(db.salaryComponent.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Catalog CRUD
// ---------------------------------------------------------------------------

describe("F1.5 — catalog CRUD", () => {
  it("getSalaryComponents serializes rows ordered by the query", async () => {
    db.salaryComponent.findMany.mockResolvedValue([CATALOG_ROW]);
    const res = await getSalaryComponents();
    expect(res.ok).toBe(true);
    expect(db.salaryComponent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }),
    );
    if (res.ok) {
      expect(res.data[0]).toEqual({
        id: "sc-1", code: "senior_basic", label: "Senior Basic Salary",
        kind: "EARNING", mode: "FIXED", defaultAmount: 84_000,
        isActive: true, sortOrder: 10, createdAt: CATALOG_ROW.createdAt.toISOString(),
      });
    }
  });

  it("saveSalaryComponent creates with the payload and audits", async () => {
    const res = await saveSalaryComponent({
      code: "senior_basic", label: "Senior Basic Salary", kind: "EARNING",
      mode: "FIXED", defaultAmount: 84_000, isActive: true, sortOrder: 10,
    });
    expect(res.ok).toBe(true);
    expect(db.salaryComponent.create).toHaveBeenCalledWith({
      data: {
        code: "senior_basic", label: "Senior Basic Salary", kind: "EARNING",
        mode: "FIXED", defaultAmount: 84_000,
        dependsOnPaymentDays: true, // S6 — schema default rides the payload
        isActive: true, sortOrder: 10,
      },
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.component_created" }));
  });

  it("saveSalaryComponent updates by id (code locked at the row, not in the where)", async () => {
    db.salaryComponent.findUnique.mockResolvedValue(CATALOG_ROW);
    const res = await saveSalaryComponent({
      id: "sc-1", code: "senior_basic", label: "Senior Basic (2027)",
      kind: "EARNING", mode: "FIXED", defaultAmount: 90_000, isActive: false, sortOrder: 10,
    });
    expect(res.ok).toBe(true);
    expect(db.salaryComponent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sc-1" } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.component_updated" }));
  });

  it("saveSalaryComponent maps a duplicate code to a friendly error naming the code", async () => {
    db.salaryComponent.findUnique.mockResolvedValue(CATALOG_ROW);
    db.salaryComponent.update.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await saveSalaryComponent({
      id: "sc-1", code: "senior_basic", label: "X", kind: "EARNING", mode: "FIXED", defaultAmount: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("senior_basic");
    expect(res.ok === false && res.error).toContain("already in the catalog");

    db.salaryComponent.findUnique.mockResolvedValue(null);
    db.salaryComponent.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    const create = await saveSalaryComponent({
      code: "senior_basic", label: "X", kind: "EARNING", mode: "FIXED", defaultAmount: 1,
    });
    expect(create.ok).toBe(false);
    expect(create.ok === false && create.error).toContain("senior_basic");
  });

  it("saveSalaryComponent rejects malformed codes and kinds at the schema gate", async () => {
    const badCode = await saveSalaryComponent({ code: "Bad Code!", label: "X", kind: "EARNING", mode: "FIXED", defaultAmount: 1 });
    expect(badCode.ok).toBe(false);
    const badKind = await saveSalaryComponent({ code: "ok_code", label: "X", kind: "BONUS", mode: "FIXED", defaultAmount: 1 });
    expect(badKind.ok).toBe(false);
    expect(db.salaryComponent.create).not.toHaveBeenCalled();
  });

  it("deleteSalaryComponent removes the row and audits that structures keep their copies", async () => {
    db.salaryComponent.findUnique.mockResolvedValue(CATALOG_ROW);
    const res = await deleteSalaryComponent({ id: "sc-1" });
    expect(res.ok).toBe(true);
    expect(db.salaryComponent.delete).toHaveBeenCalledWith({ where: { id: "sc-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.component_deleted",
      detail: expect.stringContaining("keep their copies"),
    }));
  });

  it("deleteSalaryComponent refuses an unknown id", async () => {
    const res = await deleteSalaryComponent({ id: "sc-nope" });
    expect(res.ok).toBe(false);
    expect(db.salaryComponent.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F-R1 — retire + create as ONE transaction
// ---------------------------------------------------------------------------

describe("F-R1 — transactional structure retirement", () => {
  it("saveSalaryStructure retires + creates inside ONE $transaction", async () => {
    const res = await saveSalaryStructure({ userId: "u-yuki", components: OFFER_COMPONENTS });
    expect(res.ok).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.salaryStructure.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-yuki", isActive: true }, data: { isActive: false } }),
    );
    expect(db.salaryStructure.create).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.structure_saved" }));
  });

  it("a structure REVISION (id present) stays a single write, no transaction", async () => {
    const res = await saveSalaryStructure({
      id: "ss-1", userId: "u-yuki", components: OFFER_COMPONENTS,
    });
    expect(res.ok).toBe(true);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.salaryStructure.update).toHaveBeenCalledTimes(1);
    expect(db.salaryStructure.updateMany).not.toHaveBeenCalled();
  });

  it("createStructureFromOffer retires + creates (+ registrations) inside ONE $transaction", async () => {
    const res = await createStructureFromOffer({ userId: "u-yuki" });
    expect(res.ok).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.salaryStructure.updateMany).toHaveBeenCalledTimes(1);
    expect(db.salaryStructure.create).toHaveBeenCalledTimes(1);
  });

  it("a crash inside the transaction surfaces as an error (no half-applied state)", async () => {
    (db.$transaction as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const res = await createStructureFromOffer({ userId: "u-yuki" });
    expect(res.ok).toBe(false);
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F1.5 — createStructureFromOffer maps through the catalog
// ---------------------------------------------------------------------------

describe("F1.5 — createStructureFromOffer maps offer lines through the catalog", () => {
  it("canonicalizes label/kind/mode from the catalog and keeps the offer's amount", async () => {
    db.salaryComponent.findMany.mockResolvedValue([
      { code: "senior_basic", label: "Senior Basic Salary", kind: "EARNING", mode: "FIXED" },
    ]);
    const res = await createStructureFromOffer({ userId: "u-yuki" });
    expect(res.ok).toBe(true);
    const createArg = db.salaryStructure.create.mock.calls[0][0] as { data: { components: string } };
    const lines = JSON.parse(createArg.data.components) as typeof OFFER_COMPONENTS;
    // Known code: catalog label wins, amount stays the OFFER's actual.
    expect(lines[0]).toEqual({
      key: "senior_basic", label: "Senior Basic Salary", kind: "EARNING", mode: "FIXED", amount: 90_000,
    });
    // Unknown code: passes through verbatim.
    expect(lines[1]).toEqual(OFFER_COMPONENTS[1]);
  });

  it("auto-registers unknown codes (with the offer's sighting) inside the same transaction", async () => {
    db.salaryComponent.findMany.mockResolvedValue([
      { code: "senior_basic", label: "Senior Basic Salary", kind: "EARNING", mode: "FIXED" },
    ]);
    const res = await createStructureFromOffer({ userId: "u-yuki" });
    expect(res.ok).toBe(true);
    expect(db.salaryComponent.create).toHaveBeenCalledTimes(1);
    expect(db.salaryComponent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code: "car_allowance", label: "Car Allowance", kind: "EARNING", mode: "FIXED",
        defaultAmount: 4_800, isActive: true, sortOrder: 1000,
      }),
    });
    // The registration rode the SAME transaction as retire+create (F-R1 +
    // F1.5 atomicity: no catalog row without its structure).
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "payroll.structure_from_offer",
      detail: expect.stringContaining("auto-registering 1 new component code(s): car_allowance"),
    }));
  });

  it("registers NOTHING when the catalog already knows every code", async () => {
    db.salaryComponent.findMany.mockResolvedValue([
      { code: "senior_basic", label: "Senior Basic Salary", kind: "EARNING", mode: "FIXED" },
      { code: "car_allowance", label: "Car Allowance", kind: "EARNING", mode: "FIXED" },
    ]);
    const res = await createStructureFromOffer({ userId: "u-yuki" });
    expect(res.ok).toBe(true);
    expect(db.salaryComponent.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F1.5 acceptance — the picker roundtrip: catalog row → structure line →
// payslip line
// ---------------------------------------------------------------------------

describe("F1.5 — catalog → structure → payslip roundtrip", () => {
  it("a catalog-prefilled structure line reaches the payslip as a monthly line with the catalog label", async () => {
    // 1. The catalog holds the definition.
    db.salaryComponent.findMany.mockResolvedValue([CATALOG_ROW]);

    // 2. The picker prefills a structure line from the serialized row
    //    (exactly what structure-modal's addFromCatalog does).
    const rows = await getSalaryComponents();
    expect(rows.ok).toBe(true);
    const catalogRows: SalaryComponentT[] = rows.ok ? rows.data : [];
    const picked = catalogRows
      .filter((c) => c.isActive)
      .map((c) => ({ key: c.code, label: c.label, kind: c.kind, mode: c.mode, amount: c.defaultAmount }));
    expect(picked).toEqual([{
      key: "senior_basic", label: "Senior Basic Salary",
      kind: "EARNING", mode: "FIXED", amount: 84_000,
    }]);

    // 3. The structure saves those lines.
    const saved = await saveSalaryStructure({ userId: "u-yuki", components: picked });
    expect(saved.ok).toBe(true);
    const structureArg = db.salaryStructure.create.mock.calls[0][0] as { data: { components: string } };
    const savedComponents = JSON.parse(structureArg.data.components);

    // 4. createPayrollRun snapshots the structure into payslip lines
    //    (monthly = annual ÷ 12, EARNING lines only).
    db.salaryStructure.findMany.mockResolvedValue([{
      id: "ss-new", userId: "u-yuki",
      components: structureArg.data.components,
      isActive: true,
    }]);
    const run = await createPayrollRun({ period: "2026-11" });
    expect(run.ok).toBe(true);
    const runArg = db.payrollRun.create.mock.calls[0][0] as {
      data: { payslips: { create: Array<{ userId: string; earnings: string; gross: number }> } };
    };
    const slip = runArg.data.payslips.create[0];
    expect(slip.userId).toBe("u-yuki");
    expect(JSON.parse(slip.earnings)).toEqual([
      { key: "senior_basic", label: "Senior Basic Salary", amount: 7_000 },
    ]);
    expect(slip.gross).toBe(7_000);
    void savedComponents;
  });
});
