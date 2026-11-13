// ---------------------------------------------------------------------------
// Phase 2 — the filing service's integration behaviour with a mocked db
// (the payroll.test.ts hoisted-mock pattern): generation, the
// double-filing guard, the status machine, ED never-notify-twice, and
// the EIA2 amendment flow.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The db mock (vi.hoisted so the module-level import sees it).
// ---------------------------------------------------------------------------

type DbMock = Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>;
};

const db = vi.hoisted((): DbMock => {
  const MODELS = [
    "payrollSettings", "payrollRun", "payslip", "user", "employeeTaxProfile", "employeeProfile",
    "paydayFiling", "paydayFilingLine", "employeeDetailsFiling", "paydayAmendmentFiling",
    "journalEntry",
  ];
  const obj = {} as DbMock;
  const METHODS = ["findMany", "findUnique", "findFirst", "create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate", "groupBy"];
  for (const m of MODELS) {
    obj[m] = {};
    for (const method of METHODS) obj[m][method] = vi.fn();
  }
  obj.$transaction = vi.fn(async (fn: (tx: DbMock) => Promise<unknown>) => fn(obj));
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));
vi.mock("@/lib/holidays", () => ({
  getHolidayLookup: vi.fn(async () => new Map()),
}));

import {
  flagOverdueFilings,
  generateAmendmentFiling,
  generateEmployeeDetails,
  generatePaydayFiling,
  markAccepted,
  markFiled,
  markRejected,
} from "../filing-service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SETTINGS = {
  id: "default",
  employerIrdNumber: "123123123",
  employerName: "Fernly Demo Ltd",
  payeIntermediaryIrd: null,
  payrollContactName: "Bill Smith",
  payrollContactPhone: "041234567",
  payrollContactEmail: "payroll@email.com",
  payrollPackageIdentifier: "Fernly v1.0",
  irFormVersionNumber: "0001",
  nzBusinessHolidays: null,
};

const dec = (n: number) => ({ toNumber: () => n });

const SNAP = (tax: number, acc: number, ks: number, sl: number, gross: number) => ({
  taxCode: "M",
  rateSetId: "rs",
  rateSetLabel: "FY2026-27",
  ruleVersion: "v1",
  frequency: "MONTHLY",
  payPeriodEnd: "2026-10-31",
  taxableGross: gross,
  defaultedProfile: false,
  paye: { tax, acc, total: tax + acc, method: "ANNUALISED", ietc: 0, annualised: gross * 12 },
  kiwiSaver: {
    status: "ACTIVE", reason: "", autoEnrolTriggered: false,
    employee: ks, employerGross: ks, esct: 10, employerNet: ks - 10,
    employeeRate: 0.035, employerRate: 0.035, esctRate: 0.175,
  },
  studentLoan: sl,
  statutoryNet: gross - tax - acc - ks - sl,
});

const DEDUCTIONS = JSON.stringify([
  { key: "paye", label: "PAYE income tax (M)", amount: 851.71 },
  { key: "acc", label: "ACC earners' levy", amount: 87.5 },
  { key: "ks", label: "KiwiSaver employee 3.5%", amount: 175 },
  { key: "sl", label: "Student loan repayment", amount: 60 },
]);

const PAYSLIP_A = {
  id: "ps-1", userId: "u-1", runId: "run-1", slipNo: "PS-2026-10-001",
  deductions: DEDUCTIONS, taxCodeApplied: "M",
  statutory: SNAP(851.71, 87.5, 175, 60, 5000),
  employerKiwiSaverNet: dec(165), employerEsct: dec(10),
};
const PAYSLIP_B = {
  id: "ps-2", userId: "u-2", runId: "run-1", slipNo: "PS-2026-10-002",
  deductions: DEDUCTIONS, taxCodeApplied: "M SL",
  statutory: SNAP(851.71, 87.5, 175, 60, 5000),
  employerKiwiSaverNet: dec(165), employerEsct: dec(10),
};

const LOCKED_RUN = {
  id: "run-1", period: "2026-10", status: "LOCKED", frequency: "MONTHLY",
  startDate: new Date("2026-10-01T00:00:00.000Z"),
  endDate: new Date("2026-10-31T00:00:00.000Z"),
  payDate: new Date("2026-10-31T00:00:00.000Z"),
  payslips: [PAYSLIP_A, PAYSLIP_B],
};

const USERS = [
  { id: "u-1", name: "Hana Park", email: "hana@fernly.app" },
  { id: "u-2", name: "Yuki Tanaka", email: "yuki@fernly.app" },
];

