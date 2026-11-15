"use client";

// ---------------------------------------------------------------------------
// G5 — the attendance exception queue (/admin/attendance/exceptions):
// unmatched punches (the manual-override picker), duplicates, and the
// derived missing-OUT / missing-IN days.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, LogIn, LogOut, TriangleAlert, UserCheck, XCircle } from "lucide-react";
import { matchPunchToEmployee, ignorePunch } from "@/server-actions/biometric";
import type { AttendanceExceptionsT, PunchLogItemT } from "@/lib/types";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Section({
  title,
  count,
  icon,
  tone,
  children,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card shadow-sm" data-testid="exception-section">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className={cn("flex h-6 w-6 items-center justify-center rounded-md", tone)}>{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
      </header>
      {children}
    </section>
  );
}

export function AttendanceExceptionsView({
  unmatched,
  duplicates,
  missingOut,
  missingIn,
  employees,
}: AttendanceExceptionsT) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [choices, setChoices] = useState<Record<string, string>>({});

  const match = (punchId: string) => {
    const employeeId = choices[punchId];
    if (!employeeId) {
      toast.error("Pick the employee this punch belongs to.");
      return;
    }
    startTransition(async () => {
      const res = await matchPunchToEmployee({ punchId, employeeId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Punch matched — the attendance record derives on the next reconcile pass.");
      router.refresh();
    });
  };

  const ignore = (punchId: string) => {
    startTransition(async () => {
      const res = await ignorePunch({ punchId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Punch ignored — it stays as evidence but derives no attendance.");
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="biometric-exceptions-view">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <TriangleAlert size={20} /> Attendance exceptions
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          The queue needs a human: unmapped punches (match them below), duplicates, and one-sided days. The last 30
          days of records are scanned.
        </p>
      </div>

      <Section
        title="Unmatched punches — no device-user mapping"
        count={unmatched.length}
        tone="bg-red-500/10 text-red-600"
        icon={<UserCheck size={14} />}
      >
        {unmatched.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Nothing waiting — every punch maps to an employee.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {unmatched.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="unmatched-punch">
                <div className="min-w-44">
                  <p className="text-sm font-medium tabular-nums">
                    {p.day} {p.time} <span className="text-xs text-muted-foreground">({p.direction})</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.deviceName || p.deviceId} · user <span className="font-mono">{p.deviceUserId}</span>
                  </p>
                </div>
                <select
                  className={cn(inputCls, "w-52")}
                  value={choices[p.id] ?? ""}
                  onChange={(e) => setChoices((c) => ({ ...c, [p.id]: e.target.value }))}
                  aria-label={`Employee for punch ${p.id}`}
                >
                  <option value="">This punch belongs to…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    className="f-btn f-btn-primary h-8"
                    type="button"
                    disabled={pending}
                    onClick={() => match(p.id)}
                  >
                    {pending ? <Loader2 size={13} className="animate-spin" /> : <UserCheck size={13} />}
                    Match
                  </button>
                  <button
                    className="f-btn f-btn-ghost h-8"
                    type="button"
                    disabled={pending}
                    onClick={() => ignore(p.id)}
                    title="Ignore this punch"
                  >
                    <XCircle size={13} /> Ignore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Missing OUT punches — an IN with no OUT"
        count={missingOut.length}
        tone="bg-amber-500/10 text-amber-600"
        icon={<LogOut size={14} />}
      >
        {missingOut.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No one-sided days — every IN day has its OUT.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {missingOut.map((d) => (
              <li key={d.recordId} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="missing-out-day">
                <p className="text-sm">
                  <span className="font-medium">{d.employeeName}</span>
                  <span className="text-muted-foreground"> · {d.day} · </span>
                  <span className="tabular-nums">IN {d.inTime ?? "—"} → OUT ?</span>
                </p>
                <span className="ml-auto text-xs text-muted-foreground">
                  correct the mark in the attendance grid
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Missing IN punches — an OUT with no IN"
        count={missingIn.length}
        tone="bg-sky-500/10 text-sky-600"
        icon={<LogIn size={14} />}
      >
        {missingIn.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No one-sided days — every OUT day has its IN.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {missingIn.map((d) => (
              <li key={d.recordId} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="missing-in-day">
                <p className="text-sm">
                  <span className="font-medium">{d.employeeName}</span>
                  <span className="text-muted-foreground"> · {d.day} · </span>
                  <span className="tabular-nums">IN ? → OUT {d.outTime ?? "—"}</span>
                </p>
                <span className="ml-auto text-xs text-muted-foreground">
                  correct the mark in the attendance grid
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Duplicate punches — re-deliveries + double-taps"
        count={duplicates.length}
        tone="bg-violet-500/10 text-violet-600"
        icon={<TriangleAlert size={14} />}
      >
        {duplicates.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No duplicates detected.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {duplicates.map((p: PunchLogItemT) => (
              <li key={p.id} className="px-4 py-3 text-sm" data-testid="duplicate-punch">
                <span className="font-medium">{p.employeeName ?? "unmapped"}</span>
                <span className="text-muted-foreground">
                  {" "}· {p.day} {p.time} · {p.direction} · {p.deviceName || p.deviceId} · user{" "}
                  <span className="font-mono">{p.deviceUserId}</span>
                </span>
                <p className="text-xs text-muted-foreground">
                  collapsed by the reconcile pass — it derives no attendance of its own.
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
