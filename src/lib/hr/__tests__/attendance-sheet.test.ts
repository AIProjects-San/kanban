import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P32 (AT-R01) — the monthly attendance sheet kernel tests. The CSV mirrors
// the HR console's month grid: one row per roster member, one column per
// day-of-month (benchmark vocabulary codes), eight summary columns. The
// November 2026 fixture is fully computed by hand below (Nov 1 2026 is a
// Sunday; the fixture carries one full holiday on Fri 2026-11-27 and one
// half-day holiday on Wed 2026-11-11 — a working half-day that marks as
// unmarked, exactly like the grid).
// ---------------------------------------------------------------------------

import { monthlyAttendanceSheetCsv, attendanceStatusCode } from "@/lib/hr/attendance-sheet";

const GENERATED_AT = new Date("2026-11-11T04:00:00.000Z");

/** Minimal RFC 4180 line parser (quotes + doubled quotes) for assertions. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function sheetCsv(overrides?: Partial<Parameters<typeof monthlyAttendanceSheetCsv>[0]>): string {
  return monthlyAttendanceSheetCsv({
    year: 2026,
    month: 11,
    generatedAt: GENERATED_AT,
    members: [
      { userId: "u-1", userName: "Jane Doe", employeeNumber: "EMP-0001" },
      { userId: "u-2", userName: "Solberg, Ingrid", employeeNumber: null },
    ],
    records: [
      { userId: "u-1", date: "2026-11-02", status: "PRESENT" },
      { userId: "u-1", date: "2026-11-03", status: "ABSENT" },
      { userId: "u-1", date: "2026-11-04", status: "HALF_DAY" },
      { userId: "u-1", date: "2026-11-05", status: "WFH" },
      { userId: "u-1", date: "2026-11-06", status: "ON_LEAVE" },
    ],
    holidays: [
      { date: "2026-11-27", label: "Regional anniversary", isHalfDay: false },
      { date: "2026-11-11", label: "Show half-day", isHalfDay: true },
    ],
    ...overrides,
  });
}

describe("attendance-sheet — attendanceStatusCode (the benchmark vocabulary)", () => {
  it("codes every Fernly status; unknown future statuses render raw", () => {
    expect(attendanceStatusCode("PRESENT")).toBe("P");
    expect(attendanceStatusCode("ABSENT")).toBe("A");
    expect(attendanceStatusCode("HALF_DAY")).toBe("HD");
    expect(attendanceStatusCode("WFH")).toBe("W");
    expect(attendanceStatusCode("ON_LEAVE")).toBe("L");
    expect(attendanceStatusCode("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("attendance-sheet — the file shape", () => {
  const csv = sheetCsv();
  const lines = csv.split("\r\n");

  it("leads with the identity + disclaimer + the code legend", () => {
    expect(lines[0]).toBe("# Monthly attendance sheet — Fernly HR — month 2026-11");
    expect(lines[1]).toContain("Generated 2026-11-11T04:00:00.000Z");
    expect(lines[1]).toContain("non-statutory");
    expect(lines[2]).toContain("Codes:");
    expect(lines[2]).toContain("WO weekly off");
    expect(lines[2]).toContain("H holiday");
    expect(lines[2]).toContain("blank = unmarked working day");
  });

  it("header: identity columns, one per day-of-month (30 in November), then eight summary columns", () => {
    const header = lines[3].split(",");
    expect(header).toHaveLength(2 + 30 + 8);
    expect(header.slice(0, 2)).toEqual(["Employee no", "Employee"]);
    expect(header[2]).toBe("1");
    expect(header[31]).toBe("30");
    expect(header.slice(32)).toEqual([
      "Present", "Absent", "Half days", "WFH", "On leave", "Weekly off", "Holidays", "Unmarked",
    ]);
  });

  it("CRLF line endings with exactly one trailing CRLF", () => {
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.endsWith("\r\n\r\n")).toBe(false);
    expect(lines[lines.length - 1]).toBe("");
    expect(lines).toHaveLength(3 + 1 + 2 + 1); // 3 comment/header + header + 2 members + trailing
  });

  it("quotes the comma name (RFC 4180 through the shared escaper); a null employee number renders blank", () => {
    const ingrid = parseCsvLine(lines[5]);
    expect(ingrid[0]).toBe("");
    expect(ingrid[1]).toBe("Solberg, Ingrid");
    expect(csv).toContain('"Solberg, Ingrid"');
  });
});

describe("attendance-sheet — the grid itself (November 2026, hand-computed)", () => {
  const csv = sheetCsv();
  const lines = csv.split("\r\n");
  // cells[0]=employeeNo, cells[1]=name, cells[2..31]=days 1..30, cells[32..39]=summary
  const jane = parseCsvLine(lines[4]);

  it("records code P/A/HD/W/L; unmarked weekends WO, full holidays H, working days blank", () => {
    const day = (n: number) => jane[1 + n];
    // Nov 2026: 1 Sun, 2 Mon, 3 Tue, 4 Wed, 5 Thu, 6 Fri, 7 Sat, 8 Sun …
    expect(day(1)).toBe("WO"); // Sunday
    expect(day(2)).toBe("P"); // Monday PRESENT
    expect(day(3)).toBe("A"); // Tuesday ABSENT
    expect(day(4)).toBe("HD"); // Wednesday HALF_DAY
    expect(day(5)).toBe("W"); // Thursday WFH
    expect(day(6)).toBe("L"); // Friday ON_LEAVE
    expect(day(7)).toBe("WO"); // Saturday
    expect(day(8)).toBe("WO"); // Sunday
    expect(day(9)).toBe(""); // Monday, unmarked working day
    expect(day(11)).toBe(""); // Wednesday HALF-DAY holiday: a working half-day — unmarked stays blank
    expect(day(27)).toBe("H"); // Friday full holiday, unmarked → H
    expect(day(28)).toBe("WO"); // Saturday
    expect(day(30)).toBe(""); // Monday, unmarked
  });

  it("the eight summary columns are the row's own arithmetic", () => {
    // 30 days: 5 records + 9 weekend WO + 1 holiday H + 15 unmarked (incl.
    // the half-day holiday's working half-day).
    expect(jane.slice(32, 40)).toEqual(["1", "1", "1", "1", "1", "9", "1", "15"]);
  });

  it("a record ALWAYS wins over the day classification (an explicit mark on a holiday renders its status)", () => {
    const withHolidayMark = monthlyAttendanceSheetCsv({
      year: 2026,
      month: 11,
      generatedAt: GENERATED_AT,
      members: [{ userId: "u-1", userName: "Jane Doe", employeeNumber: "EMP-0001" }],
      records: [{ userId: "u-1", date: "2026-11-27", status: "PRESENT" }], // marked ON the holiday
      holidays: [{ date: "2026-11-27", label: "Regional anniversary", isHalfDay: false }],
    });
    const row = withHolidayMark.split("\r\n")[4].split(",");
    expect(row[1 + 27]).toBe("P"); // the record codes the cell, not the calendar
    expect(row.slice(32, 40)).toEqual(["1", "0", "0", "0", "0", "9", "0", "20"]);
  });

  it("an all-blank member still gets its row (the grid's honesty — an unmarked month is information)", () => {
    const ingrid = parseCsvLine(lines[5]);
    // No records for Ingrid: every cell is WO / H / blank by the calendar.
    expect(ingrid.slice(32, 40)).toEqual(["0", "0", "0", "0", "0", "9", "1", "20"]);
  });

  it("rows keep the given roster order (the action sorts by name)", () => {
    const reordered = monthlyAttendanceSheetCsv({
      year: 2026,
      month: 11,
      generatedAt: GENERATED_AT,
      members: [
        { userId: "u-2", userName: "Zoe", employeeNumber: null },
        { userId: "u-1", userName: "Ada", employeeNumber: "EMP-0001" },
      ],
      records: [],
      holidays: [],
    });
    const rows = reordered.split("\r\n");
    expect(rows[4].startsWith(",Zoe,")).toBe(true);
    expect(rows[5].startsWith("EMP-0001,Ada,")).toBe(true);
  });
});

describe("attendance-sheet — month arithmetic", () => {
  it("February 2028 renders 29 day columns (the leap year)", () => {
    const csv = monthlyAttendanceSheetCsv({
      year: 2028,
      month: 2,
      generatedAt: GENERATED_AT,
      members: [{ userId: "u-1", userName: "Jane Doe", employeeNumber: "EMP-0001" }],
      records: [],
      holidays: [],
    });
    const header = csv.split("\r\n")[3].split(",");
    expect(header).toHaveLength(2 + 29 + 8);
    expect(header[2 + 28]).toBe("29");
    expect(csv.split("\r\n")[0]).toBe("# Monthly attendance sheet — Fernly HR — month 2028-02");
  });

  it("records outside the month or belonging to non-roster users simply never render", () => {
    const csv = monthlyAttendanceSheetCsv({
      year: 2026,
      month: 11,
      generatedAt: GENERATED_AT,
      members: [{ userId: "u-1", userName: "Jane Doe", employeeNumber: "EMP-0001" }],
      records: [
        { userId: "u-1", date: "2026-12-01", status: "PRESENT" }, // outside the month
        { userId: "u-9", date: "2026-11-02", status: "PRESENT" }, // former member
      ],
      holidays: [],
    });
    const jane = csv.split("\r\n")[4].split(",");
    expect(jane.slice(32, 40)).toEqual(["0", "0", "0", "0", "0", "9", "0", "21"]); // nothing landed
  });
});
