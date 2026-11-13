"use client";

// ---------------------------------------------------------------------------
// P1 G6 — the promotions surface: the employee's current designation/grade,
// the document list with its lifecycle actions, and the create modal (the
// new designation is required; the grade is the optional second axis). A
// linked Phase 1B salary revision renders read-only (provenance, never
// acted on).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeftRight, Check, Plus, Send, TrendingUp, X, Zap } from "lucide-react";
import {
  createEmployeePromotion,
  submitEmploymentDocument,
  approveEmploymentDocument,
  cancelEmploymentDocument,
  makeEmploymentDocumentEffective,
} from "@/server-actions/hr-employment-docs";
import type { EmployeePromotionT } from "@/lib/types";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface ContextT {
  employee: { id: string; name: string; email: string };
  current: {
    department: string;
    jobTitle: string;
    grade: string;
    location: string;
    managerId: string | null;
    managerName: string | null;
  };
  members: Array<{ id: string; name: string }>;
}

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  PENDING_APPROVAL: "bg-amber-500/10 text-amber-600",
  APPROVED: "bg-blue-500/10 text-blue-600",
  EFFECTIVE: "bg-emerald-500/10 text-emerald-600",
  CANCELLED: "bg-muted text-muted-foreground line-through",
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending approval",
  APPROVED: "Approved",
  EFFECTIVE: "Effective",
  CANCELLED: "Cancelled",
};

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The per-axis change lines. */
function changeLines(p: EmployeePromotionT): string[] {
  const lines: string[] = [`Title: ${p.fromJobTitle ?? "—"} → ${p.toJobTitle}`];
  if (p.toGrade !== null) {
    lines.push(`Grade: ${p.fromGrade ?? "—"} → ${p.toGrade}`);
  }
  return lines;
}

