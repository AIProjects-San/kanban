import { NextResponse } from "next/server";
import {
  runEncashmentAutoDraftJob,
  sendEncashmentAutoDraftFailureAlarm,
} from "@/lib/encashment-auto-draft";
import { captureError, logError } from "@/lib/observability";
import { tryAcquireMaintenanceLock, ENCASHMENT_AUTO_DRAFT_LOCK_KEY } from "@/lib/maintenance-lock";

// ---------------------------------------------------------------------------
// P31 (LV-J02 / LV-09's remainder) — the encashment auto-draft cron
// endpoint (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P31; the
// benchmark's daily generate_leave_encashment job).
//
// The engine lives in src/lib/encashment-auto-draft.ts (the pure planner
// in lib/leave-encashment.ts + the scheduled writer). This route makes it
// individually schedulable — same security contract as every cron route:
//
//   curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
//        https://app.example.com/api/cron/leave-encashment
//
// Security / operational notes:
//   • Disabled unless CRON_SECRET is set (503, no extra information).
//   • Bearer token, constant-time comparison — identical to prune-audit.
//   • Own maintenance lock key (ENCASHMENT_AUTO_DRAFT_LOCK_KEY): the
//     benchmark's job runs unconditionally; Fernly's is additionally
//     gated by the Workspace.autoLeaveEncashment switch (default OFF —
//     drafting encashment requests on members' behalf is a policy choice).
//   • The job is idempotent regardless of the lock (one live draft per
//     pair — a re-run plans nothing).
//   • Never returns leave data — only the pass's counters and failure
//     reasons (the leave-allocation report contract).
//   • Daily dispatcher: this job also rides /api/cron/daily (the fifth
//     carried job); the standalone route stays for per-job scheduling.
// ---------------------------------------------------------------------------

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
    key: ENCASHMENT_AUTO_DRAFT_LOCK_KEY,
    minIntervalMs: MIN_INTERVAL_MS,
  });
  if (!lock.acquired) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: `an encashment-auto-draft pass ran less than ${Math.round(MIN_INTERVAL_MS / 60000)} minutes ago`,
        lockBackend: lock.backend,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const report = await runEncashmentAutoDraftJob();
    // P31 — the LV-B18 failure-alarm discipline: when a pass recorded
    // failures, one LEAVE_JOB_FAILURE outbox row per ADMIN+HR user
    // carries every per-pair reason (the same contract the allocation
    // pass ships). Never throws into the report.
    if (report.failures > 0) {
      await sendEncashmentAutoDraftFailureAlarm(report).catch((err: unknown) => {
        logError("[leave-encashment] failure alarm failed:", err);
        captureError(err, { route: "/api/cron/leave-encashment", phase: "failure-alarm" });
      });
    }
    return NextResponse.json(
      { ok: true, lockBackend: lock.backend, ...report },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    captureError(err, { route: "/api/cron/leave-encashment" });
    return NextResponse.json(
      { ok: false, error: "encashment auto-draft pass failed" },
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
