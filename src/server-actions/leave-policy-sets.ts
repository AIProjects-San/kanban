"use server";

// ---------------------------------------------------------------------------
// P28 (LV-02, LV-03) — leave policy sets + bulk assignment, actions half
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.2 P28; benchmark:
// frappe/hrms `Leave Policy`/`Leave Policy Detail` + `Leave Policy
// Assignment`).
//
// listLeavePolicyState: ONE read feeding the whole Types & Policies section
// (hr:admin) — the sets with their items, the assignments with their joined
// names + granted badges, the light employee roster for the assign picker,
// and the target buckets the kernel's assignmentBucketCandidates offers.
//
// create/update/deleteLeavePolicySet: the master CRUD (hr:admin). The pure
// kernel validates the shape (validatePolicySet); the DB guards refuse a
// duplicate name (friendly, ahead of the unique index), item EDITS once any
// referencing assignment has granted (history is immutable — the P27 delete
// discipline applied to edits: create a successor set for the next window
// instead), and the delete of a set assignments still reference.
//
// bulkAssignLeavePolicySet: the HR bulk-assign tool (LV-03) — one set, one
// target bucket, 1–200 employees, each employee in their OWN transaction
// (the P13/P14 isolation pattern: one bad record never blocks the rest,
// named failures, honest counts). Per employee: the overlap guard (one
// assignment per employee per bucket — LV-03's own law, the unique index's
// friendly twin), the assignment doc, and — when the target window has
// STARTED — the eager materialization of every item's entitlement through
// the SAME tx-scoped materializer the decide path uses (MANUAL single
// grant with F2.4's DOJ pro-rata, strategy types everything already due;
// future windows materialize nothing: the doc alone, the engine grants on
// schedule — P27's forward-looking discipline).
//
// deleteLeavePolicyAssignment: refuses when any of the assignment's
// (user, item-type, bucket) pairs carries ledger rows (grants are history);
// a clean (ungranted) assignment deletes together with its zero-entitled
// balance rows, returning the employee to the global per-type policy world
// (the lazy materializer rebuilds on next touch).
//
// The pure rules live in src/lib/leave-policy-set.ts; the engine
// consumption in hr-shared.ts / leave-allocation-core.ts.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { dayKey } from "@/lib/working-days";
import { materializeLeaveBalanceTx, loadLeavePeriods } from "./hr-shared";
import {
  assignmentBucketCandidates,
  assignmentWindowFor,
  validatePolicySet,
  type BucketCandidate,
  type LeavePolicyAssignmentT,
  type LeavePolicySetT,
} from "@/lib/leave-policy-set";

// Re-exported for the client (the UI imports the DTOs from the action
// module — the P27 convention).
export type { LeavePolicySetT, LeavePolicyAssignmentT, BucketCandidate };
import { windowForBucket } from "@/lib/leave-period";
import {
  bulkAssignLeavePolicySetSchema,
  leavePolicySetCreateSchema,
  leavePolicySetDeleteSchema,
  leavePolicySetUpdateSchema,
  leavePolicyAssignmentDeleteSchema,
  parseOrThrow,
} from "@/lib/validation";

// ---------------------------------------------------------------------------
// The section's one read
// ---------------------------------------------------------------------------

export interface PolicySetEmployeeT {
  userId: string;
  name: string;
  hireDate: string | null;
  employmentStatus: string | null;
}

export interface LeavePolicyStateT {
  sets: LeavePolicySetT[];
  assignments: LeavePolicyAssignmentT[];
  employees: PolicySetEmployeeT[];
  buckets: BucketCandidate[];
}

