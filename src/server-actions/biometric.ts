"use server";

// ---------------------------------------------------------------------------
// G5 — the biometric attendance server actions (lib/biometric/* owns the
// pure rules; lib/biometric/reconcile.ts owns the derivation pass).
//
// Device-independent by construction: devices, device-user ↔ employee
// mappings, the raw punch log, the CSV fallbacks (punches + mappings),
// the reconcile trigger, and the exception queue's manual actions
// (match an unmatched punch to an employee / ignore a punch). The
// vendor adapters (fetchPunches / testConnection) plug into
// lib/biometric/adapter.ts once vendor information arrives.
//
// RBAC: everything attendance:manage (SUPER_ADMIN + ADMIN + HR — the
// F1.3 audience, same as the G4 timesheet/roster actions).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { validationError, parseOrThrow } from "@/lib/validation";
import {
  createBiometricDeviceSchema,
  updateBiometricDeviceSchema,
  deviceRefSchema,
  createDeviceMappingSchema,
  mappingRefSchema,
  importMappingsSchema,
  importPunchesSchema,
  reconcileSchema,
  punchLogQuerySchema,
  mappingsQuerySchema,
  matchPunchSchema,
  punchRefSchema,
  exceptionsQuerySchema,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import type {
  AttendanceExceptionsT,
  BiometricDeviceT,
  DeviceMappingT,
  MissingPunchDayT,
  PunchLogItemT,
  ReconciliationReportT,
} from "@/lib/types";
import {
  nzDayBounds,
  nzDayKey,
  nzHm,
  punchBreakMinutes,
  devicePushToken,
} from "@/lib/biometric/punches";
import { parsePunchCsv, parseMappingsCsv } from "@/lib/biometric/punch-csv";
import { getBiometricAdapter } from "@/lib/biometric/adapter";
import { reconcilePunches } from "@/lib/biometric/reconcile";
import { dayKey } from "@/lib/hr/working-days";

const PUNCH_PAGE_SIZE = 50;
const EXCEPTION_TAKE = 200;
const EXCEPTION_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function toDeviceT(
  row: {
    id: string; name: string; vendor: string; protocol: string; serial: string | null;
    location: string | null; lastSyncAt: Date | null; isActive: boolean; config: unknown;
  },
  punchCount = 0,
  mappingCount = 0,
): BiometricDeviceT {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    protocol: row.protocol,
    serial: row.serial,
    location: row.location,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    isActive: row.isActive,
    hasPushToken: devicePushToken(row.config) !== null,
    breakMinutes: punchBreakMinutes(row.config),
    punchCount,
    mappingCount,
  };
}

function toPunchT(row: {
  id: string; deviceId: string; deviceUserId: string; employeeId: string | null;
  punchedAt: Date; direction: string; verifyMethod: string | null;
  reconciliationStatus: string; attendanceRecordId: string | null;
  device?: { name: string } | null;
  employee?: { name: string } | null;
}): PunchLogItemT {
  return {
    id: row.id,
    deviceId: row.deviceId,
    deviceName: row.device?.name ?? "",
    deviceUserId: row.deviceUserId,
    employeeId: row.employeeId,
    employeeName: row.employee?.name ?? null,
    punchedAt: row.punchedAt.toISOString(),
    day: nzDayKey(row.punchedAt),
    time: nzHm(row.punchedAt),
    direction: row.direction,
    verifyMethod: row.verifyMethod,
    reconciliationStatus: row.reconciliationStatus,
    attendanceRecordId: row.attendanceRecordId,
  };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** The device catalog (attendance:manage) + live punch / mapping counts
 * (the "in use" guards behind deletion + deactivation). */
export async function getBiometricDevices(): Promise<ActionResult<BiometricDeviceT[]>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const [rows, punchCounts, mappingCounts] = await Promise.all([
      db.biometricDevice.findMany({ orderBy: { name: "asc" } }),
      db.punch.groupBy({ by: ["deviceId"], _count: { _all: true } }),
      db.deviceUserMapping.groupBy({ by: ["deviceId"], _count: { _all: true } }),
    ]);
    const punches = new Map(punchCounts.map((c) => [c.deviceId, c._count._all]));
    const mappings = new Map(mappingCounts.map((c) => [c.deviceId, c._count._all]));
    return rows.map((r) => toDeviceT(r, punches.get(r.id) ?? 0, mappings.get(r.id) ?? 0));
  });
}

