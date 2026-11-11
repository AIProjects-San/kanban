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
  const models = ["employeeProfile", "user", "performanceReview", "auditLog", "salaryStructure", "employeePropertyHistory", "notification"];
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
      typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[]),
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

// P33 — the promotion/transfer writer routes manager changes through the
// ONE cycle guard; mocked so the refusal test can pin the call.
const assertNoCycleMock = vi.fn();
vi.mock("@/lib/hierarchy", () => ({
  assertNoCycle: (...a: unknown[]) => assertNoCycleMock(...a),
  getManagerChain: vi.fn(async () => [] as string[]),
  getSubtreeUserIds: vi.fn(async () => new Set<string>()),
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { transitionEmployment, applyEmploymentChange, getEmploymentHistory } from "../employment";

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
  db.salaryStructure.findFirst.mockResolvedValue(null);
  assertNoCycleMock.mockResolvedValue(undefined);
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

// ---------------------------------------------------------------------------
// P33 (EM-06/EM-01, F2.5-lite) — applyEmploymentChange, the promotion/
// transfer writer: the hr:admin gate, EXITED finality, the empty-diff
// refusal, the diff rendering (labels, manager names, gross), the manager
// cycle guard, the raise's structure revision (retire + create, the same
// P16 one-per-day guard), the in-transaction QA-1 re-validation, the
// member notice and the audit — plus getEmploymentHistory's own gate.
// ---------------------------------------------------------------------------

const STRUCTURE_ROW = {
  id: "s-1",
  components: JSON.stringify([
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 96_000 },
    { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 12_000 },
    { key: "kiwisaver", label: "KiwiSaver", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
  ]),
  notes: "Engineering lead band.",
  frequency: "MONTHLY",
  maxBenefits: 0,
  openingYtd: null,
};

function changeInput(
  overrides: Partial<{
    kind: "PROMOTION" | "TRANSFER";
    effectiveDate: string;
    jobTitle: string;
    department: string;
    managerId: string | null;
    raisePercent: number;
    note: string;
  }> = {},
) {
  return {
    kind: "PROMOTION" as const,
    effectiveDate: "2026-11-01",
    jobTitle: "Lead Frontend Engineer",
    ...overrides,
  };
}

describe("P33 — applyEmploymentChange: gates and refusals", () => {
  it("is hr:admin-gated before any read", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await applyEmploymentChange("u-theo", changeInput());
    expect(res.ok).toBe(false);
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:admin");
    expect(db.employeePropertyHistory.createMany).not.toHaveBeenCalled();
  });

  it("EXITED finality — an exited employee's employment facts are never re-opened", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(row({ employmentStatus: "EXITED" }));
    const res = await applyEmploymentChange("u-theo", changeInput());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/has exited/i);
    expect(db.employeePropertyHistory.createMany).not.toHaveBeenCalled();
  });

  it("an empty diff (nothing changed) is refused, never recorded as noise", async () => {
    const res = await applyEmploymentChange("u-theo", {
      kind: "PROMOTION",
      effectiveDate: "2026-11-01",
      jobTitle: row().jobTitle, // unchanged
      department: row().department, // unchanged
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/nothing to record/i);
    expect(db.employeePropertyHistory.createMany).not.toHaveBeenCalled();
  });

  it("a raise without an active structure is refused with the honest reason", async () => {
    db.salaryStructure.findFirst.mockResolvedValue(null);
    const res = await applyEmploymentChange("u-theo", changeInput({ raisePercent: 8 }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no active salary structure/i);
  });

  it("a manager cannot report to themselves", async () => {
    const res = await applyEmploymentChange("u-theo", changeInput({ managerId: "u-theo" }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/report to themselves/i);
  });

  it("manager changes route through the ONE cycle guard", async () => {
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "u-ingrid") return { id: "u-ingrid", name: "Ingrid Solberg", deletedAt: null };
      return THEO;
    });
    await applyEmploymentChange("u-theo", changeInput({ managerId: "u-ingrid" }));
    expect(assertNoCycleMock).toHaveBeenCalledWith("u-theo", "u-ingrid");
  });

  it("an unknown or deleted manager target is refused", async () => {
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "u-ghost") return null;
      return THEO;
    });
    const res = await applyEmploymentChange("u-theo", changeInput({ managerId: "u-ghost" }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/manager not found/i);
  });
});

