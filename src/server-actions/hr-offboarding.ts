"use server";

// ---------------------------------------------------------------------------
// F2.1 — offboarding & full-and-final lite server actions
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 F2.1; benchmark rows
// EM-14/EM-15/EM-16, behaviors EM-B12/B14, notification EM-T01 lite).
//
// The SEPARATION checklist itself is NOT here — it reuses the onboarding
// machinery (createChecklist kind "SEPARATION", addTask, setTaskDone in
// hr-onboarding.ts); this file owns what offboarding ADDS:
//
//   • the overview read — one card per employee in the offboarding orbit
//     (EXITED profiles ∪ separation checklists ∪ live exit interviews ∪
//     FnF rows), each with the LIVE full-and-final computation
//   • the ExitInterview lifecycle (EM-15):
//       PENDING → SCHEDULED → COMPLETED           (terminal)
//       PENDING | SCHEDULED → CANCELLED           (terminal, history kept)
//     one LIVE record per employee (action-enforced); scheduling notifies
//     the employee IN-APP (EM-T01 lite — the HR module's zero-mail
//     discipline, F-R17)
//   • the FullAndFinalStatement lifecycle (EM-16 lite):
//       generate → UNSETTLED (row = generation snapshot; every read still
//                  computes LIVE so HR settles what is true NOW)
//       settle   → SETTLED    (live amounts frozen into the row, audited,
//                  payslip editing for the employee refused from then on —
//                  "settlement locks editing")
//
// RBAC: every action rides hr:admin (ADMIN + HR — the console audience).
// The pure math lives in lib/full-and-final.ts (asOf injected, no I/O).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { logError } from "@/lib/observability";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { parseOrThrow } from "@/lib/validation";
import {
  exitInterviewCreateSchema,
  exitInterviewScheduleSchema,
  exitInterviewCompleteSchema,
  exitInterviewCancelSchema,
  fnfGenerateSchema,
  fnfSettleSchema,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult, isUniqueConstraintError } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseComponents } from "@/lib/offer-math";
import { monthlyEarningsFromStructure, lineSum } from "@/lib/payroll-math";
import { workingDaysInPeriod } from "@/lib/working-days";
import { runWindowEnd, runWindowStart } from "@/lib/payroll-windows";
import { projectLeaveBalance } from "@/lib/leave-ledger";
import {
  computeFullAndFinal,
  parseFnFLines,
  EXIT_INTERVIEW_LIVE_STATUSES,
  EXIT_INTERVIEW_STATUS_LABELS,
  canScheduleExitInterview,
  canCompleteExitInterview,
  canCancelExitInterview,
  type FnFInput,
  type FnFLeaveAccount,
  type FnFOpenRun,
} from "@/lib/full-and-final";
import { getOrCreateBalancesBatch, getHolidayLookup, todayUTC } from "./hr-shared";
import type {
  ExitInterviewT,
  ExitInterviewStatus,
  FnFComputedT,
  FnFStateT,
  OffboardingCaseT,
  OffboardingOverviewT,
  OnboardingChecklistT,
} from "@/lib/types";

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoDateOrNull(value: Date | null): string | null {
  return value ? dayKey(value) : null;
}

// ---------------------------------------------------------------------------
// Live full-and-final computation (service half of the pure kernel)
// ---------------------------------------------------------------------------

/** Monthly gross of the user's ACTIVE structure (null = none). */
async function monthlyGrossFor(userId: string): Promise<number | null> {
  const structure = await db.salaryStructure.findFirst({
    where: { userId, isActive: true },
    orderBy: { effectiveFrom: "desc" },
    select: { components: true },
  });
  if (!structure) return null;
  return lineSum(monthlyEarningsFromStructure(parseComponents(structure.components)));
}

/** The ledger projections for every ACTIVE leave type of one user/year —
 * the truth the encashment/recovery lines read (the batch call first
 * materializes due entitlements so an untouched MANUAL type still shows
 * what the employee is owed, mirroring the Leave view's lazy contract). */
