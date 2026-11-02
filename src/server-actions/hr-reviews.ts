"use server";

// ---------------------------------------------------------------------------
// HR Module feature 3 — performance review server actions
// (docs/HR_MODULE_PLAN.md §6). Self + manager model.
//
// Lifecycle (enforced per transition, mirroring BUG_STATUS_TRANSITIONS):
//   DRAFT → SUBMITTED        (the employee, own review only)
//   SUBMITTED → REVIEWED     (the subject's manager chain, or ADMIN)
//   REVIEWED → ACKNOWLEDGED  (the employee, own review only)
//
// RBAC:
//   settings:edit — self-service reads/writes on OWN reviews
//   review:manage — create cycles for reports; read the review queue
//                   (MANAGER: subtree; ADMIN/HR: whole workspace)
// Decisions are CHAIN-scoped like leave: the subject's manager
// (User.managerId), an ADMIN, or HR writes the manager review — plan §6:
// "Reviewers must be in the subject's manager chain (or ADMIN/HR)".
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { logError } from "@/lib/observability";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { REVIEW_STATUS_LABELS } from "@/lib/config";
import type { ReviewStatus, PerformanceReviewT } from "@/lib/types";
import {
  createReviewSchema,
  selfAssessmentSchema,
  reviewDecisionSchema,
  decideReviewSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { getApproverIdsFor } from "./hr-shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

/**
 * The subject's manager chain, an ADMIN, or HR may write the manager review.
 * QA-11: the plan (docs/HR_MODULE_PLAN.md §6) explicitly grants HR the
 * reviewer role ("the subject's manager chain (or ADMIN/HR)") — the
 * original ADMIN-only short-circuit rejected HR with "Only the employee's
 * manager…", contradicting the approved plan.
 *
 * QA-17: §6 scopes reviewers to the subject's manager CHAIN (§3 even names
 * getManagerChain() as the resolution mechanism) — the guard used to
 * resolve ONE level only (User.managerId), so a grand-manager was rejected
 * with the same message. The chain walk excludes the subject themself and
 * caps at 32 hops (lib/hierarchy.ts).
 */
async function assertReviewer(auth: { userId: string; role: string }, subjectId: string): Promise<void> {
  if (auth.role === "ADMIN" || auth.role === "HR") return;
  const { getManagerChain } = await import("@/lib/hierarchy");
  const chain = await getManagerChain(subjectId);
  if (!chain.includes(auth.userId)) {
    throw new AuthorizationError("Only the employee's manager chain (or an admin) can review this cycle.");
  }
}

function serialize(
  r: {
    id: string; userId: string; title: string;
    periodStart: Date; periodEnd: Date; status: string;
    selfAssessment: string; selfRating: number | null;
    managerComment: string; managerRating: number | null;
    reviewedById: string | null; reviewedAt: Date | null;
    acknowledgedAt: Date | null; createdAt: Date; updatedAt: Date;
  },
  subjectName: string,
  reviewerName: string | null,
): PerformanceReviewT {
  return {
    id: r.id,
    userId: r.userId,
    userName: subjectName,
    title: r.title,
    periodStart: r.periodStart.toISOString().slice(0, 10),
    periodEnd: r.periodEnd.toISOString().slice(0, 10),
    status: r.status as ReviewStatus,
    selfAssessment: r.selfAssessment,
    selfRating: r.selfRating,
    managerComment: r.managerComment,
    managerRating: r.managerRating,
    reviewedBy: reviewerName,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getMyReviews(): Promise<ActionResult<PerformanceReviewT[]>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const rows = await db.performanceReview.findMany({
      where: { userId: auth.userId },
      orderBy: { periodStart: "desc" },
      // PR-21 — hard cap on the self-service review history.
      take: 200,
    });
    const reviewerNames = await namesFor(rows.map((r) => r.reviewedById).filter(Boolean) as string[]);
    return rows.map((r) => serialize(r, auth.name, r.reviewedById ? reviewerNames.get(r.reviewedById) ?? null : null));
  });
}

export async function getReviewQueue(): Promise<
  ActionResult<{ reviews: PerformanceReviewT[]; canCreate: boolean }>