/** The mapping table (attendance:manage), optionally scoped to one
 * device, plus the devices + active employees the picker needs. */
export async function getDeviceMappings(input?: {
  deviceId?: string;
}): Promise<ActionResult<{
  mappings: DeviceMappingT[];
  devices: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; name: string }>;
}>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const { deviceId } = parseOrThrow(mappingsQuerySchema, input ?? {});
    const [rows, devices, employees] = await Promise.all([
      db.deviceUserMapping.findMany({
        where: deviceId ? { deviceId } : undefined,
        orderBy: [{ deviceId: "asc" }, { deviceUserId: "asc" }],
        include: {
          device: { select: { name: true } },
          employee: { select: { name: true } },
        },
      }),
      db.biometricDevice.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
    ]);
    return {
      mappings: rows.map((r) => ({
        id: r.id,
        deviceId: r.deviceId,
        deviceName: r.device?.name ?? "",
        deviceUserId: r.deviceUserId,
        employeeId: r.employeeId,
        employeeName: r.employee?.name ?? "",
        createdAt: dayKey(r.createdAt),
      })),
      devices,
      employees,
    };
  });
}

/** The raw punch log (attendance:manage): filtered, newest-first, 50 per
 * page, with the devices list for the filter bar. */
export async function getPunchLog(input?: unknown): Promise<ActionResult<{
  punches: PunchLogItemT[];
  page: number;
  pageCount: number;
  devices: Array<{ id: string; name: string }>;
}>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const q = parseOrThrow(punchLogQuerySchema, input ?? {});
    const where: Record<string, unknown> = {};
    if (q.deviceId) where.deviceId = q.deviceId;
    if (q.status) where.reconciliationStatus = q.status;
    if (q.from || q.to) {
      where.punchedAt = {
        ...(q.from ? { gte: nzDayBounds(q.from).start } : {}),
        ...(q.to ? { lt: nzDayBounds(q.to).end } : {}),
      };
    }
    const [rows, total, devices] = await Promise.all([
      db.punch.findMany({
        where,
        orderBy: { punchedAt: "desc" },
        skip: ((q.page ?? 1) - 1) * PUNCH_PAGE_SIZE,
        take: PUNCH_PAGE_SIZE,
        include: {
          device: { select: { name: true } },
          employee: { select: { name: true } },
        },
      }),
      db.punch.count({ where }),
      db.biometricDevice.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);
    return {
      punches: rows.map(toPunchT),
      page: q.page ?? 1,
      pageCount: Math.max(1, Math.ceil(total / PUNCH_PAGE_SIZE)),
      devices,
    };
  });
}

/** The exception queue (attendance:manage): unmatched punches (no
 * mapping), duplicates, and the derived missing-OUT / missing-IN days —
 * plus the active employees for the manual-override picker. */