async function leaveAccountsFor(userId: string, year: number): Promise<FnFLeaveAccount[]> {
  const types = await db.leaveType.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    include: { policy: true },
  });
  if (types.length === 0) return [];
  await getOrCreateBalancesBatch(
    userId,
    types.map((t) => ({ id: t.id, policy: t.policy })),
    year,
  );
  const groups = await db.leaveLedgerEntry.groupBy({
    by: ["leaveTypeId", "entryType"],
    where: { userId, year, leaveTypeId: { in: types.map((t) => t.id) } },
    _sum: { delta: true },
  });
  return types.map((t) => {
    const projection = projectLeaveBalance(
      groups
        .filter((g) => g.leaveTypeId === t.id)
        .map((g) => ({ entryType: g.entryType, delta: g._sum.delta ?? 0 })),
    );
    return { leaveTypeId: t.id, name: t.name, paid: t.paid, available: projection.available };
  });
}

/** OPEN runs, each paired with the employee's payslip net (null = none).
 * P8 — a RELEASED withholding slip is excluded (its net pays through the
 * release adjustment); a still-WITHHELD slip stays a payable (a hold is
 * not a waiver — the money is owed until released or settled).
 * P10 — ordered by the run's REAL window start (period keys do not sort
 * chronologically across cadences). */
async function openRunsFor(userId: string): Promise<FnFOpenRun[]> {
  const runs = await db.payrollRun.findMany({
    where: { status: "OPEN" },
    select: {
      period: true,
      startDate: true,
      endDate: true,
      workingDays: true,
      payslips: { where: { userId }, select: { net: true, withholdStatus: true } },
    },
  });
  return runs
    .sort((a, b) =>
      (runWindowStart(a.period, a.startDate)?.getTime() ?? 0) -
      (runWindowStart(b.period, b.startDate)?.getTime() ?? 0))
    .map((r) => ({
      period: r.period,
      payslipNet: r.payslips.length > 0 ? r.payslips[0].net : null,
      withheldReleased: r.payslips.length > 0 ? r.payslips[0].withholdStatus === "RELEASED" : false,
    }));
}

/** P7 (F3.3) — the gratuity rule facts for one exiting employee: config,
 * earnings samples sliced to the averaging window (last-N LOCKED payslip
 * grosses, structure gross as the no-history fallback), and the hire date.
 * Reads happen only when the rule is ON — the disabled path costs one
 * findFirst and nothing else. */
async function gratuityFactsFor(
  userId: string,
  monthlyGross: number | null,
): Promise<FnFInput["gratuity"] & { hireDate: string | null }> {
  const rule = await db.gratuityRule.findFirst();
  if (!rule?.enabled) {
    return {
      enabled: false, averagingMonths: 3, slabs: [], earningsSamples: [],
      earningsBasis: "PAYSLIPS", hireDate: null,
    };
  }
  const [slabs, slipRows, profile] = await Promise.all([
    db.gratuitySlab.findMany({ orderBy: { fromYears: "asc" } }),
    // P10 — last-N by the run's REAL window end: mixed cadences order
    // chronologically only by date (a weekly "2026-W45" would sort after
    // monthly "2026-12" as a string). Fetched wide, JS-sorted with the
    // parsed-key fallback (null-safe, deterministic), sliced to N.
    db.payslip.findMany({
      where: { userId, run: { status: "LOCKED" } },
      select: { gross: true, run: { select: { period: true, endDate: true } } },
    }),
    db.employeeProfile.findUnique({ where: { userId }, select: { hireDate: true } }),
  ]);
  const slips = [...slipRows]
    .sort((a, b) =>
      (runWindowEnd(b.run.period, b.run.endDate)?.getTime() ?? 0) -
      (runWindowEnd(a.run.period, a.run.endDate)?.getTime() ?? 0))
    .slice(0, rule.averagingMonths);
  // Falls back to the active structure's gross when no payslip history
  // exists — the note names whichever basis priced the line.
  const samples = slips.map((s) => s.gross).filter((g) => Number.isFinite(g));
  const earningsBasis: "PAYSLIPS" | "STRUCTURE" =
    samples.length > 0 ? "PAYSLIPS" : monthlyGross !== null ? "STRUCTURE" : "PAYSLIPS";
  return {
    enabled: true,
    averagingMonths: rule.averagingMonths,
    slabs: slabs.map((s) => ({ fromYears: s.fromYears, toYears: s.toYears, fraction: s.fraction })),
    earningsSamples: samples.length > 0 ? samples : monthlyGross !== null ? [monthlyGross] : [],
    earningsBasis,
    hireDate: isoDateOrNull(profile?.hireDate ?? null),
  };
}

