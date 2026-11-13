import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P1 G6 — the EFFECTIVE core + the daily sweep: the conflict rule (spec §3
// — one EFFECTIVE transfer OR promotion per employee per date), the fact
// writes (profile, org chart, property history — all INSIDE the guarded
// flip's transaction), the QA-1 re-validation (EXIT, deleted manager), the
// race guard, the salary-revision coexistence (spec §3 — the link is
// provenance, never a trigger), and the sweep's due filter + per-document
// isolation.
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

const logAuditMock = vi.fn();
vi.mock("@/lib/audit/audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

const logErrorMock = vi.fn();
vi.mock("@/lib/infra/observability", () => ({
  logError: (...a: unknown[]) => logErrorMock(...a),
  logInfo: vi.fn(),
  captureError: vi.fn(),
}));

const assertNoCycleMock = vi.fn();
vi.mock("@/lib/auth/hierarchy", () => ({
  assertNoCycle: (...a: unknown[]) => assertNoCycleMock(...a),
}));

import {
  effectEmploymentDocument,
  runDueEmploymentDocumentsJob,
  CRON_ACTOR,
} from "../employment-doc-effect";

const MANUAL_ACTOR = { userId: "u-ada", name: "Ada", role: "ADMIN" };

const THEO = { id: "u-theo", name: "Theo Vance", deletedAt: null, managerId: "u-ingrid" };

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

function transferDoc(overrides: Record<string, unknown> = {}) {
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
    effectiveDate: new Date("2026-11-10T00:00:00.000Z"),
    reason: null,
    status: "APPROVED",
    approvedById: "u-ada",
    approvedAt: new Date(),
    cancelledById: null,
    cancelledAt: null,
    createdAt: new Date(),
    createdById: "u-hr",
    ...overrides,
  };
}

function promotionDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    employeeId: "u-theo",
    fromJobTitle: "Senior Frontend Engineer",
    toJobTitle: "Staff Engineer",
    fromGrade: "L4",
    toGrade: "L5",
    effectiveDate: new Date("2026-11-10T00:00:00.000Z"),
    reason: null,
    status: "APPROVED",
    approvedById: "u-ada",
    approvedAt: new Date(),
    cancelledById: null,
    cancelledAt: null,
    linkedSalaryAssignmentId: null,
    createdAt: new Date(),
    createdById: "u-hr",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === "u-theo") return { ...THEO };
    if (where.id === "u-ingrid") return { id: "u-ingrid", name: "Ingrid Solberg", deletedAt: null };
    if (where.id === "u-ada") return { id: "u-ada", name: "Ada Lovelace", deletedAt: null };
    return null;
  });
  db.employeeProfile.findUnique.mockResolvedValue(profileRow());
  db.employeeTransfer.findUnique.mockResolvedValue(null);
  db.employeePromotion.findUnique.mockResolvedValue(null);
  db.employeeTransfer.findFirst.mockResolvedValue(null);
  db.employeePromotion.findFirst.mockResolvedValue(null);
  db.employeeTransfer.updateMany.mockResolvedValue({ count: 1 });
  db.employeePromotion.updateMany.mockResolvedValue({ count: 1 });
  db.employeeTransfer.findMany.mockResolvedValue([]);
  db.employeePromotion.findMany.mockResolvedValue([]);
  assertNoCycleMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// The gates.
// ---------------------------------------------------------------------------

