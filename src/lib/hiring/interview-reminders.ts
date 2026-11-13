// ---------------------------------------------------------------------------
// P26 (PL-03/RJ-B18) — the interview reminder engine
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P26; the benchmark's
// daily send_interview_reminder job, which nudges each interviewer about
// their upcoming interview — its per-minute poll loop with configurable
// hours-before offsets stays declined, named in the matrix cell).
//
// The Fernly shape rides the proven house pattern (P25):
//   • dueInterviewReminders — PURE: which same-day interviews are due a
//     nudge, with the deterministic sourceKeys and the template variables.
//   • runInterviewRemindersJob — the scheduled writer: reads the workspace
//     switches, finds every OPEN interview stage scheduled for TODAY (the
//     F-R18 picked-day truth), and writes ONE personal notification per
//     interview to its interviewer (unique sourceKey → a re-run writes
//     nothing), then queues the opt-in email for exactly the nudges this
//     pass newly wrote.
//
// Timing semantics (the honest daily answer to the benchmark's per-minute
// job): the pass nudges on the MORNING OF the interview day — the
// dispatcher runs ~03:00 UTC, so the nudge lands before any same-day
// interview. Tomorrow's interviews are NOT nudged today (the scheduling
// surface already wrote a personal Reminder row + emailed the candidate
// at booking time — F-R10; this pass is the day-of commitment nudge).
//
// Day basis: the calendar event's `date` — UTC midnight of the day the HR
// user picked (F-R18: the display truth, shared with the calendar grid
// and the ICS export) — NOT the instant's UTC day, which can differ by
// ±1 around midnight. Legacy rows without an event fall back to the
// scheduledAt instant's UTC day (documented; the scheduling action has
// written eventId since R2).
//
// Idempotency: sourceKey `INTERVIEW_REMINDER:<stageId>:<asOf>` — one nudge
// per interview per day, unique across the table. A same-day RESCHEDULE
// keeps the key (no double nudge); a reschedule to another day nudges on
// the new day (a new key — correct: the new day needs its own nudge).
// The email half is gated by the in-app write: only nudges this pass
// NEWLY wrote are emailed, so a re-run queues nothing (the P18/P21
// honesty rail; a crash between the two halves loses only that
// interview's email — the notification row stands).
//
// Eligibility: the stage must be OPEN (PENDING/IN_PROGRESS — PASSED,
// FAILED and SKIPPED stages are decided, no nudge), the candidate ACTIVE
// (a closed pipeline never nudges), and the interviewer a live user
// (deleted users are never nudged). The recipient is the interviewer
// ALONE — a personal row, never a broadcast.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { logError, logInfo } from "@/lib/infra/observability";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import { queueOutboxMail, deliverOutboxMail } from "@/lib/email/mail-outbox";
import {
  resolveNotificationTemplate,
  renderTemplate,
  type ResolvedNotificationTemplate,
} from "@/lib/email/notification-template";
import { emailHtml } from "@/lib/email/email-html";

// ---------------------------------------------------------------------------
// The pure kernel
// ---------------------------------------------------------------------------

export interface InterviewNudgeCandidate {
  /** CandidateStage.id — the nudge's identity. */
  stageId: string;
  /** The interviewer's live user id (null → no nudge: nobody to send to). */
  interviewerUserId: string | null;
  /** The interviewer's display name (the email body's greeting). */
  interviewerName: string;
  candidateName: string;
  /** The candidate's position, or the "Position n/a" placeholder. */
  position: string;
  stageLabel: string;
  /** "HH:MM" 24-hour — the wall-clock the HR user picked (event.time). */
  timeLabel: string;
  /** YYYY-MM-DD — the picked calendar day (event.date's UTC day). */
  eventDay: string;
}

export interface InterviewReminderSwitches {
  remindInterviews: boolean;
}

export interface DueInterviewNudge {
  stageId: string;
  interviewerUserId: string;
  /** `INTERVIEW_REMINDER:<stageId>:<asOf>` — the dedup identity. */
  sourceKey: string;
  /** Pre-composed variables for the template registry. */
  vars: Record<string, string>;
}

/**
 * The pure rule: which interviews get a day-of nudge. One nudge per
 * interview whose picked day IS asOf and whose interviewer is known; the
 * switch off → nothing (never a single row).
 */