/** Holiday-aware working days of the rate-basis period: the run's
 * denormalized count when a run exists (the same denominator its payslips
 * divide LOP by), else the F1.1 calendar computation. */
async function rateWorkingDaysFor(period: string): Promise<number> {
  const run = await db.payrollRun.findUnique({ where: { period }, select: { workingDays: true } });
  if (run && run.workingDays > 0) return run.workingDays;
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return 0;
  const holidays = await getHolidayLookup(
    new Date(Date.UTC(y, m - 1, 1)),
    new Date(Date.UTC(y, m, 0)),
  );
  return workingDaysInPeriod(period, holidays);
}

/** The LIVE statement for one user (pure kernel + the DB facts it reads).
 * Computed for anyone; the UI only surfaces it on the EXITED arc (the
 * F1.6 transition guard guarantees a lastWorkingDay there). */
async function computeFnFForUser(userId: string): Promise<FnFComputedT> {
  const now = todayUTC();
  const year = now.getUTCFullYear();
  const [profile, monthlyGross, openRuns, accounts] = await Promise.all([
    db.employeeProfile.findUnique({
      where: { userId },
      select: { lastWorkingDay: true },
    }),
    monthlyGrossFor(userId),
    openRunsFor(userId),
    leaveAccountsFor(userId, year),
  ]);
  const lastWorkingDay = isoDateOrNull(profile?.lastWorkingDay ?? null);
  const ratePeriod = lastWorkingDay ? lastWorkingDay.slice(0, 7) : "";
  const [rateWorkingDays, gratuity] = await Promise.all([
    ratePeriod ? rateWorkingDaysFor(ratePeriod) : Promise.resolve(0),
    gratuityFactsFor(userId, monthlyGross),
  ]);
  return computeFullAndFinal({
    asOf: dayKey(now),
    lastWorkingDay,
    monthlyGross,
    ratePeriod,
    rateWorkingDays,
    openRuns,
    leaveAccounts: accounts,
    gratuity,
  });
}

/** The row's frozen/snapshot payload parsed back into a FnFComputedT. */
function storedComputed(row: {
  asOf: Date | null; lines: string; payableTotal: number; receivableTotal: number; netPayable: number;
}): FnFComputedT {
  return {
    asOf: row.asOf ? dayKey(row.asOf) : "",
    lines: parseFnFLines(row.lines),
    notes: [], // frozen lines carry no notes (the live read showed them)
    payableTotal: row.payableTotal,
    receivableTotal: row.receivableTotal,
    netPayable: row.netPayable,
    gratuity: null, // the frozen line + totals are the record; the live detail dies with the read
    rateBasis: { period: "", workingDays: 0, monthlyGross: null, dailyRate: 0 },
  };
}

// ---------------------------------------------------------------------------
// Overview read
// ---------------------------------------------------------------------------

function serializeChecklist(
  row: {
    id: string; newHireId: string; title: string; kind: string;
    completedAt: Date | null; createdAt: Date;
    tasks: {
      id: string; checklistId: string; title: string; assigneeId: string | null;
      dueOffsetDays: number; done: boolean; doneAt: Date | null; doneById: string | null;
      notes: string; order: number;
    }[];
  },
  names: Map<string, string>,
): OnboardingChecklistT {
  return {
    id: row.id,
    newHireId: row.newHireId,
    hireName: names.get(row.newHireId) ?? "(former user)",
    title: row.title,
    kind: row.kind === "SEPARATION" ? "SEPARATION" : "ONBOARDING",
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    tasks: row.tasks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => ({
        id: t.id,
        checklistId: t.checklistId,
        title: t.title,
        assigneeId: t.assigneeId,
        assigneeName: t.assigneeId ? names.get(t.assigneeId) ?? null : null,
        dueOffsetDays: t.dueOffsetDays,
        done: t.done,
        doneAt: t.doneAt ? t.doneAt.toISOString() : null,
        doneBy: t.doneById ? names.get(t.doneById) ?? null : null,
        notes: t.notes,
        order: t.order,
      })),
  };
}