describe("G6 effect core — gates", () => {
  it("refuses a document that is not APPROVED", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferDoc({ status: "DRAFT" }));
    await expect(
      effectEmploymentDocument({
        kind: "TRANSFER",
        id: "t-1",
        actor: MANUAL_ACTOR,
        requireDateReached: true,
        todayKey: "2026-11-13",
      }),
    ).rejects.toThrow(/only an approved document/i);
  });

  it("refuses when the effective date has not arrived (manual trigger)", async () => {
    db.employeePromotion.findUnique.mockResolvedValue(
      promotionDoc({ effectiveDate: new Date("2026-11-14T00:00:00.000Z") }),
    );
    await expect(
      effectEmploymentDocument({
        kind: "PROMOTION",
        id: "p-1",
        actor: MANUAL_ACTOR,
        requireDateReached: true,
        todayKey: "2026-11-13",
      }),
    ).rejects.toThrow(/can only be made effective on or after/i);
  });

  it("QA-1 — refuses an employee who EXITed since approval (the profile read is INSIDE the transaction)", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferDoc());
    db.employeeProfile.findUnique.mockResolvedValue(profileRow({ employmentStatus: "EXITED" }));
    await expect(
      effectEmploymentDocument({
        kind: "TRANSFER",
        id: "t-1",
        actor: MANUAL_ACTOR,
        requireDateReached: true,
        todayKey: "2026-11-13",
      }),
    ).rejects.toThrow(/has exited/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
    expect(db.employeePropertyHistory.createMany).not.toHaveBeenCalled();
  });

  it("refuses a transfer whose target manager left since approval", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferDoc({ toManagerId: "u-ghost" }));
    await expect(
      effectEmploymentDocument({
        kind: "TRANSFER",
        id: "t-1",
        actor: MANUAL_ACTOR,
        requireDateReached: true,
        todayKey: "2026-11-13",
      }),
    ).rejects.toThrow(/target manager is no longer an active member/i);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("loses the race loudly — a zero-count guarded flip writes nothing", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferDoc());
    db.employeeTransfer.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      effectEmploymentDocument({
        kind: "TRANSFER",
        id: "t-1",
        actor: MANUAL_ACTOR,
        requireDateReached: true,
        todayKey: "2026-11-13",
      }),
    ).rejects.toThrow(/no longer approved/i);
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
    expect(db.employeePropertyHistory.createMany).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The conflict rule (spec §3).
// ---------------------------------------------------------------------------

describe("G6 effect core — the same-date conflict rule", () => {
  it("refuses when another EFFECTIVE transfer exists on the same date", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferDoc());
    db.employeeTransfer.findFirst.mockResolvedValue({ id: "t-other" }); // the clash
    await expect(
      effectEmploymentDocument({
        kind: "TRANSFER",
        id: "t-1",
        actor: MANUAL_ACTOR,
        requireDateReached: true,
        todayKey: "2026-11-13",
      }),
    ).rejects.toThrow(/already has an effective transfer or promotion/i);
    expect(db.employeeTransfer.updateMany).not.toHaveBeenCalled();
    expect(db.employeePropertyHistory.createMany).not.toHaveBeenCalled();
  });

  it("refuses when an EFFECTIVE promotion exists on the same date (cross-kind clash)", async () => {
    db.employeePromotion.findUnique.mockResolvedValue(promotionDoc());
    db.employeePromotion.findFirst.mockResolvedValue({ id: "p-other" });
    await expect(
      effectEmploymentDocument({
        kind: "PROMOTION",
        id: "p-1",
        actor: MANUAL_ACTOR,
        requireDateReached: true,
        todayKey: "2026-11-13",
      }),
    ).rejects.toThrow(/already has an effective transfer or promotion/i);
  });

  it("ignores its own row in the conflict check but not a same-date sibling", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferDoc());
    // findFirst returns null (no clash) — the where must exclude t-1 itself.
    await effectEmploymentDocument({
      kind: "TRANSFER",
      id: "t-1",
      actor: MANUAL_ACTOR,
      requireDateReached: true,
      todayKey: "2026-11-13",
    });
    const arg = db.employeeTransfer.findFirst.mock.calls[0][0];
    expect(arg.where.status).toBe("EFFECTIVE");
    expect(arg.where.id).toEqual({ not: "t-1" });
  });
});

// ---------------------------------------------------------------------------
// The fact writes.
// ---------------------------------------------------------------------------

