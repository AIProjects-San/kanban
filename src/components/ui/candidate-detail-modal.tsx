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
//
// R6 additions: once a SIGNED offer exists (hasSignedOffer), SELECTED
// candidates get the "Mark joined" action — it provisions the employee
// account + onboarding checklist server-side and displays the created
// account email in the success toast.

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2, ChevronRight, CircleDashed, Loader2, MinusCircle, XCircle,
  Plus, Pencil, CalendarClock, ClipboardPen, FileText, ShieldCheck, UserPlus,
  AlertTriangle, Lock,
} from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import { cn } from "@/lib/utils";
import type { CandidateT, CandidateStageT, CandidateDocumentT, BackgroundCheckT, DocumentTypeConfigT } from "@/lib/types";
import {
  advanceStage,
  setStageStatus,
  decideCandidate,
  addCandidateStage,
  scheduleInterview,
  saveScorecard,
  getJoiningFormalities,
  requestDocument,
  receiveDocument,
  verifyDocument,
  rejectDocument,
  initiateBackgroundCheck,
  updateBackgroundCheck,
  markJoined,
} from "@/server-actions/hiring";
import { getDirectory } from "@/server-actions/hr-directory";
import { SCORECARD_RECOMMENDATIONS } from "@/lib/validation";
import { JoinerHandoutModal, type JoinerHandout } from "./joiner-handout";

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

const DOC_STATUS_CLS: Record<string, string> = {
  REQUESTED: "bg-amber-500/10 text-amber-600",
  RECEIVED: "bg-indigo-500/10 text-indigo-600",
  VERIFIED: "bg-emerald-500/10 text-emerald-600",
  REJECTED: "bg-destructive/10 text-destructive",
};

const BG_STATUS_CLS: Record<string, string> = {
  INITIATED: "bg-amber-500/10 text-amber-600",
  IN_REVIEW: "bg-indigo-500/10 text-indigo-600",
  CLEARED: "bg-emerald-500/10 text-emerald-600",
  FLAGGED: "bg-destructive/10 text-destructive",
};

