// ---------------------------------------------------------------------------
// G5 — biometric attendance: the pure punch kernel (no Prisma, no clock —
// the attendance-flags.ts discipline). Everything here is device- and
// vendor-independent: punch normalization, NZ day/time projection, the
// per-day IN/OUT pairing with duplicate detection, and the unpaid-break
// hours math. The reconcile ENGINE (lib/biometric/reconcile.ts) is the
// Prisma-touching consumer.
//
// Timezone note: attendance in Fernly is NZ payroll, so the canonical
// projection of a punch instant onto a (date, "HH:mm") pair is
// Pacific/Auckland (the User.timezone default). Overnight work spans two
// NZ calendar dates → two day groups → the IN day surfaces as a
// missing-OUT exception and the OUT day as a missing-IN one (the
// AttendanceRecord model is day-scoped by @@unique([userId, date]); the
// HR manual override is the resolution path, same as the manual grid).
// ---------------------------------------------------------------------------

/** The canonical attendance timezone. */
export const NZ_TZ = "Pacific/Auckland";

// ---------------------------------------------------------------------------
// Direction + reconciliation status vocabularies (schema comments mirror
// these — String columns, union pinned here and in the validation layer).
// ---------------------------------------------------------------------------

export const PUNCH_DIRECTIONS = ["IN", "OUT", "UNKNOWN"] as const;
export type PunchDirection = (typeof PUNCH_DIRECTIONS)[number];

export const PUNCH_RECONCILIATION_STATUSES = [
  "PENDING",
  "MATCHED",
  "ATTENDED",
  "UNMATCHED",
  "DUPLICATE",
  "IGNORED",
] as const;
export type PunchReconciliationStatus = (typeof PUNCH_RECONCILIATION_STATUSES)[number];

export const PUNCH_STATUS_LABELS: Record<PunchReconciliationStatus, string> = {
  PENDING: "Pending",
  MATCHED: "Matched",
  ATTENDED: "Attended",
  UNMATCHED: "Unmatched",
  DUPLICATE: "Duplicate",
  IGNORED: "Ignored",
};

/** Two explicit-direction punches by the same device user within this
 * window collapse into one (the later one is the DUPLICATE). 2 minutes —
 * the double-tap guard; the FIRST punch of each direction contributes. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// NZ time projection (Intl-based — DST-correct for every date).
// ---------------------------------------------------------------------------

const NZ_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: NZ_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface NzParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

function nzParts(instant: Date): NzParts {
  const map: Record<string, string> = {};
  for (const p of NZ_PARTS_FMT.formatToParts(instant)) map[p.type] = p.value;
  return { y: Number(map.year), mo: Number(map.month), d: Number(map.day), h: Number(map.hour), mi: Number(map.minute) };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The NZ calendar day of an instant, "yyyy-mm-dd". */