describe("P33 — applyEmploymentChange: the transaction writes", () => {
  it("a title promotion records ONE structured row, updates the profile, notifies and audits", async () => {
    const res = await applyEmploymentChange("u-theo", changeInput());
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.data.applied).toBe(1);

    // The profile fact lands.
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        update: expect.objectContaining({ jobTitle: "Lead Frontend Engineer" }),
      }),
    );
    // The structured row carries the display diff.
    expect(db.employeePropertyHistory.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: "u-theo",
          property: "jobTitle",
          currentValue: "Senior Frontend Engineer",
          newValue: "Lead Frontend Engineer",
          effectiveAt: new Date("2026-11-01T00:00:00.000Z"),
          sourceKind: "PROMOTION",
          createdById: "u-hr",
        }),
      ],
    });
    // The member's in-app notice (best-effort, in-transaction).
    expect(db.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipientUserId: "u-theo",
          type: "SUCCESS",
          title: "Promotion applied",
        }),
      }),
    );
    // The audit line carries the human-readable diff.
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.employment_change_applied",
        entityId: "u-theo",
        detail: expect.stringMatching(/Lead Frontend Engineer/),
      }),
    );
  });

  it("a department change records the LABEL (the roster's own rendering)", async () => {
    const res = await applyEmploymentChange("u-theo", {
      kind: "TRANSFER",
      effectiveDate: "2026-11-01",
      department: "DESIGN",
    });
    expect(res.ok).toBe(true);
    expect(db.employeePropertyHistory.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          property: "department",
          currentValue: "Engineering",
          newValue: "Design",
          sourceKind: "TRANSFER",
        }),
      ],
    });
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ department: "DESIGN" }) }),
    );
  });

  it("a manager change writes the org chart (User.managerId) and records the NAME", async () => {
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "u-ingrid") return { id: "u-ingrid", name: "Ingrid Solberg", deletedAt: null };
      return { ...THEO, managerId: null };
    });
    const res = await applyEmploymentChange("u-theo", changeInput({ managerId: "u-ingrid" }));
    expect(res.ok).toBe(true);
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u-theo" },
        data: { managerId: "u-ingrid" },
      }),
    );
    expect(db.employeePropertyHistory.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ property: "jobTitle" }),
        expect.objectContaining({ property: "manager", currentValue: "(none)", newValue: "Ingrid Solberg" }),
      ],
    });
  });

  it("a raise retires the active structure and creates the revision on the effective date, scaled", async () => {
    db.salaryStructure.findFirst.mockResolvedValue(STRUCTURE_ROW);
    db.salaryStructure.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      // The pre-read resolves the ACTIVE structure; the in-transaction
      // same-day guard finds nothing else.
      if (where && where.isActive === true) return STRUCTURE_ROW;
      return null;
    });
    const res = await applyEmploymentChange("u-theo", changeInput({ raisePercent: 8 }));
    expect(res.ok).toBe(true);

    // The retire-and-replace discipline, INSIDE the transaction.
    expect(db.salaryStructure.updateMany).toHaveBeenCalledWith({
      where: { userId: "u-theo", isActive: true },
      data: { isActive: false },
    });
    const createCall = db.salaryStructure.create.mock.calls[0][0];
    expect(createCall.data.userId).toBe("u-theo");
    expect(createCall.data.isActive).toBe(true);
    expect(createCall.data.effectiveFrom).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(createCall.data.frequency).toBe("MONTHLY");
    // 96,000 → 103,680 and 12,000 → 12,960 (FIXED earnings ×1.08, whole
    // units); the KiwiSaver percent line rides untouched.
    const revised = JSON.parse(createCall.data.components);
    expect(revised.find((c: { key: string }) => c.key === "basic").amount).toBe(103_680);
    expect(revised.find((c: { key: string }) => c.key === "transport").amount).toBe(12_960);
    expect(revised.find((c: { key: string }) => c.key === "kiwisaver").amount).toBe(3);
    // The salary row records the resolved gross: 108,000 → 116,640.
    expect(db.employeePropertyHistory.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ property: "jobTitle" }),
        expect.objectContaining({ property: "salary", currentValue: "$108,000", newValue: "$116,640" }),
      ],
    });
  });

  it("the P16 one-per-effective-day guard refuses a second same-day structure", async () => {
    db.salaryStructure.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where && where.isActive === true) return STRUCTURE_ROW;
      // The in-tx guard finds ANOTHER row on the same day.
      return { id: "s-other" };
    });
    const res = await applyEmploymentChange("u-theo", changeInput({ raisePercent: 8 }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already has a structure effective 2026-11-01/i);
    expect(db.salaryStructure.create).not.toHaveBeenCalled();
  });

  it("QA-1 — a concurrent EXIT between the pre-read and the write refuses inside the transaction", async () => {
    // The pre-read sees ACTIVE; the in-tx re-read sees EXITED.
    let call = 0;
    db.employeeProfile.findUnique.mockImplementation(async () => {
      call += 1;
      return row({ employmentStatus: call === 1 ? "ACTIVE" : "EXITED" });
    });
    const res = await applyEmploymentChange("u-theo", changeInput());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/re-validation inside the transaction/i);
    expect(db.employeePropertyHistory.createMany).not.toHaveBeenCalled();
  });

  it("a notification failure never breaks the change (best-effort)", async () => {
    db.notification.create.mockRejectedValueOnce(new Error("notify down"));
    const res = await applyEmploymentChange("u-theo", changeInput());
    expect(res.ok).toBe(true);
    expect(db.employeePropertyHistory.createMany).toHaveBeenCalled();
  });

  it("the transfer kind carries through (sourceKind, audit narrative, notice tone)", async () => {
    const res = await applyEmploymentChange("u-theo", {
      kind: "TRANSFER",
      effectiveDate: "2026-11-01",
      department: "DESIGN",
    });
    expect(res.ok).toBe(true);
    expect(db.employeePropertyHistory.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ sourceKind: "TRANSFER" })],
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringMatching(/transfer/i) }),
    );
    expect(db.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "INFO", title: "Transfer applied" }),
      }),
    );
  });
});

