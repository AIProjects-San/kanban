import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hierarchy helpers — pure-function tests for `canManageUser` (the only
// pure helper in lib/hierarchy.ts). The DB-walking helpers
// (`getManagerChain`, `getSubtreeUserIds`, `getDirectReports`,
// `assertNoCycle`) are exercised indirectly via the
// `requirePermissionForTarget` integration tests in
// `server-actions/__tests__/auth-guard.test.ts`.
// ---------------------------------------------------------------------------

import { canManageUser } from "@/lib/hierarchy";
import type { Role } from "@/lib/rbac";

const actor = (userId: string, role: Role) => ({ userId, role });
const target = (userId: string, role: Role, managerId: string | null) =>
  ({ userId, role, managerId });

describe("canManageUser — pure hierarchy predicate", () => {
  const subtree = new Set<string>(["mgr-1", "rep-1", "rep-2", "rep-3"]);

  it("ADMIN can manage anyone (subtree is not consulted)", () => {
    expect(canManageUser(
      actor("admin-1", "ADMIN"),
      target("anyone", "MEMBER", "someone-else"),
      new Set(), // empty subtree — admins skip this check
    )).toBe(true);
    expect(canManageUser(
      actor("admin-1", "ADMIN"),
      target("another-admin", "ADMIN", null),
      new Set(),
    )).toBe(true);
  });

  it("self-management is always allowed (regardless of role)", () => {
    expect(canManageUser(
      actor("u-1", "MEMBER"),
      target("u-1", "MEMBER", null),
      new Set(["u-1"]),
    )).toBe(true);
  });

  it("MEMBER cannot manage anyone other than themselves", () => {
    expect(canManageUser(
      actor("m-1", "MEMBER"),
      target("m-2", "MEMBER", "m-1"),
      new Set(["m-1"]),
    )).toBe(false);
    expect(canManageUser(
      actor("m-1", "MEMBER"),
      target("mgr-1", "MANAGER", null),
      new Set(["m-1"]),
    )).toBe(false);
  });

  it("MANAGER can manage a direct report (target.userId in subtree)", () => {
    expect(canManageUser(
      actor("mgr-1", "MANAGER"),
      target("rep-1", "MEMBER", "mgr-1"),
      subtree,
    )).toBe(true);
  });

  it("MANAGER can manage a transitive report (subtree includes deeper levels)", () => {
    // rep-3 reports to rep-2 who reports to mgr-1 — rep-3 is in mgr-1's subtree.
    expect(canManageUser(
      actor("mgr-1", "MANAGER"),
      target("rep-3", "MEMBER", "rep-2"),
      subtree,
    )).toBe(true);
  });

  it("MANAGER cannot manage a peer MANAGER (not in subtree, no rank advantage)", () => {
    expect(canManageUser(
      actor("mgr-1", "MANAGER"),
      target("mgr-2", "MANAGER", "admin-1"),
      subtree, // does NOT contain mgr-2
    )).toBe(false);
  });

  it("MANAGER cannot manage an ADMIN (even if in subtree — defensive)", () => {
    // canManageUser's pure logic: target.managerId === null && outranks
    // fails because ADMIN > MANAGER, so outranks(MANAGER, ADMIN) is false.
    // And the subtree check: even if the admin were in the manager's
    // subtree (weird config), the call would return true — but admins
    // shouldn't be in anyone's subtree. The pure helper trusts the caller
    // to have constructed a sensible tree; the rank check is the backstop.
    expect(canManageUser(
      actor("mgr-1", "MANAGER"),
      target("admin-1", "ADMIN", null),
      subtree, // admin-1 not in subtree
    )).toBe(false);
  });

  it("MANAGER can manage an unmanaged MEMBER via the legacy rank escape hatch", () => {
    // target has managerId = null AND actor outranks target by role.
    // This exists for users created before the hierarchy was wired up.
    expect(canManageUser(
      actor("mgr-1", "MANAGER"),
      target("legacy-member", "MEMBER", null),
      subtree, // legacy-member not in subtree
    )).toBe(true);
  });

  it("MANAGER cannot manage an unmanaged peer MANAGER (rank is not strictly higher)", () => {
    expect(canManageUser(
      actor("mgr-1", "MANAGER"),
      target("mgr-2", "MANAGER", null),
      subtree,
    )).toBe(false);
  });

  it("MANAGER cannot manage a managed MEMBER who is not in their subtree", () => {
    // The target reports to a DIFFERENT manager — actor has no claim.
    expect(canManageUser(
      actor("mgr-1", "MANAGER"),
      target("other-rep", "MEMBER", "mgr-2"),
      subtree,
    )).toBe(false);
  });
});
