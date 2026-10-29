import { describe, it, expect } from "vitest";
import {
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  ALL_PERMISSIONS,
  hasPermission,
  isValidRole,
  roleRank,
  outranks,
  type Role,
  type Permission,
} from "@/lib/rbac";

describe("isValidRole", () => {
  it("accepts the three canonical roles", () => {
    expect(isValidRole("ADMIN")).toBe(true);
    expect(isValidRole("MANAGER")).toBe(true);
    expect(isValidRole("MEMBER")).toBe(true);
  });

  it("rejects arbitrary strings, case variants and empty input", () => {
    expect(isValidRole("admin")).toBe(false);
    expect(isValidRole("SUPERUSER")).toBe(false);
    expect(isValidRole("")).toBe(false);
  });
});

describe("hasPermission", () => {
  it("returns false for null/undefined roles", () => {
    expect(hasPermission(null, "task:create")).toBe(false);
    expect(hasPermission(undefined, "task:create")).toBe(false);
  });

  it("grants ADMIN every declared permission", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(hasPermission("ADMIN", p.key)).toBe(true);
    }
  });

  it("denies MEMBER destructive permissions", () => {
    const denied: Permission[] = [
      "task:delete",
      "project:delete",
      "project:create",
      "member:delete",
      "role:manage",
      "audit:view",
      "member:edit",
    ];
    for (const p of denied) {
      expect(hasPermission("MEMBER", p)).toBe(false);
    }
  });

  it("grants MEMBER only its own permission set", () => {
    const memberPerms = ROLE_PERMISSIONS.MEMBER;
    for (const p of ALL_PERMISSIONS) {
      const expected = memberPerms.includes(p.key);
      expect(hasPermission("MEMBER", p.key)).toBe(expected);
    }
  });

  it("gives MANAGER edit-any but not delete or role management", () => {
    expect(hasPermission("MANAGER", "task:edit:any")).toBe(true);
    expect(hasPermission("MANAGER", "task:delete")).toBe(false);
    expect(hasPermission("MANAGER", "project:delete")).toBe(false);
    expect(hasPermission("MANAGER", "role:manage")).toBe(false);
  });
});

describe("role matrix sanity", () => {
  it("labels and descriptions exist for every role", () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });

  it("every permission key in the matrix is declared in ALL_PERMISSIONS", () => {
    const declared = new Set(ALL_PERMISSIONS.map((p) => p.key));
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) {
        expect(declared.has(p), `undeclared permission: ${p}`).toBe(true);
      }
    }
  });

  it("MEMBER permissions are a subset of MANAGER permissions", () => {
    const manager = new Set(ROLE_PERMISSIONS.MANAGER);
    for (const p of ROLE_PERMISSIONS.MEMBER) {
      expect(manager.has(p), `MEMBER-only permission: ${p}`).toBe(true);
    }
  });

  it("MANAGER permissions are a subset of ADMIN permissions", () => {
    const admin = new Set(ROLE_PERMISSIONS.ADMIN);
    for (const p of ROLE_PERMISSIONS.MANAGER) {
      expect(admin.has(p), `MANAGER-only permission: ${p}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// roleRank / outranks — used by the user-hierarchy helpers in lib/hierarchy.ts
// ---------------------------------------------------------------------------

describe("roleRank", () => {
  it("assigns ADMIN > MANAGER > MEMBER", () => {
    expect(roleRank("ADMIN")).toBeGreaterThan(roleRank("MANAGER"));
    expect(roleRank("MANAGER")).toBeGreaterThan(roleRank("MEMBER"));
  });

  it("returns 0 for unknown / missing roles", () => {
    expect(roleRank("UNKNOWN")).toBe(0);
    expect(roleRank(undefined)).toBe(0);
    expect(roleRank(null)).toBe(0);
    expect(roleRank("")).toBe(0);
  });
});

describe("outranks", () => {
  it("ADMIN outranks MANAGER and MEMBER", () => {
    expect(outranks("ADMIN", "MANAGER")).toBe(true);
    expect(outranks("ADMIN", "MEMBER")).toBe(true);
  });

  it("MANAGER outranks MEMBER only", () => {
    expect(outranks("MANAGER", "MEMBER")).toBe(true);
    expect(outranks("MANAGER", "ADMIN")).toBe(false);
  });

  it("is strict — same rank is NOT outranking", () => {
    expect(outranks("ADMIN", "ADMIN")).toBe(false);
    expect(outranks("MANAGER", "MANAGER")).toBe(false);
    expect(outranks("MEMBER", "MEMBER")).toBe(false);
  });
});
