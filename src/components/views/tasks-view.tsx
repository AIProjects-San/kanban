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
import { useRefresh } from "@/hooks/use-refresh";
import { Plus, MoreHorizontal, Calendar as CalIcon, FolderKanban, Clock, Bug as BugIcon, GripVertical } from "lucide-react";
import { useApp } from "@/store/app-store";
import { Avatar } from "../ui/avatar";
import { FilterBar } from "../ui/filter-bar";
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

export function TasksView({ tasks, projects, members: _members, currentUser }: TasksViewProps) {
  const { openTaskModal } = useApp();
  const refresh = useRefresh();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  // Optimistic local override applied while a drag is in flight so the card
  // snaps to the new column immediately. Cleared on both success and failure
  // once router.refresh() has been triggered (the refresh is fire-and-forget,
  // but bumpRefresh() remounts the view via the AppShell key, which discards
  // local state — including this override — so the next render uses fresh
  // server props). See L-P0-1 fix and the devil's-advocate review.
  const [optimisticTasks, setOptimisticTasks] = useState<TaskT[] | null>(null);
  // Project filter: "all" = every project the user can see (already scope-restricted for members)
  const [projectId, setProjectId] = useState<string>("all");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // Resolve "me" from the session instead of a hardcoded name.
  const me = currentUser?.name ?? "";

  const liveTasks = optimisticTasks ?? tasks;

  const filteredTasks = useMemo(() => {
    const now = new Date();
    const weekFromNow = new Date();
    weekFromNow.setDate(now.getDate() + 7);

    return liveTasks.filter((t) => {
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
  }, [liveTasks, filter, projectId, me]);

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
    const activeTask = liveTasks.find((t) => t.id === active.id);
    if (!activeTask) return;

    // Determine target column
    let targetStatus: TaskStatus | null = null;
    if (TASK_STATUSES.some((c) => c.key === overId)) {
      targetStatus = overId as TaskStatus;
    } else {
      // Dropped on a card — use that card's status
      const overTask = liveTasks.find((t) => t.id === overId);
      if (overTask) targetStatus = overTask.status;
    }
    if (!targetStatus || targetStatus === activeTask.status) return;

    const colTasks = byColumn(targetStatus);
    const newOrder = colTasks.length ? Math.max(...colTasks.map((t) => t.order)) + 1 : 0;

    // Optimistic update: instantly move the card to the target column so the
    // drag feels responsive. Rolled back if the server action fails.
    setOptimisticTasks((prev) => {
      const base = prev ?? tasks;
      return base.map((t) =>
        t.id === activeTask.id ? { ...t, status: targetStatus!, order: newOrder } : t,
      );
    });

    try {
      const res = await moveTask(activeTask.id, targetStatus, newOrder);
      if (!res.ok) {
        // Roll back the optimistic update on failure.
        setOptimisticTasks(null);
        toast.error(res.error);
        return;
      }
      toast.success(`Moved to ${TASK_STATUSES.find((c) => c.key === targetStatus)?.label}`);
      // L-P0-1 fix: trigger a real server-component refresh so the new state
      // is fetched. The useRefresh hook also bumps the Zustand tick so the
      // AppShell key changes and TasksView remounts with fresh server props
      // (which clears the optimistic override).
      refresh();
      // Clear the optimistic override defensively. If the refresh's new
      // server props haven't landed by the next render, the override still
      // holds the correct value (it matches what we just persisted). If
      // they have landed, this prevents the override from masking any
      // subsequent server-side change.
      setOptimisticTasks(null);
    } catch (e) {
      setOptimisticTasks(null);
      toast.error(actionErrorMessage(e, "Failed to move task"));
    }
  }

  const filters: { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "mine", label: "My tasks" },
    { key: "high", label: "High priority" },
    { key: "due-week", label: "Due this week" },
  ];

  const activeTask = activeId ? liveTasks.find((t) => t.id === activeId) : null;
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
      data-testid="board-column"
      data-status={column.key}
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
  // Board enhancement — required (estimate) vs spent time on the card.
  const estimateHours = task.estimateMinutes ? task.estimateMinutes / 60 : 0;
  const spentHours = task.spentHours ?? 0;
  const showTime = estimateHours > 0 || spentHours > 0;
  const overTime = estimateHours > 0 && spentHours > estimateHours;
  const bugCount = task.bugCount ?? 0;

  return (
    // PR-39 (a11y): the card itself is NO LONGER a role=button control.
    // Spreading dnd-kit's `attributes` here made every card an interactive
    // element CONTAINING interactive elements (the More button, the title
    // button) — axe "nested-interactive" × 41, and screen readers announced
    // a confusing double control. Pointer-drag stays on the card (mouse
    // users drag anywhere, exactly as before); keyboard-drag moved to the
    // explicit grip handle below, which carries the dnd attributes +
    // keyboard listeners. Opening a task by keyboard: the title button.
    <div
      ref={setNodeRef}
      onPointerDown={listeners?.onPointerDown as unknown as React.PointerEventHandler}
      onClick={(e) => {
        // Only fire click if not dragging
        if (!isDragging) {
          e.stopPropagation();
          onEdit();
        }
      }}
      className={cn(
        "group relative bg-card border border-border rounded-lg p-3 cursor-grab active:cursor-grabbing transition-shadow hover:shadow-md",
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
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="block w-full text-left text-sm font-medium text-foreground leading-snug mb-3 line-clamp-2 hover:underline focus-visible:underline"
      >
        {task.title}
      </button>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {task.assignee && (
            <Avatar name={task.assignee.name} color={task.assignee.avatarColor} size={20} />
          )}
          {showTime && (
            <span
              className={cn(
                "flex items-center gap-1 text-[0.625rem] tabular-nums",
                overTime ? "text-destructive font-medium" : "text-muted-foreground",
              )}
              title={overTime ? "Spent exceeds the required estimate" : "Spent / required time"}
            >
              <Clock size={11} />
              {Math.round(spentHours * 10) / 10}h{estimateHours > 0 ? ` / ${Math.round(estimateHours * 10) / 10}h` : ""}
            </span>
          )}
          {bugCount > 0 && (
            <span
              className="flex items-center gap-0.5 text-[0.625rem] tabular-nums text-muted-foreground"
              title={`${bugCount} linked bug${bugCount === 1 ? "" : "s"}`}
            >
              <BugIcon size={11} className="text-red-500/80" />
              {bugCount}
            </span>
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
        <div className="flex items-center gap-0.5">
          {/* PR-39 — the keyboard-drag handle (carries the dnd attributes +
              keyboard activator; pointer drag already bubbles to the card). */}
          <button
            type="button"
            {...attributes}
            onKeyDown={listeners?.onKeyDown as unknown as React.KeyboardEventHandler}
            aria-label={`Drag task ${task.title}`}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-muted rounded p-0.5 cursor-grab"
          >
            <GripVertical size={14} className="text-muted-foreground" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-muted rounded p-0.5"
            aria-label="More"
          >
            <MoreHorizontal size={14} className="text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}