export async function listLeavePolicyState(): Promise<ActionResult<LeavePolicyStateT>> {
  return toResult(async () => {
    await requirePermission("hr:admin");

    const periods = await loadLeavePeriods();
    const today = dayKey(new Date());

    const [setRows, itemRows, assignmentRows, userRows, profileRows] = await Promise.all([
      db.leavePolicySet.findMany({ orderBy: { createdAt: "asc" } }),
      db.leavePolicySetItem.findMany({ orderBy: { createdAt: "asc" } }),
      db.leavePolicyAssignment.findMany({ orderBy: [{ bucketYear: "asc" }, { assignedAt: "asc" }] }),
      db.user.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, take: 500 }),
      db.employeeProfile.findMany({
        select: { userId: true, hireDate: true, employmentStatus: true },
        take: 500,
      }),
    ]);

    const typeRows = await db.leaveType.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    const typeNameById = new Map(typeRows.map((t) => [t.id, t.name]));
    const userNameById = new Map(userRows.map((u) => [u.id, u.name]));
    const profileByUser = new Map(profileRows.map((p) => [p.userId, p]));

    // Items + assignment counts per set.
    const itemsBySet = new Map<string, typeof itemRows>();
    for (const item of itemRows) {
      const list = itemsBySet.get(item.setId) ?? [];
      list.push(item);
      itemsBySet.set(item.setId, list);
    }
    const assignmentCountBySet = new Map<string, number>();
    for (const a of assignmentRows) {
      assignmentCountBySet.set(a.setId, (assignmentCountBySet.get(a.setId) ?? 0) + 1);
    }

    // Granted badges: one compound groupBy over the assignments' (user,
    // bucket, type) space — each assignment then checks its OWN pairs
    // (another set's type rows never leak into its flag).
    const periodNameById = new Map(periods.map((p) => [p.id, p.name]));
    const relevantTypeIds = new Set<string>();
    for (const a of assignmentRows) {
      for (const item of itemsBySet.get(a.setId) ?? []) relevantTypeIds.add(item.leaveTypeId);
    }
    const grantedKeys = new Set<string>();
    if (assignmentRows.length > 0 && relevantTypeIds.size > 0) {
      const ledgerRows = await db.leaveLedgerEntry.groupBy({
        by: ["userId", "year", "leaveTypeId"],
        where: {
          userId: { in: [...new Set(assignmentRows.map((a) => a.userId))] },
          year: { in: [...new Set(assignmentRows.map((a) => a.bucketYear))] },
          leaveTypeId: { in: [...relevantTypeIds] },
        },
        _count: { id: true },
      });
      for (const row of ledgerRows) {
        if (row._count.id > 0) grantedKeys.add(`${row.userId}|${row.year}|${row.leaveTypeId}`);
      }
    }

    const sets: LeavePolicySetT[] = setRows.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      active: s.active,
      items: (itemsBySet.get(s.id) ?? []).map((item) => ({
        id: item.id,
        leaveTypeId: item.leaveTypeId,
        typeName: typeNameById.get(item.leaveTypeId) ?? "(removed type)",
        annualDays: item.annualDays,
      })),
      assignmentCount: assignmentCountBySet.get(s.id) ?? 0,
    }));

    const assignments: LeavePolicyAssignmentT[] = assignmentRows.map((a) => {
      const items = itemsBySet.get(a.setId) ?? [];
      const granted = items.some((item) =>
        grantedKeys.has(`${a.userId}|${a.bucketYear}|${item.leaveTypeId}`),
      );
      return {
        id: a.id,
        userId: a.userId,
        userName: userNameById.get(a.userId) ?? "(unknown user)",
        setId: a.setId,
        setName: setRows.find((s) => s.id === a.setId)?.name ?? "(deleted set)",
        bucketYear: a.bucketYear,
        periodName: a.periodId ? periodNameById.get(a.periodId) ?? null : null,
        assignedAt: a.assignedAt.toISOString(),
        assignedByName: userNameById.get(a.assignedById) ?? "(unknown)",
        granted,
      };
    });

    const employees: PolicySetEmployeeT[] = userRows.map((u) => {
      const profile = profileByUser.get(u.id);
      return {
        userId: u.id,
        name: u.name,
        hireDate: profile?.hireDate ? dayKey(profile.hireDate) : null,
        employmentStatus: profile?.employmentStatus ?? null,
      };
    });

    return {
      sets,
      assignments,
      employees,
      buckets: assignmentBucketCandidates(periods, today),
    };
  });
}

