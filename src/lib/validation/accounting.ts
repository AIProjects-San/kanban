// ---------------------------------------------------------------------------
// General-ledger schemas — salary revisions (Phase 1B/G8) and journal-entry
// reversal (Phase 1C/G2). (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish } from "./common";
import { yyyymmdd } from "./statutory";


/** Phase 1B (G8) — create a salary revision: close the current open
 * assignment at fromDate and open a new one. base/variable are ANNUAL NZD
 * amounts; a changed base re-prices the structure's basic anchor through a
 * cloned structure row (never in place — history stays immutable).
 * backdate must be explicit for dates in the past. */
export const createSalaryRevisionSchema = z.object({
  employeeId: cuidish,
  fromDate: yyyymmdd,
  base: z.number().finite().min(0).max(100_000_000),
  variable: z.number().finite().min(0).max(100_000_000).optional(),
  reason: z.enum(["REVISION", "PROMOTION", "TRANSFER"]),
  backdate: z.boolean().optional(),
}).strict();

/** Phase 1C (G2) — reverse a POSTED journal entry into an open period
 * (explicit target, or the period covering today when omitted). */
export const reverseJournalEntrySchema = z.object({
  entryId: cuidish,
  periodId: cuidish.optional(),
}).strict();