export function dueInterviewReminders(input: {
  asOf: string;
  interviews: InterviewNudgeCandidate[];
  switches: InterviewReminderSwitches;
}): DueInterviewNudge[] {
  if (!input.switches.remindInterviews) return [];
  const nudges: DueInterviewNudge[] = [];
  for (const i of input.interviews) {
    if (i.eventDay !== input.asOf) continue;
    if (!i.interviewerUserId) continue;
    nudges.push({
      stageId: i.stageId,
      interviewerUserId: i.interviewerUserId,
      sourceKey: `INTERVIEW_REMINDER:${i.stageId}:${input.asOf}`,
      vars: {
        interviewerName: i.interviewerName,
        candidateName: i.candidateName,
        position: i.position,
        stageLabel: i.stageLabel,
        timeLabel: i.timeLabel,
        date: input.asOf,
      },
    });
  }
  return nudges;
}

// ---------------------------------------------------------------------------
// The scheduled writer
// ---------------------------------------------------------------------------

export interface InterviewRemindersJobReport {
  asOf: string;
  /** Open scheduled interview stages examined (pre-filter count). */
  interviewsConsidered: number;
  /** Due nudges after the same-day/live-interviewer filters. */
  dueInterviews: number;
  /** Personal notifications written this pass (idempotent: re-runs write 0). */
  notificationsWritten: number;
  /** Outbox rows queued this pass (0 when the email rail is off). */
  emailsQueued: number;
}

function renderEvent(tpl: ResolvedNotificationTemplate, vars: Record<string, string>) {
  return {
    title: renderTemplate(tpl.title, vars),
    message: renderTemplate(tpl.message, vars),
    subject: renderTemplate(tpl.subject, vars),
    text: renderTemplate(tpl.body, vars),
  };
}

/**
 * One interview-reminders pass. NEVER throws for a single bad piece — the
 * report is the truth, failures log and count (the leave-allocation /
 * engagement-reminders posture).
 */
