import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P1 G6 — the employment-document action tests: creation (snapshots, the
// spec §4 refusals), the approval transitions (submit / approve / cancel —
// guarded flips, four-eyes), the manual effect delegation, the readers, and
// the no-writes-before-EFFECTIVE invariant. The effect core itself (the
// conflict rule, the fact writes) is covered in
// lib/hr/__tests__/employment-doc-effect.test.ts.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user",
    "employeeProfile",
    "employeeTransfer",
    "employeePromotion",
    "employeePropertyHistory",
    "salaryStructureAssignment",
    "salaryStructure",
    "notification",
    "auditLog",
  ];
  const methods = [
    "findMany",
    "findUnique",
    "findFirst",
    "create",
    "createMany",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "upsert",
    "count",
    "aggregate",
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
vi.mock("@/lib/infra/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) {
      super(m);
      this.name = "AuthorizationError";
    }
  },
}));

const assertNoCycleMock = vi.fn();
vi.mock("@/lib/auth/hierarchy", () => ({
  assertNoCycle: (...a: unknown[]) => assertNoCycleMock(...a),
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

// The effect core is mocked here — its own behaviour is pinned in
// lib/hr/__tests__/employment-doc-effect.test.ts; these tests pin the
// delegation contract (kind, id, actor, date rule).
const effectCoreMock = vi.fn();
vi.mock("@/lib/hr/employment-doc-effect", () => ({
  effectEmploymentDocument: (...a: unknown[]) => effectCoreMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createEmployeeTransfer,
  createEmployeePromotion,
  submitEmploymentDocument,
  approveEmploymentDocument,
  cancelEmploymentDocument,
  makeEmploymentDocumentEffective,
  getEmployeeTransfers,
} from "../hr-employment-docs";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const OTHER_HR_AUTH = { userId: "u-ada", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };

const THEO = {
  id: "u-theo",
  name: "Theo Vance",
  email: "theo@x.co",
  deletedAt: null,
  managerId: "u-ingrid",
};

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u-theo",
    jobTitle: "Senior Frontend Engineer",
    department: "ENGINEERING",
    grade: "L4",
    location: "Auckland",
    employmentStatus: "ACTIVE",
    ...overrides,
  };
}

function transferRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "t-1",
    employeeId: "u-theo",
    fromDepartment: "ENGINEERING",
    toDepartment: "DESIGN",
    fromJobTitle: "Senior Frontend Engineer",
    toJobTitle: null,
    fromManagerId: "u-ingrid",
    toManagerId: null,
    fromLocation: "Auckland",
    toLocation: null,
    effectiveDate: new Date("2026-12-01T00:00:00.000Z"),
    reason: null,
    status: "DRAFT",
    approvedById: null,
    approvedAt: null,
    cancelledById: null,
    cancelledAt: null,
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    createdById: "u-hr",
    ...overrides,
  };
}

function promotionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    employeeId: "u-theo",
    fromJobTitle: "Senior Frontend Engineer",
    toJobTitle: "Staff Engineer",
    fromGrade: "L4",
    toGrade: "L5",
    effectiveDate: new Date("2026-12-01T00:00:00.000Z"),
    reason: null,
    status: "DRAFT",
    approvedById: null,
    approvedAt: null,
    cancelledById: null,
    cancelledAt: null,
    linkedSalaryAssignmentId: null,
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    createdById: "u-hr",
    ...overrides,
  };
}

