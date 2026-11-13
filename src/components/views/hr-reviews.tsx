"use client";

// HR module feature 3 — performance reviews UI (docs/HR_MODULE_PLAN.md §6).
// ReviewsTab: the manager/admin console (queue + create cycle + review modal).
// MyReviewsSection: employee self-service (write + submit self-assessment,
// acknowledge the reviewed result) in the Settings view.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, Plus } from "lucide-react";
import { toast } from "sonner";
import { Section } from "../ui/section";
import { Field, FormRow } from "../ui/field";
import { Modal } from "../ui/modal";
import { FilterBar } from "../ui/filter-bar";
import { REVIEW_STATUS_BADGE, REVIEW_STATUS_LABELS } from "@/lib/shared/config";
import type { PerformanceReviewT } from "@/lib/types";
import { cn } from "@/lib/shared/utils";
import {
  getReviewQueue,
  createReview,
  decideReview,
  getMyReviews,
  saveSelfAssessment,
  submitReview,
  acknowledgeReview,
} from "@/server-actions/hr-reviews";
import { getDirectory } from "@/server-actions/hr-directory";
import { useApp } from "@/store/app-store";
import { fmtDay } from "@/lib/shared/format";

function fmtPeriod(r: PerformanceReviewT): string {
  return `${fmtDay(r.periodStart)} → ${fmtDay(r.periodEnd)}`;
}

// ---------------------------------------------------------------------------
// HR console tab
// ---------------------------------------------------------------------------

