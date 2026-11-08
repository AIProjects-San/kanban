import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HR module feature 3 — performance review action tests
// (docs/HR_MODULE_PLAN.md §6): all four lifecycle transitions, chain-scoped
// decisions, ownership denials, rating validation.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["performanceReview", "user", "auditLog", "notification", "employeeProfile"];
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

// PR-56 — partial mock so the best-effort notification catch blocks can be
// asserted (and so they don't spam the console). Everything but logError
// stays real, matching the __tests__/shared.test.ts convention.
const logErrorSpy = vi.fn();
vi.mock("@/lib/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability")>();
  return { ...actual, logError: (...args: unknown[]) => logErrorSpy(...args) };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createReview,
  saveSelfAssessment,
  submitReview,
  decideReview,
  acknowledgeReview,
  getMyReviews,
  getReviewQueue,
} from "../hr-reviews";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Ada", email: "ada@x.co" };
const MANAGER_AUTH = { userId: "u-mgr", role: "MANAGER" as const, name: "Ingrid", email: "ingrid@x.co" };
const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MEMBER_AUTH = { userId: "u-theo", role: "MEMBER" as const, name: "Theo", email: "theo@x.co" };

const DRAFT_REVIEW = {
  id: "pr-1",
  userId: "u-theo",
  title: "2026 Mid-year review",
  periodStart: new Date("2026-01-01T00:00:00.000Z"),
  periodEnd: new Date("2026-12-31T00:00:00.000Z"),
  status: "DRAFT",
  selfAssessment: "",
  selfRating: null,
  managerComment: "",
  managerRating: null,
  reviewedById: null,
  reviewedAt: null,
  acknowledgedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  db.performanceReview.findMany.mockResolvedValue([]);
  db.performanceReview.findUnique.mockResolvedValue(null);
  db.performanceReview.create.mockResolvedValue({ id: "pr-new" });
  db.performanceReview.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.notification.create.mockResolvedValue({});
  db.notification.createMany.mockResolvedValue({ count: 0 });
});

describe("createReview", () => {
  it("opens a DRAFT cycle for a subtree report (manager) and notifies them", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    // getSubtreeUserIds("u-mgr") walks db.user.findMany({ managerId }) —
    // Ingrid's direct reports are Theo (one level).
    db.user.findMany.mockResolvedValue([{ id: "u-theo" }]);
    const res = await createReview({ userId: "u-theo", title: "2026 Mid-year", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "u-theo", status: "DRAFT" }) }),
    );
    expect(db.notification.create).toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "review.created" }),
    );
  });

  it("rejects opening a cycle for someone outside the manager's subtree", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-stranger", name: "Stranger", deletedAt: null });
    db.user.findMany.mockResolvedValue([]); // no reports outside herself
    const res = await createReview({ userId: "u-stranger", title: "X", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/own reports/i);
  });

  it("rejects a period that ends before it starts", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    const res = await createReview({ userId: "u-theo", title: "X", periodStart: "2026-12-31", periodEnd: "2026-01-01" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/period end/i);
  });

  // F1.6 — PROBATION-kind cycles are the §9.3 gate's input: completing one
  // unlocks PROBATION → ACTIVE in the directory.
  it("F1.6: opens a PROBATION-kind cycle when the type is passed", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    db.user.findMany.mockResolvedValue([{ id: "u-theo" }]);
    const res = await createReview({
      userId: "u-theo",
      title: "Probation review — Theo",
      periodStart: "2026-08-15",
      periodEnd: "2026-11-15",
      kind: "PROBATION",
    });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "u-theo", status: "DRAFT", kind: "PROBATION" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review.created",
        detail: expect.stringContaining("probation review cycle"),
      }),
    );
  });
});

describe("saveSelfAssessment", () => {
  it("saves text + rating on the owner's DRAFT cycle", async () => {
    db.performanceReview.findUnique.mockResolvedValue(DRAFT_REVIEW);
    const res = await saveSelfAssessment({ reviewId: "pr-1", selfAssessment: "Shipped lots.", selfRating: 4 });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ selfAssessment: "Shipped lots.", selfRating: 4 }) }),
    );
  });

  it("refuses editing someone else's cycle", async () => {
    db.performanceReview.findUnique.mockResolvedValue({ ...DRAFT_REVIEW, userId: "u-someone" });
    const res = await saveSelfAssessment({ reviewId: "pr-1", selfAssessment: "x" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/own self-assessment/i);
  });

  it("refuses editing after submission", async () => {
    db.performanceReview.findUnique.mockResolvedValue({ ...DRAFT_REVIEW, status: "SUBMITTED" });
    const res = await saveSelfAssessment({ reviewId: "pr-1", selfAssessment: "x" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/submitted/i);
  });

  it("rejects an out-of-range rating", async () => {
    db.performanceReview.findUnique.mockResolvedValue(DRAFT_REVIEW);
    const res = await saveSelfAssessment({ reviewId: "pr-1", selfAssessment: "x", selfRating: 9 });
    expect(res.ok).toBe(false);
    expect(db.performanceReview.update).not.toHaveBeenCalled();
  });
});

