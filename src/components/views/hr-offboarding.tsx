"use client";

// F2.1 — the Offboarding tab (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.2; benchmark EM-14/15/16 lite).
//
// One card per employee in the offboarding orbit (EXITED profiles ∪
// separation checklists ∪ live exit interviews ∪ FnF rows). Each card owns
// three surfaces:
//   • the separation checklist — the onboarding machinery with kind
//     SEPARATION (create from the default template; ticks reuse setTaskDone)
//   • the exit interview — PENDING → SCHEDULED → COMPLETED/CANCELLED with
//     the in-app notification on scheduling
//   • the full-and-final statement — LIVE computed lines until settled;
//     settlement freezes the amounts and locks payslip editing
//
// The full flow ends here: Directory → edit → status Exited (+ last working
// day) → this tab → checklist + interview + generate → settle.

import { useCallback, useEffect, useState } from "react";
import { Plus, Check, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "../ui/modal";
import { Field } from "../ui/field";
import { cn, barWidthClass } from "@/lib/utils";
import { EMPLOYMENT_STATUS_BADGE, EMPLOYMENT_STATUS_LABELS } from "@/lib/employment";
import { EXIT_INTERVIEW_STATUS_LABELS } from "@/lib/full-and-final";
import { createChecklist, setTaskDone } from "@/server-actions/hr-onboarding";
import {
  getOffboardingOverview,
  createExitInterview,
  scheduleExitInterview,
  completeExitInterview,
  cancelExitInterview,
  generateFullAndFinal,
  settleFullAndFinal,
} from "@/server-actions/hr-offboarding";
import type { OffboardingCaseT, OffboardingOverviewT, FnFComputedT } from "@/lib/types";

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const FNF_KIND_LABELS: Record<string, string> = {
  SALARY: "Salary",
  ENCASHMENT: "Encashment",
  ADVANCE_LEAVE: "Recovery",
  GRATUITY: "Gratuity",
  // P38 — the extended line space.
  BONUS: "Bonus",
  PENDING_ENCASHMENT: "Encashment",
};

function FnFBlock({ fnf }: { fnf: OffboardingCaseT["fnf"] }) {
  const computed: FnFComputedT | null =
    fnf.status === "NONE" ? fnf.computed : fnf.status === "UNSETTLED" ? fnf.computed : fnf.frozen;

  return (
    <div className="rounded-md border border-border p-3" data-testid="fnf-section">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Full &amp; final statement
        </div>
        <span
          data-testid="fnf-status"
          className={cn(
            "inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium",
            fnf.status === "SETTLED"
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : fnf.status === "UNSETTLED"
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
          )}
        >
          {fnf.status === "SETTLED" ? "Settled" : fnf.status === "UNSETTLED" ? "Unsettled" : "Not generated"}
        </span>
      </div>

      {fnf.status === "SETTLED" && (
        <div className="text-[0.6875rem] text-muted-foreground mb-2">
          Settled {fmtDay(fnf.settledAt)} by {fnf.settledBy ?? "HR"} — amounts frozen, payslip editing locked.
        </div>
      )}
      {fnf.status === "UNSETTLED" && fnf.snapshot.netPayable !== fnf.computed.netPayable && (
        <div className="text-[0.6875rem] text-amber-600 dark:text-amber-400 mb-2">
          Amounts changed since generation (snapshot {fmtMoney(fnf.snapshot.netPayable)}) — settle freezes today&apos;s values.
        </div>
      )}

      {computed ? (
        <>
          {computed.lines.length > 0 ? (
            <div className="text-xs divide-y divide-border" data-testid="fnf-lines">
              {computed.lines.map((l, i) => (
                <div key={i} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="min-w-0 truncate text-foreground" title={l.label}>
                    <span className={cn(
                      "inline-flex px-1.5 py-0.5 rounded text-[0.625rem] font-medium mr-1.5",
                      l.amount < 0
                        ? "bg-red-500/10 text-red-600 dark:text-red-400"
                        : "bg-primary/10 text-primary",
                    )}>
                      {FNF_KIND_LABELS[l.kind] ?? l.kind}
                    </span>
                    {l.label}
                  </span>
                  <span className={cn("shrink-0 tabular-nums font-medium", l.amount < 0 ? "text-red-600 dark:text-red-400" : "text-foreground")}>
                    {fmtMoney(l.amount)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground py-1.5">No money lines — nothing owed either way.</div>
          )}

          <div className="mt-2 pt-2 border-t border-border text-xs space-y-1 tabular-nums" data-testid="fnf-totals">
            <div className="flex justify-between text-muted-foreground">
              <span>Payables</span>
              <span>{fmtMoney(computed.payableTotal)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Receivables</span>
              <span>{fmtMoney(computed.receivableTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold text-foreground" data-testid="fnf-net">
              <span>Net payable{computed.netPayable < 0 ? " (owed back)" : ""}</span>
              <span>{fmtMoney(computed.netPayable)}</span>
            </div>
            <div className="text-[0.625rem] text-muted-foreground pt-1">
              Day rate {fmtMoney(computed.rateBasis.dailyRate)} · monthly gross{" "}
              {computed.rateBasis.monthlyGross === null ? "none" : fmtMoney(computed.rateBasis.monthlyGross)} ÷{" "}
              {computed.rateBasis.workingDays} working day(s) of {computed.rateBasis.period || "—"}
            </div>
          </div>

          {computed.notes.length > 0 && (
            <ul className="mt-2 space-y-1 text-[0.6875rem] text-muted-foreground list-disc pl-4">
              {computed.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
          {fnf.status !== "SETTLED" && (
            <div className="text-[0.625rem] text-muted-foreground mt-2">
              Recomputed live from today&apos;s facts — settling freezes the current amounts.
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-muted-foreground">
          The statement computes once the employment status is Exited — record the exit from the Directory tab first.
        </div>
      )}
    </div>
  );
}

function InterviewBlock({
  caseData,
  interviewers,
  onChanged,
}: {
  caseData: OffboardingCaseT;
  interviewers: { userId: string; name: string }[];
  onChanged: () => Promise<void>;
}) {
  const interview = caseData.interview;
  const [date, setDate] = useState("");
  const [interviewerId, setInterviewerId] = useState("");
  const [notes, setNotes] = useState("");

  const busy = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const res = await fn();
    if (res.ok) { await onChanged(); } else { toast.error(res.error ?? "Something went wrong"); }
  };

  return (
    <div className="rounded-md border border-border p-3" data-testid="exit-interview">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Exit interview</div>
        {interview && (
          <span
            data-testid="exit-interview-status"
            className={cn(
              "inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium",
              interview.status === "COMPLETED"
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : interview.status === "SCHEDULED"
                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : interview.status === "CANCELLED"
                    ? "bg-zinc-500/10 text-zinc-500 line-through"
                    : "bg-blue-500/10 text-blue-700 dark:text-blue-400",
            )}
          >
            {EXIT_INTERVIEW_STATUS_LABELS[interview.status]}
          </span>
        )}
      </div>

      {!interview || interview.status === "CANCELLED" ? (
        // No record yet, or the latest was cancelled (its history stays on
        // the card below) — both accept a fresh record; the action layer
        // refuses while a LIVE (PENDING/SCHEDULED) record exists.
        <div className="space-y-2">
          {interview?.status === "CANCELLED" && (
            <div className="text-[0.6875rem] text-muted-foreground line-through">
              Previous interview cancelled {fmtDay(interview.createdAt)} — record a new one below.
            </div>
          )}
          <button
            className="f-btn f-btn-ghost f-btn-sm"
            data-testid="record-interview-btn"
            onClick={() => void busy(() => createExitInterview({ userId: caseData.userId }))}
          >
            <CalendarClock size={13} /> {interview ? "Record a new exit interview" : "Record exit interview"}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            {interview.scheduledAt ? <>Scheduled {fmtDay(interview.scheduledAt)}{interview.interviewerName ? ` · ${interview.interviewerName}` : ""}</> : "Not scheduled yet"}
            {interview.completedAt ? ` · completed ${fmtDay(interview.completedAt)}` : ""}
          </div>
          {interview.notes && (
            <div className="text-xs text-foreground rounded bg-muted/60 px-2 py-1.5">{interview.notes}</div>
          )}

          {(interview.status === "PENDING" || interview.status === "SCHEDULED") && (
            <div className="space-y-1.5 pt-1">
              <div className="flex gap-1.5 flex-wrap">
                <input
                  type="date"
                  aria-label="Interview date"
                  data-testid="interview-date-input"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="f-input f-input-sm w-auto"
                />
                <select
                  aria-label="Interviewer"
                  data-testid="interviewer-select"
                  value={interviewerId}
                  onChange={(e) => setInterviewerId(e.target.value)}
                  className="f-input f-input-sm w-auto"
                >
                  <option value="">Interviewer (optional)</option>
                  {interviewers.map((u) => (
                    <option key={u.userId} value={u.userId}>{u.name}</option>
                  ))}
                </select>
                <button
                  className="f-btn f-btn-ghost f-btn-sm"
                  data-testid="schedule-interview-btn"
                  disabled={!date}
                  onClick={() => void busy(() => scheduleExitInterview({
                    interviewId: interview.id,
                    scheduledAt: date,
                    ...(interviewerId ? { interviewerId } : {}),
                  }))}
                >
                  {interview.status === "SCHEDULED" ? "Reschedule" : "Schedule"}
                </button>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                <input
                  type="text"
                  placeholder="Outcome notes"
                  aria-label="Interview notes"
                  data-testid="interview-notes-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="f-input f-input-sm flex-1 min-w-40"
                />
                <button
                  className="f-btn f-btn-ghost f-btn-sm"
                  data-testid="complete-interview-btn"
                  onClick={() => void busy(() => completeExitInterview({
                    interviewId: interview.id,
                    ...(notes ? { notes } : {}),
                  }))}
                >
                  <Check size={13} /> Complete
                </button>
                <button
                  className="f-btn f-btn-ghost f-btn-sm text-destructive"
                  data-testid="cancel-interview-btn"
                  onClick={() => void busy(() => cancelExitInterview({ interviewId: interview.id }))}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task, onToggle,
}: {
  task: NonNullable<OffboardingCaseT["checklist"]>["tasks"][number];
  onToggle: (done: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-1.5">
      <button
        type="button"
        aria-label={task.done ? `Undo ${task.title}` : `Complete ${task.title}`}
        data-testid={`separation-task-${task.title}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onToggle(!task.done);
          setBusy(false);
        }}
        className={cn(
          "w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors",
          task.done ? "bg-success border-success text-white" : "border-border hover:border-primary",
        )}
      >
        {task.done && <Check size={12} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm truncate flex items-center gap-1.5", task.done ? "text-muted-foreground line-through" : "text-foreground")}>
          <span className="truncate">{task.title}</span>
          {task.isRequired && !task.done && (
            <span
              className="shrink-0 rounded bg-warning/15 text-warning text-[0.5625rem] font-semibold uppercase tracking-wider px-1 py-0.5"
              title="A required task — flagged for the settlement gate"
              data-testid={`separation-required-${task.title}`}
            >
              req
            </span>
          )}
        </div>
        <div className="text-[0.625rem] text-muted-foreground">
          {task.assigneeName ? `@${task.assigneeName}` : task.assigneeRole ? `the ${task.assigneeRole} role` : "unassigned"}{" "}
          · {task.dueDate
            ? `due ${new Date(task.dueDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
            : `within ${task.dueOffsetDays} day(s)`}
        </div>
      </div>
    </div>
  );
}

function ChecklistBlock({
  caseData, onChanged,
}: {
  caseData: OffboardingCaseT;
  onChanged: () => Promise<void>;
}) {
  const checklist = caseData.checklist;
  if (!checklist) return null;
  const total = checklist.tasks.length;
  const done = checklist.tasks.filter((t) => t.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="rounded-md border border-border p-3" data-testid="separation-checklist">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate">
          {checklist.title}
        </div>
        <div className="text-[0.6875rem] text-muted-foreground shrink-0">
          {done}/{total} {checklist.completedAt ? "· complete" : ""}
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden my-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full transition-all", pct >= 100 ? "bg-success" : "bg-primary", barWidthClass(pct))} />
      </div>
      <div className="space-y-1.5">
        {checklist.tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            onToggle={async (next) => {
              const res = await setTaskDone({ taskId: t.id, done: next });
              if (res.ok) { await onChanged(); } else { toast.error(res.error); }
            }}
          />
        ))}
        {total === 0 && <div className="text-xs text-muted-foreground">No tasks yet.</div>}
      </div>
    </div>
  );
}

function StartSeparationModal({
  open, members, onClose, onCreated,
}: {
  open: boolean;
  members: { userId: string; name: string }[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const name = members.find((m) => m.userId === userId)?.name;
    if (!userId || !name) return;
    setBusy(true);
    const res = await createChecklist({
      newHireId: userId,
      title: `Separation — ${name}`,
      useTemplate: true,
      kind: "SEPARATION",
    });
    setBusy(false);
    if (res.ok) {
      toast.success(`Separation checklist started for ${name}.`);
      setUserId("");
      await onCreated();
      onClose();
    } else {
      toast.error(res.error);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Start a separation">
      <div className="space-y-3">
        <Field label="Employee">
          <select
            aria-label="Employee leaving"
            data-testid="separation-user-select"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="f-input w-full"
          >
            <option value="">Pick the employee…</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>{m.name}</option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">
          Creates the 5-task separation checklist (handover, device return, access revocation, exit interview,
          full-and-final settlement). Record the exit itself (status + last working day) from the Directory tab.
        </p>
        <div className="flex justify-end gap-2">
          <button className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="f-btn f-btn-primary f-btn-sm"
            data-testid="confirm-start-separation-btn"
            disabled={!userId || busy}
            onClick={() => void create()}
          >
            <Plus size={14} /> Start separation
          </button>
        </div>
      </div>
    </Modal>
  );
}

function OffboardingCard({
  caseData, interviewers, onChanged,
}: {
  caseData: OffboardingCaseT;
  interviewers: { userId: string; name: string }[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.ok) { await onChanged(); } else { toast.error(res.error ?? "Something went wrong"); }
  };
  const fnf = caseData.fnf;

  return (
    <div className="f-card p-4 space-y-3" data-testid="offboarding-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate" data-testid="offboarding-name">
            {caseData.name}
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            {caseData.jobTitle || "—"} · hired {fmtDay(caseData.hireDate)} · LWD{" "}
            <span data-testid="offboarding-lwd">{fmtDay(caseData.lastWorkingDay)}</span>
            {caseData.noticePeriodWeeks !== null ? ` · ${caseData.noticePeriodWeeks} week(s) notice` : ""}
          </div>
        </div>
        <span
          data-testid="offboarding-status"
          className={cn(
            "inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium shrink-0",
            EMPLOYMENT_STATUS_BADGE[caseData.employmentStatus],
          )}
        >
          {EMPLOYMENT_STATUS_LABELS[caseData.employmentStatus]}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="space-y-3">
          {caseData.checklist ? (
            <ChecklistBlock caseData={caseData} onChanged={onChanged} />
          ) : (
            <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              No separation checklist yet.
            </div>
          )}
          <InterviewBlock caseData={caseData} interviewers={interviewers} onChanged={onChanged} />
        </div>
        <div className="space-y-3">
          <FnFBlock fnf={fnf} />
          {caseData.employmentStatus === "EXITED" && (
            <div className="flex gap-1.5 flex-wrap">
              {fnf.status !== "SETTLED" && (
                <button
                  className="f-btn f-btn-ghost f-btn-sm"
                  data-testid="generate-fnf-btn"
                  disabled={busy}
                  onClick={() => void act(() => generateFullAndFinal({ userId: caseData.userId }))}
                >
                  {fnf.status === "NONE" ? "Generate statement" : "Refresh snapshot"}
                </button>
              )}
              {fnf.status === "UNSETTLED" && (
                <button
                  className="f-btn f-btn-primary f-btn-sm"
                  data-testid="settle-fnf-btn"
                  disabled={busy}
                  onClick={() => void act(() => settleFullAndFinal({ userId: caseData.userId }))}
                >
                  Settle — freeze amounts
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OffboardingTab() {
  const [data, setData] = useState<OffboardingOverviewT | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const res = await getOffboardingOverview();
    if (res.ok) setData(res.data);
    else { toast.error(res.error); setData({ cases: [], members: [], interviewers: [] }); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  if (!data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading offboarding…</div>;
  }

  return (
    <div className="space-y-3" data-testid="hr-offboarding">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">
          Separation checklists, exit interviews and full-and-final settlements — one card per leaving employee.
        </p>
        <button
          className="f-btn f-btn-primary f-btn-sm"
          onClick={() => setCreating(true)}
          data-testid="start-separation-btn"
        >
          <Plus size={14} /> Start separation
        </button>
      </div>

      {data.cases.map((c) => (
        <OffboardingCard key={c.userId} caseData={c} interviewers={data.interviewers} onChanged={load} />
      ))}
      {data.cases.length === 0 && (
        <div className="f-card p-6 text-sm text-muted-foreground">
          Nobody is offboarding right now — start a separation to begin (the full-and-final computes once the exit
          is recorded in the Directory).
        </div>
      )}

      <StartSeparationModal
        open={creating}
        members={data.members}
        onClose={() => setCreating(false)}
        onCreated={load}
      />
    </div>
  );
}
