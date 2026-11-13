"use client";

// HR module feature 4 — onboarding UI (docs/HR_MODULE_PLAN.md §7).
// OnboardingTab: the HR console (create checklist from template, add tasks,
// tick anything). MyOnboardingSection: self-service — the hire and task
// assignees tick their own tasks from the Settings view.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ListChecks, Plus, Check, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Section } from "../ui/section";
import { Field, FormRow } from "../ui/field";
import { Modal } from "../ui/modal";
import { cn, barWidthClass } from "@/lib/shared/utils";
import type { OnboardingChecklistT, OnboardingTemplateTaskT } from "@/lib/types";
import {
  getOnboarding,
  createChecklist,
  addTask,
  getMyOnboardingTasks,
  setTaskDone,
  getOnboardingTemplates,
  saveOnboardingTemplateTask,
  deleteOnboardingTemplateTask,
} from "@/server-actions/hr-onboarding";
import { getDirectory } from "@/server-actions/hr-directory";
import { useApp } from "@/store/app-store";

function progressOf(c: OnboardingChecklistT): { done: number; total: number; pct: number } {
  // P35 — the server now derives completion (EM-11's boarding status) from
  // the task rows; the local calc stays only as the shape adapter for the
  // bar/card rendering below.
  return { done: c.completion.done, total: c.completion.total, pct: c.completion.percent };
}

/** P35 — one label for a task's assignee axis (user / role / self /
 *  manager / unassigned), the view twin of the server's audit label. */
function taskAssigneeLabel(task: OnboardingChecklistT["tasks"][number]): string {
  if (task.assigneeName) return `@${task.assigneeName}`;
  if (task.assigneeRole) return `the ${task.assigneeRole} role`;
  return "unassigned";
}

/** P35 (EM-12) — "Due 14 Nov" (holiday-aware date), or the raw offset for
 *  undated rows; overdue open tasks render destructive. */