function serializeInterview(
  row: {
    id: string; userId: string; status: string; scheduledAt: Date | null;
    interviewerId: string | null; notes: string; completedAt: Date | null; createdAt: Date;
  },
  names: Map<string, string>,
): ExitInterviewT {
  return {
    id: row.id,
    userId: row.userId,
    userName: names.get(row.userId) ?? "(former user)",
    status: row.status as ExitInterviewStatus,
    scheduledAt: isoDateOrNull(row.scheduledAt),
    interviewerId: row.interviewerId,
    interviewerName: row.interviewerId ? names.get(row.interviewerId) ?? null : null,
    notes: row.notes,
    completedAt: isoDateOrNull(row.completedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getOffboardingOverview(): Promise<ActionResult<OffboardingOverviewT>> {
  return toResult(async () => {
    await requirePermission("hr:admin");

    // The offboarding orbit: EXITED profiles ∪ separation checklists ∪
    // exit interviews ∪ FnF rows. Prep-in-flight cases (a checklist or
    // interview for someone still ACTIVE) surface here too.
    const [exitedProfiles, separationRows, interviewRows, fnfRows] = await Promise.all([
      db.employeeProfile.findMany({
        where: { employmentStatus: "EXITED" },
        select: { userId: true },
      }),
      db.onboardingChecklist.findMany({
        where: { kind: "SEPARATION" },
        include: { tasks: true },
        orderBy: { createdAt: "desc" },
      }),
      // ALL interviews, newest first: the display shows each employee's
      // LATEST record regardless of status (completed and cancelled are
      // real outcomes HR reads); the one-LIVE-per-employee rule governs
      // WRITES (createExitInterview refuses while a live record exists),
      // never this read.
      db.exitInterview.findMany({ orderBy: { createdAt: "desc" } }),
      db.fullAndFinalStatement.findMany({ orderBy: { createdAt: "desc" } }),
    ]);

    const userIds = [
      ...new Set([
        ...exitedProfiles.map((p) => p.userId),
        ...separationRows.map((c) => c.newHireId),
        ...interviewRows.map((i) => i.userId),
        ...fnfRows.map((f) => f.userId),
      ]),
    ];

    const [profiles, users] = await Promise.all([
      userIds.length
        ? db.employeeProfile.findMany({
            where: { userId: { in: userIds } },
            select: {
              userId: true, jobTitle: true, department: true, employmentStatus: true,
              hireDate: true, lastWorkingDay: true, noticePeriodWeeks: true,
            },
          })
        : Promise.resolve([]),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, role: true },
        orderBy: { name: "asc" },
      }),
    ]);
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const names = new Map(users.map((u) => [u.id, u.name]));
    const checklistByUser = new Map(separationRows.map((c) => [c.newHireId, c]));
    // Latest interview per employee (rows are newest-first above).
    const interviewByUser = new Map<string, (typeof interviewRows)[number]>();
    for (const row of interviewRows) {
      if (!interviewByUser.has(row.userId)) interviewByUser.set(row.userId, row);
    }
    const fnfByUser = new Map(fnfRows.map((f) => [f.userId, f]));

    const cases: OffboardingCaseT[] = [];
    for (const userId of userIds) {
      const profile = profileByUser.get(userId);
      const row = fnfByUser.get(userId);
      let fnf: FnFStateT;
      if (!row) {
        // No statement yet — compute live only for the EXITED arc; everyone
        // else gets null (the UI explains the gate).
        fnf = {
          status: "NONE",
          computed: profile?.employmentStatus === "EXITED" ? await computeFnFForUser(userId) : null,
        };
      } else if (row.status === "SETTLED") {
        fnf = {
          status: "SETTLED",
          rowId: row.id,
          generatedAt: row.createdAt.toISOString(),
          settledAt: (row.settledAt ?? row.updatedAt).toISOString(),
          settledBy: row.settledById ? names.get(row.settledById) ?? null : null,
          frozen: storedComputed(row),
        };
      } else {
        fnf = {
          status: "UNSETTLED",
          rowId: row.id,
          generatedAt: row.createdAt.toISOString(),
          generatedBy: row.generatedById ? names.get(row.generatedById) ?? null : null,
          computed: await computeFnFForUser(userId),
          snapshot: storedComputed(row),
        };
      }

      cases.push({
        userId,
        name: names.get(userId) ?? "(former user)",
        jobTitle: profile?.jobTitle ?? "",
        department: profile?.department ?? "",
        employmentStatus: (profile?.employmentStatus ?? "") as OffboardingCaseT["employmentStatus"],
        hireDate: isoDateOrNull(profile?.hireDate ?? null),
        lastWorkingDay: isoDateOrNull(profile?.lastWorkingDay ?? null),
        noticePeriodWeeks: profile?.noticePeriodWeeks ?? null,
        checklist: checklistByUser.has(userId)
          ? serializeChecklist(checklistByUser.get(userId)!, names)
          : null,
        interview: interviewByUser.has(userId)
          ? serializeInterview(interviewByUser.get(userId)!, names)
          : null,
        fnf,
      });
    }

    // Stable order: the most recent separation first, then by name.
    cases.sort((a, b) => {
      const ca = checklistByUser.get(a.userId)?.createdAt?.getTime() ?? 0;
      const cb = checklistByUser.get(b.userId)?.createdAt?.getTime() ?? 0;
      if (ca !== cb) return cb - ca;
      return a.name.localeCompare(b.name);
    });

    // Picker options: every active user — separation prep BEFORE the exit
    // and the post-exit checklist (the seeded story's shape) both start
    // here; the modal copy points at the Directory for the exit itself.
    const members = users.map((u) => ({ userId: u.id, name: u.name }));

    return { cases, members, interviewers: users.map((u) => ({ userId: u.id, name: u.name })) };
  });
}

