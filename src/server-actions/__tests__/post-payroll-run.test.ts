import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Phase 1C (G2) — post-payroll-run engine tests: the balanced entry, the
// statutory account mapping, idempotency, the out-of-balance guard, the
// closed-period refusal, and the reversal discipline (new entry + immutable
// original). The engine is a lib function (no auth); the reversal + period
// close are the server actions (mocked auth).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "payrollRun", "payslip", "salaryComponent",
    "ledgerAccount", "accountingPeriod", "journalEntry", "journalEntryLine",
    "auditLog",
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

import {
  postPayrollRun,
  buildPayrollJournalLines,
  journalBalance,
  type PostingPayslip,
  type BuildLinesContext,
} from "@/lib/accounting/post-payroll-run";
import { reverseJournalEntry, closePeriod } from "@/server-actions/accounting";

const HR_AUTH = { userId: "u-hr", role: "ADMIN" as const, name: "Remy", email: "remy@x.co" };
const d = (iso: string) => new Date(iso);
const dec = (n: number) => ({ toNumber: () => n });

/** The chart rows the engine resolves (code → id). */
const ACCOUNTS: Record<string, { id: string; code: string; name: string; type: string; isActive: boolean; isSystem: boolean }> = {
  "2100": { id: "acc-2100", code: "2100", name: "PAYE Payable", type: "LIABILITY", isActive: true, isSystem: true },
  "2110": { id: "acc-2110", code: "2110", name: "ACC Payable", type: "LIABILITY", isActive: true, isSystem: true },
  "2120": { id: "acc-2120", code: "2120", name: "KiwiSaver Employee Payable", type: "LIABILITY", isActive: true, isSystem: true },
  "2130": { id: "acc-2130", code: "2130", name: "KiwiSaver Employer Payable", type: "LIABILITY", isActive: true, isSystem: true },
  "2140": { id: "acc-2140", code: "2140", name: "ESCT Payable", type: "LIABILITY", isActive: true, isSystem: true },
  "2150": { id: "acc-2150", code: "2150", name: "Student Loan Payable", type: "LIABILITY", isActive: true, isSystem: true },
  "2200": { id: "acc-2200", code: "2200", name: "Net Pay Clearing", type: "LIABILITY", isActive: true, isSystem: true },
  "4000": { id: "acc-4000", code: "4000", name: "Salaries & Wages", type: "EXPENSE", isActive: true, isSystem: true },
  "4010": { id: "acc-4010", code: "4010", name: "Employer KiwiSaver Expense", type: "EXPENSE", isActive: true, isSystem: true },
};

const OPEN_PERIOD = { id: "per-dec", startDate: d("2026-12-01"), endDate: d("2026-12-31"), isClosed: false };

/** A rich but simple payslip: PAYE + ACC + KS employee + SL, employer KS
 *  gross/net/ESCT — the December demo shape. */
function statutoryPayslip(): PostingPayslip {
  return {
    userId: "u-diego",
    slipNo: "PS-2026-12-004",
    earnings: JSON.stringify([{ key: "basic", label: "Basic Salary", amount: 7000 }]),
    deductions: JSON.stringify([
      { key: "paye", label: "PAYE income tax (STC)", amount: 1260 },
      { key: "acc", label: "ACC earners' levy", amount: 122.5 },
      { key: "ks", label: "KiwiSaver employee 3%", amount: 210 },
      { key: "sl", label: "Student loan repayment", amount: 399.15 },
    ]),
    net: 5008.35, // 7000 − 1991.65
    employerKiwiSaverGross: dec(245),
    employerEsct: dec(73.5),
    employerKiwiSaverNet: dec(171.5),
  };
}

function lockedRun(payslips: PostingPayslip[]) {
  return {
    id: "run-dec",
    period: "2026-12",
    status: "LOCKED",
    startDate: d("2026-12-01"),
    endDate: d("2026-12-31"),
    payslips,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.payrollRun.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "run-dec" ? lockedRun([statutoryPayslip()]) : null,
  );
  db.accountingPeriod.findFirst.mockResolvedValue(OPEN_PERIOD);
  db.journalEntry.findFirst.mockResolvedValue(null);
  db.journalEntry.findUnique.mockResolvedValue(null);
  db.ledgerAccount.findUnique.mockImplementation(async ({ where }: { where: { code: string } }) =>
    ACCOUNTS[where.code] ?? null,
  );
  db.salaryComponent.findMany.mockResolvedValue([]);
  db.journalEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "je-new",
    ...data,
    lines: ((data.lines as { create?: unknown[] } | undefined)?.create ?? []).map(
      (_: unknown, i: number) => ({ id: `jl-${i}` }),
    ),
  }));
  db.accountingPeriod.findUnique.mockResolvedValue(OPEN_PERIOD);
});

