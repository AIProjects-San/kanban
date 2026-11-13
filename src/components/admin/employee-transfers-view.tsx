"use client";

// ---------------------------------------------------------------------------
// P1 G6 — the transfers surface: the employee's current facts, the document
// list with its lifecycle actions (submit / approve / cancel / make
// effective), and the create modal (destination axes prefilled with the
// current facts as placeholders; the from-side is snapshotted server-side).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeftRight, Check, Plus, Send, TrendingUp, X, Zap } from "lucide-react";
import {
  createEmployeeTransfer,
  submitEmploymentDocument,
  approveEmploymentDocument,
  cancelEmploymentDocument,
  makeEmploymentDocumentEffective,
} from "@/server-actions/hr-employment-docs";
import type { EmployeeTransferT } from "@/lib/types";
import { departmentLabel } from "@/lib/shared/config";

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

const DEPARTMENTS = ["ENGINEERING", "DESIGN", "MARKETING", "MANAGEMENT"];

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The per-axis change lines ("Department: Engineering → Design"). */
function changeLines(t: EmployeeTransferT): string[] {
  const lines: string[] = [];
  if (t.toDepartment !== null) {
    lines.push(
      `Department: ${t.fromDepartment ? departmentLabel(t.fromDepartment) : "—"} → ${departmentLabel(t.toDepartment)}`,
    );
  }
  if (t.toJobTitle !== null) {
    lines.push(`Title: ${t.fromJobTitle ?? "—"} → ${t.toJobTitle}`);
  }
  if (t.toManagerId !== null) {
    const to = t.toManagerId === "" ? "(none)" : t.toManagerName ?? "(none)";
    const from = t.fromManagerName ?? "(none)";
    lines.push(`Manager: ${from} → ${to}`);
  }
  if (t.toLocation !== null) {
    lines.push(`Location: ${t.fromLocation ?? "—"} → ${t.toLocation}`);
  }
  return lines;
}

