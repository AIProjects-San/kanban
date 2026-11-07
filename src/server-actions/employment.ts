"use server";

// ---------------------------------------------------------------------------
// F1.6 — employment lifecycle server action
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1, decision §9.3).
//
// transitionEmployment is the ONLY writer of EmployeeProfile.employmentStatus.
// The plain profile-edit path (updateProfileAsAdmin) cannot touch it — its
// strict schema rejects the key — so every status change lands here:
//
//   1. RBAC: hr:admin (ADMIN + HR, the HR-console audience).
//   2. The transition graph (lib/employment.ts): "" → PROBATION/ACTIVE/EXITED,
//      PROBATION → ACTIVE/EXITED, ACTIVE → SUSPENDED/EXITED,
//      SUSPENDED → ACTIVE/EXITED, EXITED terminal. Illegal moves get a
//      friendly error naming both statuses; a no-op (same status) is refused.
//   3. §9.3 HARD GATE: PROBATION → ACTIVE is rejected unless a PROBATION-kind
//      review has been COMPLETED (REVIEWED or ACKNOWLEDGED). A pending
//      (DRAFT/SUBMITTED) review — or none at all — blocks the confirmation.
//      This is a guarded transition, not a date + reminder label.
//   4. EXITED requires a lastWorkingDay (from this call or already on the
//      profile) — Phase F2.1's full-and-final relies on it.
//   5. hireDate feeds probation defaults: entering PROBATION without an
//      explicit end date and without one already stored sets
//      probationEndsAt = hireDate + PROBATION_DEFAULT_MONTHS (3).
//   6. Every change is audited (hr.employment_transitioned, from → to).
//
// The three plain facts (probationEndsAt / noticePeriodWeeks /
// lastWorkingDay) remain editable through updateProfileAsAdmin; this action
// also carries them on the transition call so the modal saves in one flow.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { parseOrThrow, employmentTransitionSchema } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import {
  EMPLOYMENT_STATUS_LABELS,
  PROBATION_DEFAULT_MONTHS,
  PROBATION_REVIEW_SATISFIED_STATUSES,
  canTransition,
  defaultProbationEndsAt,
} from "@/lib/employment";
import type { EmploymentStatus } from "@/lib/types";

function label(status: EmploymentStatus): string {
  return EMPLOYMENT_STATUS_LABELS[status] || status;
}

export async function transitionEmployment(
  userId: string,
  input: {
    target: "PROBATION" | "ACTIVE" | "SUSPENDED" | "EXITED";
    probationEndsAt?: string | null;
    lastWorkingDay?: string | null;
  },
): Promise<ActionResult<{ status: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(employmentTransitionSchema, input);
    const targetUserId = String(userId ?? "").trim();
    if (!targetUserId) throw new AuthorizationError("A user id is required.");

    const target = await db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw new AuthorizationError("User not found.");

    // The profile row may not exist yet (self-created or never touched by
    // HR) — that is the "" (not tracked) starting state, so the upsert below
    // creates it with neutral defaults on the transition itself.
    const row = await db.employeeProfile.findUnique({ where: { userId: targetUserId } });
    const current = (row?.employmentStatus ?? "") as EmploymentStatus;
    const targetStatus = data.target as EmploymentStatus;

    if (current === targetStatus) {
      throw new AuthorizationError(
        `${target.name} is already ${label(targetStatus).toLowerCase() === "not set" ? "not tracked" : label(targetStatus).toLowerCase()}.`,
      );
    }
    if (!canTransition(current, targetStatus)) {
      throw new AuthorizationError(
        current === ""
          ? `${target.name} has no tracked employment status yet — set probation, active or exited first.`
          : `Cannot move ${target.name} from ${label(current)} to ${label(targetStatus)} — that transition is not allowed.`,
      );
    }

    // §9.3 hard gate — probation must be reviewed before confirmation.
    // "Outstanding" means no COMPLETED PROBATION-kind review exists: a
    // DRAFT/SUBMITTED cycle, or none at all, both block. STANDARD cycles
    // never satisfy the gate (the query filters kind: "PROBATION").
    if (current === "PROBATION" && targetStatus === "ACTIVE") {
      const completed = await db.performanceReview.findFirst({
        where: {
          userId: targetUserId,
          kind: "PROBATION",
          status: { in: [...PROBATION_REVIEW_SATISFIED_STATUSES] },
        },
        select: { id: true, title: true },
      });
      if (!completed) {
        throw new AuthorizationError(
          `Probation review outstanding — ${target.name} cannot be confirmed until their probation review is completed (open a probation review cycle from the Reviews tab, then have the manager complete it).`,
        );
      }
    }

    // EXITED requires a last working day — F2.1's full-and-final settlement
    // computes dues from it, so an exit without one is not recordable.
    if (targetStatus === "EXITED") {
      const hasLwd =
        (data.lastWorkingDay !== undefined && data.lastWorkingDay !== null) ||
        (row?.lastWorkingDay ?? null) !== null;
      if (!hasLwd) {
        throw new AuthorizationError("A last working day is required to record an exit.");
      }
    }

    const probationEndsAt =
      data.probationEndsAt !== undefined
        ? data.probationEndsAt
          ? new Date(`${data.probationEndsAt}T00:00:00.000Z`)
          : null // explicit null clears
        : row?.probationEndsAt ?? null;
    const lastWorkingDay =
      data.lastWorkingDay !== undefined
        ? data.lastWorkingDay
          ? new Date(`${data.lastWorkingDay}T00:00:00.000Z`)
          : null
        : row?.lastWorkingDay ?? null;

    // hireDate feeds probation defaults (plan §7.1): entering probation
    // without any end date (in this call or stored) derives it from the
    // hire date so the probation always has a reviewable horizon.
    let defaultedFrom: Date | null = null;
    if (
      targetStatus === "PROBATION" &&
      probationEndsAt === null &&
      row?.hireDate
    ) {
      defaultedFrom = defaultProbationEndsAt(row.hireDate);
    }

    await db.employeeProfile.upsert({
      where: { userId: targetUserId },
      create: {
        userId: targetUserId,
        jobTitle: "",
        department: "",
        hireDate: null,
        employmentStatus: targetStatus,
        ...(defaultedFrom ? { probationEndsAt: defaultedFrom } : {}),
        ...(probationEndsAt && !defaultedFrom ? { probationEndsAt } : {}),
        ...(lastWorkingDay ? { lastWorkingDay } : {}),
      },
      update: {
        employmentStatus: targetStatus,
        ...(defaultedFrom ? { probationEndsAt: defaultedFrom } : {}),
        ...(data.probationEndsAt !== undefined && !defaultedFrom ? { probationEndsAt } : {}),
        ...(data.lastWorkingDay !== undefined ? { lastWorkingDay } : {}),
      },
    });

    const fromLabel = current === "" ? "not tracked" : label(current).toLowerCase();
    await logAudit({
      actor: auth,
      action: "hr.employment_transitioned",
      entityType: "EMPLOYEE_PROFILE",
      entityId: targetUserId,
      entityLabel: target.name,
      detail:
        `${auth.name} set ${target.name}'s employment status ${fromLabel} → ${label(targetStatus).toLowerCase()}` +
        (defaultedFrom
          ? ` (probation ends ${defaultedFrom.toISOString().slice(0, 10)}, defaulting ${PROBATION_DEFAULT_MONTHS} months from hire date).`
          : `.`),
    });
    revalidatePath("/");
    return { status: targetStatus };
  });
}
