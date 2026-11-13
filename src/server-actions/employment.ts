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
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { parseOrThrow, employmentTransitionSchema, employmentChangeSchema } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import type { OfferComponent } from "@/lib/offer-math";
import { assertNoCycle } from "@/lib/auth/hierarchy";
import { logError } from "@/lib/infra/observability";
import { DEPARTMENT_LABELS } from "@/lib/config";
import {
  EMPLOYMENT_STATUS_LABELS,
  PROBATION_DEFAULT_MONTHS,
  PROBATION_REVIEW_SATISFIED_STATUSES,
  canTransition,
  defaultProbationEndsAt,
} from "@/lib/hr/employment";
import {
  planEmploymentChange,
  raiseStructure,
  annualGrossOf,
  formatAnnualGross,
  EMPLOYMENT_PROPERTY_LABELS,
  type EmploymentChangeKind,
} from "@/lib/hr/employment-change";
import type { EmploymentStatus, EmploymentPropertyHistoryT } from "@/lib/types";

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

// ---------------------------------------------------------------------------
// P33 (EM-06/EM-01, F2.5-lite) — the promotion/transfer writer
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 F2.5).
//
// applyEmploymentChange is the ONLY writer of EmployeePropertyHistory —
// ONE transaction records the whole change:
//
//   1. RBAC: hr:admin (the HR-console audience — the change is employment
//      state, so the structure revision inside this transaction rides THIS
//      gate, not payroll:manage: one change, one transaction, one audit).
//   2. The pure diff (lib/hr/employment-change.ts planEmploymentChange): one
//      structured row per property whose display value actually changes
//      (jobTitle / department / grade / manager / salary); an empty diff is
//      refused — a change that changes nothing is not recorded as history
//      noise.
//   3. EXITED finality: the offboarding gate (createLeaveRequest's own
//      refusal) — an exited employee's employment facts are settled by
//      the full-and-final, never re-opened by a promotion.
//   4. A manager change routes through the ONE cycle guard the user
//      creation/edit path uses (assertNoCycle) — the org chart never loops.
//   5. A salary raise revises the structure on the change's effective
//      date through the SAME retire-and-replace discipline
//      saveSalaryStructure owns (one ACTIVE structure at a time, history
//      preserved, the P16 one-per-day guard), INSIDE this transaction —
//      the raise is FIXED-earnings-scaled (percent lines ride the grown
//      basis at resolve time; deductions untouched).
//   6. QA-1: the diff is re-planned INSIDE the transaction against the row
//      state the transaction itself reads (a concurrent profile edit or
//      structure revision between the pre-read and the write refuses the
//      change rather than recording a diff that no longer matches).
//   7. The employee gets one in-app notification (the F-R17 zero-mail
//      discipline: no email) — best-effort, never fatal.
//   8. Audited (hr.employment_change_applied) with the whole diff in the
//      detail line; the structured rows are the machine-readable copy.
// ---------------------------------------------------------------------------

/** Department key → roster label (the card's own resolution — QA-19: a raw
 * unknown key renders raw, never silently blank). */
function departmentLabelOf(key: string): string {
  if (!key) return "— Not set —";
  return DEPARTMENT_LABELS.find((d) => d.key === key)?.label ?? key;
}

