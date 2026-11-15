import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// ADR-021 coverage work — the payday-filing action wrapper (Phase 2) had
// ZERO direct tests: the pure kernels (lib/ird/*) are golden-file tested and
// the filing service is exercised through them, but the wrapper's own
// branches (zod guards, IRD validation ordering, panel joins, regeneration
// detection, audit detail variants, list filters) were the single biggest
// hole in the server-actions branch number. This file pins the wrapper's
// contract at the filing-service seam: the service is mocked (it has its
// own suite), the db is mocked at the client boundary (repo convention),
// and the pure helpers (ird-number mod-11, pay-cycle, deadline math,
// toCents) run for real.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "payrollSettings",
    "paydayFiling",
    "paydayFilingLine",
    "payslip",
    "payrollRun",
    "paydayAmendmentFiling",
    "employeeDetailsFiling",
  ];
  const methods = ["findUnique", "findMany", "create", "update", "upsert", "delete", "deleteMany", "count"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

// The filing-service seam — every name payday-filing.ts imports.
const service = vi.hoisted(() => ({
  getFilingSettings: vi.fn(),
  generatePaydayFiling: vi.fn(),
  markFiled: vi.fn(),
  markAccepted: vi.fn(),
  markRejected: vi.fn(),
  flagOverdueFilings: vi.fn(),
  listPendingEmployeeDetails: vi.fn(),
  generateEmployeeDetails: vi.fn(),
  markEmployeeDetailsFiled: vi.fn(),
  markEmployeeDetailsAccepted: vi.fn(),
  markEmployeeDetailsRejected: vi.fn(),
  generateAmendmentFiling: vi.fn(),
  markAmendmentFiled: vi.fn(),
  markAmendmentAccepted: vi.fn(),
}));
vi.mock("@/lib/ird/filing-service", () => service);

const reconcileMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ird/reconciliation", () => ({ reconcilePaydayFiling: reconcileMock }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => {
  class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) {
      super(m);
      this.name = "AuthorizationError";
    }
  }
  return {
    getSession: vi.fn(),
    getSessionOrThrow: async () => {
      throw new AuthorizationError("You must be signed in.");
    },
    requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
    AuthorizationError,
  };
});

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  recalcMemberStats: vi.fn(),
  getProjectAssociatedUserIds: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  getPayrollFilingSettings,
  savePayrollFilingSettings,
  getRunFilingPanel,
  generatePaydayFilingAction,
  downloadPaydayFilingFile,
  markPaydayFilingFiled,
  markPaydayFilingAccepted,
  markPaydayFilingRejected,
  listPaydayFilings,
  refreshOverdueFilings,
  getRunFilingStatus,
  getEmployeeDetailsView,
  generateEmployeeDetailsAction,
  downloadEmployeeDetailsFile,
  markEmployeeDetailsFiledAction,
  markEmployeeDetailsAcceptedAction,
  markEmployeeDetailsRejectedAction,
  listFilingLines,
  generateAmendmentFilingAction,
  downloadAmendmentFile,
  markAmendmentFiledAction,
  markAmendmentAcceptedAction,
} from "../payday-filing";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Admin", email: "a@x.co" };

// 123123123 — mod-11 valid + inside IRD's issued range (pinned by
// lib/ird/__tests__/ird-number.test.ts).
const VALID_IRD = "123123123";

