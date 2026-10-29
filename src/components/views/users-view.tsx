"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  UserCog, UserPlus, RefreshCw, Loader2, Mail, Trash2,
  Edit3, FolderKanban, Clock, Plus, Shield, ShieldCheck, ShieldAlert, ShieldX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app-store";
import { toast } from "sonner";
import {
  getAllUsers, deleteUser, getUserProjectAssignments } from "@/server-actions/data";
import { actionErrorMessage } from "@/lib/action-errors";
import {
  type Role,
  ROLE_LABELS, ROLE_DESCRIPTIONS, ALL_PERMISSIONS,
  hasPermission,
} from "@/lib/rbac";
import { Avatar } from "../fernly/avatar";
import { RoleBadge } from "../fernly/role-badge";
import { FilterBar } from "../fernly/filter-bar";
import { Section } from "../fernly/section";

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarColor: string;
  createdAt: string;
  projectCount: number;
  managerId: string | null;
  managerName: string | null;
}

interface ProjectAssignment {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  project: { id: string; name: string; color: string; status: string };
}

interface UsersViewProps {
  currentUser: { id: string; name: string; email: string; role: string };
  projects: Array<{ id: string; name: string; color: string; status: string }>;
}

export function UsersView({ currentUser, projects }: UsersViewProps) {
  const { openUserModal, openAssignmentModal, bumpRefresh } = useApp();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [assignmentsByUser, setAssignmentsByUser] = useState<Record<string, ProjectAssignment[]>>({});
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [loadingAssignments, setLoadingAssignments] = useState<string | null>(null);

  const role = currentUser.role as Role;
  const canManageRoles = hasPermission(role, "role:manage");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAllUsers();
      if (result.ok) setUsers(result.data);
      else toast.error(result.error);
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to load users"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  useEffect(() => {
    if (!expandedUser) return;
    if (assignmentsByUser[expandedUser]) return;
    setLoadingAssignments(expandedUser);
    getUserProjectAssignments(expandedUser)
      .then((result) => {
        setAssignmentsByUser((prev) => ({ ...prev, [expandedUser]: result.ok ? result.data : [] }));
      })
      .catch(() => {
        setAssignmentsByUser((prev) => ({ ...prev, [expandedUser]: [] }));
      })
      .finally(() => setLoadingAssignments(null));
  }, [expandedUser, assignmentsByUser]);

  const filtered = useMemo(() => {
    return users.filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!`${u.name} ${u.email}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [users, query, roleFilter]);

  const counts = useMemo(() => ({
    total: users.length,
    admin: users.filter((u) => u.role === "ADMIN").length,
    manager: users.filter((u) => u.role === "MANAGER").length,
    member: users.filter((u) => u.role === "MEMBER").length,
  }), [users]);

  async function handleDelete(userId: string, name: string) {
    if (userId === currentUser.id) {
      toast.error("You cannot delete your own account");
      return;
    }
    if (!confirm(`Delete user "${name}"? This will also remove all their project assignments. This cannot be undone.`)) return;
    try {
      const res = await deleteUser(userId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("User deleted");
      bumpRefresh();
      await loadUsers();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to delete user"));
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <UserCog size={22} className="text-primary" />
            <h1 className="text-2xl font-bold text-foreground tracking-tight">User Management</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {counts.total} users · {counts.admin} admin · {counts.manager} manager · {counts.member} member
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadUsers} className="f-btn f-btn-ghost f-btn-sm" aria-label="Refresh">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={() => openUserModal()} className="f-btn f-btn-primary f-btn-sm">
            <UserPlus size={15} /> Create user
          </button>
        </div>
      </div>

      {/* Filters */}
      <FilterBar
        filters={[
          { key: "all", label: "All", count: counts.total },
          { key: "ADMIN", label: "Admin", count: counts.admin },
          { key: "MANAGER", label: "Manager", count: counts.manager },
          { key: "MEMBER", label: "Member", count: counts.member },
        ]}
        value={roleFilter}
        onChange={(v) => setRoleFilter(v as "all" | Role)}
        search={{ value: query, onChange: setQuery, placeholder: "Search users…" }}
      />

      {/* User list */}
      <div className="f-card overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading users…
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No users match your filters.
          </div>
        ) : (
          filtered.map((u) => {
            const isExpanded = expandedUser === u.id;
            const userAssignments = assignmentsByUser[u.id];
            const isMe = u.id === currentUser.id;
            return (
              <div key={u.id} className="border-b border-border last:border-0">
                {/* Row */}
                <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/30 transition-colors">
                  <Avatar name={u.name} color={u.avatarColor ?? "forest"} size={40} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{u.name}</span>
                      {isMe && <span className="text-[0.625rem] text-primary">(you)</span>}
                      <RoleBadge role={u.role as Role} icon />
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Mail size={10} /> {u.email}
                      <span className="text-muted-foreground/40 mx-1">·</span>
                      <Clock size={10} /> Joined {new Date(u.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
                    </div>
                    {/* Reporting line — surfaces the org-chart edge so the
                        hierarchy is visible at a glance. "—" = root. */}
                    <div className="text-[0.6875rem] text-muted-foreground flex items-center gap-1 mt-0.5">
                      <span className="text-muted-foreground/60">Reports to:</span>
                      <span className="font-medium text-foreground/80">
                        {u.managerName ?? "— (root)"}
                      </span>
                    </div>
                  </div>

                  {/* Project count + expand */}
                  <button
                    onClick={() => setExpandedUser(isExpanded ? null : u.id)}
                    className="f-btn f-btn-ghost f-btn-sm"
                    title={isExpanded ? "Hide projects" : "Show assigned projects"}
                  >
                    <FolderKanban size={13} />
                    <span className="text-xs">
                      {u.projectCount}{" "}
                      <span className="text-muted-foreground">projects</span>
                    </span>
                  </button>

                  {/* Assign button */}
                  <button
                    onClick={() => openAssignmentModal(u.id)}
                    className="f-btn f-btn-secondary f-btn-sm"
                    title="Assign to projects"
                  >
                    <Plus size={13} /> Assign
                  </button>

                  {/* Edit */}
                  <button
                    onClick={() => openUserModal(u.id)}
                    className="f-btn f-btn-ghost f-btn-icon"
                    title="Edit user"
                    aria-label="Edit"
                  >
                    <Edit3 size={14} />
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => handleDelete(u.id, u.name)}
                    disabled={isMe}
                    className="f-btn f-btn-ghost f-btn-icon text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
                    title={isMe ? "You cannot delete your own account" : "Delete user"}
                    aria-label="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Expanded: project assignments */}
                {isExpanded && (
                  <div className="px-5 pb-4 pt-1 bg-muted/20 f-view-enter">
                    {loadingAssignments === u.id ? (
                      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                        <Loader2 size={12} className="animate-spin" /> Loading projects…
                      </div>
                    ) : userAssignments && userAssignments.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {userAssignments.map((a) => (
                          <span
                            key={a.id}
                            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-card border border-border text-xs"
                          >
                            <span className={cn("w-2 h-2 rounded-full f-avatar", `f-avatar-${a.project.color}`)} />
                            <span className="font-medium text-foreground">{a.project.name}</span>
                            <span className="text-muted-foreground text-[0.625rem]">{a.role.toLowerCase()}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground py-2">
                        Not assigned to any projects yet. Click <span className="font-medium text-foreground">Assign</span> to add some.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Permission matrix — collapsible, on the same page */}
      <Section
        icon={ShieldCheck}
        title="Permission matrix"
        description={`${ALL_PERMISSIONS.length} permissions across ${ROLE_LABELS.ADMIN}, ${ROLE_LABELS.MANAGER}, and ${ROLE_LABELS.MEMBER} roles`}
        collapsible
        defaultOpen={false}
      >
        <div className="overflow-x-auto f-scroll">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  Permission
                </th>
                {(["ADMIN", "MANAGER", "MEMBER"] as Role[]).map((r) => (
                  <th
                    key={r}
                    className={cn(
                      "py-2 px-3 text-center font-medium text-xs uppercase tracking-wider min-w-[90px]",
                      r === role ? "text-primary" : "text-muted-foreground"
                    )}
                  >
                    {ROLE_LABELS[r]}
                    {r === role && <div className="text-[0.625rem] font-normal text-primary mt-0.5">(you)</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ALL_PERMISSIONS.map((perm) => (
                <tr key={perm.key} className="border-b border-border last:border-0">
                  <td className="py-2.5 pr-4">
                    <div className="text-sm font-medium text-foreground">{perm.label}</div>
                    <div className="text-[0.6875rem] text-muted-foreground">{perm.description}</div>
                  </td>
                  {(["ADMIN", "MANAGER", "MEMBER"] as Role[]).map((r) => {
                    const allowed = hasPermission(r, perm.key);
                    return (
                      <td key={r} className="py-2.5 px-3 text-center">
                        {allowed ? (
                          <ShieldCheck size={16} className={cn("inline", r === role ? "text-primary" : "text-success")} />
                        ) : (
                          <ShieldX size={16} className="inline text-muted-foreground/40" />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Helper text */}
      <div className="text-xs text-muted-foreground px-1">
        New users get a login account and a team directory entry in one step. They can sign in immediately
        with the email and password you set. Use <span className="font-medium text-foreground">Assign</span> to
        control which projects each user can see.
      </div>
    </div>
  );
}