export async function applyEmploymentChange(
  userId: string,
  input: {
    kind: EmploymentChangeKind;
    effectiveDate: string;
    jobTitle?: string;
    department?: string;
    /** P34 (EM-03) — the grade grouping axis (free-form ladder string). */
    grade?: string;
    managerId?: string | null;
    raisePercent?: number;
    note?: string;
  },
): Promise<ActionResult<{ applied: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(employmentChangeSchema, input);
    const targetUserId = String(userId ?? "").trim();
    if (!targetUserId) throw new AuthorizationError("A user id is required.");

    const target = await db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, deletedAt: true, managerId: true },
    });
    if (!target || target.deletedAt) throw new AuthorizationError("User not found.");

    const row = await db.employeeProfile.findUnique({ where: { userId: targetUserId } });
    // EXITED finality — the same gate createLeaveRequest applies: employment
    // facts of an exited employee are settled by the full-and-final.
    if ((row?.employmentStatus ?? "") === "EXITED") {
      throw new AuthorizationError(
        `${target.name} has exited — employment changes are settled by the full-and-final, never re-opened.`,
      );
    }

    // ---------------------------------------------------- the current values
    const currentTitle = row?.jobTitle ?? "";
    const currentDepartment = row?.department ?? "";
    // P34 (EM-03) — the grade axis rides the diff like jobTitle (a
    // free-form display string; "" renders "—" in both diff cells).
    const currentGrade = row?.grade ?? "";
    // The manager display name (null = no manager — "(none)" keeps the row
    // honest without fabricating a name).
    let currentManagerName: string | null = null;
    if (target.managerId) {
      const mgr = await db.user.findUnique({
        where: { id: target.managerId },
        select: { name: true, deletedAt: true },
      });
      currentManagerName = mgr && !mgr.deletedAt ? mgr.name : null;
    }
    // The active structure (a raise reads it; no structure = no raise).
    const activeStructure = await db.salaryStructure.findFirst({
      where: { userId: targetUserId, isActive: true },
      orderBy: { effectiveFrom: "desc" },
      select: { id: true, components: true, notes: true, frequency: true, maxBenefits: true, openingYtd: true },
    });
    const currentComponents: OfferComponent[] = activeStructure
      ? safeParseComponents(activeStructure.components)
      : [];
    const currentGross = currentComponents.length ? annualGrossOf(currentComponents) : null;

    // --------------------------------------------------- validation on input
    if (data.department !== undefined && data.department !== "") {
      if (!DEPARTMENT_LABELS.some((d) => d.key === data.department)) {
        throw new AuthorizationError("Unknown department.");
      }
    }
    let newManagerName: string | null = null;
    if (data.managerId !== undefined) {
      if (data.managerId === null || data.managerId === "") {
        newManagerName = null; // explicit clear
      } else {
        if (data.managerId === targetUserId) {
          throw new AuthorizationError("A member cannot report to themselves.");
        }
        const mgr = await db.user.findUnique({
          where: { id: data.managerId },
          select: { id: true, name: true, deletedAt: true },
        });
        if (!mgr || mgr.deletedAt) throw new AuthorizationError("Manager not found — pick a current member.");
        newManagerName = mgr.name;
        // The ONE cycle guard the user edit path uses (one rule, both callers).
        await assertNoCycle(targetUserId, data.managerId);
      }
    }
    let revisedComponents: OfferComponent[] | null = null;
    if (data.raisePercent !== undefined) {
      if (!activeStructure) {
        throw new AuthorizationError(
          `${target.name} has no active salary structure to raise — compose one from the Payroll tab first.`,
        );
      }
      const raised = raiseStructure(currentComponents, data.raisePercent);
      if (!raised.raisedAny) {
        throw new AuthorizationError(
          `${target.name}'s structure has no fixed earning to raise (every earnings line is percent-based) — revise the structure directly instead.`,
        );
      }
      revisedComponents = raised.components;
    }

    // --------------------------------------------------------- the diff plan
    const requested: Partial<Record<"jobTitle" | "department" | "grade" | "manager" | "salary", string>> = {};
    const current: Partial<Record<"jobTitle" | "department" | "grade" | "manager" | "salary", string>> = {
      jobTitle: currentTitle,
      department: departmentLabelOf(currentDepartment),
      grade: currentGrade || "—",
      manager: currentManagerName ?? "(none)",
      ...(currentGross != null ? { salary: formatAnnualGross(currentGross) } : {}),
    };
    if (data.jobTitle !== undefined) {
      requested.jobTitle = data.jobTitle || "—";
    }
    if (data.department !== undefined) {
      requested.department = departmentLabelOf(data.department);
    }
    if (data.grade !== undefined) {
      requested.grade = data.grade || "—";
    }
    if (data.managerId !== undefined) {
      requested.manager = newManagerName ?? "(none)";
    }
    if (revisedComponents) {
      requested.salary = formatAnnualGross(annualGrossOf(revisedComponents));
    }

    const rows = planEmploymentChange({ current, requested });
    if (rows.length === 0) {
      throw new AuthorizationError(
        "Nothing to record — pick at least one property to change (title, department, grade, manager or salary).",
      );
    }

    const effectiveAt = new Date(`${data.effectiveDate}T00:00:00.000Z`);
    const effectiveDay = data.effectiveDate;

    // ------------------------------------------------ ONE transaction (F-R1)
    await db.$transaction(async (tx) => {
      // QA-1 — re-read the row inside the transaction: a concurrent EXIT
      // (or a concurrent structure revision when raising) between the
      // pre-read and this write refuses the change instead of recording a
      // diff that no longer matches the world.
      const freshProfile = await tx.employeeProfile.findUnique({ where: { userId: targetUserId } });
      if ((freshProfile?.employmentStatus ?? "") === "EXITED") {
        throw new AuthorizationError(
          `${target.name} has exited — the change was refused by the re-validation inside the transaction.`,
        );
      }

      // The profile facts (jobTitle / department / grade) — upsert keeps the
      // profile-less member legal (neutral defaults like the transition).
      if (data.jobTitle !== undefined || data.department !== undefined || data.grade !== undefined) {
        await tx.employeeProfile.upsert({
          where: { userId: targetUserId },
          create: {
            userId: targetUserId,
            jobTitle: data.jobTitle ?? currentTitle,
            department: data.department ?? currentDepartment,
            grade: data.grade ?? currentGrade,
            hireDate: null,
            employmentStatus: "",
          },
          update: {
            ...(data.jobTitle !== undefined ? { jobTitle: data.jobTitle } : {}),
            ...(data.department !== undefined ? { department: data.department } : {}),
            ...(data.grade !== undefined ? { grade: data.grade } : {}),
          },
        });
      }

      // The reporting line (org chart).
      if (data.managerId !== undefined) {
        await tx.user.update({
          where: { id: targetUserId },
          data: { managerId: data.managerId === "" ? null : data.managerId },
        });
      }

      // The salary revision — the SAME retire-and-replace discipline
      // saveSalaryStructure owns, INSIDE this transaction: one ACTIVE
      // structure per employee (the hand-off is atomic), history
      // preserved with effectiveFrom, the P16 one-per-effective-day guard
      // (a second change on the same day must move the date forward).
      if (revisedComponents && activeStructure) {
        const sameDay = await tx.salaryStructure.findFirst({
          where: {
            userId: targetUserId,
            effectiveFrom: { gte: effectiveAt, lt: new Date(`${effectiveDay}T23:59:59.999Z`) },
          },
          select: { id: true },
        });
        if (sameDay && sameDay.id !== activeStructure.id) {
          throw new AuthorizationError(
            `${target.name} already has a structure effective ${effectiveDay} — pick another effective date.`,
          );
        }
        await tx.salaryStructure.updateMany({
          where: { userId: targetUserId, isActive: true },
          data: { isActive: false },
        });
        await tx.salaryStructure.create({
          data: {
            userId: targetUserId,
            components: JSON.stringify(revisedComponents),
            // The revision is provenance-linked: whose change, why.
            notes: `${data.kind === "PROMOTION" ? "Promotion" : "Transfer"} revision (${data.raisePercent}%)${data.note ? ` — ${data.note}` : ""}`.slice(0, 500),
            effectiveFrom: effectiveAt,
            isActive: true,
            createdById: auth.userId,
            // The structure's own knobs ride the revision unchanged.
            frequency: activeStructure.frequency,
            maxBenefits: activeStructure.maxBenefits,
            ...(activeStructure.openingYtd !== undefined && activeStructure.openingYtd !== null
              ? { openingYtd: activeStructure.openingYtd as object }
              : {}),
          },
        });
      }

      // The structured property-history rows — one per changed property.
      await tx.employeePropertyHistory.createMany({
        data: rows.map((r) => ({
          userId: targetUserId,
          property: r.property,
          currentValue: r.currentValue,
          newValue: r.newValue,
          effectiveAt,
          sourceKind: data.kind,
          createdById: auth.userId,
        })),
      });

      // The employee's in-app notice — best-effort, never fatal (the
      // F2.1 exit-interview / P31 draft-notice pattern).
      try {
        const diffSummary = rows
          .map((r) => `${EMPLOYMENT_PROPERTY_LABELS[r.property]} ${r.currentValue} → ${r.newValue}`)
          .join("; ")
          .slice(0, 400);
        await tx.notification.create({
          data: {
            recipientUserId: targetUserId,
            type: data.kind === "PROMOTION" ? "SUCCESS" : "INFO",
            title: data.kind === "PROMOTION" ? "Promotion applied" : "Transfer applied",
            message: `Effective ${effectiveDay}: ${diffSummary}.${data.note ? ` Note: ${data.note}` : ""}`.slice(0, 500),
          },
        });
      } catch (err) {
        logError("[employment-change] notification create failed:", err);
      }
    });

    // The audit line carries the whole diff (the structured rows are the
    // machine-readable copy; this is the human-readable one).
    const diffLine = rows
      .map((r) => `${EMPLOYMENT_PROPERTY_LABELS[r.property]} ${r.currentValue} → ${r.newValue}`)
      .join("; ")
      .slice(0, 700);
    await logAudit({
      actor: auth,
      action: "hr.employment_change_applied",
      entityType: "EMPLOYEE_PROFILE",
      entityId: targetUserId,
      entityLabel: target.name,
      detail:
        `${auth.name} applied a ${data.kind === "PROMOTION" ? "promotion" : "transfer"} to ${target.name} ` +
        `effective ${effectiveDay}${rows.length > 0 ? ` — ${diffLine}` : ""}` +
        `${data.note ? ` (note: ${data.note})` : ""}.`,
    });
    revalidatePath("/");
    return { applied: rows.length };
  });
}

