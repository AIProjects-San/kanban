// ---------------------------------------------------------------------------
// P20 (PR-R01/PR-R02) — the payroll run CSV builders (pure; golden-file
// tested). Both exports are per LOCKED run (paid money only) and carry the
// non-statutory disclaimer in a leading comment line — Fernly deliberately
// renders no statutory totals (ADR-014), so the files state what they are.
//
// RFC 4180 discipline: a field is quoted iff it contains a comma, a double
// quote, a newline or a leading/trailing space; quotes inside double.
// Numbers are rendered as plain decimal strings (no thousands separators —
// bank files feed parsers, not eyes).
// ---------------------------------------------------------------------------

/** RFC 4180 field escaping. */
export function csvEscape(field: string | number | null | undefined): string {
  const s = field == null ? "" : String(field);
  if (/[",\r\n]/.test(s) || s !== s.trim()) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(fields: Array<string | number | null | undefined>): string {
  return fields.map(csvEscape).join(",");
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** The shared leading comment lines (the non-statutory disclaimer). */
function disclaimerLines(kind: "Salary register" | "Bank remittance", period: string, generatedAt: Date): string[] {
  return [
    `# ${kind} — Fernly Payroll — period ${period}`,
    `# Generated ${generatedAt.toISOString()} — non-statutory export; verify before use. Not a tax document (ADR-014).`,
  ];
}

/** PR-R01 — the salary register: one row per paid slip + a totals row. */
export function salaryRegisterCsv(input: {
  period: string;
  generatedAt?: Date;
  rows: Array<{
    slipNo: string;
    employeeNumber: string | null;
    employeeName: string;
    jobTitle: string;
    gross: number;
    deductions: number;
    net: number;
    lopDays: number;
    withholdStatus: string;
  }>;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const lines = [
    ...disclaimerLines("Salary register", input.period, generatedAt),
    row(["Slip no", "Employee no", "Employee", "Job title", "Gross", "Deductions", "Net pay", "LOP days", "Withheld"]),
    ...input.rows.map((r) =>
      row([
        r.slipNo,
        r.employeeNumber ?? "",
        r.employeeName,
        r.jobTitle,
        money(r.gross),
        money(r.deductions),
        money(r.net),
        r.lopDays % 1 === 0 ? String(r.lopDays) : r.lopDays.toFixed(2),
        r.withholdStatus === "WITHHELD" ? "WITHHELD" : r.withholdStatus === "RELEASED" ? "RELEASED" : "",
      ]),
    ),
  ];
  const gross = input.rows.reduce((s, r) => s + r.gross, 0);
  const deductions = input.rows.reduce((s, r) => s + r.deductions, 0);
  const net = input.rows.reduce((s, r) => s + r.net, 0);
  lines.push(row(["TOTAL", "", `${input.rows.length} payslip(s)`, "", money(gross), money(deductions), money(net), "", ""]));
  return `${lines.join("\r\n")}\r\n`;
}

/** PR-R02 — the bank remittance advice: one payment row per paid slip, the
 * bank-account column left blank (Fernly stores no bank details — the
 * employer's bank maps accounts from its records; the plan's lite shape). */
export function bankRemittanceCsv(input: {
  period: string;
  workspaceName?: string;
  generatedAt?: Date;
  rows: Array<{
    slipNo: string;
    employeeNumber: string | null;
    employeeName: string;
    net: number;
    withholdStatus: string;
  }>;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const lines = [
    ...disclaimerLines("Bank remittance", input.period, generatedAt),
    ...(input.workspaceName ? [`# Workspace: ${csvEscape(input.workspaceName)}`] : []),
    row(["Employee no", "Employee name", "Bank account", "Amount", "Currency", "Period", "Payment reference"]),
    ...input.rows
      // WITHHELD nets are not disbursed — they never reach the bank file.
      .filter((r) => r.withholdStatus !== "WITHHELD")
      .map((r) =>
        row([
          r.employeeNumber ?? "",
          r.employeeName,
          "", // the employer's bank fills this from its records
          money(r.net),
          "NZD",
          input.period,
          r.slipNo,
        ]),
      ),
  ];
  const disbursed = input.rows
    .filter((r) => r.withholdStatus !== "WITHHELD")
    .reduce((s, r) => s + r.net, 0);
  lines.push(row(["TOTAL", `${input.rows.filter((r) => r.withholdStatus !== "WITHHELD").length} payment(s)`, "", money(disbursed), "NZD", input.period, ""]));
  return `${lines.join("\r\n")}\r\n`;
}
