"use server";

// Time tracking. The member a time entry belongs to is ALWAYS derived from
// the session — a client-supplied memberId would let anyone forge hours for
// a colleague.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getSessionOrThrow, AuthorizationError } from "./auth-guard";
import { logAudit, getMyTeamMemberId } from "./shared";
import { logTimeSchema, parseOrThrow } from "@/lib/validation";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export async function logTime(raw: {
  projectId: string;
  memberId?: string; // ignored — always derived from the session for integrity
  date: string;
  hours: number;
  description?: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();
    // Deep-dive review F-11 — shape/length/range validation before the write
    // (hours range, bounded description, sanity-checked date string).
    const input = parseOrThrow(logTimeSchema, raw);
    const myMemberId = await getMyTeamMemberId(auth);
    if (!myMemberId) {
      throw new AuthorizationError("You don't have a team member profile to log time against.");
    }
    const entry = await db.timeEntry.create({
      data: {
        projectId: input.projectId,
        memberId: myMemberId,
        date: new Date(input.date),
        hours: input.hours,
        description: input.description ?? "",
      },
    });
    const project = input.projectId
      ? await db.project.findUnique({ where: { id: input.projectId } })
      : null;
    await logAudit({
      actor: auth,
      action: "time.logged",
      entityType: "TIME",
      entityId: entry.id,
      entityLabel: project?.name ?? "Unassigned",
      detail: `Logged ${input.hours}h${project ? ` on “${project.name}”` : ""}`,
    });
    revalidatePath("/");
  });
}