// ---------------------------------------------------------------------------
// Set CRUD
// ---------------------------------------------------------------------------

export async function createLeavePolicySet(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(leavePolicySetCreateSchema, input);

    // The pure kernel: bounds, dedupe, the allocation range.
    const validation = validatePolicySet(data);
    if (!validation.ok) {
      throw new AuthorizationError(validation.reason);
    }

    // The referenced types must exist (and stay referenced by id — a typo'd
    // id is a loud refusal, not a silent row).
    const types = await db.leaveType.findMany({
      where: { id: { in: data.items.map((i) => i.leaveTypeId) } },
      select: { id: true, name: true },
    });
    if (types.length !== data.items.length) {
      throw new AuthorizationError("One of the leave types no longer exists — refresh the page and rebuild the set.");
    }

    const dup = await db.leavePolicySet.findUnique({ where: { name: data.name }, select: { id: true } });
    if (dup) {
      throw new AuthorizationError(`A policy set named “${data.name}” already exists — pick another name.`);
    }

    const created = await db.$transaction(async (tx) => {
      const set = await tx.leavePolicySet.create({
        data: { name: data.name, description: data.description },
      });
      await tx.leavePolicySetItem.createMany({
        data: data.items.map((item) => ({
          setId: set.id,
          leaveTypeId: item.leaveTypeId,
          annualDays: item.annualDays,
        })),
      });
      return set;
    });

    await logAudit({
      actor: auth,
      action: "leave.policy_set_created",
      entityType: "LEAVE_POLICY_SET",
      entityId: created.id,
      entityLabel: data.name,
      detail: `Created policy set “${data.name}” (${data.items.length} type allocation(s))`,
    });
    revalidatePath("/");
    return { id: created.id };
  });
}

/** The set's items sorted+shaped for the freeze comparison. */
function normalizedItems(items: ReadonlyArray<{ leaveTypeId: string; annualDays: number }>) {
  return [...items]
    .map((i) => ({ leaveTypeId: i.leaveTypeId, annualDays: i.annualDays }))
    .sort((a, b) => a.leaveTypeId.localeCompare(b.leaveTypeId));
}

/** Ledger rows across the (user, item-type, bucket) pairs of the given
 * assignments — the "has anything been granted?" truth (one compound
 * groupBy; callers pass ≤ a handful of assignments). */
async function grantedPairRowCount(
  assignments: ReadonlyArray<{ userId: string; bucketYear: number; setId: string }>,
): Promise<number> {
  if (assignments.length === 0) return 0;
  const setIds = [...new Set(assignments.map((a) => a.setId))];
  const items = await db.leavePolicySetItem.findMany({
    where: { setId: { in: setIds } },
    select: { setId: true, leaveTypeId: true },
  });
  const typesBySet = new Map<string, string[]>();
  for (const item of items) {
    const list = typesBySet.get(item.setId) ?? [];
    list.push(item.leaveTypeId);
    typesBySet.set(item.setId, list);
  }
  const pairs = assignments.flatMap((a) =>
    (typesBySet.get(a.setId) ?? []).map((leaveTypeId) => ({
      userId: a.userId,
      year: a.bucketYear,
      leaveTypeId,
    })),
  );
  if (pairs.length === 0) return 0;
  const rows = await db.leaveLedgerEntry.groupBy({
    by: ["userId", "year", "leaveTypeId"],
    where: { OR: pairs.map((p) => ({ userId: p.userId, year: p.year, leaveTypeId: p.leaveTypeId })) },
    _count: { id: true },
  });
  return rows.reduce((sum, r) => sum + r._count.id, 0);
}

