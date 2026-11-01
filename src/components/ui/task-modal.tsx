"use client";
import { useState, useEffect, useMemo } from "react";
import { Link2, Users, Info } from "lucide-react";
import { Modal } from "./modal";
import { useApp } from "@/store/app-store";
import { useRefresh } from "@/hooks/use-refresh";
import {
  createTask,
  updateTask,
  deleteTask,
  getMyProjects,
  getProjectMembers,
} from "@/server-actions/data";
import { toast } from "sonner";
import { EntityHistorySection } from "./entity-history-section";
import { Field, FormRow } from "./field";
import { FormActions } from "./form-actions";
import { PRIORITIES, TASK_TAGS } from "@/lib/constants";
import { TASK_STATUSES } from "@/lib/config";
import type { TaskT, TaskStatus, TaskTag, Priority, ProjectT, TeamMemberT } from "@/lib/types";

interface TaskModalProps {
  tasks: TaskT[];
  projects: ProjectT[];
  members: TeamMemberT[];
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

export function TaskModal({ tasks, projects, members }: TaskModalProps) {
  const { taskModalOpen, taskModalEditId, taskModalDefaultStatus, closeTaskModal } = useApp();
  const editing = taskModalEditId ? tasks.find((t) => t.id === taskModalEditId) ?? null : null;

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
          allMembers={members}
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
  allMembers,
  onClose,
}: {
  editing: TaskT | null;
  defaultStatus: TaskStatus;
  allProjects: ProjectT[];
  allMembers: TeamMemberT[];
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
      allMembers={allMembers}
      onClose={onClose}
    />
  );
}

function TaskForm({
  editing,
  defaultStatus,
  projects,
  projectsLoading,
  allMembers,
  onClose,
}: {
  editing: TaskT | null;
  defaultStatus: TaskStatus;
  projects: ProjectOption[];
  projectsLoading: boolean;
  allMembers: TeamMemberT[];
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const [title, setTitle] = useState(editing?.title ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(editing?.status ?? defaultStatus);
  const [priority, setPriority] = useState<Priority>(editing?.priority ?? "MEDIUM");
  const [tag, setTag] = useState<TaskTag>(editing?.tag ?? "FRONTEND");
  const [dueDate, setDueDate] = useState(editing?.dueDate ? editing.dueDate.slice(0, 10) : "");
  // null = untouched (derive default); string = user picked explicitly ("" = None)
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState(editing?.assigneeId ?? "");

  const projectId = pickedProjectId ?? (editing ? editing.projectId ?? "" : projects[0]?.id ?? "");

  const submit = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
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
        <Field label="Project">
          <select
            className="f-input"
            value={projectId}
            onChange={(e) => handleProjectChange(e.target.value)}
            disabled={projectsLoading}
          >
            {projectsLoading ? (
              <option value="">Loading projects…</option>
            ) : (
              <>
                <option value="">— None —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </>
            )}
          </select>
          {!projectsLoading && (
            <p className="flex items-center gap-1 text-[0.625rem] text-muted-foreground mt-1">
              <Link2 size={9} />
              {projects.length === 0
                ? "You're not associated with any project yet"
                : `Only projects you own or have tasks in (${projects.length})`}
            </p>
          )}
        </Field>
        {/* AssigneeField remounts whenever projectId changes — fresh fetch of
            allocated members each time, no manual state reset needed. */}
        <AssigneeField
          key={projectId || "none"}
          projectId={projectId}
          allMembers={allMembers}
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
      />

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
 * Assignee dropdown that only lists people allocated to the selected project.
 * Mounts fresh (via `key`) each time the project changes, so the fetch + the
 * loading state are always consistent with the current project.
 *
 * When `projectId` is empty (no project picked) we fall back to the full team
 * list — admin can still create an unassigned placeholder task.
 */
function AssigneeField({
  projectId,
  allMembers,
  currentAssigneeId,
  editingAssignee,
  onAssigneeChange,
}: {
  projectId: string;
  allMembers: TeamMemberT[];
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
    if (!projectId) {
      // No project → full team (admin can still pick anyone for an unassigned task)
      return allMembers.map((m) => ({ id: m.id, name: m.name }));
    }
    if (projectMembers === null) return []; // loading
    const opts: { id: string; name: string; extra?: string }[] = projectMembers.map((m) => ({
      id: m.id,
      name: m.name,
      extra: m.isOwner ? "owner" : undefined,
    }));
    // Preserve the currently-edited assignee if they're not in the project's set
    // (so we don't silently drop the value).
    if (editingAssignee && !opts.some((o) => o.id === editingAssignee.id)) {
      opts.push({ id: editingAssignee.id, name: editingAssignee.name, extra: "current" });
    }
    return opts;
  }, [projectId, projectMembers, allMembers, editingAssignee]);

  const loading = !!projectId && projectMembers === null;

  return (
    <Field label="Assignee">
      <select
        className="f-input"
        value={currentAssigneeId}
        onChange={(e) => onAssigneeChange(e.target.value)}
        disabled={loading}
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
            ? "No one is allocated to this project yet"
            : `${options.length} member${options.length === 1 ? "" : "s"} allocated to this project`}
        </p>
      )}
      {projectId && !loading && options.length === 0 && (
        <p className="flex items-start gap-1 text-[0.625rem] text-warning mt-1">
          <Info size={9} className="mt-0.5 shrink-0" />
          Assign a task to someone first to add them to this project, or change the project.
        </p>
      )}
    </Field>
  );
}
