"use client";

import { useState, useMemo } from "react";
import {
  MessageSquare, User, Search, X, Mail, Clock,
  CheckCircle2, Loader2, Calendar, TrendingUp, Send,
} from "lucide-react";
import { Avatar } from "../ui/avatar";
import { cn, barWidthClass } from "@/lib/shared/utils";
import { useRefresh } from "@/hooks/use-refresh";
import { toast } from "sonner";
import { sendMessage } from "@/server-actions/data";
import { actionErrorMessage } from "@/lib/shared/action-result";
import { EntityHistorySection } from "../ui/entity-history-section";
import { TASK_STATUS_ACCENT, tagClass, DEPARTMENT_LABELS } from "@/lib/shared/config";
import type { TeamMemberT, Department, TaskT, ProjectT, TimeEntryT } from "@/lib/types";

interface TeamViewProps {
  members: TeamMemberT[];
  tasks: TaskT[];
  projects: ProjectT[];
  timeEntries: TimeEntryT[];
  currentUser: { name: string; role: string; avatarColor: string };
}

const DEPARTMENTS = [
  { key: "ALL" as const, label: "All" },
  ...DEPARTMENT_LABELS,
];

export function TeamView({ members, tasks, projects, timeEntries, currentUser }: TeamViewProps) {
  const [dept, setDept] = useState<Department | "ALL">("ALL");
  const [query, setQuery] = useState("");
  const [profileMember, setProfileMember] = useState<TeamMemberT | null>(null);
  const [messageMember, setMessageMember] = useState<TeamMemberT | null>(null);

  // The "Add Member" button was removed from this view — team members are
  // created via the Users view, which already enforces role:manage server-side
  // and writes the matching TeamMember row in the same transaction (see
  // server-actions/users.ts createUser). The currentUser.role is still passed
  // through to MemberProfileDrawer / MessageModal for sender attribution.

  const filtered = useMemo(() => {
    return members.filter((m) => {
      if (dept !== "ALL" && m.department !== dept) return false;
      if (query && !`${m.name} ${m.role} ${m.email}`.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [members, dept, query]);

  const onlineCount = members.filter((m) => m.online).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            {onlineCount} online now · {members.length} total members
          </p>
        </div>
      </div>

      {/* Search + filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members…"
            className="f-input pl-8 w-56"
          />
        </div>
        <div className="flex items-center gap-1 p-1 bg-muted/60 rounded-lg">
          {DEPARTMENTS.map((d) => (
            <button
              key={d.key}
              onClick={() => setDept(d.key)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                dept === d.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map((m) => (
          <MemberCard
            key={m.id}
            member={m}
            onProfile={() => setProfileMember(m)}
            onMessage={() => setMessageMember(m)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="col-span-full text-center py-12 text-sm text-muted-foreground">
            No team members match your filters.
          </div>
        )}
      </div>

      {/* Profile Drawer */}
      {profileMember && (
        <ProfileDrawer
          member={profileMember}
          tasks={tasks}
          projects={projects}
          timeEntries={timeEntries}
          onClose={() => setProfileMember(null)}
          onMessage={() => { setMessageMember(profileMember); setProfileMember(null); }}
        />
      )}

      {/* Message Modal */}
      {messageMember && (
        <MessageModal
          member={messageMember}
          currentUser={currentUser}
          onClose={() => setMessageMember(null)}
        />
      )}
    </div>
  );
}

function MemberCard({
  member,
  onProfile,
  onMessage,
}: {
  member: TeamMemberT;
  onProfile: () => void;
  onMessage: () => void;
}) {
  // PR-40 — closed tone set instead of var() strings (static classes, CSP).
  const workloadTone = member.workload >= 80 ? "bg-destructive" :
    member.workload >= 50 ? "bg-warning" :
    "bg-success";

  return (
    <div className="f-card f-card-hover p-5">
      <div className="flex items-start gap-3 mb-4">
        <Avatar name={member.name} color={member.avatarColor} size={48} online={member.online} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">{member.name}</div>
          <div className="text-xs text-muted-foreground truncate">{member.role}</div>
          <div className="text-[0.625rem] text-muted-foreground mt-0.5">{member.department}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-muted/40 rounded-md p-2">
          <div className="text-lg font-bold text-foreground tabular-nums">{member.openTasks}</div>
          <div className="text-[0.625rem] text-muted-foreground">Open tasks</div>
        </div>
        <div className="bg-muted/40 rounded-md p-2">
          <div className="text-lg font-bold text-foreground tabular-nums">{member.completedTasks}</div>
          <div className="text-[0.625rem] text-muted-foreground">Completed</div>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between text-[0.625rem] mb-1.5">
          <span className="text-muted-foreground">Workload</span>
          <span className="font-semibold text-foreground tabular-nums">{member.workload}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", workloadTone, barWidthClass(member.workload))}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onMessage}
          aria-label={`Message ${member.name}`}
          className="f-btn f-btn-secondary f-btn-sm flex-1"
        >
          <MessageSquare size={13} /> Message
        </button>
        <button
          onClick={onProfile}
          className="f-btn f-btn-ghost f-btn-sm flex-1"
        >
          <User size={13} /> Profile
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile Drawer — slides in from the right
// ---------------------------------------------------------------------------

function ProfileDrawer({
  member,
  tasks,
  projects,
  timeEntries,
  onClose,
  onMessage,
}: {
  member: TeamMemberT;
  tasks: TaskT[];
  projects: ProjectT[];
  timeEntries: TimeEntryT[];
  onClose: () => void;
  onMessage: () => void;
}) {
  // Assigned tasks
  const assignedTasks = tasks.filter((t) => t.assigneeId === member.id);
  const openTasks = assignedTasks.filter((t) => t.status !== "DONE");
  const doneTasks = assignedTasks.filter((t) => t.status === "DONE");

  // Time entries (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentEntries = timeEntries
    .filter((e) => e.memberId === member.id && new Date(e.date) >= thirtyDaysAgo)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 8);
  const totalHours = recentEntries.reduce((s, e) => s + e.hours, 0);

  // Hours per project (recent). Keyed by projectId so two missing
  // projects (both rendered as "Unknown") don't collide as duplicate
  // React keys in the breakdown list below.
  const hoursByProject = new Map<string, number>();
  for (const e of recentEntries) {
    if (e.projectId) hoursByProject.set(e.projectId, (hoursByProject.get(e.projectId) ?? 0) + e.hours);
  }
  const projectBreakdown = Array.from(hoursByProject.entries())
    .map(([pid, hours]) => ({
      projectId: pid,
      name: projects.find((p) => p.id === pid)?.name ?? "Unknown",
      hours: Math.round(hours * 10) / 10,
    }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 5);

  const workloadTone = member.workload >= 80 ? "bg-destructive" :
    member.workload >= 50 ? "bg-warning" : "bg-success";

  const deptLabel = member.department.charAt(0) + member.department.slice(1).toLowerCase();

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      {/* Drawer */}
      <aside
        className="fixed top-0 right-0 z-50 h-screen w-full max-w-md bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-300"
        role="dialog"
        aria-label={`${member.name} profile`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Member profile</h2>
          <button onClick={onClose} className="f-btn f-btn-ghost f-btn-icon" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto f-scroll">
          {/* Identity */}
          <div className="p-6 border-b border-border">
            <div className="flex items-start gap-4">
              <Avatar name={member.name} color={member.avatarColor} size={64} online={member.online} />
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold text-foreground">{member.name}</h3>
                <p className="text-sm text-muted-foreground">{member.role}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="f-badge bg-primary/10 text-primary">{deptLabel}</span>
                  {member.online ? (
                    <span className="flex items-center gap-1 text-[0.625rem] text-success font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" /> Online
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[0.625rem] text-muted-foreground">
                      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" /> Offline
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <Mail size={13} />
              <a href={`mailto:${member.email}`} className="hover:text-foreground hover:underline">
                {member.email}
              </a>
            </div>

            <button
              onClick={onMessage}
              className="f-btn f-btn-primary f-btn-sm w-full mt-4"
            >
              <MessageSquare size={14} /> Send message
            </button>
          </div>

          {/* Stats */}
          <div className="p-6 border-b border-border">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Overview</h4>
            <div className="grid grid-cols-3 gap-3">
              <StatBlock icon={Loader2} label="Open" value={member.openTasks} color="text-blue-500" bg="bg-blue-500/10" />
              <StatBlock icon={CheckCircle2} label="Done" value={member.completedTasks} color="text-success" bg="bg-success/10" />
              <StatBlock icon={Clock} label="Hours (30d)" value={Math.round(totalHours)} color="text-primary" bg="bg-primary/10" />
            </div>

            {/* Workload bar */}
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-muted-foreground">Current workload</span>
                <span className="font-semibold text-foreground tabular-nums">{member.workload}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", workloadTone, barWidthClass(member.workload))}
                />
              </div>
              <p className="text-[0.625rem] text-muted-foreground mt-1">
                {member.workload >= 80 ? "At capacity — consider reassigning tasks." :
                 member.workload >= 50 ? "Healthy load with room for more." :
                 "Light load — available for new work."}
              </p>
            </div>
          </div>

          {/* Assigned tasks */}
          <div className="p-6 border-b border-border">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Assigned tasks
              </h4>
              <span className="text-[0.625rem] text-muted-foreground">
                {openTasks.length} open · {doneTasks.length} done
              </span>
            </div>
            {assignedTasks.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No tasks assigned.</p>
            ) : (
              <div className="space-y-2">
                {openTasks.slice(0, 6).map((task) => {
                  const project = projects.find((p) => p.id === task.projectId);
                  const due = task.dueDate ? new Date(task.dueDate) : null;
                  const overdue = due && due < new Date(new Date().toDateString());
                  return (
                    <div key={task.id} className="flex items-center gap-2.5 p-2 rounded-md hover:bg-muted/50">
                      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", TASK_STATUS_ACCENT[task.status])} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-foreground line-clamp-1">{task.title}</div>
                        <div className="flex items-center gap-2 text-[0.625rem] text-muted-foreground mt-0.5">
                          <span className={cn("f-tag", tagClass(task.tag))}>{task.tag}</span>
                          {project && <span className="truncate">{project.name}</span>}
                          {due && (
                            <span className={cn(overdue ? "text-destructive font-medium" : "")}>
                              <Calendar size={9} className="inline mr-0.5" />
                              {due.toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {openTasks.length === 0 && (
                  <p className="text-xs text-success py-2 text-center">All caught up! No open tasks.</p>
                )}
                {openTasks.length > 6 && (
                  <p className="text-[0.625rem] text-muted-foreground text-center pt-1">
                    +{openTasks.length - 6} more open tasks
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Recent time entries */}
          <div className="p-6">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent activity
              </h4>
              <TrendingUp size={13} className="text-muted-foreground" />
            </div>
            {projectBreakdown.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No time logged in the last 30 days.</p>
            ) : (
              <>
                {/* Project breakdown bars */}
                <div className="space-y-2 mb-4">
                  {projectBreakdown.map((p) => {
                    const pct = totalHours > 0 ? Math.round((p.hours / totalHours) * 100) : 0;
                    return (
                      <div key={p.projectId}>
                        <div className="flex items-center justify-between text-[0.6875rem] mb-1">
                          <span className="text-foreground truncate pr-2">{p.name}</span>
                          <span className="text-muted-foreground tabular-nums shrink-0">{p.hours}h · {pct}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className={cn("h-full bg-primary rounded-full", barWidthClass(pct))} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Recent entries list */}
                <div className="space-y-1.5">
                  {recentEntries.slice(0, 5).map((e) => {
                    const project = projects.find((p) => p.id === e.projectId);
                    return (
                      <div key={e.id} className="flex items-center gap-2 text-xs py-1">
                        <span className="text-muted-foreground tabular-nums w-12 shrink-0">
                          {new Date(e.date).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                        </span>
                        <span className="font-medium text-foreground tabular-nums w-10 shrink-0">{e.hours}h</span>
                        <span className="text-muted-foreground truncate flex-1">
                          {project?.name ?? "—"} {e.description && `· ${e.description}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Audit history — expandable timeline of every change to this member */}
          <div className="p-6 pt-0">
            <EntityHistorySection
              entityType="MEMBER"
              entityId={member.id}
              entityLabel={member.name}
            />
          </div>
        </div>
      </aside>
    </>
  );
}

function StatBlock({
  icon: Icon,
  label,
  value,
  color,
  bg,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  return (
    <div className="text-center">
      <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center mx-auto mb-1.5", bg)}>
        <Icon size={15} className={color} />
      </div>
      <div className="text-base font-bold text-foreground tabular-nums">{value}</div>
      <div className="text-[0.625rem] text-muted-foreground">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message Modal — compose a quick message
// ---------------------------------------------------------------------------

function MessageModal({
  member,
  currentUser,
  onClose,
}: {
  member: TeamMemberT;
  currentUser: { name: string; role: string; avatarColor: string };
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!body.trim()) {
      toast.error("Message body is required");
      return;
    }
    setSending(true);
    try {
      // L-P0-2 fix: prefer the stable TeamMember.userId link directly — the
      // email-based lookup returns null for roster entries whose email
      // doesn't match their User account (3 of 12 seed members), which
      // would leave recipientUserId empty and the message invisible to
      // the recipient. The userId link is authoritative.
      const recipientUserId = member.userId ?? undefined;
      const res = await sendMessage({
        memberId: member.id,
        senderName: currentUser.name,
        senderAvatarColor: currentUser.avatarColor,
        senderRole: currentUser.role,
        recipientName: member.name,
        recipientUserId,
        subject: subject.trim() || "(no subject)",
        body: body.trim(),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      refresh();
      toast.success(`Message sent to ${member.name}`, {
        description: subject.trim() || "(no subject)",
      });
      onClose();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to send message"));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-card border border-border rounded-xl shadow-2xl flex flex-col max-h-[90vh]"
        role="dialog"
        aria-label={`Message ${member.name}`}
      >
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <Avatar name={member.name} color={member.avatarColor} size={36} online={member.online} />
            <div>
              <div className="text-sm font-semibold text-foreground">Message {member.name}</div>
              <div className="text-[0.625rem] text-muted-foreground" data-testid="message-recipient">{member.email}</div>
            </div>
          </div>
          <button onClick={onClose} className="f-btn f-btn-ghost f-btn-icon" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto f-scroll">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Subject</label>
            <input
              name="subject"
              className="f-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Quick question about the Atlas project…"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Message</label>
            <textarea
              autoFocus
              className="f-input min-h-[120px] py-2 resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`Hi ${member.name.split(" ")[0]},\n\n…`}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-border">
          <button onClick={onClose} className="f-btn f-btn-ghost f-btn-sm">Cancel</button>
          <button
            onClick={send}
            disabled={sending}
            className="f-btn f-btn-primary f-btn-sm"
          >
            {sending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            {sending ? "Sending…" : "Send message"}
          </button>
        </div>
      </div>
    </>
  );
}
