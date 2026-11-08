import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HR module feature 2 — employee directory action tests
// (docs/HR_MODULE_PLAN.md §5): read scoping, self-service vs hr:admin edit
// splits, department validation, deleted-user filtering.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["employeeProfile", "user", "auditLog"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

// PR-56 — partial mock for ONE drift-simulation test below (everything but
// DEPARTMENT_LABELS stays real). The unknown-department guard in
// updateProfileAsAdmin (hr-directory.ts:188-189) is defensive against
// validation.ts's zod enum and config.ts's DEPARTMENT_LABELS ever drifting
// apart — with both real, the schema already rejects every unknown
// department before the guard can see it. Simulating the drift (config
// drops "DESIGN" while validation still accepts it) pins the guard. No
// existing test in this file passes a department, so nothing else changes.
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    DEPARTMENT_LABELS: actual.DEPARTMENT_LABELS.filter((d) => d.key !== "DESIGN"),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getDirectory, getMyProfile, upsertMyProfile, updateProfileAsAdmin } from "../hr-directory";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const MANAGER_AUTH = { userId: "u-mgr", role: "MANAGER" as const, name: "Ingrid", email: "ingrid@x.co" };
const MEMBER_AUTH = { userId: "u-theo", role: "MEMBER" as const, name: "Theo", email: "theo@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const PROFILE_ROW = {
  id: "ep-1",
  userId: "u-theo",
  jobTitle: "Senior Frontend Engineer",
  department: "ENGINEERING",
  hireDate: new Date("2024-06-10T00:00:00.000Z"),
  phone: "+64 21 555 0003",
  location: "Auckland, NZ",
  emergencyContactName: "Rae Vance",
  emergencyContactPhone: "+64 21 555 0199",
  skills: "React, TypeScript",
  notes: "HR note",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  db.employeeProfile.findMany.mockResolvedValue([]);
  db.employeeProfile.findUnique.mockResolvedValue(null);
  db.employeeProfile.upsert.mockResolvedValue({});
  db.user.findMany.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue(null);
});

describe("getDirectory", () => {
  it("requires hr:view (a MEMBER is rejected)", async () => {
    requirePermissionMock.mockImplementation(async (perm: string) => {
      if (perm === "hr:view") {
        throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      }
      return MEMBER_AUTH;
    });
    const res = await getDirectory();
    expect(res.ok).toBe(false);
  });

  it("maps rows with the org-chart manager name and hides deleted users", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.employeeProfile.findMany.mockResolvedValue([PROFILE_ROW, { ...PROFILE_ROW, id: "ep-2", userId: "u-gone" }]);
    db.user.findMany.mockResolvedValue([
      { id: "u-theo", name: "Theo Vance", email: "theo@fernly.app", role: "MEMBER", managerId: "u-mgr" },
      { id: "u-mgr", name: "Ingrid Solberg", email: "ingrid@fernly.app", role: "MANAGER", managerId: null },
      // u-gone is absent → its profile is filtered out
    ]);
    const res = await getDirectory();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.profiles).toHaveLength(1);
      expect(res.data.profiles[0]).toMatchObject({
        name: "Theo Vance",
        managerName: "Ingrid Solberg",
        jobTitle: "Senior Frontend Engineer",
        hireDate: "2024-06-10",
      });
      expect(res.data.canAdmin).toBe(false); // MANAGER: read-only directory
    }
  });
});

describe("getMyProfile", () => {
  it("returns null when no profile row exists yet", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    const res = await getMyProfile();
    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toBeNull();
  });

  it("serializes the caller's profile with the manager name", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.employeeProfile.findUnique.mockResolvedValue(PROFILE_ROW);
    db.user.findUnique.mockResolvedValueOnce({ name: "Theo Vance", email: "theo@fernly.app", role: "MEMBER", managerId: "u-mgr" });
    db.user.findUnique.mockResolvedValueOnce({ name: "Ingrid Solberg" });
    const res = await getMyProfile();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data?.managerName).toBe("Ingrid Solberg");
      expect(res.data?.skills).toBe("React, TypeScript");
    }
  });
});

