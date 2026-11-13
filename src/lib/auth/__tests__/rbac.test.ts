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
} from "@/lib/auth/rbac";

describe("isValidRole", () => {
  it("accepts the five canonical roles", () => {
    expect(isValidRole("SUPER_ADMIN")).toBe(true);
    expect(isValidRole("ADMIN")).toBe(true);
    expect(isValidRole("MANAGER")).toBe(true);
    expect(isValidRole("MEMBER")).toBe(true);
    expect(isValidRole("HR")).toBe(true);
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

  it("grants SUPER_ADMIN every declared permission (the only statutory:manage holder)", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(hasPermission("SUPER_ADMIN", p.key)).toBe(true);
    }
    expect(hasPermission("SUPER_ADMIN", "statutory:manage")).toBe(true);
  });

  it("grants ADMIN every declared permission except statutory:manage (Phase 0)", () => {
    for (const p of ALL_PERMISSIONS) {
      const expected = p.key !== "statutory:manage";
      expect(hasPermission("ADMIN", p.key), `ADMIN × ${p.key}`).toBe(expected);
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

  // ---------------------------------------------------------------------
  // HR role (docs/HR_MODULE_PLAN.md) — people-operations powers ONLY:
  // hr:* + the MEMBER self-service baseline, no task/project authority.
  // ---------------------------------------------------------------------
  it("grants HR the hr:* family", () => {
    expect(hasPermission("HR", "hr:view")).toBe(true);
    expect(hasPermission("HR", "hr:admin")).toBe(true);
    expect(hasPermission("HR", "review:manage")).toBe(true);
    expect(hasPermission("HR", "onboarding:manage")).toBe(true);
    expect(hasPermission("HR", "leave:request")).toBe(true);
  });

  it("denies HR project/task/member authority", () => {
    const denied: Permission[] = [
      "task:create", "task:edit:any", "task:edit:own", "task:delete",
      "project:create", "project:edit", "project:delete",
      "member:invite", "member:edit", "member:delete",
      "role:manage", "audit:view",
      "bug:create", "bug:edit:any", "bug:edit:own", "bug:delete", "bug:assign",
    ];
    for (const p of denied) {
      expect(hasPermission("HR", p)).toBe(false);
    }
  });

  it("denies MEMBER the HR console and review/onboarding management", () => {
    expect(hasPermission("MEMBER", "hr:view")).toBe(false);
    expect(hasPermission("MEMBER", "hr:admin")).toBe(false);
    expect(hasPermission("MEMBER", "review:manage")).toBe(false);
    expect(hasPermission("MEMBER", "onboarding:manage")).toBe(false);
    expect(hasPermission("MEMBER", "leave:request")).toBe(true);
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

  it("ADMIN permissions are a subset of SUPER_ADMIN permissions (Phase 0)", () => {
    const superAdmin = new Set(ROLE_PERMISSIONS.SUPER_ADMIN);
    for (const p of ROLE_PERMISSIONS.ADMIN) {
      expect(superAdmin.has(p), `ADMIN-only permission: ${p}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// roleRank / outranks — used by the user-hierarchy helpers in lib/hierarchy.ts
// ---------------------------------------------------------------------------

describe("roleRank", () => {
  it("assigns SUPER_ADMIN > ADMIN > MANAGER > MEMBER", () => {
    expect(roleRank("SUPER_ADMIN")).toBeGreaterThan(roleRank("ADMIN"));
    expect(roleRank("ADMIN")).toBeGreaterThan(roleRank("MANAGER"));
    expect(roleRank("MANAGER")).toBeGreaterThan(roleRank("MEMBER"));
  });

  it("SUPER_ADMIN strictly outranks every other role (Phase 0)", () => {
    expect(outranks("SUPER_ADMIN", "ADMIN")).toBe(true);
    expect(outranks("SUPER_ADMIN", "HR")).toBe(true);
    expect(outranks("SUPER_ADMIN", "MANAGER")).toBe(true);
    expect(outranks("SUPER_ADMIN", "MEMBER")).toBe(true);
    expect(outranks("SUPER_ADMIN", "SUPER_ADMIN")).toBe(false);
    // ...and nobody reaches back up.
    expect(outranks("ADMIN", "SUPER_ADMIN")).toBe(false);
  });

  it("ranks HR at MANAGER level (strict outranks keeps them mutually unmanaged)", () => {
    expect(roleRank("HR")).toBe(roleRank("MANAGER"));
    expect(roleRank("HR")).toBeGreaterThan(roleRank("MEMBER"));
    expect(outranks("HR", "MANAGER")).toBe(false);
    expect(outranks("MANAGER", "HR")).toBe(false);
    expect(outranks("HR", "MEMBER")).toBe(true);
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

// ---------------------------------------------------------------------------
// R8 — the FULL permission matrix, pinned (docs/RECRUITMENT_MODULE_PLAN.md
// §5, milestone R8: "permission-matrix tests completed"). Every declared
// permission × every role, with the exact expected grant/deny. Any change to
// the matrix — adding a permission, granting it to a new role — must
// consciously update this table. This is the contract the RBAC editor's
// static floor enforces at runtime.
// ---------------------------------------------------------------------------

describe("permission matrix (full pin)", () => {
  // ✓ = granted, ✗ = denied. Columns: SUPER_ADMIN, ADMIN, HR, MANAGER, MEMBER.
  const MATRIX: Record<Permission, [boolean, boolean, boolean, boolean, boolean]> = {
    // Tasks & projects
    "task:create":        [true, true, false, true, true],
    "task:edit:own":      [true, true, false, true, true],
    "task:edit:any":      [true, true, false, true, false],
    "task:delete":        [true, true, false, false, false],
    "project:create":     [true, true, false, true, false],
    "project:edit":       [true, true, false, true, false],
    "project:delete":     [true, true, false, false, false],
    // Team
    "member:invite":      [true, true, false, true, false],
    "member:edit":        [true, true, false, false, false],
    "member:delete":      [true, true, false, false, false],
    // Communication & calendar
    "message:send":       [true, true, true, true, true],
    "event:create":       [true, true, false, true, false],
    "event:delete":       [true, true, false, true, false],
    // General
    "settings:edit":      [true, true, true, true, true],
    "role:manage":        [true, true, false, false, false],
    "analytics:view":     [true, true, true, true, true],
    "team:view":          [true, true, true, true, true],
    "audit:view":         [true, true, false, true, false],
    // Bugs
    "bug:create":         [true, true, false, true, true],
    "bug:edit:own":       [true, true, false, true, true],
    "bug:edit:any":       [true, true, false, true, false],
    "bug:delete":         [true, true, false, false, false],
    "bug:assign":         [true, true, false, true, false],
    // HR module
    "hr:view":            [true, true, true, true, false],
    "hr:admin":           [true, true, true, false, false],
    "leave:request":      [true, true, true, true, true],
    "review:manage":      [true, true, true, true, false],
    "onboarding:manage":  [true, true, true, false, false],
    // Recruitment module (docs/RECRUITMENT_MODULE_PLAN.md §3)
    "hiring:view":        [true, true, true, true, false],
    "hiring:manage":      [true, true, true, false, false],
    "hiring:config":      [true, true, true, false, false],
    // F2.10 — the four-eyes approver: MANAGER yes, HR (the composer's
    // role) no. ADMIN may approve but never its own composition
    // (approveOffer's composer check).
    "hiring:approve":     [true, true, false, true, false],
    "payroll:manage":     [true, true, true, false, false],
    // F1.3 — attendance records: HR/admin marking (docs/Fernly_HR_Payroll_
    // Enhancement_Plan.md §7.1, decision §9.1: no member self-marking).
    "attendance:manage":  [true, true, true, false, false],
    // NZ statutory engine (Phase 0) — SUPER_ADMIN only: plain ADMIN runs
    // payroll but never rewrites the statutory rate tables it computes from.
    "statutory:manage":    [true, false, false, false, false],
  };

  const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "HR", "MANAGER", "MEMBER"];

  it("every declared permission has a pinned row", () => {
    const declared = ALL_PERMISSIONS.map((p) => p.key).sort();
    const pinned = Object.keys(MATRIX).sort();
    expect(pinned).toEqual(declared);
  });

  it.each(ROLES)("matches the pinned grants for %s", (role) => {
    for (const [permission, grants] of Object.entries(MATRIX) as [Permission, boolean[]][]) {
      const idx = ROLES.indexOf(role);
      expect(
        hasPermission(role, permission),
        `${role} × ${permission}: expected ${grants[idx]}`,
      ).toBe(grants[idx]);
    }
  });

  it("MANAGER (the hiring interviewer) never reaches payroll or hiring manage", () => {
    expect(hasPermission("MANAGER", "payroll:manage")).toBe(false);
    expect(hasPermission("MANAGER", "hiring:manage")).toBe(false);
    expect(hasPermission("MANAGER", "hiring:config")).toBe(false);
    // ...but keeps the interviewer's read view.
    expect(hasPermission("MANAGER", "hiring:view")).toBe(true);
  });

  it("MEMBER holds no hiring or payroll permission at all", () => {
    for (const p of ["hiring:view", "hiring:manage", "hiring:config", "payroll:manage"] as Permission[]) {
      expect(hasPermission("MEMBER", p)).toBe(false);
    }
  });
});