export async function getAttendanceExceptions(input?: unknown): Promise<ActionResult<AttendanceExceptionsT>> {
  return toResult(async () => {
    await requirePermission("attendance:manage");
    const { days } = parseOrThrow(exceptionsQuerySchema, input ?? {});
    const since = new Date(Date.now() - (days ?? EXCEPTION_WINDOW_DAYS) * 86_400_000);

    const [unmatched, duplicates, records, employees] = await Promise.all([
      db.punch.findMany({
        where: { reconciliationStatus: "UNMATCHED" },
        orderBy: { punchedAt: "desc" },
        take: EXCEPTION_TAKE,
        include: { device: { select: { name: true } } },
      }),
      db.punch.findMany({
        where: { reconciliationStatus: "DUPLICATE" },
        orderBy: { punchedAt: "desc" },
        take: EXCEPTION_TAKE,
        include: { device: { select: { name: true } }, employee: { select: { name: true } } },
      }),
      db.attendanceRecord.findMany({
        where: {
          source: "BIOMETRIC",
          date: { gte: since },
          OR: [
            { inTime: { not: null }, outTime: null },
            { inTime: null, outTime: { not: null } },
          ],
        },
        orderBy: { date: "desc" },
        take: EXCEPTION_TAKE,
      }),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
    ]);

    const nameOf = new Map(employees.map((e) => [e.id, e.name]));
    const missingOut: MissingPunchDayT[] = [];
    const missingIn: MissingPunchDayT[] = [];
    for (const r of records) {
      const item: MissingPunchDayT = {
        recordId: r.id,
        employeeId: r.userId,
        employeeName: nameOf.get(r.userId) ?? "(former employee)",
        day: dayKey(r.date),
        inTime: r.inTime,
        outTime: r.outTime,
      };
      if (r.inTime && !r.outTime) missingOut.push(item);
      else missingIn.push(item);
    }

    return {
      unmatched: unmatched.map(toPunchT),
      duplicates: duplicates.map(toPunchT),
      missingOut,
      missingIn,
      employees,
    };
  });
}

// ---------------------------------------------------------------------------
// Device writers
// ---------------------------------------------------------------------------

export async function createBiometricDevice(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(createBiometricDeviceSchema, input);
    const config: Record<string, unknown> = {};
    if (data.pushToken) config.pushToken = data.pushToken;
    if (data.breakMinutes !== undefined) config.breakMinutes = data.breakMinutes;
    try {
      const row = await db.biometricDevice.create({
        data: {
          name: data.name,
          vendor: data.vendor,
          protocol: data.protocol,
          serial: data.serial || null,
          location: data.location || null,
          config: Object.keys(config).length
            ? (config as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
      await logAudit({
        actor: auth,
        action: "biometric.device_created",
        entityType: "BIOMETRIC_DEVICE",
        entityId: row.id,
        entityLabel: row.name,
        detail: `${auth.name} registered the biometric device "${row.name}" (${row.vendor} / ${row.protocol}${data.pushToken ? ", push token set" : ""}).`,
      });
      revalidatePath("/");
      return { id: row.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(`A device with serial "${data.serial}" is already registered.`);
      }
      throw e;
    }
  });
}

export async function updateBiometricDevice(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(updateBiometricDeviceSchema, input);
    const existing = await db.biometricDevice.findUnique({ where: { id: data.deviceId } });
    if (!existing) throw new AuthorizationError("Device not found.");
    const config: Record<string, unknown> = {
      ...((existing.config as Record<string, unknown> | null) ?? {}),
    };
    if (data.pushToken !== undefined) config.pushToken = data.pushToken;
    if (data.breakMinutes !== undefined) config.breakMinutes = data.breakMinutes;
    try {
      await db.biometricDevice.update({
        where: { id: data.deviceId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.serial !== undefined ? { serial: data.serial || null } : {}),
          ...(data.location !== undefined ? { location: data.location || null } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          config: config as Prisma.InputJsonValue,
        },
      });
      await logAudit({
        actor: auth,
        action: "biometric.device_updated",
        entityType: "BIOMETRIC_DEVICE",
        entityId: data.deviceId,
        entityLabel: data.name ?? existing.name,
        detail: `${auth.name} updated the biometric device "${data.name ?? existing.name}"${data.isActive === false ? " — deactivated" : data.isActive === true ? " — reactivated" : ""}.`,
      });
      revalidatePath("/");
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(`A device with serial "${data.serial}" is already registered.`);
      }
      throw e;
    }
  });
}

/** Hard delete — refused while punches or mappings exist (punches are
 * payroll evidence; the Restrict FKs back the refusal). Retirement is
 * the isActive=false flip. */
