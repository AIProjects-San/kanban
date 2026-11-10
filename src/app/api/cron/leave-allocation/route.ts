import { NextResponse } from "next/server";
import { runLeaveAllocationJob, sendLeaveJobFailureAlarm } from "@/lib/leave-allocation-core";
import { captureError, logError } from "@/lib/observability";
import { tryAcquireMaintenanceLock, LEAVE_ALLOCATION_LOCK_KEY } from "@/lib/maintenance-lock";

// ---------------------------------------------------------------------------
// F2.4 — leave-allocation cron endpoint (docs/Fernly_HR_Payroll_
// Enhancement_Plan.md §7.2 F2.4; the benchmark's daily
// allocate_earned_leaves job, LV-J03).
//
// The engine itself lives in src/lib/leave-allocation-core.ts (the three
// ledger writers: strategy grants, year-end rollover, carry lapse). This
// route makes it schedulable — same security contract as /api/cron/
// prune-audit:
//
//   curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
//        https://app.example.com/api/cron/leave-allocation
//
// Security / operational notes:
//   • Disabled unless CRON_SECRET is set (503, no extra information).
//   • Bearer token, constant-time comparison — identical to prune-audit.
//   • Own maintenance lock key (LEAVE_ALLOCATION_LOCK_KEY): the audit
//     purge and this job are separate identities, so one running never
//     suppresses the other; the docker-compose scheduler calls both in
//     the same daily pass.
//   • The job is idempotent regardless of the lock (double-run ⇒ no new
//     ledger rows — the deterministic sourceId keys skip them).
//   • Never returns leave data — only the run's counters.
//   • Daily is the intended cadence: monthly EARNED periods and the
//     year-end rollover all advance on "first run after the due date".

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
    key: LEAVE_ALLOCATION_LOCK_KEY,
    minIntervalMs: MIN_INTERVAL_MS,
  });
  if (!lock.acquired) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: `a leave-allocation pass ran less than ${Math.round(MIN_INTERVAL_MS / 60000)} minutes ago`,
        lockBackend: lock.backend,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const report = await runLeaveAllocationJob();
    // P21 (LV-B18) — the failure alarm: when a pass recorded failures, one
    // LEAVE_JOB_FAILURE outbox row per ADMIN+HR user carries every per-pair
    // reason (moved into the core module at P26 so the daily dispatcher
    // reaches the same alarm; behavior byte-identical). Never throws into
    // the report.
    if (report.failures > 0) {
      await sendLeaveJobFailureAlarm(report).catch((err: unknown) => {
        logError("[leave-allocation] failure alarm failed:", err);
        captureError(err, { route: "/api/cron/leave-allocation", phase: "failure-alarm" });
      });
    }
    return NextResponse.json(
      { ok: true, lockBackend: lock.backend, ...report },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    captureError(err, { route: "/api/cron/leave-allocation" });
    return NextResponse.json(
      { ok: false, error: "leave allocation pass failed" },
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
