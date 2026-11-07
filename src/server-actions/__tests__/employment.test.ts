import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F1.6 — employment lifecycle action tests (transitionEmployment, the ONLY
// writer of EmployeeProfile.employmentStatus). Plan acceptance: "transition
// tests incl. the gate (review pending → transition refused; completed →
// allowed)". Covers RBAC (hr:admin), the transition machine's refusals
// (no-op, illegal arcs, EXITED terminal), the §9.3 probation-review hard
// gate, the EXITED last-working-day requirement, the hireDate probation
// default, the row-absent create path, and the audit trail.
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1, decision §9.3.)
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["employeeProfile", "user", "performanceReview", "auditLog"];
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

import { transitionEmployment } from "../employment";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const THEO = { id: "u-theo", name: "Theo Vance", deletedAt: null };

/** Row factory — the fields the action reads. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u-theo",
    jobTitle: "Senior Frontend Engineer",
    department: "ENGINEERING",
    hireDate: new Date("2026-08-15T00:00:00.000Z"),
    employmentStatus: "",
    probationEndsAt: null,
    noticePeriodWeeks: null,
    lastWorkingDay: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockResolvedValue(THEO);
  db.employeeProfile.findUnique.mockResolvedValue(row());
  db.employeeProfile.upsert.mockResolvedValue({});
  db.performanceReview.findFirst.mockResolvedValue(null);
});

describe("RBAC", () => {
  it("is hr:admin-gated — a member is refused before any read", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(false);
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:admin");
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("an ADMIN (not just HR) may drive transitions", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(true);
  });

  it("refuses an empty user id and an unknown/deleted user", async () => {
    const res1 = await transitionEmployment("", { target: "ACTIVE" });
    expect(res1.ok).toBe(false);
    expect(res1.ok === false && res1.error).toMatch(/user id/i);

    db.user.findUnique.mockResolvedValue(null);
    const res2 = await transitionEmployment("u-ghost", { target: "ACTIVE" });
    expect(res2.ok).toBe(false);
    expect(res2.ok === false && res2.error).toMatch(/user not found/i);

    db.user.findUnique.mockResolvedValue({ ...THEO, deletedAt: new Date() });
    const res3 = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res3.ok).toBe(false);
    expect(res3.ok === false && res3.error).toMatch(/user not found/i);
  });

  it("rejects a target outside the four statuses (no un-classifying)", async () => {
    const res = await transitionEmployment("u-theo", { target: "ON_HOLD" } as never);
    expect(res.ok).toBe(false);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });
});

describe("transition machine refusals", () => {
  it("a no-op (same status) is refused with a friendly message", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "ACTIVE" }));
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already active/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  it("an illegal arc is refused naming both statuses", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "EXITED" }));
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/from exited to active/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  it("SUSPENDED is not a first move from not-tracked", async () => {
    const res = await transitionEmployment("u-theo", { target: "SUSPENDED" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no tracked employment status/i);
  });

  it("PROBATION → SUSPENDED is refused (the §9.3 bypass arc is absent)", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "PROBATION" }));
    const res = await transitionEmployment("u-theo", { target: "SUSPENDED" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/from probation to suspended/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });
});

describe("§9.3 hard gate — PROBATION → ACTIVE needs a completed probation review", () => {
  it("review pending → transition REFUSED (no review at all)", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "PROBATION" }));
    db.performanceReview.findFirst.mockResolvedValue(null);
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/probation review outstanding/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("review pending → transition REFUSED (only DRAFT/SUBMITTED cycles exist)", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "PROBATION" }));
    // findFirst filters kind PROBATION + status REVIEWED/ACKNOWLEDGED — a
    // pending cycle is invisible to it, exactly like no review at all.
    db.performanceReview.findFirst.mockResolvedValue(null);
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(false);
    expect(db.performanceReview.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u-theo",
          kind: "PROBATION",
          status: { in: ["REVIEWED", "ACKNOWLEDGED"] },
        }),
      }),
    );
  });

  it("a completed STANDARD review does not satisfy the gate (kind filter)", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "PROBATION" }));
    // The gate's query is kind-scoped: STANDARD cycles never satisfy it.
    db.performanceReview.findFirst.mockImplementation(async (args: { where?: { kind?: string } }) =>
      args?.where?.kind === "PROBATION" ? null : { id: "pr-std", title: "Mid-year" },
    );
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/probation review outstanding/i);
  });

  it("review completed (REVIEWED/ACKNOWLEDGED) → transition ALLOWED", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(
      row({ employmentStatus: "PROBATION", probationEndsAt: new Date("2026-11-15T00:00:00.000Z") }),
    );
    db.performanceReview.findFirst.mockResolvedValue({ id: "pr-9", title: "Probation review — Theo" });
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.data.status).toBe("ACTIVE");
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        update: expect.objectContaining({ employmentStatus: "ACTIVE" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.employment_transitioned",
        entityType: "EMPLOYEE_PROFILE",
        entityId: "u-theo",
      }),
    );
  });

  it("the gate never fires for non-probation arcs (suspension reinstatement)", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "SUSPENDED" }));
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.findFirst).not.toHaveBeenCalled();
  });
});

describe("EXITED requires a last working day (F2.1 relies on it)", () => {
  it("refuses an exit with no last working day on the call or the profile", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "ACTIVE" }));
    const res = await transitionEmployment("u-theo", { target: "EXITED" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/last working day is required/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
  });

  it("records the exit when the call carries the last working day", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "ACTIVE" }));
    const res = await transitionEmployment("u-theo", {
      target: "EXITED",
      lastWorkingDay: "2026-11-20",
    });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          employmentStatus: "EXITED",
          lastWorkingDay: new Date("2026-11-20T00:00:00.000Z"),
        }),
      }),
    );
  });

  it("a last working day already on the profile satisfies the requirement", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(
      row({ employmentStatus: "ACTIVE", lastWorkingDay: new Date("2026-11-20T00:00:00.000Z") }),
    );
    const res = await transitionEmployment("u-theo", { target: "EXITED" });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ employmentStatus: "EXITED" }),
      }),
    );
  });
});

describe("hireDate feeds probation defaults", () => {
  it("entering probation without an end date defaults to hireDate + 3 months", async () => {
    const res = await transitionEmployment("u-theo", { target: "PROBATION" });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          employmentStatus: "PROBATION",
          probationEndsAt: new Date("2026-11-15T00:00:00.000Z"),
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.employment_transitioned",
        detail: expect.stringContaining("defaulting 3 months from hire date"),
      }),
    );
  });

  it("an explicit end date wins over the default", async () => {
    const res = await transitionEmployment("u-theo", {
      target: "PROBATION",
      probationEndsAt: "2026-12-01",
    });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          probationEndsAt: new Date("2026-12-01T00:00:00.000Z"),
        }),
      }),
    );
    // No defaulting note when the date was explicit.
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.not.stringContaining("defaulting") }),
    );
  });

  it("without a hire date either, probation is recorded with no end date", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ hireDate: null }));
    const res = await transitionEmployment("u-theo", { target: "PROBATION" });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({ probationEndsAt: expect.anything() }),
      }),
    );
  });
});

describe("the not-tracked starting state", () => {
  it("creates the profile row with neutral defaults when none exists", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(null);
    const res = await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(res.ok).toBe(true);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: "u-theo",
          jobTitle: "",
          department: "",
          hireDate: null,
          employmentStatus: "ACTIVE",
        }),
      }),
    );
  });

  it("audit names the from → to arc, with not-tracked spelled out", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(null);
    await transitionEmployment("u-theo", { target: "ACTIVE" });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.employment_transitioned",
        detail: expect.stringMatching(/not tracked → active/i),
      }),
    );
  });
});
