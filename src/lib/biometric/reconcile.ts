// ---------------------------------------------------------------------------
// G5 — the punch reconciliation engine. Device- and vendor-independent:
// it consumes Punch rows (however they arrived — HTTP push, CSV import,
// a future fetchPunches adapter) and derives AttendanceRecords.
//
// The pass, per device + time window:
//   1. Load the device's PENDING and MATCHED punches in the window
//      (MATCHED includes manually-overridden punches awaiting their
//      derivation — the exception-queue loop's second half).
//   2. Resolve each punch's deviceUserId through DeviceUserMapping; no
//      mapping → UNMATCHED (the exception queue's input). Mapped punches
//      group per (employee, NZ day).
//   3. Per group, pair the day (lib/biometric/punches.pairDayPunches):
//      IN = earliest, OUT = latest, duplicates collapsed. The pairing
//      input ALSO includes the day's already-ATTENDED punches for that
//      employee (any device) — so partial windows and multi-device days
//      re-derive the SAME record instead of clobbering one side.
//   4. Upsert the AttendanceRecord: create, re-derive an existing
//      BIOMETRIC row, or — when a MANUAL/DERIVED mark already stands —
//      leave its content untouched and only link the punches (an
//      explicit HR decision always outranks the engine). Non-working
//      days (F-R15 house rule) get NO record: the punches are marked
//      ATTENDED and counted in the report, but the mark is left to HR.
//   5. Contributing punches → ATTENDED + employeeId + the record link;
//      duplicates → DUPLICATE.
//
// Idempotent by construction: a terminal punch (ATTENDED / UNMATCHED /
// DUPLICATE / IGNORED) is never re-loaded, and a re-derived BIOMETRIC
// record is a pure function of the day's punches — running the same
// window twice produces the same AttendanceRecords and reports zeros.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import { deriveAttendanceTiming } from "@/lib/hr/attendance-flags";
import { dayKey, parseDay, nonWorkingDayReason } from "@/lib/hr/working-days";
import {
  nzDayBounds,
  nzDayKey,
  nzHm,
  pairDayPunches,
  punchBreakMinutes,
  deriveWorkedHours,
  type DayPunchInput,
  type PunchDirection,
} from "./punches";

export interface ReconciliationReport {
  deviceId: string;
  deviceName: string;
  windowStart: Date;
  windowEnd: Date;
  /** PENDING/MATCHED punches examined this run. */
  processed: number;
  /** Punches resolved to an employee through a mapping (or an override). */
  matched: number;
  /** Punches left UNMATCHED (no mapping — the exception queue). */
  unmatched: number;
  /** Punches promoted to ATTENDED (linked to a record, or a non-working
   * day's evidence-only promotion). */
  attended: number;
  /** Punches marked DUPLICATE this run. */
  duplicates: number;
  recordsCreated: number;
  recordsUpdated: number;
  /** Days whose existing MANUAL/DERIVED mark outranked the engine. */
  recordsSkippedExisting: number;
  /** Days with punches but no record (weekend/full holiday — F-R15). */
  daysSkippedNonWorking: number;
  /** Days that paired an IN with no OUT (exception queue). */
  missingOutDays: number;
  /** Days that paired an OUT with no IN (exception queue). */
  missingInDays: number;
}

interface PunchRow {
  id: string;
  deviceUserId: string;
  employeeId: string | null;
  punchedAt: Date;
  direction: string;
}

function toPairInput(p: PunchRow): DayPunchInput {
  return {
    id: p.id,
    deviceUserId: p.deviceUserId,
    punchedAt: p.punchedAt,
    direction: (p.direction === "IN" || p.direction === "OUT" ? p.direction : "UNKNOWN") as PunchDirection,
  };
}

