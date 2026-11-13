import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P21 (LV-R01) — the employee leave balance report kernel
// (benchmark: hrms "Employee Leave Balance" report columns — opening,
// allocated, taken, expired, closing; all-zero pairs skipped).
//
// Pure arithmetic on ledger rows: pinned here, not in action mocks.
// ---------------------------------------------------------------------------

import {
  buildLeaveBalanceReportRows,
  leaveBalanceReportCsv,
  type LedgerRowForReport,
} from "@/lib/leave/leave-balance-report";

function ledger(rows: Array<[string, string, number, string, number]>): LedgerRowForReport[] {
  // [userId, leaveTypeId, year, entryType, delta]
  return rows.map(([userId, leaveTypeId, year, entryType, delta]) => ({
    userId, leaveTypeId, year, entryType, delta,
  }));
}

describe("buildLeaveBalanceReportRows", () => {
  const typeNames = new Map([
    ["lt-annual", "Annual Leave"],
    ["lt-sick", "Sick Leave"],
  ]);
  const labels = new Map([
    ["u-theo", { userId: "u-theo", userName: "Theo Jansen", employeeNumber: "EMP-004" }],
    ["u-ada", { userId: "u-ada", userName: "Ada Lovelace", employeeNumber: null }],
  ]);

  it("aggregates one pair across years: opening, allocated, taken, expired, closing", () => {
    const rows = buildLeaveBalanceReportRows({
      year: 2026,
      ledgerRows: ledger([
        // 2024: an import never consumed — still opening for 2026.
        ["u-theo", "lt-annual", 2024, "BALANCE_IMPORT", 30],
        // 2025: grant + a consumption.
        ["u-theo", "lt-annual", 2025, "GRANT", 20],
        ["u-theo", "lt-annual", 2025, "CONSUME", -6],
        // 2026 (the report year): the five kinds.
        ["u-theo", "lt-annual", 2026, "GRANT", 5],
        ["u-theo", "lt-annual", 2026, "CARRY", 4],
        ["u-theo", "lt-annual", 2026, "ADJUST", 1],
        ["u-theo", "lt-annual", 2026, "CONSUME", -3.5],
        ["u-theo", "lt-annual", 2026, "EXPIRE", -2],
      ]),
      typeNames,
      labels,
    });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    // opening = 30 + 20 − 6 = 44
    expect(r.opening).toBe(44);
    // allocated = 5 + 4 + 1 = 10
    expect(r.allocated).toBe(10);
    expect(r.taken).toBe(3.5);
    expect(r.expired).toBe(2);
    // closing = 44 + 10 − 3.5 − 2 = 48.5
    expect(r.closing).toBe(48.5);
    expect(r.leaveTypeName).toBe("Annual Leave");
    expect(r.userName).toBe("Theo Jansen");
    expect(r.employeeNumber).toBe("EMP-004");
  });

  it("a consumption reversal restores taken (cancel of an approval)", () => {
    const rows = buildLeaveBalanceReportRows({
      year: 2026,
      ledgerRows: ledger([
        ["u-theo", "lt-annual", 2026, "GRANT", 20],
        ["u-theo", "lt-annual", 2026, "CONSUME", -5],
        // The cancel's sibling row: +5 CONSUME with isReversal — cancels out.
        ["u-theo", "lt-annual", 2026, "CONSUME", 5],
      ]),
      typeNames,
      labels,
    });
    expect(rows[0].taken).toBe(0);
    expect(rows[0].closing).toBe(20);
  });

  it("all-zero pairs are skipped (the benchmark's no-entry filter)", () => {
    const rows = buildLeaveBalanceReportRows({
      year: 2026,
      ledgerRows: ledger([
        ["u-ghost", "lt-sick", 2026, "GRANT", 0],
      ]),
      typeNames,
      labels,
    });
    expect(rows).toHaveLength(0);
  });

  it("sorts by type name then employee name; deleted users/types label honestly", () => {
    const rows = buildLeaveBalanceReportRows({
      year: 2026,
      ledgerRows: ledger([
        ["u-theo", "lt-sick", 2026, "GRANT", 3],
        ["u-ada", "lt-annual", 2026, "GRANT", 4],
        ["u-theo", "lt-annual", 2026, "GRANT", 5],
        ["u-gone", "lt-annual", 2026, "GRANT", 2],
      ]),
      typeNames,
      labels, // no label for u-gone → "(deleted user)"
    });
    expect(rows.map((r) => `${r.leaveTypeName}|${r.userName}`)).toEqual([
      // "(" sorts before letters — the deleted-user label leads its block.
      "Annual Leave|(deleted user)",
      "Annual Leave|Ada Lovelace",
      "Annual Leave|Theo Jansen",
      "Sick Leave|Theo Jansen",
    ]);
  });

  it("rows in years AFTER the report year never leak in (a 2027 grant ≠ 2026 report)", () => {
    const rows = buildLeaveBalanceReportRows({
      year: 2026,
      ledgerRows: ledger([
        ["u-theo", "lt-annual", 2027, "GRANT", 20],
      ]),
      typeNames,
      labels,
    });
    expect(rows).toHaveLength(0);
  });
});

describe("leaveBalanceReportCsv", () => {
  it("renders the golden file: disclaimer, header, rows, CRLF endings", () => {
    const csv = leaveBalanceReportCsv({
      year: 2026,
      generatedAt: new Date("2026-11-10T22:00:00.000Z"),
      rows: [
        {
          leaveTypeId: "lt-annual", leaveTypeName: "Annual Leave",
          userId: "u-theo", userName: "Theo Jansen", employeeNumber: "EMP-004",
          opening: 44, allocated: 10, taken: 3.5, expired: 2, closing: 48.5,
        },
        {
          leaveTypeId: "lt-sick", leaveTypeName: "Sick, Leave (comma)",
          userId: "u-ada", userName: 'Ada "quotes" Lovelace', employeeNumber: null,
          opening: 0, allocated: 4, taken: 0, expired: 0, closing: 4,
        },
      ],
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("# Employee leave balance — Fernly HR — year 2026");
    expect(lines[1]).toContain("non-statutory export");
    expect(lines[2]).toBe("Leave type,Employee no,Employee,Opening balance,Allocated,Taken,Expired,Closing balance");
    expect(lines[3]).toBe("Annual Leave,EMP-004,Theo Jansen,44,10,3.5,2,48.5");
    // RFC 4180: commas and quotes quote the field; inner quotes double.
    expect(lines[4]).toBe('"Sick, Leave (comma)",,"Ada ""quotes"" Lovelace",0,4,0,0,4');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
