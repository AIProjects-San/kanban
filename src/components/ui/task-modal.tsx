"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { Link2, Users, Info, Clock, Bug as BugIcon, Trash2, X, Loader2, Plus } from "lucide-react";
import { Modal } from "./modal";
import { useApp } from "@/store/app-store";
import { useRefresh } from "@/hooks/use-refresh";
import {
  createTask,
  updateTask,
  deleteTask,
  getMyProjects,
  getProjectMembers,
  logTaskTime,
  getTaskTimeLog,
  deleteTimeEntry,
  getTaskLinkedBugs,
  getLinkableBugs,
} from "@/server-actions/data";
import { linkBugToTask } from "@/server-actions/bugs";
import { toast } from "sonner";
import { EntityHistorySection } from "./entity-history-section";
import { Field, FormRow } from "./field";
import { FormActions } from "./form-actions";
import { PRIORITIES, TASK_TAGS } from "@/lib/constants";
import { TASK_STATUSES, BUG_SEVERITY_BADGE, BUG_SEVERITY_LABELS, BUG_STATUS_BADGE, BUG_STATUS_LABELS } from "@/lib/config";
import { cn } from "@/lib/utils";
import { canDeleteTask, type TaskDeleteContext } from "@/lib/task-delete";
import { useAppSession } from "@/hooks/use-app-session";
import type { TaskT, TaskStatus, TaskTag, Priority, ProjectT, TeamMemberT, BugSeverity, BugStatus } from "@/lib/types";

interface TaskModalProps {
  tasks: TaskT[];
  projects: ProjectT[];
  /** PR-61 — context for the row-level task-delete rule (see lib/task-delete.ts). */
  members?: TeamMemberT[];
  managedUserIds?: string[];
}

/** Narrow shape used by the project selector — from getMyProjects() */
interface ProjectOption {
  id: string;
  name: string;
  color: string;
  status: string;
}

/** Narrow shape returned by getProjectMembers() */
interface ProjectMember {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string;
  avatarColor: string;
  online: boolean;
  openTasks: number;
  completedTasks: number;
  workload: number;
  isOwner: boolean;
}

export function TaskModal({ tasks, projects, members = [], managedUserIds = [] }: TaskModalProps) {
  const { taskModalOpen, taskModalEditId, taskModalDefaultStatus, closeTaskModal } = useApp();
  const editing = taskModalEditId ? tasks.find((t) => t.id === taskModalEditId) ?? null : null;
  const { data: session } = useAppSession();
  const sessionUser = session?.user ?? null;

  // PR-61 — the Delete button only renders for users the server would
  // actually allow to delete this task: ADMIN, the assignee, the project
  // owner, or a manager whose reporting chain covers the assignee/owner.
  const myTeamMemberId = sessionUser
    ? members.find((m) => m.userId === sessionUser.id)?.id ?? null
    : null;
  const deleteCtx: TaskDeleteContext = { members, projects, myTeamMemberId, managedUserIds };
  const showDelete = editing ? canDeleteTask(sessionUser, editing, deleteCtx) : false;

  return (
    <Modal
      open={taskModalOpen}
      onClose={closeTaskModal}
      title={editing ? "Edit task" : "New task"}
      description={editing ? "Update task details" : "Add a new task to your board"}
      size="md"
    >
      {taskModalOpen && (
        // key remounts the body on each open/edit target — fresh fetch + fresh form state
        <TaskModalBody
          key={editing?.id ?? "new"}
          editing={editing}
          defaultStatus={taskModalDefaultStatus as TaskStatus}
          allProjects={projects}
          showDelete={showDelete}
          onClose={closeTaskModal}
        />
      )}
    </Modal>
  );
}

