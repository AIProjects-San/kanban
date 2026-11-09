import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P7 (PR-20/PR-21, F3.3) — gratuity rule action tests.
// RBAC (payroll:manage), the read's default world, the transactional
// replace-slabs save, kernel-level refusal of overlapping slabs, and the
// audit trail. Config only — no money is ever written by these actions.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["gratuityRule", "gratuitySlab", "auditLog"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.resolve(fn),
  );
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

import { getGratuityRule, saveGratuityRule } from "../payroll-gratuity";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
});

describe("P7 — getGratuityRule", () => {
  it("returns the default world (off, no slabs) when nothing is configured", async () => {
    db.gratuityRule.findFirst.mockResolvedValue(null);
    const res = await getGratuityRule();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ enabled: false, averagingMonths: 3, slabs: [] });
    }
    expect(db.gratuitySlab.findMany).not.toHaveBeenCalled();
  });

  it("returns the configured rule with its slabs sorted by fromYears", async () => {
    db.gratuityRule.findFirst.mockResolvedValue({ id: "gr-1", enabled: true, averagingMonths: 6 });
    db.gratuitySlab.findMany.mockResolvedValue([
      { id: "s-1", fromYears: 1, toYears: 4, fraction: 0.25 },
      { id: "s-2", fromYears: 5, toYears: null, fraction: 0.5 },
    ]);
    const res = await getGratuityRule();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.enabled).toBe(true);
      expect(res.data.averagingMonths).toBe(6);
      expect(res.data.slabs).toEqual([
        { id: "s-1", fromYears: 1, toYears: 4, fraction: 0.25 },
        { id: "s-2", fromYears: 5, toYears: null, fraction: 0.5 },
      ]);
    }
  });

  it("requires payroll:manage", async () => {
    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const res = await getGratuityRule();
    expect(res.ok).toBe(false);
  });
});

describe("P7 — saveGratuityRule", () => {
  it("creates the rule row and writes the slab set in one transaction", async () => {
    db.gratuityRule.findFirst.mockResolvedValue(null);
    db.gratuitySlab.deleteMany.mockResolvedValue({ count: 0 });
    db.gratuitySlab.createMany.mockResolvedValue({ count: 2 });
    const res = await saveGratuityRule({
      enabled: true,
      averagingMonths: 3,
      slabs: [
        { fromYears: 1, toYears: 4, fraction: 0.25 },
        { fromYears: 5, toYears: null, fraction: 0.5 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(db.gratuityRule.create).toHaveBeenCalledWith({
      data: { enabled: true, averagingMonths: 3 },
    });
    expect(db.gratuitySlab.deleteMany).toHaveBeenCalledWith({});
    expect(db.gratuitySlab.createMany).toHaveBeenCalledWith({
      data: [
        { fromYears: 1, toYears: 4, fraction: 0.25 },
        { fromYears: 5, toYears: null, fraction: 0.5 },
      ],
    });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0] as { action: string; detail: string };
    expect(audit.action).toBe("payroll.gratuity_rule_saved");
    expect(audit.detail).toContain("2 slab(s)");
  });

  it("updates the existing rule row instead of creating a second one", async () => {
    db.gratuityRule.findFirst.mockResolvedValue({ id: "gr-1", enabled: false, averagingMonths: 3 });
    db.gratuitySlab.deleteMany.mockResolvedValue({ count: 2 });
    const res = await saveGratuityRule({ enabled: false, averagingMonths: 3, slabs: [] });
    expect(res.ok).toBe(true);
    expect(db.gratuityRule.update).toHaveBeenCalledWith({
      where: { id: "gr-1" },
      data: { enabled: false, averagingMonths: 3 },
    });
    expect(db.gratuityRule.create).not.toHaveBeenCalled();
    expect(db.gratuitySlab.createMany).not.toHaveBeenCalled();
  });

  it("refuses overlapping slabs (the kernel owns the rule)", async () => {
    const res = await saveGratuityRule({
      enabled: true,
      averagingMonths: 3,
      slabs: [
        { fromYears: 1, toYears: 5, fraction: 0.25 },
        { fromYears: 5, toYears: null, fraction: 0.5 },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("overlap");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range averaging window at the schema layer", async () => {
    const res = await saveGratuityRule({ enabled: true, averagingMonths: 13, slabs: [] });
    expect(res.ok).toBe(false);
  });

  it("requires payroll:manage", async () => {
    requirePermissionMock.mockRejectedValue(new Error("denied"));
    const res = await saveGratuityRule({ enabled: true, averagingMonths: 3, slabs: [] });
    expect(res.ok).toBe(false);
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