export async function reconcilePunches(
  deviceId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ReconciliationReport> {
  return db.$transaction(async (tx) => {
    const device = await tx.biometricDevice.findUnique({ where: { id: deviceId } });
    if (!device) throw new Error(`Biometric device not found (${deviceId}).`);
    const config = await getWorkspaceConfig();
    const breakMinutes = punchBreakMinutes(device.config);
    const now = new Date();

    const punches = await tx.punch.findMany({
      where: {
        deviceId,
        punchedAt: { gte: windowStart, lte: windowEnd },
        reconciliationStatus: { in: ["PENDING", "MATCHED"] },
      },
      orderBy: { punchedAt: "asc" },
    });

    const report: ReconciliationReport = {
      deviceId,
      deviceName: device.name,
      windowStart,
      windowEnd,
      processed: punches.length,
      matched: 0,
      unmatched: 0,
      attended: 0,
      duplicates: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsSkippedExisting: 0,
      daysSkippedNonWorking: 0,
      missingOutDays: 0,
      missingInDays: 0,
    };
    if (punches.length === 0) return report;

    // --- mappings + holidays (window padded ±2 days: the NZ day groups
    // can extend past the punch-instant window's edges) ------------------
    const [mappings, holidays] = await Promise.all([
      tx.deviceUserMapping.findMany({ where: { deviceId } }),
      tx.holidayCalendarEntry.findMany({
        where: {
          date: {
            gte: new Date(windowStart.getTime() - 2 * 86_400_000),
            lte: new Date(windowEnd.getTime() + 2 * 86_400_000),
          },
        },
        select: { date: true, label: true, isHalfDay: true },
      }),
    ]);
    const employeeOf = new Map(mappings.map((m) => [m.deviceUserId, m.employeeId]));
    const holidayByDay = new Map(holidays.map((h) => [dayKey(h.date), h]));

    // --- partition: unmatched vs per-(employee, day) groups --------------
    const unmatchedIds: string[] = [];
    const groups = new Map<string, { employeeId: string; day: string; punches: PunchRow[] }>();
    for (const p of punches) {
      const employeeId = employeeOf.get(p.deviceUserId);
      if (!employeeId) {
        unmatchedIds.push(p.id);
        continue;
      }
      report.matched++;
      const day = nzDayKey(p.punchedAt);
      const key = `${employeeId}\u0000${day}`;
      const group = groups.get(key);
      if (group) group.punches.push(p);
      else groups.set(key, { employeeId, day, punches: [p] });
    }

    if (unmatchedIds.length > 0) {
      await tx.punch.updateMany({
        where: { id: { in: unmatchedIds } },
        data: { reconciliationStatus: "UNMATCHED", employeeId: null, matchedAt: null },
      });
      report.unmatched = unmatchedIds.length;
    }

    // --- per (employee, NZ day) derivation -------------------------------
    for (const group of groups.values()) {
      const { employeeId, day } = group;

      // The day's already-attended punches for this employee — from ANY
      // device and any earlier partial window — so re-derivation is a
      // function of the day's full punch set, not just this batch.
      const bounds = nzDayBounds(day);
      const attended = await tx.punch.findMany({
        where: {
          employeeId,
          punchedAt: { gte: bounds.start, lt: bounds.end },
          reconciliationStatus: "ATTENDED",
        },
      });

      const pairing = pairDayPunches([...attended, ...group.punches].map(toPairInput));

      // Only BATCH punch ids ever get a status flip here.
      const batchIds = new Set(group.punches.map((p) => p.id));
      const duplicateIds = pairing.duplicateIds.filter((id) => batchIds.has(id));
      if (duplicateIds.length > 0) {
        await tx.punch.updateMany({
          where: { id: { in: duplicateIds } },
          data: { reconciliationStatus: "DUPLICATE", employeeId, attendanceRecordId: null },
        });
        report.duplicates += duplicateIds.length;
      }
      const contributingIds = pairing.contributingIds.filter((id) => batchIds.has(id));

      const recordDate = parseDay(day);
      const holiday = holidayByDay.get(day) ?? null;
      const nonWorking = nonWorkingDayReason(recordDate, holiday);

      if (nonWorking !== null) {
        // F-R15 house rule: attendance is never marked on non-working
        // days (they never charge loss-of-pay either way). The punches
        // are evidence — ATTENDED, unlinked — and HR decides whether a
        // manual mark (e.g. weekend overtime) is warranted.
        if (contributingIds.length > 0) {
          await tx.punch.updateMany({
            where: { id: { in: contributingIds } },
            data: { employeeId, reconciliationStatus: "ATTENDED", matchedAt: now },
          });
          report.attended += contributingIds.length;
        }
        report.daysSkippedNonWorking++;
        continue;
      }

      const inTime = pairing.inAt !== null ? nzHm(pairing.inAt) : null;
      const outTime = pairing.outAt !== null ? nzHm(pairing.outAt) : null;
      const timing = deriveAttendanceTiming({
        inTime,
        outTime,
        dayStart: config.workspace.attendanceDayStart,
        dayEnd: config.workspace.attendanceDayEnd,
      });
      const workingHours = deriveWorkedHours(pairing.inAt, pairing.outAt, breakMinutes);
      const note = `Biometric · ${device.name} · ${pairing.contributingIds.length} punch(es)${breakMinutes > 0 ? ` · ${breakMinutes}m break deducted` : ""}`;

      const existing = await tx.attendanceRecord.findUnique({
        where: { userId_date: { userId: employeeId, date: recordDate } },
      });

      let recordId: string;
      if (!existing) {
        const created = await tx.attendanceRecord.create({
          data: {
            userId: employeeId,
            date: recordDate,
            status: "PRESENT",
            inTime,
            outTime,
            lateMinutes: timing.lateMinutes,
            earlyMinutes: timing.earlyMinutes,
            workingHours,
            overtimeMinutes: timing.overtimeMinutes,
            note,
            source: "BIOMETRIC",
          },
        });
        recordId = created.id;
        report.recordsCreated++;
      } else if (existing.source === "BIOMETRIC") {
        await tx.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            status: "PRESENT",
            inTime,
            outTime,
            lateMinutes: timing.lateMinutes,
            earlyMinutes: timing.earlyMinutes,
            workingHours,
            overtimeMinutes: timing.overtimeMinutes,
            note,
          },
        });
        recordId = existing.id;
        report.recordsUpdated++;
      } else {
        // A MANUAL/DERIVED mark outranks the engine (the upsertAttendance
        // -Record discipline: an explicit HR decision wins). Content is
        // left untouched; the punches link onto it as evidence.
        recordId = existing.id;
        report.recordsSkippedExisting++;
      }

      if (pairing.missingOut) report.missingOutDays++;
      if (pairing.missingIn) report.missingInDays++;

      if (contributingIds.length > 0) {
        await tx.punch.updateMany({
          where: { id: { in: contributingIds } },
          data: {
            employeeId,
            reconciliationStatus: "ATTENDED",
            matchedAt: now,
            attendanceRecordId: recordId,
          },
        });
        report.attended += contributingIds.length;
      }
    }

    return report;
  });
}