describe("submitReview", () => {
  it("moves the owner's DRAFT to SUBMITTED and notifies the manager", async () => {
    db.performanceReview.findUnique.mockResolvedValue(DRAFT_REVIEW);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    const res = await submitReview({ reviewId: "pr-1" });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUBMITTED" }) }),
    );
    expect(db.notification.createMany).toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "review.submitted" }));
  });

  it("refuses submitting someone else's cycle", async () => {
    db.performanceReview.findUnique.mockResolvedValue({ ...DRAFT_REVIEW, userId: "u-someone" });
    const res = await submitReview({ reviewId: "pr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/own/i);
  });
});

describe("decideReview", () => {
  const SUBMITTED = { ...DRAFT_REVIEW, status: "SUBMITTED", selfAssessment: "Did things.", selfRating: 3 };

  it("the subject's manager completes the review with a rating", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.performanceReview.findUnique.mockResolvedValue(SUBMITTED);
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" }); // Theo → Ingrid
    const res = await decideReview({ reviewId: "pr-1", managerComment: "Strong half.", managerRating: 4 });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REVIEWED", managerComment: "Strong half.", managerRating: 4, reviewedById: "u-mgr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "review.reviewed" }));
  });

  it("rejects a manager outside the subject's chain", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.performanceReview.findUnique.mockResolvedValue(SUBMITTED);
    db.user.findUnique.mockResolvedValue({ managerId: "u-other-mgr" });
    const res = await decideReview({ reviewId: "pr-1", managerComment: "x", managerRating: 3 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/manager/i);
  });

  it("refuses reviewing a cycle that is not SUBMITTED", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.performanceReview.findUnique.mockResolvedValue({ ...SUBMITTED, status: "DRAFT" });
    const res = await decideReview({ reviewId: "pr-1", managerComment: "x", managerRating: 3 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/submitted/i);
  });

  it("rejects an out-of-range rating", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.performanceReview.findUnique.mockResolvedValue(SUBMITTED);
    const res = await decideReview({ reviewId: "pr-1", managerComment: "x", managerRating: 0 });
    expect(res.ok).toBe(false);
    expect(db.performanceReview.update).not.toHaveBeenCalled();
  });

  // QA-11 — plan §6: "Reviewers must be in the subject's manager chain (or
  // ADMIN/HR)". The original ADMIN-only short-circuit in assertReviewer
  // rejected HR even though the RBAC matrix grants HR review:manage.
  it("QA-11: HR completes a review without being in the subject's chain", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.performanceReview.findUnique.mockResolvedValue(SUBMITTED);
    // Remy (HR) is NOT in Theo's chain — the old code rejected this call.
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    const res = await decideReview({ reviewId: "pr-1", managerComment: "HR-organized cycle.", managerRating: 4 });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REVIEWED", reviewedById: "u-hr", managerRating: 4 }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // QA-17 — plan §6 scopes reviewers to "the subject's manager chain", not
  // just the immediate manager (§3 even names getManagerChain() as the
  // resolution mechanism). The guard resolved ONE level (User.managerId),
  // so a grand-manager was rejected with "Only the employee's manager…".
  // In the seed, Soren → Lena → Ingrid: only Lena could review Soren's
  // cycle; if Lena is unavailable, only ADMIN/HR could step in.
  // -----------------------------------------------------------------------

  const CHAIN_BY_ID: Record<string, { managerId: string | null }> = {
    "u-soren": { managerId: "u-lena" },   // Soren → Lena
    "u-lena": { managerId: "u-mgr" },     // Lena → Ingrid (the grand-manager)
    "u-mgr": { managerId: null },         // Ingrid is the root of this chain
  };

  it("QA-17: a skip-level manager in the subject's chain can complete the review", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH); // Ingrid
    db.performanceReview.findUnique.mockResolvedValue({ ...SUBMITTED, userId: "u-soren" });
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      CHAIN_BY_ID[where.id] ?? null,
    );
    const res = await decideReview({ reviewId: "pr-1", managerComment: "Covering for Lena.", managerRating: 4 });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REVIEWED", reviewedById: "u-mgr" }),
      }),
    );
  });

  it("QA-17: a manager one level up but OUTSIDE the chain is still rejected", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH); // Ingrid, NOT in Soren's chain below
    db.performanceReview.findUnique.mockResolvedValue({ ...SUBMITTED, userId: "u-soren" });
    // Soren reports to Priya's org instead — Ingrid is a stranger here.
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "u-soren" ? { managerId: "u-priya" } : { managerId: null },
    );
    const res = await decideReview({ reviewId: "pr-1", managerComment: "x", managerRating: 3 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/manager/i);
  });

  it("QA-17: the subject themself is never in their own reviewer chain", async () => {
    requirePermissionMock.mockResolvedValue({ ...MANAGER_AUTH, userId: "u-soren", role: "MANAGER" as const });
    db.performanceReview.findUnique.mockResolvedValue({ ...SUBMITTED, userId: "u-soren" });
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      CHAIN_BY_ID[where.id] ?? null,
    );
    const res = await decideReview({ reviewId: "pr-1", managerComment: "self-review attempt", managerRating: 5 });
    expect(res.ok).toBe(false);
  });

  // -----------------------------------------------------------------------
  // QA-20 — ADMIN/HR bypass the chain check entirely, so the SUBJECT of a
  // cycle (if they hold ADMIN or HR) could write their own manager review,
  // stamp themselves as the reviewer and rate themselves. The plan's model
  // is "manager reviews, employee acknowledges" — the employee must never
  // sit on both sides of the table, regardless of role.
  // -----------------------------------------------------------------------

  it("QA-20: an ADMIN cannot review their own cycle", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH); // u-admin
    db.performanceReview.findUnique.mockResolvedValue({ ...SUBMITTED, userId: "u-admin" });
    const res = await decideReview({ reviewId: "pr-1", managerComment: "Great work, me.", managerRating: 5 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/own/i);
    expect(db.performanceReview.update).not.toHaveBeenCalled();
  });

  it("QA-20: an HR user cannot review their own cycle", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH); // u-hr
    db.performanceReview.findUnique.mockResolvedValue({ ...SUBMITTED, userId: "u-hr" });
    const res = await decideReview({ reviewId: "pr-1", managerComment: "Modest, honest.", managerRating: 3 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/own/i);
    expect(db.performanceReview.update).not.toHaveBeenCalled();
  });
});

