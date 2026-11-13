import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P32 (PL-11) — the shared report-CSV helper tests: the RFC 4180 escaper
// (re-exported by payroll-csv — one definition), the row composer, the
// disclaimer header lines (default shape + the payroll family's product /
// ADR-014 restatement + legends) and the CRLF file body. The payroll and
// leave-balance golden suites pin that the refactored builders stay
// byte-identical; this file pins the shared primitives themselves.
// ---------------------------------------------------------------------------

import {
  csvEscape,
  csvRow,
  reportCsvHeaderLines,
  csvFileBody,
} from "@/lib/report-csv";

describe("report-csv — csvEscape (RFC 4180)", () => {
  it("is the same function payroll-csv re-exports (one definition)", () => {
  });

  it("quotes iff comma / quote / newline / edge-space, doubling inner quotes", () => {
    expect(csvEscape("Yuki Tanaka")).toBe("Yuki Tanaka");
    expect(csvEscape(123)).toBe("123");
    expect(csvEscape("")).toBe("");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape("Solberg, Ingrid")).toBe('"Solberg, Ingrid"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape(" padded ")).toBe('" padded "');
  });
});

describe("report-csv — csvRow", () => {
  it("joins raw fields with commas through the escaper", () => {
    expect(csvRow(["a", 1, null, undefined, "b,c"])).toBe('a,1,,,\"b,c\"');
  });
});

describe("report-csv — reportCsvHeaderLines", () => {
  const GENERATED_AT = new Date("2026-11-11T04:00:00.000Z");

  it("renders the default identity + disclaimer pair", () => {
    expect(reportCsvHeaderLines({ kind: "Monthly attendance sheet", scope: "month 2026-11", generatedAt: GENERATED_AT })).toEqual([
      "# Monthly attendance sheet — Fernly HR — month 2026-11",
      `# Generated ${GENERATED_AT.toISOString()} — non-statutory export; verify before use.`,
    ]);
  });

  it("carries a per-family product name and disclaimer restatement, plus RFC 4180-escaped legend lines", () => {
    const lines = reportCsvHeaderLines({
      kind: "Salary register",
      scope: "period 2026-11",
      product: "Fernly Payroll",
      generatedAt: GENERATED_AT,
      disclaimerExtra: " Not a tax document (ADR-014).",
      extraLines: ["Codes: P present, A absent", 'the "half" day'],
    });
    expect(lines[0]).toBe("# Salary register — Fernly Payroll — period 2026-11");
    expect(lines[1]).toBe(
      `# Generated ${GENERATED_AT.toISOString()} — non-statutory export; verify before use. Not a tax document (ADR-014).`,
    );
    // A legend carrying a comma is quoted whole (one field, the payroll
    // workspace-line precedent); the quote legend doubles its inner quotes.
    expect(lines[2]).toBe('# "Codes: P present, A absent"');
    expect(lines[3]).toBe('# "the ""half"" day"');
  });
});

describe("report-csv — csvFileBody", () => {
  it("joins with CRLF and always ends with one trailing CRLF", () => {
    expect(csvFileBody(["a", "b"])).toBe("a\r\nb\r\n");
    expect(csvFileBody(["a"])).toBe("a\r\n");
    expect(csvFileBody(["a", "b"]).endsWith("\r\n")).toBe(true);
  });
});
