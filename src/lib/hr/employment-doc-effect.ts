// ---------------------------------------------------------------------------
// P1 G6 — the EFFECTIVE core + the daily due sweep.
//
// effectEmploymentDocument is the ONE writer that moves a Transfer /
// Promotion document to EFFECTIVE and applies its facts. Both callers ride
// it with the same rules:
//
//   • the manual admin trigger (server-actions/hr-employment-docs.ts —
//     hr:admin-gated, on/after the effective date), and
//   • the daily dispatcher's sweep (/api/cron/daily → the
//     employment-documents job — due = APPROVED with effectiveDate ≤ today).
//
// ONE transaction per document (the F-R1 discipline):
//   1. QA-1 re-validation inside the transaction: the employee must not be
//      EXITED (the full-and-final settles an exited employee's facts) and
//      the transfer's target manager must still be a current member.
//   2. The conflict rule (spec §3): no other EFFECTIVE transfer OR promotion
//      may exist for the same employee on the same effective date.
//   3. The guarded flip (QA-16): updateMany WHERE status = "APPROVED" — a
//      zero count means a concurrent effect/cancel won the race; abort
//      BEFORE any fact write.
//   4. The property diff is planned against the LIVE facts inside the
//      transaction (the from-snapshot on the document records the intent at
//      DRAFT time; the property history records what ACTUALLY changed in
//      the world — if the profile was edited meanwhile, fewer rows land,
//      honestly).
//   5. The profile facts (department / jobTitle / grade / location) and the
//      reporting line (User.managerId) are written, the structured
//      EmployeePropertyHistory rows land (the P33 kernel's planner — one
//      row per changed property), and the employee gets one best-effort
//      in-app notice.
//   6. The audit entry (hr.transfer_effective / hr.promotion_effective)
//      carries the whole diff; the structured rows are the machine copy.
//
// A promotion's linkedSalaryAssignmentId is deliberately NEVER acted on
// (spec §3: the salary revision is its own Phase 1B document) — the
// promotion and a same-date salary assignment coexist without interaction.
//
// The sweep (runDueEmploymentDocumentsJob) follows the encashment-auto-draft
// posture: per-document isolation (one bad document logs, counts and moves
// on), idempotency = the status flip itself (a re-run finds EFFECTIVE rows
// and plans nothing), and a counters-only report (never employee data).
// ---------------------------------------------------------------------------

import { Prisma } from "@prisma/client";
import { db } from "@/lib/infra/db";
import { logError } from "@/lib/infra/observability";
import { logAudit } from "@/lib/audit/audit";
import { AuthorizationError } from "@/lib/auth/authorization-error";
import { assertNoCycle } from "@/lib/auth/hierarchy";
import { DEPARTMENT_LABELS } from "@/lib/shared/config";
import {
  planEmploymentChange,
  EMPLOYMENT_PROPERTY_LABELS,
  type PropertyDiffRow,
  type EmploymentProperty,
} from "@/lib/hr/employment-change";
import {
  isEffectiveDayReached,
  utcDayKeyOf,
  dayKeyToDate,
  isEmploymentDocKind,
  type EmploymentDocKind,
} from "@/lib/hr/employment-documents";

/** The transaction client (structurally satisfied by the plain client too,
 * so the helpers accept either). */
type TxClient = Prisma.TransactionClient;

/** The actor shape logAudit takes (duplicated from AuditEntry so this lib
 * module never imports the action layer). */
export interface EffectActor {
  userId: string;
  name: string;
  role: string;
}

/** The cron identity (the encashment job's createdById convention). */
export const CRON_ACTOR: EffectActor = {
  userId: "cron:employment-documents",
  name: "Daily effective-date pass",
  role: "SYSTEM",
};

/** Department key → roster label (QA-19: an unknown key renders raw, never
 * silently blank — the same resolution the P33 writer uses). */
function departmentLabelOf(key: string | null | undefined): string {
  if (!key) return "— Not set —";
  return DEPARTMENT_LABELS.find((d) => d.key === key)?.label ?? key;
}

/** The live employment facts the diff is planned against. */
interface LiveFacts {
  jobTitle: string;
  department: string;
  grade: string;
  location: string;
  managerId: string | null;
  managerName: string | null;
}