export function EmployeeTransfersView({
  context,
  transfers,
  today,
}: {
  context: ContextT;
  transfers: EmployeeTransferT[];
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<EmployeeTransferT | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  // The create form (placeholders carry the current facts).
  const [effectiveDate, setEffectiveDate] = useState(tomorrow());
  const [toDepartment, setToDepartment] = useState("");
  const [toJobTitle, setToJobTitle] = useState("");
  const [toManagerId, setToManagerId] = useState("");
  const [toLocation, setToLocation] = useState("");
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
      const res = await createEmployeeTransfer({
        employeeId: context.employee.id,
        effectiveDate,
        ...(toDepartment ? { toDepartment } : {}),
        ...(toJobTitle.trim() ? { toJobTitle: toJobTitle.trim() } : {}),
        ...(toManagerId === "__clear__"
          ? { toManagerId: null }
          : toManagerId
            ? { toManagerId }
            : {}),
        ...(toLocation.trim() ? { toLocation: toLocation.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setOpen(false);
      setToDepartment("");
      setToJobTitle("");
      setToManagerId("");
      setToLocation("");
      setReason("");
      toast.success("Transfer drafted — submit it for approval when ready.");
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
              href={`/admin/employees/${context.employee.id}/promotions`}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <TrendingUp className="h-3 w-3" /> Promotions
            </Link>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Transfers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {context.employee.name} · <span className="text-xs">{context.employee.email}</span>
          </p>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            An approved transfer applies its facts — department, job title,
            reporting manager, location — on the effective date. Nothing moves
            before that.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New transfer
        </button>
      </div>

      {/* The current facts the next transfer starts from. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Department", value: cur.department ? departmentLabel(cur.department) : "—" },
          { label: "Job title", value: cur.jobTitle || "—" },
          { label: "Manager", value: cur.managerName ?? "—" },
          { label: "Location", value: cur.location || "—" },
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
            {transfers.map((t) => (
              <tr key={t.id} className="border-b border-border/60 last:border-0 align-top hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">{t.effectiveDate}</td>
                <td className="px-4 py-3">
                  <div className="space-y-0.5">
                    {changeLines(t).map((line) => (
                      <p key={line} className="text-sm">
                        {line}
                      </p>
                    ))}
                    {t.reason && (
                      <p className="text-xs text-muted-foreground">Reason: {t.reason}</p>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[t.status] ?? "bg-muted"}`}
                  >
                    {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  {t.status === "APPROVED" && t.effectiveDate > today && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Applies {t.effectiveDate}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {t.createdByName}
                  <span className="block text-[11px] text-muted-foreground/70">
                    {t.createdAt.slice(0, 10)}
                    {t.approvedByName ? ` · approved by ${t.approvedByName}` : ""}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {t.status === "DRAFT" && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => submitEmploymentDocument({ kind: "TRANSFER", id: t.id }),
                            "Transfer submitted for approval.",
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        <Send className="h-3.5 w-3.5" /> Submit
                      </button>
                    )}
                    {t.status === "PENDING_APPROVAL" && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => approveEmploymentDocument({ kind: "TRANSFER", id: t.id }),
                            "Transfer approved — it applies on its effective date.",
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </button>
                    )}
                    {t.status === "APPROVED" && (
                      <button
                        type="button"
                        disabled={pending || t.effectiveDate > today}
                        title={
                          t.effectiveDate > today
                            ? `The effective date (${t.effectiveDate}) has not arrived yet`
                            : undefined
                        }
                        onClick={() =>
                          run(
                            () => makeEmploymentDocumentEffective({ kind: "TRANSFER", id: t.id }),
                            "Transfer is now effective — the facts have been applied.",
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-600/90 disabled:opacity-40"
                      >
                        <Zap className="h-3.5 w-3.5" /> Make effective
                      </button>
                    )}
                    {["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(t.status) && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => setConfirmCancel(t)}
                        className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {transfers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No transfers recorded yet.
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
                <ArrowLeftRight className="h-4 w-4" /> New transfer
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
                  Must be in the future when submitted — the transfer applies its
                  facts on this date.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Department
                </label>
                <select
                  value={toDepartment}
                  onChange={(e) => setToDepartment(e.target.value)}
                  className={inputCls}
                >
                  <option value="">Keep current{cur.department ? ` (${departmentLabel(cur.department)})` : ""}</option>
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>
                      {departmentLabel(d)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Job title
                </label>
                <input
                  type="text"
                  value={toJobTitle}
                  placeholder={cur.jobTitle ? `Keep current (${cur.jobTitle})` : "New job title"}
                  onChange={(e) => setToJobTitle(e.target.value)}
                  className={inputCls}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Reporting manager
                </label>
                <select
                  value={toManagerId}
                  onChange={(e) => setToManagerId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">
                    Keep current{cur.managerName ? ` (${cur.managerName})` : ""}
                  </option>
                  <option value="__clear__">(none — clear the reporting line)</option>
                  {context.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Location
                </label>
                <input
                  type="text"
                  value={toLocation}
                  placeholder={cur.location ? `Keep current (${cur.location})` : "New location"}
                  onChange={(e) => setToLocation(e.target.value)}
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
                A transfer must move at least one fact. It drafts first, then
                needs approval by a different pair of eyes before its effective
                date.
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
                disabled={
                  pending ||
                  !effectiveDate ||
                  (!toDepartment && !toJobTitle.trim() && !toManagerId && !toLocation.trim())
                }
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Draft transfer"}
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
            <h2 className="text-base font-semibold">Cancel this transfer?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The transfer effective {confirmCancel.effectiveDate} will be
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
                        kind: "TRANSFER",
                        id: doc.id,
                        ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {}),
                      }),
                    "Transfer cancelled.",
                  );
                }}
                className="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                Cancel transfer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