export async function updateLeavePolicySet(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(leavePolicySetUpdateSchema, input);

    const validation = validatePolicySet(data);
    if (!validation.ok) {
      throw new AuthorizationError(validation.reason);
    }

    const existing = await db.leavePolicySet.findUnique({ where: { id: data.id } });
    if (!existing) {
      throw new AuthorizationError("That policy set no longer exists — refresh the list.");
    }

    if (data.name !== existing.name) {
      const dup = await db.leavePolicySet.findUnique({ where: { name: data.name }, select: { id: true } });
      if (dup) {
        throw new AuthorizationError(`A policy set named “${data.name}” already exists — pick another name.`);
      }
    }

    const existingItems = await db.leavePolicySetItem.findMany({
      where: { setId: data.id },
      select: { leaveTypeId: true, annualDays: true },
    });
    const itemsChanged =
      JSON.stringify(normalizedItems(existingItems)) !== JSON.stringify(normalizedItems(data.items));

    if (itemsChanged) {
      // History is immutable: once any referencing assignment has granted,
      // the set's allocations are frozen (a mid-stream change would bend
      // future accruals under live entitlements). Until then an edit is a
      // fix-ahead-of-the-window — allowed.
      const referencing = await db.leavePolicyAssignment.findMany({
        where: { setId: data.id },
        select: { userId: true, bucketYear: true, setId: true },
      });
      const grantedRows = await grantedPairRowCount(referencing);
      if (grantedRows > 0) {
        throw new AuthorizationError(
          `“${existing.name}” has assignments whose grants already landed (${grantedRows} ledger row(s)) — its allocations are frozen. Create a successor set and assign it to the next window instead.`,
        );
      }
      const types = await db.leaveType.findMany({
        where: { id: { in: data.items.map((i) => i.leaveTypeId) } },
        select: { id: true },
      });
      if (types.length !== data.items.length) {
        throw new AuthorizationError("One of the leave types no longer exists — refresh the page and rebuild the set.");
      }
    }

    await db.$transaction(async (tx) => {
      await tx.leavePolicySet.update({
        where: { id: data.id },
        data: { name: data.name, description: data.description, active: data.active },
      });
      if (itemsChanged) {
        await tx.leavePolicySetItem.deleteMany({ where: { setId: data.id } });
        await tx.leavePolicySetItem.createMany({
          data: data.items.map((item) => ({
            setId: data.id,
            leaveTypeId: item.leaveTypeId,
            annualDays: item.annualDays,
          })),
        });
      }
    });

    await logAudit({
      actor: auth,
      action: "leave.policy_set_updated",
      entityType: "LEAVE_POLICY_SET",
      entityId: data.id,
      entityLabel: data.name,
      detail: `Updated policy set “${data.name}”${itemsChanged ? " (allocations rewritten)" : " (metadata)"}${!data.active ? " — retired from the assign picker" : ""}`,
    });
    revalidatePath("/");
  });
}