describe("upsertMyProfile", () => {
  it("creates a first profile row for the caller — job data gets neutral defaults", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    const res = await upsertMyProfile({ phone: "+64 21 555 0003" });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        // QA-10 + QA-19: a self-created profile starts with EMPTY job data
        // — HR fills in title/department/hireDate later via the admin path.
        // The department used to default to "ENGINEERING", fabricating
        // HR-owned classification the roster then displayed as fact.
        create: expect.objectContaining({ userId: "u-theo", jobTitle: "", department: "", hireDate: null }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "profile.updated", entityType: "EMPLOYEE_PROFILE" }),
    );
  });

  // QA-19 — QA-10 emptied jobTitle/hireDate on the self-create path but
  // left department stamping "ENGINEERING" (the column default + an
  // explicit value). Every member who self-created a profile showed up
  // in the shared roster as "Engineering", whatever they actually do.
  it("QA-19: a self-created profile never fabricates a department", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    const res = await upsertMyProfile({ location: "Auckland, NZ" });
    expect(res.ok).toBe(true);
    const call = db.employeeProfile.upsert.mock.calls[0][0];
    expect(call.create.department).toBe("");
  });

  // QA-10 — self-service is contact-fields-only (docs/HR_MODULE_PLAN.md §5:
  // "Self-service edit of own contact fields; HR/ADMIN edit everything").
  // The strict schema must reject HR-owned keys outright.
  it("QA-10: rejects self-service attempts to write HR-owned fields", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    for (const smuggle of [
      { jobTitle: "CTO" },
      { department: "MANAGEMENT" },
      { hireDate: "2020-01-01" },
      { notes: "self-promoted" },
    ]) {
      const res = await upsertMyProfile(smuggle as never);
      expect(res.ok).toBe(false);
    }
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  it("QA-10: a legitimate self-service save never carries job data in the update payload", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    const res = await upsertMyProfile({ phone: "+64 21 555 0003", skills: "React" });
    expect(res.ok).toBe(true);
    const call = db.employeeProfile.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ phone: "+64 21 555 0003", skills: "React" });
    expect("jobTitle" in call.update).toBe(false);
    expect("department" in call.update).toBe(false);
    expect("hireDate" in call.update).toBe(false);
  });
});

describe("updateProfileAsAdmin", () => {
  it("requires hr:admin (a MANAGER cannot edit others' profiles)", async () => {
    requirePermissionMock.mockImplementation(async (perm: string) => {
      if (perm === "hr:admin") {
        throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      }
      return MANAGER_AUTH;
    });
    const res = await updateProfileAsAdmin("u-theo", { jobTitle: "X" });
    expect(res.ok).toBe(false);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  it("HR edits any profile including the HR-only notes field", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const res = await updateProfileAsAdmin("u-theo", { notes: "Probation ended." });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        update: expect.objectContaining({ notes: "Probation ended." }),
      }),
    );
  });

  // QA-19 (admin side) — the admin upsert create-branch also defaulted
  // the department to "ENGINEERING" when HR saved a profile without
  // picking one. "" must mean "not classified yet", rendered as "—".
  it("QA-19: the admin create-branch without a department leaves it unset", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const res = await updateProfileAsAdmin("u-theo", { jobTitle: "Senior FE", phone: "+64 21 555 0001" });
    expect(res.ok).toBe(true);
    const call = db.employeeProfile.upsert.mock.calls[0][0];
    expect(call.create.department).toBe("");
  });

  it("S14 — sets the leave-approver override (validated target) and clears it with null", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    // First call: the TARGET; second: the APPROVER candidate.
    db.user.findUnique
      .mockResolvedValueOnce({ id: "u-theo", name: "Theo Vance", deletedAt: null })
      .mockResolvedValueOnce({ id: "u-remy", name: "Remy Laurent", deletedAt: null });
    const res = await updateProfileAsAdmin("u-theo", { leaveApproverId: "u-remy" });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        update: expect.objectContaining({ leaveApproverId: "u-remy" }),
      }),
    );

    // Clearing: null rides both branches.
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const clear = await updateProfileAsAdmin("u-theo", { leaveApproverId: null });
    expect(clear.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ leaveApproverId: null }),
      }),
    );
  });

  it("S14 — self-override and ghost approver are refused with friendly errors", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const self = await updateProfileAsAdmin("u-theo", { leaveApproverId: "u-theo" });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toContain("their own leave approver");

    db.user.findUnique
      .mockResolvedValueOnce({ id: "u-theo", name: "Theo Vance", deletedAt: null })
      .mockResolvedValueOnce(null);
    const ghost = await updateProfileAsAdmin("u-theo", { leaveApproverId: "u-ghost" });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error).toContain("Leave approver not found");
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown target user", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue(null);
    const res = await updateProfileAsAdmin("u-ghost", { jobTitle: "X" });
    expect(res.ok).toBe(false);
  });

  it("rejects a soft-deleted target user", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-x", name: "X", deletedAt: new Date() });
    const res = await updateProfileAsAdmin("u-x", { jobTitle: "X" });
    expect(res.ok).toBe(false);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  // F1.6 — the three PLAIN employment facts are HR-editable facts; the
  // STATUS itself never flows through this action (its strict schema
  // rejects the key) — only the guarded transitionEmployment writes it.
  it("F1.6: HR saves the plain employment facts (probation end, notice weeks, LWD)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const res = await updateProfileAsAdmin("u-theo", {
      probationEndsAt: "2026-12-01",
      noticePeriodWeeks: 4,
      lastWorkingDay: null,
    });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        update: expect.objectContaining({
          probationEndsAt: new Date("2026-12-01T00:00:00.000Z"),
          noticePeriodWeeks: 4,
          lastWorkingDay: null, // explicit null clears
        }),
      }),
    );
  });

  it("F1.6: a plain profile save CANNOT set employmentStatus — strict schema rejects the key", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const res = await updateProfileAsAdmin("u-theo", {
      employmentStatus: "ACTIVE",
    } as never);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/employmentStatus/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });
});

