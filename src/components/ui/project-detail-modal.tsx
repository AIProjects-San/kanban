"use client";

// ---------------------------------------------------------------------------
// PR-59 — Project detail modal.
//
// Clicking a project card (Projects view + Dashboard "Current Projects") opens
// this read-oriented detail view for EVERY role — previously the click opened
// the raw edit form for editors and did nothing at all for members. Three
// sections, matching the user-approved contract:
//
//   1. Info      — every project field, read-only. "Edit details" (project:edit)
//                  layers the existing ProjectModal on top; saving there
//                  refreshes the server props, which flow back into this modal.
//   2. Members   — the project owner (ownership implies access) + every
//                  explicit assignment (getProjectAssignments — scope-gated
//                  server-side: a MEMBER only reaches this modal for projects
//                  they can see anyway). role:manage users additionally get an
//                  add-member picker + per-row remove; writes go through the
//                  audit-logged assignUserToProject / unassignUserFromProject.
//   3. History   — the reusable EntityHistorySection timeline, collapsed by
//                  default (one click expands + lazy-loads the trail), showing
//                  created / field-level updates / member changes.
//
// Server side this component adds nothing: every action it calls already
// exists, is permission-gated and unit-tested.
// ---------------------------------------------------------------------------

import { useState, useEffect, useMemo } from "react";
import { Loader2, Pencil, UserPlus, X, Crown } from "lucide-react";
import { Modal } from "./modal";
import { Avatar } from "./avatar";
import { EntityHistorySection } from "./entity-history-section";
import { useApp } from "@/store/app-store";
import { usePermissions } from "@/hooks/use-permissions";
import { useRefresh } from "@/hooks/use-refresh";
import {
  getProjectAssignments,
  assignUserToProject,
  unassignUserFromProject,
} from "@/server-actions/data";
import { toast } from "sonner";
import { cn, barWidthClass } from "@/lib/utils";
import { PROJECT_STATUS_MAP, priorityClass } from "@/lib/config";
import type { ProjectT, TeamMemberT } from "@/lib/types";

interface ProjectDetailModalProps {
  projects: ProjectT[];
  members: TeamMemberT[];
  tasks: { projectId: string | null; status: string }[];
}

/** Shape returned by getProjectAssignments (see server-actions/assignments.ts). */
interface AssignmentRow {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  user: { id: string; name: string; email: string; role: string; avatarColor: string };
}

export function ProjectDetailModal({ projects, members, tasks }: ProjectDetailModalProps) {
  const { projectDetailId, closeProjectDetail } = useApp();
  const open = !!projectDetailId;
  const project = open && projectDetailId ? projects.find((p) => p.id === projectDetailId) ?? null : null;

  return (
    <Modal
      open={open}
      onClose={closeProjectDetail}
      title={project ? project.name : "Project"}
      description={project ? "Project details, members and change history" : undefined}
      size="lg"
    >
      {open && projectDetailId && (
        project ? (
          <ProjectDetailBody
            key={projectDetailId}
            project={project}
            members={members}
            tasks={tasks}
          />
        ) : (
          // Stale id — project deleted in another tab / lost access mid-session.
          <div className="py-10 text-center text-sm text-muted-foreground">
            Project not found — it may have been deleted.
          </div>
        )
      )}
    </Modal>
  );
}