async function readLiveFacts(
  client: TxClient,
  userId: string,
): Promise<{ facts: LiveFacts; exited: boolean }> {
  const [profile, user] = await Promise.all([
    client.employeeProfile.findUnique({ where: { userId } }),
    client.user.findUnique({
      where: { id: userId },
      select: { managerId: true, deletedAt: true },
    }),
  ]);
  let managerName: string | null = null;
  if (user?.managerId) {
    const mgr = await client.user.findUnique({
      where: { id: user.managerId },
      select: { name: true, deletedAt: true },
    });
    managerName = mgr && !mgr.deletedAt ? mgr.name : null;
  }
  return {
    facts: {
      jobTitle: profile?.jobTitle ?? "",
      department: profile?.department ?? "",
      grade: profile?.grade ?? "",
      location: profile?.location ?? "",
      managerId: user?.managerId ?? null,
      managerName,
    },
    exited: (profile?.employmentStatus ?? "") === "EXITED",
  };
}

/** The same-day window an effectiveDate lands in (UTC midnight → end of
 * day — the conflict query's bounds). */
function dayWindow(dayKey_: string): { gte: Date; lt: Date } {
  const start = dayKeyToDate(dayKey_);
  return { gte: start, lt: new Date(start.getTime() + 24 * 60 * 60 * 1_000) };
}

/** Resolve a manager target at effect time — must still exist and be a
 * current member (a document naming a since-deleted manager is refused,
 * not silently re-pointed), and must not create a reporting cycle. ""
 * (and null) mean "clear the line" — no lookup. Returns the display name. */
