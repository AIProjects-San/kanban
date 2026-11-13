"use server";

// Calendar events.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission } from "./auth-guard";
import { createEventSchema, parseOrThrow } from "@/lib/validation";
import { logAudit, fmtDayDate } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";

export async function createEvent(input: {
  title: string;
  description?: string;
  date: string;
  time?: string;
  durationMin?: number;
  type?: string;
  location?: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("event:create");
    const data = parseOrThrow(createEventSchema, input);
    const event = await db.calendarEvent.create({
      data: {
        title: data.title,
        description: data.description ?? "",
        date: new Date(data.date),
        time: data.time ?? "09:00",
        durationMin: data.durationMin ?? 60,
        type: data.type ?? "MEETING",
        location: data.location ?? "",
      },
    });
    await logAudit({
      actor: auth,
      action: "event.created",
      entityType: "EVENT",
      entityId: event.id,
      entityLabel: event.title,
      detail: `Scheduled “${event.title}” on ${fmtDayDate(event.date)} at ${event.time}`,
    });
    revalidatePath("/");
  });
}

export async function deleteEvent(id: string): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("event:delete");
    const existing = await db.calendarEvent.findUnique({ where: { id } });
    // Deep-dive review F-15 — not-found is a clean no-op, not a P2025.
    if (!existing) return;
    await db.calendarEvent.delete({ where: { id } });
    await logAudit({
      actor: auth,
      action: "event.deleted",
      entityType: "EVENT",
      entityId: id,
      entityLabel: existing.title,
      detail: `Deleted event “${existing.title}”`,
    });
    revalidatePath("/");
  });
}
