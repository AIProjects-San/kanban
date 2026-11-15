import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// G5 — the CSV fallback parsers: punch + mapping round-trips, malformed
// input errors with row numbers, quoted fields, BOM, and the NZ-naive
// timestamp convention.
// ---------------------------------------------------------------------------

import { parsePunchCsv, parseMappingsCsv, PUNCH_CSV_TEMPLATE, MAPPINGS_CSV_TEMPLATE } from "../punch-csv";

describe("parsePunchCsv", () => {
  it("round-trips a well-formed CSV (naive NZ timestamps, optional columns)", () => {
    const res = parsePunchCsv(
      "deviceUserId,punchedAt,direction,verifyMethod\n" +
        "1001,2026-11-10 09:05,IN,fingerprint\n" +
        '1001,2026-11-10 17:35,,\n' +
        '1002,"2026-11-10T09:00:00+13:00",,PALM\n',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toHaveLength(3);
    // 09:05 NZ (UTC+13) = 2026-11-09T20:05Z
    expect(res.rows[0].punchedAt.toISOString()).toBe("2026-11-09T20:05:00.000Z");
    expect(res.rows[0].direction).toBe("IN");
    expect(res.rows[0].verifyMethod).toBe("FINGERPRINT");
    expect(res.rows[1].direction).toBe("UNKNOWN");
    expect(res.rows[1].verifyMethod).toBeNull();
    // zoned ISO passes through verbatim; unknown verify methods survive.
    expect(res.rows[2].punchedAt.toISOString()).toBe("2026-11-09T20:00:00.000Z");
    expect(res.rows[2].verifyMethod).toBe("PALM");
  });

  it("accepts epoch seconds/millis in the punchedAt column", () => {
    const t = Date.UTC(2026, 10, 9, 20, 5);
    const res = parsePunchCsv(
      `deviceUserId,punchedAt\n1001,${t / 1000}\n1001,${t}\n`,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0].punchedAt.getTime()).toBe(t);
    expect(res.rows[1].punchedAt.getTime()).toBe(t);
  });

  it("strips a BOM and tolerates CRLF", () => {
    const res = parsePunchCsv("\uFEFFdeviceUserId,punchedAt,direction\r\n1001,2026-11-10 09:05,IN\r\n");
    expect(res.ok).toBe(true);
  });

  it("rejects the malformed shapes with row-level errors", () => {
    expect(parsePunchCsv("")).toEqual({ ok: false, error: "The CSV is empty." });
    expect(parsePunchCsv("userId,when\n1001,2026-11-10 09:05")).not.toHaveProperty("rows");
    expect(parsePunchCsv("deviceUserId,punchedAt\n,2026-11-10 09:05")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Row 2"),
    });
    expect(parsePunchCsv("deviceUserId,punchedAt\n1001,not-a-time")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Row 2"),
    });
    expect(parsePunchCsv("deviceUserId,punchedAt,direction\n1001,2026-11-10 09:05,SIDEWAYS")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Row 2"),
    });
    expect(parsePunchCsv('deviceUserId,punchedAt\n"1001,2026-11-10 09:05')).toMatchObject({
      ok: false,
      error: expect.stringContaining("unbalanced quoting"),
    });
    expect(parsePunchCsv("deviceUserId,punchedAt\n1001,2026-02-30 09:05")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Row 2"),
    });
  });

  it("enforces the row cap", () => {
    const lines = ["deviceUserId,punchedAt"];
    for (let i = 0; i < 5001; i++) lines.push(`1001,2026-11-10 09:0${i % 10}`);
    expect(parsePunchCsv(lines.join("\n"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("limit"),
    });
  });

  it("renders a valid template", () => {
    expect(parsePunchCsv(PUNCH_CSV_TEMPLATE).ok).toBe(true);
  });
});

describe("parseMappingsCsv", () => {
  it("round-trips the employeeEmail variant", () => {
    const res = parseMappingsCsv("deviceUserId,employeeEmail\n1001,alice@fernly.example\n");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]).toEqual({
      deviceUserId: "1001",
      employeeEmail: "alice@fernly.example",
      employeeId: null,
    });
  });

  it("round-trips the employeeId variant and ignores extra columns", () => {
    const res = parseMappingsCsv("deviceUserId,employeeId,note\n1001,u-123,hello\n");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0].employeeEmail).toBeNull();
    expect(res.rows[0].employeeId).toBe("u-123");
  });

  it("requires an employee column in the header", () => {
    expect(parseMappingsCsv("deviceUserId,note\n1001,x")).toMatchObject({
      ok: false,
      error: expect.stringContaining("employeeEmail"),
    });
  });

  it("rejects rows without any employee reference and bad emails", () => {
    expect(parseMappingsCsv("deviceUserId,employeeEmail\n1001,\n")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Row 2"),
    });
    expect(parseMappingsCsv("deviceUserId,employeeEmail\n1001,not-an-email\n")).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a valid email"),
    });
  });

  it("renders a valid template", () => {
    expect(parseMappingsCsv(MAPPINGS_CSV_TEMPLATE).ok).toBe(true);
  });
});