// ---------------------------------------------------------------------------
// Exit interview lifecycle (EM-15)
// ---------------------------------------------------------------------------

async function assertLiveInterview(interviewId: string) {
  const row = await db.exitInterview.findUnique({ where: { id: interviewId } });
  if (!row) throw new AuthorizationError("Exit interview not found.");
  return row;
}

export async function createExitInterview(input: {
  userId: string;
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(exitInterviewCreateSchema, input);

    const target = await db.user.findUnique({
      where: { id: data.userId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw new AuthorizationError("User not found.");

    // One LIVE interview per employee (PENDING/SCHEDULED); CANCELLED rows
    // are history, so a mistaken cancel never bricks the employee.
    const live = await db.exitInterview.findFirst({
      where: { userId: data.userId, status: { in: [...EXIT_INTERVIEW_LIVE_STATUSES] } },
      select: { id: true, status: true },
    });
    if (live) {
      throw new AuthorizationError(
        `${target.name} already has a live exit interview (${EXIT_INTERVIEW_STATUS_LABELS[live.status as ExitInterviewStatus].toLowerCase()}).`,
      );
    }

    const created = await db.exitInterview.create({
      data: { userId: data.userId, status: "PENDING", createdById: auth.userId },
    });
    await logAudit({
      actor: auth,
      action: "hr.exit_interview_recorded",
      entityType: "EXIT_INTERVIEW",
      entityId: created.id,
      entityLabel: target.name,
      detail: `${auth.name} recorded a pending exit interview for ${target.name}.`,
    });
    revalidatePath("/");
    return { id: created.id };
  });
}

export async function scheduleExitInterview(input: {
  interviewId: string;
  scheduledAt: string;
  interviewerId?: string;
  notes?: string;
}): Promise<ActionResult<{ status: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(exitInterviewScheduleSchema, input);
    const row = await assertLiveInterview(data.interviewId);
    if (!canScheduleExitInterview(row.status as ExitInterviewStatus)) {
      throw new AuthorizationError(
        `This interview is already ${EXIT_INTERVIEW_STATUS_LABELS[row.status as ExitInterviewStatus].toLowerCase()} — record a new one instead.`,
      );
    }

    let interviewerName: string | null = null;
    if (data.interviewerId) {
      const interviewer = await db.user.findUnique({
        where: { id: data.interviewerId },
        select: { id: true, name: true, deletedAt: true },
      });
      if (!interviewer || interviewer.deletedAt) {
        throw new AuthorizationError("Interviewer not found.");
      }
      interviewerName = interviewer.name;
    }
    const target = await db.user.findUnique({
      where: { id: row.userId },
      select: { name: true },
    });

    await db.exitInterview.update({
      where: { id: row.id },
      data: {
        status: "SCHEDULED",
        scheduledAt: new Date(`${data.scheduledAt}T00:00:00.000Z`),
        interviewerId: data.interviewerId ?? row.interviewerId,
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });

    // EM-T01 lite — notify the employee IN-APP (best-effort; the HR module
    // writes no emails by discipline F-R17).
    try {
      await db.notification.create({
        data: {
          recipientUserId: row.userId,
          type: "INFO",
          title: "Exit interview scheduled",
          message:
            `${auth.name} scheduled your exit interview for ${data.scheduledAt}` +
            (interviewerName ? ` with ${interviewerName}.` : "."),
        },
      });
    } catch (err) {
      logError("r-offboarding] exit-interview notification failed:", err);
    }

    await logAudit({
      actor: auth,
      action: "hr.exit_interview_scheduled",
      entityType: "EXIT_INTERVIEW",
      entityId: row.id,
      entityLabel: target?.name ?? row.userId,
      detail:
        `${auth.name} scheduled ${target?.name ?? "the employee"}'s exit interview for ${data.scheduledAt}` +
        (interviewerName ? ` (interviewer: ${interviewerName}).` : "."),
    });
    revalidatePath("/");
    return { status: "SCHEDULED" };
  });
}

export async function completeExitInterview(input: {
  interviewId: string;
  notes?: string;
}): Promise<ActionResult<{ status: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(exitInterviewCompleteSchema, input);
    const row = await assertLiveInterview(data.interviewId);
    if (!canCompleteExitInterview(row.status as ExitInterviewStatus)) {
      throw new AuthorizationError(
        `This interview is already ${EXIT_INTERVIEW_STATUS_LABELS[row.status as ExitInterviewStatus].toLowerCase()} — it cannot be completed.`,
      );
    }
    const target = await db.user.findUnique({
      where: { id: row.userId },
      select: { name: true },
    });

    await db.exitInterview.update({
      where: { id: row.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });
    await logAudit({
      actor: auth,
      action: "hr.exit_interview_completed",
      entityType: "EXIT_INTERVIEW",
      entityId: row.id,
      entityLabel: target?.name ?? row.userId,
      detail: `${auth.name} completed ${target?.name ?? "the employee"}'s exit interview${data.notes ? ` — "${data.notes.slice(0, 200)}"` : ""}.`,
    });
    revalidatePath("/");
    return { status: "COMPLETED" };
  });
}

