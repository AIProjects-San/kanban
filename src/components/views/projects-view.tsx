"use client";

import { useState, useMemo } from "react";
import {
  FolderKanban, Plus, Edit3, Trash2, Calendar as CalIcon, X,
} from "lucide-react";
import { cn, barWidthClass } from "@/lib/utils";
import { useApp } from "@/store/app-store";
import { useRefresh } from "@/hooks/use-refresh";
import { usePermissions } from "@/hooks/use-permissions";
import { toast } from "sonner";
import { deleteProject } from "@/server-actions/data";
import { actionErrorMessage } from "@/lib/action-errors";
import { EmptyState } from "../ui/empty-state";
import { FilterBar } from "../ui/filter-bar";
import { PROJECT_STATUSES, PROJECT_STATUS_MAP, priorityClass } from "@/lib/config";
import type { ProjectT, ProjectStatus } from "@/lib/types";

interface ProjectsViewProps {
  projects: ProjectT[];
  tasks: { projectId: string | null; status: string }[];
}

export function ProjectsView({ projects, tasks }: ProjectsViewProps) {
  const { openProjectModal, selectedProjectId, clearSelectedProject } = useApp();
  const refresh = useRefresh();
  const { can } = usePermissions();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProjectStatus>("all");

  const canCreate = can("project:create");
  const canEdit = can("project:edit");
  const canDelete = can("project:delete");

  // PR-58 — sidebar deep-link: opening a project from the Work → Projects
  // submenu filters the grid to that project until cleared. A stale id
  // (project deleted in another tab) simply falls back to "all".
  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (selectedProject && p.id !== selectedProject.id) return false;
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!`${p.name} ${p.description} ${p.ownerName}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [projects, query, statusFilter, selectedProject]);

  const counts = useMemo(() => ({
    total: projects.length,
    running: projects.filter((p) => p.status === "RUNNING").length,
    pending: projects.filter((p) => p.status === "PENDING").length,
    paused: projects.filter((p) => p.status === "PAUSED").length,
    ended: projects.filter((p) => p.status === "ENDED").length,
  }), [projects]);

  async function handleDelete(project: ProjectT) {
    if (!confirm(`Delete project "${project.name}"? This will also delete all tasks in it. This cannot be undone.`)) return;
    try {
      const res = await deleteProject(project.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Project deleted");
      refresh();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to delete project"));
    }
  }

  const filters = [
    { key: "all", label: "All", count: counts.total },
    ...PROJECT_STATUSES.map((s) => ({
      key: s.key,
      label: s.label,
      count: counts[s.key.toLowerCase() as keyof typeof counts] as number,
    })),
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <FolderKanban size={22} className="text-primary" />
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Projects</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {counts.total} projects · {counts.running} running · {counts.ended} ended
          </p>
        </div>
        {canCreate && (
          <button onClick={() => openProjectModal()} className="f-btn f-btn-primary f-btn-sm">
            <Plus size={15} /> New Project
          </button>
        )}
      </div>

      {/* Sidebar deep-link banner — one click to get back to all projects */}
      {selectedProject && (
        <div className="flex items-center justify-between gap-3 f-card px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <FolderKanban size={14} className="text-primary" />
            <span>
              Showing project: <span className="font-semibold">{selectedProject.name}</span>
            </span>
          </div>
          <button
            onClick={clearSelectedProject}
            className="f-btn f-btn-ghost f-btn-sm"
            aria-label="Clear project filter and show all projects"
          >
            <X size={14} /> Show all
          </button>
        </div>
      )}

      {/* Filters */}
      <FilterBar
        filters={filters}
        value={statusFilter}
        onChange={(v) => setStatusFilter(v as "all" | ProjectStatus)}
        search={{ value: query, onChange: setQuery, placeholder: "Search projects…" }}
      />

      {/* Project grid */}
      {filtered.length === 0 ? (
        <div className="f-card">
          <EmptyState
            icon={<FolderKanban size={32} />}
            title={projects.length === 0 ? "No projects yet" : "No projects match your filters"}
            description={projects.length === 0
              ? canCreate
                ? "Create your first project to get started."
                : "Ask an admin or manager to create one."
              : "Try adjusting your search or filters."
            }
            action={canCreate && projects.length === 0 ? (
              <button onClick={() => openProjectModal()} className="f-btn f-btn-primary f-btn-sm">
                <Plus size={14} /> New Project
              </button>
            ) : undefined}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((p) => {
            const style = PROJECT_STATUS_MAP[p.status];
            const projectTasks = tasks.filter((t) => t.projectId === p.id);
            const doneCount = projectTasks.filter((t) => t.status === "DONE").length;
            const due = p.dueDate ? new Date(p.dueDate) : null;
            const overdue = due && due < new Date(new Date().toDateString()) && p.status !== "ENDED";

            return (
              <div
                key={p.id}
                data-testid="project-card"
                className="f-card f-card-hover p-5 flex flex-col cursor-pointer"
                onClick={() => canEdit && openProjectModal(p.id)}
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center text-white text-xs font-bold f-avatar shrink-0", `f-avatar-${p.color}`)}>
                      {p.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground truncate">{p.name}</div>
                      <div className="text-[0.625rem] text-muted-foreground">Owner: {p.ownerName || "—"}</div>
                    </div>
                  </div>
                  <span className={cn("f-badge shrink-0", style.badge)}>
                    <span className={cn("w-1.5 h-1.5 rounded-full mr-1", style.dot)} />
                    {style.label}
                  </span>
                </div>

                {/* Description */}
                {p.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-3 flex-1">{p.description}</p>
                )}
                {!p.description && <div className="flex-1" />}

                {/* Progress */}
                <div className="mb-3">
                  <div className="flex items-center justify-between text-[0.6875rem] text-muted-foreground mb-1">
                    <span>{p.progress}% complete</span>
                    <span>{doneCount}/{projectTasks.length} tasks done</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn("h-full bg-primary rounded-full transition-all", barWidthClass(p.progress))}
                    />
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between pt-3 border-t border-border">
                  <div className="flex items-center gap-2">
                    <span className={cn("f-tag", priorityClass(p.priority))}>{p.priority}</span>
                    {due && (
                      <span className={cn(
                        "flex items-center gap-1 text-[0.625rem]",
                        overdue ? "text-destructive font-medium" : "text-muted-foreground"
                      )}>
                        <CalIcon size={10} />
                        {due.toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                      </span>
                    )}
                  </div>
                  {(canEdit || canDelete) && (
                    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                      {canEdit && (
                        <button
                          onClick={() => openProjectModal(p.id)}
                          className="f-btn f-btn-ghost f-btn-icon h-7 w-7"
                          title="Edit project"
                          aria-label="Edit"
                        >
                          <Edit3 size={13} />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => handleDelete(p)}
                          className="f-btn f-btn-ghost f-btn-icon h-7 w-7 text-destructive"
                          title="Delete project"
                          aria-label="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