/** Parse the structure's stored component JSON defensively (a malformed
 * row records as an empty structure — the raise path then refuses on the
 * no-structure rule instead of crashing on bad data). */
function safeParseComponents(json: string): OfferComponent[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as OfferComponent[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// P33 (EM-06) — the structured property-history reader (hr:view — the
// directory's own gate: the panel rides the profile modal the same
// audience opens). Newest change first, capped like every list read.
// ---------------------------------------------------------------------------

export async function getEmploymentHistory(
  userId: string,
): Promise<ActionResult<EmploymentPropertyHistoryT[]>> {
  return toResult(async () => {
    await requirePermission("hr:view");
    const targetUserId = String(userId ?? "").trim();
    if (!targetUserId) throw new AuthorizationError("A user id is required.");
    const target = await db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw new AuthorizationError("User not found.");

    const rows = await db.employeePropertyHistory.findMany({
      where: { userId: targetUserId },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
    return rows.map(
      (r): EmploymentPropertyHistoryT => ({
        id: r.id,
        userId: r.userId,
        property: r.property,
        currentValue: r.currentValue,
        newValue: r.newValue,
        effectiveAt: r.effectiveAt.toISOString().slice(0, 10),
        sourceKind: r.sourceKind,
        createdAt: r.createdAt.toISOString(),
      }),
    );
  });
}
