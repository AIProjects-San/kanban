import { NextResponse } from "next/server";
import { runInterviewRemindersJob } from "@/lib/hiring/interview-reminders";
import { captureError } from "@/lib/infra/observability";
import { tryAcquireMaintenanceLock, INTERVIEW_REMINDERS_LOCK_KEY } from "@/lib/infra/maintenance-lock";

// ---------------------------------------------------------------------------
// P26 (PL-03/RJ-B18) — the interview-reminders cron endpoint (docs/
// Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P26; the benchmark's daily
// send_interview_reminder job, workspace-scoped to a day-of interviewer
// nudge). The engine lives in src/lib/hiring/interview-reminders.ts; this route
// (and the daily dispatcher, which carries it beside the other HR jobs)
// makes it schedulable — same security contract as /api/cron/prune-audit,
// leave-allocation and employee-reminders:
//
//   curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
//        https://app.example.com/api/cron/interview-reminders
//
//   • Disabled unless CRON_SECRET is set (503, no extra information).
//   • Bearer token, constant-time comparison.
//   • Own maintenance lock identity (INTERVIEW_REMINDERS_LOCK_KEY): the
//     other daily jobs' runs never suppress it.
//   • Idempotent regardless of the lock: each nudge rides the unique
//     Notification.sourceKey (`INTERVIEW_REMINDER:<stageId>:<day>`) and
//     the email half only fires for nudges the pass newly wrote — a
//     double-run writes nothing.
//   • Never returns candidate data — only the pass's counters.
//   • The workspace switch gates everything (off → a no-op pass that
//     still reports ok, so the scheduler's log stays honest).
//   • Daily is the intended cadence: the nudge is the morning-of pass.
//     The benchmark's per-minute poll loop stays declined (named in the
//     matrix's PL-03 row).

const MIN_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour — overlap guard only

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

async function handle(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    // Not configured → the job is disabled. 503 (not 404) so a misconfigured
    // scheduler visibly fails instead of silently doing nothing.
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

  const lock = await tryAcquireMaintenanceLock({
    key: INTERVIEW_REMINDERS_LOCK_KEY,
    minIntervalMs: MIN_INTERVAL_MS,
  });
  if (!lock.acquired) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: `an interview-reminders pass ran less than ${Math.round(MIN_INTERVAL_MS / 60000)} minutes ago`,
        lockBackend: lock.backend,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const report = await runInterviewRemindersJob();
    return NextResponse.json(
      { ok: true, lockBackend: lock.backend, ...report },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    captureError(err, { route: "/api/cron/interview-reminders" });
    return NextResponse.json(
      { ok: false, error: "interview reminders pass failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// Both verbs supported: Kubernetes CronJobs typically GET; system crontabs
// often POST. Both require the same bearer token.
export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
