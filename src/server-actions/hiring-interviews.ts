"use server";

// ---------------------------------------------------------------------------
// R2 — Interview scheduling + scorecards (split from hiring.ts).
//
// Scheduling an INTERVIEW stage creates a CalendarEvent (so it lands on the
// shared Calendar) + a personal Reminder for the interviewer, records
// scheduledAt/ownerUserId/eventId, and refuses a conflicting booking (the
// same interviewer already has another interview within the same hour).
// The scorecard is the structured research-D form: 1-5 rating,
// strengths/concerns, and a STRONG_HIRE | HIRE | NO_HIRE recommendation.
// getMyInterviews/saveScorecard are session-only (persona-audit P0-5/D-04):
// a MEMBER assigned as interviewer reaches their own surface without
// holding hiring:view.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, getSessionOrThrow, AuthorizationError, checkPermission } from "./auth-guard";
import { scheduleInterviewSchema, scorecardSchema, parseOrThrow } from "@/lib/validation";
import { logAudit, sendOutboxMail } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { composeInterviewInviteEmail } from "@/lib/hiring/hiring-email";
import { planInterviewEvent } from "@/lib/hiring/interview-event";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";

// ---------------------------------------------------------------------------
// R2 — Interview scheduling + scorecards (hiring:manage / stage owner).
//
// Scheduling an INTERVIEW stage creates a CalendarEvent (so it lands on the
// shared Calendar) + a personal Reminder for the interviewer, records
// scheduledAt/ownerUserId/eventId, and refuses a conflicting booking (the
// same interviewer already has another interview within the same hour).
// The scorecard is the structured research-D form: 1-5 rating,
// strengths/concerns, and a STRONG_HIRE | HIRE | NO_HIRE recommendation.
// ---------------------------------------------------------------------------

