import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P20 (PR-R01/PR-R02) — golden-file tests for lib/payroll-csv.ts: the
// register + the bank remittance, RFC 4180 escaping, the non-statutory
// disclaimer, and the withheld-money rule (WITHHELD nets never reach the
// bank file).
// ---------------------------------------------------------------------------

import { salaryRegisterCsv, bankRemittanceCsv } from "@/lib/payroll/payroll-csv";

const GENERATED_AT = new Date("2026-11-10T08:30:00.000Z");

const ROWS = [
  {
    slipNo: "PS-2026-11-001", employeeNumber: "EMP-0003", employeeName: "Yuki Tanaka",
    jobTitle: "Data Engineer", gross: 6_700, deductions: 108, net: 6_592, lopDays: 0, withholdStatus: "",
  },
  {
    // A name with a comma + quotes exercises the RFC 4180 path.
    slipNo: "PS-2026-11-002", employeeNumber: null, employeeName: 'Solberg, "Ingrid"',
    jobTitle: "Research Analyst", gross: 3_400, deductions: 100, net: 3_300, lopDays: 1.5, withholdStatus: "WITHHELD",
  },
  {
    slipNo: "PS-2026-11-003", employeeNumber: "EMP-0007", employeeName: "Diego Fernández",
    jobTitle: "Ops Specialist", gross: 4_100.555, deductions: 0, net: 4_100.56, lopDays: 0, withholdStatus: "RELEASED",
  },
];

describe("payroll-csv — salaryRegisterCsv (PR-R01)", () => {
  const csv = salaryRegisterCsv({ period: "2026-11", generatedAt: GENERATED_AT, rows: ROWS });
  const lines = csv.split("\r\n");

  it("leads with the non-statutory disclaimer naming the period + generation time", () => {
    expect(lines[0]).toBe("# Salary register — Fernly Payroll — period 2026-11");
    expect(lines[1]).toContain("Generated 2026-11-10T08:30:00.000Z");
    expect(lines[1]).toContain("non-statutory");
    expect(lines[1]).toContain("Not a tax document");
  });

  it("one row per slip, CRLF line endings, trailing newline", () => {
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines[2]).toBe("Slip no,Employee no,Employee,Job title,Gross,Deductions,Net pay,LOP days,Withheld");
    expect(lines[3]).toBe("PS-2026-11-001,EMP-0003,Yuki Tanaka,Data Engineer,6700.00,108.00,6592.00,0,");
    // The comma/quote name is quoted with doubled inner quotes; fractional
    // LOP renders 2 decimals; null employee number renders empty.
    expect(lines[4]).toBe('PS-2026-11-002,,"Solberg, ""Ingrid""",Research Analyst,3400.00,100.00,3300.00,1.50,WITHHELD');
    // Money rounds to 2dp everywhere; RELEASED carries through.
    expect(lines[5]).toBe("PS-2026-11-003,EMP-0007,Diego Fernández,Ops Specialist,4100.56,0.00,4100.56,0,RELEASED");
  });

  it("ends with the honest TOTAL row (Σ gross/deductions/net over ALL slips incl. withheld)", () => {
    expect(lines[6]).toBe("TOTAL,,3 payslip(s),,14200.56,208.00,13992.56,,");
    expect(lines[7]).toBe("");
  });
});

describe("payroll-csv — bankRemittanceCsv (PR-R02)", () => {
  const csv = bankRemittanceCsv({ period: "2026-11", workspaceName: "Fernly Workspace", generatedAt: GENERATED_AT, rows: ROWS });
  const lines = csv.split("\r\n");

  it("leads with the disclaimer + the workspace line", () => {
    expect(lines[0]).toBe("# Bank remittance — Fernly Payroll — period 2026-11");
    expect(lines[1]).toContain("non-statutory");
    expect(lines[2]).toBe("# Workspace: Fernly Workspace");
  });

  it("WITHHELD nets never reach the bank file; the account column stays blank", () => {
    expect(lines[3]).toBe("Employee no,Employee name,Bank account,Amount,Currency,Period,Payment reference");
    // Slip 001 pays; slip 002 (WITHHELD) is skipped; slip 003 released pays.
    expect(lines[4]).toBe("EMP-0003,Yuki Tanaka,,6592.00,NZD,2026-11,PS-2026-11-001");
    expect(lines[5]).toBe("EMP-0007,Diego Fernández,,4100.56,NZD,2026-11,PS-2026-11-003");
    expect(lines[6]).toBe("TOTAL,2 payment(s),,10692.56,NZD,2026-11,");
    expect(lines[7]).toBe("");
    expect(csv).not.toContain("3300.00");
  });
});
