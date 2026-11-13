// SERVER-ONLY leave-policy override reads.
//
// Lives in lib so the leave-allocation cron kernel can read policy
// assignments without importing the action layer.

import { db } from "@/lib/db";

/** One assignment's resolved overrides for a bucket. */
export interface BucketPolicyOverrides {
  setId: string;
  setName: string;
  annualDaysByType: Map<string, number>;
}

/** The override for ONE user's bucket (null = no assignment — the global
 * per-type policy world). Two reads when an assignment exists (the doc +
 * its items), zero when it does not — the common case stays a single read. */
export async function assignmentOverridesFor(
  userId: string,
  bucketYear: number,
): Promise<BucketPolicyOverrides | null> {
  const assignment = await db.leavePolicyAssignment.findUnique({
    where: { userId_bucketYear: { userId, bucketYear } },
    select: { setId: true },
  });
  if (!assignment) return null;
  const [set, items] = await Promise.all([
    db.leavePolicySet.findUnique({
      where: { id: assignment.setId },
      select: { name: true },
    }),
    db.leavePolicySetItem.findMany({
      where: { setId: assignment.setId },
      select: { leaveTypeId: true, annualDays: true },
    }),
  ]);
  // An orphaned setId (set hard-deleted behind an assignment — the delete
  // action refuses exactly this) degrades to NO override: the engine falls
  // back to the global policy rather than inventing days.
  if (!set) return null;
  return {
    setId: assignment.setId,
    setName: set.name,
    annualDaysByType: new Map(items.map((i) => [i.leaveTypeId, i.annualDays])),
  };
}

/** The overrides for EVERY user assigned to a bucket (the cron job's
 * batched read: one query per table, never per user). */
export async function assignmentOverridesForUsers(
  bucketYear: number,
): Promise<Map<string, BucketPolicyOverrides>> {
  const assignments = await db.leavePolicyAssignment.findMany({
    where: { bucketYear },
    select: { userId: true, setId: true },
  });
  if (assignments.length === 0) return new Map();
  const setIds = [...new Set(assignments.map((a) => a.setId))];
  const [sets, items] = await Promise.all([
    db.leavePolicySet.findMany({ where: { id: { in: setIds } }, select: { id: true, name: true } }),
    db.leavePolicySetItem.findMany({
      where: { setId: { in: setIds } },
      select: { setId: true, leaveTypeId: true, annualDays: true },
    }),
  ]);
  const nameById = new Map(sets.map((s) => [s.id, s.name]));
  const itemsBySet = new Map<string, Map<string, number>>();
  for (const item of items) {
    let byType = itemsBySet.get(item.setId);
    if (!byType) {
      byType = new Map<string, number>();
      itemsBySet.set(item.setId, byType);
    }
    byType.set(item.leaveTypeId, item.annualDays);
  }
  const result = new Map<string, BucketPolicyOverrides>();
  for (const a of assignments) {
    if (!nameById.has(a.setId)) continue; // orphaned set — no override
    result.set(a.userId, {
      setId: a.setId,
      setName: nameById.get(a.setId)!,
      annualDaysByType: itemsBySet.get(a.setId) ?? new Map<string, number>(),
    });
  }
  return result;
}
