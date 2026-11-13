// ---------------------------------------------------------------------------
// P25 (PL-02/EM-23/EM-J01–03) — the engagement reminder engine
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P25 / F3.10; the
// benchmark's hrms/controllers/employee_reminders.py: send_birthday_
// reminders + send_work_anniversary_reminders daily, send_reminders_in_
// advance for holidays weekly/monthly).
//
// Split like every house kernel:
//   • dueEngagementReminders — PURE: which digests are due today (birthday
//     month-day match, whole-year anniversary match, holiday exactly N days
//     ahead), with the deterministic sourceKeys and the template variables.
//   • runEmployeeRemindersJob — the scheduled writer: reads the workspace
//     switches + profiles + holidays, renders the digests through the P24
//     template registry (override row → built-in default), writes ONE
//     broadcast notification per digest (unique sourceKey → skipDuplicates
//     makes re-runs idempotent), and queues the opt-in email digest per
//     live member (one MailOutbox row per recipient per event, deduped by
//     a day-window pre-check — the P18/P21 honesty rail).
//
// Idempotency: the in-app digests ride Notification.sourceKey
// (`ENGAGEMENT:BIRTHDAY:2026-11-10` — day-scoped for the two people
// digests; `ENGAGEMENT:HOLIDAY:<date>` — holiday-scoped so a mid-cycle knob
// change never double-reminds one holiday; the holiday's date is unique in
// the calendar, so it keys the digest). The unique index is the hard guard;
// the job pre-checks today's existing keys and writes row-by-row so one
// already-written digest never fails the pass (SQLite createMany has no
// skipDuplicates — the hr-shared discipline). The email half rides a
// kind+day pre-check below (bounded by the route's maintenance lock for
// concurrency; exact for re-runs).
//
// Eligibility: EXITED employees never celebrate (employmentStatus gate);
// deleted users never enter (the query filters deletedAt). The hire-day
// itself is not an anniversary (0 years — the benchmark's own rule).
// Leap-day (Feb 29) birthdays and anniversaries fire on Mar 1 in non-leap
// years (the benchmark's convention).
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { logError, logInfo } from "@/lib/observability";
import { getWorkspaceConfig } from "@/lib/config-loader";
import { queueOutboxMail, deliverOutboxMail } from "@/lib/server/mail-outbox";
import {
  resolveNotificationTemplate,
  renderTemplate,
  type ResolvedNotificationTemplate,
} from "@/lib/notification-template";
import { daysBetween } from "@/lib/working-days";
import { emailHtml } from "@/lib/email-html";

// ---------------------------------------------------------------------------
// The pure kernel
// ---------------------------------------------------------------------------

export type EngagementEventKey = "EMPLOYEE_BIRTHDAY" | "EMPLOYEE_ANNIVERSARY" | "HOLIDAY_UPCOMING";

export interface EngagementEmployee {
  userId: string;
  name: string;
  /** YYYY-MM-DD or null (no birthday on file → never reminded). */
  birthDate: string | null;
  /** YYYY-MM-DD or null (no hire date → no anniversary). */
  hireDate: string | null;
  /** "" | PROBATION | ACTIVE | SUSPENDED | EXITED — EXITED never celebrates. */
  employmentStatus: string;
}

export interface EngagementHoliday {
  /** The holiday's unique calendar date (YYYY-MM-DD) — the digest key. */
  date: string;
  /** The holiday's label (its display name). */
  label: string;
}

export interface EngagementSwitches {
  remindBirthdays: boolean;
  remindAnniversaries: boolean;
  remindHolidays: boolean;
  /** 1–30; the daily job matches `holidayDate − asOf === daysAhead` exactly. */
  holidayReminderDaysAhead: number;
}