describe("G6 effect core — the transfer application", () => {
  it("flips the status, writes the profile facts, the org chart and the property history", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferDoc({
        toDepartment: "DESIGN",
        toJobTitle: "Principal Designer",
        toManagerId: "u-ada",
        toLocation: "Wellington",
      }),
    );
    const res = await effectEmploymentDocument({
      kind: "TRANSFER",
      id: "t-1",
      actor: MANUAL_ACTOR,
      requireDateReached: true,
      todayKey: "2026-11-13",
    });

    expect(res.applied).toBe(4); // department + title + manager + location
    expect(db.employeeTransfer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1", status: "APPROVED" },
        data: { status: "EFFECTIVE" },
      }),
    );
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-theo" },
        update: {
          jobTitle: "Principal Designer",
          department: "DESIGN",
          location: "Wellington",
        },
      }),
    );
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u-theo" },
        data: { managerId: "u-ada" },
      }),
    );
    const history = db.employeePropertyHistory.createMany.mock.calls[0][0].data;
    expect(history).toHaveLength(4);
    const byProp = Object.fromEntries(history.map((r: { property: string }) => [r.property, r]));
    expect(byProp.department).toMatchObject({
      currentValue: "Engineering",
      newValue: "Design",
    });
    expect(byProp.jobTitle).toMatchObject({
      currentValue: "Senior Frontend Engineer",
      newValue: "Principal Designer",
    });
    expect(byProp.manager).toMatchObject({
      currentValue: "Ingrid Solberg",
      newValue: "Ada Lovelace",
    });
    expect(byProp.location).toMatchObject({
      currentValue: "Auckland",
      newValue: "Wellington",
    });
    for (const row of history) {
      expect(row.sourceKind).toBe("TRANSFER");
      expect(row.userId).toBe("u-theo");
    }
    expect(db.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recipientUserId: "u-theo", type: "INFO" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.transfer_effective",
        entityType: "EMPLOYEE_TRANSFER",
        entityId: "t-1",
      }),
    );
  });

  it("an explicit manager clear (\"\") sets the reporting line to null", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(transferDoc({ toManagerId: "" }));
    await effectEmploymentDocument({
      kind: "TRANSFER",
      id: "t-1",
      actor: MANUAL_ACTOR,
      requireDateReached: true,
      todayKey: "2026-11-13",
    });
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { managerId: null },
      }),
    );
  });

  it("a manager-only transfer skips the profile upsert entirely", async () => {
    db.employeeTransfer.findUnique.mockResolvedValue(
      transferDoc({ toDepartment: null, toManagerId: "u-ada" }),
    );
    await effectEmploymentDocument({
      kind: "TRANSFER",
      id: "t-1",
      actor: MANUAL_ACTOR,
      requireDateReached: true,
      todayKey: "2026-11-13",
    });
    expect(db.employeeProfile.upsert).not.toHaveBeenCalled();
    expect(db.user.update).toHaveBeenCalled();
  });
});