export async function deleteBiometricDevice(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const { deviceId } = parseOrThrow(deviceRefSchema, input);
    const existing = await db.biometricDevice.findUnique({ where: { id: deviceId } });
    if (!existing) throw new AuthorizationError("Device not found.");
    const [punchCount, mappingCount] = await Promise.all([
      db.punch.count({ where: { deviceId } }),
      db.deviceUserMapping.count({ where: { deviceId } }),
    ]);
    if (punchCount > 0) {
      throw new AuthorizationError(
        `"${existing.name}" has ${punchCount} punch(es) — punch history is retained. Deactivate the device instead.`,
      );
    }
    if (mappingCount > 0) {
      throw new AuthorizationError(
        `"${existing.name}" still has ${mappingCount} employee mapping(s) — remove them first.`,
      );
    }
    await db.biometricDevice.delete({ where: { id: deviceId } });
    await logAudit({
      actor: auth,
      action: "biometric.device_deleted",
      entityType: "BIOMETRIC_DEVICE",
      entityId: deviceId,
      entityLabel: existing.name,
      detail: `${auth.name} deleted the biometric device "${existing.name}" (no punches or mappings existed).`,
    });
    revalidatePath("/");
  });
}

/** Adapter-backed reachability probe. Without a vendor adapter (the
 * current state — vendor integration is a follow-up) push devices get
 * the "use the endpoint/CSV" answer and poll devices an honest "not yet
 * available". */
export async function testDeviceConnection(input: unknown): Promise<ActionResult<{ ok: boolean; error?: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const { deviceId } = parseOrThrow(deviceRefSchema, input);
    const device = await db.biometricDevice.findUnique({ where: { id: deviceId } });
    if (!device) throw new AuthorizationError("Device not found.");
    const adapter = getBiometricAdapter(device.vendor, device.protocol);
    let result: { ok: boolean; error?: string };
    if (adapter) {
      result = await adapter.testConnection(device);
    } else if (device.protocol === "ADMS_PUSH") {
      result = {
        ok: devicePushToken(device.config) !== null,
        error:
          devicePushToken(device.config) === null
            ? "No push token is configured — set one so the device can authenticate to /api/biometric/punch."
            : undefined,
      };
    } else {
      result = {
        ok: false,
        error: `The ${device.vendor} ${device.protocol} adapter arrives with the vendor integration — meanwhile, import this device's punches from CSV.`,
      };
    }
    await logAudit({
      actor: auth,
      action: "biometric.device_tested",
      entityType: "BIOMETRIC_DEVICE",
      entityId: deviceId,
      entityLabel: device.name,
      detail: `${auth.name} tested the connection to "${device.name}" — ${result.ok ? "OK" : `failed: ${result.error ?? "unknown error"}`}.`,
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Mapping writers
// ---------------------------------------------------------------------------

export async function createDeviceMapping(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(createDeviceMappingSchema, input);
    const [device, employee] = await Promise.all([
      db.biometricDevice.findUnique({ where: { id: data.deviceId }, select: { id: true, name: true } }),
      db.user.findUnique({
        where: { id: data.employeeId },
        select: { id: true, name: true, deletedAt: true },
      }),
    ]);
    if (!device) throw new AuthorizationError("Device not found.");
    if (!employee || employee.deletedAt) throw new AuthorizationError("Employee not found.");
    try {
      const row = await db.deviceUserMapping.create({
        data: {
          deviceId: data.deviceId,
          deviceUserId: data.deviceUserId,
          employeeId: data.employeeId,
        },
      });
      await logAudit({
        actor: auth,
        action: "biometric.mapping_created",
        entityType: "DEVICE_USER_MAPPING",
        entityId: row.id,
        entityLabel: `${device.name} · ${data.deviceUserId} → ${employee.name}`,
        detail: `${auth.name} mapped device user ${data.deviceUserId} on "${device.name}" to ${employee.name}.`,
      });
      revalidatePath("/");
      return { id: row.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(
          `Device user ${data.deviceUserId} or ${employee.name} is already mapped on this device.`,
        );
      }
      throw e;
    }
  });
}

export async function deleteDeviceMapping(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const { mappingId } = parseOrThrow(mappingRefSchema, input);
    const existing = await db.deviceUserMapping.findUnique({
      where: { id: mappingId },
      include: {
        device: { select: { name: true } },
        employee: { select: { name: true } },
      },
    });
    if (!existing) throw new AuthorizationError("Mapping not found.");
    await db.deviceUserMapping.delete({ where: { id: mappingId } });
    await logAudit({
      actor: auth,
      action: "biometric.mapping_deleted",
      entityType: "DEVICE_USER_MAPPING",
      entityId: mappingId,
      entityLabel: `${existing.device?.name ?? "device"} · ${existing.deviceUserId} → ${existing.employee?.name ?? "employee"}`,
      detail: `${auth.name} removed the mapping ${existing.deviceUserId} → ${existing.employee?.name ?? "(gone)"} on "${existing.device?.name ?? "device"}".`,
    });
    revalidatePath("/");
  });
}

