"use client";

// ---------------------------------------------------------------------------
// Phase 1B (G8) — the salary history timeline + the revision modal.
//
//   Timeline  — every assignment window (fromDate → toDate, null = current)
//               with base / variable (annual), reason, approver and creator.
//   Revision  — fromDate (default today) + base + variable + reason; the
//               server closes the current assignment at fromDate and opens
//               the new one in ONE transaction. Past dates require the
//               explicit backdate tick. A backdated revision surfaces the
//               detected arrears (locked windows paid on the old base).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  CalendarRange,
  History,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { createSalaryRevision } from "@/server-actions/salary-assignments";
import type { SalaryAssignmentT } from "@/lib/types";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const REASON_LABELS: Record<string, string> = {
  HIRE: "Hire",
  REVISION: "Revision",
  PROMOTION: "Promotion",
  TRANSFER: "Transfer",
};

const money = (n: number) =>
  `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const day = (iso: string) => iso.slice(0, 10);

interface HistoryT {
  employee: { id: string; name: string; email: string; jobTitle: string };
  assignments: SalaryAssignmentT[];
}

export function SalaryHistoryView({ history, today }: { history: HistoryT; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const current = history.assignments.find((a) => a.toDate == null);

  // The revision form (prefilled from the current assignment).
  const [fromDate, setFromDate] = useState(today);
  const [base, setBase] = useState(current ? String(current.base) : "");
  const [variable, setVariable] = useState(current ? String(current.variable) : "0");
  const [reason, setReason] = useState<"REVISION" | "PROMOTION" | "TRANSFER">("REVISION");
  const [backdate, setBackdate] = useState(false);
  const isPast = fromDate < today;

  function submit() {
    startTransition(async () => {
      const res = await createSalaryRevision({
        employeeId: history.employee.id,
        fromDate,
        base: Number(base),
        variable: Number(variable),
        reason,
        backdate: isPast ? backdate : undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setOpen(false);
      if (res.data.arrears.length > 0) {
        const total = res.data.arrears.reduce((s, a) => s + a.delta, 0);
        toast.warning(
          `Revision saved — ${res.data.arrears.length} locked period(s) detected in arrears (net ${money(total)}). Posting the adjustment is a later step.`,
          { duration: 8000 },
        );
      } else {
        toast.success("Salary revision saved — the previous assignment was closed and the new one is in force.");
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Salary history</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {history.employee.name}
            {history.employee.jobTitle ? ` — ${history.employee.jobTitle}` : ""} ·{" "}
            <span className="text-xs">{history.employee.email}</span>
          </p>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            The effective-dated assignment timeline: a payroll run pays from the
            assignment in force at its window start, so a revision re-prices
            future windows without rewriting paid history.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!current}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> New revision
        </button>
      </div>

      {!current && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          This employee has no open salary assignment — create a salary
          structure and run the assignment backfill first.
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Effective from</th>
              <th className="px-4 py-3 font-medium">Until</th>
              <th className="px-4 py-3 font-medium text-right">Base (annual)</th>
              <th className="px-4 py-3 font-medium text-right">Variable (annual)</th>
              <th className="px-4 py-3 font-medium">Reason</th>
              <th className="px-4 py-3 font-medium">Recorded by</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {history.assignments.map((a) => (
              <tr key={a.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">{day(a.fromDate)}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {a.toDate ? day(a.toDate) : "— current —"}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">{money(a.base)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {a.variable > 0 ? money(a.variable) : "—"}
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                    {REASON_LABELS[a.reason ?? ""] ?? a.reason ?? "—"}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {a.createdByName}
                  <span className="block text-[11px] text-muted-foreground/70">
                    {day(a.createdAt)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {a.toDate == null ? (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                      in force
                    </span>
                  ) : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      closed
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {history.assignments.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No salary assignments recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <History className="h-4 w-4" /> New salary revision
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Effective from
                </label>
                <input
                  type="date"
                  value={fromDate}
                  min={current ? day(current.fromDate) : undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className={inputCls}
                />
                {current && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Must be after {day(current.fromDate)} (the current assignment's start).
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Base (annual, NZD)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Variable (annual, NZD)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={variable}
                    onChange={(e) => setVariable(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Reason
                </label>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as typeof reason)}
                  className={inputCls}
                >
                  <option value="REVISION">Revision</option>
                  <option value="PROMOTION">Promotion</option>
                  <option value="TRANSFER">Transfer</option>
                </select>
              </div>

              {isPast && (
                <label className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                  <input
                    type="checkbox"
                    checked={backdate}
                    onChange={(e) => setBackdate(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <TriangleAlert className="mr-1 inline h-3.5 w-3.5" />
                    The effective date is in the past — tick to confirm a
                    retroactive revision. Already-locked periods are never
                    rewritten; the gap is surfaced as detected arrears.
                  </span>
                </label>
              )}

              <p className="rounded-md bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                <CalendarRange className="mr-1 inline h-3.5 w-3.5" />
                On submit the current assignment is closed at the effective
                date and the new one opens — one atomic transaction. A changed
                base re-prices the salary structure through a cloned row; paid
                history stays untouched.
              </p>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-9 rounded-md border border-input px-4 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={pending || !fromDate || base === ""}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save revision"}
                <ArrowDownToLine className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
