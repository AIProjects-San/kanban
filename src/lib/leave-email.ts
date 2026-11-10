// ---------------------------------------------------------------------------
// P21 (LV-T01/LV-T02) — the leave email builders (pure; a "use server" file
// may only export async functions, so these live here — the payslip-email
// house pattern). Subjects carry no day counts or statuses (subjects leak
// through mail-client previews); the text body is the audit copy the Outbox
// re-reads, and the HTML mirrors it.
//
// Benchmark shapes:
//   LV-T01 "Leave Application Pending Approval" (Save) → the leave
//   approver: employee, type, from, to, status, a view link.
//   LV-T02 "Leave Application Status Update" (Submit) → the employee:
//   "Your leave application has been {status}".
// ---------------------------------------------------------------------------

import { escapeHtml } from "@/lib/utils";

function days(n: number): string {
  return `${n % 1 === 0 ? n : n.toFixed(1)} day${n === 1 ? "" : "s"}`;
}

export interface LeaveEmailFacts {
  requesterName: string;
  typeName: string;
  startDate: string;
  endDate: string;
  days: number;
}

/** LV-T01 — the subject names the module only. */
export function leavePendingEmailSubject(): string {
  return "Leave request awaiting your approval";
}

export function leavePendingEmailText(facts: LeaveEmailFacts): string {
  return [
    `A leave request from ${facts.requesterName} is awaiting your approval.`,
    "",
    `Employee: ${facts.requesterName}`,
    `Leave type: ${facts.typeName}`,
    `From: ${facts.startDate}`,
    `To: ${facts.endDate}`,
    `Duration: ${days(facts.days)}`,
    "",
    "Review it in Fernly under HR → Requests.",
    "",
    "— Fernly HR",
  ].join("\n");
}

/** LV-T02 — the subject stays neutral (no status in previews). */
export function leaveDecidedEmailSubject(): string {
  return "Your leave request has been decided";
}

export function leaveDecidedEmailText(
  facts: LeaveEmailFacts,
  decision: "APPROVE" | "REJECT",
  deciderName: string,
  note: string,
): string {
  return [
    `Hi ${facts.requesterName},`,
    "",
    `Your ${days(facts.days)} ${facts.typeName} request (${facts.startDate} → ${facts.endDate}) has been ${decision === "APPROVE" ? "approved" : "rejected"} by ${deciderName}.${note ? ` Note: ${note}` : ""}`,
    "",
    "The request is in Fernly under Leave.",
    "",
    "— Fernly HR",
  ].join("\n");
}

export function leaveEmailHtml(text: string): string {
  const body = text
    .split("\n")
    .map((l) => (l.startsWith("Duration:") || l.endsWith("approved") || l.endsWith("rejected") ? `<strong>${escapeHtml(l)}</strong>` : escapeHtml(l)))
    .join("<br />");
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111;">${body}</div>`;
}

// ---------------------------------------------------------------------------
// P21 (LV-B18) — the earned-leave job failure alarm (the benchmark's
// send_email_for_failed_allocations to HR Managers; Fernly sends to every
// ADMIN+HR user, unconditionally — a failure alarm is operational telemetry,
// not a routine mail side effect, so the F-R17 zero-mail posture does not
// apply). One outbox row per recipient; the row itself is the retained
// failure record with every per-pair reason.
// ---------------------------------------------------------------------------

export function leaveJobFailureEmailSubject(): string {
  return "Automatic leave allocation failed";
}

export function leaveJobFailureEmailText(
  asOf: string,
  failures: Array<{ leaveTypeName: string; phase: string; reason: string }>,
): string {
  const shown = failures.slice(0, 10);
  return [
    `The daily leave-allocation pass (${asOf}) recorded ${failures.length} failure(s):`,
    "",
    ...shown.map((f) => `- ${f.leaveTypeName} (${f.phase} phase): ${f.reason}`),
    ...(failures.length > shown.length ? [`- … and ${failures.length - shown.length} more (see the Outbox copy in Fernly)`] : []),
    "",
    "The next daily pass retries every failed pair idempotently. If a failure repeats, check the error log.",
    "",
    "— Fernly HR",
  ].join("\n");
}