/** Bulk mapping import (CSV): deviceUserId, employeeEmail — or an
 * employeeId column. All-or-nothing on unknown employees (a typo'd
 * mapping is worse than a failed import); re-delivered rows count as
 * duplicates, never double-map. */
export async function importDeviceMappings(input: unknown): Promise<ActionResult<{
  created: number;
  duplicates: number;
}>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(importMappingsSchema, input);
    const device = await db.biometricDevice.findUnique({
      where: { id: data.deviceId },
      select: { id: true, name: true },
    });
    if (!device) throw new AuthorizationError("Device not found.");
    const parsed = parseMappingsCsv(data.csv);
    if (!parsed.ok) throw validationError(parsed.error);

    // Resolve every employee up front (all-or-nothing).
    const emails = [...new Set(parsed.rows.map((r) => r.employeeEmail).filter((e): e is string => e !== null))];
    const ids = [...new Set(parsed.rows.map((r) => r.employeeId).filter((e): e is string => e !== null))];
    const [byEmailRows, byIdRows] = await Promise.all([
      emails.length
        ? db.user.findMany({ where: { email: { in: emails }, deletedAt: null }, select: { id: true, email: true, name: true } })
        : Promise.resolve([]),
      ids.length
        ? db.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    const idByEmail = new Map(byEmailRows.map((u) => [u.email, u.id]));
    const nameById = new Map(byIdRows.map((u) => [u.id, u.name]));
    for (const r of parsed.rows) {
      if (r.employeeEmail && !idByEmail.has(r.employeeEmail)) {
        throw validationError(`No active employee with email ${r.employeeEmail}.`);
      }
      if (r.employeeId && !nameById.has(r.employeeId)) {
        throw validationError(`No active employee with id ${r.employeeId}.`);
      }
    }

    let created = 0;
    let duplicates = 0;
    for (const r of parsed.rows) {
      const employeeId = r.employeeEmail ? idByEmail.get(r.employeeEmail)! : r.employeeId!;
      try {
        await db.deviceUserMapping.create({
          data: { deviceId: data.deviceId, deviceUserId: r.deviceUserId, employeeId },
        });
        created++;
      } catch (e) {
        if (isUniqueConstraintError(e)) duplicates++;
        else throw e;
      }
    }
    await logAudit({
      actor: auth,
      action: "biometric.mappings_imported",
      entityType: "DEVICE_USER_MAPPING",
      entityId: data.deviceId,
      entityLabel: device.name,
      detail: `${auth.name} imported ${created} employee mapping(s) onto "${device.name}" from CSV (${duplicates} already mapped).`,
    });
    revalidatePath("/");
    return { created, duplicates };
  });
}

// ---------------------------------------------------------------------------
// Punch ingest (CSV fallback) + the reconcile trigger
// ---------------------------------------------------------------------------