export function ReviewsTab() {
  const [reviews, setReviews] = useState<PerformanceReviewT[] | null>(null);
  const [roster, setRoster] = useState<{ userId: string; name: string }[]>([]);
  const [filter, setFilter] = useState("ALL");
  const [creating, setCreating] = useState(false);
  const [reviewing, setReviewing] = useState<PerformanceReviewT | null>(null);
  const { bumpRefresh } = useApp();

  const load = useCallback(async () => {
    const [queueRes, dirRes] = await Promise.all([getReviewQueue(), getDirectory()]);
    if (queueRes.ok) {
      setReviews(queueRes.data.reviews);
    } else {
      toast.error(queueRes.error);
      setReviews([]);
    }
    if (dirRes.ok) setRoster(dirRes.data.profiles.map((p) => ({ userId: p.userId, name: p.name })));
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const filters = useMemo(
    () => [
      { key: "ALL", label: "All", count: reviews?.length ?? 0 },
      { key: "DRAFT", label: "Draft", count: reviews?.filter((r) => r.status === "DRAFT").length ?? 0 },
      { key: "SUBMITTED", label: "Submitted", count: reviews?.filter((r) => r.status === "SUBMITTED").length ?? 0 },
      { key: "REVIEWED", label: "Reviewed", count: reviews?.filter((r) => r.status === "REVIEWED").length ?? 0 },
      { key: "ACKNOWLEDGED", label: "Acknowledged", count: reviews?.filter((r) => r.status === "ACKNOWLEDGED").length ?? 0 },
    ],
    [reviews],
  );
  const visible = (reviews ?? []).filter((r) => filter === "ALL" || r.status === filter);

  if (reviews === null) {
    return <div className="p-6 text-sm text-muted-foreground">Loading review cycles…</div>;
  }

  return (
    <div className="space-y-3" data-testid="hr-reviews">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <FilterBar filters={filters} value={filter} onChange={(v) => setFilter(v)} />
        <button className="f-btn f-btn-primary f-btn-sm" onClick={() => setCreating(true)}>
          <Plus size={14} /> New Cycle
        </button>
      </div>

      <div className="f-card overflow-hidden">
        {visible.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No review cycles match this filter.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="px-4 py-2 font-semibold">Employee</th>
                <th className="px-4 py-2 font-semibold">Cycle</th>
                <th className="px-4 py-2 font-semibold">Period</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Ratings</th>
                <th className="px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} data-testid={`review-row-${r.title}`}>
                  <td className="px-4 py-2.5 font-medium">{r.userName}</td>
                  <td className="px-4 py-2.5">
                    {r.title}{" "}
                    {r.kind === "PROBATION" ? (
                      <span className={cn("inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium ml-1", "bg-amber-500/10 text-amber-700 dark:text-amber-400")} data-testid="probation-tag">
                        Probation
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{fmtPeriod(r)}</td>
                  <td className="px-4 py-2.5">
                    <span className={cn("inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium", REVIEW_STATUS_BADGE[r.status])}>
                      {REVIEW_STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground tabular-nums text-[0.8125rem]">
                    {r.selfRating ? `self ${r.selfRating}/5` : "—"}
                    {r.managerRating ? ` · mgr ${r.managerRating}/5` : ""}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.status === "SUBMITTED" && (
                      <button
                        className="f-btn f-btn-primary f-btn-sm"
                        data-testid={`review-btn-${r.title}`}
                        onClick={() => setReviewing(r)}
                      >
                        Review
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <CreateReviewModal
        open={creating}
        roster={roster}
        onClose={() => setCreating(false)}
        onCreated={async () => {
          setCreating(false);
          await load();
          bumpRefresh();
        }}
      />
      <ReviewDecisionModal
        review={reviewing}
        onClose={() => setReviewing(null)}
        onDecided={load}
      />
    </div>
  );
}

function CreateReviewModal({
  open, roster, onClose, onCreated,
}: {
  open: boolean;
  roster: { userId: string; name: string }[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const year = new Date().getUTCFullYear();
  const [userId, setUserId] = useState("");
  const [title, setTitle] = useState("");
  const [periodStart, setPeriodStart] = useState(`${year}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(`${year}-12-31`);
  // F1.6 — PROBATION cycles are the §9.3 gate's input: completing one is
  // what unlocks PROBATION → ACTIVE in the directory.
  const [kind, setKind] = useState<"STANDARD" | "PROBATION">("STANDARD");
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title="Open a review cycle">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await createReview({ userId, title, periodStart, periodEnd, kind });
          setBusy(false);
          if (res.ok) {
            toast.success("Review cycle opened");
            setTitle("");
            await onCreated();
          } else {
            toast.error(res.error);
          }
        }}
      >
        <Field label="Employee">
          <select className="f-input" value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="" disabled>Select an employee…</option>
            {roster.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Cycle title">
          <input className="f-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={`e.g. ${year} Mid-year review`} required />
        </Field>
        <Field label="Review type">
          <select
            className="f-input"
            value={kind}
            data-testid="review-kind-select"
            onChange={(e) => setKind(e.target.value as "STANDARD" | "PROBATION")}
          >
            <option value="STANDARD">Standard review</option>
            <option value="PROBATION">Probation review</option>
          </select>
        </Field>
        <FormRow>
          <Field label="Period start">
            <input type="date" className="f-input" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
          </Field>
          <Field label="Period end">
            <input type="date" className="f-input" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
          </Field>
        </FormRow>
        {kind === "PROBATION" ? (
          <div className="text-xs text-muted-foreground" data-testid="probation-kind-hint">
            A completed probation review is required before a probationing employee can be confirmed as active (directory → Employment → Active).
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy || !userId}>
            {busy ? "Opening…" : "Open cycle"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReviewDecisionModal({
  review, onClose, onDecided,
}: { review: PerformanceReviewT | null; onClose: () => void; onDecided: () => Promise<void> }) {
  const [comment, setComment] = useState("");
  const [rating, setRating] = useState("3");
  const [busy, setBusy] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setComment(""); setRating("3"); }, [review?.id]);

  if (!review) return null;

  return (
    <Modal open={Boolean(review)} onClose={onClose} title={`Review — ${review.title}`}>
      <div className="space-y-4">
        <div className="text-sm">
          <div className="font-medium text-foreground">{review.userName}</div>
          <div className="text-muted-foreground mt-1">{fmtPeriod(review)}</div>
          {review.selfAssessment ? (
            <div className="mt-2 text-[0.8125rem] italic text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto f-scroll">
              “{review.selfAssessment}”
            </div>
          ) : (
            <div className="mt-2 text-[0.8125rem] text-muted-foreground">No self-assessment text.</div>
          )}
          {review.selfRating && <div className="mt-1 text-xs text-muted-foreground">Self rating: {review.selfRating}/5</div>}
        </div>
        <Field label="Manager comment (shown to the employee)">
          <textarea className="f-input min-h-24" maxLength={10_000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Strengths, growth areas, next steps…" />
        </Field>
        <Field label="Rating (1-5)">
          <select className="f-input w-auto" value={rating} onChange={(e) => setRating(e.target.value)}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} — {["Needs improvement", "Developing", "Meets expectations", "Exceeds expectations", "Outstanding"][n - 1]}</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <button className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="f-btn f-btn-primary f-btn-sm"
            disabled={busy || comment.trim().length === 0}
            data-testid="complete-review"
            onClick={async () => {
              setBusy(true);
              const res = await decideReview({ reviewId: review.id, managerComment: comment, managerRating: Number(rating) });
              setBusy(false);
              if (res.ok) {
                toast.success("Review completed");
                onClose();
                await onDecided();
              } else {
                toast.error(res.error);
              }
            }}
          >
            {busy ? "Saving…" : "Complete review"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Self-service (Settings view)
// ---------------------------------------------------------------------------

export function MyReviewsSection() {
  const [reviews, setReviews] = useState<PerformanceReviewT[] | null>(null);
  const [active, setActive] = useState<PerformanceReviewT | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftRating, setDraftRating] = useState("");
  const [busy, setBusy] = useState(false);
  const { bumpRefresh } = useApp();

  const load = useCallback(async () => {
    const res = await getMyReviews();
    if (res.ok) setReviews(res.data);
    else setReviews([]);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const openDraft = (r: PerformanceReviewT) => {
    setActive(r);
    setDraftText(r.selfAssessment);
    setDraftRating(r.selfRating ? String(r.selfRating) : "");
  };

  return (
    <Section icon={ClipboardCheck} title="My reviews" description="Your performance review cycles — write your self-assessment, submit it, and acknowledge the result">
      {reviews === null ? (
        <div className="text-sm text-muted-foreground py-2">Loading review cycles…</div>
      ) : reviews.length === 0 ? (
        <div className="text-sm text-muted-foreground">No review cycles have been opened for you yet.</div>
      ) : (
        <div className="space-y-2">
          {reviews.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3" data-testid={`my-review-${r.title}`}>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground truncate">
                  {r.title}{" "}
                  {r.kind === "PROBATION" ? (
                    <span className={cn("inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium ml-1", "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
                      Probation
                    </span>
                  ) : null}
                </div>
                <div className="text-[0.6875rem] text-muted-foreground">{fmtPeriod(r)}{r.managerRating ? ` · mgr ${r.managerRating}/5` : ""}{r.reviewedBy ? ` · by ${r.reviewedBy}` : ""}</div>
                {r.status === "REVIEWED" && r.managerComment && (
                  <div className="text-[0.6875rem] text-muted-foreground mt-1 line-clamp-2">“{r.managerComment}”</div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={cn("inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium", REVIEW_STATUS_BADGE[r.status])}>
                  {REVIEW_STATUS_LABELS[r.status]}
                </span>
                {r.status === "DRAFT" && (
                  <button className="f-btn f-btn-primary f-btn-sm" onClick={() => openDraft(r)}>Write</button>
                )}
                {r.status === "REVIEWED" && (
                  <button
                    className="f-btn f-btn-primary f-btn-sm"
                    data-testid={`ack-${r.title}`}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const res = await acknowledgeReview({ reviewId: r.id });
                      setBusy(false);
                      if (res.ok) {
                        toast.success("Review acknowledged");
                        await load();
                        bumpRefresh();
                      } else {
                        toast.error(res.error);
                      }
                    }}
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={Boolean(active)} onClose={() => setActive(null)} title={active ? `Self-assessment — ${active.title}` : ""}>
        {active && (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const saveRes = await saveSelfAssessment({
                reviewId: active.id,
                selfAssessment: draftText,
                ...(draftRating ? { selfRating: Number(draftRating) } : {}),
              });
              if (!saveRes.ok) {
                setBusy(false);
                toast.error(saveRes.error);
                return;
              }
              const submitRes = await submitReview({ reviewId: active.id });
              setBusy(false);
              if (submitRes.ok) {
                toast.success("Self-assessment submitted");
                setActive(null);
                await load();
                bumpRefresh();
              } else {
                toast.error(submitRes.error);
              }
            }}
          >
            <div className="text-xs text-muted-foreground">{fmtPeriod(active)} — submitting locks your answers and notifies your manager.</div>
            <Field label="Self-assessment">
              <textarea className="f-input min-h-40" maxLength={10_000} value={draftText} onChange={(e) => setDraftText(e.target.value)} placeholder="What went well? What would you do differently? Where do you want to grow?" />
            </Field>
            <Field label="Self rating (1-5)">
              <select className="f-input w-auto" value={draftRating} onChange={(e) => setDraftRating(e.target.value)}>
                <option value="">No rating</option>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={() => setActive(null)}>Cancel</button>
              <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy}>
                {busy ? "Submitting…" : "Save & submit"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </Section>
  );
}
