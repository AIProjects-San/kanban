"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Bug as BugIcon, Plus, Filter, Loader2, ChevronRight,
  ArrowRightLeft, UserPlus, MessageSquare, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { hasPermission, type Role } from "@/lib/rbac";
import {
  BUG_STATUSES, BUG_SEVERITIES, BUG_PRIORITIES,
  BUG_STATUS_LABELS, BUG_STATUS_BADGE, BUG_SEVERITY_LABELS, BUG_SEVERITY_BADGE,
  BUG_PRIORITY_LABELS, BUG_STATUS_TRANSITIONS,
} from "@/lib/config";
import type { BugStatus, BugSeverity, BugPriority, BugResolution } from "@/lib/types";
import { Modal } from "../ui/modal";
import { Field, FormRow } from "../ui/field";
import { Avatar } from "../ui/avatar";
import {
  createBug, getBugsPage, getBug, changeBugStatus,
  assignBug, addBugComment, deleteBug,
} from "@/server-actions/bugs";
import type { ProjectT } from "@/lib/types";

interface BugsViewProps {
  currentUser: { id: string; name: string; email: string; role: string };
  projects: ProjectT[];
}

interface BugListItem {
  id: string;
  title: string;
  severity: string;
  priority: string;
  status: string;
  reporterName: string | null;
  assigneeName: string | null;
  projectName: string | null;
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

export function BugsView({ currentUser, projects }: BugsViewProps) {
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role as Role | undefined;
  const [bugs, setBugs] = useState<BugListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedBugId, setSelectedBugId] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    status: "",
    severity: "",
    priority: "",
    search: "",
  });

  const loadBugs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getBugsPage({
        search: filters.search || undefined,
        status: filters.status || undefined,
        severity: filters.severity || undefined,
        priority: filters.priority || undefined,
        limit: 50,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setBugs(res.data.items);
      setHasMore(res.data.hasMore);
    } catch {
      toast.error("Failed to load bugs");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // Data-loading effect — setState inside loadBugs is the standard fetch pattern.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadBugs(); }, [loadBugs]);

  const canCreate = hasPermission(role, "bug:create");

  return (
    <div className="space-y-5 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <BugIcon className="h-6 w-6 text-red-500" />
            Bugs
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Raise, track, and resolve bugs through their full lifecycle
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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Filter size={14} className="text-muted-foreground" />
        <input
          type="text"
          placeholder="Search bugs…"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          className="f-input flex-1 min-w-[200px]"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          className="f-input"
        >
          <option value="">All statuses</option>
          {BUG_STATUSES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <select
          value={filters.severity}
          onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
          className="f-input"
        >
          <option value="">All severities</option>
          {BUG_SEVERITIES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <select
          value={filters.priority}
          onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
          className="f-input"
        >
          <option value="">All priorities</option>
          {BUG_PRIORITIES.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* Bug list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : bugs.length === 0 ? (
        <div className="text-center py-12">
          <BugIcon className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-sm font-medium text-foreground">No bugs found</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {canCreate ? "Raise your first bug to get started." : "No bugs match the current filters."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {bugs.map((bug) => (
            <button
              key={bug.id}
              onClick={() => setSelectedBugId(bug.id)}
              className="w-full text-left p-4 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${BUG_STATUS_BADGE[bug.status as BugStatus] ?? "bg-muted text-muted-foreground"}`}>
                      {BUG_STATUS_LABELS[bug.status as BugStatus] ?? bug.status}
                    </span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${BUG_SEVERITY_BADGE[bug.severity as BugSeverity] ?? "bg-muted text-muted-foreground"}`}>
                      {BUG_SEVERITY_LABELS[bug.severity as BugSeverity] ?? bug.severity}
                    </span>
                    <span className="text-xs text-muted-foreground">{bug.priority}</span>
                  </div>
                  <h3 className="font-medium text-foreground truncate">{bug.title}</h3>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>Reporter: {bug.reporterName ?? "Unknown"}</span>
                    <span>·</span>
                    <span>Assigned: {bug.assigneeName ?? "Unassigned"}</span>
                    {bug.projectName && (
                      <>
                        <span>·</span>
                        <span>{bug.projectName}</span>
                      </>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </div>
            </button>
          ))}
          {hasMore && (
            <div className="text-center py-3">
              <button onClick={() => void loadBugs()} className="f-btn f-btn-sm">
                Load more
              </button>
            </div>
          )}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateBugModal
          projects={projects}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void loadBugs();
          }}
        />
      )}

      {/* Detail drawer */}
      {selectedBugId && (
        <BugDetailDrawer
          bugId={selectedBugId}
          currentUser={currentUser}
          onClose={() => setSelectedBugId(null)}
          onChanged={() => void loadBugs()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Bug Modal
// ---------------------------------------------------------------------------

function CreateBugModal({
  projects, onClose, onCreated,
}: {
  projects: ProjectT[];
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
  const [projectId, setProjectId] = useState("");
  const [environment, setEnvironment] = useState("");
  const [saving, setSaving] = useState(false);

  const canSubmit = title.trim().length > 0 && !saving;

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
        projectId: projectId || null,
        environment: environment.trim(),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Bug raised", { description: "The bug has been created and is now in the New state." });
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
          <Field label="Linked Project (optional)">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="f-input">
              <option value="">— None —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
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
  bugId, currentUser, onClose, onChanged,
}: {
  bugId: string;
  currentUser: { id: string; name: string; email: string; role: string };
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

        {/* People + project + dates */}
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
            <div className="text-xs text-muted-foreground">Environment</div>
            <div className="font-medium">{bug.environment || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Created</div>
            <div className="font-medium">{new Date(bug.createdAt).toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Updated</div>
            <div className="font-medium">{new Date(bug.updatedAt).toLocaleString()}</div>
          </div>
        </div>

        {/* Assignment panel */}
        {showAssign && canAssign && (
          <AssignPanel
            bugId={bug.id}
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
          <p className="text-xs text-muted-foreground mb-2">Move this bug to its next state</p>
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
// Assign Panel — search users + assign
// ---------------------------------------------------------------------------

function AssignPanel({
  bugId, currentAssigneeId, onAssigned, search, setSearch,
}: {
  bugId: string;
  currentAssigneeId: string | null;
  onAssigned: () => void;
  search: string;
  setSearch: (s: string) => void;
}) {
  const [results, setResults] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [searching, setSearching] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (search.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    // Debounced user search via the existing pagination endpoint.
    const timer = setTimeout(async () => {
      try {
        const { getUsersPage } = await import("@/server-actions/pagination");
        const res = await getUsersPage({ search: search.trim(), limit: 10 });
        if (res.ok) {
          setResults(res.data.items.map((u) => ({ id: u.id, name: u.name, email: u.email })));
        }
      } catch {
        // swallow — the panel just shows no results
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  return (
    <div className="border border-border rounded-md p-3 space-y-2">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search developers by name…"
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
      {searching && (
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 size={12} className="animate-spin" /> Searching…
        </div>
      )}
      {results.length > 0 && (
        <div className="space-y-1 max-h-[200px] overflow-y-auto">
          {results.map((u) => (
            <button
              key={u.id}
              onClick={() => void assign(u.id)}
              className="w-full text-left p-2 rounded hover:bg-accent/50 flex items-center gap-2"
            >
              <Avatar name={u.name} size={24} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{u.name}</div>
                <div className="text-xs text-muted-foreground truncate">{u.email}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