export function nzDayKey(instant: Date): string {
  const p = nzParts(instant);
  return `${pad2(p.y % 10000)}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/** The NZ wall-clock time of an instant, "HH:mm" (the AttendanceRecord
 * inTime/outTime format). */
export function nzHm(instant: Date): string {
  const p = nzParts(instant);
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}

/** NZ offset (ms) at the given instant: local-wall-as-UTC minus UTC. */
function nzOffsetMs(instant: Date): number {
  const p = nzParts(instant);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - instant.getTime();
}

/** The UTC instant of an NZ local wall time, iterated to a fixed
 * point so DST-transition days bound correctly (the naive one-shot
 * subtraction lands on the wrong side of a transition when the guess
 * crosses it — e.g. the 25h April clock-back day). Exact except for
 * wall times inside the skipped hour of a spring-forward transition
 * (nonexistent times oscillate; the last iteration wins — CSV exporters
 * should emit zoned ISO when that precision matters). */
export function nzLocalToInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let result = target;
  for (let i = 0; i < 3; i++) {
    const offset = nzOffsetMs(new Date(result));
    const next = target - offset;
    if (next === result) break;
    result = next;
  }
  return new Date(result);
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real-calendar "yyyy-mm-dd". */
export function isValidDayKey(day: string): boolean {
  if (!DAY_KEY_RE.test(day)) return false;
  const y = Number(day.slice(0, 4));
  const mo = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
}

/** The UTC instants bounding an NZ calendar day: [start, end). DST-exact
 * (23h and 25h days both bound correctly). Throws on a malformed key —
 * callers validate with isValidDayKey first (the parseDay discipline). */
export function nzDayBounds(day: string): { start: Date; end: Date } {
  if (!isValidDayKey(day)) throw new Error(`Malformed day key "${day}".`);
  const y = Number(day.slice(0, 4));
  const mo = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const start = nzLocalToInstant(y, mo, d, 0, 0);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = nzLocalToInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Ingest normalization (shared by the HTTP push route + the CSV import).
// ---------------------------------------------------------------------------

/** "in"/"out"/"unknown" (any case) → the canonical direction. null/"" →
 * UNKNOWN (most push payloads carry no direction at all). Anything else →
 * null (invalid — reject the payload). */
export function normalizeDirection(v: unknown): PunchDirection | null {
  if (v == null) return "UNKNOWN";
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  if (s === "" || s === "UNKNOWN") return "UNKNOWN";
  if (s === "IN" || s === "OUT") return s;
  return null;
}

const KNOWN_VERIFY_METHODS = ["FINGERPRINT", "FACE", "CARD", "PIN"];

/** Canonical verify method: known values upper-cased, anything else kept
 * trimmed (≤32 chars, vendor payloads win). null/""/non-string → null. */
export function normalizeVerifyMethod(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (KNOWN_VERIFY_METHODS.includes(up)) return up;
  return s.slice(0, 32);
}

/** Plausible punch range: 1990-01-01 .. 2100-01-01 (epoch millis). */
const MIN_TS_MS = Date.UTC(1990, 0, 1);
const MAX_TS_MS = Date.UTC(2100, 0, 1);

const ISO_LIKE_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse a punchedAt value: epoch seconds OR epoch millis (number) or an
 * ISO-like string ("yyyy-mm-ddTHH:mm[:ss][.sss][Z|±HH:mm]", "T" or " ").
 * Naive strings (no zone) are interpreted per `naiveZone` — "UTC" for the
 * HTTP push (deterministic wire contract), "NZ" for CSV exports (device
 * local wall time). Returns null for anything invalid, non-calendar, or
 * outside 1990..2100.
 */
export function parsePunchedAt(
  v: unknown,
  opts: { naiveZone: "NZ" | "UTC" } = { naiveZone: "UTC" },
): Date | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // Epoch seconds below this threshold (≈ 5138 as millis / 1973 as
    // seconds); millis above it — the classic s/ms split.
    let ms = v;
    if (v < 1e11) ms = v * 1000;
    if (ms < MIN_TS_MS || ms >= MAX_TS_MS) return null;
    return new Date(ms);
  }
  if (typeof v === "string") {
    const m = ISO_LIKE_RE.exec(v.trim());
    if (!m) return null;
    const zone = m[7];
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    const sec = m[6] === undefined ? 0 : Number(m[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
    const cal = new Date(Date.UTC(y, mo - 1, d));
    if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return null;
    if (zone) {
      // Parse the validated original (space→T) so the fractional
      // seconds survive — reconstructing from the regex groups would
      // drop them.
      const t = Date.parse(v.trim().replace(" ", "T"));
      return Number.isNaN(t) ? null : new Date(t);
    }
    if (opts.naiveZone === "NZ") return nzLocalToInstant(y, mo, d, h, mi);
    return new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device config readers (BiometricDevice.config is vendor-neutral JSON:
// { pushToken?: string, breakMinutes?: number }).
// ---------------------------------------------------------------------------

/** The unpaid break (minutes, 0..480) the engine deducts from a day's
 * span. Absent/garbage → 0 (no deduction). */
export function punchBreakMinutes(config: unknown): number {
  if (typeof config !== "object" || config === null) return 0;
  const v = (config as { breakMinutes?: unknown }).breakMinutes;
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(480, Math.round(v)));
}

/** The per-device push token (null when unset — the HTTP endpoint then
 * refuses to authenticate the device). */
export function devicePushToken(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return null;
  const v = (config as { pushToken?: unknown }).pushToken;
  if (typeof v !== "string" || !v.trim()) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Per-day pairing — the reconcile engine's core rule.
// ---------------------------------------------------------------------------

export interface DayPunchInput {
  id: string;
  deviceUserId: string;
  punchedAt: Date;
  direction: PunchDirection;
}

export interface DayPairing {
  /** Earliest contributing IN punch (explicit IN, or the earliest UNKNOWN
   * promoted when the day carries no explicit IN). Null = no IN. */
  inAt: Date | null;
  /** Latest contributing OUT punch (symmetric to inAt). Null = no OUT. */
  outAt: Date | null;
  /** Every kept (non-duplicate) punch id — all of them link onto the
   * derived AttendanceRecord as contributing evidence. */
  contributingIds: string[];
  /** Punch ids deduped away this pass (exact re-delivery or a same-
   * direction double-tap within DUPLICATE_WINDOW_MS). */
  duplicateIds: string[];
  /** An IN with no OUT (the exception queue's missing-OUT case). */
  missingOut: boolean;
  /** An OUT with no IN (the rarer mirror case). */
  missingIn: boolean;
}

/**
 * Derive one day's IN/OUT from its punches (already grouped per employee
 * per NZ day by the caller):
 *
 *  1. Sort by instant (deterministic tiebreak: deviceUserId, then id).
 *  2. EXACT duplicates — same deviceUserId at the same instant (a re-push
 *     that slipped past the DB guard because the device row differs, or a
 *     direction-flapping double-report) — keep the first, mark the rest.
 *  3. NEAR duplicates — same deviceUserId, same EXPLICIT direction, within
 *     DUPLICATE_WINDOW_MS of the previous kept punch of that direction —
 *     the double-tap guard. UNKNOWN-direction punches only ever hit the
 *     exact rule (a real IN→OUT sequence can legitimately be minutes
 *     apart when the device reports no directions).
 *  4. IN = earliest explicit IN (else the earliest UNKNOWN, promoted);
 *     OUT = latest explicit OUT (else the latest UNKNOWN). A lone UNKNOWN
 *     punch is an IN-only day (missingOut), never a zero-length day.
 */
export function pairDayPunches(punches: DayPunchInput[]): DayPairing {
  const sorted = [...punches].sort(
    (a, b) =>
      a.punchedAt.getTime() - b.punchedAt.getTime() ||
      (a.deviceUserId < b.deviceUserId ? -1 : a.deviceUserId > b.deviceUserId ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );

  const kept: DayPunchInput[] = [];
  const duplicateIds: string[] = [];
  const lastKeptAny = new Map<string, DayPunchInput>();
  const lastKeptByDirection = new Map<string, DayPunchInput>();

  for (const p of sorted) {
    const t = p.punchedAt.getTime();
    const prevAny = lastKeptAny.get(p.deviceUserId);
    if (prevAny && prevAny.punchedAt.getTime() === t) {
      duplicateIds.push(p.id);
      continue;
    }
    if (p.direction !== "UNKNOWN") {
      const key = `${p.deviceUserId}\u0000${p.direction}`;
      const prev = lastKeptByDirection.get(key);
      if (prev && t - prev.punchedAt.getTime() <= DUPLICATE_WINDOW_MS) {
        duplicateIds.push(p.id);
        continue;
      }
    }
    kept.push(p);
    lastKeptAny.set(p.deviceUserId, p);
    if (p.direction !== "UNKNOWN") {
      lastKeptByDirection.set(`${p.deviceUserId}\u0000${p.direction}`, p);
    }
  }

  const ins = kept.filter((p) => p.direction === "IN");
  const outs = kept.filter((p) => p.direction === "OUT");
  const unknowns = kept.filter((p) => p.direction === "UNKNOWN");

  let inAt: Date | null = ins.length ? ins[0].punchedAt : null;
  if (inAt === null && unknowns.length) inAt = unknowns[0].punchedAt;
  let outAt: Date | null = outs.length ? outs[outs.length - 1].punchedAt : null;
  if (outAt === null && unknowns.length) outAt = unknowns[unknowns.length - 1].punchedAt;
  // A single UNKNOWN punch is an IN-only day, never a zero-length day.
  if (!ins.length && !outs.length && unknowns.length === 1) outAt = null;

  return {
    inAt,
    outAt,
    contributingIds: kept.map((p) => p.id),
    duplicateIds,
    missingOut: inAt !== null && outAt === null,
    missingIn: inAt === null && outAt !== null,
  };
}

/** Net worked hours for a paired day: (out − in) minus the configured
 * unpaid break, clamped at 0, 2 decimals. Null when unpaired. (This is
 * the biometric workingHours — the S2 kernel's plain span plus the G5
 * break rule from the device config.) */
export function deriveWorkedHours(inAt: Date | null, outAt: Date | null, breakMinutes: number): number | null {
  if (inAt === null || outAt === null) return null;
  const spanMinutes = (outAt.getTime() - inAt.getTime()) / 60_000;
  if (spanMinutes <= 0) return null;
  const net = Math.max(0, spanMinutes - breakMinutes);
  return Math.round((net / 60) * 100) / 100;
}