describe("G6 effect core — the promotion application + salary coexistence", () => {
  it("writes the designation + grade, and the property history carries them", async () => {
    db.employeePromotion.findUnique.mockResolvedValue(promotionDoc());
    const res = await effectEmploymentDocument({
      kind: "PROMOTION",
      id: "p-1",
      actor: MANUAL_ACTOR,
      requireDateReached: true,
      todayKey: "2026-11-13",
    });
    expect(res.applied).toBe(2);
    expect(db.employeeProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { jobTitle: "Staff Engineer", grade: "L5" },
      }),
    );
    const history = db.employeePropertyHistory.createMany.mock.calls[0][0].data;
    const byProp = Object.fromEntries(history.map((r: { property: string }) => [r.property, r]));
    expect(byProp.jobTitle).toMatchObject({
      currentValue: "Senior Frontend Engineer",
      newValue: "Staff Engineer",
    });
    expect(byProp.grade).toMatchObject({ currentValue: "L4", newValue: "L5" });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.promotion_effective" }),
    );
  });

  it("spec §3 — a linked salary revision is provenance ONLY: the promotion never touches the salary tables, and a same-date assignment never blocks it", async () => {
    db.employeePromotion.findUnique.mockResolvedValue(
      promotionDoc({ linkedSalaryAssignmentId: "sa-1" }),
    );
    // A Phase 1B assignment exists for the same employee on the same date —
    // the conflict rule only guards transfer/promotion documents.
    db.salaryStructureAssignment.findFirst.mockResolvedValue({ id: "sa-1" });
    const res = await effectEmploymentDocument({
      kind: "PROMOTION",
      id: "p-1",
      actor: MANUAL_ACTOR,
      requireDateReached: true,
      todayKey: "2026-11-13",
    });
    expect(res.applied).toBe(2);
    expect(db.salaryStructureAssignment.findFirst).not.toHaveBeenCalled();
    expect(db.salaryStructureAssignment.create).not.toHaveBeenCalled();
    expect(db.salaryStructureAssignment.update).not.toHaveBeenCalled();
    expect(db.salaryStructure.updateMany).not.toHaveBeenCalled();
    expect(db.salaryStructure.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

describe("G6 — runDueEmploymentDocumentsJob (the daily sweep)", () => {
  it("effects the due documents of both kinds, oldest first, with the cron actor", async () => {
    db.employeeTransfer.findMany.mockResolvedValue([{ id: "t-1" }, { id: "t-2" }]);
    db.employeePromotion.findMany.mockResolvedValue([{ id: "p-1" }]);
    db.employeeTransfer.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "t-1" ? transferDoc() : transferDoc({ id: "t-2", toManagerId: "u-ada" }),
    );
    db.employeePromotion.findUnique.mockResolvedValue(promotionDoc());

    const report = await runDueEmploymentDocumentsJob("2026-11-13");

    expect(report).toMatchObject({ considered: 3, effected: 3, failed: 0 });
    // The due filter: APPROVED with effectiveDate ≤ end of today.
    const where = db.employeeTransfer.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("APPROVED");
    expect(where.effectiveDate.lte.getTime()).toBeGreaterThan(
      new Date("2026-11-13T00:00:00.000Z").getTime(),
    );
    // The cron identity rides every audit + property row.
    const historyCalls = db.employeePropertyHistory.createMany.mock.calls;
    expect(historyCalls.length).toBeGreaterThan(0);
    for (const call of historyCalls) {
      for (const row of call[0].data) {
        expect(row.createdById).toBe(CRON_ACTOR.userId);
      }
    }
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: CRON_ACTOR, action: "hr.transfer_effective" }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: CRON_ACTOR, action: "hr.promotion_effective" }),
    );
  });

  it("per-document isolation — one failing document never stops the pass", async () => {
    db.employeeTransfer.findMany.mockResolvedValue([{ id: "t-bad" }, { id: "t-good" }]);
    db.employeeTransfer.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "t-bad"
        ? transferDoc({ id: "t-bad", status: "CANCELLED" }) // refused: not APPROVED
        : transferDoc({ id: "t-good" }),
    );
    const report = await runDueEmploymentDocumentsJob("2026-11-13");
    expect(report).toMatchObject({ considered: 2, effected: 1, failed: 1 });
    expect(report.failuresDetail[0]).toContain("t-bad");
    expect(db.employeeTransfer.updateMany).toHaveBeenCalledTimes(1); // only t-good flipped
  });

  it("idempotency rides the status flip — nothing due means nothing done", async () => {
    const report = await runDueEmploymentDocumentsJob("2026-11-13");
    expect(report).toMatchObject({ considered: 0, effected: 0, failed: 0 });
    expect(db.employeeTransfer.updateMany).not.toHaveBeenCalled();
    expect(db.employeePromotion.updateMany).not.toHaveBeenCalled();
  });
});
