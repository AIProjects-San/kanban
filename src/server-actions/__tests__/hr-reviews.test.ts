import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HR module feature 3 — performance review action tests
// (docs/HR_MODULE_PLAN.md §6): all four lifecycle transitions, chain-scoped
// decisions, ownership denials, rating validation.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["performanceReview", "user", "auditLog", "notification"];
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
