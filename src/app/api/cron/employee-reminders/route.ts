import { NextResponse } from "next/server";
import { runEmployeeRemindersJob } from "@/lib/hr/employee-reminders";
import { captureError } from "@/lib/infra/observability";
import { tryAcquireMaintenanceLock, EMPLOYEE_REMINDERS_LOCK_KEY } from "@/lib/infra/maintenance-lock";

// ---------------------------------------------------------------------------
// P25 (PL-02/EM-J01–03) — the engagement-reminders cron endpoint (docs/
// Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P25 / F3.10; the benchmark's
// daily send_birthday_reminders + send_work_anniversary_reminders and the
// advance-holiday pass, collapsed into ONE daily route — the advance match
// is exact-day, so each holiday reminds exactly once).
//
// Same security contract as /api/cron/prune-audit and leave-allocation:
//
//   curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
//        https://app.example.com/api/cron/employee-reminders
//
//   • Disabled unless CRON_SECRET is set (503, no extra information).
//   • Bearer token, constant-time comparison.
//   • Own maintenance lock identity (EMPLOYEE_REMINDERS_LOCK_KEY): the
//     audit purge and the leave-allocation pass never suppress it.
//   • Idempotent regardless of the lock: the digests ride the unique
//     Notification.sourceKey (createMany skipDuplicates) and the email
//     half rides a kind+day pre-check — a double-run writes nothing.
//   • Never returns employee data — only the pass's counters.
//   • The workspace switches gate everything (all three off → a no-op pass
//     that still reports ok, so the scheduler's log stays honest).

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
    key: EMPLOYEE_REMINDERS_LOCK_KEY,
    minIntervalMs: MIN_INTERVAL_MS,
  });
  if (!lock.acquired) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        reason: `an engagement-reminders pass ran less than ${Math.round(MIN_INTERVAL_MS / 60000)} minutes ago`,
        lockBackend: lock.backend,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const report = await runEmployeeRemindersJob();
    return NextResponse.json(
      { ok: true, lockBackend: lock.backend, ...report },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    captureError(err, { route: "/api/cron/employee-reminders" });
    return NextResponse.json(
      { ok: false, error: "engagement reminders pass failed" },
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