/** The CSV fallback for vendors with no protocol support: punches land
 * in the SAME Punch table (PENDING) and reconcile identically. Exact
 * re-deliveries (same device user + instant) count as duplicates — the
 * DB's re-delivery guard — never as errors. */
export async function importPunchesCsv(input: unknown): Promise<ActionResult<{
  inserted: number;
  duplicates: number;
}>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(importPunchesSchema, input);
    const device = await db.biometricDevice.findUnique({
      where: { id: data.deviceId },
      select: { id: true, name: true },
    });
    if (!device) throw new AuthorizationError("Device not found.");
    const parsed = parsePunchCsv(data.csv);
    if (!parsed.ok) throw validationError(parsed.error);

    let inserted = 0;
    let duplicates = 0;
    for (const row of parsed.rows) {
      try {
        await db.punch.create({
          data: {
            deviceId: data.deviceId,
            deviceUserId: row.deviceUserId,
            punchedAt: row.punchedAt,
            direction: row.direction,
            verifyMethod: row.verifyMethod,
            rawPayload: { source: "csv" },
          },
        });
        inserted++;
      } catch (e) {
        if (isUniqueConstraintError(e)) duplicates++;
        else throw e;
      }
    }
    if (inserted + duplicates > 0) {
      await db.biometricDevice.update({
        where: { id: data.deviceId },
        data: { lastSyncAt: new Date() },
      });
    }
    await logAudit({
      actor: auth,
      action: "biometric.punches_imported",
      entityType: "PUNCH",
      entityId: data.deviceId,
      entityLabel: device.name,
      detail: `${auth.name} imported ${inserted} punch(es) from CSV into "${device.name}" (${duplicates} duplicate skip${duplicates === 1 ? "" : "s"}).`,
    });
    revalidatePath("/");
    return { inserted, duplicates };
  });
}

/** Run the reconcile engine over a device + window (the from/to days
 * are NZ days; the engine derives AttendanceRecords + the punch status
 * flips, and is idempotent). */
export async function reconcileDevicePunches(input: unknown): Promise<ActionResult<ReconciliationReportT>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(reconcileSchema, input);
    const device = await db.biometricDevice.findUnique({
      where: { id: data.deviceId },
      select: { id: true, name: true },
    });
    if (!device) throw new AuthorizationError("Device not found.");
    const from = nzDayBounds(data.from);
    const to = nzDayBounds(data.to);
    if (from.start.getTime() > to.start.getTime()) {
      throw new AuthorizationError("The reconcile window start must not be after its end.");
    }
    const report = await reconcilePunches(
      data.deviceId,
      from.start,
      new Date(to.end.getTime() - 1),
    );
    await logAudit({
      actor: auth,
      action: "biometric.reconciled",
      entityType: "PUNCH",
      entityId: data.deviceId,
      entityLabel: device.name,
      detail: `${auth.name} reconciled "${device.name}" punches ${data.from} → ${data.to}: ${report.processed} processed, ${report.attended} attended, ${report.unmatched} unmatched, ${report.duplicates} duplicate(s), ${report.recordsCreated} record(s) created, ${report.recordsUpdated} updated.`,
    });
    revalidatePath("/");
    return {
      deviceId: report.deviceId,
      deviceName: report.deviceName,
      windowStart: report.windowStart.toISOString(),
      windowEnd: report.windowEnd.toISOString(),
      processed: report.processed,
      matched: report.matched,
      unmatched: report.unmatched,
      attended: report.attended,
      duplicates: report.duplicates,
      recordsCreated: report.recordsCreated,
      recordsUpdated: report.recordsUpdated,
      recordsSkippedExisting: report.recordsSkippedExisting,
      daysSkippedNonWorking: report.daysSkippedNonWorking,
      missingOutDays: report.missingOutDays,
      missingInDays: report.missingInDays,
    };
  });
}

// ---------------------------------------------------------------------------
// The exception queue's manual actions
// ---------------------------------------------------------------------------