/** Today, as the actions compute it — the tests pin dates around it. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function futureDate(days = 10): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === "u-theo") return { ...THEO };
    if (where.id === "u-ingrid") return { id: "u-ingrid", name: "Ingrid Solberg", deletedAt: null };
    if (where.id === "u-ada") return { id: "u-ada", name: "Ada Lovelace", deletedAt: null };
    return null;
  });
  db.user.findMany.mockResolvedValue([]);
  db.employeeProfile.findUnique.mockResolvedValue(profileRow());
  db.employeeProfile.findMany.mockResolvedValue([]);
  db.employeeTransfer.findUnique.mockResolvedValue(null);
  db.employeePromotion.findUnique.mockResolvedValue(null);
  db.employeeTransfer.findFirst.mockResolvedValue(null);
  db.employeePromotion.findFirst.mockResolvedValue(null);
  db.employeeTransfer.findMany.mockResolvedValue([]);
  db.employeePromotion.findMany.mockResolvedValue([]);
  db.employeeTransfer.create.mockResolvedValue({ id: "t-new" });
  db.employeePromotion.create.mockResolvedValue({ id: "p-new" });
  db.employeeTransfer.updateMany.mockResolvedValue({ count: 1 });
  db.employeePromotion.updateMany.mockResolvedValue({ count: 1 });
  db.salaryStructureAssignment.findUnique.mockResolvedValue(null);
  assertNoCycleMock.mockResolvedValue(undefined);
  effectCoreMock.mockResolvedValue({ applied: 2 });
});

// ---------------------------------------------------------------------------
// createEmployeeTransfer
// ---------------------------------------------------------------------------

describe("G6 — createEmployeeTransfer", () => {
  it("is hr:admin-gated before any read", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toDepartment: "DESIGN",
    });
    expect(res.ok).toBe(false);
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:admin");
    expect(db.employeeTransfer.create).not.toHaveBeenCalled();
  });

  it("creates a DRAFT with the from-side snapshotted from the live facts", async () => {
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toDepartment: "DESIGN",
      toLocation: "Wellington",
      reason: "Design systems move",
    });
    expect(res.ok).toBe(true);
    expect(db.employeeTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          employeeId: "u-theo",
          fromDepartment: "ENGINEERING",
          fromJobTitle: "Senior Frontend Engineer",
          fromManagerId: "u-ingrid",
          fromLocation: "Auckland",
          toDepartment: "DESIGN",
          toLocation: "Wellington",
          status: "DRAFT",
          createdById: "u-hr",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.transfer_created", entityId: "t-new" }),
    );
  });

  it("refuses a transfer to the same department (spec §4)", async () => {
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toDepartment: "ENGINEERING",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already in that department/i);
    expect(db.employeeTransfer.create).not.toHaveBeenCalled();
  });

  it("refuses a transfer to the same designation (spec §4)", async () => {
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toJobTitle: "Senior Frontend Engineer",
      toLocation: "Wellington",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already holds that job title/i);
  });

  it("refuses a transfer that carries no axis at all", async () => {
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/at least one destination/i);
  });

  it("refuses a transfer whose every carried axis matches the current facts", async () => {
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toLocation: "Auckland", // same location; no other axis
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/nothing changes/i);
  });

  it("refuses an unknown department at the zod boundary", async () => {
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toDepartment: "ACCOUNTING" as never,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/unknown department/i);
  });

  it("routes a manager change through the ONE cycle guard", async () => {
    await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toManagerId: "u-ingrid",
      toLocation: "Wellington",
    });
    expect(assertNoCycleMock).toHaveBeenCalledWith("u-theo", "u-ingrid");
  });

  it("refuses the employee as their own manager", async () => {
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toManagerId: "u-theo",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/report to themselves/i);
  });

  it("refuses a deleted or unknown manager target", async () => {
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toManagerId: "u-ghost",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/manager not found/i);
  });

  it("stores an explicit manager clear as \"\" (absent stays null)", async () => {
    await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toManagerId: null,
    });
    expect(db.employeeTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ toManagerId: "" }),
      }),
    );
  });

  it("EXITED finality — an exited employee's facts are never re-opened", async () => {
    db.employeeProfile.findUnique.mockResolvedValue(profileRow({ employmentStatus: "EXITED" }));
    const res = await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toDepartment: "DESIGN",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/has exited/i);
  });
});

// ---------------------------------------------------------------------------
// createEmployeePromotion
// ---------------------------------------------------------------------------

describe("G6 — createEmployeePromotion", () => {
  it("creates a DRAFT with the from-side snapshotted, grade optional", async () => {
    const res = await createEmployeePromotion({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toJobTitle: "Staff Engineer",
      toGrade: "L5",
    });
    expect(res.ok).toBe(true);
    expect(db.employeePromotion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          employeeId: "u-theo",
          fromJobTitle: "Senior Frontend Engineer",
          fromGrade: "L4",
          toJobTitle: "Staff Engineer",
          toGrade: "L5",
          status: "DRAFT",
          createdById: "u-hr",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.promotion_created", entityId: "p-new" }),
    );
  });

  it("refuses a promotion to the same designation (spec §4)", async () => {
    const res = await createEmployeePromotion({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toJobTitle: "Senior Frontend Engineer",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already holds that designation/i);
  });

  it("refuses a promotion to the same grade (spec §4)", async () => {
    const res = await createEmployeePromotion({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toJobTitle: "Staff Engineer",
      toGrade: "L4",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already on that grade/i);
  });

  it("validates the linked salary assignment belongs to the employee", async () => {
    db.salaryStructureAssignment.findUnique.mockResolvedValue({
      employeeId: "u-someone-else",
    });
    const res = await createEmployeePromotion({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toJobTitle: "Staff Engineer",
      linkedSalaryAssignmentId: "sa-1",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/different employee/i);
  });

  it("accepts a linked salary assignment of the same employee", async () => {
    db.salaryStructureAssignment.findUnique.mockResolvedValue({ employeeId: "u-theo" });
    const res = await createEmployeePromotion({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toJobTitle: "Staff Engineer",
      linkedSalaryAssignmentId: "sa-1",
    });
    expect(res.ok).toBe(true);
    expect(db.employeePromotion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ linkedSalaryAssignmentId: "sa-1" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// submit — the future-date rule + the DRAFT-only guard.
// ---------------------------------------------------------------------------

describe("G6 — submitEmploymentDocument", () => {
  it("refuses an effective date that is today (future means strictly after)", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferRow({ effectiveDate: new Date(`${todayKey()}T00:00:00.000Z`) }),
    );
    const res = await submitEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/must be in the future/i);
    expect(db.employeeTransfer.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a past effective date", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferRow({ effectiveDate: new Date("2020-01-01T00:00:00.000Z") }),
    );
    const res = await submitEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/must be in the future/i);
  });

  it("flips DRAFT → PENDING_APPROVAL through the guarded updateMany", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferRow());
    const res = await submitEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(true);
    expect(db.employeeTransfer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1", status: "DRAFT" },
        data: { status: "PENDING_APPROVAL" },
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.transfer_submitted" }),
    );
  });

  it("refuses a non-DRAFT document", async () => {
    db.employeePromotion.findUnique.mockResolvedValue(promotionRow({ status: "APPROVED" }));
    const res = await submitEmploymentDocument({ kind: "PROMOTION", id: "p-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/only a draft/i);
  });

  it("loses the race loudly (guarded flip returns zero)", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferRow());
    db.employeeTransfer.updateMany.mockResolvedValue({ count: 0 });
    const res = await submitEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no longer a draft/i);
  });
});

// ---------------------------------------------------------------------------
// approve — four-eyes + the PENDING-only guard.
// ---------------------------------------------------------------------------

describe("G6 — approveEmploymentDocument", () => {
  it("refuses the creator approving their own document (spec §4)", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferRow({ status: "PENDING_APPROVAL", createdById: "u-hr" }),
    );
    const res = await approveEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/different pair of eyes/i);
    expect(db.employeeTransfer.updateMany).not.toHaveBeenCalled();
  });

  it("refuses the subject approving their own transfer (spec §4)", async () => {
    requirePermissionMock.mockResolvedValue({ ...HR_AUTH, userId: "u-theo" });
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferRow({ status: "PENDING_APPROVAL", createdById: "u-ada" }),
    );
    const res = await approveEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/your own transfer/i);
  });

  it("approves with the approver + timestamp through the guarded flip", async () => {
    requirePermissionMock.mockResolvedValue(OTHER_HR_AUTH);
    db.employeePromotion.findUnique.mockResolvedValue(promotionRow({ status: "PENDING_APPROVAL" }));
    const res = await approveEmploymentDocument({ kind: "PROMOTION", id: "p-1" });
    expect(res.ok).toBe(true);
    expect(db.employeePromotion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p-1", status: "PENDING_APPROVAL" },
        data: expect.objectContaining({ status: "APPROVED", approvedById: "u-ada" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.promotion_approved" }),
    );
  });

  it("refuses a non-pending document", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferRow({ status: "DRAFT" }));
    const res = await approveEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/only a pending/i);
  });
});

// ---------------------------------------------------------------------------
// cancel — the creator rule (ADMIN as the safety valve).
// ---------------------------------------------------------------------------

describe("G6 — cancelEmploymentDocument", () => {
  it("refuses a non-creator non-admin (an HR peer cannot cancel)", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferRow({ status: "PENDING_APPROVAL", createdById: "u-ada" }),
    );
    const res = await cancelEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/only the document's creator/i);
  });

  it("the creator cancels their own pending document", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferRow({ status: "PENDING_APPROVAL", createdById: "u-hr" }),
    );
    const res = await cancelEmploymentDocument({
      kind: "TRANSFER",
      id: "t-1",
      reason: "Plans changed",
    });
    expect(res.ok).toBe(true);
    expect(db.employeeTransfer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED", cancelledById: "u-hr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.transfer_cancelled" }),
    );
  });

  it("ADMIN is the safety valve for an orphaned APPROVED document", async () => {
    requirePermissionMock.mockResolvedValue(OTHER_HR_AUTH);
    db.employeePromotion.findUnique.mockResolvedValue(
      promotionRow({ status: "APPROVED", createdById: "u-gone" }),
    );
    const res = await cancelEmploymentDocument({ kind: "PROMOTION", id: "p-1" });
    expect(res.ok).toBe(true);
  });

  it("refuses cancelling an already-EFFECTIVE document (finality)", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferRow({ status: "EFFECTIVE" }));
    const res = await cancelEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already effective/i);
    expect(db.employeeTransfer.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The no-writes-before-EFFECTIVE invariant (spec: nothing moves before the
// EFFECTIVE state) + the manual effect delegation.
// ---------------------------------------------------------------------------

describe("G6 — no employment-fact writes before EFFECTIVE", () => {
  it("create/submit/approve write ONLY the document row — never the profile, org chart or property history", async () => {
    // The full pre-effect lifecycle.
    await createEmployeeTransfer({
      employeeId: "u-theo",
      effectiveDate: futureDate(),
      toDepartment: "DESIGN",
    });
    db.employeeTransfer.findUnique.mockResolvedValue(transferRow());
    await submitEmploymentDocument({ kind: "TRANSFER", id: "t-1" });
    requirePermissionMock.mockResolvedValue(OTHER_HR_AUTH);
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferRow({ status: "PENDING_APPROVAL" }),
    );
    await approveEmploymentDocument({ kind: "TRANSFER", id: "t-1" });

    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
    expect(db.employeeProfile.update).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.employeePropertyHistory.createMany).not.toHaveBeenCalled();
    expect(db.salaryStructure.updateMany).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
  });
});

describe("G6 — makeEmploymentDocumentEffective (the manual trigger)", () => {
  it("delegates to the ONE effect core with the auth actor and the date rule", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferRow({ status: "APPROVED", employeeId: "u-theo" }),
    );
    const res = await makeEmploymentDocumentEffective({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(true);
    expect(effectCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "TRANSFER",
        id: "t-1",
        actor: { userId: "u-hr", name: "Remy", role: "HR" },
        requireDateReached: true,
      }),
    );
    expect(res.ok === true && res.data.applied).toBe(2);
  });

  it("refuses an unknown document before touching the core", async () => {
    db.employeePromotion.findUnique.mockResolvedValue(null);
    const res = await makeEmploymentDocumentEffective({ kind: "PROMOTION", id: "p-404" });
    expect(res.ok).toBe(false);
    expect(effectCoreMock).not.toHaveBeenCalled();
  });

  it("surfaces the core's refusal (e.g. the date has not arrived)", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferRow({ status: "APPROVED" }));
    effectCoreMock.mockRejectedValue(new Error("The effective date is 2099-01-01 — a document can only be made effective on or after that date."));
    const res = await makeEmploymentDocumentEffective({ kind: "TRANSFER", id: "t-1" });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Readers.
// ---------------------------------------------------------------------------

describe("G6 — getEmployeeTransfers", () => {
  it("is hr:view-gated and serializes the rows with resolved names", async () => {
    db.employeeTransfer.findMany.mockResolvedValue([
      transferRow({
        status: "APPROVED",
        approvedById: "u-ada",
        toManagerId: "u-ada",
      }),
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-ada", name: "Ada Lovelace" },
      { id: "u-hr", name: "Remy" },
    ]);
    const res = await getEmployeeTransfers("u-theo");
    expect(requirePermissionMock).toHaveBeenCalledWith("hr:view");
    expect(res.ok).toBe(true);
    const row = res.ok === true ? res.data[0] : null;
    expect(row).not.toBeNull();
    expect(row!.effectiveDate).toBe("2026-12-01");
    expect(row!.approvedByName).toBe("Ada Lovelace");
    expect(row!.toManagerName).toBe("Ada Lovelace");
    expect(row!.createdByName).toBe("Remy");
  });
});
