"use client";

// HR module feature 4 — onboarding UI (docs/HR_MODULE_PLAN.md §7).
// OnboardingTab: the HR console (create checklist from template, add tasks,
// tick anything). MyOnboardingSection: self-service — the hire and task
// assignees tick their own tasks from the Settings view.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ListChecks, Plus, Check } from "lucide-react";
import { toast } from "sonner";
import { Section } from "../ui/section";
import { Field } from "../ui/field";
import { Modal } from "../ui/modal";
import { cn, barWidthClass } from "@/lib/utils";
import type { OnboardingChecklistT } from "@/lib/types";
import {
  getOnboarding,
  createChecklist,
  addTask,
  getMyOnboardingTasks,
  setTaskDone,
} from "@/server-actions/hr-onboarding";
import { getDirectory } from "@/server-actions/hr-directory";
import { useApp } from "@/store/app-store";

function progressOf(c: OnboardingChecklistT): { done: number; total: number; pct: number } {
  const total = c.tasks.length;
  const done = c.tasks.filter((t) => t.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

function TaskRow({
  task, disabled, onToggle,
}: {
  task: OnboardingChecklistT["tasks"][number];
  disabled: boolean;
  onToggle: (done: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <button
        type="button"
        aria-label={task.done ? `Undo ${task.title}` : `Complete ${task.title}`}
        data-testid={`task-${task.title}`}
        disabled={busy || disabled}
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
        <div className={cn("text-sm truncate", task.done ? "text-muted-foreground line-through" : "text-foreground")}>
          {task.title}
        </div>
        <div className="text-[0.625rem] text-muted-foreground">
          {task.assigneeName ? `@${task.assigneeName}` : "unassigned"} · due day {task.dueOffsetDays}
          {task.doneBy ? ` · done by ${task.doneBy}` : ""}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HR console tab
// ---------------------------------------------------------------------------

export function OnboardingTab() {
  const [checklists, setChecklists] = useState<OnboardingChecklistT[] | null>(null);
  const [roster, setRoster] = useState<{ userId: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [addingTo, setAddingTo] = useState<OnboardingChecklistT | null>(null);

  const load = useCallback(async () => {
    const [res, dirRes] = await Promise.all([getOnboarding(), getDirectory()]);
    if (res.ok) setChecklists(res.data);
    else { toast.error(res.error); setChecklists([]); }
    if (dirRes.ok) setRoster(dirRes.data.profiles.map((p) => ({ userId: p.userId, name: p.name })));
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // F2.1 — separation checklists live in the Offboarding tab; this tab
  // keeps the new-hire flow only.
  const onboardingOnly = useMemo(
    () => (checklists ?? []).filter((c) => c.kind !== "SEPARATION"),
    [checklists],
  );

  if (checklists === null) {
    return <div className="p-6 text-sm text-muted-foreground">Loading onboarding checklists…</div>;
  }

  return (
    <div className="space-y-3" data-testid="hr-onboarding">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">
          Per-hire checklists. The template assigns manager tasks automatically; the hire and assignees tick their own.
        </p>
        <button className="f-btn f-btn-primary f-btn-sm" onClick={() => setCreating(true)}>
          <Plus size={14} /> New Checklist
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {onboardingOnly.map((c) => {
          const { done, total, pct } = progressOf(c);
          return (
            <div key={c.id} className="f-card p-4" data-testid={`checklist-${c.title}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{c.title}</div>
                  <div className="text-[0.6875rem] text-muted-foreground">
                    {c.hireName} · {done}/{total} tasks {c.completedAt ? "· complete" : ""}
                  </div>
                </div>
                {!c.completedAt && (
                  <button
                    className="f-btn f-btn-ghost f-btn-sm shrink-0"
                    onClick={() => setAddingTo(c)}
                    aria-label={`Add task to ${c.title}`}
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden my-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className={cn("h-full rounded-full transition-all", pct >= 100 ? "bg-success" : "bg-primary", barWidthClass(pct))} />
              </div>
              <div className="space-y-1.5">
                {c.tasks.map((t) => (
                  <TaskRow key={t.id} task={t} disabled={false} onToggle={async (done) => {
                    const res = await setTaskDone({ taskId: t.id, done });
                    if (res.ok) { await load(); } else { toast.error(res.error); }
                  }} />
                ))}
                {c.tasks.length === 0 && <div className="text-xs text-muted-foreground">No tasks yet — add the first one.</div>}
              </div>
            </div>
          );
        })}
        {onboardingOnly.length === 0 && (
          <div className="f-card p-6 text-sm text-muted-foreground lg:col-span-2">No onboarding checklists yet.</div>
        )}
      </div>

      <CreateChecklistModal
        open={creating}
        roster={roster}
        onClose={() => setCreating(false)}
        onCreated={async () => { setCreating(false); await load(); }}
      />
      <AddTaskModal
        checklist={addingTo}
        roster={roster}
        onClose={() => setAddingTo(null)}
        onAdded={load}
      />
    </div>
  );
}

function CreateChecklistModal({
  open, roster, onClose, onCreated,
}: {
  open: boolean;
  roster: { userId: string; name: string }[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [newHireId, setNewHireId] = useState("");
  const [title, setTitle] = useState("");
  const [useTemplate, setUseTemplate] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title="Start onboarding">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await createChecklist({ newHireId, title, useTemplate });
          setBusy(false);
          if (res.ok) {
            toast.success("Onboarding checklist created");
            setTitle("");
            await onCreated();
          } else {
            toast.error(res.error);
          }
        }}
      >
        <Field label="New hire">
          <select className="f-input" value={newHireId} onChange={(e) => setNewHireId(e.target.value)} required>
            <option value="" disabled>Select the new hire…</option>
            {roster.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Checklist title">
          <input className="f-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. November 2026 onboarding" required />
        </Field>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} />
          Start from the default template (5 tasks, manager auto-assigned)
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy || !newHireId}>
            {busy ? "Creating…" : "Create checklist"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddTaskModal({
  checklist, roster, onClose, onAdded,
}: {
  checklist: OnboardingChecklistT | null;
  roster: { userId: string; name: string }[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueOffsetDays, setDueOffsetDays] = useState("7");
  const [busy, setBusy] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setTitle(""); setAssigneeId(""); setDueOffsetDays("7"); }, [checklist?.id]);

  if (!checklist) return null;

  return (
    <Modal open={Boolean(checklist)} onClose={onClose} title={`Add task — ${checklist.title}`}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await addTask({
            checklistId: checklist.id,
            title,
            assigneeId: assigneeId || null,
            dueOffsetDays: Number(dueOffsetDays) || 7,
          });
          setBusy(false);
          if (res.ok) {
            toast.success("Task added");
            await onAdded();
          } else {
            toast.error(res.error);
          }
        }}
      >
        <Field label="Task title">
          <input className="f-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Order the laptop" required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assignee">
            <select className="f-input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned (HR picks up)</option>
              {roster.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Due (days after start)">
            <input type="number" min={0} max={365} className="f-input" value={dueOffsetDays} onChange={(e) => setDueOffsetDays(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy || title.trim().length === 0}>
            {busy ? "Adding…" : "Add task"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Self-service (Settings view)
// ---------------------------------------------------------------------------

export function MyOnboardingSection() {
  const [checklists, setChecklists] = useState<OnboardingChecklistT[] | null>(null);
  const { bumpRefresh } = useApp();

  const load = useCallback(async () => {
    const res = await getMyOnboardingTasks();
    if (res.ok) setChecklists(res.data.checklists);
    else setChecklists([]);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const mine = useMemo(
    () => (checklists ?? []).filter((c) => c.tasks.some((t) => !t.done)),
    [checklists],
  );

  return (
    <Section icon={ListChecks} title="My onboarding" description="Tasks you are responsible for — tick them as you go">
      {checklists === null ? (
        <div className="text-sm text-muted-foreground py-2">Loading onboarding tasks…</div>
      ) : mine.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          {checklists.length === 0
            ? "No onboarding checklists involve you."
            : "All your onboarding tasks are done."}
        </div>
      ) : (
        <div className="space-y-3">
          {mine.map((c) => (
            <div key={c.id} className="rounded-lg border border-border p-3">
              <div className="text-sm font-medium text-foreground mb-2">
                {c.title} <span className="text-muted-foreground font-normal">· {c.hireName}</span>
              </div>
              <div className="space-y-1.5">
                {c.tasks.filter((t) => !t.done).map((t) => (
                  <TaskRow key={t.id} task={t} disabled={false} onToggle={async (done) => {
                    const res = await setTaskDone({ taskId: t.id, done });
                    if (res.ok) { await load(); bumpRefresh(); } else { toast.error(res.error); }
                  }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