> {
  return toResult(async () => {
    const auth = await requirePermission("review:manage");

    let visibleUserIds: string[] | null = null;
    if (auth.role === "MANAGER") {
      const { getSubtreeUserIds } = await import("@/lib/hierarchy");
      visibleUserIds = [...(await getSubtreeUserIds(auth.userId))];
    }

    const rows = await db.performanceReview.findMany({
      where: visibleUserIds ? { userId: { in: visibleUserIds } } : {},
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      // PR-21 — hard cap; same rationale as the leave queue.
      take: 500,
    });
    const names = await namesFor([...rows.map((r) => r.userId), ...rows.map((r) => r.reviewedById).filter(Boolean) as string[]]);
    return {
      reviews: rows.map((r) => serialize(r, names.get(r.userId) ?? "(former user)", r.reviewedById ? names.get(r.reviewedById) ?? null : null)),
      canCreate: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Create (review:manage — the subject must be in the creator's subtree,
// or the creator is ADMIN/HR; HR may create for anyone since it organizes
// the cycle, but only the chain can WRITE the review itself.)
// ---------------------------------------------------------------------------

export async function createReview(input: {
  userId: string;
  title: string;
  periodStart: string;
  periodEnd: string;
}): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("review:manage");
    const data = parseOrThrow(createReviewSchema, input);

    const subject = await db.user.findUnique({
      where: { id: data.userId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!subject || subject.deletedAt) throw new AuthorizationError("Employee not found.");

    if (auth.role === "MANAGER") {
      const { getSubtreeUserIds } = await import("@/lib/hierarchy");
      const subtree = await getSubtreeUserIds(auth.userId);
      if (!subtree.has(data.userId)) {
        throw new AuthorizationError("You can only open review cycles for your own reports.");
      }
    }

    const start = new Date(`${data.periodStart}T00:00:00.000Z`);
    const end = new Date(`${data.periodEnd}T00:00:00.000Z`);
    if (end < start) throw new AuthorizationError("The period end must be after the period start.");

    const created = await db.performanceReview.create({
      data: {
        userId: data.userId,
        title: data.title,
        periodStart: start,
        periodEnd: end,
        status: "DRAFT",
      },
    });

    // Notify the employee their cycle is open (best-effort).
    try {
      await db.notification.create({
        data: {
          recipientUserId: data.userId,
          type: "INFO",
          title: "Performance review cycle opened",
          message: `${auth.name} opened "${data.title}" (${data.periodStart} → ${data.periodEnd}). Write your self-assessment and submit it.`,
        },
      });
    } catch (err) {
      // Notification failures must never break the mutation.
      logError("[hr-reviews] notification create failed:", err);
    }

    await logAudit({
      actor: auth,
      action: "review.created",
      entityType: "PERFORMANCE_REVIEW",
      entityId: created.id,
      entityLabel: data.title,
      detail: `${auth.name} opened a review cycle "${data.title}" for ${subject.name} (${data.periodStart} → ${data.periodEnd}).`,
    });
    revalidatePath("/");
    return { id: created.id };
  });
}

// ---------------------------------------------------------------------------
// Employee transitions
// ---------------------------------------------------------------------------

export async function saveSelfAssessment(input: {
  reviewId: string;
  selfAssessment: string;
  selfRating?: number;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const data = parseOrThrow(selfAssessmentSchema, input);

    const review = await db.performanceReview.findUnique({ where: { id: data.reviewId } });
    if (!review) throw new AuthorizationError("Review not found.");
    if (review.userId !== auth.userId) {
      throw new AuthorizationError("You can only edit your own self-assessment.");
    }
    if (review.status !== "DRAFT") {
      throw new AuthorizationError(`This cycle is already ${REVIEW_STATUS_LABELS[review.status as ReviewStatus] ?? review.status} — the self-assessment can no longer be edited.`);
    }

    await db.performanceReview.update({
      where: { id: review.id },
      data: {
        selfAssessment: data.selfAssessment,
        ...(data.selfRating !== undefined ? { selfRating: data.selfRating } : {}),
      },
    });

    await logAudit({
      actor: auth,
      action: "review.updated",
      entityType: "PERFORMANCE_REVIEW",
      entityId: review.id,
      entityLabel: review.title,
      detail: `${auth.name} saved their self-assessment for "${review.title}".`,
    });
    revalidatePath("/");
  });
}

export async function submitReview(input: { reviewId: string }): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const data = parseOrThrow(reviewDecisionSchema, input);

    const review = await db.performanceReview.findUnique({ where: { id: data.reviewId } });
    if (!review) throw new AuthorizationError("Review not found.");
    if (review.userId !== auth.userId) {
      throw new AuthorizationError("Only the employee can submit their own self-assessment.");
    }
    if (review.status !== "DRAFT") {
      throw new AuthorizationError(`Only a draft cycle can be submitted — this one is ${review.status.toLowerCase()}.`);
    }

    await db.performanceReview.update({
      where: { id: review.id },
      data: { status: "SUBMITTED", updatedAt: new Date() },
    });

    // Notify the reviewer (best-effort).
    try {
      const reviewerIds = await getApproverIdsFor(review.userId);
      if (reviewerIds.length) {
        await db.notification.createMany({
          data: reviewerIds.map((id) => ({
            recipientUserId: id,
            type: "INFO",
            title: "Self-assessment ready for review",
            message: `${auth.name} submitted their self-assessment for "${review.title}".`,
          })),
        });
      }
    } catch (err) {
      // Never break the mutation on a notification failure.
      logError("[hr-reviews] notification createMany failed:", err);
    }

    await logAudit({
      actor: auth,
      action: "review.submitted",
      entityType: "PERFORMANCE_REVIEW",
      entityId: review.id,
      entityLabel: review.title,
      detail: `${auth.name} submitted their self-assessment for "${review.title}".`,
    });
    revalidatePath("/");
  });
}

