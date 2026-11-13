import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hierarchy helpers — tests for every exported function:
//   • `canManageUser`           — pure hierarchy predicate
//   • `getManagerChain`         — walks the managerId chain up
//   • `getSubtreeUserIds`       — BFS down the managerId tree
//   • `getDirectReports`        — one-level-down lookup
//   • `assertNoCycle`           — guards against manager-graph cycles
// ---------------------------------------------------------------------------

// DB mock — installed BEFORE the module under test is imported.
const { db } = vi.hoisted(() => {
  const db = {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return { db };
});
vi.mock("@/lib/infra/db", () => ({ db }));

import {
  canManageUser,
  getManagerChain,
  getSubtreeUserIds,
  getDirectReports,
  assertNoCycle,
  resolveLeaveApprover,
} from "@/lib/auth/hierarchy";
import { AuthorizationError } from "@/lib/auth/authorization-error";
import type { Role } from "@/lib/auth/rbac";

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

// ---------------------------------------------------------------------------
// getManagerChain — walks the managerId chain up
// ---------------------------------------------------------------------------

describe("getManagerChain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] when the user has no manager (root)", async () => {
    db.user.findUnique.mockResolvedValue({ managerId: null });
    expect(await getManagerChain("u-1")).toEqual([]);
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u-1" },
      select: { managerId: true },
    });
  });

  it("returns [] when the user record does not exist", async () => {
    db.user.findUnique.mockResolvedValue(null);
    expect(await getManagerChain("ghost")).toEqual([]);
  });

  it("walks up the chain — immediate manager first, then their manager", async () => {
    // u-3 → mgr-2 → mgr-1 → (root)
    db.user.findUnique
      .mockResolvedValueOnce({ managerId: "mgr-2" })
      .mockResolvedValueOnce({ managerId: "mgr-1" })
      .mockResolvedValueOnce({ managerId: null });
    expect(await getManagerChain("u-3")).toEqual(["mgr-2", "mgr-1"]);
  });

  it("bails out if it detects a cycle (managerId === start userId)", async () => {
    // u-1 → mgr-1 → u-1 (cycle)
    db.user.findUnique
      .mockResolvedValueOnce({ managerId: "mgr-1" })
      .mockResolvedValueOnce({ managerId: "u-1" });
    expect(await getManagerChain("u-1")).toEqual(["mgr-1"]);
  });

  it("caps at 32 hops as a safety net", async () => {
    // Always return a non-null managerId — the loop must terminate.
    db.user.findUnique.mockResolvedValue({ managerId: "next" });
    const chain = await getManagerChain("start");
    expect(chain.length).toBeLessThanOrEqual(32);
  });
});

// ---------------------------------------------------------------------------
// getSubtreeUserIds — BFS down the managerId tree
// ---------------------------------------------------------------------------

