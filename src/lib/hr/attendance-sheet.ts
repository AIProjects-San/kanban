// ---------------------------------------------------------------------------
// P32 (AT-R01) — the monthly attendance sheet report (pure kernel).
// Benchmark: hrms/hr/report/monthly_attendance_sheet — one row per
// employee, one column per day of the month, each cell a status code
// (P/A/HD/H/WO/L in the benchmark's vocabulary), with per-row totals.
//
// Fernly renders the HR console's own month grid (F1.3) as the sheet:
//   • every RECORD cell codes its status:
//       PRESENT → P   ABSENT → A   HALF_DAY → HD   WFH → W   ON_LEAVE → L
//     (the benchmark vocabulary — the in-app grid's compact letters differ
//     (H/W), the CSV legend line defines every code so no cell is ambiguous)
//   • every UNMARKED cell codes the day itself, through the same dayKind
//     classifier the F-R15 marking guard uses (one rule, both callers):
//       WEEKEND → WO   FULL_HOLIDAY → H
//       WORKING / HALF_HOLIDAY → blank (an unmarked working day — half-day
//       holidays are working half-days in the house model, markable and
//       LOP-charged; a blank cell is the honest "not marked")
//   • eight summary columns close each row: counts of P, A, HD, W, L, WO, H
//     and unmarked (blank) cells — the sheet's own arithmetic, not a
//     re-derivation of the LOP pipeline.
//
// The roster mirrors the grid exactly: every live member gets a row, all
// blank included (an unmarked month is real information), in the roster's
// name order; records of former members simply never render (their rows
// are gone with the user). Employee numbers come from the directory side.
//
// The file rides the P32 shared `lib/report-csv.ts` helper (RFC 4180
// escaping, the disclaimer header, the CRLF body). Pure and
// dependency-free beyond that: the server action feeds the inputs, the
// unit tests own the bytes.
// ---------------------------------------------------------------------------

import { csvRow, reportCsvHeaderLines, csvFileBody } from "@/lib/report-csv";
import { dayKind } from "@/lib/working-days";

export interface AttendanceSheetMember {
  userId: string;
  userName: string;
  employeeNumber?: string | null;
}

export interface AttendanceSheetRecord {
  userId: string;
  /** "yyyy-mm-dd" */
  date: string;
  status: string;
}

export interface SheetHoliday {
  /** "yyyy-mm-dd" */
  date: string;
  label: string;
  isHalfDay: boolean;
}

/** The code a RECORD cell renders for its status (benchmark vocabulary). */
export function attendanceStatusCode(status: string): string {
  switch (status) {
    case "PRESENT": return "P";
    case "ABSENT": return "A";
    case "HALF_DAY": return "HD";
    case "WFH": return "W";
    case "ON_LEAVE": return "L";
    default: return status; // unknown future statuses render honestly raw
  }
}

/** The code an UNMARKED cell renders for the day itself. */
function unmarkedDayCode(date: Date, holiday?: SheetHoliday): string {
  switch (dayKind(date, holiday ? { label: holiday.label, isHalfDay: holiday.isHalfDay } : null)) {
    case "WEEKEND": return "WO";
    case "FULL_HOLIDAY": return "H";
    default: return ""; // WORKING / HALF_HOLIDAY — an unmarked working day
  }
}

const CODE_LEGEND =
  "Codes: P present · A absent · HD half day · W work-from-home · L on leave · " +
  "WO weekly off (unmarked weekend) · H holiday (unmarked full holiday) · blank = unmarked working day.";

/**
 * AT-R01 — the monthly attendance sheet CSV: leading comment lines
 * (identity + disclaimer + the code legend), the header row (identity
 * columns, one column per day-of-month, eight summary columns), one row
 * per member in the given roster order.
 */
export function monthlyAttendanceSheetCsv(input: {
  year: number;
  month: number;
  generatedAt?: Date;
  members: AttendanceSheetMember[];
  records: AttendanceSheetRecord[];
  holidays: SheetHoliday[];
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const daysInMonth = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const d = new Date(Date.UTC(input.year, input.month - 1, i + 1));
    return { num: i + 1, date: d, iso: d.toISOString().slice(0, 10) };
  });

  const holidayByDate = new Map<string, SheetHoliday>(input.holidays.map((h) => [h.date, h]));
  const recordByUserDate = new Map<string, AttendanceSheetRecord>();
  for (const r of input.records) recordByUserDate.set(`${r.userId}|${r.date}`, r);

  const lines = [
    ...reportCsvHeaderLines({
      kind: "Monthly attendance sheet",
      scope: `month ${input.year}-${String(input.month).padStart(2, "0")}`,
      generatedAt,
      extraLines: [CODE_LEGEND],
    }),
    csvRow([
      "Employee no",
      "Employee",
      ...days.map((d) => String(d.num)),
      "Present",
      "Absent",
      "Half days",
      "WFH",
      "On leave",
      "Weekly off",
      "Holidays",
      "Unmarked",
    ]),
  ];

  for (const member of input.members) {
    const cells: string[] = [];
    const counts = { P: 0, A: 0, HD: 0, W: 0, L: 0, WO: 0, H: 0, blank: 0 };
    for (const day of days) {
      const rec = recordByUserDate.get(`${member.userId}|${day.iso}`);
      let code: string;
      if (rec) {
        code = attendanceStatusCode(rec.status);
      } else {
        code = unmarkedDayCode(day.date, holidayByDate.get(day.iso));
      }
      cells.push(code);
      if (code === "") counts.blank += 1;
      else if (code === "P") counts.P += 1;
      else if (code === "A") counts.A += 1;
      else if (code === "HD") counts.HD += 1;
      else if (code === "W") counts.W += 1;
      else if (code === "L") counts.L += 1;
      else if (code === "WO") counts.WO += 1;
      else if (code === "H") counts.H += 1;
    }
    lines.push(
      csvRow([
        member.employeeNumber ?? "",
        member.userName,
        ...cells,
        counts.P,
        counts.A,
        counts.HD,
        counts.W,
        counts.L,
        counts.WO,
        counts.H,
        counts.blank,
      ]),
    );
  }
  return csvFileBody(lines);
}