describe("acknowledgeReview", () => {
  it("the owner acknowledges a REVIEWED cycle (terminal)", async () => {
    db.performanceReview.findUnique.mockResolvedValue({
      ...DRAFT_REVIEW, status: "REVIEWED", managerRating: 4, reviewedById: "u-mgr",
    });
    const res = await acknowledgeReview({ reviewId: "pr-1" });
    expect(res.ok).toBe(true);
    expect(db.performanceReview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ACKNOWLEDGED", acknowledgedAt: expect.any(Date) }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "review.acknowledged" }));
  });

  it("refuses acknowledging before the manager review", async () => {
    db.performanceReview.findUnique.mockResolvedValue({ ...DRAFT_REVIEW, status: "SUBMITTED" });
    const res = await acknowledgeReview({ reviewId: "pr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/reviewed/i);
  });
});

describe("reads", () => {
  it("getMyReviews serializes the caller's cycles with reviewer names", async () => {
    db.performanceReview.findMany.mockResolvedValue([{ ...DRAFT_REVIEW, status: "REVIEWED", reviewedById: "u-mgr" }]);
    db.user.findMany.mockResolvedValue([{ id: "u-mgr", name: "Ingrid Solberg" }]);
    const res = await getMyReviews();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]).toMatchObject({ status: "REVIEWED", reviewedBy: "Ingrid Solberg" });
    }
  });

  it("getReviewQueue scopes a MANAGER to their subtree", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.performanceReview.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([{ id: "u-theo" }]); // Ingrid → Theo
    const res = await getReviewQueue();
    expect(res.ok).toBe(true);
    expect(db.performanceReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: { in: ["u-mgr", "u-theo"] } }) }),
    );
  });
});

