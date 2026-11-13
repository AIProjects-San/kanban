// ---------------------------------------------------------------------------
// P31 (LV-J02 / LV-09's remainder) — the encashment auto-draft job (the
// scheduled writer). docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P31;
// the benchmark's daily generate_leave_encashment cron.
//
// The pure planner (which pairs get a draft, with which days) lives in
// lib/leave/leave-encashment.ts beside planLeaveEncashment — ONE rule, both
// callers. This module owns the rows:
//
//   • the workspace switch gates the whole pass (Workspace.
//     autoLeaveEncashment, default OFF — drafting encashment requests on
//     members' behalf is a policy choice, never a surprise queue row);
//   • candidates = the year's balance-cache pairs whose type opted into
//     encashment; the LEDGER projection (not the cache) supplies the
//     available days, one batched groupBy for the whole pass;
//   • every draft = ONE PENDING LeaveEncashment row (payout = next
//     month, createdById "cron:leave-encashment") + ONE best-effort INFO
//     notification to the member (sourceKey ENCASHMENT_AUTO_DRAFT:<rowId>
//     — a draft the member never filed still lands in their Leave view's
//     encashment list, so the balance they are about to sell is no
//     surprise);
//   • idempotency is the KERNEL's one-live-draft-per-pair rule (a re-run
//     finds the PENDING row it wrote yesterday and plans nothing), not a
//     sourceKey — the draft row IS the state;
//   • failures: per-pair isolation (the leave-allocation posture) — one
//     bad pair logs, counts and moves on; the LV-B18 discipline rides:
//     failuresDetail + the unconditional LEAVE_JOB_FAILURE outbox alarm
//     to ADMIN+HR when a pass recorded any.
//
// Never throws for a single bad pair; the report is the truth.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import { logError, logInfo } from "@/lib/infra/observability";
import { dayKey } from "@/lib/hr/working-days";
import { projectLeaveBalance } from "@/lib/leave/leave-ledger";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import {
  resolveLeavePolicy,
  type ResolvedLeavePolicy,
} from "@/lib/leave/leave-policy";
import {
  dueEncashmentAutoDrafts,
  type EncashmentAutoDraftSwitches,
} from "@/lib/leave/leave-encashment";
import { queueOutboxMail, deliverOutboxMail } from "@/lib/email/mail-outbox";
import {
  encashmentDraftFailureEmailSubject,
  encashmentDraftFailureEmailText,
  leaveEmailHtml,
} from "@/lib/leave/leave-email";

export interface EncashmentAutoDraftFailure {
  userId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  reason: string;
}

export interface EncashmentAutoDraftJobReport {
  asOf: string;
  /** The ledger year the pass planned against (the request path's own). */
  year: number;
  /** (member × encashable type) pairs examined. */
  pairsConsidered: number;
  /** PENDING drafts written this pass (idempotent: re-runs write 0). */
  draftsWritten: number;
  /** Best-effort member notifications written. */
  notificationsWritten: number;
  failures: number;
  /** LV-B18's discipline riding the new job — one per failed pair. */
  failuresDetail: EncashmentAutoDraftFailure[];
}

/**
 * One encashment auto-draft pass. Gated by the workspace switch; the
 * kernel owns every planning rule; this writer only gathers facts,
 * creates the rows and reports. Default asOf = today UTC.
 */
