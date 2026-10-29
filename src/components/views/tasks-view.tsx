"use client";

import { useState, useMemo } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import { Plus, MoreHorizontal, Calendar as CalIcon, FolderKanban } from "lucide-react";
import { useApp } from "@/store/app-store";
import { Avatar } from "../fernly/avatar";
import { FilterBar } from "../fernly/filter-bar";
import { cn } from "@/lib/utils";
import { TASK_STATUSES, priorityClass, tagClass } from "@/lib/config";
import type { TaskT, TaskStatus, ProjectT, TeamMemberT } from "@/lib/types";
import { moveTask } from "@/server-actions/data";
import { actionErrorMessage } from "@/lib/action-errors";
import { toast } from "sonner";

interface TasksViewProps {
  tasks: TaskT[];
  projects: ProjectT[];
  members: TeamMemberT[];
  currentUser?: { name: string; role: string } | null;
}

type FilterKey = "all" | "mine" | "high" | "due-week";

export function TasksView({ tasks, projects, members, currentUser }: TasksViewProps) {
  const { openTaskModal } = useApp();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  // Project filter: "all" = every project the user can see (already scope-restricted for members)
  const [projectId, setProjectId] = useState<string>("all");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // Resolve "me" from the session instead of a hardcoded name.
  const me = currentUser?.name ?? "";

  const filteredTasks = useMemo(() => {
    const now = new Date();
    const weekFromNow = new Date();
    weekFromNow.setDate(now.getDate() + 7);

    return tasks.filter((t) => {
      if (projectId !== "all" && t.projectId !== projectId) return false;
      if (filter === "mine" && t.assignee?.name !== me) return false;
      if (filter === "high" && t.priority !== "HIGH") return false;
      if (filter === "due-week") {
        if (!t.dueDate) return false;
        const d = new Date(t.dueDate);
        if (d < now || d > weekFromNow) return false;
      }
      return true;
    });
  }, [tasks, filter, projectId, me]);

  const byColumn = (status: TaskStatus) =>
    filteredTasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.order - b.order);

  function onDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string);
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const overId = over.id as string;
    const activeTask = tasks.find((t) => t.id === active.id);
    if (!activeTask) return;

    // Determine target column
    let targetStatus: TaskStatus | null = null;
    if (TASK_STATUSES.some((c) => c.key === overId)) {
      targetStatus = overId as TaskStatus;
    } else {
      // Dropped on a card — use that card's status
      const overTask = tasks.find((t) => t.id === overId);
      if (overTask) targetStatus = overTask.status;
    }
    if (!targetStatus || targetStatus === activeTask.status) return;

    const colTasks = byColumn(targetStatus);
    const newOrder = colTasks.length ? Math.max(...colTasks.map((t) => t.order)) + 1 : 0;
    try {
      const res = await moveTask(activeTask.id, targetStatus, newOrder);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Moved to ${TASK_STATUSES.find((c) => c.key === targetStatus)?.label}`);
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to move task"));
    }
  }

  const filters: { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "mine", label: "My tasks" },
    { key: "high", label: "High priority" },
    { key: "due-week", label: "Due this week" },
  ];

  const activeTask = activeId ? tasks.find((t) => t.id === activeId) : null;
  const selectedProject = projectId !== "all" ? projects.find((p) => p.id === projectId) : null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {filteredTasks.length} of {tasks.length} tasks · Drag cards between columns to update status
          </p>
        </div>
        <button onClick={() => openTaskModal()} className="f-btn f-btn-primary f-btn-sm">
          <Plus size={15} /> New Task
        </button>
      </div>

      {/* Filters + Project picker — same line */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterBar
          filters={filters}
          value={filter}
          onChange={(v) => setFilter(v as FilterKey)}
        />
        {/* Project filter */}
        <div className="flex items-center gap-1 p-1 bg-muted/60 rounded-lg">
          <FolderKanban size={14} className="ml-2 mr-1 text-muted-foreground" />
          <button
            onClick={() => setProjectId("all")}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              projectId === "all"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            All projects
          </button>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="bg-transparent text-xs font-medium text-foreground border-0 outline-none cursor-pointer pr-2 py-1.5 max-w-[180px]"
            aria-label="Filter by project"
          >
            <option value="all">All projects ({projects.length})</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Active project chip */}
      {selectedProject && (
        <div className="inline-flex items-center gap-2 -mt-2 text-xs text-muted-foreground">
          <span className={cn("w-2 h-2 rounded-full f-avatar", `f-avatar-${selectedProject.color}`)} />
          Filtering by <span className="font-medium text-foreground">{selectedProject.name}</span>
          <button
            onClick={() => setProjectId("all")}
            className="text-primary hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      {/* Board */}
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {TASK_STATUSES.map((col) => {
            const colTasks = byColumn(col.key);
            return (
              <Column
                key={col.key}
                column={col}
                tasks={colTasks}
                onEdit={(id) => openTaskModal(id)}
                onAdd={() => openTaskModal(null, col.key)}
              />
            );
          })}
        </div>
        <DragOverlay>
          {activeTask ? <TaskCard task={activeTask} onEdit={() => {}} dragging /> : null}
        </DragOverlay>
      </DndContext>

      {filteredTasks.length === 0 && (
        <div className="f-card p-10 text-center text-sm text-muted-foreground">
          {tasks.length === 0
            ? "No tasks yet. Create one to get started."
            : "No tasks match the current filters."}
        </div>
      )}
    </div>
  );
}

function Column({
  column,
  tasks,
  onEdit,
  onAdd,
}: {
  column: { key: TaskStatus; label: string; accent: string };
  tasks: TaskT[];
  onEdit: (id: string) => void;
  onAdd: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col rounded-xl border bg-card/50 transition-colors min-h-[200px]",
        isOver ? "border-primary bg-primary/5" : "border-border"
      )}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <span className={cn("w-2 h-2 rounded-full", column.accent)} />
          <span className="text-sm font-semibold text-foreground">{column.label}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{tasks.length}</span>
        </div>
        <button
          onClick={onAdd}
          className="f-btn f-btn-ghost f-btn-icon"
          style={{ height: 28, width: 28 }}
          aria-label={`Add to ${column.label}`}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto f-scroll" style={{ maxHeight: "calc(100vh - 320px)" }}>
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onEdit={() => onEdit(task.id)} />
        ))}
        {tasks.length === 0 && (
          <button
            onClick={onAdd}
            className="w-full py-6 text-xs text-muted-foreground hover:text-foreground border-2 border-dashed border-border rounded-lg transition-colors hover:border-primary/30"
          >
            Drop tasks here or click to add
          </button>
        )}
      </div>
    </div>
  );
}

function TaskCard({ task, onEdit, dragging }: { task: TaskT; onEdit: () => void; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  const due = task.dueDate ? new Date(task.dueDate) : null;
  const overdue = due && due < new Date(new Date().toDateString()) && task.status !== "DONE";

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        // Only fire click if not dragging
        if (!isDragging) {
          e.stopPropagation();
          onEdit();
        }
      }}
      className={cn(
        "bg-card border border-border rounded-lg p-3 cursor-grab active:cursor-grabbing transition-shadow hover:shadow-md",
        (isDragging || dragging) && "opacity-40",
        overdue && "border-destructive/40"
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className={cn("f-tag", tagClass(task.tag))}>
          {task.tag}
        </span>
        <span className={cn("f-tag", priorityClass(task.priority))}>
          {task.priority}
        </span>
      </div>
      {task.project && (
        <div className="text-[0.625rem] text-muted-foreground mb-1.5 truncate">
          {task.project.name}
        </div>
      )}
      <div className="text-sm font-medium text-foreground leading-snug mb-3 line-clamp-2">
        {task.title}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {task.assignee && (
            <Avatar name={task.assignee.name} color={task.assignee.avatarColor} size={20} />
          )}
          {due && (
            <span className={cn(
              "flex items-center gap-1 text-[0.625rem]",
              overdue ? "text-destructive font-medium" : "text-muted-foreground"
            )}>
              <CalIcon size={11} />
              {due.toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
            </span>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="opacity-0 group-hover:opacity-100 hover:bg-muted rounded p-0.5"
          aria-label="More"
        >
          <MoreHorizontal size={14} className="text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