describe("additional transition denials + queue fallbacks", () => {
  it("submitReview refuses a cycle that is not DRAFT", async () => {
    db.performanceReview.findUnique.mockResolvedValue({ ...DRAFT_REVIEW, status: "REVIEWED" });
    const res = await submitReview({ reviewId: "pr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/draft/i);
  });

  it("acknowledgeReview refuses someone else's cycle", async () => {
    db.performanceReview.findUnique.mockResolvedValue({ ...DRAFT_REVIEW, status: "REVIEWED", userId: "u-someone" });
    const res = await acknowledgeReview({ reviewId: "pr-1" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/own/i);
  });

  it("getReviewQueue renders the former-user fallback for deleted subjects", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.performanceReview.findMany.mockResolvedValue([DRAFT_REVIEW]);
    db.user.findMany.mockResolvedValue([]); // subject no longer resolves
    const res = await getReviewQueue();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.reviews[0].userName).toBe("(former user)");
      expect(res.data.reviews[0].reviewedBy).toBeNull();
    }
  });

  it("getMyReviews returns an empty list for a user with no cycles", async () => {
    db.performanceReview.findMany.mockResolvedValue([]);
    const res = await getMyReviews();
    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PR-56 — remaining branch coverage: the not-found guards on every
// transition and the best-effort notification catch blocks.
// ---------------------------------------------------------------------------

describe("PR-56 — remaining branch coverage", () => {
  it("pins hr-reviews.ts:163 — an unknown subject cannot get a review cycle", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue(null);

    const res = await createReview({ userId: "u-ghost", title: "2026 Mid-year", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/employee not found/i);
    expect(db.performanceReview.create).not.toHaveBeenCalled();
  });

  it("pins hr-reviews.ts:163 — a soft-deleted subject cannot get a review cycle either", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: new Date("2026-01-01T00:00:00.000Z") });

    const res = await createReview({ userId: "u-theo", title: "2026 Mid-year", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/employee not found/i);
    expect(db.performanceReview.create).not.toHaveBeenCalled();
  });

  it("pins hr-reviews.ts:199 — a notification failure never breaks cycle creation", async () => {
    requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
    db.user.findUnique.mockResolvedValue({ id: "u-theo", name: "Theo Vance", deletedAt: null });
    db.notification.create.mockRejectedValue(new Error("mail queue down"));

    const res = await createReview({ userId: "u-theo", title: "2026 Mid-year", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ id: "pr-new" });
    expect(logErrorSpy).toHaveBeenCalledWith("[hr-reviews] notification create failed:", expect.any(Error));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "review.created" }));
  });

  it("pins hr-reviews.ts:229 — saving a self-assessment on an unknown cycle fails", async () => {
    db.performanceReview.findUnique.mockResolvedValue(null);

    const res = await saveSelfAssessment({ reviewId: "pr-ghost", selfAssessment: "x" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("AUTH");
    expect(res.ok === false && res.error).toMatch(/review not found/i);
    expect(db.performanceReview.update).not.toHaveBeenCalled();
  });

  it("pins hr-reviews.ts:263 — submitting an unknown cycle fails", async () => {
    db.performanceReview.findUnique.mockResolvedValue(null);

    const res = await submitReview({ reviewId: "pr-ghost" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/review not found/i);
    expect(db.performanceReview.update).not.toHaveBeenCalled();
  });

  it("pins hr-reviews.ts:291 — a notification failure never breaks submission", async () => {
    db.performanceReview.findUnique.mockResolvedValue(DRAFT_REVIEW);
    // The reviewer must resolve so createMany is actually reached.
    db.user.findUnique.mockResolvedValue({ managerId: "u-mgr" });
    db.notification.createMany.mockRejectedValue(new Error("broker down"));

    const res = await submitReview({ reviewId: "pr-1" });
    expect(res.ok).toBe(true);
    expect(logErrorSpy).toHaveBeenCalledWith("[hr-reviews] notification createMany failed:", expect.any(Error));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "review.submitted" }));
  });

  it("pins hr-reviews.ts:312 — acknowledging an unknown cycle fails", async () => {
    db.performanceReview.findUnique.mockResolvedValue(null);

    const res = await acknowledgeReview({ reviewId: "pr-ghost" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/review not found/i);
    expect(db.performanceReview.update).not.toHaveBeenCalled();
  });

  it("pins hr-reviews.ts:351 — deciding an unknown cycle fails", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.performanceReview.findUnique.mockResolvedValue(null);

    const res = await decideReview({ reviewId: "pr-ghost", managerComment: "x", managerRating: 3 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/review not found/i);
    expect(db.performanceReview.update).not.toHaveBeenCalled();
  });

  it("pins hr-reviews.ts:388 — a notification failure never breaks the manager review", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH); // Ingrid
    db.performanceReview.findUnique.mockResolvedValue({ ...DRAFT_REVIEW, status: "SUBMITTED" });
    // Keyed on where.id so the chain walk terminates: Theo → Ingrid → root.
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "u-theo" ? { managerId: "u-mgr" } : { managerId: null });
    db.notification.create.mockRejectedValue(new Error("dead letter"));

    const res = await decideReview({ reviewId: "pr-1", managerComment: "Strong half.", managerRating: 4 });
    expect(res.ok).toBe(true);
    expect(logErrorSpy).toHaveBeenCalledWith("[hr-reviews] notification createMany failed:", expect.any(Error));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "review.reviewed" }));
  });
});
