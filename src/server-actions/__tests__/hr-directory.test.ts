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
  it("creates a first profile row for the caller", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    const res = await upsertMyProfile({ jobTitle: "Frontend Engineer", department: "ENGINEERING", phone: "+64 21 555 0003" });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        create: expect.objectContaining({ userId: "u-theo", jobTitle: "Frontend Engineer" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "profile.updated", entityType: "EMPLOYEE_PROFILE" }),
    );
  });

  it("rejects an unknown department", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    const res = await upsertMyProfile({ department: "LEGAL" as never });
    expect(res.ok).toBe(false);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
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
});