export function EmployeePromotionsView({
  context,
  promotions,
  today,
}: {
  context: ContextT;
  promotions: EmployeePromotionT[];
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<EmployeePromotionT | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  // The create form.
  const [effectiveDate, setEffectiveDate] = useState(tomorrow());
  const [toJobTitle, setToJobTitle] = useState("");
  const [toGrade, setToGrade] = useState("");
  const [reason, setReason] = useState("");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(success);
      router.refresh();
    });
  }

  function submitCreate() {
    startTransition(async () => {
      const res = await createEmployeePromotion({
        employeeId: context.employee.id,
        effectiveDate,
        toJobTitle: toJobTitle.trim(),
        ...(toGrade.trim() ? { toGrade: toGrade.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setOpen(false);
      setToJobTitle("");
      setToGrade("");
      setReason("");
      toast.success("Promotion drafted — submit it for approval when ready.");
      router.refresh();
    });
  }

  const cur = context.current;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href={`/admin/employees/${context.employee.id}/transfers`}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftRight className="h-3 w-3" /> Transfers
            </Link>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Promotions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {context.employee.name} · <span className="text-xs">{context.employee.email}</span>
          </p>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            An approved promotion applies the new designation (and grade) on
            the effective date. A linked salary revision is its own Phase 1B
            document — the link is provenance, never a trigger.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New promotion
        </button>
      </div>

      {/* The current facts the next promotion starts from. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Designation", value: cur.jobTitle || "—" },
          { label: "Grade", value: cur.grade || "—" },
          { label: "Department", value: cur.department || "—" },
          { label: "Manager", value: cur.managerName ?? "—" },
        ].map((f) => (
          <div key={f.label} className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{f.label}</p>
            <p className="mt-1 truncate text-sm font-medium">{f.value}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Effective</th>
              <th className="px-4 py-3 font-medium">Change</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Recorded by</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {promotions.map((p) => (
              <tr key={p.id} className="border-b border-border/60 last:border-0 align-top hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">{p.effectiveDate}</td>
                <td className="px-4 py-3">
                  <div className="space-y-0.5">
                    {changeLines(p).map((line) => (
                      <p key={line} className="text-sm">
                        {line}
                      </p>
                    ))}
                    {p.linkedSalaryAssignmentId && (
                      <p className="text-xs text-muted-foreground">
                        Linked salary revision: {p.linkedSalaryAssignmentId.slice(0, 12)}…
                        (Phase 1B document)
                      </p>
                    )}
                    {p.reason && (
                      <p className="text-xs text-muted-foreground">Reason: {p.reason}</p>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[p.status] ?? "bg-muted"}`}
                  >
                    {STATUS_LABEL[p.status] ?? p.status}
                  </span>
                  {p.status === "APPROVED" && p.effectiveDate > today && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Applies {p.effectiveDate}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {p.createdByName}
                  <span className="block text-[11px] text-muted-foreground/70">
                    {p.createdAt.slice(0, 10)}
                    {p.approvedByName ? ` · approved by ${p.approvedByName}` : ""}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {p.status === "DRAFT" && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => submitEmploymentDocument({ kind: "PROMOTION", id: p.id }),
                            "Promotion submitted for approval.",
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        <Send className="h-3.5 w-3.5" /> Submit
                      </button>
                    )}
                    {p.status === "PENDING_APPROVAL" && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => approveEmploymentDocument({ kind: "PROMOTION", id: p.id }),
                            "Promotion approved — it applies on its effective date.",
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </button>
                    )}
                    {p.status === "APPROVED" && (
                      <button
                        type="button"
                        disabled={pending || p.effectiveDate > today}
                        title={
                          p.effectiveDate > today
                            ? `The effective date (${p.effectiveDate}) has not arrived yet`
                            : undefined
                        }
                        onClick={() =>
                          run(
                            () => makeEmploymentDocumentEffective({ kind: "PROMOTION", id: p.id }),
                            "Promotion is now effective — the facts have been applied.",
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-600/90 disabled:opacity-40"
                      >
                        <Zap className="h-3.5 w-3.5" /> Make effective
                      </button>
                    )}
                    {["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(p.status) && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setCancelReason("");
                          setConfirmCancel(p);
                        }}
                        className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {promotions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No promotions recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* The create modal. */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <TrendingUp className="h-4 w-4" /> New promotion
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
                  Effective date
                </label>
                <input
                  type="date"
                  value={effectiveDate}
                  min={tomorrow()}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                  className={inputCls}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Must be in the future when submitted — the promotion applies on
                  this date.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  New designation <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={toJobTitle}
                  placeholder={cur.jobTitle ? `Currently ${cur.jobTitle}` : "New designation"}
                  onChange={(e) => setToJobTitle(e.target.value)}
                  className={inputCls}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  A promotion must name a new designation — the current one
                  cannot be re-granted.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Grade
                </label>
                <input
                  type="text"
                  value={toGrade}
                  placeholder={cur.grade ? `Currently ${cur.grade}` : "New grade (optional)"}
                  onChange={(e) => setToGrade(e.target.value)}
                  className={inputCls}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Reason
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>

              <p className="rounded-md bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                A salary revision is composed separately on the Salary history
                page (Phase 1B); the promotion and the revision can share an
                effective date without interacting.
              </p>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-9 rounded-md border border-input px-4 text-sm hover:bg-muted"
              >
                Close
              </button>
              <button
                type="button"
                onClick={submitCreate}
                disabled={pending || !effectiveDate || !toJobTitle.trim()}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Draft promotion"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The cancel confirm. */}
      {confirmCancel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg">
            <h2 className="text-base font-semibold">Cancel this promotion?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The promotion effective {confirmCancel.effectiveDate} will be
              cancelled and never apply. This cannot be undone.
            </p>
            <textarea
              placeholder="Reason (optional)"
              rows={2}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="mt-3 w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmCancel(null)}
                className="h-9 rounded-md border border-input px-4 text-sm hover:bg-muted"
              >
                Keep it
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const doc = confirmCancel;
                  setConfirmCancel(null);
                  run(
                    () =>
                      cancelEmploymentDocument({
                        kind: "PROMOTION",
                        id: doc.id,
                        ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {}),
                      }),
                    "Promotion cancelled.",
                  );
                }}
                className="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                Cancel promotion
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
