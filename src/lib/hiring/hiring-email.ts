// ---------------------------------------------------------------------------
// R3 — candidate-facing email templates (docs/RECRUITMENT_MODULE_PLAN.md §5).
//
// Pure functions: no DB, no mailer — the server action composes, persists the
// MailOutbox row, then attempts delivery. Design rule: the INTERNAL rejection
// reason (Candidate.rejectReason) never goes into the email; only the
// HR-approved `remarks` typed into the send form do. The internal reason is
// audit-only and can be blunt; the external note is what the candidate reads.
// ---------------------------------------------------------------------------

import { APP } from "@/config/app";
import { escapeHtml } from "@/lib/shared/utils";

export interface RejectionEmailInput {
  candidateName: string;
  position: string;
  workspaceName: string;
  /** HR-approved personal note for the candidate ("" = omit the paragraph). */
  remarks: string;
}

export interface ComposedEmail {
  subject: string;
  text: string;
  html: string;
}

/** First name (given name) for the greeting — "Priyanka Menon" → "Priyanka",
 * "Cher" → "Cher". Falls back to the full name when it looks empty. */
export function firstNameOf(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  return first || fullName.trim() || "there";
}

export function composeRejectionEmail(input: RejectionEmailInput): ComposedEmail {
  const first = firstNameOf(input.candidateName);
  const position = input.position.trim();
  const org = input.workspaceName.trim() || APP.name;
  const remarks = input.remarks.trim();

  // Blank position → generic wording ("the role"), never "the role role".
  const subject = `Update on your application — ${position || "role"} at ${org}`;

  // Optional personal note paragraph (text + html variants).
  const noteText = remarks ? `\n${remarks}\n` : "";
  // Remarks are free text typed by HR — escape before the HTML part (F-07).
  const noteHtml = remarks ? `<p>${escapeHtml(remarks)}</p>` : "";

  const text =
    `Hi ${first},\n\n` +
    `Thank you for taking the time to apply for the ${position ? `${position} ` : ""}role at ${org} and for meeting our team.\n\n` +
    `After careful consideration, we have decided not to move forward with your application at this time.\n` +
    noteText +
    `\nWe appreciate your interest in ${org} and wish you the very best in your search.\n\n` +
    `Warm regards,\nThe ${org} Hiring Team`;

  const html =
    `<p>Hi ${escapeHtml(first)},</p>` +
    `<p>Thank you for taking the time to apply for the ${position ? `<strong>${escapeHtml(position)}</strong> ` : ""}role at ${escapeHtml(org)} and for meeting our team.</p>` +
    `<p>After careful consideration, we have decided not to move forward with your application at this time.</p>` +
    noteHtml +
    `<p>We appreciate your interest in ${escapeHtml(org)} and wish you the very best in your search.</p>` +
    `<p>Warm regards,<br>The ${escapeHtml(org)} Hiring Team</p>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// F2.10 (F-R10) — the interview-invite email. The MailOutbox kind
// INTERVIEW_INVITE has been reserved since the schema was written; this is
// its composer. Written by scheduleInterview on every schedule/reschedule
// (a reschedule MUST re-send — the email carries the new time; no same-day
// duplicate guard, unlike rejections).
// ---------------------------------------------------------------------------

export interface InterviewInviteEmailInput {
  candidateName: string;
  position: string;
  /** The pipeline stage label (e.g. "Interview 1 — Tech"). */
  stageLabel: string;
  workspaceName: string;
  /** The scheduled moment. */
  when: Date;
  /** Minutes booked (the calendar event's durationMin). */
  durationMin: number;
  /** The interviewer's display name, when known. */
  interviewerName?: string;
}

/** "Thu, 12 Nov 2026, 14:00" — weekday + short date + time, the shape a
 * candidate scans first. Invalid dates degrade to "to be confirmed" —
 * never the raw "Invalid Date" in a candidate-facing email. */
function formatInviteWhen(when: Date): string {
  const t = when.getTime();
  if (!Number.isFinite(t)) return "to be confirmed";
  return when.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function composeInterviewInviteEmail(input: InterviewInviteEmailInput): ComposedEmail {
  const first = firstNameOf(input.candidateName);
  const position = input.position.trim();
  const org = input.workspaceName.trim() || APP.name;
  const stage = input.stageLabel.trim() || "interview";
  const whenText = formatInviteWhen(input.when);
  const withWhom = input.interviewerName?.trim();
  const duration = Number.isFinite(input.durationMin) && input.durationMin > 0 ? Math.round(input.durationMin) : 60;

  const subject = `Interview invitation — ${position || stage} at ${org}`;

  const text =
    `Hi ${first},\n\n` +
    `Thank you for your continued application${position ? ` for the ${position} role` : ""} at ${org}.\n` +
    `We would like to invite you to an interview:\n\n` +
    `  Stage: ${stage}\n` +
    `  When: ${whenText} (${duration} minutes)\n` +
    (withWhom ? `  With: ${withWhom}\n` : "") +
    `\nIf the time does not work, just reply to this email and we will find another slot.\n\n` +
    `Looking forward to speaking with you!\n\n` +
    `Warm regards,\nThe ${org} Hiring Team`;

  const html =
    `<p>Hi ${escapeHtml(first)},</p>` +
    `<p>Thank you for your continued application${position ? ` for the <strong>${escapeHtml(position)}</strong> role` : ""} at ${escapeHtml(org)}.</p>` +
    `<p>We would like to invite you to an interview:</p>` +
    `<p><strong>Stage:</strong> ${escapeHtml(stage)}<br>` +
    `<strong>When:</strong> ${escapeHtml(whenText)} (${duration} minutes)<br>` +
    (withWhom ? `<strong>With:</strong> ${escapeHtml(withWhom)}<br>` : "") +
    `</p>` +
    `<p>If the time does not work, just reply to this email and we will find another slot.</p>` +
    `<p>Looking forward to speaking with you!</p>` +
    `<p>Warm regards,<br>The ${escapeHtml(org)} Hiring Team</p>`;

  return { subject, text, html };
}