describe("postPayrollRun", () => {
  it("builds a BALANCED posted entry from a statutory payslip", async () => {
    const je = await postPayrollRun("run-dec", { postedById: "u-hr" });

    expect(db.journalEntry.create).toHaveBeenCalledTimes(1);
    const arg = db.journalEntry.create.mock.calls[0][0] as {
      data: {
        status: string;
        sourceType: string;
        sourceId: string;
        periodId: string;
        postedById: string | null;
        lines: { create: Array<{ accountId: string; debit: number; credit: number }> };
      };
    };
    expect(arg.data.status).toBe("POSTED");
    expect(arg.data.sourceType).toBe("PAYROLL_RUN");
    expect(arg.data.sourceId).toBe("run-dec");
    expect(arg.data.periodId).toBe("per-dec");
    expect(arg.data.postedById).toBe("u-hr");

    const lines = arg.data.lines.create;
    const { debit, credit } = journalBalance(lines.map((l) => ({ ...l })));
    // Dr = 7,000 (salary) + 245 (employer KS) = 7,245
    expect(debit).toBe(7245);
    // Cr = 1,991.65 statutory + 171.5 employer net + 73.5 ESCT + 5,008.35 net
    expect(credit).toBe(7245);
    expect(je.id).toBe("je-new");
  });

  it("credits each statutory liability on its own account", async () => {
    await postPayrollRun("run-dec");
    const lines = (db.journalEntry.create.mock.calls[0][0] as {
      data: { lines: { create: Array<{ accountId: string; debit: number; credit: number; description?: string }> } };
    }).data.lines.create;

    const creditOf = (id: string) =>
      lines.filter((l) => l.accountId === id).reduce((s, l) => s + l.credit, 0);
    const debitOf = (id: string) =>
      lines.filter((l) => l.accountId === id).reduce((s, l) => s + l.debit, 0);

    expect(creditOf("acc-2100")).toBe(1260);      // PAYE
    expect(creditOf("acc-2110")).toBe(122.5);     // ACC levy
    expect(creditOf("acc-2120")).toBe(210);       // KS employee
    expect(creditOf("acc-2150")).toBe(399.15);    // Student loan
    expect(creditOf("acc-2130")).toBe(171.5);     // KS employer (net)
    expect(creditOf("acc-2140")).toBe(73.5);      // ESCT
    expect(creditOf("acc-2200")).toBe(5008.35);   // Net pay clearing
    expect(debitOf("acc-4000")).toBe(7000);       // Salary expense
    expect(debitOf("acc-4010")).toBe(245);        // Employer KS expense
  });

  it("routes an unmapped non-statutory deduction to the expense account (the balancing leg)", async () => {
    const slip = statutoryPayslip();
    slip.deductions = JSON.stringify([
      ...JSON.parse(slip.deductions),
      { key: "advance_recovery", label: "Advance Recovery", amount: 100 },
    ]);
    slip.net = 4908.35;
    db.payrollRun.findUnique.mockResolvedValue(lockedRun([slip]));

    await postPayrollRun("run-dec");
    const lines = (db.journalEntry.create.mock.calls[0][0] as {
      data: { lines: { create: Array<{ accountId: string; debit: number; credit: number }> } };
    }).data.lines.create;
    // The advance recovery CREDITS 4000 (expense reduction), keeping the
    // entry balanced: Dr 7,245 = Cr 7,245.
    const net4000 = lines
      .filter((l) => l.accountId === "acc-4000")
      .reduce((s, l) => s + l.debit - l.credit, 0);
    expect(net4000).toBe(6900);
    const { debit, credit } = journalBalance(lines);
    expect(debit).toBe(credit);
  });

  it("is idempotent — a second call returns the existing POSTED entry (with lines)", async () => {
    const existing = { id: "je-existing", status: "POSTED", lines: [] };
    db.journalEntry.findFirst.mockResolvedValue(existing);
    const je = await postPayrollRun("run-dec");
    expect(je.id).toBe("je-existing");
    expect(Array.isArray(je.lines)).toBe(true);
    expect(db.journalEntry.create).not.toHaveBeenCalled();
    // The idempotency lookup excludes reversals…
    const where = db.journalEntry.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      sourceType: "PAYROLL_RUN",
      sourceId: "run-dec",
      status: "POSTED",
      reversalOfId: null,
    });
    // …and includes the lines (the PostedJournalEntry contract must hold on
    // the idempotent return too — post-run-to-gl iterates them).
    const include = db.journalEntry.findFirst.mock.calls[0][0].include;
    expect(include).toEqual({ lines: true });
  });

  it("throws out-of-balance BEFORE any write", async () => {
    // A net that does not reconcile with the deduction lines.
    const slip = statutoryPayslip();
    slip.net = 4000; // should be 5,008.35
    db.payrollRun.findUnique.mockResolvedValue(lockedRun([slip]));

    await expect(postPayrollRun("run-dec")).rejects.toThrow("out of balance");
    expect(db.journalEntry.create).not.toHaveBeenCalled();
  });

  it("refuses a closed accounting period (even for an already-posted run)", async () => {
    db.accountingPeriod.findFirst.mockResolvedValue({ ...OPEN_PERIOD, isClosed: true });
    await expect(postPayrollRun("run-dec")).rejects.toThrow("Accounting period is closed");
    // The period guard runs BEFORE the idempotency return.
    db.journalEntry.findFirst.mockResolvedValue({ id: "je-existing", status: "POSTED" });
    await expect(postPayrollRun("run-dec")).rejects.toThrow("Accounting period is closed");
  });

  it("refuses a run with no covering period and a run that is not LOCKED", async () => {
    db.accountingPeriod.findFirst.mockResolvedValue(null);
    await expect(postPayrollRun("run-dec")).rejects.toThrow("No accounting period covers this run");
    db.accountingPeriod.findFirst.mockResolvedValue(OPEN_PERIOD);
    db.payrollRun.findUnique.mockResolvedValue(lockedRun([statutoryPayslip()]));
    (db.payrollRun.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "run-dec" ? { ...lockedRun([statutoryPayslip()]), status: "OPEN" } : null,
    );
    await expect(postPayrollRun("run-dec")).rejects.toThrow("Run must be LOCKED before posting");
    await expect(postPayrollRun("run-missing")).rejects.toThrow("not found");
  });
});