export interface DueEngagementEvent {
  eventKey: EngagementEventKey;
  /** The deterministic Notification.sourceKey (see the header). */
  sourceKey: string;
  /** Pre-composed variables for the template registry. */
  vars: Record<string, string>;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Does an annual MM-DD anniversary land on asOf? Leap-day lands on Mar 1
 * in non-leap years (the benchmark's convention). */
function annualDayMatches(annual: string, asOf: string): boolean {
  const aMonth = Number(annual.slice(5, 7));
  const aDay = Number(annual.slice(8, 10));
  const tMonth = Number(asOf.slice(5, 7));
  const tDay = Number(asOf.slice(8, 10));
  const tYear = Number(asOf.slice(0, 4));
  if (aMonth === 2 && aDay === 29) {
    if (isLeapYear(tYear)) return tMonth === 2 && tDay === 29;
    return tMonth === 3 && tDay === 1; // Feb 29 people celebrate on Mar 1
  }
  return aMonth === tMonth && aDay === tDay;
}

/** Whole years between a hire date and asOf (the anniversary math); the
 * hire day itself is year 0 (not an anniversary). */
function wholeYearsSince(hireDate: string, asOf: string): number {
  const hYear = Number(hireDate.slice(0, 4));
  const tYear = Number(asOf.slice(0, 4));
  const years = tYear - hYear;
  if (years <= 0) return 0;
  // Only count a completed year when the anniversary day has arrived —
  // annualDayMatches already guarantees the MM-DD alignment, so any year
  // difference ≥ 1 here is a completed anniversary.
  return years;
}

function listNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The pure rule: which engagement digests are due on `asOf`.
 * Excludes EXITED employees; skips empty digests (no birthday → no row,
 * never a "nobody has a birthday" notification — the benchmark sends
 * nothing when the list is empty).
 */
export function dueEngagementReminders(input: {
  asOf: string;
  employees: EngagementEmployee[];
  holidays: EngagementHoliday[];
  switches: EngagementSwitches;
}): DueEngagementEvent[] {
  const events: DueEngagementEvent[] = [];
  const live = input.employees.filter((e) => e.employmentStatus !== "EXITED");

  if (input.switches.remindBirthdays) {
    const celebrating = live
      .filter((e) => e.birthDate && annualDayMatches(e.birthDate, input.asOf))
      .map((e) => e.name);
    if (celebrating.length) {
      events.push({
        eventKey: "EMPLOYEE_BIRTHDAY",
        sourceKey: `ENGAGEMENT:BIRTHDAY:${input.asOf}`,
        vars: {
          names: listNames(celebrating),
          count: String(celebrating.length),
          date: input.asOf,
        },
      });
    }
  }

  if (input.switches.remindAnniversaries) {
    const marking = live
      .filter((e) => e.hireDate && annualDayMatches(e.hireDate, input.asOf))
      .map((e) => {
        const years = wholeYearsSince(e.hireDate as string, input.asOf);
        return years >= 1 ? `${e.name} (${years} year${years === 1 ? "" : "s"})` : null;
      })
      .filter((x): x is string => x !== null);
    if (marking.length) {
      events.push({
        eventKey: "EMPLOYEE_ANNIVERSARY",
        sourceKey: `ENGAGEMENT:ANNIVERSARY:${input.asOf}`,
        vars: {
          names: listNames(marking),
          count: String(marking.length),
          date: input.asOf,
        },
      });
    }
  }

  if (input.switches.remindHolidays) {
    const daysAhead = Math.min(Math.max(Math.round(input.switches.holidayReminderDaysAhead) || 7, 1), 30);
    for (const h of input.holidays) {
      const gap = daysBetween(input.asOf, h.date);
      if (gap === daysAhead) {
        events.push({
          eventKey: "HOLIDAY_UPCOMING",
          // Holiday-scoped by its unique calendar date, not day-scoped:
          // changing the knob mid-cycle must never re-remind one holiday.
          sourceKey: `ENGAGEMENT:HOLIDAY:${h.date}`,
          vars: {
            holidayName: h.label,
            holidayDate: h.date,
            daysAhead: String(daysAhead),
            date: input.asOf,
          },
        });
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// The scheduled writer
// ---------------------------------------------------------------------------

export interface EmployeeRemindersJobReport {
  asOf: string;
  birthdays: number;
  anniversaries: number;
  holidays: number;
  /** Broadcast notifications written this pass (idempotent: re-runs write 0). */
  broadcastsWritten: number;
  /** Outbox rows queued this pass (0 when the email rail is off). */
  emailsQueued: number;
  /** Digest events skipped because an email of the same kind already went
   * out today (the day-window dedup — a same-day re-run). */
  emailKindsSkipped: number;
}

const ENGAGEMENT_KINDS: EngagementEventKey[] = ["EMPLOYEE_BIRTHDAY", "EMPLOYEE_ANNIVERSARY", "HOLIDAY_UPCOMING"];

function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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
 * One engagement pass. NEVER throws for a single bad piece — the report is
 * the truth, failures log and count (the leave-allocation job's posture).
 */
export async function runEmployeeRemindersJob(): Promise<EmployeeRemindersJobReport> {
  const now = new Date();
  const asOf = now.toISOString().slice(0, 10);
  const report: EmployeeRemindersJobReport = {
    asOf,
    birthdays: 0,
    anniversaries: 0,
    holidays: 0,
    broadcastsWritten: 0,
    emailsQueued: 0,
    emailKindsSkipped: 0,
  };

  // The switches + template override rows ride the SAME cached config read
  // the interactive surfaces use (10s TTL + PR-31 pub/sub invalidation).
  const config = await getWorkspaceConfig();
  const switches: EngagementSwitches = {
    remindBirthdays: config.workspace.remindBirthdays !== false,
    remindAnniversaries: config.workspace.remindAnniversaries !== false,
    remindHolidays: config.workspace.remindHolidays !== false,
    holidayReminderDaysAhead: config.workspace.holidayReminderDaysAhead,
  };
  const emailOn = config.workspace.emailEngagementReminders === true;

  // Employees: live users' profiles (name comes from the user; the profile
  // carries the dates). Deleted users never celebrate.
  const [profiles, users] = await Promise.all([
    db.employeeProfile.findMany({
      select: { userId: true, birthDate: true, hireDate: true, employmentStatus: true },
    }),
    db.user.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
  ]);
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const employees: EngagementEmployee[] = profiles.flatMap((p) => {
    const name = nameById.get(p.userId);
    if (!name) return []; // profile of a deleted user — never reminded
    return [{
      userId: p.userId,
      name,
      birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
      hireDate: p.hireDate ? p.hireDate.toISOString().slice(0, 10) : null,
      employmentStatus: p.employmentStatus,
    }];
  });

  // Holidays: from today forward (the advance match only ever looks
  // ahead). The date is unique per calendar — one digest per holiday.
  const holidayRows = await db.holidayCalendarEntry.findMany({
    where: { date: { gte: now } },
    select: { date: true, label: true },
    orderBy: { date: "asc" },
    take: 100, // a year's worth; the digest fires at most once per row
  });
  const holidays: EngagementHoliday[] = holidayRows.map((h) => ({
    date: h.date.toISOString().slice(0, 10),
    label: h.label,
  }));

  const events = dueEngagementReminders({ asOf, employees, holidays, switches });
  report.birthdays = events.filter((e) => e.eventKey === "EMPLOYEE_BIRTHDAY").length;
  report.anniversaries = events.filter((e) => e.eventKey === "EMPLOYEE_ANNIVERSARY").length;
  report.holidays = events.filter((e) => e.eventKey === "HOLIDAY_UPCOMING").length;

  if (!events.length) {
    logInfo("[employee-reminders] pass complete — nothing due", {
      metric: "employee_reminders_pass",
      asOf,
    });
    return report;
  }

  // Render every digest through the registry (override row → default).
  const rendered = events.map((e) => {
    const tpl = resolveNotificationTemplate(config.notificationTemplates, e.eventKey);
    return { event: e, ...renderEvent(tpl, e.vars) };
  });

  // In-app: ONE broadcast row per digest, idempotent via the unique
  // sourceKey. SQLite createMany has no skipDuplicates (the hr-shared
  // discipline), so the pass pre-checks today's existing keys and writes
  // row-by-row — an already-written digest (re-run or a race the memory
  // backend missed) is skipped, never a failed pass.
  const existing = await db.notification.findMany({
    where: { sourceKey: { in: rendered.map((r) => r.event.sourceKey) } },
    select: { sourceKey: true },
  });
  const alreadyWritten = new Set(existing.map((n) => n.sourceKey));
  for (const r of rendered) {
    if (alreadyWritten.has(r.event.sourceKey)) continue;
    try {
      await db.notification.create({
        data: {
          recipientUserId: null,
          type: "INFO",
          title: r.title,
          message: r.message,
          sourceKey: r.event.sourceKey,
        },
      });
      report.broadcastsWritten += 1;
    } catch (err) {
      // The unique-index collision (a concurrent pass won the race) — the
      // digest exists, which is exactly what this writer wanted.
      logError("[employee-reminders] broadcast skipped (already written):", err);
    }
  }

  // Email (opt-in): one digest row per live member WITH an address, per
  // event. Day-window dedup: an event kind that already emailed today is
  // skipped whole (a same-day re-run queues nothing).
  if (emailOn) {
    try {
      const sentToday = await db.mailOutbox.findMany({
        where: { kind: { in: ENGAGEMENT_KINDS }, createdAt: { gte: dayStartUtc(now) } },
        select: { kind: true },
      });
      const alreadySent = new Set(sentToday.map((r) => r.kind));
      const recipients = await db.user.findMany({
        where: { deletedAt: null, NOT: { email: "" } },
        select: { email: true },
        take: 200, // fan-out bound (the QA-17 posture at digest scale)
      });
      const toSend = rendered.filter((r) => {
        if (alreadySent.has(r.event.eventKey)) {
          report.emailKindsSkipped += 1;
          return false;
        }
        return true;
      });
      const rowIds: string[] = [];
      for (const r of toSend) {
        for (const rcpt of recipients) {
          const row = await queueOutboxMail(db, {
            kind: r.event.eventKey,
            toAddress: rcpt.email,
            subject: r.subject,
            text: r.text,
            sentById: "cron:employee-reminders",
          });
          rowIds.push(row.id);
        }
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
          html: engagementEmailHtml(row.body),
          text: row.body,
        }).catch((err: unknown) => logError("[employee-reminders] delivery failed:", err));
      }
    } catch (err) {
      // The email half must never fail the pass — the broadcasts above are
      // the primary surface; the outbox keeps its honesty on retry.
      logError("[employee-reminders] email pass failed:", err);
    }
  }

  logInfo("[employee-reminders] pass complete", {
    metric: "employee_reminders_pass",
    asOf,
    broadcasts: report.broadcastsWritten,
    emails: report.emailsQueued,
  });
  return report;
}

/** The plain-text digest → the shared mail HTML wrap. */
export function engagementEmailHtml(text: string): string {
  return emailHtml(text, { bold: (line) => (line.startsWith("Holiday:") || line.startsWith("Work anniversaries") || line.startsWith("Birthdays")) });
}