function taskDueLabel(task: OnboardingChecklistT["tasks"][number]): { text: string; overdue: boolean } {
  if (task.dueDate) {
    const due = new Date(task.dueDate);
    const today = new Date();
    const overdue = !task.done && due.getTime() < today.getTime() - 24 * 60 * 60 * 1000;
    return { text: `due ${due.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`, overdue };
  }
  return { text: `due day ${task.dueOffsetDays}`, overdue: false };
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
        <div className={cn("text-sm truncate flex items-center gap-1.5", task.done ? "text-muted-foreground line-through" : "text-foreground")}>
          <span className="truncate">{task.title}</span>
          {task.isRequired && !task.done && (
            <span
              className="shrink-0 rounded bg-warning/15 text-warning text-[0.5625rem] font-semibold uppercase tracking-wider px-1 py-0.5"
              title="A required task — flagged for the completion gate"
              data-testid={`required-${task.title}`}
            >
              req
            </span>
          )}
        </div>
        <div className="text-[0.625rem] text-muted-foreground">
          {taskAssigneeLabel(task)} ·{" "}
          <span className={cn(taskDueLabel(task).overdue && "text-destructive font-medium")}>
            {taskDueLabel(task).text}
          </span>
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
  // F2.10 (F-R8) — the configurable template source (both kinds).
  const [templates, setTemplates] = useState<OnboardingTemplateTaskT[] | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);

  const load = useCallback(async () => {
    const [res, dirRes, tplRes] = await Promise.all([getOnboarding(), getDirectory(), getOnboardingTemplates()]);
    if (res.ok) setChecklists(res.data);
    else { toast.error(res.error); setChecklists([]); }
    if (dirRes.ok) setRoster(dirRes.data.profiles.map((p) => ({ userId: p.userId, name: p.name })));
    if (tplRes.ok) setTemplates(tplRes.data);
    else { toast.error(tplRes.error); setTemplates([]); }
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
      {/* F2.10 (F-R8) — the ONE template source, editable. New checklists
          (and every markJoined) instantiate from these rows. */}
      {templates !== null && (
        <Section icon={ListChecks} title="Default templates" description="The task list every new checklist instantiates — onboarding and separation">
          <TemplateEditor templates={templates} onChanged={load} onOpen={() => setTemplateModalOpen(true)} />
        </Section>
      )}

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
                    {c.hireName} · {done}/{total} tasks{" "}
                    <span
                      data-testid={`status-${c.title}`}
                      className={cn(
                        "rounded px-1 py-0.5 font-medium",
                        c.completion.status === "COMPLETE" ? "bg-success/15 text-success"
                          : c.completion.status === "IN_PROGRESS" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {c.completion.status === "COMPLETE" ? "complete" : c.completion.status === "IN_PROGRESS" ? `${c.completion.percent}% in progress` : "not started"}
                    </span>
                    {c.completion.requiredOpen > 0 && (
                      <span className="text-warning" title="Required tasks still open"> · {c.completion.requiredOpen} required open</span>
                    )}
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
      <TemplateTaskModal
        open={templateModalOpen}
        roster={roster}
        onClose={() => setTemplateModalOpen(false)}
        onChanged={load}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// F2.10 (F-R8) — the default-template editor (compact: two lists + row
// actions + one add/edit modal).
// ---------------------------------------------------------------------------

function TemplateEditor({
  templates, onChanged, onOpen,
}: {
  templates: OnboardingTemplateTaskT[];
  onChanged: () => Promise<void>;
  onOpen: () => void;
}) {
  const groups = [
    { kind: "ONBOARDING" as const, label: "Onboarding (new hires)" },
    { kind: "SEPARATION" as const, label: "Separation (exits)" },
  ];
  const remove = async (id: string, title: string) => {
    const res = await deleteOnboardingTemplateTask({ id });
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Removed "${title}" from the template.`);
    await onChanged();
  };

  return (
    <div className="space-y-3" data-testid="onboarding-template-editor">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {groups.map((g) => {
          const rows = templates.filter((t) => t.kind === g.kind).sort((a, b) => a.sortOrder - b.sortOrder);
          return (
            <div key={g.kind} className="rounded-md border border-border p-3" data-testid={`template-group-${g.kind}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</div>
                <span className="text-xs text-muted-foreground">{rows.filter((r) => r.isActive).length} active</span>
              </div>
              <div className="space-y-1">
                {rows.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm" data-testid={`template-task-${t.title}`}>
                    <span className={cn("min-w-0 grow truncate", !t.isActive && "text-muted-foreground line-through")}>{t.title}</span>
                    <span className="text-[0.625rem] text-muted-foreground shrink-0" data-testid={`template-chip-${t.title}`}>
                      day {t.dueOffsetDays} ·{" "}
                      {t.assigneeUserId ? "@user" : t.assigneeRole ? `${t.assigneeRole} role` : t.assignSelf ? "hire" : "manager"}
                      {t.isRequired ? " · required" : ""}
                    </span>
                    <button
                      className="f-btn f-btn-ghost f-btn-sm shrink-0"
                      onClick={onOpen}
                      aria-label={`Edit ${t.title}`}
                      data-testid={`edit-template-${t.title}`}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="f-btn f-btn-ghost f-btn-sm text-destructive shrink-0"
                      onClick={() => void remove(t.id, t.title)}
                      aria-label={`Remove ${t.title}`}
                      data-testid={`delete-template-${t.title}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                {rows.length === 0 && (
                  <div className="text-xs text-muted-foreground">No rows — the canonical code defaults apply.</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div>
        <button className="f-btn f-btn-secondary f-btn-sm" onClick={onOpen} data-testid="add-template-task-btn">
          <Plus size={14} /> Add / edit template task
        </button>
      </div>
    </div>
  );
}

function TemplateTaskModal({
  open, onClose, onChanged, roster,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  roster: { userId: string; name: string }[];
}) {
  const [kind, setKind] = useState<"ONBOARDING" | "SEPARATION">("ONBOARDING");
  const [title, setTitle] = useState("");
  const [dueOffsetDays, setDueOffsetDays] = useState(3);
  // P35 — the assignee axis: MANAGER default / SELF / one USER / one ROLE
  // (the last two are the XOR pair — picking one clears the other).
  const [assigneeMode, setAssigneeMode] = useState<"MANAGER" | "SELF" | "USER" | "ROLE">("MANAGER");
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [assigneeRole, setAssigneeRole] = useState<"ADMIN" | "MANAGER" | "HR" | "MEMBER">("HR");
  const [isRequired, setIsRequired] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title="Template task" description="Added to every future checklist of this kind">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await saveOnboardingTemplateTask({
            kind,
            title,
            dueOffsetDays,
            // The XOR pair collapses onto the mode: only one of the two is
            // ever sent (assignSelf rides the SELF mode).
            assignSelf: assigneeMode === "SELF",
            assigneeUserId: assigneeMode === "USER" && assigneeUserId ? assigneeUserId : null,
            assigneeRole: assigneeMode === "ROLE" ? assigneeRole : null,
            isRequired,
            isActive,
          });
          setBusy(false);
          if (!res.ok) { toast.error(res.error); return; }
          toast.success("Template task saved.");
          setTitle("");
          await onChanged();
          onClose();
        }}
      >
        <FormRow>
          <Field label="Kind">
            <select className="f-input" value={kind} onChange={(e) => setKind(e.target.value as "ONBOARDING" | "SEPARATION")}>
              <option value="ONBOARDING">Onboarding (new hires)</option>
              <option value="SEPARATION">Separation (exits)</option>
            </select>
          </Field>
          <Field label="Due day (working days after the checklist starts)">
            <input
              type="number" min={1} max={365} className="f-input"
              value={dueOffsetDays}
              onChange={(e) => setDueOffsetDays(Number(e.target.value))}
              data-testid="template-due-day"
            />
          </Field>
        </FormRow>
        <Field label="Task title">
          <input
            className="f-input" value={title} maxLength={200} required
            onChange={(e) => setTitle(e.target.value)}
            data-testid="template-title-input"
          />
        </Field>
        <FormRow>
          <Field label="Assignee">
            <select
              className="f-input" value={assigneeMode}
              onChange={(e) => setAssigneeMode(e.target.value as typeof assigneeMode)}
              data-testid="template-assignee-mode"
            >
              <option value="MANAGER">The hire's manager</option>
              <option value="SELF">The hire / leaver themself</option>
              <option value="USER">One named user…</option>
              <option value="ROLE">Everyone holding a role…</option>
            </select>
          </Field>
          {assigneeMode === "USER" ? (
            <Field label="User">
              <select
                className="f-input" value={assigneeUserId}
                onChange={(e) => setAssigneeUserId(e.target.value)}
                data-testid="template-assignee-user"
                required
              >
                <option value="" disabled>Pick a user…</option>
                {roster.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
              </select>
            </Field>
          ) : assigneeMode === "ROLE" ? (
            <Field label="Role (every holder sees the task)">
              <select
                className="f-input" value={assigneeRole}
                onChange={(e) => setAssigneeRole(e.target.value as typeof assigneeRole)}
                data-testid="template-assignee-role"
              >
                <option value="HR">HR</option>
                <option value="MANAGER">Manager</option>
                <option value="ADMIN">Admin</option>
                <option value="MEMBER">Member</option>
              </select>
            </Field>
          ) : <div />}
        </FormRow>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="accent-primary" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} data-testid="template-required" />
            Required
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="accent-primary" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active (instantiated)
          </label>
          <div className="text-[0.625rem] text-muted-foreground self-center">Due dates skip weekends & holidays</div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Close</button>
          <button type="submit" className="f-btn f-btn-primary" disabled={busy} data-testid="save-template-task-btn">
            Save task
          </button>
        </div>
      </form>
    </Modal>
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
  // P35 — optional walk anchor; empty = the profile fact (hireDate /
  // lastWorkingDay), else today.
  const [startDate, setStartDate] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title="Start onboarding">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await createChecklist({
            newHireId,
            title,
            useTemplate,
            ...(startDate ? { startDate } : {}),
          });
          setBusy(false);
          if (res.ok) {
            toast.success("Onboarding checklist created");
            setTitle("");
            setStartDate("");
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
        <Field label="Start date (due dates count working days from here)">
          <input
            type="date" className="f-input" value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            data-testid="checklist-start-date"
          />
          <p className="text-[0.625rem] text-muted-foreground">Empty = the hire date on file (today when none).</p>
        </Field>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} />
          Start from the default template (manager tasks auto-assigned; due dates skip weekends & holidays)
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
  // P35 — the required flag on manual adds.
  const [isRequired, setIsRequired] = useState(false);
  const [busy, setBusy] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setTitle(""); setAssigneeId(""); setDueOffsetDays("7"); setIsRequired(false); }, [checklist?.id]);

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
            isRequired,
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
          <Field label="Due (working days after start)">
            <input type="number" min={0} max={365} className="f-input" value={dueOffsetDays} onChange={(e) => setDueOffsetDays(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input type="checkbox" className="accent-primary" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} data-testid="add-task-required" />
          Required task
        </label>
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