describe("P33 — getEmploymentHistory (the structured reader)", () => {
  it("is hr:view-gated", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await getEmploymentHistory("u-theo");
    expect(res.ok).toBe(false);
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:view");
  });

  it("serializes rows newest-first with date-only effectiveAt", async () => {
    db.employeePropertyHistory.findMany.mockResolvedValue([
      {
        id: "h-1", userId: "u-theo", property: "jobTitle",
        currentValue: "UX Research Intern", newValue: "UX Researcher",
        effectiveAt: new Date("2026-09-27T00:00:00.000Z"),
        sourceKind: "PROMOTION", createdById: "u-hr",
        createdAt: new Date("2026-09-27T00:00:00.000Z"),
      },
    ]);
    const res = await getEmploymentHistory("u-theo");
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.data[0]).toEqual({
      id: "h-1", userId: "u-theo", property: "jobTitle",
      currentValue: "UX Research Intern", newValue: "UX Researcher",
      effectiveAt: "2026-09-27", sourceKind: "PROMOTION",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    expect(db.employeePropertyHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
        take: 100,
      }),
    );
  });

  it("an unknown or deleted user is refused (soft-delete honesty)", async () => {
    db.user.findUnique.mockResolvedValue({ ...THEO, deletedAt: new Date() });
    const res = await getEmploymentHistory("u-theo");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/user not found/i);
  });
});
