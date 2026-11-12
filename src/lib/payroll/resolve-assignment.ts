// ---------------------------------------------------------------------------
// Phase 1B (G8) — effective-dated salary assignment resolution.
//
// One assignment is "in force" at date D for employee E when
//   fromDate <= D  AND  (toDate == null OR toDate > D)
// — the [fromDate, toDate) half-open window, toDate null = current. At most
// one assignment per employee begins on any given date (@@unique), so the
// latest qualifying fromDate is always THE answer.
//
// Three shapes:
//   resolveAssignmentAt(prisma, …)   — the single-employee DB read (UI,
//                                      single-slip paths).
//   resolveAssignmentFromList(…)     — the sync variant over a preloaded
//                                      array (bulk payroll runs: ONE query
//                                      for the whole run, never N+1).
//   assignmentsInForceWhere(…)       — the shared window predicate for bulk
//                                      loads whose call site owns the
//                                      include / relation filters.
// Pure date comparisons only — everything here is clock-free.
// ---------------------------------------------------------------------------

import type { Prisma, PrismaClient, SalaryStructureAssignment } from "@prisma/client";

/** The minimum client surface the async resolver needs (accepts the global
 *  client, an interactive-transaction client, or any test double). */
export type AssignmentReader = Pick<PrismaClient, "salaryStructureAssignment">;

/** Is this assignment's [fromDate, toDate) window open at `date`? */
export function assignmentInForce(
  a: Pick<SalaryStructureAssignment, "fromDate" | "toDate">,
  date: Date,
): boolean {
  return (
    a.fromDate.getTime() <= date.getTime() &&
    (a.toDate == null || a.toDate.getTime() > date.getTime())
  );
}

/** The assignment in force at `date` for one employee, or null.
 *
 *  The Phase 1B spec query verbatim: latest fromDate <= date whose toDate is
 *  null or still in the future. */
export async function resolveAssignmentAt(
  prisma: AssignmentReader,
  employeeId: string,
  date: Date,
): Promise<SalaryStructureAssignment | null> {
  return prisma.salaryStructureAssignment.findFirst({
    where: {
      employeeId,
      fromDate: { lte: date },
      OR: [{ toDate: null }, { toDate: { gt: date } }],
    },
    orderBy: { fromDate: "desc" },
  });
}

/** Bulk-run resolver: the same semantics over a preloaded array (ONE query
 *  for the whole run — the payroll action loads every candidate assignment
 *  in force once and resolves each employee synchronously from it). */
export function resolveAssignmentFromList<
  T extends Pick<SalaryStructureAssignment, "employeeId" | "fromDate" | "toDate">,
>(assignments: T[], employeeId: string, date: Date): T | null {
  let best: T | null = null;
  for (const a of assignments) {
    if (a.employeeId !== employeeId || !assignmentInForce(a, date)) continue;
    if (best == null || a.fromDate.getTime() > best.fromDate.getTime()) best = a;
  }
  return best;
}

/** The shared in-force window predicate, for bulk loads whose call site owns
 *  the include / relation filters (e.g. the payroll run's
 *  `include: { structure: true }`). */
export function assignmentsInForceWhere(
  date: Date,
  employeeIds?: string[],
): Prisma.SalaryStructureAssignmentWhereInput {
  return {
    fromDate: { lte: date },
    OR: [{ toDate: null }, { toDate: { gt: date } }],
    ...(employeeIds && employeeIds.length > 0 ? { employeeId: { in: employeeIds } } : {}),
  };
}