export async function acknowledgeReview(input: { reviewId: string }): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("settings:edit");
    const data = parseOrThrow(reviewDecisionSchema, input);

    const review = await db.performanceReview.findUnique({ where: { id: data.reviewId } });
    if (!review) throw new AuthorizationError("Review not found.");
    if (review.userId !== auth.userId) {
      throw new AuthorizationError("Only the employee can acknowledge their own review.");
    }
    if (review.status !== "REVIEWED") {
      throw new AuthorizationError(`Only a reviewed cycle can be acknowledged — this one is ${review.status.toLowerCase()}.`);
    }

    await db.performanceReview.update({
      where: { id: review.id },
      data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), updatedAt: new Date() },
    });

    await logAudit({
      actor: auth,
      action: "review.acknowledged",
      entityType: "PERFORMANCE_REVIEW",
      entityId: review.id,
      entityLabel: review.title,
      detail: `${auth.name} acknowledged the review of "${review.title}".`,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------------------
// Manager transition (chain-scoped)
// ---------------------------------------------------------------------------

export async function decideReview(input: {
  reviewId: string;
  managerComment: string;
  managerRating: number;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("review:manage");
    const data = parseOrThrow(decideReviewSchema, input);

    const review = await db.performanceReview.findUnique({ where: { id: data.reviewId } });
    if (!review) throw new AuthorizationError("Review not found.");
    if (review.status !== "SUBMITTED") {
      throw new AuthorizationError(`Only a submitted cycle can be reviewed — this one is ${review.status.toLowerCase()}.`);
    }
    // QA-20: ADMIN/HR bypass the chain check, so a subject holding either
    // role could otherwise write their own manager review, stamp themselves
    // as the reviewer and rate themselves. The plan's model is "manager
    // reviews, employee acknowledges" — never both sides of the table.
    if (review.userId === auth.userId) {
      throw new AuthorizationError("You cannot review your own cycle — it is reviewed by your manager chain, HR, or another admin.");
    }
    await assertReviewer(auth, review.userId);

    await db.performanceReview.update({
      where: { id: review.id },
      data: {
        status: "REVIEWED",
        managerComment: data.managerComment,
        managerRating: data.managerRating,
        reviewedById: auth.userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Notify the employee (best-effort).
    try {
      await db.notification.create({
        data: {
          recipientUserId: review.userId,
          type: "INFO",
          title: "Your review is ready",
          message: `${auth.name} completed the review of "${review.title}" — acknowledge it to close the cycle.`,
        },
      });
    } catch (err) {
      // Never break the mutation on a notification failure.
      logError("[hr-reviews] notification createMany failed:", err);
    }

    await logAudit({
      actor: auth,
      action: "review.reviewed",
      entityType: "PERFORMANCE_REVIEW",
      entityId: review.id,
      entityLabel: review.title,
      detail: `${auth.name} reviewed "${review.title}" with a rating of ${data.managerRating}/5.`,
    });
    revalidatePath("/");
  });
}