const TAX_PROFILES = [
  { userId: "u-1", irdNumber: "752783373", taxCode: "M", kiwiSaverStatus: "ACTIVE", employmentStartDate: new Date("2024-07-15T00:00:00.000Z"), employmentEndDate: null, isCasual: false, employmentType: "PERMANENT" },
  { userId: "u-2", irdNumber: "760841838", taxCode: "M SL", kiwiSaverStatus: "ACTIVE", employmentStartDate: new Date("2025-09-01T00:00:00.000Z"), employmentEndDate: null, isCasual: false, employmentType: "PERMANENT" },
];

/** The posted JE: credits per account, in dollars. */
function jeWithCredits(paye: number, ks: number, ksEr: number, esct: number, sl: number) {
  return [
    {
      id: "je-1", sourceType: "PAYROLL_RUN", sourceId: "run-1", status: "POSTED", reversalOfId: null,
      lines: [
        { credit: dec(paye), account: { code: "2100" } },
        { credit: dec(87.5 * 2), account: { code: "2110" } },
        { credit: dec(ks), account: { code: "2120" } },
        { credit: dec(ksEr), account: { code: "2130" } },
        { credit: dec(esct), account: { code: "2140" } },
        { credit: dec(sl), account: { code: "2150" } },
      ],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  db.payrollSettings.findUnique.mockResolvedValue(SETTINGS);
  db.payrollRun.findUnique.mockResolvedValue(LOCKED_RUN);
  db.paydayFilingLine.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue(USERS);
  db.employeeTaxProfile.findMany.mockResolvedValue(TAX_PROFILES);
  db.journalEntry.findMany.mockResolvedValue(jeWithCredits(851.71 * 2, 175 * 2, 165 * 2, 10 * 2, 60 * 2));
  db.paydayFiling.create.mockResolvedValue({ id: "filing-1" });
  db.paydayFiling.findUnique.mockResolvedValue(null);
});

describe("generatePaydayFiling", () => {
  it("creates one filing + N lines in a single transaction, all 12 reconciliation checks passing", async () => {
    const result = await generatePaydayFiling("run-1", { generatedById: "u-hr" });

    expect(result.id).toBe("filing-1");
    expect(result.status).toBe("GENERATED");
    expect(result.totalEmployeeLines).toBe(2);
    expect(result.reconciliation.allPass).toBe(true);
    expect(result.reconciliation.checks).toHaveLength(12);
    // The due date: Friday 2026-10-30 payday? No — payday IS 2026-10-31
    // (a Saturday): +1 working day = Mon 2026-11-02, +2 = Tue 2026-11-03.
    expect(result.dueDate.toISOString().slice(0, 10)).toBe("2026-11-03");

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.paydayFiling.create).toHaveBeenCalledTimes(1);
    const createArg = db.paydayFiling.create.mock.calls[0][0];
    expect(createArg.data.status).toBe("GENERATED");
    expect(createArg.data.employerIrd).toBe("123123123");
    expect(createArg.data.payCycle).toBe("MT");
    expect(createArg.data.totalEmployeeLines).toBe(2);
    expect(createArg.data.totalGrossCents).toBe(1_000_000);
    expect(createArg.data.totalPayeCents).toBe(170_342);
    expect(createArg.data.totalStudentLoanCents).toBe(12_000);
    expect(createArg.data.totalKiwisaverEmployeeCents).toBe(35_000);
    expect(createArg.data.totalKiwisaverEmployerNetCents).toBe(33_000);
    expect(createArg.data.totalEsctCents).toBe(2_000);
    expect(createArg.data.fileContent).toContain("HEI2,123123123,20261031,N,N,");
    expect(createArg.data.lines.create).toHaveLength(2);
    expect(createArg.data.fileHash).toMatch(/^[0-9a-f]{64}$/);
    // The line rows carry the payslip ids (the double-filing guard keys).
    expect(createArg.data.lines.create.map((l: { payslipId: string }) => l.payslipId)).toEqual(["ps-1", "ps-2"]);
    // Names are "Surname Firstnames".
    expect(createArg.data.lines.create[0].employeeName).toBe("Park Hana");
    expect(createArg.data.lines.create[1].employeeName).toBe("Tanaka Yuki");
  });

  it("the generated file has the right shape (HEI2 + 2 DEI lines, cents, no decimals)", async () => {
    await generatePaydayFiling("run-1");
    const content = db.paydayFiling.create.mock.calls[0][0].data.fileContent as string;
    const rows = content.split("\n").filter((l) => l !== "");
    expect(rows).toHaveLength(3);
    expect(rows[0].split(",")).toHaveLength(28);
    expect(rows[1].split(",")).toHaveLength(27);
    expect(rows[2].split(",")).toHaveLength(27);
    // No DECIMAL AMOUNTS: no field is a decimal number (package ids and
    // emails may carry dots).
    expect(content.split("\n").flatMap((l) => l.split(",")).some((f) => /^-?\d+\.\d+$/.test(f))).toBe(false);
    expect(rows[1]).toContain("Park Hana");
    expect(rows[1]).toContain(",M,");
    expect(rows[2]).toContain(",M SL,");
  });

  it("refuses an OPEN run", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...LOCKED_RUN, status: "OPEN" });
    await expect(generatePaydayFiling("run-1")).rejects.toThrow(/still OPEN/i);
  });

  it("refuses a QUARTERLY run (no confirmed pay cycle code)", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ ...LOCKED_RUN, frequency: "QUARTERLY" });
    await expect(generatePaydayFiling("run-1")).rejects.toThrow(/pay cycle code/i);
  });

  it("refuses when settings are missing", async () => {
    db.payrollSettings.findUnique.mockResolvedValue(null);
    await expect(generatePaydayFiling("run-1")).rejects.toThrow(/filing settings are not configured/i);
  });

  it("refuses a payslip with no statutory snapshot", async () => {
    db.payrollRun.findUnique.mockResolvedValue({
      ...LOCKED_RUN,
      payslips: [{ ...PAYSLIP_A, statutory: null }, PAYSLIP_B],
    });
    await expect(generatePaydayFiling("run-1")).rejects.toThrow(/never priced by the statutory engine/i);
  });

  it("DOUBLE-FILING GUARD: refuses when a payslip is already in a FILED filing", async () => {
    db.paydayFilingLine.findMany.mockResolvedValue([
      { filingId: "old-filing", payslipId: "ps-1", filing: { id: "old-filing", status: "FILED", employerIrd: "123123123", payDate: new Date("2026-10-31T00:00:00.000Z"), filedAt: new Date("2026-11-01T00:00:00.000Z") } },
      { filingId: "old-filing", payslipId: "ps-2", filing: { id: "old-filing", status: "FILED", employerIrd: "123123123", payDate: new Date("2026-10-31T00:00:00.000Z"), filedAt: new Date("2026-11-01T00:00:00.000Z") } },
    ]);
    await expect(generatePaydayFiling("run-1")).rejects.toThrow(/already uploaded to myIR/i);
    expect(db.paydayFiling.create).not.toHaveBeenCalled();
  });

  it("REGENERATION: a REJECTED filing for the same payday is replaced (delete + create)", async () => {
    db.paydayFilingLine.findMany.mockResolvedValue([
      { filingId: "old-filing", payslipId: "ps-1", filing: { id: "old-filing", status: "REJECTED", employerIrd: "123123123", payDate: new Date("2026-10-31T00:00:00.000Z") } },
      { filingId: "old-filing", payslipId: "ps-2", filing: { id: "old-filing", status: "REJECTED", employerIrd: "123123123", payDate: new Date("2026-10-31T00:00:00.000Z") } },
    ]);
    const result = await generatePaydayFiling("run-1");
    expect(result.id).toBe("filing-1");
    expect(db.paydayFiling.delete).toHaveBeenCalledWith({ where: { id: "old-filing" } });
    expect(db.paydayFiling.create).toHaveBeenCalledTimes(1);
  });

  it("RECONCILIATION REFUSAL: a ledger mismatch blocks generation before any write", async () => {
    // The JE never posted the student loan credit.
    db.journalEntry.findMany.mockResolvedValue(jeWithCredits(851.71 * 2, 175 * 2, 165 * 2, 10 * 2, 0));
    await expect(generatePaydayFiling("run-1")).rejects.toThrow(/would disagree with the payroll records or the general ledger/i);
    expect(db.paydayFiling.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("payslipId uniqueness is enforced by the @@unique constraint (the backstop)", () => {
    // The constraint lives in the schema; the service-level guard above is
    // the friendly face. This test pins the schema expectation.
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toContain("payslipId      String   @unique");
    expect(schema).toContain("@@unique([employerIrd, payDate])");
    expect(schema).toContain("@@unique([employeeId, kind])");
  });
});

describe("the status machine", () => {
  it("GENERATED → FILED requires a filer and stamps filedAt", async () => {
    db.paydayFiling.findUnique.mockResolvedValue({ id: "filing-1", status: "GENERATED" });
    await markFiled("filing-1", { filedById: "u-hr", irdReference: "myIR-123" });
    expect(db.paydayFiling.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FILED", irdReference: "myIR-123" }) }),
    );
  });

  it("FILED → ACCEPTED", async () => {
    db.paydayFiling.findUnique.mockResolvedValue({ id: "filing-1", status: "FILED" });
    await markAccepted("filing-1");
    expect(db.paydayFiling.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED" }) }));
  });

  it("FILED → REJECTED requires a non-empty error report", async () => {
    db.paydayFiling.findUnique.mockResolvedValue({ id: "filing-1", status: "FILED" });
    await expect(markRejected("filing-1", { errorReport: "  " })).rejects.toThrow(/Paste the myIR error report/i);
    await markRejected("filing-1", { errorReport: "Line 2, field 15: PAYE mismatch" });
    expect(db.paydayFiling.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED", irdErrorReport: "Line 2, field 15: PAYE mismatch" }) }),
    );
  });

  it("every illegal transition refuses loudly", async () => {
    for (const [from, fn] of [
      ["FILED", () => markFiled("filing-1", { filedById: "u-hr" })],
      ["ACCEPTED", () => markAccepted("filing-1")],
      ["REJECTED", () => markRejected("filing-1", { errorReport: "x" })],
      ["GENERATED", () => markAccepted("filing-1")],
      ["AMENDED", () => markAccepted("filing-1")],
    ] as const) {
      db.paydayFiling.findUnique.mockResolvedValue({ id: "filing-1", status: from });
      await expect(fn()).rejects.toThrow(/this one is/i);
    }
  });
});

describe("flagOverdueFilings", () => {
  it("flags GENERATED/FILED filings past their due date, once (idempotent)", async () => {
    db.paydayFiling.updateMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-11-13T00:00:00.000Z");
    const count = await flagOverdueFilings(now);
    expect(count).toBe(3);
    const arg = db.paydayFiling.updateMany.mock.calls[0][0];
    expect(arg.where.status).toEqual({ in: ["GENERATED", "FILED"] });
    expect(arg.where.dueDate).toEqual({ lt: now });
    expect(arg.where.overdueFlaggedAt).toBe(null); // only unflagged rows — the idempotency
    expect(arg.data.overdueFlaggedAt).toEqual(now);
  });
});

describe("generateEmployeeDetails", () => {
  beforeEach(() => {
    db.employeeTaxProfile.findMany.mockResolvedValue(TAX_PROFILES.slice(0, 1));
    db.user.findMany.mockResolvedValue(USERS.slice(0, 1));
    db.employeeProfile.findMany.mockResolvedValue([{ userId: "u-1", phone: "021123456", birthDate: new Date("1994-03-20T00:00:00.000Z") }]);
    db.employeeDetailsFiling.findMany.mockResolvedValue([]);
    db.employeeDetailsFiling.create.mockResolvedValue({ id: "ed-1" });
  });

  it("generates one filing row per employee sharing one HED2+DED+TED file", async () => {
    const result = await generateEmployeeDetails({ employeeIds: ["u-1"], generatedById: "u-hr" });
    expect(result.employeeLineCount).toBe(1);
    expect(db.employeeDetailsFiling.create).toHaveBeenCalledTimes(1);
    const arg = db.employeeDetailsFiling.create.mock.calls[0][0];
    expect(arg.data.kind).toBe("NEW");
    expect(arg.data.status).toBe("GENERATED");
    expect(arg.data.fileContent.startsWith("HED2,123123123,Fernly v1.0,1\n")).toBe(true);
    expect(arg.data.fileContent).toContain("DED,752783373,Park Hana,,Hana,,Park,19940320,20240715,,NE,AK,");
    expect(arg.data.fileContent).toContain("TED,M");
  });

  it("NEVER-NOTIFY-TWICE: an existing notification for the same kind refuses", async () => {
    db.employeeDetailsFiling.findMany.mockResolvedValue([{ employeeId: "u-1", kind: "NEW", status: "ACCEPTED" }]);
    await expect(generateEmployeeDetails({ employeeIds: ["u-1"] })).rejects.toThrow(/already has a new-employee notification/i);
  });

  it("an OPTED_OUT employee refuses (opt-out date + bank are not held)", async () => {
    db.employeeTaxProfile.findMany.mockResolvedValue([{ ...TAX_PROFILES[0], kiwiSaverStatus: "OPTED_OUT" }]);
    await expect(generateEmployeeDetails({ employeeIds: ["u-1"] })).rejects.toThrow(/opted out/i);
  });

  it("a departing employee (employment end set) files kind DEPARTING with the end date", async () => {
    db.employeeTaxProfile.findMany.mockResolvedValue([
      { ...TAX_PROFILES[0], employmentEndDate: new Date("2026-10-15T00:00:00.000Z") },
    ]);
    await generateEmployeeDetails({ employeeIds: ["u-1"] });
    const arg = db.employeeDetailsFiling.create.mock.calls[0][0];
    expect(arg.data.kind).toBe("DEPARTING");
    expect(arg.data.fileContent).toMatch(/,EE,AK,/); // existing employee
    expect(arg.data.fileContent).toContain("20261015"); // employment end
  });
});

describe("generateAmendmentFiling", () => {
  const FROZEN_LINE = {
    filingId: "filing-1", employeeId: "u-1", payslipId: "ps-1",
    employeeIrd: "752783373", employeeName: "Park Hana", taxCode: "M",
    employmentStart: null, employmentEnd: null,
    periodStart: new Date("2026-10-01T00:00:00.000Z"), periodEnd: new Date("2026-10-31T00:00:00.000Z"),
    payCycle: "MT", hoursPaidCents: 0, grossCents: 500_000, priorGrossAdjCents: 0, notLiableAccCents: 0,
    lumpSumIndicator: "0", payeCents: 85_171, priorPayeAdjCents: 0, childSupportCents: 0, childSupportCode: null,
    studentLoanCents: 6_000, slcirCents: 0, slborCents: 0, kiwisaverEmployeeCents: 17_500,
    kiwisaverEmployerNetCents: 16_500, esctCents: 1_000, donationsCents: 0, familyTaxCreditCents: 0, shareSchemeCents: 0,
  };

  beforeEach(() => {
    db.paydayFiling.findUnique.mockResolvedValue({
      id: "filing-1", status: "FILED", employerIrd: "123123123",
      payDate: new Date("2026-10-31T00:00:00.000Z"),
      lines: [FROZEN_LINE],
    });
    db.paydayAmendmentFiling.create.mockResolvedValue({ id: "amend-1" });
  });

  it("builds a contiguous DTI/DAI pair from the frozen line and flips the original to AMENDED", async () => {
    const result = await generateAmendmentFiling(
      "filing-1",
      [{ employeeId: "u-1", amended: { grossCents: 490_000 } }],
      { generatedById: "u-hr" },
    );
    expect(result.pairCount).toBe(1);
    expect(result.id).toBe("amend-1");

    const createArg = db.paydayAmendmentFiling.create.mock.calls[0][0];
    expect(createArg.data.correctionCount).toBe(1);
    const rows = (createArg.data.fileContent as string).split("\n").filter((l) => l !== "");
    expect(rows).toHaveLength(3); // EIA2 + DTI + DAI
    expect(rows[0]).toBe("EIA2,123123123,20261031,,Bill Smith,041234567,0001");
    expect(rows[1].startsWith("DTI,752783373,Park Hana,M,,,20261001,20261031,MT,")).toBe(true);
    expect(rows[1]).toContain(",500000,"); // original gross as filed
    expect(rows[2].startsWith("DAI,752783373,Park Hana,M,,,20261001,20261031,MT,")).toBe(true);
    expect(rows[2]).toContain(",490000,"); // corrected gross

    // The original flips to AMENDED with the back-pointer.
    expect(db.paydayFiling.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "filing-1" }, data: { status: "AMENDED", amendedByFilingId: "amend-1" } }),
    );
  });

  it("a delete correction emits the filed DTI + a nil DAI", async () => {
    await generateAmendmentFiling("filing-1", [{ employeeId: "u-1", amended: null }], { generatedById: "u-hr" });
    const rows = (db.paydayAmendmentFiling.create.mock.calls[0][0].data.fileContent as string).split("\n").filter((l) => l !== "");
    expect(rows[2]).toBe("DAI,,,,,,,,,0,0,0,0,0,0,0,0,,0,0,0,0,0,0,0,0,0");
  });

  it("refuses to amend a filing that was never uploaded", async () => {
    db.paydayFiling.findUnique.mockResolvedValue({ ...FROZEN_LINE, id: "filing-1", status: "GENERATED", lines: [FROZEN_LINE] });
    await expect(generateAmendmentFiling("filing-1", [{ employeeId: "u-1", amended: { grossCents: 1 } }])).rejects.toThrow(/amendment corrects a filing that was uploaded/i);
  });

  it("refuses an unknown employee (not on the filed return)", async () => {
    await expect(generateAmendmentFiling("filing-1", [{ employeeId: "u-99", amended: { grossCents: 1 } }])).rejects.toThrow(/not on the filing being amended/i);
  });
});