function TaskModalBody({
  editing,
  defaultStatus,
  allProjects,
  showDelete,
  onClose,
}: {
  editing: TaskT | null;
  defaultStatus: TaskStatus;
  allProjects: ProjectT[];
  /** PR-61 — row-level delete rule, computed by the parent. */
  showDelete: boolean;
  onClose: () => void;
}) {
  // Projects the current user is associated with (owner or task assignee).
  // This component mounts fresh each time the modal opens, so the fetch
  // always reflects the latest associations.
  const [myProjects, setMyProjects] = useState<ProjectOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyProjects()
      .then((result) => {
        if (cancelled) return;
        setMyProjects(result.ok ? result.data : []);
      })
      .catch(() => {
        if (!cancelled) setMyProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When editing, keep the task's current project selectable even if the
  // user is no longer associated with it (removing it would break the select).
  const allowedProjects = useMemo<ProjectOption[] | null>(() => {
    if (myProjects === null) return null;
    if (editing?.projectId && !myProjects.some((p) => p.id === editing.projectId)) {
      const current = allProjects.find((p) => p.id === editing.projectId);
      if (current) {
        return [...myProjects, { id: current.id, name: current.name, color: current.color, status: current.status }];
      }
    }
    return myProjects;
  }, [myProjects, editing, allProjects]);

  return (
    <TaskForm
      editing={editing}
      defaultStatus={defaultStatus}
      projects={allowedProjects ?? []}
      projectsLoading={allowedProjects === null}
      showDelete={showDelete}
      onClose={onClose}
    />
  );
}

function TaskForm({
  editing,
  defaultStatus,
  projects,
  projectsLoading,
  showDelete,
  onClose,
}: {
  editing: TaskT | null;
  defaultStatus: TaskStatus;
  projects: ProjectOption[];
  projectsLoading: boolean;
  /** PR-61 — row-level delete rule, computed in TaskModal. */
  showDelete: boolean;
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const [title, setTitle] = useState(editing?.title ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(editing?.status ?? defaultStatus);
  const [priority, setPriority] = useState<Priority>(editing?.priority ?? "MEDIUM");
  const [tag, setTag] = useState<TaskTag>(editing?.tag ?? "FRONTEND");
  const [dueDate, setDueDate] = useState(editing?.dueDate ? editing.dueDate.slice(0, 10) : "");
  // Estimate (required time), entered in hours for humans, stored in minutes.
  const [estimateHours, setEstimateHours] = useState(
    editing?.estimateMinutes ? String(Math.round((editing.estimateMinutes / 60) * 10) / 10) : "",
  );
  // null = untouched (derive default); string = user picked explicitly ("" = None)
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState(editing?.assigneeId ?? "");

  const projectId = pickedProjectId ?? (editing ? editing.projectId ?? "" : projects[0]?.id ?? "");

  const submit = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    // Project association rule — every task belongs to a project (enforced
    // server-side too; this is the friendly client-side gate).
    if (!projectId) {
      toast.error(
        projects.length === 0
          ? "Task must be assigned to a project — you're not associated with any project yet"
          : "Task must be assigned to a project — pick one first",
      );
      return;
    }
    const estimateMinutes = estimateHours.trim() === "" ? 0 : Math.round(parseFloat(estimateHours) * 60);
    if (Number.isNaN(estimateMinutes) || estimateMinutes < 0) {
      toast.error("Estimate must be a positive number of hours");
      return;
    }
    const payload = {
      title: title.trim(),
      description,
      status,
      priority,
      tag,
      dueDate: dueDate || null,
      projectId: projectId || null,
      assigneeId: assigneeId || null,
      estimateMinutes,
    };
    if (editing) {
      const res = await updateTask(editing.id, payload);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Task updated");
    } else {
      const res = await createTask(payload);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Task created");
    }
    refresh();
    onClose();
  };

  const remove = async () => {
    if (!editing) return;
    const res = await deleteTask(editing.id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Task deleted");
    refresh();
    onClose();
  };

  // When the user changes the project, clear the assignee so they consciously
  // re-pick from the new project's allocated set.
  const handleProjectChange = (newProjectId: string) => {
    setPickedProjectId(newProjectId);
    setAssigneeId("");
  };

  return (
    // A real <form> (not a bare div): Enter submits the dialog, and screen
    // readers announce the fields as a form. Buttons opt out of implicit
    // submission explicitly — see FormActions.
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Title">
        <input
          autoFocus
          type="text"
          className="f-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to be done?"
        />
      </Field>
      <Field label="Description">
        <textarea
          className="f-input min-h-[72px] py-2"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add details, scope, or acceptance criteria"
        />
      </Field>
      <FormRow>
        <Field label="Status">
          <select className="f-input" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
            {TASK_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className="f-input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
      </FormRow>
      <FormRow>
        <Field label="Tag">
          <select className="f-input" value={tag} onChange={(e) => setTag(e.target.value as TaskTag)}>
            {TASK_TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Due date">
          <input type="date" className="f-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </FormRow>
      <FormRow>
        <Field label="Estimate (hours)">
          <input
            type="number"
            min={0}
            max={168}
            step={0.5}
            className="f-input"
            value={estimateHours}
            onChange={(e) => setEstimateHours(e.target.value)}
            placeholder="e.g. 4 — required time for this task"
          />
          <p className="flex items-center gap-1 text-[0.625rem] text-muted-foreground mt-1">
            <Clock size={9} />
            Required time — time spent is logged below while you work
          </p>
        </Field>
      </FormRow>
      <FormRow>
        <Field label="Project *">
          <select
            className="f-input"
            value={projectId}
            onChange={(e) => handleProjectChange(e.target.value)}
            disabled={projectsLoading}
            aria-label="Project"
          >
            {projectsLoading ? (
              <option value="">Loading projects…</option>
            ) : (
              <>
                {/* Disabled placeholder — a task must belong to a project.
                    Shown pre-selected only for legacy project-less tasks,
                    which must be given a project before they can be saved. */}
                <option value="" disabled>— Select a project —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </>
            )}
          </select>
          {!projectsLoading && (
            <p className="flex items-center gap-1 text-[0.625rem] text-muted-foreground mt-1">
              <Link2 size={9} />
              {projects.length === 0
                ? "You're not associated with any project yet"
                : `Projects you own or are assigned to (${projects.length}) — assignees come from the project team`}
            </p>
          )}
        </Field>
        {/* AssigneeField remounts whenever projectId changes — fresh fetch of
            allocated members each time, no manual state reset needed. */}
        <AssigneeField
          key={projectId || "none"}
          projectId={projectId}
          currentAssigneeId={assigneeId}
          editingAssignee={editing?.assignee ?? null}
          onAssigneeChange={setAssigneeId}
        />
      </FormRow>
      <FormActions
        editing={!!editing}
        createLabel="Create task"
        editLabel="Save changes"
        onCancel={onClose}
        onSubmit={submit}
        onDelete={remove}
        showDelete={showDelete}
      />

      {/* Board enhancement — time log (required vs spent). Only when editing
          an existing task; new tasks get logged once they exist. */}
      {editing && <TimeLogSection taskId={editing.id} onLogAdded={() => refresh()} />}

      {/* Board enhancement — bugs linked to this task (Task ↔ Bug). */}
      {editing && <LinkedBugsSection taskId={editing.id} onLinkChanged={() => refresh()} />}

      {/* Expandable audit history — only when editing an existing task.
          New tasks have no history yet, so we hide the section entirely. */}
      {editing && (
        <EntityHistorySection
          entityType="TASK"
          entityId={editing.id}
          entityLabel={editing.title}
        />
      )}
    </form>
  );
}

/**
 * Assignee dropdown that only lists people associated with the selected
 * project (explicit ProjectAssignment or ownership — the same rule the
 * server enforces on createTask/updateTask). Mounts fresh (via `key`) each
 * time the project changes, so the fetch + the loading state are always
 * consistent with the current project.
 *
 * When `projectId` is empty (legacy project-less task being edited) the list
 * is empty — pick a project first, then choose one of its team members.
 */
function AssigneeField({
  projectId,
  currentAssigneeId,
  editingAssignee,
  onAssigneeChange,
}: {
  projectId: string;
  currentAssigneeId: string;
  editingAssignee: { id: string; name: string; avatarColor: string } | null;
  onAssigneeChange: (id: string) => void;
}) {
  // null = loading; [] = loaded but empty; non-empty = loaded.
  // Initialize so we don't fetch when there's no project.
  const [projectMembers, setProjectMembers] = useState<ProjectMember[] | null>(
    projectId ? null : []
  );

  useEffect(() => {
    if (!projectId) return; // nothing to fetch
    let cancelled = false;
    getProjectMembers(projectId)
      .then((result) => {
        if (cancelled) return;
        setProjectMembers(result.ok ? result.data : []);
      })
      .catch(() => {
        if (!cancelled) setProjectMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const options = useMemo<{ id: string; name: string; extra?: string }[]>(() => {
    if (!projectId || projectMembers === null) return [];
    const opts: { id: string; name: string; extra?: string }[] = projectMembers.map((m) => ({
      id: m.id,
      name: m.name,
      extra: m.isOwner ? "owner" : undefined,
    }));
    // Preserve the currently-edited assignee if they're not in the project's set
    // (so we don't silently drop the value on legacy rows).
    if (editingAssignee && !opts.some((o) => o.id === editingAssignee.id)) {
      opts.push({ id: editingAssignee.id, name: editingAssignee.name, extra: "current" });
    }
    return opts;
  }, [projectId, projectMembers, editingAssignee]);

  const loading = !!projectId && projectMembers === null;

  return (
    <Field label="Assignee">
      <select
        className="f-input"
        value={currentAssigneeId}
        onChange={(e) => onAssigneeChange(e.target.value)}
        disabled={loading || !projectId}
        aria-label="Assignee"
      >
        <option value="">
          {loading
            ? "Loading project members…"
            : projectId
              ? "— Unassigned —"
              : "— Select a project first —"}
        </option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}{m.extra ? ` (${m.extra})` : ""}
          </option>
        ))}
      </select>
      {projectId && !loading && (
        <p className="flex items-center gap-1 text-[0.625rem] text-muted-foreground mt-1">
          <Users size={9} />
          {options.length === 0
            ? "No team members are assigned to this project yet"
            : `Only users assigned to this project (${options.length})`}
        </p>
      )}
      {projectId && !loading && options.length === 0 && (
        <p className="flex items-start gap-1 text-[0.625rem] text-warning mt-1">
          <Info size={9} className="mt-0.5 shrink-0" />
          Assign users to this project first (Team → project assignments), then pick an assignee.
        </p>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Board enhancement — TimeLogSection (required vs spent)
//
// Shows the task's estimate, the spent aggregate, a progress bar, the
// individual entries, and a small form to log more time. Deleting an entry
// is enforced server-side (own entries, or task:edit:any).
// ---------------------------------------------------------------------------

interface TimeLogData {
  taskId: string;
  estimateMinutes: number;
  spentHours: number;
  entries: Array<{
    id: string;
    date: string;
    hours: number;
    description: string;
    memberId: string | null;
    memberName: string | null;
    createdAt: string;
  }>;
}

function TimeLogSection({ taskId, onLogAdded }: { taskId: string; onLogAdded: () => void }) {
  const [log, setLog] = useState<TimeLogData | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getTaskTimeLog(taskId);
      if (res.ok) setLog(res.data);
    } catch {
      // Swallow — the section just renders the empty state.
    }
  }, [taskId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    const h = parseFloat(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24) {
      toast.error("Hours must be greater than 0 and at most 24");
      return;
    }
    setSaving(true);
    try {
      const res = await logTaskTime({ taskId, date, hours: h, description: description.trim() || undefined });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Logged ${h}h on this task`);
      setHours("");
      setDescription("");
      await load();
      onLogAdded();
    } catch {
      toast.error("Failed to log time");
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = async (id: string) => {
    try {
      const res = await deleteTimeEntry(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Time entry deleted");
      await load();
      onLogAdded();
    } catch {
      toast.error("Failed to delete time entry");
    }
  };

  const estimateHours = log ? log.estimateMinutes / 60 : 0;
  const spent = log?.spentHours ?? 0;
  // Progress caps at 100% visually; over-estimate is flagged in red.
  const pct = estimateHours > 0 ? Math.min(100, Math.round((spent / estimateHours) * 100)) : 0;
  const over = estimateHours > 0 && spent > estimateHours;

  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">Time log</h3>
        </div>
        {log && (
          <span className={cn("text-xs font-medium tabular-nums", over ? "text-destructive" : "text-muted-foreground")}>
            Spent {spent}h{estimateHours > 0 ? ` / Required ${Math.round(estimateHours * 10) / 10}h` : ""}
          </span>
        )}
      </div>

      {log === null ? (
        <div className="flex items-center gap-1 text-xs text-muted-foreground py-2">
          <Loader2 size={12} className="animate-spin" /> Loading time log…
        </div>
      ) : (
        <>
          {estimateHours > 0 && (
            <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={cn("h-full rounded-full transition-all", over ? "bg-destructive" : pct >= 100 ? "bg-success" : "bg-primary")}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          )}

          {/* Entries */}
          {log.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground mb-3">No time logged yet. Log the first entry below.</p>
          ) : (
            <div className="space-y-1.5 mb-3 max-h-[180px] overflow-y-auto f-scroll">
              {log.entries.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-xs py-1 px-2 rounded-md bg-muted/40">
                  <span className="tabular-nums font-medium w-[86px] shrink-0 text-foreground">{new Date(e.date).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</span>
                  <span className="tabular-nums font-semibold w-[44px] shrink-0">{e.hours}h</span>
                  <span className="text-muted-foreground truncate flex-1">
                    {e.memberName ? `${e.memberName}${e.description ? " · " : ""}` : ""}
                    {e.description}
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeEntry(e.id)}
                    className="opacity-60 hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                    aria-label="Delete time entry"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add entry */}
          <div className="flex gap-2 items-start">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="f-input w-auto text-xs"
              aria-label="Date"
            />
            <input
              type="number"
              min={0.25}
              max={24}
              step={0.25}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="h"
              className="f-input w-[70px] text-xs"
              aria-label="Hours"
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What did you work on?"
              maxLength={2000}
              className="f-input flex-1 text-xs"
              aria-label="Description"
            />
            <button type="button" onClick={() => void submit()} disabled={saving} className="f-btn f-btn-primary f-btn-sm shrink-0">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Log
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board enhancement — LinkedBugsSection (Task ↔ Bug)
//
// Lists the bugs linked to this task with severity/status badges, lets the
// user unlink them, and offers a picker of other bugs to link. Permission to
// change a link is enforced server-side (reporter / assignee / bug:edit:any).
// ---------------------------------------------------------------------------

interface LinkedBug {
  id: string;
  title: string;
  severity: string;
  status: string;
  priority?: string;
  resolution?: string | null;
}

function LinkedBugsSection({ taskId, onLinkChanged }: { taskId: string; onLinkChanged: () => void }) {
  const [linked, setLinked] = useState<LinkedBug[] | null>(null);
  const [linkable, setLinkable] = useState<LinkedBug[] | null>(null);
  const [pickedBugId, setPickedBugId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([getTaskLinkedBugs(taskId), getLinkableBugs(taskId)]);
      if (a.ok) setLinked(a.data);
      if (b.ok) setLinkable(b.data);
    } catch {
      // Swallow — the section renders the empty state.
    }
  }, [taskId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const link = async (bugId: string) => {
    setBusy(true);
    try {
      const res = await linkBugToTask(bugId, { taskId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Bug linked to this task");
      setPickedBugId("");
      await load();
      onLinkChanged();
    } catch {
      toast.error("Failed to link bug");
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (bugId: string) => {
    setBusy(true);
    try {
      const res = await linkBugToTask(bugId, { taskId: null });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Bug unlinked");
      await load();
      onLinkChanged();
    } catch {
      toast.error("Failed to unlink bug");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center gap-2 mb-2">
        <BugIcon size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">Linked bugs</h3>
        {linked !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">{linked.length}</span>
        )}
      </div>

      {linked === null ? (
        <div className="flex items-center gap-1 text-xs text-muted-foreground py-2">
          <Loader2 size={12} className="animate-spin" /> Loading linked bugs…
        </div>
      ) : (
        <>
          {linked.length === 0 ? (
            <p className="text-xs text-muted-foreground mb-2">No bugs linked. Link one below to track defects found in this task.</p>
          ) : (
            <div className="space-y-1.5 mb-2">
              {linked.map((b) => (
                <div key={b.id} className="flex items-center gap-2 text-xs py-1.5 px-2 rounded-md bg-muted/40">
                  <span className={cn("px-1.5 py-0.5 rounded-full font-medium shrink-0", BUG_SEVERITY_BADGE[b.severity as BugSeverity] ?? "bg-muted text-muted-foreground")}>
                    {BUG_SEVERITY_LABELS[b.severity as BugSeverity] ?? b.severity}
                  </span>
                  <span className={cn("px-1.5 py-0.5 rounded-full shrink-0", BUG_STATUS_BADGE[b.status as BugStatus] ?? "bg-muted text-muted-foreground")}>
                    {BUG_STATUS_LABELS[b.status as BugStatus] ?? b.status}
                  </span>
                  <span className="font-medium text-foreground truncate flex-1">{b.title}</span>
                  <button
                    type="button"
                    onClick={() => void unlink(b.id)}
                    disabled={busy}
                    className="opacity-60 hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                    aria-label={`Unlink bug ${b.title}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Link picker */}
          {linkable !== null && linkable.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                value={pickedBugId}
                onChange={(e) => setPickedBugId(e.target.value)}
                className="f-input flex-1 text-xs"
                aria-label="Link an existing bug"
              >
                <option value="">— Link an existing bug… —</option>
                {linkable.map((b) => (
                  <option key={b.id} value={b.id}>
                    [{BUG_SEVERITY_LABELS[b.severity as BugSeverity] ?? b.severity}] {b.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => pickedBugId && void link(pickedBugId)}
                disabled={!pickedBugId || busy}
                className="f-btn f-btn-sm shrink-0"
              >
                <Link2 size={13} /> Link
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