export async function runEncashmentAutoDraftJob(asOfDate?: Date): Promise<EncashmentAutoDraftJobReport> {
  const asOfD = asOfDate ?? new Date();
  const asOf = dayKey(asOfD);
  const year = asOfD.getUTCFullYear();
  const report: EncashmentAutoDraftJobReport = {
    asOf,
    year,
    pairsConsidered: 0,
    draftsWritten: 0,
    notificationsWritten: 0,
    failures: 0,
    failuresDetail: [],
  };

  // The switch rides the SAME cached config read the interactive surfaces
  // use (10s TTL + PR-31 pub/sub invalidation) — flipping it in Settings
  // takes effect on the next pass, no deploy.
  const config = await getWorkspaceConfig();
  const switches: EncashmentAutoDraftSwitches = {
    autoLeaveEncashment: config.workspace.autoLeaveEncashment === true,
  };
  if (!switches.autoLeaveEncashment) {
    logInfo("[encashment-auto-draft] pass skipped — the switch is off", {
      metric: "encashment_auto_draft_pass",
      asOf,
    });
    return report;
  }

  // The encashable types (the policy knob, default off — an opted-out
  // workspace is an honest empty pass).
  const types = await db.leaveType.findMany({
    where: { active: true },
    include: { policy: true },
  });
  const encashable = types.filter((t) => {
    if (!t.policy) return false;
    return resolveLeavePolicy(t.policy).encashable;
  });
  if (encashable.length === 0) {
    logInfo("[encashment-auto-draft] pass complete — no encashable types", {
      metric: "encashment_auto_draft_pass",
      asOf,
    });
    return report;
  }
  const policyByType = new Map<string, ResolvedLeavePolicy>(
    encashable.map((t) => [t.id, resolveLeavePolicy(t.policy)]),
  );
  const nameByType = new Map(encashable.map((t) => [t.id, t.name]));
  const typeIds = encashable.map((t) => t.id);

  // The candidate pairs: this year's balance-cache rows (the ledger's
  // read cache — a pair with no row has nothing materialized to sell).
  const balances = await db.leaveBalance.findMany({
    where: { year, leaveTypeId: { in: typeIds } },
    select: { userId: true, leaveTypeId: true },
  });
  if (balances.length === 0) {
    logInfo("[encashment-auto-draft] pass complete — no pairs", {
      metric: "encashment_auto_draft_pass",
      asOf,
    });
    return report;
  }

  // Live members only (deleted users never get drafts) and non-EXITED
  // employment (a terminated employee's residual balance is the off-
  // boarding FnF's business, not a fresh encashment proposal).
  const userIds = [...new Set(balances.map((b) => b.userId))];
  const users = await db.user.findMany({
    where: { id: { in: userIds }, deletedAt: null },
    select: { id: true, name: true },
  });
  const liveUserIds = new Set(users.map((u) => u.id));
  const profiles = await db.employeeProfile.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, employmentStatus: true },
  });
  const statusByUser = new Map(
    profiles.map((p) => [p.userId, p.employmentStatus]),
  );
  const eligiblePairs = balances.filter(
    (b) => liveUserIds.has(b.userId) && statusByUser.get(b.userId) !== "EXITED",
  );
  report.pairsConsidered = eligiblePairs.length;

  // The ledger truth for every pair in ONE batched groupBy (the same
  // projection the approval re-reads inside its transaction).
  const ledgerGroups = await db.leaveLedgerEntry.groupBy({
    by: ["userId", "leaveTypeId", "entryType"],
    where: { year, userId: { in: eligiblePairs.map((p) => p.userId) }, leaveTypeId: { in: typeIds } },
    _sum: { delta: true },
  });
  const availableByPair = new Map<string, number>();
  const pairKey = (userId: string, leaveTypeId: string) => `${userId}::${leaveTypeId}`;
  const groupedByPair = new Map<string, Array<{ entryType: string; delta: number }>>();
  for (const g of ledgerGroups) {
    const key = pairKey(g.userId, g.leaveTypeId);
    const list = groupedByPair.get(key) ?? [];
    list.push({ entryType: g.entryType, delta: g._sum.delta ?? 0 });
    groupedByPair.set(key, list);
  }
  for (const [key, list] of groupedByPair) {
    availableByPair.set(key, projectLeaveBalance(list).available);
  }

  // The pair's live/rejected draft history (one read for the whole pass).
  const history = await db.leaveEncashment.findMany({
    where: { year, userId: { in: userIds }, leaveTypeId: { in: typeIds } },
    select: { userId: true, leaveTypeId: true, status: true },
  });
  const liveDraftPairs = new Set<string>();
  const rejectedDraftPairs = new Set<string>();
  for (const h of history) {
    const key = pairKey(h.userId, h.leaveTypeId);
    if (h.status === "PENDING" || h.status === "APPROVED") liveDraftPairs.add(key);
    if (h.status === "REJECTED") rejectedDraftPairs.add(key);
  }

  // The kernel decides; the writer just lands its verdicts.
  const candidates = eligiblePairs.map((p) => {
    const key = pairKey(p.userId, p.leaveTypeId);
    return {
      userId: p.userId,
      leaveTypeId: p.leaveTypeId,
      leaveTypeName: nameByType.get(p.leaveTypeId) ?? "Leave",
      policy: policyByType.get(p.leaveTypeId) as ResolvedLeavePolicy,
      availableDays: availableByPair.get(key) ?? 0,
      hasLiveDraft: liveDraftPairs.has(key),
      hasRejectedDraft: rejectedDraftPairs.has(key),
    };
  });
  const due = dueEncashmentAutoDrafts({ asOf, candidates, switches });

  for (const d of due) {
    try {
      const row = await db.leaveEncashment.create({
        data: {
          userId: d.userId,
          leaveTypeId: d.leaveTypeId,
          year,
          days: d.days,
          status: "PENDING",
          payoutPeriod: d.payoutPeriod,
          reason: "Auto-drafted by the daily leave job — the balance exceeded the encashable floor.",
          createdById: "cron:leave-encashment",
        },
      });
      report.draftsWritten += 1;
      // Best-effort member notice — their balance is being proposed for
      // sale, they should see it coming. Never fails the pass.
      try {
        await db.notification.create({
          data: {
            recipientUserId: d.userId,
            type: "INFO",
            title: "Leave encashment drafted for review",
            message: `${d.days} day(s) of ${d.leaveTypeName} were auto-drafted for encashment review (payout ${d.payoutPeriod}).`,
            sourceKey: `ENCASHMENT_AUTO_DRAFT:${row.id}`,
          },
        });
        report.notificationsWritten += 1;
      } catch (err) {
        logError("[encashment-auto-draft] member notice failed (draft stands):", err);
      }
    } catch (err) {
      report.failures += 1;
      const reason = err instanceof Error ? err.message : String(err);
      report.failuresDetail.push({
        userId: d.userId,
        leaveTypeId: d.leaveTypeId,
        leaveTypeName: d.leaveTypeName,
        reason,
      });
      logError(
        `[encashment-auto-draft] draft failed (user ${d.userId}, type ${d.leaveTypeName}):`,
        err,
      );
    }
  }

  logInfo("[encashment-auto-draft] pass complete", {
    metric: "encashment_auto_draft_pass",
    asOf,
    pairs: report.pairsConsidered,
    drafts: report.draftsWritten,
    failures: report.failures,
  });
  return report;
}

