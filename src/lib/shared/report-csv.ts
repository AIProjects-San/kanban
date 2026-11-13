// ---------------------------------------------------------------------------
// P32 (PL-11) — the shared report-CSV helper: the ONE place every tabular
// report export gets its file shape from (RFC 4180 escaping, the leading
// disclaimer comment lines, the CRLF file composer). The payroll register
// and bank remittance (P20), the leave balance report (P21) and the two
// P32 surfaces (monthly attendance sheet, employee information) all ride
// these primitives — a new report CSV never re-invents the discipline.
//
// RFC 4180 discipline (unchanged from the P20 escaper it supersedes): a
// field is quoted iff it contains a comma, a double quote, a newline or a
// leading/trailing space; quotes inside double. Numbers are rendered as
// plain decimal strings (no thousands separators — report files feed
// parsers, not eyes).
//
// House disclaimer posture (ADR-014): Fernly renders no statutory totals,
// so every exported file states what it is — a non-statutory export to be
// verified before use — in a leading comment line.
//
// Pure and dependency-free: server actions feed rows; tests own the bytes.
// ---------------------------------------------------------------------------

/** RFC 4180 field escaping — quote iff comma/quote/newline/edge-space. */
export function csvEscape(field: string | number | null | undefined): string {
  const s = field == null ? "" : String(field);
  if (/[",\r\n]/.test(s) || s !== s.trim()) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** One comma-joined CSV row from raw fields. */
export function csvRow(fields: Array<string | number | null | undefined>): string {
  return fields.map(csvEscape).join(",");
}

/**
 * The shared leading comment lines every report CSV opens with: the report
 * identity, the generation instant, and the non-statutory disclaimer.
 * `disclaimerExtra` appends a per-family restatement to the disclaimer line
 * (the payroll files keep their explicit "Not a tax document (ADR-014)."),
 * `extraLines` carry per-report legends (e.g. the attendance sheet's code
 * legend) — each is prefixed with "# " and RFC 4180-escaped as one field.
 */
export function reportCsvHeaderLines(input: {
  kind: string;
  scope: string;
  /** The product name on line 1 — "Fernly HR" by default; the payroll
   * files keep their pinned "Fernly Payroll" identity. */
  product?: string;
  generatedAt?: Date;
  disclaimerExtra?: string;
  extraLines?: string[];
}): string[] {
  const generatedAt = input.generatedAt ?? new Date();
  const product = input.product ?? "Fernly HR";
  const lines = [
    `# ${input.kind} — ${product} — ${input.scope}`,
    `# Generated ${generatedAt.toISOString()} — non-statutory export; verify before use.${input.disclaimerExtra ?? ""}`,
  ];
  for (const extra of input.extraLines ?? []) {
    lines.push(`# ${csvEscape(extra)}`);
  }
  return lines;
}

/** Join report lines into the final CRLF-terminated CSV file body. */
export function csvFileBody(lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}
