// ---------------------------------------------------------------------------
// User reporting hierarchy — the org-chart layer on top of RBAC.
// ---------------------------------------------------------------------------
// The 3-role RBAC matrix in `lib/rbac.ts` answers "what category of action
// is this user allowed to perform?". It does NOT answer "is this user
// allowed to perform that action *on this specific target user*?" — that
// requires the manager-chain.
//
// Data model: `User.managerId` is a self-reference. Null = root (the
// workspace owner / an unmanaged admin). The chain is walked up to find
// a user's ancestors, and BFS'd down to find a user's subtree.
//
// Hierarchy-aware RBAC combines BOTH signals:
//
//   canManageUser(actor, target) :=
//     actor.role === "ADMIN"                              // admins manage everyone
//     || actor.userId === target.userId                   // self-management (own profile)
//     || target is in actor's subtree                     // direct + transitive reports
//     || actor.outranks(target) && target has no manager  // legacy: peer-less unmanaged user
//
// The last clause is a backward-compatibility escape hatch for users
// created before the hierarchy existed (they have managerId = null) — a
// MANAGER can still manage an unmanaged MEMBER purely by rank. Once every
// user has a manager assigned, the chain check is authoritative.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { outranks, type Role } from "@/lib/rbac";
import { AuthorizationError } from "@/lib/server/authorization-error";

/**
 * Walk up the `managerId` chain from `userId` and return the ordered list
 * of ancestor user ids (immediate manager first, then their manager, …).
 * The list does NOT include `userId` itself. Capped at 32 hops as a
 * safety net against a cycle that should be prevented at write time but
 * might exist if the DB was hand-edited.
 */
export async function getManagerChain(userId: string): Promise<string[]> {
  const chain: string[] = [];
  let current: string | null = userId;
  for (let i = 0; i < 32 && current; i++) {
    const row: { managerId: string | null } | null = await db.user.findUnique({
      where: { id: current },
      select: { managerId: true },
    });
    if (!row || !row.managerId) break;
    if (row.managerId === userId) {
      // Cycle — shouldn't happen (write path prevents it) but bail out
      // rather than spinning forever.
      break;
    }
    chain.push(row.managerId);
    current = row.managerId;
  }
  return chain;
}

/**
 * BFS down the `managerId` tree from `userId` and return the set of user
 * ids in their subtree (including `userId` itself). Used to answer "which
 * users can this actor manage?". Caps at 1000 nodes as a sanity ceiling.
 */
export async function getSubtreeUserIds(userId: string): Promise<Set<string>> {
  const result = new Set<string>([userId]);
  const queue: string[] = [userId];
  while (queue.length > 0 && result.size < 1000) {
    const current = queue.shift()!;
    const reports = await db.user.findMany({
      where: { managerId: current },
      select: { id: true },
    });
    for (const r of reports) {
      if (!result.has(r.id)) {
        result.add(r.id);
        queue.push(r.id);
      }
    }
  }
  return result;
}

/**
 * The user's direct reports (one level down). Cheap — single indexed
 * query — so the Users page can show a "X reports" badge without
 * computing the full subtree.
 */
export async function getDirectReports(managerId: string): Promise<
  Array<{ id: string; name: string; role: string; email: string }>
> {
  return db.user.findMany({
    where: { managerId },
    select: { id: true, name: true, role: true, email: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Pure hierarchy predicate — given the actor's identity, the target's
 * identity, and the actor's subtree (pre-computed by `getSubtreeUserIds`),
 * decide whether the actor may manage the target.
 *
 * Kept pure (no DB) so it's trivially testable and composable. Callers
 * must pass the subtree they computed for the actor at the start of the
 * request — repeated DB walks inside a single permission check would be
 * wasteful.
 */
export function canManageUser(
  actor: { userId: string; role: Role },
  target: { userId: string; role: Role; managerId: string | null },
  actorSubtree: Set<string>,
): boolean {
  // Self-management is always allowed (subject to caller-side self-
  // protection rules like "cannot demote yourself").
  if (actor.userId === target.userId) return true;
  // Admins manage everyone.
  if (actor.role === "ADMIN") return true;
  // Members never manage other users.
  if (actor.role === "MEMBER") return false;
  // Managers: target must be in their subtree, OR they outrank an
  // unmanaged target (the legacy escape hatch for users with managerId
  // = null created before the hierarchy existed).
  if (actorSubtree.has(target.userId)) return true;
  if (target.managerId === null && outranks(actor.role, target.role)) return true;
  return false;
}

/**
 * Walk up from `userId` and throw an `AuthorizationError` if `newManagerId`
 * appears in the chain (i.e. the new manager is the user themselves or a
 * transitive report of theirs). This prevents creating a cycle in the
// manager graph.
 *
 * Call this BEFORE writing `managerId` to the DB.
 */
export async function assertNoCycle(userId: string, newManagerId: string | null | undefined): Promise<void> {
  if (!newManagerId) return;
  if (newManagerId === userId) {
    throw new AuthorizationError("A user cannot be their own manager.");
  }
  const chain = await getManagerChain(newManagerId);
  if (chain.includes(userId) || chain.includes(newManagerId) && chain[0] === userId) {
    throw new AuthorizationError(
      "Cannot set this manager — it would create a reporting cycle " +
      "(the proposed manager already reports to this user).",
    );
  }
  // Also check the forward direction: if newManagerId is already a
  // transitive report of userId, setting them as manager would loop.
  const subtree = await getSubtreeUserIds(userId);
  if (subtree.has(newManagerId)) {
    throw new AuthorizationError(
      "Cannot set this manager — they already report to this user (directly or transitively).",
    );
  }
}

/**
 * EM-B04/LV-B13 (S14) — resolve who decides one employee's leave requests.
 * Pure: the employee's explicit override outranks the reporting manager;
 * neither present = the caller's ADMIN fallback. Returns the winning
 * approver id (null = no personal approver) and where it came from.
 */
export function resolveLeaveApprover(input: {
  leaveApproverId?: string | null;
  managerId?: string | null;
}): { approverId: string | null; source: "OVERRIDE" | "MANAGER" | "NONE" } {
  if (input.leaveApproverId) return { approverId: input.leaveApproverId, source: "OVERRIDE" };
  if (input.managerId) return { approverId: input.managerId, source: "MANAGER" };
  return { approverId: null, source: "NONE" };
}