describe("buildPayrollJournalLines (pure core)", () => {
  const ctx: BuildLinesContext = {
    salariesExpenseId: "acc-4000",
    netPayClearingId: "acc-2200",
    employerKsExpenseId: "acc-4010",
    statutoryAccountIds: {
      PAYE: "acc-2100",
      ACC: "acc-2110",
      KIWISAVER_EMPLOYEE: "acc-2120",
      KIWISAVER_EMPLOYER: "acc-2130",
      ESCT: "acc-2140",
      STUDENT_LOAN: "acc-2150",
    },
    componentExpenseById: new Map([["bonus", "acc-4050"]]),
    componentLiabilityById: new Map(),
  };

  it("maps a component-mapped earning to its expense account", () => {
    const slip: PostingPayslip = {
      userId: "u-x",
      slipNo: "PS-1",
      earnings: JSON.stringify([
        { key: "basic", label: "Basic", amount: 100 },
        { key: "bonus", label: "Bonus", amount: 50, },
      ]),
      deductions: "[]",
      net: 150,
      employerKiwiSaverGross: null,
      employerEsct: null,
      employerKiwiSaverNet: null,
    };
    const lines = buildPayrollJournalLines([slip], ctx);
    expect(lines.find((l) => l.accountId === "acc-4050")).toEqual({
      accountId: "acc-4050", debit: 50, employeeId: "u-x", description: "Bonus",
    });
    expect(lines.find((l) => l.accountId === "acc-2200")?.credit).toBe(150);
    expect(journalBalance(lines)).toEqual({ debit: 150, credit: 150 });
  });

  it("skips statistical lines entirely", () => {
    const slip: PostingPayslip = {
      userId: "u-x",
      slipNo: "PS-1",
      earnings: JSON.stringify([
        { key: "basic", label: "Basic", amount: 100 },
        { key: "package", label: "Package total", amount: 9999, statistical: true },
      ]),
      deductions: "[]",
      net: 100,
      employerKiwiSaverGross: null,
      employerEsct: null,
      employerKiwiSaverNet: null,
    };
    const lines = buildPayrollJournalLines([slip], ctx);
    expect(lines).toHaveLength(2); // 1 debit + 1 net credit
    expect(journalBalance(lines)).toEqual({ debit: 100, credit: 100 });
  });
});