/** A full PaydayFiling row (every toSummary field). */
function filingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "f-1",
    employerIrd: VALID_IRD,
    payDate: new Date("2026-11-11T00:00:00.000Z"),
    periodStart: new Date("2026-11-01T00:00:00.000Z"),
    periodEnd: new Date("2026-11-07T00:00:00.000Z"),
    payCycle: "FORTNIGHTLY",
    status: "GENERATED",
    totalEmployeeLines: 3,
    totalGrossCents: 100_000,
    totalPayeCents: 20_000,
    totalKiwisaverEmployeeCents: 3_000,
    totalKiwisaverEmployerNetCents: 3_000,
    totalEsctCents: 30,
    totalStudentLoanCents: 0,
    dueDate: new Date("2026-11-13T00:00:00.000Z"),
    overdueFlaggedAt: null,
    generatedAt: new Date("2026-11-11T01:00:00.000Z"),
    generatedById: "u-admin",
    filedAt: null,
    filedById: null,
    irdReference: null,
    acceptedAt: null,
    rejectedAt: null,
    irdErrorReport: null,
    amendedByFilingId: null,
    fileContent: "employerIrd,payDate\n123123123,20261111",
    fileHash: "abcdef0123456789",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  logAuditMock.mockResolvedValue(undefined);
  service.getFilingSettings.mockResolvedValue(null);
  service.markFiled.mockResolvedValue(undefined);
  service.markAccepted.mockResolvedValue(undefined);
  service.markRejected.mockResolvedValue(undefined);
  service.flagOverdueFilings.mockResolvedValue(0);
  service.listPendingEmployeeDetails.mockResolvedValue([]);
  service.generateEmployeeDetails.mockResolvedValue({ ids: ["ed-1", "ed-2"], employeeLineCount: 2 });
  service.markEmployeeDetailsFiled.mockResolvedValue(undefined);
  service.markEmployeeDetailsAccepted.mockResolvedValue(undefined);
  service.markEmployeeDetailsRejected.mockResolvedValue(undefined);
  service.generateAmendmentFiling.mockResolvedValue({ id: "am-1", pairCount: 2 });
  service.markAmendmentFiled.mockResolvedValue(undefined);
  service.markAmendmentAccepted.mockResolvedValue(undefined);
  reconcileMock.mockResolvedValue({ filingId: "f-1", checks: [] });
  for (const m of Object.values(db)) {
    for (const meth of Object.values(m)) meth.mockResolvedValue(undefined);
  }
  db.paydayFiling.findMany.mockResolvedValue([]);
  db.paydayFilingLine.findMany.mockResolvedValue([]);
  db.payslip.findMany.mockResolvedValue([]);
  db.payrollRun.findMany.mockResolvedValue([]);
  db.paydayAmendmentFiling.findMany.mockResolvedValue([]);
  db.employeeDetailsFiling.findMany.mockResolvedValue([]);
  db.payrollSettings.upsert.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("payday-filing settings", () => {
  it("returns null when no settings row exists", async () => {
    service.getFilingSettings.mockResolvedValue(null);
    const res = await getPayrollFilingSettings();
    expect(res).toEqual({ ok: true, data: null });
  });

  it("maps the settings row, defaulting a missing intermediary to \"\"", async () => {
    service.getFilingSettings.mockResolvedValue({
      employerIrdNumber: VALID_IRD,
      employerName: "Fernly Ltd",
      payeIntermediaryIrd: null,
      payrollContactName: "Payroll Team",
      payrollContactPhone: "0212345678",
      payrollContactEmail: "payroll@fernly.example",
      payrollPackageIdentifier: "Fernly v1.0",
      irFormVersionNumber: "0001",
    });
    const res = await getPayrollFilingSettings();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toMatchObject({ employerIrdNumber: VALID_IRD, payeIntermediaryIrd: "" });
  });

  const baseSettings = {
    employerIrdNumber: VALID_IRD,
    employerName: "Fernly Ltd",
    payeIntermediaryIrd: "",
    payrollContactName: "Payroll Team",
    payrollContactPhone: "0212345678",
    payrollContactEmail: "payroll@fernly.example",
    payrollPackageIdentifier: "Fernly v1.0",
    irFormVersionNumber: "0001",
  };

  it("saves valid settings (with intermediary) through the upsert", async () => {
    // A PAYE intermediary is validated with the same employer IRD rule —
    // 123123123 is the pinned-valid example from the ird-number suite.
    const res = await savePayrollFilingSettings({ ...baseSettings, payeIntermediaryIrd: "123123123" });
    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(db.payrollSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: expect.objectContaining({
          employerIrdNumber: "123123123",
          payeIntermediaryIrd: "123123123",
        }),
        create: expect.objectContaining({ id: "default" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an employer IRD that fails the mod-11 check", async () => {
    const res = await savePayrollFilingSettings({ ...baseSettings, employerIrdNumber: "123456789" });
    expect(res).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("not a valid employer IRD number") });
    expect(db.payrollSettings.upsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid PAYE intermediary IRD but allows leaving it blank", async () => {
    const bad = await savePayrollFilingSettings({ ...baseSettings, payeIntermediaryIrd: "123456789" });
    expect(bad).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("intermediary") });
    const blank = await savePayrollFilingSettings({ ...baseSettings, payeIntermediaryIrd: "" });
    expect(blank.ok).toBe(true);
  });

  it("rejects commas in the contact name and the package identifier", async () => {
    const name = await savePayrollFilingSettings({ ...baseSettings, payrollContactName: "Team, Payroll" });
    expect(name).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("Commas are never allowed") });
    const pkg = await savePayrollFilingSettings({ ...baseSettings, payrollPackageIdentifier: "Fernly, v1.0" });
    expect(pkg).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("Commas are never allowed") });
  });

  it("rejects a phone with symbols and a malformed email", async () => {
    const phone = await savePayrollFilingSettings({ ...baseSettings, payrollContactPhone: "021 234 5678" });
    expect(phone).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("digits") });
    const email = await savePayrollFilingSettings({ ...baseSettings, payrollContactEmail: "not-an-email" });
    expect(email).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("valid email") });
  });

  it("surfaces a zod failure as a VALIDATION result", async () => {
    const res = await savePayrollFilingSettings({ ...baseSettings, irFormVersionNumber: "0002" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// Run filing panel
// ---------------------------------------------------------------------------

describe("getRunFilingPanel", () => {
  it("errors when the run does not exist", async () => {
    db.payrollRun.findUnique.mockResolvedValue(null);
    const res = await getRunFilingPanel({ runId: "run-x" });
    expect(res).toEqual({ ok: false, code: "AUTH", error: "Payroll run not found." });
  });

  it("returns an empty panel for a run with no slips", async () => {
    db.payrollRun.findUnique.mockResolvedValue({
      id: "run-1", period: "2026-11-01", frequency: "MONTHLY", status: "PAID",
      startDate: null, endDate: null, payDate: null,
    });
    db.payslip.findMany.mockResolvedValue([]);
    const res = await getRunFilingPanel({ runId: "run-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.filing).toBeNull();
    expect(res.data.amendments).toEqual([]);
    expect(res.data.reconciliation).toBeNull();
  });

  it("joins slips → lines → filing, reconciles and lists amendments", async () => {
    db.payrollRun.findUnique.mockResolvedValue({
      id: "run-1", period: "2026-11-01", frequency: "FORTNIGHTLY", status: "PAID",
      startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-07T00:00:00Z"),
      payDate: new Date("2026-11-11T00:00:00Z"),
    });
    db.payslip.findMany.mockResolvedValue([{ id: "slip-1" }, { id: "slip-2" }]);
    db.paydayFilingLine.findMany.mockResolvedValue([{ filingId: "f-1" }, { filingId: "f-1" }]);
    db.paydayFiling.findMany.mockResolvedValue([filingRow()]);
    db.paydayAmendmentFiling.findMany.mockResolvedValue([
      { id: "am-1", status: "GENERATED", correctionCount: 2, generatedAt: new Date("2026-11-12T00:00:00Z"), filedAt: null, acceptedAt: null },
    ]);
    reconcileMock.mockResolvedValue({ filingId: "f-1", checks: [{ id: "gross", pass: true }] });
    const res = await getRunFilingPanel({ runId: "run-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.filingCadenceSupported).toBe(true);
    expect(res.data.filing?.id).toBe("f-1");
    expect(res.data.filing?.hasFile).toBe(true);
    expect(res.data.filing?.workingDaysRemaining).toBeTypeOf("number");
    expect(res.data.reconciliation).toEqual({ filingId: "f-1", checks: [{ id: "gross", pass: true }] });
    expect(res.data.amendments[0]).toMatchObject({ id: "am-1", correctionCount: 2 });
  });

  it("shows a false cadence flag and a null reconciliation when the engine throws", async () => {
    db.payrollRun.findUnique.mockResolvedValue({
      id: "run-1", period: "2026-11-01", frequency: "ANNUAL", status: "PAID",
      startDate: null, endDate: null, payDate: null,
    });
    db.payslip.findMany.mockResolvedValue([{ id: "slip-1" }]);
    db.paydayFilingLine.findMany.mockResolvedValue([{ filingId: "f-1" }]);
    db.paydayFiling.findMany.mockResolvedValue([filingRow()]);
    reconcileMock.mockRejectedValue(new Error("line sum mismatch"));
    const res = await getRunFilingPanel({ runId: "run-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.filingCadenceSupported).toBe(false);
    expect(res.data.reconciliation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Generate / download / mark — the EI lifecycle
// ---------------------------------------------------------------------------

describe("the EI filing lifecycle actions", () => {
  it("generates a first filing and audits it as a fresh generation", async () => {
    db.payslip.findMany.mockResolvedValue([{ id: "slip-1" }]);
    db.paydayFilingLine.findMany.mockResolvedValue([]);
    service.generatePaydayFiling.mockResolvedValue({
      id: "f-9", payDate: new Date("2026-11-11T00:00:00Z"), dueDate: new Date("2026-11-13T00:00:00Z"),
      totalEmployeeLines: 4, reconciliation: { checks: [{ pass: true }] },
    });
    const res = await generatePaydayFilingAction({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payday.filing_generated" }),
    );
  });

  it("audits a regeneration when the run's payslips already have filing lines", async () => {
    db.payslip.findMany.mockResolvedValue([{ id: "slip-1" }]);
    db.paydayFilingLine.findMany.mockResolvedValue([{ filingId: "f-1" }]);
    service.generatePaydayFiling.mockResolvedValue({
      id: "f-10", payDate: new Date("2026-11-11T00:00:00Z"), dueDate: new Date("2026-11-13T00:00:00Z"),
      totalEmployeeLines: 4, reconciliation: { checks: [] },
    });
    const res = await generatePaydayFilingAction({ runId: "run-1" });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payday.filing_regenerated" }),
    );
  });

  it("refuses to download an unknown filing or one without content", async () => {
    db.paydayFiling.findUnique.mockResolvedValue(null);
    const missing = await downloadPaydayFilingFile({ filingId: "f-404" });
    expect(missing).toEqual({ ok: false, code: "AUTH", error: "Payday filing not found." });
    db.paydayFiling.findUnique.mockResolvedValue(filingRow({ fileContent: null }));
    const empty = await downloadPaydayFilingFile({ filingId: "f-1" });
    expect(empty).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("no stored file content") });
  });

  it("downloads the stored EI file with a hash in the audit detail", async () => {
    db.paydayFiling.findUnique.mockResolvedValue(filingRow());
    const res = await downloadPaydayFilingFile({ filingId: "f-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.filename).toBe(`EI-${VALID_IRD}-20261111.csv`);
    expect(res.data.mime).toBe("text/csv");
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payday.filing_downloaded" }),
    );
  });

  it("marks filed with and without an IRD reference", async () => {
    db.paydayFiling.findUnique.mockResolvedValue(filingRow());
    const withRef = await markPaydayFilingFiled({ filingId: "f-1", irdReference: "IRD-REF-1" });
    expect(withRef).toEqual({ ok: true, data: { ok: true } });
    expect(service.markFiled).toHaveBeenCalledWith("f-1", { filedById: "u-admin", irdReference: "IRD-REF-1" });
    const noRef = await markPaydayFilingFiled({ filingId: "f-1" });
    expect(noRef.ok).toBe(true);
    expect(service.markFiled).toHaveBeenCalledWith("f-1", { filedById: "u-admin", irdReference: null });
  });

  it("marks accepted, and rejected with the error report truncated at 200 chars", async () => {
    const accepted = await markPaydayFilingAccepted({ filingId: "f-1" });
    expect(accepted).toEqual({ ok: true, data: { ok: true } });
    expect(service.markAccepted).toHaveBeenCalledWith("f-1");

    const short = await markPaydayFilingRejected({ filingId: "f-1", errorReport: "line 3 bad" });
    expect(short.ok).toBe(true);
    const long = await markPaydayFilingRejected({ filingId: "f-1", errorReport: "x".repeat(250) });
    expect(long.ok).toBe(true);
    // The short report renders whole; the long one is truncated with an
    // ellipsis in the audit detail.
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payday.filing_marked_rejected", detail: expect.stringContaining("…") }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payday.filing_marked_rejected", detail: expect.not.stringContaining("…") }),
    );
  });
});

// ---------------------------------------------------------------------------
// Filings list + overdue refresh + run badges
// ---------------------------------------------------------------------------

describe("listPaydayFilings / refreshOverdueFilings / getRunFilingStatus", () => {
  it("maps filings to their run periods (deduped) and applies the status filter", async () => {
    db.paydayFiling.findMany.mockResolvedValue([filingRow(), filingRow({ id: "f-2", status: "FILED" })]);
    db.paydayFilingLine.findMany.mockResolvedValue([
      { filingId: "f-1", payslipId: "s-1" },
      { filingId: "f-1", payslipId: "s-2" }, // same run → dedupe
      { filingId: "f-1", payslipId: "s-404" }, // unknown slip → skipped
    ]);
    db.payslip.findMany.mockResolvedValue([{ id: "s-1", runId: "run-1" }, { id: "s-2", runId: "run-1" }]);
    db.payrollRun.findMany.mockResolvedValue([{ id: "run-1", period: "2026-11-01" }]);

    const all = await listPaydayFilings();
    if (!all.ok) throw new Error("expected ok");
    expect(all.data).toHaveLength(2);
    expect(all.data[0].runPeriods).toEqual(["2026-11-01"]);

    const filed = await listPaydayFilings({ status: "FILED" });
    if (!filed.ok) throw new Error("expected ok");
    expect(filed.data.map((f) => f.id)).toEqual(["f-2"]);
  });

  it("the overdue filter keeps only past-due, unaccepted filings", async () => {
    db.paydayFiling.findMany.mockResolvedValue([
      filingRow({ id: "late", dueDate: new Date("2026-01-01T00:00:00Z"), status: "GENERATED" }),
      filingRow({ id: "late-accepted", dueDate: new Date("2026-01-01T00:00:00Z"), status: "ACCEPTED" }),
      filingRow({ id: "late-amended", dueDate: new Date("2026-01-01T00:00:00Z"), status: "AMENDED" }),
      filingRow({ id: "on-time", dueDate: new Date("2999-01-01T00:00:00Z"), status: "GENERATED" }),
    ]);
    const res = await listPaydayFilings({ overdue: true });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.map((f) => f.id)).toEqual(["late"]);
  });

  it("refreshOverdueFilings audits only when something was newly flagged", async () => {
    service.flagOverdueFilings.mockResolvedValue(3);
    const flagged = await refreshOverdueFilings();
    expect(flagged).toEqual({ ok: true, data: { flagged: 3 } });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    service.flagOverdueFilings.mockResolvedValue(0);
    const none = await refreshOverdueFilings();
    expect(none).toEqual({ ok: true, data: { flagged: 0 } });
    expect(logAuditMock).toHaveBeenCalledTimes(1); // unchanged
  });

  it("getRunFilingStatus badges runs, skipping orphan lines and keeping the first filing", async () => {
    db.paydayFilingLine.findMany.mockResolvedValue([
      { filingId: "f-1", payslipId: "s-1" },
      { filingId: "f-2", payslipId: "s-1" }, // same run — first wins
      { filingId: "f-404", payslipId: "s-1" }, // unknown filing → skipped
      { filingId: "f-1", payslipId: "s-404" }, // unknown slip → skipped
    ]);
    db.payslip.findMany.mockResolvedValue([{ id: "s-1", runId: "run-1" }]);
    db.paydayFiling.findMany.mockResolvedValue([
      { id: "f-1", status: "FILED", dueDate: new Date("2026-11-13T00:00:00Z") },
      { id: "f-2", status: "ACCEPTED", dueDate: new Date("2026-11-13T00:00:00Z") },
    ]);
    const res = await getRunFilingStatus();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({
      "run-1": { status: "FILED", filingId: "f-1", dueDate: "2026-11-13T00:00:00.000Z" },
    });
  });
});

// ---------------------------------------------------------------------------
// Employee Details
// ---------------------------------------------------------------------------

describe("the Employee Details actions", () => {
  it("derives the period from periodKey and defaults to the current month", async () => {
    db.employeeDetailsFiling.findMany.mockResolvedValue([
      {
        id: "ed-1", employeeId: "u-1", employeeName: "Ada", employeeIrd: VALID_IRD, kind: "NEW",
        status: "GENERATED", generatedAt: new Date("2026-11-02T00:00:00Z"), filedAt: null,
        acceptedAt: null, rejectedAt: null, irdErrorReport: null,
      },
    ]);
    const res = await getEmployeeDetailsView({ periodKey: "2026-10" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.periodKey).toBe("2026-10");
    expect(service.listPendingEmployeeDetails).toHaveBeenCalledWith(
      new Date("2026-10-01T00:00:00.000Z"),
      new Date("2026-10-31T00:00:00.000Z"),
    );
    expect(res.data.filed[0]).toMatchObject({ id: "ed-1", generatedAt: "2026-11-02T00:00:00.000Z", filedAt: null });

    const nowRes = await getEmployeeDetailsView();
    if (!nowRes.ok) throw new Error("expected ok");
    expect(nowRes.data.periodKey).toMatch(/^\d{4}-\d{2}$/);
  });

  it("generates an ED file for selected employees and validates the selection", async () => {
    const res = await generateEmployeeDetailsAction({ employeeIds: ["u-1", "u-2"] });
    expect(res).toEqual({ ok: true, data: { ids: ["ed-1", "ed-2"], employeeLineCount: 2 } });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payday.employee_details_generated", entityId: "ed-1" }),
    );
    const empty = await generateEmployeeDetailsAction({ employeeIds: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("VALIDATION");
  });

  it("refuses to download an unknown or content-less ED filing, then downloads it", async () => {
    db.employeeDetailsFiling.findUnique.mockResolvedValue(null);
    const missing = await downloadEmployeeDetailsFile({ id: "ed-404" });
    expect(missing).toEqual({ ok: false, code: "AUTH", error: "Employee details filing not found." });
    db.employeeDetailsFiling.findUnique.mockResolvedValue({ fileContent: null });
    const empty = await downloadEmployeeDetailsFile({ id: "ed-1" });
    expect(empty).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("no stored file content") });
    db.employeeDetailsFiling.findUnique.mockResolvedValue({
      fileContent: "kind,employeeIrd\nNEW,123123123", employerIrd: VALID_IRD, kind: "NEW",
    });
    const res = await downloadEmployeeDetailsFile({ id: "ed-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.filename).toContain(`ED-${VALID_IRD}`);
    expect(res.data.filename).toContain("NEW");
  });

  it("marks ED filings filed / accepted / rejected", async () => {
    expect(await markEmployeeDetailsFiledAction({ id: "ed-1" })).toEqual({ ok: true, data: { ok: true } });
    expect(service.markEmployeeDetailsFiled).toHaveBeenCalledWith("ed-1", { filedById: "u-admin" });
    expect(await markEmployeeDetailsAcceptedAction({ id: "ed-1" })).toEqual({ ok: true, data: { ok: true } });
    expect(service.markEmployeeDetailsAccepted).toHaveBeenCalledWith("ed-1");
    expect(await markEmployeeDetailsRejectedAction({ id: "ed-1", errorReport: "bad line" })).toEqual({ ok: true, data: { ok: true } });
    expect(service.markEmployeeDetailsRejected).toHaveBeenCalledWith("ed-1", { errorReport: "bad line" });
    const invalid = await markEmployeeDetailsRejectedAction({ id: "ed-1", errorReport: "" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// Amendments (EIA2)
// ---------------------------------------------------------------------------

describe("the EIA2 amendment actions", () => {
  it("lists a filing's lines for the amendment form", async () => {
    db.paydayFilingLine.findMany.mockResolvedValue([
      { employeeId: "u-1", employeeName: "Ada", grossCents: 1000, payeCents: 200 },
    ]);
    const res = await listFilingLines({ filingId: "f-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data[0]).toEqual({ employeeId: "u-1", employeeName: "Ada", grossCents: 1000, payeCents: 200 });
    expect(db.paydayFilingLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { filingId: "f-1" } }),
    );
  });

  it("maps numeric corrections to cents and deletions to a null amendment", async () => {
    await generateAmendmentFilingAction({
      originalFilingId: "f-1",
      corrections: [
        {
          employeeId: "u-1", gross: 1000.5, paye: 200.25, studentLoan: 10,
          kiwisaverEmployee: 30, kiwisaverEmployerNet: 30, esct: 0.5,
        },
        { employeeId: "u-2", delete: true },
      ],
    });
    expect(service.generateAmendmentFiling).toHaveBeenCalledWith(
      "f-1",
      [
        {
          employeeId: "u-1",
          amended: {
            grossCents: 100_050, payeCents: 20_025, studentLoanCents: 1000,
            kiwisaverEmployeeCents: 3000, kiwisaverEmployerNetCents: 3000, esctCents: 50,
          },
        },
        { employeeId: "u-2", amended: null },
      ],
      { generatedById: "u-admin" },
    );
  });

  it("validates that at least one correction is present", async () => {
    const res = await generateAmendmentFilingAction({ originalFilingId: "f-1", corrections: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });

  it("refuses to download an unknown or content-less amendment, then downloads it", async () => {
    db.paydayAmendmentFiling.findUnique.mockResolvedValue(null);
    const missing = await downloadAmendmentFile({ id: "am-404" });
    expect(missing).toEqual({ ok: false, code: "AUTH", error: "Amendment filing not found." });
    db.paydayAmendmentFiling.findUnique.mockResolvedValue({ fileContent: null });
    const empty = await downloadAmendmentFile({ id: "am-1" });
    expect(empty).toEqual({ ok: false, code: "AUTH", error: expect.stringContaining("no stored file content") });
    db.paydayAmendmentFiling.findUnique.mockResolvedValue({
      fileContent: "dti\n1", employerIrd: VALID_IRD, payDate: new Date("2026-11-11T00:00:00Z"),
    });
    const res = await downloadAmendmentFile({ id: "am-1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.filename).toBe(`EIA2-${VALID_IRD}-20261111.csv`);
  });

  it("marks amendments filed and accepted", async () => {
    expect(await markAmendmentFiledAction({ id: "am-1" })).toEqual({ ok: true, data: { ok: true } });
    expect(service.markAmendmentFiled).toHaveBeenCalledWith("am-1", { filedById: "u-admin" });
    expect(await markAmendmentAcceptedAction({ id: "am-1" })).toEqual({ ok: true, data: { ok: true } });
    expect(service.markAmendmentAccepted).toHaveBeenCalledWith("am-1");
  });
});
