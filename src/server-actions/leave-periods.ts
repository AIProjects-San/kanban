"use server";

// ---------------------------------------------------------------------------
// P27 (LV-08) — the leave period master, actions half.
//
// listLeavePeriods: the rows (hr:admin — the master renders in the HR
// console's Types & Policies tab). createLeavePeriod: role:manage-level
// hr:admin, the structural zod pass + the PURE kernel validation (span,
// overlap, one window per start year, chain extension) + the two
// forward-looking DB guards:
//   • the target bucket must carry NO engine grants yet (a window that
//     reshapes a bucket the calendar-year engine already granted into
//     would double-grant its periods — periods are forward-looking);
//   • the start must be TOMORROW or later (a window that already started
//     races the daily pass: half its grants would land late).
// deleteLeavePeriod: hr:admin, refuses a period whose ledger bucket has ANY
// rows (history is immutable) — only future windows are deletable, so the
// delete of a typo'd period can never rewrite granted history. All three
// audit through the house logAudit convention.
//
// The window KERNEL (resolution, validation, buckets) lives in
// src/lib/leave/leave-period.ts (pure, test-pinned); the engine consumers in
// hr-leave.ts / hr-shared.ts / leave-allocation-core.ts.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { validateLeavePeriod } from "@/lib/leave/leave-period";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { dayKey } from "@/lib/hr/working-days";
import {
  leavePeriodCreateSchema,
  leavePeriodDeleteSchema,
  parseOrThrow,
} from "@/lib/validation";

export interface LeavePeriodT {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  /** The ledger bucket the window writes into (its start year). */
  bucketYear: number;
}

export async function listLeavePeriods(): Promise<ActionResult<{ periods: LeavePeriodT[] }>> {
  return toResult(async () => {
    await requirePermission("hr:admin");
    const rows = await db.leavePeriod.findMany({ orderBy: { startDate: "asc" } });
    return {
      periods: rows.map((r) => ({
        id: r.id,
        name: r.name,
        startDate: dayKey(r.startDate),
        endDate: dayKey(r.endDate),
        bucketYear: Number(dayKey(r.startDate).slice(0, 4)),
      })),
    };
  });
}

export async function createLeavePeriod(input: {
  name: string;
  startDate: string;
  endDate: string;
}): Promise<ActionResult<{ period: LeavePeriodT }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(leavePeriodCreateSchema, input);

    const rows = await db.leavePeriod.findMany({ orderBy: { startDate: "asc" } });
    const existing = rows.map((r) => ({
      id: r.id,
      name: r.name,
      startDate: dayKey(r.startDate),
      endDate: dayKey(r.endDate),
    }));

    // The pure kernel: span, overlap, one window per start year, chain
    // extension. The refusal is the rule's own sentence.
    const validation = validateLeavePeriod(data, existing);
    if (!validation.ok) {
      throw new AuthorizationError(validation.reason);
    }

    const startYear = Number(data.startDate.slice(0, 4));

    // Forward-looking guard 1 — the bucket must be engine-clean. A named
    // window whose bucket already carries POLICY ledger rows (the
    // calendar-year engine's grants, or a deleted window's survivors)
    // would double-grant: the period keys it derives are already taken
    // by the old grants' keys.
    const engineRowsInBucket = await db.leaveLedgerEntry.count({
      where: { year: startYear, sourceType: "POLICY" },
    });
    if (engineRowsInBucket > 0) {
      throw new AuthorizationError(
        `The ${startYear} allocation bucket already has engine grants — named periods are forward-looking. Create the first custom window for a start year the calendar-year engine has not yet granted into.`,
      );
    }

    // Forward-looking guard 2 — the window must not already have started:
    // a mid-flight window races the daily pass (its early grants would
    // land late or never, and the rollover would skip). Tomorrow onward
    // gives the workspace one clean pass before the window opens.
    const today = dayKey(new Date());
    if (data.startDate <= today) {
      throw new AuthorizationError(
        `A new leave period must start in the future (after ${today}) — a window that already started would race the daily allocation pass.`,
      );
    }

    const created = await db.leavePeriod.create({
      data: {
        name: data.name,
        startDate: new Date(`${data.startDate}T00:00:00.000Z`),
        endDate: new Date(`${data.endDate}T00:00:00.000Z`),
      },
    });
    await logAudit({
      actor: auth,
      action: "leave.period_created",
      entityType: "LEAVE_PERIOD",
      entityId: created.id,
      entityLabel: data.name,
      detail: `Created leave period “${data.name}” (${data.startDate} → ${data.endDate}, ledger bucket ${startYear})`,
    });
    revalidatePath("/");
    return {
      period: {
        id: created.id,
        name: created.name,
        startDate: data.startDate,
        endDate: data.endDate,
        bucketYear: startYear,
      },
    };
  });
}

export async function deleteLeavePeriod(input: {
  id: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(leavePeriodDeleteSchema, input);

    const row = await db.leavePeriod.findUnique({ where: { id: data.id } });
    if (!row) {
      throw new AuthorizationError("That leave period no longer exists — refresh the list.");
    }
    const startKey = dayKey(row.startDate);
    const endKey = dayKey(row.endDate);
    const startYear = Number(startKey.slice(0, 4));

    // History is immutable: a window whose ledger bucket has ANY row
    // (grants, carry, consumption — any source) may not be deleted — the
    // rows reference the bucket the window defined. Only future windows
    // (or a clean past one nobody touched) are deletable.
    const bucketRows = await db.leaveLedgerEntry.count({
      where: { year: startYear },
    });
    if (bucketRows > 0) {
      throw new AuthorizationError(
        `“${row.name}”'s allocation bucket (${startYear}) has ${bucketRows} ledger row(s) — a window with history is never deleted. Only future windows can be removed.`,
      );
    }

    await db.leavePeriod.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "leave.period_deleted",
      entityType: "LEAVE_PERIOD",
      entityId: row.id,
      entityLabel: row.name,
      detail: `Deleted leave period “${row.name}” (${startKey} → ${endKey}) before it took effect`,
    });
    revalidatePath("/");
  });
}