export async function cancelExitInterview(input: {
  interviewId: string;
}): Promise<ActionResult<{ status: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(exitInterviewCancelSchema, input);
    const row = await assertLiveInterview(data.interviewId);
    if (!canCancelExitInterview(row.status as ExitInterviewStatus)) {
      throw new AuthorizationError(
        `This interview is already ${EXIT_INTERVIEW_STATUS_LABELS[row.status as ExitInterviewStatus].toLowerCase()} — it cannot be cancelled.`,
      );
    }
    const target = await db.user.findUnique({
      where: { id: row.userId },
      select: { name: true },
    });

    await db.exitInterview.update({
      where: { id: row.id },
      data: { status: "CANCELLED" },
    });
    await logAudit({
      actor: auth,
      action: "hr.exit_interview_cancelled",
      entityType: "EXIT_INTERVIEW",
      entityId: row.id,
      entityLabel: target?.name ?? row.userId,
      detail: `${auth.name} cancelled ${target?.name ?? "the employee"}'s exit interview.`,
    });
    revalidatePath("/");
    return { status: "CANCELLED" };
  });
}

// ---------------------------------------------------------------------------
// Full-and-final statement (EM-16 lite)
// ---------------------------------------------------------------------------

export async function generateFullAndFinal(input: {
  userId: string;
}): Promise<ActionResult<{ id: string; status: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(fnfGenerateSchema, input);

    const target = await db.user.findUnique({
      where: { id: data.userId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw new AuthorizationError("User not found.");

    const profile = await db.employeeProfile.findUnique({ where: { userId: data.userId } });
    if ((profile?.employmentStatus ?? "") !== "EXITED") {
      throw new AuthorizationError(
        `A full-and-final statement needs an exited employee — record the exit (with a last working day) first.`,
      );
    }

    const existing = await db.fullAndFinalStatement.findUnique({ where: { userId: data.userId } });
    if (existing?.status === "SETTLED") {
      throw new AuthorizationError(
        `${target.name}'s full-and-final statement is already settled — the frozen amounts are final.`,
      );
    }

    // The row snapshots the LIVE computation at generation time; reads keep
    // recomputing (the settle freezes what is true THEN).
    const computed = await computeFnFForUser(data.userId);
    const lastWorkingDay = profile?.lastWorkingDay ?? null;
    const payload = {
      lastWorkingDay,
      asOf: new Date(),
      lines: JSON.stringify(computed.lines),
      payableTotal: computed.payableTotal,
      receivableTotal: computed.receivableTotal,
      netPayable: computed.netPayable,
    };

    let row;
    if (existing) {
      row = await db.fullAndFinalStatement.update({
        where: { id: existing.id },
        data: { ...payload, generatedById: auth.userId },
      });
    } else {
      try {
        row = await db.fullAndFinalStatement.create({
          data: { userId: data.userId, status: "UNSETTLED", ...payload, generatedById: auth.userId },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          // Two HR users racing the generation: adopt the winner's row.
          row = await db.fullAndFinalStatement.findUniqueOrThrow({
            where: { userId: data.userId },
          });
        } else {
          throw err;
        }
      }
    }

    await logAudit({
      actor: auth,
      action: "hr.fnf_generated",
      entityType: "FULL_AND_FINAL",
      entityId: row.id,
      entityLabel: target.name,
      detail:
        `${auth.name} generated ${target.name}'s full-and-final statement (unsettled): ` +
        `payable $${computed.payableTotal.toFixed(2)}, receivable $${computed.receivableTotal.toFixed(2)}, net $${computed.netPayable.toFixed(2)} — recomputed live until settled.`,
    });
    revalidatePath("/");
    return { id: row.id, status: row.status };
  });
}

export async function settleFullAndFinal(input: {
  userId: string;
}): Promise<ActionResult<{ status: string; netPayable: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(fnfSettleSchema, input);

    const target = await db.user.findUnique({
      where: { id: data.userId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw new AuthorizationError("User not found.");

    const row = await db.fullAndFinalStatement.findUnique({ where: { userId: data.userId } });
    if (!row) {
      throw new AuthorizationError(
        `No full-and-final statement for ${target.name} yet — generate it first.`,
      );
    }
    if (row.status === "SETTLED") {
      throw new AuthorizationError("This statement is already settled — the frozen amounts are final.");
    }

    // Freeze the LIVE computation (not the stale generation snapshot) inside
    // the settlement transaction.
    const computed = await computeFnFForUser(data.userId);
    const settled = await db.$transaction(async (tx) => {
      return tx.fullAndFinalStatement.update({
        where: { id: row.id },
        data: {
          status: "SETTLED",
          asOf: new Date(),
          lines: JSON.stringify(computed.lines),
          payableTotal: computed.payableTotal,
          receivableTotal: computed.receivableTotal,
          netPayable: computed.netPayable,
          settledById: auth.userId,
          settledAt: new Date(),
        },
      });
    });

    await logAudit({
      actor: auth,
      action: "hr.fnf_settled",
      entityType: "FULL_AND_FINAL",
      entityId: settled.id,
      entityLabel: target.name,
      detail:
        `${auth.name} settled ${target.name}'s full-and-final statement: ` +
        `payable $${computed.payableTotal.toFixed(2)} − receivable $${computed.receivableTotal.toFixed(2)} = net $${computed.netPayable.toFixed(2)}. ` +
        `Amounts are frozen and payslip editing for ${target.name} is locked.`,
    });
    revalidatePath("/");
    return { status: "SETTLED", netPayable: computed.netPayable };
  });
}
