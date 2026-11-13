"use server";

// ---------------------------------------------------------------------------
// F1.1 — holiday calendar server actions
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
//
// RBAC: everything here is `hr:admin` (ADMIN + HR) — the calendar shapes
// leave counting and payroll denominators for the whole workspace, so it is
// configuration, not self-service data. Members see the EFFECT of the
// calendar (excluded days in their request preview) via getMyLeaveData.
//
// Semantics: any entry removes its date from working-day counting
// (isHalfDay counts 0.5); kind (PUBLIC/WEEKLY_OFF) is labeling. One entry
// per date (unique) — upsert maps a duplicate date to a real message
// (QA-18 convention, same as leave type names/codes).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import type { HolidayT } from "@/lib/types";
import type { ActionResult } from "@/lib/action-result";
import { holidayEntrySchema, deleteHolidayEntrySchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import { parseDay } from "./hr-shared";

/** Entries for one calendar year (ascending). `year` defaults to the
 * current UTC year when omitted/invalid — the tab passes the year it is
 * browsing so no unbounded whole-table read ever leaves the server. */
export async function getHolidayCalendar(
  yearInput?: number,
): Promise<ActionResult<{ year: number; entries: HolidayT[] }>> {
  return toResult(async () => {
    await requirePermission("hr:admin");
    const now = new Date();
    const y = Number(yearInput);
    const year = Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : now.getUTCFullYear();

    const rows = await db.holidayCalendarEntry.findMany({
      where: {
        date: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lte: new Date(Date.UTC(year, 11, 31)),
        },
      },
      orderBy: { date: "asc" },
    });

    return {
      year,
      entries: rows.map((r) => ({
        id: r.id,
        date: r.date.toISOString().slice(0, 10),
        label: r.label,
        kind: r.kind as HolidayT["kind"],
        isHalfDay: r.isHalfDay,
      })),
    };
  });
}

/** Create or update one entry. `id` present → update (the date may move);
 * absent → create. A date already taken by ANOTHER entry rejects with a
 * message that names the conflicting date. */
export async function upsertHolidayEntry(input: {
  id?: string;
  date: string;
  label?: string;
  kind?: "PUBLIC" | "WEEKLY_OFF";
  isHalfDay?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(holidayEntrySchema, input);
    const date = parseDay(data.date);

    if (data.id) {
      const existing = await db.holidayCalendarEntry.findUnique({ where: { id: data.id } });
      if (!existing) throw new AuthorizationError("Holiday entry not found.");
      try {
        const updated = await db.holidayCalendarEntry.update({
          where: { id: data.id },
          data: {
            date,
            label: data.label,
            kind: data.kind,
            isHalfDay: data.isHalfDay,
          },
        });
        await logAudit({
          actor: auth,
          action: "hr.holiday_updated",
          entityType: "HOLIDAY_ENTRY",
          entityId: updated.id,
          entityLabel: `${data.date}${data.label ? ` (${data.label})` : ""}`,
          detail: `${auth.name} updated the holiday entry for ${data.date}${data.label ? ` — ${data.label}` : ""}${data.isHalfDay ? " (half day)" : ""}.`,
        });
        revalidatePath("/");
        return { id: updated.id };
      } catch (e) {
        if (isUniqueConstraintError(e)) {
          throw new AuthorizationError(
            `${data.date} is already a holiday — one entry per date. Edit the existing entry instead.`,
          );
        }
        throw e;
      }
    }

    try {
      const created = await db.holidayCalendarEntry.create({
        data: {
          date,
          label: data.label,
          kind: data.kind,
          isHalfDay: data.isHalfDay,
        },
      });
      await logAudit({
        actor: auth,
        action: "hr.holiday_created",
        entityType: "HOLIDAY_ENTRY",
        entityId: created.id,
        entityLabel: `${data.date}${data.label ? ` (${data.label})` : ""}`,
        detail: `${auth.name} added ${data.kind === "WEEKLY_OFF" ? "a weekly off day" : "a public holiday"} on ${data.date}${data.label ? ` — ${data.label}` : ""}${data.isHalfDay ? " (half day)" : ""}.`,
      });
      revalidatePath("/");
      return { id: created.id };
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new AuthorizationError(
          `${data.date} is already a holiday — one entry per date. Edit the existing entry instead.`,
        );
      }
      throw e;
    }
  });
}

/** Remove one entry. Deleting a past entry does NOT recompute anything —
 * leave days and payroll denominators are denormalized snapshots. */
export async function deleteHolidayEntry(input: {
  id: string;
}): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(deleteHolidayEntrySchema, input);

    const existing = await db.holidayCalendarEntry.findUnique({ where: { id: data.id } });
    if (!existing) throw new AuthorizationError("Holiday entry not found.");

    await db.holidayCalendarEntry.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hr.holiday_deleted",
      entityType: "HOLIDAY_ENTRY",
      entityId: data.id,
      entityLabel: `${existing.date.toISOString().slice(0, 10)}${existing.label ? ` (${existing.label})` : ""}`,
      detail: `${auth.name} removed the holiday entry for ${existing.date.toISOString().slice(0, 10)}${existing.label ? ` — ${existing.label}` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}