export async function scheduleInterview(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(scheduleInterviewSchema, input);
    const when = new Date(data.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      throw new AuthorizationError("The scheduled date/time is invalid.");
    }
    // F-R18 (S18) — the display pair rides the pure kernel: the wall-clock
    // the user picked becomes the calendar event's UTC-midnight day + HH:MM
    // label (the generic-events house convention), so the day on screen is
    // the day that was picked regardless of the server's timezone. The
    // instant `when` below stays the scheduling truth (clash guard, stage
    // row, reminder) — the two facts are intentionally on different bases,
    // each where it is true.
    const planned = planInterviewEvent(data.wallClock);
    const stage = await db.candidateStage.findUnique({
      where: { id: data.stageId },
      include: { candidate: true },
    });
    if (!stage) throw new AuthorizationError("Stage not found.");
    if (stage.candidate.status !== "ACTIVE") {
      throw new AuthorizationError(`Candidate is ${stage.candidate.status} — the pipeline is closed.`);
    }
    if (stage.stageType !== "INTERVIEW") {
      throw new AuthorizationError("Interviews can only be scheduled on INTERVIEW stages.");
    }
    const interviewerId = data.interviewerId ?? stage.ownerUserId;
    if (!interviewerId) {
      throw new AuthorizationError("Pick an interviewer before scheduling.");
    }

    // Conflict check: the same interviewer must not have two interviews in
    // the same hour window (±59 min around `when`). Only counts non-skipped
    // stages — a skipped loop never happens.
    const nearby = await db.candidateStage.findMany({
      where: {
        ownerUserId: interviewerId,
        id: { not: stage.id },
        status: { not: "SKIPPED" },
        scheduledAt: { not: null, gte: new Date(when.getTime() - 59 * 60_000), lte: new Date(when.getTime() + 59 * 60_000) },
      },
      select: { label: true, candidate: { select: { fullName: true } } },
    });
    if (nearby.length > 0) {
      const clash = nearby[0];
      throw new AuthorizationError(
        `Scheduling conflict: ${clash.candidate.fullName} has "${clash.label}" within the same hour for this interviewer.`,
      );
    }

    // F-R12/F2.10 — the reschedule's delete-old/create-new/update-stage used
    // to be three naked writes (a crash mid-way orphaned the event); now ONE
    // transaction. F-R6: a reschedule deletes the PREVIOUS event + its
    // linked reminder via stage.eventId instead of orphaning them.
    const oldEventId = stage.eventId;
    await db.$transaction(async (tx) => {
      if (oldEventId) {
        await tx.reminder.deleteMany({ where: { eventId: oldEventId } });
        await tx.calendarEvent.delete({ where: { id: oldEventId } });
      }
      const created = await tx.calendarEvent.create({
        data: {
          title: `Interview: ${stage.candidate.fullName} — ${stage.label}`,
          description: `${stage.candidate.position || "Position n/a"} · ${stage.candidate.email}`,
          // F-R18 (S18) — the planned pair (UTC-midnight day + picked
          // HH:MM), NOT the instant + its server-local rendering: interview
          // events share the generic-events basis so every reader renders
          // one answer.
          date: planned.date,
          time: planned.time,
          durationMin: 60,
          type: "MEETING",
          location: stage.candidate.department || "",
        },
      });
      await tx.reminder.create({
        data: {
          title: `Interview with ${stage.candidate.fullName} (${stage.label})`,
          dueDate: when,
          ownerId: interviewerId,
          // F-R6 — the link that lets the NEXT reschedule clean this pair up.
          eventId: created.id,
        },
      });
      await tx.candidateStage.update({
        data: { scheduledAt: when, ownerUserId: interviewerId, eventId: created.id },
        where: { id: stage.id },
      });
    });

    // F2.10 (F-R10) — the reserved INTERVIEW_INVITE outbox kind finally has
    // its writer: every schedule AND reschedule emails the candidate (a
    // reschedule re-sends on purpose — the email carries the new time; no
    // same-day duplicate guard, unlike rejections). Best-effort: a provider
    // outage never fails the scheduling itself.
    const config = await getWorkspaceConfig();
    const interviewer = await db.user.findUnique({
      where: { id: interviewerId },
      select: { name: true },
    });
    const invite = composeInterviewInviteEmail({
      candidateName: stage.candidate.fullName,
      position: stage.candidate.position,
      stageLabel: stage.label,
      workspaceName: config.workspace.name,
      when,
      durationMin: 60,
      interviewerName: interviewer?.name,
    });
    const { status: mailStatus } = await sendOutboxMail({
      kind: "INTERVIEW_INVITE",
      candidateId: stage.candidateId,
      toAddress: stage.candidate.email,
      subject: invite.subject,
      text: invite.text,
      html: invite.html,
      sentById: auth.userId,
    });

    await logAudit({
      actor: auth,
      action: stage.scheduledAt ? "hiring.interview_rescheduled" : "hiring.interview_scheduled",
      entityType: "CANDIDATE",
      entityId: stage.candidateId,
      entityLabel: stage.candidate.fullName,
      detail: `${auth.name} ${stage.scheduledAt ? "rescheduled" : "scheduled"} "${stage.label}" with ${stage.candidate.fullName} for ${when.toISOString()} (calendar event + interviewer reminder${oldEventId ? ", previous pair cleaned up" : ""}; invite email ${mailStatus}).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

export async function saveScorecard(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    // Persona-audit P0-5 (D-04) — session-only auth: the isOwner check below
    // is the actual policy (the assigned interviewer may fill their OWN
    // scorecard; everyone else needs hiring:manage). Requiring hiring:view
    // here made that owner-exception dead code for MEMBER interviewers —
    // the scheduler offers members in the picker, so the exception must be
    // reachable. Mirrors getMyPayslips' session-scoped pattern.
    const auth = await getSessionOrThrow();
    const data = parseOrThrow(scorecardSchema, input);
    const stage = await db.candidateStage.findUnique({
      where: { id: data.stageId },
      include: { candidate: { select: { id: true, fullName: true, status: true } } },
    });
    if (!stage) throw new AuthorizationError("Stage not found.");
    // The assigned interviewer may fill their OWN scorecard; everyone else
    // needs hiring:manage (HR-driven — HR can record on behalf).
    // F-R13: checkPermission (DB ceiling) — a DB-granted hiring:manage can
    // authorize on behalf; the raw static hasPermission() ignored grants.
    const isOwner = stage.ownerUserId === auth.userId;
    if (!isOwner && !(await checkPermission(auth.role, "hiring:manage"))) {
      throw new AuthorizationError("Only the assigned interviewer or an HR/admin can fill this scorecard.");
    }
    if (stage.candidate.status !== "ACTIVE") {
      throw new AuthorizationError(`Candidate is ${stage.candidate.status} — the pipeline is closed.`);
    }
    await db.candidateStage.update({
      where: { id: stage.id },
      data: {
        rating: data.rating ?? null,
        strengths: data.strengths,
        concerns: data.concerns,
        recommendation: data.recommendation ?? null,
        remarks: data.remarks || stage.remarks,
      },
    });
    await logAudit({
      actor: auth,
      action: "hiring.scorecard_saved",
      entityType: "CANDIDATE",
      entityId: stage.candidateId,
      entityLabel: stage.candidate.fullName,
      detail: `${auth.name} saved the "${stage.label}" scorecard for ${stage.candidate.fullName}` +
        `${data.rating ? ` (rating ${data.rating}/5, ${data.recommendation ?? "no recommendation"})` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Interviewer self-service: my assigned, still-open interview stages (any
 * signed-in user — the WHERE clause scopes to the caller's own rows).
 * Persona-audit P0-5 (D-04): previously gated on hiring:view, which locked
 * MEMBER interviewers out of their own assignments entirely; now
 * session-scoped like getMyPayslips — own data, no permission needed. */
export async function getMyInterviews(): Promise<
  ActionResult<
    Array<{
      stageId: string;
      stageLabel: string;
      candidateId: string;
      candidateName: string;
      position: string;
      status: string;
      scheduledAt: string | null;
      rating: number | null;
      recommendation: string | null;
    }>
  >
> {
  return toResult(async () => {
    // Session-scoped (see docblock) — the WHERE below is the entire policy.
    const auth = await getSessionOrThrow();
    const rows = await db.candidateStage.findMany({
      where: {
        ownerUserId: auth.userId,
        stageType: "INTERVIEW",
        status: { in: ["PENDING", "IN_PROGRESS"] },
        candidate: { status: "ACTIVE" },
      },
      include: { candidate: { select: { id: true, fullName: true, position: true, status: true } } },
      orderBy: { scheduledAt: "asc" },
    });
    return rows.map((r) => ({
      stageId: r.id,
      stageLabel: r.label,
      candidateId: r.candidateId,
      candidateName: r.candidate.fullName,
      position: r.candidate.position,
      status: r.status,
      scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : null,
      rating: r.rating,
      recommendation: r.recommendation,
    }));
  });
}
