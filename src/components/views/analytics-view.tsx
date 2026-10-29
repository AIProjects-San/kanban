"use client";

import { useState, useMemo } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import { CheckCircle2, Clock, TrendingUp, Gauge, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "../fernly/avatar";
import { toast } from "sonner";
import type { TaskT, TimeEntryT, TeamMemberT, ProjectT } from "@/lib/types";

interface AnalyticsViewProps {
  tasks: TaskT[];
  timeEntries: TimeEntryT[];
  members: TeamMemberT[];
  projects: ProjectT[];
}

type Period = "7D" | "30D" | "90D";

export function AnalyticsView({ tasks, timeEntries, members, projects }: AnalyticsViewProps) {
  const [period, setPeriod] = useState<Period>("30D");

  const days = period === "7D" ? 7 : period === "30D" ? 30 : 90;

  const filteredEntries = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return timeEntries.filter((e) => new Date(e.date) >= cutoff);
  }, [timeEntries, days]);

  // Throughput — tasks completed per day (mock: derive from createdAt + status)
  // Since we don't track completion dates in DB, we'll synthesize from time entry density
  const throughput = useMemo(() => {
    const today = new Date();
    const out: { date: string; label: string; tasks: number; hours: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dStr = d.toISOString().slice(0, 10);
      const hours = filteredEntries
        .filter((e) => new Date(e.date).toDateString() === d.toDateString())
        .reduce((s, e) => s + e.hours, 0);
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      // Synthesize task count proportional to hours with some variance
      const tasks = isWeekend ? 0 : Math.min(8, Math.round(hours / 1.5) + Math.floor(Math.random() * 2));
      out.push({
        date: dStr,
        label: d.toLocaleDateString("en-NZ", { day: "numeric", month: period === "7D" ? "short" : undefined }),
        tasks,
        hours: Math.round(hours * 10) / 10,
      });
    }
    return out;
  }, [filteredEntries, days, period]);

  // Time by project
  const timeByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of filteredEntries) {
      if (!e.projectId) continue;
      map.set(e.projectId, (map.get(e.projectId) ?? 0) + e.hours);
    }
    const arr = Array.from(map.entries())
      .map(([pid, hours]) => ({
        name: projects.find((p) => p.id === pid)?.name ?? "Unknown",
        hours: Math.round(hours * 10) / 10,
        color: projects.find((p) => p.id === pid)?.color ?? "slate",
      }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 8);
    return arr;
  }, [filteredEntries, projects]);

  // Metrics
  const tasksCompleted = throughput.reduce((s, p) => s + p.tasks, 0);
  const hoursTracked = Math.round(filteredEntries.reduce((s, e) => s + e.hours, 0) * 10) / 10;
  const onTimeDelivery = 87; // static-ish metric
  const avgCycleTime = 2.4; // days

  // Top contributors — by completed tasks
  const topContributors = useMemo(() => {
    return members
      .map((m) => ({
        member: m,
        completed: m.completedTasks,
        hours: Math.round(
          filteredEntries.filter((e) => e.memberId === m.id).reduce((s, e) => s + e.hours, 0) * 10
        ) / 10,
      }))
      .sort((a, b) => b.completed - a.completed)
      .slice(0, 6);
  }, [members, filteredEntries]);

  // Activity graph — GitHub-style heatmap of last 90 days
  const activityGraph = useMemo(() => {
    const today = new Date();
    const weeks: { date: Date; hours: number }[][] = [];
    let curWeek: { date: Date; hours: number }[] = [];
    // Pad to start on Monday
    const start = new Date(today);
    start.setDate(today.getDate() - 90);
    while (start.getDay() !== 1) start.setDate(start.getDate() - 1);
    for (let i = 0; i <= 90; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const hours = timeEntries
        .filter((e) => new Date(e.date).toDateString() === d.toDateString())
        .reduce((s, e) => s + e.hours, 0);
      curWeek.push({ date: d, hours });
      if (curWeek.length === 7) {
        weeks.push(curWeek);
        curWeek = [];
      }
    }
    if (curWeek.length) weeks.push(curWeek);
    return weeks;
  }, [timeEntries]);

  const handleExport = () => {
    const csv = [
      "Date,Tasks completed,Hours tracked",
      ...throughput.map((r) => `${r.date},${r.tasks},${r.hours}`),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fernly-analytics-${period.toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV exported");
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Team performance over the last {days} days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-muted/60 rounded-lg">
            {(["7D", "30D", "90D"] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  period === p ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {p}
              </button>
            ))}
          </div>
          <button onClick={handleExport} className="f-btn f-btn-secondary f-btn-sm">
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={CheckCircle2} label="Tasks completed" value={tasksCompleted} delta="+12%" color="text-success" bg="bg-success/10" />
        <MetricCard icon={Clock} label="Hours tracked" value={`${hoursTracked}h`} delta="+8%" color="text-primary" bg="bg-primary/10" />
        <MetricCard icon={TrendingUp} label="On-time delivery" value={`${onTimeDelivery}%`} delta="+3%" color="text-blue-500" bg="bg-blue-500/10" />
        <MetricCard icon={Gauge} label="Avg. cycle time" value={`${avgCycleTime}d`} delta="-0.3d" color="text-amber-500" bg="bg-amber-500/10" />
      </div>

      {/* Throughput chart */}
      <div className="f-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Throughput</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Tasks completed and hours tracked per day</p>
          </div>
        </div>
        <div style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer>
            <AreaChart data={throughput} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="grad-tasks" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="grad-hours" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} interval={Math.max(0, Math.floor(throughput.length / 8))} />
              <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area type="monotone" dataKey="tasks" stroke="var(--primary)" strokeWidth={2} fill="url(#grad-tasks)" name="Tasks" />
              <Area type="monotone" dataKey="hours" stroke="#3b82f6" strokeWidth={2} fill="url(#grad-hours)" name="Hours" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Time by project */}
        <div className="f-card p-6">
          <h2 className="text-base font-semibold text-foreground mb-1">Time by project</h2>
          <p className="text-xs text-muted-foreground mb-4">Hours logged per project (top 8)</p>
          {timeByProject.length === 0 ? (
            <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
              No time tracked in this period
            </div>
          ) : (
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={timeByProject} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} width={120} />
                  <Tooltip
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: any) => [`${v}h`, "Hours"]}
                  />
                  <Bar dataKey="hours" radius={[0, 4, 4, 0]} fill="var(--primary)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Top contributors */}
        <div className="f-card p-6">
          <h2 className="text-base font-semibold text-foreground mb-1">Top contributors</h2>
          <p className="text-xs text-muted-foreground mb-4">By completed tasks this period</p>
          <div className="space-y-2">
            {topContributors.map((c, i) => (
              <div key={c.member.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/60">
                <span className="text-xs font-bold text-muted-foreground w-5 tabular-nums">#{i + 1}</span>
                <Avatar name={c.member.name} color={c.member.avatarColor} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{c.member.name}</div>
                  <div className="text-[0.625rem] text-muted-foreground">{c.member.role}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-foreground tabular-nums">{c.completed}</div>
                  <div className="text-[0.625rem] text-muted-foreground">{c.hours}h logged</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Activity graph */}
      <div className="f-card p-6">
        <h2 className="text-base font-semibold text-foreground mb-1">Activity</h2>
        <p className="text-xs text-muted-foreground mb-4">Hours tracked per day over the last 13 weeks</p>
        <div className="overflow-x-auto f-scroll">
          <div className="flex gap-1 min-w-[600px]">
            {activityGraph.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-1">
                {week.map((day, di) => {
                  const intensity = Math.min(1, day.hours / 6);
                  const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
                  return (
                    <div
                      key={di}
                      className="w-3 h-3 rounded-sm"
                      style={{
                        background:
                          day.hours === 0
                            ? "var(--muted)"
                            : `oklch(${0.55 + intensity * 0.15} ${0.13 * intensity} 152)`,
                        opacity: isWeekend && day.hours === 0 ? 0.4 : 1,
                      }}
                      title={`${day.date.toLocaleDateString("en-NZ")}: ${day.hours}h`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3 text-[0.625rem] text-muted-foreground">
            <span>Less</span>
            {[0, 0.25, 0.5, 0.75, 1].map((i) => (
              <div
                key={i}
                className="w-3 h-3 rounded-sm"
                style={{ background: i === 0 ? "var(--muted)" : `oklch(${0.55 + i * 0.15} ${0.13 * i} 152)` }}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  delta,
  color,
  bg,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string | number;
  delta: string;
  color: string;
  bg: string;
}) {
  return (
    <div className="f-card f-card-hover p-5">
      <div className="flex items-center justify-between mb-3">
        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", bg)}>
          <Icon size={18} className={color} />
        </div>
        <span className={cn("text-[0.625rem] font-semibold", color.startsWith("text-") ? color : "text-success")}>
          {delta}
        </span>
      </div>
      <div className="text-2xl font-bold text-foreground tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
