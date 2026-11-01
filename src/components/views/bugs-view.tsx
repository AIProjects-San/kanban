"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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
import {
  Bug as BugIcon, Plus, Filter, Loader2,
  ArrowRightLeft, UserPlus, MessageSquare, Trash2, Link2, FolderKanban,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { hasPermission, type Role } from "@/lib/rbac";
import {
  BUG_STATUSES, BUG_SEVERITIES, BUG_PRIORITIES,
  BUG_STATUS_LABELS, BUG_STATUS_BADGE, BUG_SEVERITY_LABELS, BUG_SEVERITY_BADGE,
  BUG_PRIORITY_LABELS, BUG_STATUS_TRANSITIONS,
} from "@/lib/config";
import type { BugStatus, BugSeverity, BugPriority, BugResolution, ProjectT, TaskT } from "@/lib/types";
import { Modal } from "../ui/modal";
import { Field, FormRow } from "../ui/field";
import { Avatar } from "../ui/avatar";
import { FilterBar } from "../ui/filter-bar";
import { EntityHistorySection } from "../ui/entity-history-section";
import { cn } from "@/lib/utils";
import {
  createBug, getBug, changeBugStatus, moveBug, linkBugToTask,
  assignBug, addBugComment, deleteBug, getBugBoard,
} from "@/server-actions/bugs";
import { getProjectAssignableUsers } from "@/server-actions/assignments";

interface BugsViewProps {
  currentUser: { id: string; name: string; email: string; role: string };
  projects: ProjectT[];
  tasks: TaskT[];
}

interface BugCardData {
  id: string;
  title: string;
  severity: string;
  priority: string;
  status: string;
  order: number;
  resolution: string | null;
  reporterUserId: string;
  reporterName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BugDetail {
  id: string;
  title: string;
  description: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  severity: string;
  priority: string;
  status: string;
  resolution: string | null;
  reporterUserId: string;
  reporterName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  environment: string;
  createdAt: string;
  updatedAt: string;
  triagedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  comments: Array<{
    id: string;
    authorId: string;
    authorName: string;
    body: string;
    createdAt: string;
  }>;
}

type FilterKey = "all" | "mine" | "unassigned" | "high-severity";

// ---------------------------------------------------------------------------
// BugsView — a kanban board with the same shape and interactions as the Task
// board: drag cards between lifecycle columns (NEW → TRIAGED → IN_PROGRESS →
// IN_REVIEW → RESOLVED → CLOSED, with REOPENED), optimistic moves, and a
// detail drawer for the full lifecycle UI. Lifecycle legality is enforced
// server-side by moveBug (BUG_STATUS_TRANSITIONS) — an illegal drag rolls
// back with a toast explaining the allowed targets.
// ---------------------------------------------------------------------------

export function BugsView({ currentUser, projects, tasks }: BugsViewProps) {
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role as Role | undefined;
  const [bugs, setBugs] = useState<BugCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedBugId, setSelectedBugId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [severity, setSeverity] = useState("");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState("");

  // Drag state + optimistic override (mirrors the Task board).
  const [activeId, setActiveId] = useState<string | null>(null);
  const [optimisticBugs, setOptimisticBugs] = useState<BugCardData[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const loadBoard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getBugBoard();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setBugs(res.data.items);
    } catch {
      toast.error("Failed to load bugs");
    } finally {
      setLoading(false);
    }
  }, []);

  // Data-loading effect — setState inside loadBoard is the standard fetch pattern.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadBoard(); }, [loadBoard]);

  const canCreate = hasPermission(role, "bug:create");

  const liveBugs = optimisticBugs ?? bugs;

  const filteredBugs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return liveBugs.filter((b) => {
      if (severity && b.severity !== severity) return false;
      if (priority && b.priority !== priority) return false;
      if (filter === "mine" && b.assigneeUserId !== currentUser.id) return false;
      if (filter === "unassigned" && b.assigneeUserId) return false;
      if (filter === "high-severity" && b.severity !== "CRITICAL" && b.severity !== "MAJOR") return false;
      if (q && !b.title.toLowerCase().includes(q) && !(b.taskTitle ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [liveBugs, severity, priority, filter, search, currentUser.id]);

  const byColumn = (status: string) =>
    filteredBugs
      .filter((b) => b.status === status)
      .sort((a, b) => a.order - b.order);

  function onDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string);
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const overId = over.id as string;
    const activeBug = liveBugs.find((b) => b.id === active.id);
    if (!activeBug) return;

    // Determine the target column: a column drop uses the column key; a card
    // drop uses that card's status. Same-status drops are no-ops (matching
    // the Task board's behaviour).
    let targetStatus: string | null = null;
    if (BUG_STATUSES.some((c) => c.key === overId)) {
      targetStatus = overId;
    } else {
      const overBug = liveBugs.find((b) => b.id === overId);
      if (overBug) targetStatus = overBug.status;
    }
    if (!targetStatus || targetStatus === activeBug.status) return;

    const colBugs = byColumn(targetStatus);
    const newOrder = colBugs.length ? Math.max(...colBugs.map((b) => b.order)) + 1 : 0;

    // Optimistic move — snaps the card into the target column instantly.
    // Rolled back when moveBug rejects an illegal lifecycle transition.
    setOptimisticBugs((prev) => {
      const base = prev ?? bugs;
      return base.map((b) =>
        b.id === activeBug.id ? { ...b, status: targetStatus!, order: newOrder } : b,
      );
    });

    try {
      const res = await moveBug(activeBug.id, { status: targetStatus, order: newOrder });
      if (!res.ok) {
        setOptimisticBugs(null);
        toast.error(res.error);
        return;
      }
      toast.success(`Moved to ${BUG_STATUS_LABELS[targetStatus as BugStatus]}`);
      setOptimisticBugs(null);
      await loadBoard();
    } catch {
      setOptimisticBugs(null);
      toast.error("Failed to move bug");
    }
  }

  const filters: { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "mine", label: "Assigned to me" },
    { key: "unassigned", label: "Unassigned" },
    { key: "high-severity", label: "Critical + Major" },
  ];

  const activeBug = activeId ? liveBugs.find((b) => b.id === activeId) : null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <BugIcon className="h-6 w-6 text-red-500" />
            Bugs
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {filteredBugs.length} of {bugs.length} bugs · Drag cards between columns to move them through the lifecycle
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="f-btn f-btn-primary f-btn-sm"
          >
            <Plus size={14} /> New Bug
          </button>
        )}
      </div>

      {/* Filters — chips + severity + priority + search */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterBar
          filters={filters}
          value={filter}
          onChange={(v) => setFilter(v as FilterKey)}
        />
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="f-input w-auto shrink-0"
          aria-label="Filter by severity"
        >
          <option value="">All severities</option>
          {BUG_SEVERITIES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="f-input w-auto shrink-0"
          aria-label="Filter by priority"
        >
          <option value="">All priorities</option>
          {BUG_PRIORITIES.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
        <div className="flex items-center gap-1.5 flex-1 min-w-[180px]">
          <Filter size={14} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search bugs or linked tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="f-input w-full"
          />
        </div>
      </div>

      {/* Board — same interaction model as the Task board, with a
          horizontally scrollable flex row because the bug lifecycle has 7
          columns instead of 4. */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : bugs.length === 0 ? (
        <div className="text-center py-12">
          <BugIcon className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-sm font-medium text-foreground">No bugs yet</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {canCreate ? "Raise your first bug to get started." : "Bugs raised by your team will appear here."}
          </p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <div className="flex gap-4 overflow-x-auto f-scroll pb-2">
            {BUG_STATUSES.map((col) => {
              const colBugs = byColumn(col.key);
              return (
                <BugColumn
                  key={col.key}
                  column={col}
                  bugs={colBugs}
                  onOpen={(id) => setSelectedBugId(id)}
                  onAdd={() => setShowCreate(true)}
                />
              );
            })}
          </div>
          <DragOverlay>
            {activeBug ? <BugCard bug={activeBug} dragging /> : null}
          </DragOverlay>
        </DndContext>
      )}

      {filteredBugs.length === 0 && bugs.length > 0 && (
        <div className="f-card p-10 text-center text-sm text-muted-foreground">
          No bugs match the current filters.
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateBugModal
          projects={projects}
          tasks={tasks}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void loadBoard();
          }}
        />
      )}

      {/* Detail drawer */}
      {selectedBugId && (
        <BugDetailDrawer
          bugId={selectedBugId}
          currentUser={currentUser}
          tasks={tasks}
          onClose={() => setSelectedBugId(null)}
          onChanged={() => void loadBoard()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board column — droppable, same visual language as the Task board columns.
// ---------------------------------------------------------------------------

function BugColumn({
  column,
  bugs,
  onOpen,
  onAdd,
}: {
  column: { key: string; label: string; dot: string };
  bugs: BugCardData[];
  onOpen: (id: string) => void;
  onAdd: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key });
  return (
    <div
      ref={setNodeRef}
      data-testid="bug-board-column"
      data-status={column.key}
      className={cn(
        "flex flex-col rounded-xl border bg-card/50 transition-colors min-w-[240px] w-[240px] shrink-0 min-h-[200px]",
        isOver ? "border-primary bg-primary/5" : "border-border"
      )}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <span className={cn("w-2 h-2 rounded-full", column.dot)} />
          <span className="text-sm font-semibold text-foreground">{column.label}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{bugs.length}</span>
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
        {bugs.map((bug) => (
          <BugCard key={bug.id} bug={bug} onOpen={() => onOpen(bug.id)} />
        ))}
        {bugs.length === 0 && (
          <button
            onClick={onAdd}
            className="w-full py-6 text-xs text-muted-foreground hover:text-foreground border-2 border-dashed border-border rounded-lg transition-colors hover:border-primary/30"
          >
            Drop bugs here or click to add
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bug card — draggable. Same interaction as the Task card: drag to move,
// click to open the detail drawer.
// ---------------------------------------------------------------------------

function BugCard({ bug, dragging, onOpen }: { bug: BugCardData; dragging?: boolean; onOpen?: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: bug.id,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        // Only fire click if not dragging.
        if (!isDragging) {
          e.stopPropagation();
          onOpen?.();
        }
      }}
      className={cn(
        "bg-card border border-border rounded-lg p-3 cursor-grab active:cursor-grabbing transition-shadow hover:shadow-md",
        (isDragging || dragging) && "opacity-40"
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className={cn("text-[0.625rem] font-medium px-2 py-0.5 rounded-full", BUG_SEVERITY_BADGE[bug.severity as BugSeverity] ?? "bg-muted text-muted-foreground")}>
          {BUG_SEVERITY_LABELS[bug.severity as BugSeverity] ?? bug.severity}
        </span>
        <span className="text-[0.625rem] text-muted-foreground tabular-nums">{bug.priority}</span>
      </div>
      {bug.projectName && (
        <div className="text-[0.625rem] text-muted-foreground mb-1.5 truncate">
          {bug.projectName}
        </div>
      )}
      <div className="text-sm font-medium text-foreground leading-snug mb-2 line-clamp-2">
        {bug.title}
      </div>
      {bug.taskTitle && (
        <div className="flex items-center gap-1 text-[0.625rem] text-muted-foreground mb-2 truncate">
          <Link2 size={10} className="shrink-0 text-primary/70" />
          <span className="truncate">{bug.taskTitle}</span>
        </div>
      )}
      {bug.resolution && bug.status !== "REOPENED" && (
        <div className="text-[0.625rem] text-muted-foreground mb-2">
          {bug.resolution.replace(/_/g, " ").toLowerCase()}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {bug.assigneeName ? (
            <Avatar name={bug.assigneeName} size={20} />
          ) : (
            <span className="text-[0.625rem] text-muted-foreground">Unassigned</span>
          )}
        </div>
        <span className="text-[0.625rem] text-muted-foreground tabular-nums">
          {new Date(bug.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Bug Modal
// ---------------------------------------------------------------------------

function CreateBugModal({
  projects, tasks, onClose, onCreated,
}: {
  projects: ProjectT[];
  tasks: TaskT[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stepsToReproduce, setStepsToReproduce] = useState("");
  const [expectedBehavior, setExpectedBehavior] = useState("");
  const [actualBehavior, setActualBehavior] = useState("");
  const [severity, setSeverity] = useState<BugSeverity>("MAJOR");
  const [priority, setPriority] = useState<BugPriority>("P2");
  // Project association rule — every bug belongs to a project. Default to
  // the first visible project so the one-field happy path just works.
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [taskId, setTaskId] = useState("");
  const [environment, setEnvironment] = useState("");
  const [saving, setSaving] = useState(false);

  const canSubmit = title.trim().length > 0 && !!projectId && !saving;
  // A linked task must belong to the SAME project (enforced server-side).
  const projectTasks = projectId ? tasks.filter((t) => t.projectId === projectId) : [];

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await createBug({
        title: title.trim(),
        description,
        stepsToReproduce,
        expectedBehavior,
        actualBehavior,
        severity,
        priority,
        projectId,
        taskId: taskId || null,
        environment: environment.trim(),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Bug raised", { description: "The bug has been created on the board." });
      onCreated();
    } catch {
      toast.error("Failed to create bug");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={true} title="Raise a Bug" onClose={onClose} size="lg">
      <div className="space-y-4">
        <Field label="Title *">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Brief summary of the bug"
            className="f-input"
            maxLength={200}
            autoFocus
          />
        </Field>

        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's the bug? When does it happen?"
            className="f-input min-h-[80px]"
            maxLength={10000}
          />
        </Field>

        <FormRow>
          <Field label="Steps to Reproduce">
            <textarea
              value={stepsToReproduce}
              onChange={(e) => setStepsToReproduce(e.target.value)}
              placeholder="1. Go to…&#10;2. Click…&#10;3. See error"
              className="f-input min-h-[80px]"
              maxLength={10000}
            />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Expected Behavior">
            <textarea
              value={expectedBehavior}
              onChange={(e) => setExpectedBehavior(e.target.value)}
              placeholder="What should happen?"
              className="f-input min-h-[60px]"
              maxLength={5000}
            />
          </Field>
          <Field label="Actual Behavior">
            <textarea
              value={actualBehavior}
              onChange={(e) => setActualBehavior(e.target.value)}
              placeholder="What actually happens?"
              className="f-input min-h-[60px]"
              maxLength={5000}
            />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Severity">
            <select value={severity} onChange={(e) => setSeverity(e.target.value as BugSeverity)} className="f-input">
              {BUG_SEVERITIES.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value as BugPriority)} className="f-input">
              {BUG_PRIORITIES.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Project *">
            <select
              value={projectId}
              onChange={(e) => { setProjectId(e.target.value); setTaskId(""); }}
              className="f-input"
              aria-label="Project"
            >
              {/* Disabled placeholder — every bug must belong to a project
                  (enforced server-side too). */}
              <option value="" disabled>— Select a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="flex items-center gap-1 text-[0.625rem] text-muted-foreground mt-1">
              <FolderKanban size={9} />
              {projects.length === 0
                ? "No projects visible to you yet"
                : `Assignees must be users assigned to this project`}
            </p>
          </Field>
          <Field label="Linked Task (optional)">
            <select
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className="f-input"
              disabled={!projectId}
            >
              <option value="">— None —</option>
              {projectTasks.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            <p className="flex items-center gap-1 text-[0.625rem] text-muted-foreground mt-1">
              <Link2 size={9} />
              {projectId
                ? `Tasks in the selected project (${projectTasks.length})`
                : "Pick a project to see its tasks"}
            </p>
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Environment">
            <input
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              placeholder="e.g. Production / Chrome 120 / macOS"
              className="f-input"
              maxLength={500}
            />
          </Field>
        </FormRow>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="f-btn f-btn-sm">Cancel</button>
          <button onClick={submit} disabled={!canSubmit} className="f-btn f-btn-primary f-btn-sm">
            {saving ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><BugIcon size={14} /> Raise Bug</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bug Detail Drawer (full lifecycle UI)
// ---------------------------------------------------------------------------

function BugDetailDrawer({
  bugId, currentUser, tasks, onClose, onChanged,
}: {
  bugId: string;
  currentUser: { id: string; name: string; email: string; role: string };
  tasks: TaskT[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role as Role | undefined;
  const [bug, setBug] = useState<BugDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [showAssign, setShowAssign] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [showTaskLink, setShowTaskLink] = useState(false);

  const loadBug = useCallback(async () => {
    try {
      const res = await getBug(bugId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setBug(res.data);
    } catch {
      toast.error("Failed to load bug");
    } finally {
      setLoading(false);
    }
  }, [bugId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadBug(); }, [loadBug]);

  const canEditAny = hasPermission(role, "bug:edit:any");
  const canAssign = hasPermission(role, "bug:assign");
  const canDelete = hasPermission(role, "bug:delete");
  const canEdit = bug && (canEditAny || bug.reporterUserId === currentUser.id || bug.assigneeUserId === currentUser.id);

  const handleStatusChange = async (newStatus: BugStatus, resolution?: BugResolution, statusComment?: string) => {
    if (!bug) return;
    try {
      const res = await changeBugStatus(bug.id, { status: newStatus, resolution, comment: statusComment });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Bug moved to ${BUG_STATUS_LABELS[newStatus]}`);
      await loadBug();
      onChanged();
    } catch {
      toast.error("Failed to change status");
    }
  };

  const handleComment = async () => {
    if (!bug || !comment.trim()) return;
    try {
      const res = await addBugComment({ bugId: bug.id, body: comment.trim() });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setComment("");
      await loadBug();
    } catch {
      toast.error("Failed to add comment");
    }
  };

  const handleDelete = async () => {
    if (!bug) return;
    if (!confirm(`Delete bug "${bug.title}"? This cannot be undone.`)) return;
    try {
      const res = await deleteBug(bug.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Bug deleted");
      onClose();
      onChanged();
    } catch {
      toast.error("Failed to delete bug");
    }
  };

  const handleLinkTask = async (taskId: string | null) => {
    if (!bug) return;
    try {
      const res = await linkBugToTask(bug.id, { taskId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(taskId ? "Bug linked to task" : "Bug unlinked from task");
      setShowTaskLink(false);
      await loadBug();
      onChanged();
    } catch {
      toast.error("Failed to link bug");
    }
  };

  if (loading) {
    return (
      <Modal open={true} title="Loading bug…" onClose={onClose} size="lg">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </Modal>
    );
  }

  if (!bug) {
    return (
      <Modal open={true} title="Bug not found" onClose={onClose} size="lg">
        <p className="text-sm text-muted-foreground">This bug may have been deleted.</p>
      </Modal>
    );
  }

  const currentStatus = bug.status as BugStatus;
  const allowedTransitions = BUG_STATUS_TRANSITIONS[currentStatus] ?? [];

  return (
    <Modal open={true} title={bug.title} onClose={onClose} size="lg">
      <div className="space-y-5">
        {/* Status + severity + priority badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${BUG_STATUS_BADGE[currentStatus]}`}>
            {BUG_STATUS_LABELS[currentStatus]}
          </span>
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${BUG_SEVERITY_BADGE[bug.severity as BugSeverity] ?? ""}`}>
            {BUG_SEVERITY_LABELS[bug.severity as BugSeverity] ?? bug.severity}
          </span>
          <span className="text-xs text-muted-foreground">{BUG_PRIORITY_LABELS[bug.priority as BugPriority] ?? bug.priority}</span>
          {bug.resolution && (
            <span className="text-xs text-muted-foreground">· {bug.resolution.replace(/_/g, " ").toLowerCase()}</span>
          )}
        </div>

        {/* People + project + linked task + dates */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Reporter</div>
            <div className="font-medium">{bug.reporterName ?? "Unknown"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Assigned to</div>
            <div className="font-medium">
              {bug.assigneeName ?? <span className="text-muted-foreground">Unassigned</span>}
              {canAssign && (
                <button onClick={() => setShowAssign(!showAssign)} className="ml-2 text-xs text-primary hover:underline">
                  {showAssign ? "Cancel" : "Assign"}
                </button>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Project</div>
            <div className="font-medium">{bug.projectName ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Linked task</div>
            <div className="font-medium flex items-center gap-1">
              {bug.taskTitle ? (
                <>
                  <Link2 size={12} className="text-primary/70 shrink-0" />
                  <span className="truncate">{bug.taskTitle}</span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
              {canEdit && (
                <button onClick={() => setShowTaskLink(!showTaskLink)} className="ml-2 text-xs text-primary hover:underline shrink-0">
                  {showTaskLink ? "Cancel" : bug.taskTitle ? "Change" : "Link"}
                </button>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Environment</div>
            <div className="font-medium">{bug.environment || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Created</div>
            <div className="font-medium">{new Date(bug.createdAt).toLocaleString()}</div>
          </div>
        </div>

        {/* Task link panel */}
        {showTaskLink && canEdit && (
          <div className="border border-border rounded-md p-3 space-y-2">
            <div className="text-xs text-muted-foreground">
              Link this bug to a task in the same project for traceability — the task's board card shows its linked bugs.
            </div>
            {bug.taskTitle && (
              <button
                onClick={() => void handleLinkTask(null)}
                className="f-btn f-btn-sm w-full text-muted-foreground"
              >
                <Link2 size={12} /> Unlink from “{bug.taskTitle}”
              </button>
            )}
            <select
              onChange={(e) => e.target.value && void handleLinkTask(e.target.value)}
              className="f-input"
              defaultValue=""
              aria-label="Link to a task"
            >
              <option value="">— Choose a task to link… —</option>
              {/* Project association rule — only tasks in the bug's project
                  are linkable (the server rejects cross-project links). */}
              {tasks
                .filter((t) => bug.projectId && t.projectId === bug.projectId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}{t.project ? ` (${t.project.name})` : ""}
                  </option>
                ))}
            </select>
          </div>
        )}

        {/* Assignment panel */}
        {showAssign && canAssign && (
          <AssignPanel
            bugId={bug.id}
            projectId={bug.projectId}
            currentAssigneeId={bug.assigneeUserId}
            onAssigned={() => { setShowAssign(false); void loadBug(); onChanged(); }}
            search={assigneeSearch}
            setSearch={setAssigneeSearch}
          />
        )}

        {/* Lifecycle transitions */}
        {canEdit && allowedTransitions.length > 0 && (
          <div className="border-t border-border pt-4">
          <div className="flex items-center gap-2 mb-1"><ArrowRightLeft size={14} className="text-muted-foreground" /><h3 className="text-sm font-semibold">Lifecycle</h3></div>
          <p className="text-xs text-muted-foreground mb-2">Move this bug to its next state (or drag its card on the board)</p>
          <div>
            <div className="flex flex-wrap gap-2">
              {allowedTransitions.map((target) => {
                const needsResolution = target === "RESOLVED";
                const handleClick = () => {
                  if (needsResolution) {
                    const resolution = window.prompt(
                      "Resolution (FIXED / WONT_FIX / DUPLICATE / CANNOT_REPRODUCE / WORKS_AS_INTENDED):",
                      "FIXED",
                    ) as BugResolution | null;
                    if (!resolution) return;
                    const comment = window.prompt("Optional comment:") ?? "";
                    void handleStatusChange(target, resolution, comment || undefined);
                  } else {
                    void handleStatusChange(target);
                  }
                };
                return (
                  <button key={target} onClick={handleClick} className="f-btn f-btn-sm">
                    → {BUG_STATUS_LABELS[target]}
                  </button>
                );
              })}
            </div>
          </div>
          </div>
        )}

        {/* Description */}
        {bug.description && (
          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-semibold mb-2">Description</h3>
            <p className="text-sm text-foreground whitespace-pre-wrap">{bug.description}</p>
          </div>
        )}

        {/* Reproduction */}
        {(bug.stepsToReproduce || bug.expectedBehavior || bug.actualBehavior) && (
          <div className="border-t border-border pt-4">
              <h3 className="text-sm font-semibold mb-2">Reproduction</h3>
            <div className="space-y-3">
              {bug.stepsToReproduce && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Steps to Reproduce</div>
                  <pre className="text-sm text-foreground whitespace-pre-wrap font-sans">{bug.stepsToReproduce}</pre>
                </div>
              )}
              {bug.expectedBehavior && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Expected</div>
                  <p className="text-sm text-foreground">{bug.expectedBehavior}</p>
                </div>
              )}
              {bug.actualBehavior && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Actual</div>
                  <p className="text-sm text-foreground">{bug.actualBehavior}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Comments */}
        <div className="border-t border-border pt-4">
          <div className="flex items-center gap-2 mb-3"><MessageSquare size={14} className="text-muted-foreground" /><h3 className="text-sm font-semibold">Comments ({bug.comments.length})</h3></div>
          <div className="space-y-3">
            {bug.comments.length === 0 && (
              <p className="text-sm text-muted-foreground">No comments yet. Start the discussion.</p>
            )}
            {bug.comments.map((c) => (
              <div key={c.id} className="border-l-2 border-border pl-3">
                <div className="flex items-center gap-2 mb-1">
                  <Avatar name={c.authorName || "?"} size={20} />
                  <span className="text-sm font-medium">{c.authorName}</span>
                  <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleString()}</span>
                </div>
                <p className="text-sm text-foreground whitespace-pre-wrap">{c.body}</p>
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a comment…"
                className="f-input flex-1"
                maxLength={5000}
                onKeyDown={(e) => { if (e.key === "Enter" && comment.trim()) void handleComment(); }}
              />
              <button
                onClick={() => void handleComment()}
                disabled={!comment.trim()}
                className="f-btn f-btn-primary f-btn-sm"
              >
                Post
              </button>
            </div>
          </div>
        </div>

        {/* Audit history — full traceability of every bug lifecycle event */}
        <EntityHistorySection
          entityType="BUG"
          entityId={bug.id}
          entityLabel={bug.title}
          title="Bug History & Audit Trail"
        />

        {/* Delete (admin only) */}
        {canDelete && (
          <div className="pt-4 border-t border-border">
            <button
              onClick={() => void handleDelete()}
              className="f-btn f-btn-sm text-destructive border-destructive hover:bg-destructive/10"
            >
              <Trash2 size={14} /> Delete Bug
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Assign Panel — users associated with the bug's project only.
//
// Project association rule: a bug can only be assigned to users staffed on
// its project (ProjectAssignment) or owning it — the same rule assignBug
// enforces server-side. The list is fetched once per project and filtered
// locally as you type.
// ---------------------------------------------------------------------------

function AssignPanel({
  bugId, projectId, currentAssigneeId, onAssigned, search, setSearch,
}: {
  bugId: string;
  projectId: string | null;
  currentAssigneeId: string | null;
  onAssigned: () => void;
  search: string;
  setSearch: (s: string) => void;
}) {
  const [users, setUsers] = useState<Array<{ id: string; name: string; email: string; isOwner: boolean }>>([]);
  const [loading, setLoading] = useState(!!projectId);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!projectId) return; // legacy project-less bug — nothing to fetch
    let cancelled = false;
    setLoading(true);
    getProjectAssignableUsers(projectId)
      .then((result) => {
        if (cancelled) return;
        setUsers(result.ok ? result.data : []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const q = search.trim().toLowerCase();
  const results = q
    ? users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    : users;

  const assign = async (userId: string | null) => {
    try {
      const res = await assignBug(bugId, userId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(userId ? "Bug assigned" : "Bug unassigned");
      onAssigned();
    } catch {
      toast.error("Failed to assign bug");
    }
  };

  if (!projectId) {
    return (
      <div className="border border-border rounded-md p-3 space-y-2">
        <p className="text-xs text-warning flex items-start gap-1">
          <UserPlus size={12} className="mt-0.5 shrink-0" />
          This bug has no project yet. Bugs must belong to a project before they can be assigned —
          assignees come from the project team.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-md p-3 space-y-2">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search the project team by name or email…"
        className="f-input"
        autoFocus
      />
      {currentAssigneeId && (
        <button
          onClick={() => void assign(null)}
          className="f-btn f-btn-sm w-full text-muted-foreground"
        >
          <UserPlus size={12} /> Unassign
        </button>
      )}
      {loading && (
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 size={12} className="animate-spin" /> Loading project team…
        </div>
      )}
      {!loading && results.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {users.length === 0
            ? "No users are assigned to this project yet — assign users to the project first (Team → project assignments)."
            : "No one on the project team matches that search."}
        </p>
      )}
      {!loading && results.length > 0 && (
        <div className="space-y-1 max-h-[200px] overflow-y-auto">
          {results.map((u) => (
            <button
              key={u.id}
              onClick={() => void assign(u.id)}
              className="w-full text-left p-2 rounded hover:bg-accent/50 flex items-center gap-2"
            >
              <Avatar name={u.name} size={24} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {u.name}{u.isOwner ? <span className="text-muted-foreground font-normal"> (owner)</span> : null}
                </div>
                <div className="text-xs text-muted-foreground truncate">{u.email}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {!loading && (
        <p className="text-[0.625rem] text-muted-foreground">
          Only users assigned to this project can be bug assignees.
        </p>
      )}
    </div>
  );
}
