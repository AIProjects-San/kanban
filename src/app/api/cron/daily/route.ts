import { NextResponse } from "next/server";
import {
  runLeaveAllocationJob,
  sendLeaveJobFailureAlarm,
} from "@/lib/leave/leave-allocation-core";
import { runEmployeeRemindersJob } from "@/lib/hr/employee-reminders";
import { runInterviewRemindersJob } from "@/lib/hiring/interview-reminders";
import {
  runEncashmentAutoDraftJob,
  sendEncashmentAutoDraftFailureAlarm,
} from "@/lib/leave/encashment-auto-draft";
import { runDueEmploymentDocumentsJob } from "@/lib/hr/employment-doc-effect";
import { captureError, logError } from "@/lib/infra/observability";
import {
  tryAcquireMaintenanceLock,
  LEAVE_ALLOCATION_LOCK_KEY,
  EMPLOYEE_REMINDERS_LOCK_KEY,
  INTERVIEW_REMINDERS_LOCK_KEY,
  ENCASHMENT_AUTO_DRAFT_LOCK_KEY,
  EMPLOYMENT_DOCS_LOCK_KEY,
} from "@/lib/infra/maintenance-lock";

// ---------------------------------------------------------------------------
// P26 (PL-03) — the DAILY DISPATCHER: one route carrying every HR job, the
// workspace-scope answer to the benchmark's scheduler_events buckets
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P26). The benchmark
// registers 16 cron jobs across all/hourly/daily/weekly/monthly buckets;
// Fernly runs ONE daily pass and lets each job's own idempotency decide
// whether it has work — the per-minute/hourly buckets stay declined (a
// web app polls daily, never per-minute; named in the matrix row).
//
// Jobs carried, in order:
//   1. leave-allocation  — the ledger pass: earned-leave grants, year-end
//      rollover, carry lapse ("expiry") (F2.4 / LV-J01–03)
//   2. employee-reminders — the engagement digests: birthdays, work
//      anniversaries, advance holidays (P25 / PL-02, EM-J01–03)
//   3. interview-reminders — the day-of interviewer nudges (P26 / RJ-B18)
//   4. encashment-auto-draft — the opt-in encashment proposals for
//      balances over the floor (P31 / LV-J02, LV-09's remainder;
//      gated by the Workspace.autoLeaveEncashment switch, default OFF)
//   5. employment-documents — the effective-date sweep: APPROVED
//      transfers/promotions whose date has arrived go EFFECTIVE and their
//      facts land (P1 G6; per-document isolation, the status flip is the
//      idempotency)
//
// NOT carried: the platform audit purge (/api/cron/prune-audit) — launch
// gate 12's own endpoint, called first in the compose loop. The HR jobs
// and the audit purge are separate contracts with separate locks.
//
// Security / operational contract — identical to every cron route:
//
//   curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
//        https://app.example.com/api/cron/daily
//
//   • Disabled unless CRON_SECRET is set (503, no extra information).
//   • Bearer token, constant-time comparison.
//   • NO dispatcher-level lock: every job acquires its OWN maintenance
//     lock identity (leave_allocation / employee_reminders /
//     interview_reminders), so a concurrent dispatcher or a stray call to
//     a job's standalone route is suppressed by that job's own 1-hour
//     window — the dispatcher composes locks, it does not add one.
//   • Per-job isolation: one job failing (or being lock-skipped) never
//     aborts the others — the report carries each job's own outcome and
//     the HTTP status only reflects whether every carried job reported
//     ok (a skipped job is ok: it ran recently, which is the truth).
//   • The standalone routes stay available for per-job scheduling (a
//     deployment that only wants the leave pass, say); the dispatcher is
//     the convenience surface, never the only one.
//   • Never returns employee or candidate data — only the jobs' counters.
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour — per-job overlap guard only

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token.length > 0 && timingSafeEqual(token, secret);
}

/** One carried job's outcome, flattened into the response's jobs[] array. */
interface JobOutcome {
  job: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  [counter: string]: unknown;
}

async function runJob(
  name: string,
  lockKey: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<JobOutcome> {
  const lock = await tryAcquireMaintenanceLock({
    key: lockKey,
    minIntervalMs: MIN_INTERVAL_MS,
  });
  if (!lock.acquired) {
    return {
      job: name,
      ok: true,
      skipped: true,
      reason: `a ${name} pass ran less than ${Math.round(MIN_INTERVAL_MS / 60000)} minutes ago`,
    };
  }
  try {
    const report = await fn();
    return { job: name, ok: true, ...report };
  } catch (err) {
    // One job's failure must never abort the pass — capture, report, move on.
    captureError(err, { route: "/api/cron/daily", job: name });
    return { job: name, ok: false, error: `${name} pass failed` };
  }
}

async function handle(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    // Not configured → the dispatcher is disabled. 503 (not 404) so a
    // misconfigured scheduler visibly fails instead of silently doing
    // nothing.
    return NextResponse.json(
      { ok: false, error: "cron disabled (CRON_SECRET not set)" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The jobs, in their fixed order (ledger first — the reminder passes
  // read what it wrote; the discipline the compose loop already had).
  const jobs: JobOutcome[] = [];
  jobs.push(
    await runJob("leave-allocation", LEAVE_ALLOCATION_LOCK_KEY, async () => {
      const report = await runLeaveAllocationJob();
      // P21 (LV-B18) — the failure alarm rides the pass wherever it runs
      // from (the standalone route does the same; the core module owns the
      // alarm so both callers are byte-identical).
      if (report.failures > 0) {
        await sendLeaveJobFailureAlarm(report).catch((err: unknown) => {
          logError("[daily:leave-allocation] failure alarm failed:", err);
          captureError(err, { route: "/api/cron/daily", job: "leave-allocation", phase: "failure-alarm" });
        });
      }
      return report as unknown as Record<string, unknown>;
    }),
  );
  jobs.push(
    await runJob("employee-reminders", EMPLOYEE_REMINDERS_LOCK_KEY, async () =>
      (await runEmployeeRemindersJob()) as unknown as Record<string, unknown>,
    ),
  );
  jobs.push(
    await runJob("interview-reminders", INTERVIEW_REMINDERS_LOCK_KEY, async () =>
      (await runInterviewRemindersJob()) as unknown as Record<string, unknown>,
    ),
  );
  jobs.push(
    await runJob("encashment-auto-draft", ENCASHMENT_AUTO_DRAFT_LOCK_KEY, async () => {
      const report = await runEncashmentAutoDraftJob();
      // P31 — the LV-B18 failure-alarm discipline riding this job too
      // (the core module owns the alarm so every caller is identical).
      if (report.failures > 0) {
        await sendEncashmentAutoDraftFailureAlarm(report).catch((err: unknown) => {
          logError("[daily:encashment-auto-draft] failure alarm failed:", err);
          captureError(err, {
            route: "/api/cron/daily",
            job: "encashment-auto-draft",
            phase: "failure-alarm",
          });
        });
      }
      return report as unknown as Record<string, unknown>;
    }),
  );
  jobs.push(
    await runJob("employment-documents", EMPLOYMENT_DOCS_LOCK_KEY, async () =>
      (await runDueEmploymentDocumentsJob()) as unknown as Record<string, unknown>,
    ),
  );

  const allOk = jobs.every((j) => j.ok);
  return NextResponse.json(
    { ok: allOk, jobs },
    { status: allOk ? 200 : 500, headers: { "Cache-Control": "no-store" } },
  );
}

// Both verbs supported: Kubernetes CronJobs typically GET; system crontabs
// often POST. Both require the same bearer token.
export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
