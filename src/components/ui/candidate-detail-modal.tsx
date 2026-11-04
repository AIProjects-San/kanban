"use client";

// Recruitment — candidate detail modal: stage timeline (snapshot of the
// template at creation) + advance/skip/fail + decisions (reject with reason,
// withdraw, reactivate) + per-candidate custom stage.
//
// R2 additions (docs/RECRUITMENT_MODULE_PLAN.md §5): INTERVIEW stages get a
// schedule form (creates a calendar event + interviewer reminder via the
// server) and a structured scorecard (1–5 rating, strengths, concerns,
// STRONG_HIRE|HIRE|NO_HIRE — research D). Scorecard edit is open to the
// assigned interviewer or HR/ADMIN (canManage).

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2, ChevronRight, CircleDashed, Loader2, MinusCircle, XCircle,
  Plus, Pencil, CalendarClock, ClipboardPen,
} from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import { cn } from "@/lib/utils";
import type { CandidateT, CandidateStageT } from "@/lib/types";
import {
  advanceStage,
  setStageStatus,
  decideCandidate,
  addCandidateStage,
  scheduleInterview,
  saveScorecard,
} from "@/server-actions/hiring";
import { getDirectory } from "@/server-actions/hr-directory";
import { SCORECARD_RECOMMENDATIONS } from "@/lib/validation";

const STAGE_STATUS_ICON: Record<string, React.ReactNode> = {
  PENDING: <CircleDashed size={15} className="text-muted-foreground" />,
  IN_PROGRESS: <ChevronRight size={15} className="text-primary" />,
  PASSED: <CheckCircle2 size={15} className="text-success" />,
  FAILED: <XCircle size={15} className="text-destructive" />,
  SKIPPED: <MinusCircle size={15} className="text-amber-500" />,
};

const STAGE_TYPE_LABEL: Record<string, string> = {
  SCREENING: "Screening", INTERVIEW: "Interview", ASSESSMENT: "Assessment",
  BG_CHECK: "Background check", DOCUMENTS: "Documents", OFFER: "Offer", CUSTOM: "Custom",
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  STRONG_HIRE: "Strong hire", HIRE: "Hire", NO_HIRE: "No hire",
};

