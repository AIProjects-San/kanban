// ---------------------------------------------------------------------------
// G5 — the CSV fallback (the day-1 path for vendors with no protocol
// support): parse punch + device-user-mapping CSVs into rows the ingest
// actions write into the SAME Punch / DeviceUserMapping tables, so the
// reconcile engine treats them identically to pushed punches.
//
// Formats (header row required, case-insensitive column names, extra
// columns ignored, quoted fields supported):
//
//   punches:
//     deviceUserId,punchedAt,direction,verifyMethod
//     1001,2026-11-10 09:00,IN,FINGERPRINT
//     1001,2026-11-10 17:30,OUT,
//
//   mappings (employeeEmail OR employeeId column):
//     deviceUserId,employeeEmail
//     1001,alice@fernly.example
//
// punchedAt accepts zoned ISO ("2026-11-10T09:00:00+13:00"), epoch
// seconds/millis ("1799280000") or NAIVE local time ("2026-11-10
// 09:00"), interpreted as NZ wall time (device export convention).
// Zoned ISO wins when DST-edge precision matters.
//
// Pure kernel: no Prisma, no fs — the actions own the writes.
// ---------------------------------------------------------------------------

import {
  normalizeDirection,
  normalizeVerifyMethod,
  parsePunchedAt,
  type PunchDirection,
} from "./punches";

const MAX_ROWS = 5000;

/** Strip a UTF-8 BOM + split on CRLF/LF. */
function csvLines(text: string): string[] {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/);
}

/** Split one CSV line into fields (quoted fields with doubled quotes;
 * null when the quoting is unbalanced). */
function splitCsvLine(line: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (inQuotes) return null;
  out.push(cur);
  return out;
}

interface ParsedCsv {
  header: Map<string, number>;
  rows: string[][];
}

/** Header + data rows; null + message on malformed structure. */
function parseCsv(text: string, required: string[]): { ok: true; csv: ParsedCsv } | { ok: false; error: string } {
  const lines = csvLines(text).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { ok: false, error: "The CSV is empty." };
  const headerFields = splitCsvLine(lines[0]);
  if (!headerFields) return { ok: false, error: "Row 1 has unbalanced quoting." };
  const header = new Map<string, number>();
  headerFields.forEach((h, i) => header.set(h.trim().toLowerCase(), i));
  for (const col of required) {
    if (!header.has(col)) {
      return { ok: false, error: `Row 1: the header is missing the "${col}" column.` };
    }
  }
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]);
    if (!fields) return { ok: false, error: `Row ${i + 1} has unbalanced quoting.` };
    if (fields.length > headerFields.length) {
      return { ok: false, error: `Row ${i + 1} has more fields than the header.` };
    }
    rows.push(fields);
  }
  if (rows.length > MAX_ROWS) {
    return { ok: false, error: `The CSV has ${rows.length} rows — the limit is ${MAX_ROWS} per upload.` };
  }
  return { ok: true, csv: { header, rows } };
}

function fieldAt(csv: ParsedCsv, row: string[], col: string): string {
  const i = csv.header.get(col);
  return i === undefined || i >= row.length ? "" : row[i].trim();
}

// ---------------------------------------------------------------------------
// Punches
// ---------------------------------------------------------------------------

export interface CsvPunchRow {
  deviceUserId: string;
  punchedAt: Date;
  direction: PunchDirection;
  verifyMethod: string | null;
}

export type ParsePunchCsvResult =
  | { ok: true; rows: CsvPunchRow[] }
  | { ok: false; error: string };

export function parsePunchCsv(text: string): ParsePunchCsvResult {
  const parsed = parseCsv(text, ["deviceuserid", "punchedat"]);
  if (!parsed.ok) return parsed;
  const { csv } = parsed;
  const rows: CsvPunchRow[] = [];
  for (let i = 0; i < csv.rows.length; i++) {
    const lineNo = i + 2; // header is line 1
    const row = csv.rows[i];
    const deviceUserId = fieldAt(csv, row, "deviceuserid");
    if (!deviceUserId || deviceUserId.length > 64) {
      return { ok: false, error: `Row ${lineNo}: deviceUserId is required (1–64 characters).` };
    }
    // Pure digits read as epoch seconds/millis (device exports often
    // quote them); everything else is an ISO-ish timestamp string.
    const rawTs = fieldAt(csv, row, "punchedat");
    const punchedAt = parsePunchedAt(/^\d+$/.test(rawTs) ? Number(rawTs) : rawTs, { naiveZone: "NZ" });
    if (!punchedAt) {
      return { ok: false, error: `Row ${lineNo}: punchedAt "${rawTs}" is not a valid timestamp (zoned ISO, epoch, or "yyyy-MM-dd HH:mm" NZ local).` };
    }
    const directionRaw = fieldAt(csv, row, "direction");
    const direction = normalizeDirection(directionRaw);
    if (direction === null) {
      return { ok: false, error: `Row ${lineNo}: direction "${directionRaw}" is not IN, OUT or UNKNOWN.` };
    }
    rows.push({
      deviceUserId,
      punchedAt,
      direction,
      verifyMethod: normalizeVerifyMethod(fieldAt(csv, row, "verifymethod")),
    });
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// Device-user mappings
// ---------------------------------------------------------------------------

export interface CsvMappingRow {
  deviceUserId: string;
  employeeEmail: string | null;
  employeeId: string | null;
}

export type ParseMappingsCsvResult =
  | { ok: true; rows: CsvMappingRow[] }
  | { ok: false; error: string };

export function parseMappingsCsv(text: string): ParseMappingsCsvResult {
  const parsed = parseCsv(text, ["deviceuserid"]);
  if (!parsed.ok) return parsed;
  const { csv } = parsed;
  const byEmail = csv.header.has("employeeemail");
  const byId = csv.header.has("employeeid");
  if (!byEmail && !byId) {
    return { ok: false, error: "Row 1: the header needs an employeeEmail or an employeeId column." };
  }
  const rows: CsvMappingRow[] = [];
  for (let i = 0; i < csv.rows.length; i++) {
    const lineNo = i + 2;
    const row = csv.rows[i];
    const deviceUserId = fieldAt(csv, row, "deviceuserid");
    if (!deviceUserId || deviceUserId.length > 64) {
      return { ok: false, error: `Row ${lineNo}: deviceUserId is required (1–64 characters).` };
    }
    const email = byEmail ? fieldAt(csv, row, "employeeemail").toLowerCase() : "";
    const id = byId ? fieldAt(csv, row, "employeeid") : "";
    if (!email && !id) {
      return { ok: false, error: `Row ${lineNo}: an employeeEmail or employeeId is required.` };
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: `Row ${lineNo}: "${email}" is not a valid email.` };
    }
    rows.push({ deviceUserId, employeeEmail: email || null, employeeId: id || null });
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// UI template hints (the import panels render these).
// ---------------------------------------------------------------------------

export const PUNCH_CSV_TEMPLATE =
  "deviceUserId,punchedAt,direction,verifyMethod\n1001,2026-11-10 09:00,IN,FINGERPRINT\n1001,2026-11-10 17:30,OUT,\n";

export const MAPPINGS_CSV_TEMPLATE =
  "deviceUserId,employeeEmail\n1001,alice@fernly.example\n";
