"use client";

// Persona-audit P0-5 (D-04) — the member-interviewer self-service view.
// HR can assign any employee (including plain members) as an interviewer —
// the scheduler's picker offers the whole directory — but members hold no
// hiring:view, so before this view a member-interviewer could not see the
// assignment, open the candidate, or submit the scorecard the process was
// waiting on. The scoped answer (Greenhouse/Keka-style interviewer panel,
// same shape as the My-Payslips pattern from P0-1): every signed-in user
// sees their OWN assigned, still-open interview stages here and can fill
// their OWN scorecard. The Hiring board, funnel, outbox and offers stay
// hiring:view-gated — this view exposes no candidate PII beyond the stages
// the caller is assigned to.

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ClipboardPen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SCORECARD_RECOMMENDATIONS } from "@/lib/validation";
import { getMyInterviews, saveScorecard } from "@/server-actions/hiring-interviews";

const RECOMMENDATION_LABEL: Record<string, string> = {
  STRONG_HIRE: "Strong hire",
  HIRE: "Hire",
  NO_HIRE: "No hire",
};

type MyInterviewRow = {
  stageId: string;
  stageLabel: string;
  candidateId: string;
  candidateName: string;
  position: string;
  status: string;
  scheduledAt: string | null;
  rating: number | null;
  recommendation: string | null;
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "unscheduled";
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MyInterviewsView({ currentUser }: { currentUser: { id: string; name: string; role: string } }) {
  const [rows, setRows] = useState<MyInterviewRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The scorecard form target (one open form at a time, mirroring the
  // candidate-detail modal's one-form-at-a-time behavior).
  const [formFor, setFormFor] = useState<MyInterviewRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState("");
  const [strengths, setStrengths] = useState("");
  const [concerns, setConcerns] = useState("");
  const [recommendation, setRecommendation] = useState("");
  const [remarks, setRemarks] = useState("");

  const load = useCallback(async () => {
    const res = await getMyInterviews();
    if (res.ok) {
      setRows(res.data);
    } else {
      toast.error(res.error);
      setRows([]);
    }
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const openForm = (m: MyInterviewRow) => {
    setFormFor(m);
    setRating(m.rating ? String(m.rating) : "");
    setStrengths("");
    setConcerns("");
    setRecommendation(m.recommendation ?? "");
    setRemarks("");
  };

  const submitScorecard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formFor) return;
    setBusy(true);
    const res = await saveScorecard({
      stageId: formFor.stageId,
      rating: rating ? Number(rating) : null,
      strengths,
      concerns,
      recommendation: recommendation || null,
      remarks,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? "Could not save the scorecard.");
      return;
    }
    toast.success("Scorecard saved.");
    setFormFor(null);
    await load();
  };

  const hasCard = (m: MyInterviewRow) =>
    m.rating !== null || m.recommendation !== null;

  return (
    <div className="p-6 space-y-5" data-testid="my-interviews-view">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <CalendarClock size={20} /> My Interviews
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {rows.length > 0
              ? `${rows.length} assigned interview${rows.length === 1 ? "" : "s"} waiting on you · ${currentUser.name}`
              : `Interviews assigned to you appear here · ${currentUser.name}`}
          </p>
        </div>
      </div>

      {/* Assigned interviews list */}
      <div className="rounded-lg border border-border" data-testid="my-interviews-list">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <CalendarClock size={14} className="text-indigo-500" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Your assigned interviews
          </div>
          <span className="text-xs text-muted-foreground ml-auto">open stages only</span>
        </div>
        <div className="divide-y divide-border">
          {rows.map((m) => {
            const filled = hasCard(m);
            return (
              <div key={m.stageId} className="px-4 py-3 space-y-2" data-testid="my-interview-row">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium">{m.candidateName}</span>
                  <span className="text-muted-foreground text-xs">
                    {m.position || "Position n/a"} · {m.stageLabel}
                  </span>
                  <span className="text-xs text-indigo-600 ml-auto">{fmtWhen(m.scheduledAt)}</span>
                  {!filled ? (
                    <button
                      className="f-btn f-btn-primary f-btn-sm"
                      onClick={() => openForm(m)}
                      data-testid={`my-interview-fill-${m.stageId}`}
                    >
                      <ClipboardPen size={13} /> Fill scorecard
                    </button>
                  ) : (
                    <button
                      className="f-btn f-btn-secondary f-btn-sm"
                      onClick={() => openForm(m)}
                      data-testid={`my-interview-edit-${m.stageId}`}
                    >
                      <ClipboardPen size={13} /> Edit scorecard
                    </button>
                  )}
                </div>

                {/* Already-filled own scorecard — read summary */}
                {filled && (
                  <div className="rounded-md bg-muted/60 p-2 text-xs space-y-1" data-testid={`my-interview-card-${m.stageId}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">Your scorecard</span>
                      <span className="tabular-nums">{m.rating ?? "—"}/5</span>
                      <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[0.625rem] font-medium">
                        {RECOMMENDATION_LABEL[m.recommendation ?? ""] ?? "no recommendation"}
                      </span>
                    </div>
                  </div>
                )}

                {/* Inline scorecard form — own assignment only */}
                {formFor?.stageId === m.stageId && (
                  <form onSubmit={submitScorecard} className="rounded-md border border-border p-3 space-y-2" data-testid="my-interview-scorecard-form">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block space-y-1">
                        <span className="text-xs font-medium">Rating (1–5)</span>
                        <select className="f-input" value={rating} onChange={(e) => setRating(e.target.value)} data-testid="my-scorecard-rating">
                          <option value="">— Not rated —</option>
                          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </label>
                      <label className="block space-y-1">
                        <span className="text-xs font-medium">Recommendation</span>
                        <select className="f-input" value={recommendation} onChange={(e) => setRecommendation(e.target.value)} data-testid="my-scorecard-recommendation">
                          <option value="">— None —</option>
                          {SCORECARD_RECOMMENDATIONS.map((r) => <option key={r} value={r}>{RECOMMENDATION_LABEL[r]}</option>)}
                        </select>
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-xs font-medium">Strengths</span>
                      <textarea className="f-input min-h-[48px]" value={strengths} onChange={(e) => setStrengths(e.target.value)} maxLength={2_000} data-testid="my-scorecard-strengths" />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-xs font-medium">Concerns</span>
                      <textarea className="f-input min-h-[48px]" value={concerns} onChange={(e) => setConcerns(e.target.value)} maxLength={2_000} data-testid="my-scorecard-concerns" />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-xs font-medium">Remarks (shown on the stage)</span>
                      <textarea className="f-input min-h-[40px]" value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={2_000} data-testid="my-scorecard-remarks" />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => setFormFor(null)}>Cancel</button>
                      <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy} data-testid="my-scorecard-submit">Save scorecard</button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
          {loaded && rows.length === 0 && (
            <div className="px-4 py-8 text-center" data-testid="my-interviews-empty">
              <p className="text-sm text-muted-foreground">No interviews assigned to you.</p>
              <p className="text-xs text-muted-foreground mt-1">
                When HR assigns you as an interviewer, the interview and its scorecard appear here.
              </p>
            </div>
          )}
          {!loaded && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading your interviews…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