function fmt(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CandidateDetailModal({
  open,
  onClose,
  onChanged,
  candidate,
  canManage,
  onEdit,
  currentUserId,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  candidate: CandidateT | null;
  canManage: boolean;
  onEdit: (c: CandidateT) => void;
  /** Signed-in user — scorecards are also editable by the assigned interviewer. */
  currentUserId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newStageLabel, setNewStageLabel] = useState("");

  // R2 — scheduling state (one form at a time).
  const [schedStageId, setSchedStageId] = useState<string | null>(null);
  const [schedWhen, setSchedWhen] = useState("");
  const [schedInterviewer, setSchedInterviewer] = useState("");
  const [interviewers, setInterviewers] = useState<Array<{ userId: string; name: string }>>([]);

  // R2 — scorecard state.
  const [cardStage, setCardStage] = useState<CandidateStageT | null>(null);
  const [rating, setRating] = useState("");
  const [strengths, setStrengths] = useState("");
  const [concerns, setConcerns] = useState("");
  const [recommendation, setRecommendation] = useState("");
  const [cardRemarks, setCardRemarks] = useState("");

  const loadInterviewers = useCallback(async () => {
    if (interviewers.length > 0) return;
    const res = await getDirectory();
    if (res.ok) {
      setInterviewers(res.data.profiles.map((p) => ({ userId: p.userId, name: p.name })));
    }
  }, [interviewers.length]);

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRejectOpen(false); setAddOpen(false); setReason(""); setNewStageLabel("");
      setSchedStageId(null); setSchedWhen(""); setSchedInterviewer("");
      setCardStage(null);
    }
  }, [open]);

  if (!candidate) return null;
  const c = candidate;
  const active = c.status === "ACTIVE";
  const ordered = c.stages;
  const current =
    ordered.find((s) => s.status === "IN_PROGRESS") ??
    ordered.find((s) => s.status === "PENDING");

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) { toast.error(res.error ?? "Action failed."); return false; }
    toast.success(okMsg);
    onChanged();
    return true;
  };

  const advance = () =>
    run(() => advanceStage({ candidateId: c.id }), "Stage passed — pipeline advanced.");

  const setStatus = (s: CandidateStageT, status: "SKIPPED" | "FAILED") =>
    run(
      () => setStageStatus({ stageId: s.id, status, remarks: s.remarks }),
      `"${s.label}" marked ${status.toLowerCase()}.`,
    );

  const reject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length === 0) {
      toast.error("A rejection reason is required.");
      return;
    }
    const okDone = await run(
      () => decideCandidate({ candidateId: c.id, decision: "REJECT", reason }),
      "Candidate rejected.",
    );
    if (okDone) setRejectOpen(false);
  };

  const withdraw = () =>
    run(() => decideCandidate({ candidateId: c.id, decision: "WITHDRAW", reason: "" }), "Candidate marked withdrawn.");

  const reactivate = () =>
    run(() => decideCandidate({ candidateId: c.id, decision: "REACTIVATE", reason: "" }), "Candidate reactivated.");

  const addStage = async (e: React.FormEvent) => {
    e.preventDefault();
    const okDone = await run(
      () => addCandidateStage({ candidateId: c.id, label: newStageLabel, stageType: "CUSTOM", beforeStageId: current?.id ?? null }),
      "Custom stage added.",
    );
    if (okDone) { setAddOpen(false); setNewStageLabel(""); }
  };

  // R2 — open the schedule form for an INTERVIEW stage.
  const openSchedule = async (s: CandidateStageT) => {
    await loadInterviewers();
    setCardStage(null);
    setSchedStageId(s.id);
    setSchedWhen(toLocalInput(s.scheduledAt));
    setSchedInterviewer(s.ownerUserId ?? "");
  };

  const submitSchedule = async (e: React.FormEvent, s: CandidateStageT) => {
    e.preventDefault();
    if (!schedWhen) { toast.error("Pick a date and time."); return; }
    const okDone = await run(
      () => scheduleInterview({
        stageId: s.id,
        scheduledAt: new Date(schedWhen).toISOString(),
        interviewerId: schedInterviewer || null,
      }),
      "Interview scheduled — calendar event + reminder created.",
    );
    if (okDone) { setSchedStageId(null); setSchedWhen(""); }
  };

  // R2 — open the scorecard form (interviewer or manager).
  const openScorecard = (s: CandidateStageT) => {
    setSchedStageId(null);
    setCardStage(s);
    setRating(s.rating ? String(s.rating) : "");
    setStrengths(s.strengths);
    setConcerns(s.concerns);
    setRecommendation(s.recommendation ?? "");
    setCardRemarks(s.remarks);
  };

  const submitScorecard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cardStage) return;
    const okDone = await run(
      () => saveScorecard({
        stageId: cardStage.id,
        rating: rating ? Number(rating) : null,
        strengths,
        concerns,
        recommendation: recommendation || null,
        remarks: cardRemarks,
      }),
      "Scorecard saved.",
    );
    if (okDone) setCardStage(null);
  };

  const hasCard = (s: CandidateStageT) =>
    s.rating !== null || s.strengths !== "" || s.concerns !== "" || s.recommendation !== null;

  return (
    <Modal open={open} onClose={onClose} title={c.fullName} description={`${c.position || "Position n/a"}${c.department ? ` · ${c.department}` : ""}`} size="xl">
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Left — profile */}
        <div className="space-y-4 min-w-0">
          <div className="rounded-lg border border-border p-4 space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Email</span>
              <span className="font-mono text-xs break-all">{c.email}</span>
            </div>
            {c.phone && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Phone</span><span>{c.phone}</span>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Source</span><span>{c.source || "—"}</span>
            </div>
            {c.resumeUrl && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Resume</span>
                <a href={c.resumeUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate max-w-[220px]">{c.resumeUrl}</a>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Added</span><span>{fmt(c.createdAt)}</span>
            </div>
          </div>

          {c.notes && (
            <div className="rounded-lg border border-border p-4 text-sm">
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Notes</div>
              <p className="whitespace-pre-wrap text-foreground">{c.notes}</p>
            </div>
          )}

          {/* Decision panel */}
          <div className="rounded-lg border border-border p-4" data-testid="candidate-decision">
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Decision</div>
            {c.status === "ACTIVE" && !canManage ? (
              <div className="text-xs text-muted-foreground rounded-md bg-muted/60 px-3 py-2">
                Pipeline in progress — HR drives the stages and the decision.
              </div>
            ) : c.status === "ACTIVE" ? (
              <div className="flex flex-wrap gap-2">
                <button
                  className="f-btn f-btn-primary" disabled={busy} onClick={advance}
                  data-testid="advance-stage-btn"
                >
                  Pass “{current?.label ?? "stage"}”
                </button>
                <button className="f-btn f-btn-ghost" disabled={busy} onClick={onEdit.bind(null, c)}>
                  <Pencil size={14} /> Edit
                </button>
                <button
                  className="f-btn f-btn-ghost text-destructive hover:bg-destructive/10" disabled={busy}
                  onClick={() => setRejectOpen((v) => !v)}
                  data-testid="reject-btn"
                >
                  Reject
                </button>
                <button className="f-btn f-btn-ghost" disabled={busy} onClick={withdraw}>Withdraw</button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className={cn(
                  "rounded-md px-3 py-2 text-sm",
                  c.status === "REJECTED" && "bg-destructive/10 text-destructive",
                  c.status === "WITHDRAWN" && "bg-muted text-muted-foreground",
                  c.status === "HIRED" && "bg-success/10 text-success",
                )}>
                  {c.status}
                  {c.rejectReason ? ` — “${c.rejectReason}”` : ""}
                  {c.decidedAt ? ` · ${fmt(c.decidedAt)}` : ""}
                </div>
                {(c.status === "REJECTED" || c.status === "WITHDRAWN") && canManage && (
                  <button className="f-btn f-btn-ghost" disabled={busy} onClick={reactivate} data-testid="reactivate-btn">
                    Reactivate candidate
                  </button>
                )}
              </div>
            )}
            {rejectOpen && (
              <form onSubmit={reject} className="mt-3 space-y-2">
                <Field label="Rejection reason (required — included in the rejection email)">
                  <textarea
                    className="f-input min-h-[64px]"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    data-testid="reject-reason"
                    maxLength={2_000}
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <button type="button" className="f-btn f-btn-ghost" onClick={() => setRejectOpen(false)}>Cancel</button>
                  <button type="submit" className="f-btn f-btn-ghost text-destructive hover:bg-destructive/10" disabled={busy} data-testid="reject-confirm">
                    Confirm rejection
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>

        {/* Right — stage timeline */}
        <div className="min-w-0" data-testid="candidate-timeline">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Stage timeline
            </div>
            {canManage && active && (
              <button className="f-btn f-btn-ghost text-xs" disabled={busy} onClick={() => setAddOpen((v) => !v)} data-testid="add-stage-btn">
                <Plus size={13} /> Add stage
              </button>
            )}
          </div>
          {addOpen && (
            <form onSubmit={addStage} className="mb-3 flex gap-2 items-end">
              <div className="flex-1">
                <Field label="Custom stage (this candidate only)">
                  <input
                    className="f-input" value={newStageLabel}
                    onChange={(e) => setNewStageLabel(e.target.value)}
                    data-testid="new-stage-label" required maxLength={120}
                  />
                </Field>
              </div>
              <button type="submit" className="f-btn f-btn-primary" disabled={busy}>Add</button>
            </form>
          )}
          <ol className="space-y-2">
            {ordered.map((s) => (
              <li
                key={s.id}
                className={cn(
                  "rounded-lg border p-3 flex items-start gap-3",
                  s.status === "IN_PROGRESS" && "border-primary/60 bg-primary/5",
                  s.status === "SKIPPED" && "opacity-60",
                )}
                data-testid={`stage-${s.stageKey}`}
              >
                <div className="mt-0.5">{STAGE_STATUS_ICON[s.status] ?? STAGE_STATUS_ICON.PENDING}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("text-sm font-medium", s.status === "SKIPPED" && "line-through")}>{s.label}</span>
                    <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
                      {STAGE_TYPE_LABEL[s.stageType] ?? s.stageType}
                    </span>
                    {s.scheduledAt && s.stageType === "INTERVIEW" && (
                      <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 inline-flex items-center gap-1" data-testid={`scheduled-chip-${s.stageKey}`}>
                        <CalendarClock size={11} /> {fmtDateTime(s.scheduledAt)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {s.status}
                    {s.startedAt ? ` · started ${fmt(s.startedAt)}` : ""}
                    {s.completedAt ? ` · ${fmt(s.completedAt)}` : ""}
                    {s.ownerName ? ` · ${s.ownerName}` : ""}
                  </div>
                  {s.remarks && <div className="text-xs mt-1 text-foreground/80">“{s.remarks}”</div>}

                  {/* R2 — scorecard read view */}
                  {hasCard(s) && (
                    <div className="mt-2 rounded-md bg-muted/60 p-2 text-xs space-y-1" data-testid={`scorecard-${s.stageKey}`}>
                      <div className="flex gap-2 items-center flex-wrap">
                        {s.rating !== null && <span className="font-semibold">Rating: {s.rating}/5</span>}
                        {s.recommendation && (
                          <span className={cn(
                            "px-1.5 py-0.5 rounded font-medium",
                            s.recommendation === "NO_HIRE" ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success",
                          )}>
                            {RECOMMENDATION_LABEL[s.recommendation] ?? s.recommendation}
                          </span>
                        )}
                      </div>
                      {s.strengths && <div><span className="text-muted-foreground">Strengths:</span> {s.strengths}</div>}
                      {s.concerns && <div><span className="text-muted-foreground">Concerns:</span> {s.concerns}</div>}
                    </div>
                  )}

                  {/* Stage actions */}
                  <div className="flex flex-wrap gap-2 mt-2">
                    {canManage && active && (s.status === "PENDING" || s.status === "IN_PROGRESS") && (
                      <>
                        {s.stageType === "INTERVIEW" && (
                          <button
                            className="f-btn f-btn-ghost text-xs" disabled={busy}
                            onClick={() => void openSchedule(s)}
                            data-testid={`schedule-btn-${s.stageKey}`}
                          >
                            <CalendarClock size={13} /> {s.scheduledAt ? "Reschedule" : "Schedule"}
                          </button>
                        )}
                        {s.status !== "IN_PROGRESS" && (
                          <button className="f-btn f-btn-ghost text-xs" disabled={busy} onClick={() => setStatus(s, "SKIPPED")}>Skip</button>
                        )}
                        <button className="f-btn f-btn-ghost text-xs" disabled={busy} onClick={() => setStatus(s, "FAILED")}>Mark failed</button>
                      </>
                    )}
                    {s.stageType === "INTERVIEW" && active && (canManage || s.ownerUserId === currentUserId) && (
                      <button
                        className="f-btn f-btn-ghost text-xs" disabled={busy}
                        onClick={() => openScorecard(s)}
                        data-testid={`scorecard-btn-${s.stageKey}`}
                      >
                        <ClipboardPen size={13} /> {hasCard(s) ? "Edit scorecard" : "Fill scorecard"}
                      </button>
                    )}
                  </div>

                  {/* R2 — schedule form */}
                  {schedStageId === s.id && (
                    <form onSubmit={(e) => submitSchedule(e, s)} className="mt-2 p-2 rounded-md border border-border space-y-2" data-testid="schedule-form">
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Date & time">
                          <input
                            type="datetime-local" className="f-input" value={schedWhen}
                            onChange={(e) => setSchedWhen(e.target.value)} required
                            data-testid="schedule-when"
                          />
                        </Field>
                        <Field label="Interviewer">
                          <select className="f-input" value={schedInterviewer} onChange={(e) => setSchedInterviewer(e.target.value)} data-testid="schedule-interviewer">
                            <option value="">— Keep current owner —</option>
                            {interviewers.map((i) => (
                              <option key={i.userId} value={i.userId}>{i.name}</option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => setSchedStageId(null)}>Cancel</button>
                        <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy} data-testid="schedule-submit">
                          {s.scheduledAt ? "Reschedule" : "Schedule"} interview
                        </button>
                      </div>
                    </form>
                  )}

                  {/* R2 — scorecard form */}
                  {cardStage?.id === s.id && (
                    <form onSubmit={submitScorecard} className="mt-2 p-2 rounded-md border border-border space-y-2" data-testid="scorecard-form">
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Rating (1–5)">
                          <select className="f-input" value={rating} onChange={(e) => setRating(e.target.value)} data-testid="scorecard-rating">
                            <option value="">— Not rated —</option>
                            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </Field>
                        <Field label="Recommendation">
                          <select className="f-input" value={recommendation} onChange={(e) => setRecommendation(e.target.value)} data-testid="scorecard-recommendation">
                            <option value="">— None —</option>
                            {SCORECARD_RECOMMENDATIONS.map((r) => <option key={r} value={r}>{RECOMMENDATION_LABEL[r]}</option>)}
                          </select>
                        </Field>
                      </div>
                      <Field label="Strengths">
                        <textarea className="f-input min-h-[48px]" value={strengths} onChange={(e) => setStrengths(e.target.value)} maxLength={2_000} />
                      </Field>
                      <Field label="Concerns">
                        <textarea className="f-input min-h-[48px]" value={concerns} onChange={(e) => setConcerns(e.target.value)} maxLength={2_000} />
                      </Field>
                      <Field label="Remarks (shown on the stage)">
                        <textarea className="f-input min-h-[40px]" value={cardRemarks} onChange={(e) => setCardRemarks(e.target.value)} maxLength={2_000} />
                      </Field>
                      <div className="flex justify-end gap-2">
                        <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => setCardStage(null)}>Cancel</button>
                        <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy} data-testid="scorecard-submit">Save scorecard</button>
                      </div>
                    </form>
                  )}
                </div>
              </li>
            ))}
            {ordered.length === 0 && (
              <li className="text-sm text-muted-foreground">No stages — the template was empty at creation.</li>
            )}
          </ol>
          {busy && <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Working…</div>}
        </div>
      </div>
    </Modal>
  );
}
