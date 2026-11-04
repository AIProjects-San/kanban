"use client";

// Recruitment R1 — candidate detail modal: stage timeline (snapshot of the
// template at creation) + advance/skip/fail + decisions (reject with reason,
// withdraw, reactivate) + per-candidate custom stage.
// docs/RECRUITMENT_MODULE_PLAN.md §5 (R1), §1.4–1.5 (statuses).

import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, CircleDashed, Loader2, MinusCircle, XCircle, Plus, Pencil } from "lucide-react";
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
} from "@/server-actions/hiring";

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

function fmt(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function CandidateDetailModal({
  open,
  onClose,
  onChanged,
  candidate,
  canManage,
  onEdit,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  candidate: CandidateT | null;
  canManage: boolean;
  onEdit: (c: CandidateT) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newStageLabel, setNewStageLabel] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) { setRejectOpen(false); setAddOpen(false); setReason(""); setNewStageLabel(""); }
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
            {c.status === "ACTIVE" ? (
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
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {s.status}
                    {s.startedAt ? ` · started ${fmt(s.startedAt)}` : ""}
                    {s.completedAt ? ` · ${fmt(s.completedAt)}` : ""}
                    {s.ownerName ? ` · ${s.ownerName}` : ""}
                  </div>
                  {s.remarks && <div className="text-xs mt-1 text-foreground/80">“{s.remarks}”</div>}
                  {canManage && active && (s.status === "PENDING" || s.status === "IN_PROGRESS") && (
                    <div className="flex gap-2 mt-2">
                      {s.status !== "IN_PROGRESS" && (
                        <button className="f-btn f-btn-ghost text-xs" disabled={busy} onClick={() => setStatus(s, "SKIPPED")}>Skip</button>
                      )}
                      <button className="f-btn f-btn-ghost text-xs" disabled={busy} onClick={() => setStatus(s, "FAILED")}>Mark failed</button>
                    </div>
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