export function CandidateDetailModal({
  open,
  onClose,
  onChanged,
  candidate,
  canManage,
  onEdit,
  onBuildOffer,
  currentUserId,
  hasSignedOffer,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  candidate: CandidateT | null;
  canManage: boolean;
  onEdit: (c: CandidateT) => void;
  /** R5 — open the offer builder for this candidate (SELECTED phase). */
  onBuildOffer: (c: CandidateT) => void;
  /** Signed-in user — scorecards are also editable by the assigned interviewer. */
  currentUserId: string;
  /** R6 — the candidate has a SIGNED offer (gates "Mark joined"). */
  hasSignedOffer: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  // R3 — opt-in rejection email (MailOutbox): HR-approved external note.
  const [sendEmail, setSendEmail] = useState(false);
  const [emailRemarks, setEmailRemarks] = useState("");
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

  // R4 — joining formalities (docs checklist + background checks).
  const [formalities, setFormalities] = useState<{
    docTypes: DocumentTypeConfigT[];
    documents: CandidateDocumentT[];
    bgChecks: BackgroundCheckT[];
    /** F2.10 (F-R9/E5) — the joining-gate verdict markJoined enforces. */
    gate: { enabled: boolean; allowed: boolean; blockers: string[]; summary: string };
  } | null>(null);
  // Inline action form on one doc row ("receive" fileRef / "reject" remark).
  const [docAction, setDocAction] = useState<{ doc: CandidateDocumentT; mode: "receive" | "reject" } | null>(null);
  const [docInput, setDocInput] = useState("");
  const [bgFormOpen, setBgFormOpen] = useState(false);
  const [bgVendor, setBgVendor] = useState("");
  const [bgNotes, setBgNotes] = useState("");
  const [bgReportRef, setBgReportRef] = useState("");

  // D-03 (P0-4) — the joiner's day-one handout state: set right after a
  // successful markJoined so HR can print the sign-in instructions (the
  // account email + "Forgot password?" steps) instead of relying on a
  // provider-gated welcome email that may have been SKIPPED.
  const [joinHandout, setJoinHandout] = useState<JoinerHandout | null>(null);
  // F2.10 (F-R7) — the payroll-ready verdict of the last markJoined in THIS
  // modal session (drives the hired summary's salary-structure line).
  const [lastJoin, setLastJoin] = useState<{ payrollReady: boolean } | null>(null);

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
      setSendEmail(false); setEmailRemarks("");
      setDocAction(null); setDocInput(""); setBgFormOpen(false); setBgVendor(""); setBgNotes(""); setBgReportRef("");
      setJoinHandout(null);
      setLastJoin(null);
    }
  }, [open]);

  // R4 — load the joining-formalities bundle when HR opens the modal.
  const loadFormalities = useCallback(async (cid: string) => {
    const res = await getJoiningFormalities(cid);
    if (res.ok) {
      setFormalities({
        docTypes: res.data.docTypes,
        documents: res.data.documents,
        bgChecks: res.data.bgChecks,
        gate: res.data.gate,
      });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && canManage && candidate) { setFormalities(null); void loadFormalities(candidate.id); }
  }, [open, canManage, candidate, loadFormalities]);

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
    setBusy(true);
    const res = await decideCandidate({ candidateId: c.id, decision: "REJECT", reason, sendEmail, emailRemarks });
    setBusy(false);
    if (!res.ok) { toast.error(res.error ?? "Action failed."); return; }
    // P0-6 (D-05) — the toast mirrors the outbox row's truth: SENT / SKIPPED
    // (no provider) / FAILED (provider error). No email requested → the
    // plain decision confirmation.
    if (sendEmail) {
      if (res.data.mailStatus === "SENT") {
        toast.success("Candidate rejected — rejection email sent and recorded in the outbox.");
      } else if (res.data.mailStatus === "FAILED") {
        toast.error("Candidate rejected, but the rejection email FAILED to send — see the outbox for the error.");
      } else {
        toast.warning("Candidate rejected — the rejection email was NOT delivered (no mail provider configured). Recorded as skipped in the outbox.");
      }
    } else {
      toast.success("Candidate rejected.");
    }
    onChanged();
    setRejectOpen(false); setSendEmail(false); setEmailRemarks("");
  };

  // R3 — the hire decision: ACTIVE → SELECTED (offer prep pointer).
  const select = () =>
    run(() => decideCandidate({ candidateId: c.id, decision: "SELECT", reason: "" }), "Candidate selected — offer preparation pending.");

  // R6 — SELECTED + SIGNED offer → employee account + onboarding checklist.
  // The created account email is the one thing HR must relay to the hire
  // (the welcome email carries it too, when a mail provider is configured).
  // D-03 — the toast is transient, so the handout modal carries the durable
  // copy: printable sign-in email + set-password steps + first-two-weeks
  // checklist (F2.10: the REAL instantiated tasks, not a code copy), with
  // the not-delivered warning when the mail was SKIPPED. F2.10 also renders
  // the payroll-ready verdict (F-R7 — the salary structure copy) in the
  // hired summary.
  const join = async () => {
    setBusy(true);
    const res = await markJoined({ candidateId: c.id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    setLastJoin({ payrollReady: res.data.payrollReady });
    if (res.data.mailStatus === "SENT") {
      toast.success(`${c.fullName} joined — account ${res.data.email} created with an onboarding checklist. Welcome email sent.`);
    } else {
      toast.warning(`${c.fullName} joined — account ${res.data.email} created with an onboarding checklist. BUT the welcome email was NOT delivered (no mail provider configured) — print the day-one handout and give the hire their sign-in email; they set a password via "Forgot password?".`);
    }
    setJoinHandout({
      name: c.fullName,
      position: c.position,
      email: res.data.email,
      workspaceName: res.data.workspaceName ?? "Fernly",
      mailStatus: res.data.mailStatus,
      payrollReady: res.data.payrollReady,
      tasks: res.data.checklistTasks.map((t) => ({ title: t.title, due: `day ${t.dueOffsetDays}` })),
    });
    onChanged();
  };

  // R4 — joining-formalities mutations. Each refreshes the bundle in place
  // (the board itself doesn't change, so no onChanged round-trip).
  const runFormality = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) { toast.error(res.error ?? "Action failed."); return false; }
    toast.success(okMsg);
    await loadFormalities(c.id);
    return true;
  };

  const requestDoc = (docTypeKey: string) =>
    runFormality(() => requestDocument({ candidateId: c.id, docTypeKey }), "Document requested.");

  const requestAllMandatory = async () => {
    if (!formalities) return;
    const missing = formalities.docTypes.filter(
      (t) => t.isActive && t.isMandatory && !formalities.documents.some((d) => d.docTypeKey === t.key),
    );
    if (missing.length === 0) { toast.info("All mandatory documents are already requested."); return; }
    setBusy(true);
    for (const t of missing) {
      const res = await requestDocument({ candidateId: c.id, docTypeKey: t.key });
      if (!res.ok) { toast.error(res.error); break; }
    }
    setBusy(false);
    toast.success(`${missing.length} mandatory document${missing.length === 1 ? "" : "s"} requested.`);
    await loadFormalities(c.id);
  };

  const submitDocAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docAction) return;
    if (docAction.mode === "receive") {
      const ok = await runFormality(
        () => receiveDocument({ documentId: docAction.doc.id, fileRef: docInput }),
        "Document marked received.",
      );
      if (ok) { setDocAction(null); setDocInput(""); }
    } else {
      if (docInput.trim().length === 0) { toast.error("A rejection note is required."); return; }
      const ok = await runFormality(
        () => rejectDocument({ documentId: docAction.doc.id, remarks: docInput }),
        "Document rejected.",
      );
      if (ok) { setDocAction(null); setDocInput(""); }
    }
  };

  const initBg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (bgVendor.trim().length === 0) { toast.error("A vendor is required."); return; }
    const ok = await runFormality(
      () => initiateBackgroundCheck({ candidateId: c.id, vendor: bgVendor, notes: bgNotes }),
      "Background check initiated.",
    );
    if (ok) { setBgFormOpen(false); setBgVendor(""); setBgNotes(""); }
  };

  const setBgStatus = (b: BackgroundCheckT, status: string) =>
    runFormality(
      () => updateBackgroundCheck({ id: b.id, status, reportRef: bgReportRef, notes: b.notes }),
      `Background check ${status.toLowerCase().replace("_", " ")}.`,
    );

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
        // F-R18 (S18) — two facts: the instant (this browser's true
        // UTC moment) + the raw datetime-local wall-clock the user picked
        // (the calendar event's day + label derive from it server-side).
        scheduledAt: new Date(schedWhen).toISOString(),
        wallClock: schedWhen,
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
    <>
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
                <button
                  className="f-btn f-btn-ghost text-emerald-600 hover:bg-emerald-500/10" disabled={busy}
                  onClick={select}
                  data-testid="select-btn"
                >
                  Select
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
                  c.status === "SELECTED" && "bg-emerald-500/10 text-emerald-600",
                  c.status === "HIRED" && "bg-success/10 text-success",
                )}>
                  {c.status}
                  {c.rejectReason ? ` — “${c.rejectReason}”` : ""}
                  {c.decidedAt ? ` · ${fmt(c.decidedAt)}` : ""}
                </div>
                {c.status === "SELECTED" && !hasSignedOffer && (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700" data-testid="offer-prep-banner">
                    Offer preparation pending — build and send the offer letter, then collect the signature.
                  </div>
                )}
                {c.status === "SELECTED" && hasSignedOffer && (
                  <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700" data-testid="offer-signed-banner">
                    Offer signed — ready to mark joined (creates the account + onboarding checklist).
                  </div>
                )}
                {c.status === "SELECTED" && (
                  <div className="flex flex-wrap gap-2">
                    {canManage && (
                      <button className="f-btn f-btn-primary" disabled={busy} onClick={onBuildOffer.bind(null, c)} data-testid="build-offer-btn">
                        Build offer
                      </button>
                    )}
                    {canManage && (
                      <button
                        className="f-btn f-btn-secondary"
                        disabled={busy || !hasSignedOffer}
                        onClick={() => void join()}
                        data-testid="mark-joined-btn"
                      >
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} Mark joined
                      </button>
                    )}
                  </div>
                )}
                {c.status === "HIRED" && (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-0.5" data-testid="hired-details">
                    <div>Employee account created{c.joinedAt ? ` · joined ${fmt(c.joinedAt)}` : ""}.</div>
                    <div>Their onboarding checklist is live under HR → Onboarding.</div>
                    {/* F2.10 (F-R7) — the payroll-ready verdict, visible right
                    after joining (when this modal session did the join). */}
                    {lastJoin && (
                      <div
                        className={cn(
                          "flex items-center gap-1.5",
                          lastJoin.payrollReady ? "text-emerald-600" : "text-amber-600",
                        )}
                        data-testid="payroll-ready-line"
                      >
                        {lastJoin.payrollReady ? (
                          <><CheckCircle2 size={12} /> Salary structure copied from the signed offer — payroll-ready.</>
                        ) : (
                          <><AlertTriangle size={12} /> No salary structure — the signed offer had no components. Fix payroll manually.</>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {(c.status === "REJECTED" || c.status === "WITHDRAWN" || c.status === "SELECTED") && canManage && (
                  <button className="f-btn f-btn-ghost" disabled={busy} onClick={reactivate} data-testid="reactivate-btn">
                    Reactivate candidate
                  </button>
                )}
              </div>
            )}
            {rejectOpen && (
              <form onSubmit={reject} className="mt-3 space-y-2">
                <Field label="Rejection reason (required — internal, audit only)">
                  <textarea
                    className="f-input min-h-[64px]"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    data-testid="reject-reason"
                    maxLength={2_000}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm cursor-pointer" data-testid="reject-email-toggle">
                  <input
                    type="checkbox"
                    checked={sendEmail}
                    onChange={(e) => setSendEmail(e.target.checked)}
                    className="accent-primary"
                  />
                  Email the candidate a rejection notice
                </label>
                {sendEmail && (
                  <Field label="Personal note to the candidate (included in the email)">
                    <textarea
                      className="f-input min-h-[64px]"
                      value={emailRemarks}
                      onChange={(e) => setEmailRemarks(e.target.value)}
                      placeholder="e.g. We were impressed by your portfolio — please apply again for senior openings next quarter."
                      data-testid="reject-email-remarks"
                      maxLength={2_000}
                    />
                  </Field>
                )}
                {sendEmail && (
                  <div className="text-xs text-muted-foreground rounded-md bg-muted/60 px-3 py-2">
                    Every send is recorded in the audited email outbox. Without a mail provider (RESEND_API_KEY) it is recorded as skipped — never sent silently.
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" className="f-btn f-btn-ghost" onClick={() => setRejectOpen(false)}>Cancel</button>
                  <button type="submit" className="f-btn f-btn-ghost text-destructive hover:bg-destructive/10" disabled={busy} data-testid="reject-confirm">
                    Confirm rejection
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* R4 — joining formalities: document checklist + background checks */}
          {canManage && (
            <div className="rounded-lg border border-border p-4" data-testid="joining-formalities">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <ShieldCheck size={12} /> Joining formalities
                </div>
                <button
                  className="f-btn f-btn-ghost text-xs"
                  disabled={busy || !formalities}
                  onClick={requestAllMandatory}
                  data-testid="request-mandatory-btn"
                >
                  Request all mandatory
                </button>
              </div>

              {/* F2.10 (F-R9/E5) — the joining-gate verdict: what markJoined
                  will enforce, rendered BEFORE it bites. */}
              {formalities?.gate.enabled && (
                <div
                  className={cn(
                    "rounded-md border px-3 py-2 mb-2.5 text-xs",
                    formalities.gate.allowed
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                  )}
                  data-testid="joining-gate-status"
                >
                  <div className="font-semibold flex items-center gap-1.5">
                    {formalities.gate.allowed ? <CheckCircle2 size={12} /> : <Lock size={12} />}
                    Joining gate — {formalities.gate.summary}
                  </div>
                  {!formalities.gate.allowed && (
                    <ul className="mt-1 list-disc pl-7 space-y-0.5">
                      {formalities.gate.blockers.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Document checklist */}
              <div className="space-y-1.5" data-testid="doc-checklist">
                {!formalities && <div className="text-xs text-muted-foreground">Loading checklist…</div>}
                {formalities?.docTypes
                  .filter((t) => t.isActive || formalities.documents.some((d) => d.docTypeKey === t.key))
                  .map((t) => {
                    const doc = formalities.documents.find((d) => d.docTypeKey === t.key) ?? null;
                    return (
                      <div key={t.key} className="rounded-md border border-border px-3 py-2" data-testid={`doc-row-${t.key}`}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <FileText size={13} className="text-muted-foreground shrink-0" />
                          <span className="text-sm min-w-0">{t.label}</span>
                          {t.isMandatory && !doc && (
                            <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 uppercase tracking-wide">required</span>
                          )}
                          <span className="ml-auto" />
                          {doc ? (
                            <span className={cn("text-[0.625rem] font-semibold px-1.5 py-0.5 rounded", DOC_STATUS_CLS[doc.status] ?? "bg-muted text-muted-foreground")} data-testid={`doc-status-${t.key}`}>
                              {doc.status}
                            </span>
                          ) : (
                            <button
                              className="f-btn f-btn-ghost text-xs" disabled={busy}
                              onClick={() => requestDoc(t.key)}
                              data-testid={`request-doc-${t.key}`}
                            >
                              Request
                            </button>
                          )}
                        </div>
                        {doc && (
                          <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                            {doc.fileRef && <span className="truncate max-w-[220px] font-mono">{doc.fileRef}</span>}
                            {doc.verifiedBy && <span>verified by {doc.verifiedBy}{doc.verifiedAt ? ` · ${fmt(doc.verifiedAt)}` : ""}</span>}
                            {doc.remarks && doc.status === "REJECTED" && <span className="text-destructive">“{doc.remarks}”</span>}
                          </div>
                        )}
                        {doc && doc.status === "REQUESTED" && (
                          <button
                            className="f-btn f-btn-ghost text-xs mt-1.5" disabled={busy}
                            onClick={() => { setDocAction({ doc, mode: "receive" }); setDocInput(doc.fileRef); }}
                            data-testid={`receive-doc-${t.key}`}
                          >
                            Mark received
                          </button>
                        )}
                        {doc && doc.status === "REJECTED" && (
                          <button
                            className="f-btn f-btn-ghost text-xs mt-1.5" disabled={busy}
                            onClick={() => requestDoc(t.key)}
                            data-testid={`rerequest-doc-${t.key}`}
                          >
                            Re-request
                          </button>
                        )}
                        {doc && doc.status === "RECEIVED" && (
                          <div className="flex gap-2 mt-1.5">
                            <button
                              className="f-btn f-btn-ghost text-xs text-emerald-600 hover:bg-emerald-500/10" disabled={busy}
                              onClick={() => runFormality(() => verifyDocument({ documentId: doc.id, remarks: "" }), "Document verified.")}
                              data-testid={`verify-doc-${t.key}`}
                            >
                              Verify
                            </button>
                            <button
                              className="f-btn f-btn-ghost text-xs text-destructive hover:bg-destructive/10" disabled={busy}
                              onClick={() => { setDocAction({ doc, mode: "reject" }); setDocInput(""); }}
                              data-testid={`reject-doc-${t.key}`}
                            >
                              Reject
                            </button>
                          </div>
                        )}
                        {docAction && doc && docAction.doc.id === doc.id && (
                          <form onSubmit={submitDocAction} className="mt-2 space-y-1.5">
                            <Field label={docAction.mode === "receive" ? "File reference (URL or name — optional)" : "What is wrong? (sent with the re-request)"}>
                              <input
                                className="f-input text-xs"
                                value={docInput}
                                onChange={(e) => setDocInput(e.target.value)}
                                data-testid={`doc-action-input-${t.key}`}
                                maxLength={docAction.mode === "receive" ? 500 : 2_000}
                              />
                            </Field>
                            <div className="flex justify-end gap-2">
                              <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => { setDocAction(null); setDocInput(""); }}>Cancel</button>
                              <button type="submit" className="f-btn f-btn-ghost text-xs" disabled={busy} data-testid={`doc-action-submit-${t.key}`}>
                                {docAction.mode === "receive" ? "Mark received" : "Reject document"}
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    );
                  })}
                {formalities && formalities.docTypes.filter((t) => t.isActive || formalities.documents.some((d) => d.docTypeKey === t.key)).length === 0 && (
                  <div className="text-xs text-muted-foreground">No document types configured.</div>
                )}
              </div>

              {/* Background checks */}
              <div className="mt-4 pt-3 border-t border-border">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Background check</div>
                  <button
                    className="f-btn f-btn-ghost text-xs" disabled={busy}
                    onClick={() => setBgFormOpen((v) => !v)}
                    data-testid="bg-initiate-btn"
                  >
                    Initiate
                  </button>
                </div>
                {bgFormOpen && (
                  <form onSubmit={initBg} className="mb-2 space-y-1.5" data-testid="bg-initiate-form">
                    <Field label="Vendor (who runs the check)">
                      <input
                        className="f-input text-xs" value={bgVendor}
                        onChange={(e) => setBgVendor(e.target.value)}
                        placeholder="e.g. HireRight"
                        data-testid="bg-vendor"
                        maxLength={120}
                      />
                    </Field>
                    <Field label="Notes (optional)">
                      <input
                        className="f-input text-xs" value={bgNotes}
                        onChange={(e) => setBgNotes(e.target.value)}
                        maxLength={2_000}
                      />
                    </Field>
                    <div className="flex justify-end gap-2">
                      <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => setBgFormOpen(false)}>Cancel</button>
                      <button type="submit" className="f-btn f-btn-ghost text-xs" disabled={busy} data-testid="bg-initiate-submit">
                        Initiate check
                      </button>
                    </div>
                  </form>
                )}
                <div className="space-y-1.5" data-testid="bg-check-list">
                  {formalities?.bgChecks.map((b) => (
                    <div key={b.id} className="rounded-md border border-border px-3 py-2" data-testid={`bg-row-${b.id}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{b.vendor}</span>
                        <span className={cn("text-[0.625rem] font-semibold px-1.5 py-0.5 rounded", BG_STATUS_CLS[b.status] ?? "bg-muted text-muted-foreground")}>
                          {b.status.replace("_", " ")}
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {b.initiatedBy ?? "—"} · {fmt(b.initiatedAt)}{b.completedAt ? ` → ${fmt(b.completedAt)}` : ""}
                        </span>
                      </div>
                      {(b.reportRef || b.notes) && (
                        <div className="mt-1 text-xs text-muted-foreground flex gap-2 flex-wrap">
                          {b.reportRef && <span className="font-mono">{b.reportRef}</span>}
                          {b.notes && <span>{b.notes}</span>}
                        </div>
                      )}
                      {b.status !== "CLEARED" && b.status !== "FLAGGED" && (
                        <div className="flex flex-wrap gap-2 mt-1.5 items-center">
                          {b.status === "INITIATED" && (
                            <button className="f-btn f-btn-ghost text-xs" disabled={busy} onClick={() => setBgStatus(b, "IN_REVIEW")} data-testid={`bg-in-review-${b.id}`}>
                              In review
                            </button>
                          )}
                          <input
                            className="f-input text-xs max-w-[200px]"
                            value={bgReportRef}
                            onChange={(e) => setBgReportRef(e.target.value)}
                            placeholder="Report reference (optional)"
                            maxLength={500}
                          />
                          <button className="f-btn f-btn-ghost text-xs text-emerald-600 hover:bg-emerald-500/10" disabled={busy} onClick={() => setBgStatus(b, "CLEARED")} data-testid={`bg-clear-${b.id}`}>
                            Cleared
                          </button>
                          <button className="f-btn f-btn-ghost text-xs text-destructive hover:bg-destructive/10" disabled={busy} onClick={() => setBgStatus(b, "FLAGGED")} data-testid={`bg-flag-${b.id}`}>
                            Flagged
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {formalities && formalities.bgChecks.length === 0 && !bgFormOpen && (
                    <div className="text-xs text-muted-foreground">No background check yet — initiate one around offer acceptance (T-14).</div>
                  )}
                </div>
              </div>
            </div>
          )}
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
    {/* D-03 — printable day-one handout (opens after a successful join).
        Sibling of the outer modal, not a child: both use portals + focus
        traps, and a nested trap would fight the handout's own. */}
    <JoinerHandoutModal handout={joinHandout} onClose={() => setJoinHandout(null)} />
    </>
  );
}
