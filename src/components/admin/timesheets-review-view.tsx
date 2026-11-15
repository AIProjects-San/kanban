"use client";

// ---------------------------------------------------------------------------
// G4 — the timesheet review queue (/admin/timesheets, attendance:manage):
// status-filterable list of every timesheet, with the approve / reject
// decision inline (four-eyes is enforced server-side — the employee's own
// sheet shows the decision buttons but the action refuses a self-review)
// and the link into the employee's full sheet.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { BadgeCheck, ClipboardList, FileX, Loader2 } from "lucide-react";
import { decideTimesheet } from "@/server-actions/timesheets";
import type { TimesheetT } from "@/lib/types";
import {
  TIMESHEET_STATUS_BADGE,
  TIMESHEET_STATUS_LABELS,
  TIMESHEET_STATUSES,
} from "@/lib/hr/timesheets";
import { cn } from "@/lib/shared/utils";

const STATUS_FILTERS = ["ALL", ...TIMESHEET_STATUSES] as const;

export function TimesheetsReviewView({
  sheets,
  activeStatus,
}: {
  sheets: TimesheetT[];
  activeStatus: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const decide = (timesheetId: string, decision: "APPROVE" | "REJECT", withReason?: string) => {
    setBusyId(timesheetId);
    startTransition(async () => {
      const res = await decideTimesheet({ timesheetId, decision, reason: withReason });
      setBusyId(null);
      setRejectId(null);
      setReason("");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        decision === "APPROVE"
          ? "Timesheet approved — the hours are payroll-consumable."
          : "Timesheet rejected — it returns to the author as a draft.",
      );
      router.refresh();
    });
  };

  const counts = new Map<string, number>();
  for (const s of sheets) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);

  return (
    <div className="space-y-5" data-testid="timesheets-review-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList size={20} /> Timesheets
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {sheets.length} sheet{sheets.length === 1 ? "" : "s"}
            {activeStatus !== "ALL" ? ` · ${TIMESHEET_STATUS_LABELS[activeStatus as keyof typeof TIMESHEET_STATUS_LABELS] ?? activeStatus}` : ""}
            {" · "}approval is four-eyes: nobody reviews their own hours.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <Link
              key={f}
              href={f === "ALL" ? "/admin/timesheets" : `/admin/timesheets?status=${f}`}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium border",
                activeStatus === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:bg-muted",
              )}
            >
              {f === "ALL" ? "All" : TIMESHEET_STATUS_LABELS[f as keyof typeof TIMESHEET_STATUS_LABELS]?.split(" — ")[0] ?? f}
            </Link>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Employee</th>
              <th className="px-4 py-2.5 font-medium">Period</th>
              <th className="px-4 py-2.5 font-medium text-right">Hours</th>
              <th className="px-4 py-2.5 font-medium text-right">Overtime</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium text-right">Decision</th>
            </tr>
          </thead>
          <tbody>
            {sheets.map((s) => (
              <tr key={s.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5">
                  <Link
                    href={`/admin/employees/${s.employeeId}/timesheets`}
                    className="font-medium hover:underline"
                  >
                    {s.employeeName || s.employeeId}
                  </Link>
                  <span className="block text-xs text-muted-foreground">{s.lineCount} line(s)</span>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {s.periodStart} → {s.periodEnd}
                </td>
                <td className="px-4 py-2.5 text-right font-medium">{s.totalHours.toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">
                  {s.overtimeHours > 0 ? (
                    <span className="text-amber-600">{s.overtimeHours.toFixed(2)} h</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded",
                      TIMESHEET_STATUS_BADGE[s.status as keyof typeof TIMESHEET_STATUS_BADGE] ??
                        "bg-muted text-muted-foreground",
                    )}
                  >
                    {TIMESHEET_STATUS_LABELS[s.status as keyof typeof TIMESHEET_STATUS_LABELS] ?? s.status}
                  </span>
                  {s.status === "REJECTED" && s.rejectReason ? (
                    <span className="block text-xs text-muted-foreground mt-0.5 max-w-56 truncate" title={s.rejectReason}>
                      {s.rejectReason}
                    </span>
                  ) : null}
                  {s.approvedByName ? (
                    <span className="block text-xs text-muted-foreground mt-0.5">by {s.approvedByName}</span>
                  ) : null}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {s.status === "SUBMITTED" ? (
                    rejectId === s.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <input
                          className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-xs"
                          placeholder="Reason for the author…"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                        <button
                          className="f-btn f-btn-ghost text-xs"
                          disabled={pending && busyId === s.id}
                          onClick={() => { setRejectId(null); setReason(""); }}
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          className="f-btn f-btn-primary text-xs"
                          disabled={pending && busyId === s.id}
                          onClick={() => decide(s.id, "REJECT", reason)}
                          type="button"
                          data-testid={`reject-confirm-${s.id}`}
                        >
                          {pending && busyId === s.id ? <Loader2 size={13} className="animate-spin" /> : <FileX size={13} />} Reject
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <button
                          className="f-btn f-btn-ghost text-xs"
                          disabled={pending && busyId === s.id}
                          onClick={() => setRejectId(s.id)}
                          type="button"
                          data-testid={`reject-btn-${s.id}`}
                        >
                          <FileX size={13} /> Reject
                        </button>
                        <button
                          className="f-btn f-btn-primary text-xs"
                          disabled={pending && busyId === s.id}
                          onClick={() => decide(s.id, "APPROVE")}
                          type="button"
                          data-testid={`approve-btn-${s.id}`}
                        >
                          {pending && busyId === s.id ? <Loader2 size={13} className="animate-spin" /> : <BadgeCheck size={13} />} Approve
                        </button>
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {s.status === "LOCKED" ? "Consumed by payroll" : "—"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {sheets.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No timesheets{activeStatus !== "ALL" ? " in this status" : ""} yet — employees draft
                  their hours from their own timesheet page.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