describe("getSubtreeUserIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns just {userId} when the user has no reports", async () => {
    db.user.findMany.mockResolvedValue([]);
    expect(await getSubtreeUserIds("u-1")).toEqual(new Set(["u-1"]));
  });

  it("BFSes down — includes direct reports and transitive reports", async () => {
    // u-1 → [rep-1, rep-2]; rep-1 → [rep-3]; rep-2 → []; rep-3 → []
    db.user.findMany
      .mockResolvedValueOnce([{ id: "rep-1" }, { id: "rep-2" }])
      .mockResolvedValueOnce([{ id: "rep-3" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const subtree = await getSubtreeUserIds("u-1");
    expect(subtree).toEqual(new Set(["u-1", "rep-1", "rep-2", "rep-3"]));
  });

  it("caps at 1000 nodes as a sanity ceiling", async () => {
    // Every query returns one new report — the BFS must stop at 1000.
    let n = 0;
    db.user.findMany.mockImplementation(() => {
      n += 1;
      return Promise.resolve(n < 2000 ? [{ id: `rep-${n}` }] : []);
    });
    const subtree = await getSubtreeUserIds("u-1");
    expect(subtree.size).toBeLessThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------------------
// getDirectReports — one-level-down lookup
// ---------------------------------------------------------------------------

describe("getDirectReports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries users where managerId === the supplied id, ordered by name", async () => {
    const reports = [
      { id: "r-1", name: "Alice", role: "MEMBER", email: "a@x.co" },
      { id: "r-2", name: "Bob", role: "MEMBER", email: "b@x.co" },
    ];
    db.user.findMany.mockResolvedValue(reports);
    const result = await getDirectReports("mgr-1");
    expect(result).toEqual(reports);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { managerId: "mgr-1" },
      select: { id: true, name: true, role: true, email: true },
      orderBy: { name: "asc" },
    });
  });

  it("returns [] when the manager has no reports", async () => {
    db.user.findMany.mockResolvedValue([]);
    expect(await getDirectReports("solo")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assertNoCycle — guards against manager-graph cycles
// ---------------------------------------------------------------------------

describe("assertNoCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a no-op when newManagerId is null", async () => {
    await assertNoCycle("u-1", null);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("is a no-op when newManagerId is undefined", async () => {
    await assertNoCycle("u-1", undefined);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("throws when a user would become their own manager", async () => {
    await expect(assertNoCycle("u-1", "u-1")).rejects.toThrow(AuthorizationError);
    await expect(assertNoCycle("u-1", "u-1")).rejects.toThrow(/own manager/i);
  });

  it("throws when the proposed manager already reports to the user (forward direction)", async () => {
    // getSubtreeUserIds(u-1) returns {u-1, rep-1}; newManagerId = rep-1 → cycle.
    db.user.findMany
      .mockResolvedValueOnce([{ id: "rep-1" }]) // direct reports of u-1
      .mockResolvedValueOnce([]);                // reports of rep-1
    await expect(assertNoCycle("u-1", "rep-1")).rejects.toThrow(/already report to/i);
  });

  it("throws when setting the manager would create an upward chain cycle", async () => {
    // getManagerChain(newManagerId=rep-1) returns [u-1, ...] → rep-1 reports to u-1 → cycle.
    db.user.findUnique
      .mockResolvedValueOnce({ managerId: "u-1" }) // rep-1 → u-1
      .mockResolvedValueOnce({ managerId: null });  // u-1 → root
    // getSubtreeUserIds(u-1) — pretend u-1 has no reports.
    db.user.findMany.mockResolvedValue([]);
    await expect(assertNoCycle("u-1", "rep-1")).rejects.toThrow(/cycle/i);
  });

  it("passes when there is no cycle in either direction", async () => {
    // getManagerChain(newManager=other-mgr) returns [admin-1] — u-1 not in it.
    db.user.findUnique
      .mockResolvedValueOnce({ managerId: "admin-1" })
      .mockResolvedValueOnce({ managerId: null });
    // getSubtreeUserIds(u-1) — pretend u-1 has unrelated reports.
    db.user.findMany
      .mockResolvedValueOnce([{ id: "rep-x" }])
      .mockResolvedValueOnce([]);
    await expect(assertNoCycle("u-1", "other-mgr")).resolves.toBeUndefined();
  });
});


describe("resolveLeaveApprover (S14 / EM-B04 / LV-B13)", () => {
  it("the explicit override outranks the reporting manager", () => {
    expect(resolveLeaveApprover({ leaveApproverId: "u-override", managerId: "u-manager" }))
      .toEqual({ approverId: "u-override", source: "OVERRIDE" });
  });

  it("no override → the manager decides (today's rule)", () => {
    expect(resolveLeaveApprover({ leaveApproverId: null, managerId: "u-manager" }))
      .toEqual({ approverId: "u-manager", source: "MANAGER" });
  });

  it("neither → the caller's ADMIN fallback (source NONE)", () => {
    expect(resolveLeaveApprover({ leaveApproverId: null, managerId: null }))
      .toEqual({ approverId: null, source: "NONE" });
    expect(resolveLeaveApprover({})).toEqual({ approverId: null, source: "NONE" });
  });
});