// ---------------------------------------------------------------------------
// P31 — the failure alarm (the LV-B18 discipline riding the new job: the
// same contract sendLeaveJobFailureAlarm ships for the allocation pass —
// one LEAVE_JOB_FAILURE outbox row per ADMIN+HR user carries every per-pair
// reason, delivered best-effort; the row IS the retained failure record).
// Never throws into the caller.
// ---------------------------------------------------------------------------

export async function sendEncashmentAutoDraftFailureAlarm(
  report: EncashmentAutoDraftJobReport,
): Promise<void> {
  const recipients = await db.user.findMany({
    where: { role: { in: ["ADMIN", "HR"] }, deletedAt: null, NOT: { email: "" } },
    select: { email: true },
    take: 50, // a workspace with >50 admins+HR is a config smell; bounds the fan-out
  });
  const text = encashmentDraftFailureEmailText(report.asOf, report.failuresDetail);
  const rowIds: string[] = [];
  for (const r of recipients) {
    const row = await queueOutboxMail(db, {
      kind: "LEAVE_JOB_FAILURE",
      toAddress: r.email,
      subject: encashmentDraftFailureEmailSubject(),
      text,
      sentById: "cron:leave-encashment",
    });
    rowIds.push(row.id);
  }
  for (const id of rowIds) {
    const row = await db.mailOutbox.findUnique({
      where: { id },
      select: { toAddress: true, subject: true, body: true },
    });
    if (!row) continue;
    await deliverOutboxMail(id, {
      toAddress: row.toAddress,
      subject: row.subject,
      html: leaveEmailHtml(row.body),
      text: row.body,
    }).catch((err: unknown) => logError("[encashment-auto-draft] alarm delivery failed:", err));
  }
}
