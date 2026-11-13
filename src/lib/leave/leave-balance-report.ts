// ---------------------------------------------------------------------------
// P21 (LV-R01) — the employee leave balance report (pure kernel).
// Benchmark: hrms/hr/report/employee_leave_balance — per (leave type ×
// employee): Opening Balance, Leaves Allocated, Leaves Taken, Leaves
// Expired, Closing Balance; all-zero pairs skipped.
//
// Fernly mapping from the append-only LeaveLedgerEntry (F1.2) for a target
// year Y over the pair (user, type):
//   opening   = Σ delta over years < Y      (the carried-in position)
//   allocated = Σ delta of GRANT + CARRY + ADJUST rows in year Y
//   taken     = −Σ delta of CONSUME rows in year Y   (display-positive)
//   expired   = −Σ delta of EXPIRE rows in year Y    (display-positive;
//               Fernly's rollover cap and carry lapse both write EXPIRE)
//   closing   = opening + allocated − taken − expired
//
// BALANCE_IMPORT / REVERSAL / MIGRATION rows ride the signed sums naturally
// (import = opening position; a reversal of a consumption is +delta and
// restores taken). Zero-everything pairs are skipped, matching the
// benchmark's "leave out pairs without ledger entries" filter.
//
// Pure and dependency-free: the server action feeds ledger rows + label
// maps; unit tests own the arithmetic. P32: the CSV builder rides the
// shared `lib/shared/report-csv.ts` helper (one file shape for every report).
// ---------------------------------------------------------------------------

import { csvRow, reportCsvHeaderLines, csvFileBody } from "@/lib/shared/report-csv";

import { round2 } from "@/lib/payroll/payroll-math";

export interface LedgerRowForReport {
  userId: string;
  leaveTypeId: string;
  year: number;
  entryType: string;
  delta: number;
}

export interface ReportLabel {
  userId: string;
  userName: string;
  employeeNumber?: string | null;
}

export interface LeaveBalanceReportRow {
  leaveTypeId: string;
  leaveTypeName: string;
  userId: string;
  userName: string;
  employeeNumber: string | null;
  opening: number;
  allocated: number;
  taken: number;
  expired: number;
  closing: number;
}

/** Build the report rows from raw ledger rows for the target year. */
export function buildLeaveBalanceReportRows(input: {
  year: number;
  ledgerRows: LedgerRowForReport[];
  typeNames: Map<string, string>;
  labels: Map<string, ReportLabel>;
}): LeaveBalanceReportRow[] {
  interface Acc {
    opening: number;
    allocated: number;
    taken: number;
    expired: number;
  }
  const acc = new Map<string, Acc>();
  const bump = (userId: string, leaveTypeId: string): Acc => {
    const key = `${userId}\u0000${leaveTypeId}`;
    let a = acc.get(key);
    if (!a) {
      a = { opening: 0, allocated: 0, taken: 0, expired: 0 };
      acc.set(key, a);
    }
    return a;
  };

  for (const r of input.ledgerRows) {
    const a = bump(r.userId, r.leaveTypeId);
    if (r.year < input.year) {
      a.opening += r.delta;
    } else if (r.year === input.year) {
      switch (r.entryType) {
        case "GRANT":
        case "CARRY":
        case "ADJUST":
        case "BALANCE_IMPORT":
          a.allocated += r.delta;
          break;
        case "CONSUME":
          a.taken -= r.delta; // deltas are negative; taken displays positive
          break;
        case "EXPIRE":
          a.expired -= r.delta; // deltas are negative; expired displays positive
          break;
        default:
          // REVERSAL-of-consume (+delta, entryType REVERSAL) and any future
          // kinds ride the opening-neutral allocation bucket only when the
          // year matches; unknown kinds contribute to allocated so the
          // closing math never silently drops a mutation.
          a.allocated += r.delta;
          break;
      }
    }
  }

  const rows: LeaveBalanceReportRow[] = [];
  for (const [key, a] of acc) {
    const [userId, leaveTypeId] = key.split("\u0000");
    const label = input.labels.get(userId) ?? { userId, userName: "(deleted user)" };
    const opening = round2(a.opening);
    const allocated = round2(a.allocated);
    const taken = round2(a.taken);
    const expired = round2(a.expired);
    const closing = round2(opening + allocated - taken - expired);
    // The benchmark leaves all-zero pairs out of the report.
    if (opening === 0 && allocated === 0 && taken === 0 && expired === 0) continue;
    rows.push({
      leaveTypeId,
      leaveTypeName: input.typeNames.get(leaveTypeId) ?? "(deleted type)",
      userId,
      userName: label.userName,
      employeeNumber: label.employeeNumber ?? null,
      opening,
      allocated,
      taken,
      expired,
      closing,
    });
  }
  // Stable order: type name, then employee name, then user id (deterministic
  // output for the golden-file CSV test).
  rows.sort((x, y) =>
    x.leaveTypeName.localeCompare(y.leaveTypeName) ||
    x.userName.localeCompare(y.userName) ||
    x.userId.localeCompare(y.userId),
  );
  return rows;
}

/** LV-R01 — the balance report CSV (one row per type × employee; rides the
 * P32 shared report-csv helper — bytes unchanged, golden-pinned). */
export function leaveBalanceReportCsv(input: {
  year: number;
  generatedAt?: Date;
  rows: LeaveBalanceReportRow[];
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const lines = [
    ...reportCsvHeaderLines({ kind: "Employee leave balance", scope: `year ${input.year}`, generatedAt }),
    csvRow(["Leave type", "Employee no", "Employee", "Opening balance", "Allocated", "Taken", "Expired", "Closing balance"]),
  ];
  for (const r of input.rows) {
    lines.push(
      csvRow([
        r.leaveTypeName,
        r.employeeNumber ?? "",
        r.userName,
        r.opening,
        r.allocated,
        r.taken,
        r.expired,
        r.closing,
      ]),
    );
  }
  return csvFileBody(lines);
}
