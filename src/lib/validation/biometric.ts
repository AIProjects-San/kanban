// ---------------------------------------------------------------------------
// G5 — biometric attendance action inputs. The vendor/protocol vocabularies
// mirror the schema comments (BiometricDevice.vendor / .protocol); the
// punch status vocabulary mirrors lib/biometric/punches.ts.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cuidish, isoDateStr, title } from "./common";
import { PUNCH_RECONCILIATION_STATUSES } from "@/lib/biometric/punches";

export const biometricVendorEnum = z.enum(["ZKTECO", "SUPREMA", "HIKVISION", "OTHER"]);
export const biometricProtocolEnum = z.enum(["ADMS_PUSH", "TCP_POLL", "SDK", "CSV_IMPORT"]);

export const biometricPushToken = z
  .string()
  .trim()
  .min(16, "The push token must be at least 16 characters.")
  .max(200);

const optionalName = z.string().trim().max(200);

// --- devices -------------------------------------------------------------

export const createBiometricDeviceSchema = z
  .object({
    name: title,
    vendor: biometricVendorEnum,
    protocol: biometricProtocolEnum,
    serial: z.string().trim().max(120).optional(),
    location: optionalName.optional(),
    pushToken: biometricPushToken.optional(),
    breakMinutes: z.number().int().min(0).max(480).optional(),
  })
  .strict();

export const updateBiometricDeviceSchema = z
  .object({
    deviceId: cuidish,
    name: title.optional(),
    serial: z.string().trim().max(120).optional(),
    location: optionalName.optional(),
    isActive: z.boolean().optional(),
    pushToken: biometricPushToken.optional(),
    breakMinutes: z.number().int().min(0).max(480).optional(),
  })
  .strict();

export const deviceRefSchema = z.object({ deviceId: cuidish }).strict();

/** The mapping-table read filter (optional device scope). */
export const mappingsQuerySchema = z.object({ deviceId: cuidish.optional() }).strict();

// --- mappings ------------------------------------------------------------

export const createDeviceMappingSchema = z
  .object({
    deviceId: cuidish,
    deviceUserId: z.string().trim().min(1).max(64),
    employeeId: cuidish,
  })
  .strict();

export const mappingRefSchema = z.object({ mappingId: cuidish }).strict();

export const importMappingsSchema = z
  .object({
    deviceId: cuidish,
    csv: z.string().min(1, "Paste the CSV to import.").max(200_000),
  })
  .strict();

// --- punches -------------------------------------------------------------

export const importPunchesSchema = z
  .object({
    deviceId: cuidish,
    csv: z.string().min(1, "Paste the punch CSV to import.").max(200_000),
  })
  .strict();

export const reconcileSchema = z
  .object({
    deviceId: cuidish,
    from: isoDateStr,
    to: isoDateStr,
  })
  .strict();

export const punchLogQuerySchema = z
  .object({
    deviceId: cuidish.optional(),
    status: z.enum(PUNCH_RECONCILIATION_STATUSES).optional(),
    from: isoDateStr.optional(),
    to: isoDateStr.optional(),
    page: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

export const matchPunchSchema = z
  .object({
    punchId: cuidish,
    employeeId: cuidish,
  })
  .strict();

export const punchRefSchema = z.object({ punchId: cuidish }).strict();

export const exceptionsQuerySchema = z
  .object({
    days: z.number().int().min(1).max(180).optional(),
  })
  .strict();