describe("reverseJournalEntry (action)", () => {
  const originalEntry = () => ({
    id: "je-orig",
    date: d("2026-12-31"),
    memo: "Payroll run run-dec (2026-12)",
    periodId: "per-dec",
    sourceType: "PAYROLL_RUN",
    sourceId: "run-dec",
    status: "POSTED",
    reversalOfId: null,
    period: OPEN_PERIOD,
    lines: [
      { accountId: "acc-4000", debit: dec(7000), credit: dec(0), employeeId: "u-x", costCenter: null, description: "Basic Salary" },
      { accountId: "acc-2200", debit: dec(0), credit: dec(7000), employeeId: "u-x", costCenter: null, description: "Net pay PS-1" },
    ],
  });

  beforeEach(() => {
    db.journalEntry.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "je-orig" ? originalEntry() : null,
    );
    db.accountingPeriod.findFirst.mockResolvedValue({
      id: "per-jan", startDate: d("2027-01-01"), endDate: d("2027-01-31"), isClosed: false,
    });
    db.journalEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "je-rev", ...data,
      lines: ((data.lines as { create?: unknown[] } | undefined)?.create ?? []).map(
        (_: unknown, i: number) => ({ id: `jl-rev-${i}` }),
      ),
    }));
  });

  it("creates a mirrored POSTED entry and flips only the original's status", async () => {
    const res = await reverseJournalEntry({ entryId: "je-orig" });
    expect(res.ok).toBe(true);

    const createArg = db.journalEntry.create.mock.calls[0][0] as {
      data: {
        periodId: string;
        status: string;
        reversalOfId: string;
        lines: { create: Array<{ accountId: string; debit: unknown; credit: unknown }> };
      };
    };
    // Mirrored legs: the debit became the credit and vice versa (Decimal
    // inputs pass through verbatim — normalize for the assertion).
    const num = (v: unknown) => (typeof v === "number" ? v : (v as { toNumber(): number }).toNumber());
    expect(createArg.data.periodId).toBe("per-jan");
    expect(createArg.data.status).toBe("POSTED");
    expect(createArg.data.reversalOfId).toBe("je-orig");
    const mirrored = createArg.data.lines.create.map((l) => ({
      accountId: l.accountId,
      debit: num(l.debit),
      credit: num(l.credit),
    }));
    expect(mirrored).toEqual([
      { accountId: "acc-4000", debit: 0, credit: 7000 },
      { accountId: "acc-2200", debit: 7000, credit: 0 },
    ]);

    // The original: ONLY the status + reverser move (lines untouched).
    expect(db.journalEntry.update).toHaveBeenCalledWith({
      where: { id: "je-orig" },
      data: { status: "REVERSED", reversedById: "u-hr" },
    });
    expect(db.journalEntryLine.update).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "accounting.entry_reversed" }),
    );
  });

  it("refuses anything that is not a plain POSTED entry", async () => {
    db.journalEntry.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "je-orig" ? { ...originalEntry(), status: "REVERSED" } : null,
    );
    let res = await reverseJournalEntry({ entryId: "je-orig" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Only POSTED entries");

    db.journalEntry.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "je-orig" ? { ...originalEntry(), reversalOfId: "je-other" } : null,
    );
    res = await reverseJournalEntry({ entryId: "je-orig" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("cannot itself be reversed");
  });

  it("refuses a closed target period", async () => {
    db.accountingPeriod.findFirst.mockResolvedValue({
      id: "per-jan", startDate: d("2027-01-01"), endDate: d("2027-01-31"), isClosed: true,
    });
    const res = await reverseJournalEntry({ entryId: "je-orig" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("closed");
  });
});

describe("closePeriod (action)", () => {
  it("closes an open period once and refuses a double close", async () => {
    db.accountingPeriod.findUnique.mockResolvedValue({ ...OPEN_PERIOD });
    let res = await closePeriod("per-dec");
    expect(res.ok).toBe(true);
    expect(db.accountingPeriod.update).toHaveBeenCalledWith({
      where: { id: "per-dec" },
      data: { isClosed: true },
    });

    db.accountingPeriod.findUnique.mockResolvedValue({ ...OPEN_PERIOD, isClosed: true });
    res = await closePeriod("per-dec");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already closed");
  });
});