async function resolveManagerTarget(
  client: TxClient,
  userId: string,
  managerId: string | null,
): Promise<string | null> {
  if (!managerId) return null; // null (absent — never reaches here) or "" (clear)
  const mgr = await client.user.findUnique({
    where: { id: managerId },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!mgr || mgr.deletedAt) {
    throw new AuthorizationError(
      "The transfer's target manager is no longer an active member — cancel this document and record a new one.",
    );
  }
  await assertNoCycle(userId, managerId);
  return mgr.name;
}

/** Render the diff rows as the audit/notification summary line. */
function diffLineOf(rows: PropertyDiffRow[]): string {
  if (rows.length === 0) return "no net change — the facts were already in place";
  return rows
    .map((r) => `${EMPLOYMENT_PROPERTY_LABELS[r.property]} ${r.currentValue} → ${r.newValue}`)
    .join("; ")
    .slice(0, 600);
}

/**
 * Move one APPROVED document to EFFECTIVE and apply its facts. Throws
 * AuthorizationError-shaped errors on refusal; returns the applied property
 * rows for the audit line.
 */
export async function effectEmploymentDocument(input: {
  kind: EmploymentDocKind | string;
  id: string;
  actor: EffectActor;
  /** The manual trigger re-checks the date (the sweep pre-filters by it);
   * both paths enforce the same rule through this flag. */
  requireDateReached: boolean;
  todayKey?: string;
}): Promise<{ applied: number }> {
  if (!isEmploymentDocKind(input.kind)) {
    throw new AuthorizationError("Unknown document kind.");
  }
  const kind = input.kind;
  const todayKey = input.todayKey ?? utcDayKeyOf(new Date());

  const doc =
    kind === "TRANSFER"
      ? await db.employeeTransfer.findUnique({ where: { id: input.id } })
      : await db.employeePromotion.findUnique({ where: { id: input.id } });
  if (!doc) throw new AuthorizationError("Document not found.");
  if (doc.status !== "APPROVED") {
    throw new AuthorizationError(
      `Only an approved document can be made effective — this one is ${doc.status
        .toLowerCase()
        .replace("_", " ")}.`,
    );
  }
  const effectiveDay = utcDayKeyOf(doc.effectiveDate);
  if (input.requireDateReached && !isEffectiveDayReached(effectiveDay, todayKey)) {
    throw new AuthorizationError(
      `The effective date is ${effectiveDay} — a document can only be made effective on or after that date.`,
    );
  }

  const employee = await db.user.findUnique({
    where: { id: doc.employeeId },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!employee || employee.deletedAt) throw new AuthorizationError("Employee not found.");

  const rows = await db.$transaction(
    async (tx): Promise<PropertyDiffRow[]> => {
      // QA-1 — re-read the live facts INSIDE the transaction. An EXIT since
      // approval (or a profile edit) refuses or re-scopes the application
      // instead of recording a diff that no longer matches the world.
      const { facts, exited } = await readLiveFacts(tx, employee.id);
      if (exited) {
        throw new AuthorizationError(
          `${employee.name} has exited — employment changes are settled by the full-and-final, never re-opened.`,
        );
      }

      // The conflict rule (spec §3): one EFFECTIVE transfer OR promotion per
      // employee per effective date — whichever trigger fires first wins;
      // the second is refused with the honest reason.
      const window = dayWindow(effectiveDay);
      const clashTransfer = await tx.employeeTransfer.findFirst({
        where: {
          employeeId: employee.id,
          status: "EFFECTIVE",
          effectiveDate: { gte: window.gte, lt: window.lt },
          ...(kind === "TRANSFER" ? { id: { not: doc.id } } : {}),
        },
        select: { id: true },
      });
      const clashPromotion = await tx.employeePromotion.findFirst({
        where: {
          employeeId: employee.id,
          status: "EFFECTIVE",
          effectiveDate: { gte: window.gte, lt: window.lt },
          ...(kind === "PROMOTION" ? { id: { not: doc.id } } : {}),
        },
        select: { id: true },
      });
      if (clashTransfer || clashPromotion) {
        throw new AuthorizationError(
          `${employee.name} already has an effective transfer or promotion on ${effectiveDay} — a second document for the same date is refused.`,
        );
      }

      // The requested end state, resolved against the live world. The
      // manager axis encoding: stored null = untouched, "" = clear the
      // line, an id = set it (the create action's storeManagerId contract).
      let toManagerName: string | null = null;
      if (kind === "TRANSFER") {
        const t = doc as { toManagerId: string | null };
        if (t.toManagerId !== null) {
          toManagerName = await resolveManagerTarget(tx, employee.id, t.toManagerId);
        }
      }

      // The guarded flip (QA-16): the status moves only if it is still
      // APPROVED — a concurrent effect or cancel winning the race aborts
      // BEFORE any fact write.
      const flipped =
        kind === "TRANSFER"
          ? await tx.employeeTransfer.updateMany({
              where: { id: doc.id, status: "APPROVED" },
              data: { status: "EFFECTIVE" },
            })
          : await tx.employeePromotion.updateMany({
              where: { id: doc.id, status: "APPROVED" },
              data: { status: "EFFECTIVE" },
            });
      if (flipped.count === 0) {
        throw new AuthorizationError(
          "This document is no longer approved — it was just effected or cancelled elsewhere. Refresh and try again.",
        );
      }

      // The diff against the LIVE facts (the P33 planner — one row per
      // property whose display value actually changes).
      const current: Partial<Record<EmploymentProperty, string>> = {
        jobTitle: facts.jobTitle || "—",
        department: departmentLabelOf(facts.department),
        grade: facts.grade || "—",
        manager: facts.managerName ?? "(none)",
        location: facts.location || "—",
      };
      const requested: Partial<Record<EmploymentProperty, string>> = {};
      const effectiveAt = dayKeyToDate(effectiveDay);

      if (kind === "TRANSFER") {
        // Storage encoding: null = the axis is not part of this transfer
        // (Prisma never returns undefined for a loaded row); "" on the
        // manager axis = an explicit clear of the reporting line.
        const t = doc as {
          toDepartment: string | null;
          toJobTitle: string | null;
          toManagerId: string | null;
          toLocation: string | null;
        };
        if (t.toDepartment !== null) requested.department = departmentLabelOf(t.toDepartment);
        if (t.toJobTitle !== null) requested.jobTitle = t.toJobTitle || "—";
        if (t.toManagerId !== null) requested.manager = toManagerName ?? "(none)";
        if (t.toLocation !== null) requested.location = t.toLocation || "—";

        // The profile facts (upsert keeps the profile-less member legal —
        // the P33 writer's own discipline).
        if (t.toDepartment !== null || t.toJobTitle !== null || t.toLocation !== null) {
          await tx.employeeProfile.upsert({
            where: { userId: employee.id },
            create: {
              userId: employee.id,
              jobTitle: t.toJobTitle ?? facts.jobTitle,
              department: t.toDepartment ?? facts.department,
              location: t.toLocation ?? facts.location,
              hireDate: null,
              employmentStatus: "",
            },
            update: {
              ...(t.toJobTitle !== null ? { jobTitle: t.toJobTitle } : {}),
              ...(t.toDepartment !== null ? { department: t.toDepartment } : {}),
              ...(t.toLocation !== null ? { location: t.toLocation } : {}),
            },
          });
        }
        // The reporting line (org chart) — "" = clear, an id = set.
        if (t.toManagerId !== null) {
          await tx.user.update({
            where: { id: employee.id },
            data: { managerId: t.toManagerId || null },
          });
        }
      } else {
        const p = doc as { toJobTitle: string; toGrade: string | null };
        requested.jobTitle = p.toJobTitle || "—";
        if (p.toGrade !== null) requested.grade = p.toGrade || "—";

        await tx.employeeProfile.upsert({
          where: { userId: employee.id },
          create: {
            userId: employee.id,
            jobTitle: p.toJobTitle,
            grade: p.toGrade ?? facts.grade,
            hireDate: null,
            employmentStatus: "",
          },
          update: {
            jobTitle: p.toJobTitle,
            ...(p.toGrade !== null ? { grade: p.toGrade } : {}),
          },
        });
        // NOTE (spec §3): linkedSalaryAssignmentId is NEVER acted on — the
        // salary revision is a separate Phase 1B document; the link is
        // provenance, not a trigger.
      }

      const rows = planEmploymentChange({ current, requested });

      // The structured property-history rows — one per changed property.
      if (rows.length > 0) {
        await tx.employeePropertyHistory.createMany({
          data: rows.map((r) => ({
            userId: employee.id,
            property: r.property,
            currentValue: r.currentValue,
            newValue: r.newValue,
            effectiveAt,
            sourceKind: kind,
            createdById: input.actor.userId,
          })),
        });
      }

      // The employee's in-app notice — best-effort, never fatal (the P33
      // writer's own pattern).
      try {
        await tx.notification.create({
          data: {
            recipientUserId: employee.id,
            type: kind === "PROMOTION" ? "SUCCESS" : "INFO",
            title: kind === "PROMOTION" ? "Promotion effective" : "Transfer effective",
            message: `Effective ${effectiveDay}: ${diffLineOf(rows)}.`.slice(0, 500),
          },
        });
      } catch (err) {
        logError("[employment-doc-effect] notification create failed:", err);
      }

      return rows;
    },
  );

  // The audit line carries the whole diff (the human-readable copy; the
  // structured rows above are the machine-readable one). Written AFTER the
  // committed transaction — the logAudit best-effort discipline.
  await logAudit({
    actor: input.actor,
    action: kind === "TRANSFER" ? "hr.transfer_effective" : "hr.promotion_effective",
    entityType: kind === "TRANSFER" ? "EMPLOYEE_TRANSFER" : "EMPLOYEE_PROMOTION",
    entityId: doc.id,
    entityLabel: employee.name,
    detail:
      `${input.actor.name} made ${employee.name}'s ${kind === "TRANSFER" ? "transfer" : "promotion"} ` +
      `effective (${effectiveDay}) — ${diffLineOf(rows)}.`,
  });

  return { applied: rows.length };
}

// ---------------------------------------------------------------------------
// The daily sweep — due = APPROVED with effectiveDate ≤ today (UTC).
// ---------------------------------------------------------------------------

export interface EmploymentDocsSweepReport {
  considered: number;
  effected: number;
  failed: number;
  failuresDetail: string[];
}

export async function runDueEmploymentDocumentsJob(
  todayKey?: string,
): Promise<EmploymentDocsSweepReport> {
  const today = todayKey ?? utcDayKeyOf(new Date());
  const endOfToday = new Date(dayKeyToDate(today).getTime() + 24 * 60 * 60 * 1_000 - 1);

  const [dueTransfers, duePromotions] = await Promise.all([
    db.employeeTransfer.findMany({
      where: { status: "APPROVED", effectiveDate: { lte: endOfToday } },
      select: { id: true },
      orderBy: { effectiveDate: "asc" },
    }),
    db.employeePromotion.findMany({
      where: { status: "APPROVED", effectiveDate: { lte: endOfToday } },
      select: { id: true },
      orderBy: { effectiveDate: "asc" },
    }),
  ]);

  const report: EmploymentDocsSweepReport = {
    considered: dueTransfers.length + duePromotions.length,
    effected: 0,
    failed: 0,
    failuresDetail: [],
  };

  // Effective-date order within each kind so a same-employee sequence
  // applies oldest first; the conflict rule still guards same-date pairs.
  for (const kind of ["TRANSFER", "PROMOTION"] as const) {
    const docs = kind === "TRANSFER" ? dueTransfers : duePromotions;
    for (const doc of docs) {
      try {
        await effectEmploymentDocument({
          kind,
          id: doc.id,
          actor: CRON_ACTOR,
          requireDateReached: true,
          todayKey: today,
        });
        report.effected += 1;
      } catch (err) {
        // Per-document isolation: one bad document logs, counts and moves
        // on (the encashment posture). Conflicts and races are EXPECTED
        // outcomes, not job-crashers — they count in `failed` with the
        // reason for the log.
        report.failed += 1;
        const reason = err instanceof Error ? err.message : String(err);
        report.failuresDetail.push(`${kind}:${doc.id}: ${reason}`.slice(0, 300));
        logError(`[employment-documents] sweep could not effect ${kind} ${doc.id}:`, err);
      }
    }
  }

  return report;
}
