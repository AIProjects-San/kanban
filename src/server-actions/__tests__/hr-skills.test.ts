import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P37 (EM-19, PF-07, EM-18) — the skill master + employee skill maps:
// the action layer (master CRUD, the map read + the rating upsert).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["skill", "employeeSkill", "user", "auditLog"];
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

vi.mock("@/lib/infra/db", () => ({ db }));

const requirePermissionMock = vi.fn();
const checkPermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  checkPermission: (...a: unknown[]) => checkPermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  getSkills,
  saveSkill,
  deleteSkill,
  getSkillMap,
  upsertEmployeeSkill,
  removeEmployeeSkill,
} from "../hr-skills";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MEMBER_AUTH = { userId: "u-diego", role: "MEMBER" as const, name: "Diego", email: "diego@x.co" };

const SKILL = { id: "sk-1", key: "react", label: "React", description: "", isActive: true, sortOrder: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  checkPermissionMock.mockResolvedValue(false);
  db.user.findUnique.mockResolvedValue({ id: "u-diego", name: "Diego Morales", deletedAt: null });
  db.user.findMany.mockResolvedValue([{ id: "u-diego", name: "Diego Morales" }]);
  db.skill.findUnique.mockResolvedValue(SKILL);
  db.skill.findMany.mockResolvedValue([SKILL]);
  db.skill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sk-new", ...data }));
  db.skill.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sk-1", ...data }));
  db.skill.delete.mockResolvedValue(SKILL);
  db.employeeSkill.findMany.mockResolvedValue([]);
  db.employeeSkill.findUnique.mockResolvedValue(null);
  db.employeeSkill.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: "es-1", ...create }));
  db.employeeSkill.delete.mockResolvedValue({});
});

describe("the master (EM-19/PF-07)", () => {
  it("getSkills requires hr:view (a MEMBER is refused)", async () => {
    requirePermissionMock.mockImplementation(async (perm: string) => {
      if (perm === "hr:view") throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      return MEMBER_AUTH;
    });
    const res = await getSkills();
    expect(res.ok).toBe(false);
  });

  it("saveSkill creates (hr:admin) with the audit row", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await saveSkill({ key: "react", label: "React", sortOrder: 10 });
    expect(res.ok).toBe(true);
    expect(db.skill.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ key: "react" }) }));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hr.skill_saved" }));
  });

  it("saveSkill edits by id", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await saveSkill({ id: "sk-1", key: "react", label: "React 19", description: "upd" });
    expect(res.ok).toBe(true);
    expect(db.skill.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sk-1" } }));
  });

  it("validation bounds: empty label / bad key shape refuse", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const badLabel = await saveSkill({ key: "x", label: "  " });
    expect(badLabel.ok).toBe(false);
    const badKey = await saveSkill({ key: "Not Ok!", label: "X" });
    expect(badKey.ok).toBe(false);
  });

  it("deleteSkill removes the master row (maps keep their snapshots)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await deleteSkill({ id: "sk-1" });
    expect(res.ok).toBe(true);
    expect(db.skill.delete).toHaveBeenCalledWith({ where: { id: "sk-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hr.skill_deleted" }));
  });
});

describe("the map read (EM-18)", () => {
  it("a member without a userId gets their own map (self mode)", async () => {
    const res = await getSkillMap({});
    expect(res.ok).toBe(true);
    expect(db.employeeSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-diego" } }),
    );
    if (res.ok) expect(res.data.canManage).toBe(false);
  });

  it("a member cannot read another employee's map", async () => {
    const res = await getSkillMap({ userId: "u-hana" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/your own/i);
  });

  it("an hr:view holder reads any map + the ACTIVE master; entries carry the derived proficiency", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    checkPermissionMock.mockResolvedValue(true);
    db.employeeSkill.findMany.mockResolvedValue([
      { id: "es-1", userId: "u-diego", skillKey: "react", label: "React", rating: 5, notes: "owns review", assessedById: "u-hr", assessedAt: new Date() },
    ]);
    const res = await getSkillMap({ userId: "u-diego" });
    expect(res.ok).toBe(true);
    expect(db.skill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
    if (res.ok) {
      expect(res.data.entries[0]).toMatchObject({ label: "React", rating: 5, proficiency: "Expert" });
      expect(res.data.summary).toBe("1 skill · avg 5 (Expert)");
    }
  });
});

describe("the rating write (EM-18)", () => {
  it("HR rates a skill — the upsert with the label snapshot + assessor", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await upsertEmployeeSkill({ userId: "u-diego", skillKey: "react", rating: 4, notes: "growing" });
    expect(res.ok).toBe(true);
    expect(db.employeeSkill.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_skillKey: { userId: "u-diego", skillKey: "react" } },
        create: expect.objectContaining({ label: "React", rating: 4, assessedById: "u-hr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee_skill_rated", detail: expect.stringContaining("4/5 (Advanced)") }),
    );
  });

  it("refuses an unknown or inactive skill; refuses a ghost employee", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.skill.findUnique.mockResolvedValue({ ...SKILL, isActive: false });
    const inactive = await upsertEmployeeSkill({ userId: "u-diego", skillKey: "react", rating: 3 });
    expect(inactive.ok).toBe(false);
    expect(inactive.ok === false && inactive.error).toMatch(/inactive skill/i);

    db.skill.findUnique.mockResolvedValue(SKILL);
    db.user.findUnique.mockResolvedValue(null);
    const ghost = await upsertEmployeeSkill({ userId: "u-ghost", skillKey: "react", rating: 3 });
    expect(ghost.ok).toBe(false);
    expect(ghost.ok === false && ghost.error).toMatch(/employee not found/i);
  });

  it("rating bounds refuse (0 / 6 / 3.5)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    expect((await upsertEmployeeSkill({ userId: "u-diego", skillKey: "react", rating: 0 })).ok).toBe(false);
    expect((await upsertEmployeeSkill({ userId: "u-diego", skillKey: "react", rating: 6 })).ok).toBe(false);
    expect((await upsertEmployeeSkill({ userId: "u-diego", skillKey: "react", rating: 3.5 })).ok).toBe(false);
  });

  it("a MEMBER cannot rate (hr:admin)", async () => {
    requirePermissionMock.mockImplementation(async (perm: string) => {
      if (perm === "hr:admin") throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      return MEMBER_AUTH;
    });
    const res = await upsertEmployeeSkill({ userId: "u-diego", skillKey: "react", rating: 4 });
    expect(res.ok).toBe(false);
    expect(db.employeeSkill.upsert).not.toHaveBeenCalled();
  });

  it("removeEmployeeSkill deletes the rating (hr:admin)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.employeeSkill.findUnique.mockResolvedValue({ id: "es-1", label: "React" });
    const res = await removeEmployeeSkill({ id: "es-1" });
    expect(res.ok).toBe(true);
    expect(db.employeeSkill.delete).toHaveBeenCalledWith({ where: { id: "es-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hr.employee_skill_removed" }));
  });
});