export async function deleteLeavePolicySet(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(leavePolicySetDeleteSchema, input);

    const existing = await db.leavePolicySet.findUnique({ where: { id: data.id } });
    if (!existing) {
      throw new AuthorizationError("That policy set no longer exists — refresh the list.");
    }

    // Assignments resolve LIVE against the set — deleting it out from under
    // them would silently degrade their overrides to the global policy.
    const referencing = await db.leavePolicyAssignment.count({ where: { setId: data.id } });
    if (referencing > 0) {
      throw new AuthorizationError(
        `“${existing.name}” still has ${referencing} assignment(s) — delete those first (an assignment whose grants landed is never deleted; wait for the next window).`,
      );
    }

    await db.$transaction(async (tx) => {
      await tx.leavePolicySetItem.deleteMany({ where: { setId: data.id } });
      await tx.leavePolicySet.delete({ where: { id: data.id } });
    });
    await logAudit({
      actor: auth,
      action: "leave.policy_set_deleted",
      entityType: "LEAVE_POLICY_SET",
      entityId: existing.id,
      entityLabel: existing.name,
      detail: `Deleted policy set “${existing.name}” (unassigned by anyone)`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// The bulk assignment tool (LV-03)
// ---------------------------------------------------------------------------

export interface BulkAssignLeavePolicySetResult {
  assigned: number;
  /** (user, type) pairs whose balance row + grants materialized now — the
   * honest count (0 for future windows: the doc alone, the engine grants on
   * schedule once the window opens). */
  pairsMaterialized: number;
  failures: Array<{ userId: string; reason: string }>;
}

export async function bulkAssignLeavePolicySet(
  input: unknown,
): Promise<ActionResult<BulkAssignLeavePolicySetResult>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(bulkAssignLeavePolicySetSchema, input);

    const set = await db.leavePolicySet.findUnique({ where: { id: data.setId } });
    if (!set) {
      throw new AuthorizationError("That policy set no longer exists — refresh the list.");
    }
    if (!set.active) {
      throw new AuthorizationError(`“${set.name}” is retired — reactivate it before assigning.`);
    }
    const items = await db.leavePolicySetItem.findMany({
      where: { setId: set.id },
      orderBy: { createdAt: "asc" },
    });
    if (items.length === 0) {
      throw new AuthorizationError(`“${set.name}” carries no type allocations — edit it first.`);
    }

    // Window targeting (the pure kernel's tri-state): a named period's
    // window, the implicit calendar year, or the REFUSAL when named periods
    // exist but none starts in the target bucket.
    const periods = await loadLeavePeriods();
    const target = assignmentWindowFor(periods, data.bucketYear);
    if (!target.ok) {
      throw new AuthorizationError(target.reason);
    }
    const windowArg = target.windowArg;
    const winStart = windowArg?.start ?? `${data.bucketYear}-01-01`;
    const winEnd = windowArg?.end ?? `${data.bucketYear}-12-31`;
    const periodId = windowForBucket(periods, data.bucketYear).periodId ?? "";
    const today = dayKey(new Date());
    // Eager materialization only for a window that has STARTED — a future
    // window's assignment is the doc alone (P27's forward-looking
    // discipline; the engine grants on schedule once it opens).
    const windowStarted = today >= winStart;
    const windowLabel = windowArg
      ? `${winStart} → ${winEnd}`
      : `calendar year ${data.bucketYear}`;

    // The employees must exist (a typo'd id is a per-employee failure, not
    // a silent skip — the P14 rule).
    const users = await db.user.findMany({
      where: { id: { in: data.userIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    // The friendly overlap pre-check (the unique index is the race-safe
    // twin below).
    const alreadyAssigned = await db.leavePolicyAssignment.findMany({
      where: { userId: { in: data.userIds }, bucketYear: data.bucketYear },
      select: { userId: true, setId: true },
    });
    const assignedByUser = new Map(alreadyAssigned.map((a) => [a.userId, a.setId]));

    const failures: Array<{ userId: string; reason: string }> = [];
    let assigned = 0;
    let pairsMaterialized = 0;

    for (const userId of data.userIds) {
      if (!nameById.has(userId)) {
        failures.push({ userId, reason: "employee not found" });
        continue;
      }
      if (assignedByUser.has(userId)) {
        const existingSetName = assignedByUser.get(userId) === set.id
          ? `this same set`
          : `another set`;
        failures.push({
          userId,
          reason: `already has an assignment for the ${windowLabel} (${existingSetName}) — one assignment per employee per window; delete it first if nothing has been granted`,
        });
        continue;
      }
      try {
        const materialized = await db.$transaction(async (tx) => {
          await tx.leavePolicyAssignment.create({
            data: {
              userId,
              setId: set.id,
              bucketYear: data.bucketYear,
              periodId,
              assignedById: auth.userId,
            },
          });
          let materializedPairs = 0;
          if (windowStarted) {
            for (const item of items) {
              const result = await materializeLeaveBalanceTx(
                tx,
                userId,
                item.leaveTypeId,
                data.bucketYear,
                windowArg,
                item.annualDays,
              );
              if (result.materialized) materializedPairs += 1;
            }
          }
          return materializedPairs;
        });
        assigned += 1;
        pairsMaterialized += materialized;
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown error";
        failures.push({
          userId,
          reason: /userId_bucketYear|unique/i.test(message)
            ? `already has an assignment for the ${windowLabel} (just created concurrently) — refresh`
            : message,
        });
      }
    }

    if (assigned === 0) {
      // Nothing landed at all — refuse loudly rather than pretending.
      throw new AuthorizationError(
        `Bulk assignment created no assignments — ${failures.length} failure(s): ${failures.map((f) => `${nameById.get(f.userId) ?? f.userId} (${f.reason})`).join("; ")}.`,
      );
    }

    await logAudit({
      actor: auth,
      action: "leave.policy_set_bulk_assigned",
      entityType: "LEAVE_POLICY_SET",
      entityId: set.id,
      entityLabel: `${assigned} employee(s)`,
      detail: `${auth.name} bulk-assigned policy set “${set.name}” to ${assigned} employee(s) for the ${windowLabel} (${items.length} type(s) each; ${pairsMaterialized} entitlement pair(s) materialized)${failures.length > 0 ? `; ${failures.length} FAILED: ${failures.map((f) => `${nameById.get(f.userId) ?? f.userId} (${f.reason})`).join("; ")}` : ""}.`,
    });
    revalidatePath("/");
    return { assigned, pairsMaterialized, failures };
  });
}

// ---------------------------------------------------------------------------
// Assignment delete
// ---------------------------------------------------------------------------

export async function deleteLeavePolicyAssignment(input: unknown): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("hr:admin");
    const data = parseOrThrow(leavePolicyAssignmentDeleteSchema, input);

    const assignment = await db.leavePolicyAssignment.findUnique({ where: { id: data.id } });
    if (!assignment) {
      throw new AuthorizationError("That assignment no longer exists — refresh the list.");
    }
    const [set, items] = await Promise.all([
      db.leavePolicySet.findUnique({ where: { id: assignment.setId }, select: { name: true } }),
      db.leavePolicySetItem.findMany({
        where: { setId: assignment.setId },
        select: { leaveTypeId: true },
      }),
    ]);
    const setName = set?.name ?? "(deleted set)";

    // History is immutable: any ledger row on the assignment's (user, type,
    // bucket) pairs means the engine already granted under it — the
    // assignment stands (the benchmark's cancel-requires-canceling-
    // allocations, Fernly-shaped: adjust balances via the Balances tab if
    // the numbers are wrong, never rewrite granted history).
    const grantedRows = await grantedPairRowCount([
      { userId: assignment.userId, bucketYear: assignment.bucketYear, setId: assignment.setId },
    ]);
    if (grantedRows > 0) {
      const user = await db.user.findUnique({
        where: { id: assignment.userId },
        select: { name: true },
      });
      throw new AuthorizationError(
        `${user?.name ?? "This employee"}'s ${assignment.bucketYear} assignment under “${setName}” has ${grantedRows} ledger row(s) — granted history is never deleted. Adjust balances from the Balances tab if the numbers are wrong.`,
      );
    }

    // Clean delete: the doc + its zero-entitled balance rows together (a
    // surviving entitled-0 row would pin MANUAL types at zero forever —
    // the lazy materializer never rebuilds an existing row). With no
    // ledger rows, deleting the cache rows returns the employee to the
    // global per-type policy world exactly as it was.
    await db.$transaction(async (tx) => {
      await tx.leavePolicyAssignment.delete({ where: { id: assignment.id } });
      for (const item of items) {
        await tx.leaveBalance.deleteMany({
          where: {
            userId: assignment.userId,
            leaveTypeId: item.leaveTypeId,
            year: assignment.bucketYear,
          },
        });
      }
    });

    await logAudit({
      actor: auth,
      action: "leave.policy_assignment_deleted",
      entityType: "LEAVE_POLICY_SET",
      entityId: assignment.id,
      entityLabel: setName,
      detail: `Deleted the ${assignment.bucketYear} assignment of “${setName}” before anything was granted (balances re-materialize from the per-type policies)`,
    });
    revalidatePath("/");
  });
}