export async function runInterviewRemindersJob(): Promise<InterviewRemindersJobReport> {
  const now = new Date();
  const asOf = now.toISOString().slice(0, 10);
  const report: InterviewRemindersJobReport = {
    asOf,
    interviewsConsidered: 0,
    dueInterviews: 0,
    notificationsWritten: 0,
    emailsQueued: 0,
  };

  // The switches ride the SAME cached config read the interactive surfaces
  // use (10s TTL + PR-31 pub/sub invalidation).
  const config = await getWorkspaceConfig();
  const switches: InterviewReminderSwitches = {
    remindInterviews: config.workspace.remindInterviews !== false,
  };
  const emailOn = config.workspace.emailInterviewReminders === true;

  if (!switches.remindInterviews) {
    logInfo("[interview-reminders] pass complete — the switch is off", {
      metric: "interview_reminders_pass",
      asOf,
    });
    return report;
  }

  // Every OPEN scheduled interview stage on an ACTIVE candidate. Deliberately
  // NOT date-windowed in SQL: the same-day decision is the kernel's (on the
  // picked-day basis), and a same-day re-run after a crash must still see
  // the morning's interviews (scheduledAt already in the past). The
  // open-stage + ACTIVE-candidate filters bound the set naturally.
  const stages = await db.candidateStage.findMany({
    where: {
      stageType: "INTERVIEW",
      scheduledAt: { not: null },
      status: { in: ["PENDING", "IN_PROGRESS"] },
      ownerUserId: { not: null },
      candidate: { status: "ACTIVE" },
    },
    select: {
      id: true,
      label: true,
      scheduledAt: true,
      eventId: true,
      ownerUserId: true,
      candidate: { select: { fullName: true, position: true } },
    },
  });
  report.interviewsConsidered = stages.length;

  // The events (picked-day truth) — CandidateStage is relation-light
  // (plain eventId FK), so fetch and map. Rows without an event (legacy
  // pre-R2 shape) fall back to the scheduledAt instant's UTC day/time.
  const eventIds = stages.map((s) => s.eventId).filter((id): id is string => id !== null);
  const events = eventIds.length
    ? await db.calendarEvent.findMany({
        where: { id: { in: eventIds } },
        select: { id: true, date: true, time: true },
      })
    : [];
  const eventById = new Map(events.map((e) => [e.id, e]));

  // The interviewers — live users only (deleted users are never nudged).
  const userIds = stages.map((s) => s.ownerUserId).filter((id): id is string => id !== null);
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds }, deletedAt: null },
        select: { id: true, name: true, email: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const interviews: InterviewNudgeCandidate[] = [];
  for (const s of stages) {
    const user = s.ownerUserId ? userById.get(s.ownerUserId) : undefined;
    if (!user) continue; // interviewer deleted (or stage without one) — no nudge
    const event = s.eventId ? eventById.get(s.eventId) : undefined;
    // The picked pair when the event exists; the instant's UTC rendering
    // otherwise (the documented legacy fallback).
    const daySource = event ? event.date : s.scheduledAt;
    if (!daySource) continue;
    const eventDay = daySource.toISOString().slice(0, 10);
    const timeLabel = event ? event.time : (s.scheduledAt as Date).toISOString().slice(11, 16);
    interviews.push({
      stageId: s.id,
      interviewerUserId: user.id,
      interviewerName: user.name,
      candidateName: s.candidate.fullName,
      position: s.candidate.position || "Position n/a",
      stageLabel: s.label,
      timeLabel,
      eventDay,
    });
  }

  const due = dueInterviewReminders({ asOf, interviews, switches });
  report.dueInterviews = due.length;
  if (!due.length) {
    logInfo("[interview-reminders] pass complete — nothing due", {
      metric: "interview_reminders_pass",
      asOf,
    });
    return report;
  }

  // Render every nudge through the registry (override row → default).
  const rendered = due.map((n) => {
    const tpl = resolveNotificationTemplate(config.notificationTemplates, "INTERVIEW_TODAY");
    return { nudge: n, ...renderEvent(tpl, n.vars) };
  });

  // In-app: ONE personal notification per nudge, idempotent via the unique
  // sourceKey. SQLite createMany has no skipDuplicates (the hr-shared
  // discipline), so the pass pre-checks today's existing keys and writes
  // row-by-row — an already-written nudge (re-run or a race the memory
  // backend missed) is skipped, never a failed pass.
  const existing = await db.notification.findMany({
    where: { sourceKey: { in: rendered.map((r) => r.nudge.sourceKey) } },
    select: { sourceKey: true },
  });
  const alreadyWritten = new Set(existing.map((n) => n.sourceKey));
  const fresh: typeof rendered = [];
  for (const r of rendered) {
    if (alreadyWritten.has(r.nudge.sourceKey)) continue;
    try {
      await db.notification.create({
        data: {
          recipientUserId: r.nudge.interviewerUserId,
          type: "INFO",
          title: r.title,
          message: r.message,
          sourceKey: r.nudge.sourceKey,
        },
      });
      report.notificationsWritten += 1;
      fresh.push(r);
    } catch (err) {
      // The unique-index collision (a concurrent pass won the race) — the
      // nudge exists, which is exactly what this writer wanted.
      logError("[interview-reminders] notification skipped (already written):", err);
    }
  }

  // Email (opt-in): one outbox row per nudge THIS pass newly wrote (the
  // in-app write gates the email — a same-day re-run queues nothing). The
  // interviewer's own address, never the candidate's (candidates already
  // got their INTERVIEW_INVITE at booking time — F-R10).
  if (emailOn && fresh.length) {
    try {
      const rowIds: string[] = [];
      for (const r of fresh) {
        const email = userById.get(r.nudge.interviewerUserId)?.email;
        if (!email) continue; // no address on file — the notification stands
        const row = await queueOutboxMail(db, {
          kind: "INTERVIEW_REMINDER",
          toAddress: email,
          subject: r.subject,
          text: r.text,
          sentById: "cron:interview-reminders",
        });
        rowIds.push(row.id);
      }
      report.emailsQueued = rowIds.length;
      // Delivery best-effort, outside any business transaction (the P18
      // rail; the outbox row is the durable record either way).
      for (const id of rowIds) {
        const row = await db.mailOutbox.findUnique({
          where: { id },
          select: { toAddress: true, subject: true, body: true },
        });
        if (!row) continue;
        await deliverOutboxMail(id, {
          toAddress: row.toAddress,
          subject: row.subject,
          html: interviewEmailHtml(row.body),
          text: row.body,
        }).catch((err: unknown) => logError("[interview-reminders] delivery failed:", err));
      }
    } catch (err) {
      // The email half must never fail the pass — the notifications above
      // are the primary surface; the outbox keeps its honesty on retry.
      logError("[interview-reminders] email pass failed:", err);
    }
  }

  logInfo("[interview-reminders] pass complete", {
    metric: "interview_reminders_pass",
    asOf,
    due: report.dueInterviews,
    notifications: report.notificationsWritten,
    emails: report.emailsQueued,
  });
  return report;
}

/** The plain-text nudge → the shared mail HTML wrap. */
export function interviewEmailHtml(text: string): string {
  return emailHtml(text);
}