function ProjectDetailBody({
  project,
  members,
  tasks,
}: {
  project: ProjectT;
  members: TeamMemberT[];
  tasks: { projectId: string | null; status: string }[];
}) {
  const { openProjectModal, refreshTick } = useApp();
  const refresh = useRefresh();
  const { can } = usePermissions();

  const canEdit = can("project:edit");
  const canManageMembers = can("role:manage");

  // ------------------------------------------------------------------ info
  const style = PROJECT_STATUS_MAP[project.status];
  const projectTasks = tasks.filter((t) => t.projectId === project.id);
  const doneCount = projectTasks.filter((t) => t.status === "DONE").length;
  const due = project.dueDate ? new Date(project.dueDate) : null;
  const overdue = due && due < new Date(new Date().toDateString()) && project.status !== "ENDED";

  // --------------------------------------------------------------- members
  const [assignments, setAssignments] = useState<AssignmentRow[] | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [pickedMemberId, setPickedMemberId] = useState("");

  useEffect(() => {
    let cancelled = false;
    // No setAssignments(null) here: the body is keyed by project id in the
    // parent, so switching projects remounts this component (fresh null
    // state) and this effect only ever loads one project's roster.
    getProjectAssignments(project.id)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setAssignments(result.data);
        else {
          toast.error(result.error);
          setAssignments([]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast.error("Failed to load members");
          setAssignments([]);
        }
      });
    return () => { cancelled = true; };
  }, [project.id]);

  const assignedUserIds = useMemo(
    () => new Set((assignments ?? []).map((a) => a.userId),
    ), [assignments]);

  // Owner first (ownership implies access even without an assignment row),
  // then explicit assignments. A legacy name-only owner (no user account link)
  // still renders — just without account-level controls.
  const rows = useMemo(() => {
    const out: Array<{
      key: string;
      userId: string | null;
      name: string;
      email: string | null;
      avatarColor: string;
      userRole: string;
      assignmentRole: string | null;
      isOwner: boolean;
    }> = [];
    if (project.ownerUserId && !assignedUserIds.has(project.ownerUserId)) {
      const m = members.find((mem) => mem.userId === project.ownerUserId) ?? null;
      out.push({
        key: `owner-${project.ownerUserId}`,
        userId: project.ownerUserId,
        name: m?.name ?? project.ownerName ?? "Owner",
        email: m?.email ?? null,
        avatarColor: m?.avatarColor ?? "forest",
        userRole: m?.role ?? "",
        assignmentRole: null,
        isOwner: true,
      });
    }
    for (const a of assignments ?? []) {
      out.push({
        key: a.id,
        userId: a.userId,
        name: a.user.name,
        email: a.user.email,
        avatarColor: a.user.avatarColor,
        userRole: a.user.role,
        assignmentRole: a.role,
        isOwner: a.userId === project.ownerUserId,
      });
    }
    if (!project.ownerUserId && project.ownerName) {
      out.push({
        key: `owner-legacy-${project.ownerName}`,
        userId: null,
        name: project.ownerName,
        email: null,
        avatarColor: "forest",
        userRole: "",
        assignmentRole: null,
        isOwner: true,
      });
    }
    return out;
  }, [assignments, assignedUserIds, members, project.ownerUserId, project.ownerName]);

  // Candidates for the add picker: roster members with a user account who are
  // neither the owner nor already assigned.
  const candidates = useMemo(
    () =>
      members.filter(
        (m) =>
          m.userId &&
          m.userId !== project.ownerUserId &&
          !assignedUserIds.has(m.userId),
      ),
    [members, project.ownerUserId, assignedUserIds],
  );

  async function handleAdd() {
    const member = candidates.find((m) => m.id === pickedMemberId);
    if (!member?.userId) return;
    setBusyUserId(member.userId);
    try {
      const res = await assignUserToProject(member.userId, project.id, "MEMBER");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${member.name} assigned to ${project.name}`);
      // Optimistic local update; refresh() revalidates the server props.
      setAssignments((prev) => [
        ...(prev ?? []),
        {
          id: `${project.id}-${member.userId}`,
          projectId: project.id,
          userId: member.userId as string,
          role: "MEMBER",
          user: {
            id: member.userId as string,
            name: member.name,
            email: member.email,
            role: member.role,
            avatarColor: member.avatarColor,
          },
        },
      ]);
      setPickedMemberId("");
      refresh();
    } catch {
      toast.error("Failed to assign member");
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleRemove(row: { userId: string; name: string }) {
    setBusyUserId(row.userId);
    try {
      const res = await unassignUserFromProject(row.userId, project.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${row.name} removed from ${project.name}`);
      setAssignments((prev) => (prev ?? []).filter((a) => a.userId !== row.userId));
      refresh();
    } catch {
      toast.error("Failed to remove member");
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------- info */}
      <section aria-label="Project information" className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("f-badge", style.badge)}>
              <span className={cn("w-1.5 h-1.5 rounded-full mr-1", style.dot)} />
              {style.label}
            </span>
            <span className={cn("f-tag", priorityClass(project.priority))}>{project.priority}</span>
            {due && (
              <span className={cn(
                "flex items-center gap-1 text-xs",
                overdue ? "text-destructive font-medium" : "text-muted-foreground",
              )}>
                Due {due.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
                {overdue && " · overdue"}
              </span>
            )}
          </div>
          {canEdit && (
            <button
              onClick={() => openProjectModal(project.id)}
              className="f-btn f-btn-secondary f-btn-sm"
            >
              <Pencil size={13} /> Edit details
            </button>
          )}
        </div>

        {project.description ? (
          <p className="text-sm text-foreground leading-relaxed">{project.description}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">No description yet.</p>
        )}

        {/* Progress */}
        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>{project.progress}% complete</span>
            <span>{doneCount}/{projectTasks.length} tasks done</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className={cn("h-full bg-primary rounded-full transition-all", barWidthClass(project.progress))} />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- members */}
      <section aria-label="Project members" className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">
            Members
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {rows.length} {rows.length === 1 ? "person" : "people"}
            </span>
          </h3>
          {canManageMembers && candidates.length > 0 && (
            <div className="flex items-center gap-1.5">
              <select
                className="f-input f-btn-sm py-1 text-xs w-44"
                value={pickedMemberId}
                onChange={(e) => setPickedMemberId(e.target.value)}
                aria-label="Choose a team member to assign"
              >
                <option value="">Choose member…</option>
                {candidates.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              <button
                onClick={handleAdd}
                disabled={!pickedMemberId || busyUserId !== null}
                className="f-btn f-btn-primary f-btn-sm"
              >
                <UserPlus size={13} /> Add
              </button>
            </div>
          )}
        </div>

        {assignments === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Loading members…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            No members assigned to this project yet.
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((row) => (
              <li key={row.key} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar name={row.name} color={row.avatarColor} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-foreground truncate">{row.name}</span>
                    {row.isOwner && (
                      <span className="flex items-center gap-0.5 text-[0.625rem] font-semibold text-primary">
                        <Crown size={10} /> Owner
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {row.email ?? "No linked account"}
                    {row.assignmentRole && !row.isOwner && (
                      <span className="ml-1.5 uppercase tracking-wide">· {row.assignmentRole}</span>
                    )}
                  </div>
                </div>
                {canManageMembers && !row.isOwner && row.userId && (
                  <button
                    onClick={() => handleRemove({ userId: row.userId as string, name: row.name })}
                    disabled={busyUserId === row.userId}
                    className="f-btn f-btn-ghost f-btn-icon h-7 w-7 text-destructive"
                    title={`Remove ${row.name} from this project`}
                    aria-label={`Remove ${row.name} from this project`}
                  >
                    {busyUserId === row.userId
                      ? <Loader2 size={13} className="animate-spin" />
                      : <X size={13} />}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManageMembers && candidates.length === 0 && assignments !== null && (
          <p className="text-xs text-muted-foreground text-center pt-1">
            Every team member is already assigned to this project.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------- history */}
      {/* Collapsed by default (user request): opening the modal costs no
          audit round trip — the section lazy-loads on first expand.
          Keyed by refreshTick so every mutation (project edit, member
          add/remove) remounts it and re-fetches on the next expand —
          otherwise the lazy-loaded list would stay stale after a change
          made right here in the modal. */}
      <EntityHistorySection
        key={`${project.id}-${refreshTick}`}
        entityType="PROJECT"
        entityId={project.id}
        entityLabel={project.name}
      />
    </div>
  );
}
