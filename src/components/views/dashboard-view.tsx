"use client";

import {
  FolderKanban,
  CheckCircle2,
  Loader2,
  Clock,
  Plus,
  Calendar as CalIcon,
  AlertCircle,
  ArrowRight,
  Play,
  Pause,
  Square,
  Timer,
} from "lucide-react";
import { cn, barWidthClass } from "@/lib/utils";
import { useState, useEffect } from "react";
import { Avatar } from "../ui/avatar";
import { StatCard } from "../ui/stat-card";
import { MyPayslipsCard } from "../ui/my-payslips-card";
import { useApp } from "@/store/app-store";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/use-permissions";
import type { ProjectT, TeamMemberT, ReminderT, TaskT, NotificationT } from "@/lib/types";

interface DashboardViewProps {
  projects: ProjectT[];
  members: TeamMemberT[];
  reminders: ReminderT[];
  tasks: TaskT[];
  notifs: NotificationT[];
  stats: {
    total: number; ended: number; running: number; pending: number; paused: number;
    weeklyCompletion: number; projectEndedPct: number;
  };
  user?: { id?: string; name: string; email: string; avatarColor: string; role: string } | null;
  greeting?: string;
  todayDate?: string;
}

export function DashboardView({ projects, members, reminders, tasks, notifs, stats, user, greeting, todayDate }: DashboardViewProps) {
  const { setView, openTaskModal, openProjectModal, openProjectDetail } = useApp();
  const { can } = usePermissions();

  const hello = greeting ?? "Hello";
  const firstName = user?.name?.split(" ")[0] ?? "there";
  // Stable "today” reference (server-computed in the user's timezone) for
  // overdue comparisons — avoids hydration mismatches from `new Date()`.
  const todayStr = todayDate ?? new Date().toISOString().slice(0, 10);

  const kpis = [
    { label: "Total Projects", value: stats.total, icon: FolderKanban, color: "text-primary", bg: "bg-primary/10" },
    { label: "Ended", value: stats.ended, icon: CheckCircle2, color: "text-success", bg: "bg-success/10" },
    { label: "Running", value: stats.running, icon: Loader2, color: "text-blue-500", bg: "bg-blue-500/10" },
    { label: "Pending", value: stats.pending, icon: Clock, color: "text-warning", bg: "bg-warning/10" },
  ];

  const runningProjects = projects
    .filter((p) => p.status === "RUNNING")
    .slice(0, 5);

  const onlineMembers = members.filter((m) => m.online).slice(0, 6);
  // Display list for the Reminders card (next 4 incomplete, server-sorted
  // by dueDate) — the greeting count above is computed separately and is
  // NOT capped by this slice.
  const upcomingReminders = reminders.filter((r) => !r.completed).slice(0, 4);
  const recentActivity = notifs.slice(0, 4);

  // "You have N open tasks" — the greeting is personal, so count only
  // tasks assigned to the signed-in user. The tasks prop is workspace-wide
  // for admins — counting every member's tasks made the greeting claim the
  // whole workspace's workload ("28 open tasks" when the user has 5).
  const myOpenTasks = tasks.filter(
    (t) => t.status !== "DONE" && user?.id != null && t.assignee?.userId === user.id,
  ).length;
  // "N reminders today" — incomplete reminders due today or overdue (an
  // overdue reminder still needs doing today). Counted from the FULL list,
  // not from upcomingReminders, whose .slice(0, 4) display cap froze the
  // greeting at a maximum of 4 regardless of the real total.
  const remindersToday = reminders.filter(
    (r) => !r.completed && r.dueDate.slice(0, 10) <= todayStr,
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{hello}, {firstName}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            You have {myOpenTasks} open task{myOpenTasks === 1 ? "" : "s"} and{" "}
            {remindersToday} reminder{remindersToday === 1 ? "" : "s"} today.
          </p>
        </div>
        <div className="flex gap-2">
          {can("project:create") && (
            <button onClick={() => openProjectModal()} className="f-btn f-btn-secondary f-btn-sm">
              <Plus size={15} /> Add Project
            </button>
          )}
          {can("task:create") && (
            <button onClick={() => openTaskModal()} className="f-btn f-btn-primary f-btn-sm">
              <Plus size={15} /> New Task
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <StatCard
            key={kpi.label}
            icon={kpi.icon}
            value={kpi.value}
            label={kpi.label}
            iconColor={kpi.color}
            iconBg={kpi.bg}
          />
        ))}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left col — projects + progress */}
        <div className="lg:col-span-2 space-y-6">
          {/* Project Analytics */}
          <div className="f-card p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-base font-semibold text-foreground">Project Analytics</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Weekly completion across active projects</p>
              </div>
              <button
                onClick={() => setView("analytics")}
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                View details <ArrowRight size={12} />
              </button>
            </div>
            <div className="flex items-center gap-6">
              <ProgressRing value={stats.weeklyCompletion} label="Weekly Completion" />
              <div className="flex-1 space-y-3">
                <ProgressBar label="Project Ended" value={stats.projectEndedPct} tone="success" />
                <ProgressBar label="In Progress" value={Math.round((stats.running / Math.max(stats.total, 1)) * 100)} tone="primary" />
                <ProgressBar label="Pending" value={Math.round((stats.pending / Math.max(stats.total, 1)) * 100)} tone="warning" />
              </div>
            </div>
          </div>

          {/* Current Projects */}
          <div className="f-card p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-foreground">Current Projects</h2>
              <button
                onClick={() => setView("projects")}
                className="text-xs text-primary hover:underline"
              >
                See all
              </button>
            </div>
            <div className="space-y-2">
              {runningProjects.map((p) => (
                <div
                  key={p.id}
                  data-testid="project-card"
                  onClick={() => openProjectDetail(p.id)}
                  title="View project details"
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/60 transition-colors cursor-pointer"
                >
                  <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center text-white text-xs font-bold f-avatar", `f-avatar-${p.color}`)}>
                    {p.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{p.name}</div>
                    <div className="text-xs text-muted-foreground">Owner: {p.ownerName}</div>
                  </div>
                  <div className="hidden sm:block w-32">
                    <div className="flex items-center justify-between text-[0.6875rem] text-muted-foreground mb-1">
                      <span>{p.progress}%</span>
                      <span>{p.dueDate ? new Date(p.dueDate).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "—"}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn("h-full bg-primary rounded-full transition-all", barWidthClass(p.progress))}
                      />
                    </div>
                  </div>
                </div>
              ))}
              {runningProjects.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No active projects. Create one to get started.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right col — reminders, time tracker, team */}
        <div className="space-y-6">
          {/* Payslip self-service shortcut (P0-1) — renders only when the
              signed-in user has a finalized payslip. */}
          <MyPayslipsCard />

          {/* Time Tracker */}
          <TimeTracker />

          {/* Reminders */}
          <div className="f-card p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">Reminders</h2>
              <CalIcon size={14} className="text-muted-foreground" />
            </div>
            <div className="space-y-2">
              {upcomingReminders.length === 0 ? (
                <p className="text-xs text-muted-foreground py-3 text-center">All clear!</p>
              ) : (
                upcomingReminders.map((r) => {
                  const due = new Date(r.dueDate);
                  const dueStr = due.toISOString().slice(0, 10);
                  const overdue = dueStr < todayStr;
                  return (
                    <div key={r.id} className="flex items-start gap-2.5 p-2 rounded-md hover:bg-muted/60">
                      <AlertCircle size={14} className={cn("mt-0.5", overdue ? "text-destructive" : "text-warning")} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-foreground">{r.title}</div>
                        <div className="text-[0.625rem] text-muted-foreground">
                          {overdue ? "Overdue · " : ""}
                          {due.toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Team Collaboration */}
          <div className="f-card p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Team Collaboration</h2>
                <p className="text-[0.625rem] text-muted-foreground">{onlineMembers.length} online now</p>
              </div>
              <button
                onClick={() => setView("team")}
                className="text-xs text-primary hover:underline"
              >
                View
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {onlineMembers.map((m) => (
                <Avatar key={m.id} name={m.name} color={m.avatarColor} size={32} online />
              ))}
              {onlineMembers.length === 0 && (
                <p className="text-xs text-muted-foreground">No one online right now.</p>
              )}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="f-card p-5">
            <h2 className="text-sm font-semibold text-foreground mb-3">Recent Activity</h2>
            <div className="space-y-3">
              {recentActivity.map((n) => (
                <div key={n.id} className="flex items-start gap-2.5">
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full mt-1.5 shrink-0",
                    n.type === "WARNING" ? "bg-warning" :
                    n.type === "SUCCESS" ? "bg-success" :
                    n.type === "TASK" ? "bg-primary" :
                    "bg-muted-foreground"
                  )} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground line-clamp-1">{n.title}</div>
                    <div className="text-[0.625rem] text-muted-foreground line-clamp-2">{n.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProgressRing({ value, label }: { value: number; label: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  return (
    <div className="relative w-32 h-32 shrink-0">
      <svg className="w-32 h-32 -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} stroke="var(--muted)" strokeWidth="10" fill="none" />
        <circle
          cx="60" cy="60" r={r}
          className="f-donut-ring"
          stroke="var(--primary)" strokeWidth="10" fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-foreground tabular-nums">{value}%</span>
        <span className="text-[0.625rem] text-muted-foreground mt-0.5 text-center px-2">{label}</span>
      </div>
    </div>
  );
}

// PR-40 — tone is a closed set (backgrounds are static utility classes) and
// the width maps onto the .f-w-0…100 grid; no inline style attributes, so the
// hardened production CSP (style-src 'self') holds on the SSR'd dashboard.
function ProgressBar({ label, value, tone }: { label: string; value: number; tone: "success" | "primary" | "warning" }) {
  const toneClass = {
    success: "bg-success",
    primary: "bg-primary",
    warning: "bg-warning",
  }[tone];
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold text-foreground tabular-nums">{value}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-700", toneClass, barWidthClass(value))}
        />
      </div>
    </div>
  );
}

function TimeTracker() {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds
  const [project] = useState("Halcyon Labs Website");

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const fmt = (n: number) => n.toString().padStart(2, "0");

  return (
    <div className="f-card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Timer size={16} className="text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Time Tracker</h2>
        </div>
        <span className="text-[0.625rem] text-muted-foreground">Today</span>
      </div>
      <div className="text-center py-3">
        <div className="text-3xl font-bold tabular-nums text-foreground">
          {fmt(h)}:{fmt(m)}:{fmt(s)}
        </div>
        <div className="text-xs text-muted-foreground mt-1">{project}</div>
      </div>
      <div className="flex items-center justify-center gap-2">
        {!running ? (
          <button
            onClick={() => { setRunning(true); toast.success("Timer started"); }}
            className="f-btn f-btn-primary f-btn-sm"
          >
            <Play size={14} /> Start
          </button>
        ) : (
          <button
            onClick={() => { setRunning(false); toast.info("Timer paused"); }}
            className="f-btn f-btn-secondary f-btn-sm"
          >
            <Pause size={14} /> Pause
          </button>
        )}
        <button
          onClick={() => {
            if (elapsed > 0) {
              toast.success(`Logged ${fmt(h)}:${fmt(m)}:${fmt(s)} to ${project}`);
              setElapsed(0);
              setRunning(false);
            }
          }}
          className="f-btn f-btn-ghost f-btn-sm"
        >
          <Square size={14} /> Stop & Log
        </button>
      </div>
    </div>
  );
}