/** Manual override: match an (unmatched) punch to an employee. The
 * override records WHO and WHEN via the audit log + matchedAt; the
 * punched day's AttendanceRecord is (re-)derived on the next reconcile
 * pass. Idempotent: re-matching the same punch to the same employee is
 * a no-op. */
export async function matchPunchToEmployee(input: unknown): Promise<ActionResult<{ matched: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const data = parseOrThrow(matchPunchSchema, input);
    const [punch, employee] = await Promise.all([
      db.punch.findUnique({
        where: { id: data.punchId },
        include: { device: { select: { name: true } } },
      }),
      db.user.findUnique({
        where: { id: data.employeeId },
        select: { id: true, name: true, deletedAt: true },
      }),
    ]);
    if (!punch) throw new AuthorizationError("Punch not found.");
    if (!employee || employee.deletedAt) throw new AuthorizationError("Employee not found.");

    if (punch.reconciliationStatus === "MATCHED" && punch.employeeId === data.employeeId) {
      // Idempotent no-op — the override already stands.
      return { matched: true };
    }
    if (punch.reconciliationStatus === "ATTENDED" || punch.reconciliationStatus === "DUPLICATE") {
      throw new AuthorizationError(
        "This punch has already been reconciled into attendance — it can no longer be re-matched.",
      );
    }

    // QA-16 guarded flip: only a still-overridable punch moves.
    const flipped = await db.punch.updateMany({
      where: {
        id: data.punchId,
        reconciliationStatus: { in: ["PENDING", "UNMATCHED", "IGNORED", "MATCHED"] },
      },
      data: {
        employeeId: data.employeeId,
        reconciliationStatus: "MATCHED",
        matchedAt: new Date(),
      },
    });
    if (flipped.count === 0) {
      throw new AuthorizationError("This punch has already been reconciled into attendance.");
    }
    await logAudit({
      actor: auth,
      action: "biometric.punch_matched",
      entityType: "PUNCH",
      entityId: data.punchId,
      entityLabel: `${punch.device?.name ?? "device"} · ${punch.deviceUserId} → ${employee.name}`,
      detail: `${auth.name} matched the ${punch.direction} punch of device user ${punch.deviceUserId} (${punch.device?.name ?? "device"}, ${dayKey(punch.punchedAt)} ${nzHm(punch.punchedAt)}) to ${employee.name} — the attendance record derives on the next reconcile pass.`,
    });
    revalidatePath("/");
    return { matched: true };
  });
}

/** Dismiss a punch from the queue (IGNORED): it stays as evidence but
 * never derives attendance. */
export async function ignorePunch(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("attendance:manage");
    const { punchId } = parseOrThrow(punchRefSchema, input);
    const punch = await db.punch.findUnique({
      where: { id: punchId },
      include: { device: { select: { name: true } } },
    });
    if (!punch) throw new AuthorizationError("Punch not found.");
    if (punch.reconciliationStatus === "IGNORED") return; // idempotent
    if (punch.reconciliationStatus === "ATTENDED" || punch.reconciliationStatus === "DUPLICATE") {
      throw new AuthorizationError(
        "This punch has already been reconciled into attendance — it cannot be ignored.",
      );
    }
    const flipped = await db.punch.updateMany({
      where: {
        id: punchId,
        reconciliationStatus: { in: ["PENDING", "UNMATCHED", "MATCHED"] },
      },
      data: { reconciliationStatus: "IGNORED" },
    });
    if (flipped.count === 0) {
      throw new AuthorizationError("This punch has already been reconciled into attendance.");
    }
    await logAudit({
      actor: auth,
      action: "biometric.punch_ignored",
      entityType: "PUNCH",
      entityId: punchId,
      entityLabel: `${punch.device?.name ?? "device"} · ${punch.deviceUserId}`,
      detail: `${auth.name} ignored the ${punch.direction} punch of device user ${punch.deviceUserId} (${punch.device?.name ?? "device"}, ${dayKey(punch.punchedAt)} ${nzHm(punch.punchedAt)}) — it stays as evidence but derives no attendance.`,
    });
    revalidatePath("/");
  });
}
