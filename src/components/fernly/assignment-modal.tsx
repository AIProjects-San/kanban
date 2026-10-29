"use client";
import { isActionError, actionErrorMessage } from "@/lib/action-errors";
import { useState, useEffect, useMemo } from "react";
import { Loader2, Check } from "lucide-react";
import { Modal } from "./modal";
import { useApp } from "@/store/app-store";
import {
  getUserProjectAssignments,
  assignUserToProject,
  unassignUserFromProject } from "@/server-actions/data";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface ProjectAssignment {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  project: { id: string; name: string; color: string; status: string };
}

interface AssignmentModalProps {
  /** All projects in the workspace — shown as checkboxes. */
  projects: Array<{ id: string; name: string; color: string; status: string }>;
}

export function AssignmentModal({ projects }: AssignmentModalProps) {
  const { assignmentModalUserId, closeAssignmentModal } = useApp();
  const open = !!assignmentModalUserId;

  return (
    <Modal
      open={open}
      onClose={closeAssignmentModal}
      title="Assign to projects"
      description="Select which projects this user can access"
      size="md"
    >
      {open && assignmentModalUserId && (
        <AssignmentForm key={assignmentModalUserId} userId={assignmentModalUserId} projects={projects} onClose={closeAssignmentModal} />
      )}
    </Modal>
  );
}

function AssignmentForm({
  userId,
  projects,
  onClose,
}: {
  userId: string;
  projects: Array<{ id: string; name: string; color: string; status: string }>;
  onClose: () => void;
}) {
  const { bumpRefresh } = useApp();
  const [assignments, setAssignments] = useState<ProjectAssignment[] | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUserProjectAssignments(userId)
      .then((result) => {
        if (!cancelled) setAssignments(result as ProjectAssignment[]);
      })
      .catch((e) => {
        if (!cancelled) {
          if (isActionError(e)) toast.error(actionErrorMessage(e));
          else toast.error("Failed to load assignments");
          setAssignments([]);
        }
      });
    return () => { cancelled = true; };
  }, [userId]);

  const assignedProjectIds = useMemo(
    () => new Set((assignments ?? []).map((a) => a.projectId)),
    [assignments],
  );

  async function toggle(projectId: string) {
    if (!assignments) return;
    setToggling(projectId);
    try {
      if (assignedProjectIds.has(projectId)) {
        await unassignUserFromProject(userId, projectId);
        setAssignments(assignments.filter((a) => a.projectId !== projectId));
        toast.success("Unassigned");
      } else {
        await assignUserToProject(userId, projectId, "MEMBER");
        const project = projects.find((p) => p.id === projectId);
        if (project) {
          setAssignments([
            ...assignments,
            {
              id: `${userId}-${projectId}`,
              projectId,
              userId,
              role: "MEMBER",
              project,
            },
          ]);
        }
        toast.success("Assigned to project");
      }
      bumpRefresh();
    } catch (e) {
      if (isActionError(e)) toast.error(actionErrorMessage(e));
      else toast.error("Failed to update assignment");
    } finally {
      setToggling(null);
    }
  }

  if (assignments === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Loading assignments…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-md p-3">
        The user will see these projects in their dashboard and tasks view.
        {assignments.length > 0 && (
          <span className="block mt-1 font-medium text-foreground">
            Currently assigned to {assignments.length} {assignments.length === 1 ? "project" : "projects"}.
          </span>
        )}
      </div>

      <div className="max-h-[340px] overflow-y-auto f-scroll space-y-1 -mx-1 px-1">
        {projects.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No projects in the workspace yet.
          </div>
        ) : (
          projects.map((p) => {
            const assigned = assignedProjectIds.has(p.id);
            return (
              <label
                key={p.id}
                className={cn(
                  "flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors",
                  assigned
                    ? "border-primary/40 bg-primary/5"
                    : "border-border hover:bg-muted/40"
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  disabled={toggling === p.id}
                  className={cn(
                    "w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all",
                    assigned
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card",
                    toggling === p.id && "opacity-50"
                  )}
                >
                  {assigned && (toggling === p.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={12} />)}
                </button>
                <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center text-white text-[0.625rem] font-bold f-avatar shrink-0", `f-avatar-${p.color}`)}>
                  {p.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{p.name}</div>
                  <div className="text-[0.625rem] text-muted-foreground">{p.status}</div>
                </div>
                {assigned && (
                  <span className="text-[0.625rem] font-medium text-primary f-badge bg-primary/10">Assigned</span>
                )}
              </label>
            );
          })
        )}
      </div>

      <div className="flex justify-end pt-2">
        <button onClick={onClose} className="f-btn f-btn-primary f-btn-sm">Done</button>
      </div>
    </div>
  );
}