describe("upsert update paths (partial fields)", () => {
  it("upsertMyProfile updates an existing row with only the changed fields", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    const res = await upsertMyProfile({ phone: "+64 21 555 9999" });
    expect(res.ok).toBe(true);
    const call = db.employeeProfile.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "u-theo" });
    expect(call.update).toEqual({ phone: "+64 21 555 9999" });
  });

  it("QA-10: self-service cannot clear the hire date — that is HR-owned now", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    const res = await upsertMyProfile({ hireDate: null } as never);
    expect(res.ok).toBe(false);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  it("updateProfileAsAdmin (HR) clears the hire date when explicitly null", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const res = await updateProfileAsAdmin("u-theo", { hireDate: null });
    expect(res.ok).toBe(true);
    const call = db.employeeProfile.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ hireDate: null });
  });

  it("updateProfileAsAdmin updates partially and keeps other fields", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const res = await updateProfileAsAdmin("u-theo", { skills: "Rust" });
    expect(res.ok).toBe(true);
    const call = db.employeeProfile.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ skills: "Rust" });
  });
});

// ---------------------------------------------------------------------------
// PR-56 — remaining branch coverage: the null-manager arms of the org-chart
// resolver, the vanished-user guard in getMyProfile, and the department
// guard in updateProfileAsAdmin (incl. the validation↔config drift it
// defends against).
// ---------------------------------------------------------------------------

describe("PR-56 — remaining branch coverage", () => {
  // hr-directory.ts:63 — managerNameOf's null-manager arm: a rostered user
  // with NO manager, plus (line 64's ?? null arm) one whose manager row is
  // gone from the user list.
  it("pins hr-directory.ts:63-64 — users with no manager (or a vanished manager) serialize with managerName null", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.employeeProfile.findMany.mockResolvedValue([
      { ...PROFILE_ROW, id: "ep-1", userId: "u-lone" }, // managerId: null
      { ...PROFILE_ROW, id: "ep-2", userId: "u-orphan" }, // manager is deleted
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-lone", name: "Lone Wolf", email: "lone@x.co", role: "MEMBER", managerId: null },
      { id: "u-orphan", name: "Orphan Kane", email: "orphan@x.co", role: "MEMBER", managerId: "u-gone" },
      // u-gone is absent → usersById.get(u-gone) misses → ?? null
    ]);
    const res = await getDirectory();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.profiles).toHaveLength(2);
      expect(res.data.profiles.find((p) => p.userId === "u-lone")?.managerName).toBeNull();
      expect(res.data.profiles.find((p) => p.userId === "u-orphan")?.managerName).toBeNull();
    }
  });

  // hr-directory.ts:108 — the profile row exists but the caller's user row
  // is gone: serialize as null rather than crash on a missing user.
  it("pins hr-directory.ts:108 — getMyProfile returns null when the profile's user row is missing", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.employeeProfile.findUnique.mockResolvedValue(PROFILE_ROW);
    db.user.findUnique.mockResolvedValue(null); // the user vanished between the two reads
    const res = await getMyProfile();
    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toBeNull();
  });

  // hr-directory.ts:188-189 — a department the label set no longer knows is
  // refused. With the REAL modules the zod enum already blocks every unknown
  // department, so this test simulates the drift the guard exists for (the
  // partial @/lib/config mock at the top of this file drops "DESIGN") and
  // proves the action still refuses the save instead of persisting a
  // department the roster cannot render.
  it("pins hr-directory.ts:189 — an unknown department is rejected even when validation and config drift apart", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await updateProfileAsAdmin("u-theo", { department: "DESIGN" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/unknown department/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  // Companion to the drift test above: a department that IS still in the
  // (mocked) label set must keep saving — proves the mock is surgical and
  // the happy-path department write (no existing test passed one) works.
  it("pins hr-directory.ts:188 (false arm) — a known department still saves through the admin path", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const res = await updateProfileAsAdmin("u-theo", { department: "ENGINEERING" });
    expect(res.ok).toBe(true);
    const call = db.employeeProfile.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ department: "ENGINEERING" });
  });
});
