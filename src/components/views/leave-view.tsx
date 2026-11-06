"use client";

// HR module — Leave self-service view (docs/HR_MODULE_PLAN.md §4).
// Every role sees this: balances per leave type, a request form with a live
// working-day preview, and the caller's own request history with cancel.
// Decision actions live in the HR console (hr-view), not here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "../ui/modal";
import { Field, FormRow } from "../ui/field";
import { LEAVE_STATUS_BADGE, LEAVE_STATUS_LABELS } from "@/lib/config";
import type { LeaveBalanceT, LeaveRequestT, LeaveTypeT, HolidayT } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getMyLeaveData, createLeaveRequest, cancelLeaveRequest } from "@/server-actions/hr-leave";
import { holidayLookupFrom, workingDaysBetween } from "@/lib/working-days";
import { useApp } from "@/store/app-store";

interface CurrentUser {
  id: string;
  name: string;
  role: string;
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

/** Holiday entries inside a range, for the preview's exclusion note. */
function holidaysInRange(
  start: string,
  end: string,
  holidays: HolidayT[],
): HolidayT[] {
  if (!start || !end || end < start) return [];
  return holidays.filter((h) => h.date >= start && h.date <= end);
}

export function LeaveView({ currentUser }: { currentUser: CurrentUser }) {
  const [balances, setBalances] = useState<LeaveBalanceT[]>([]);
  const [requests, setRequests] = useState<LeaveRequestT[]>([]);
  const [types, setTypes] = useState<LeaveTypeT[]>([]);
  const [holidays, setHolidays] = useState<HolidayT[]>([]);
  const [year, setYear] = useState<number>(new Date().getUTCFullYear());
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const { bumpRefresh } = useApp();

  const load = useCallback(async () => {
    const res = await getMyLeaveData();
    if (res.ok) {
      setBalances(res.data.balances);
      setRequests(res.data.requests);
      setTypes(res.data.types);
      setHolidays(res.data.holidays);
      setYear(res.data.year);
    } else {
      toast.error(res.error);
    }
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  if (!loaded) {
    return <div className="p-6 text-sm text-muted-foreground">Loading leave…</div>;
  }

  const pendingCount = requests.filter((r) => r.status === "PENDING").length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <CalendarDays className="h-6 w-6 text-violet-500" />
            Leave
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {currentUser.name} · {year} balances{pendingCount > 0 ? ` · ${pendingCount} request${pendingCount === 1 ? "" : "s"} awaiting a decision` : ""}
          </p>
        </div>
        <button onClick={() => setShowForm(true)} className="f-btn f-btn-primary f-btn-sm">
          <Plus size={14} /> Request Leave
        </button>
      </div>

      {/* Balances */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {balances.map((b) => (
          <div key={b.leaveTypeId} className="f-card p-4 flex items-center gap-3">
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: b.typeColor }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground truncate">{b.typeName}</div>
              <div className="text-[0.6875rem] text-muted-foreground">
                {b.used} used · {b.carriedOver > 0 ? `${b.carriedOver} carried over · ` : ""}{b.entitled} entitled
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-xl font-semibold text-foreground tabular-nums" data-testid="balance-available">{b.available}</div>
              <div className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">days left</div>
            </div>
          </div>
        ))}
        {balances.length === 0 && (
          <div className="f-card p-6 text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">
            No leave types are configured yet — ask HR (or a workspace admin) to add them.
          </div>
        )}
      </div>

      {/* History */}
      <div className="f-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">My requests</h2>
          <span className="text-[0.6875rem] text-muted-foreground">{requests.length} total</span>
        </div>
        {requests.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            You haven&apos;t requested any leave yet. Approved requests appear on the team calendar automatically.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="px-4 py-2 font-semibold">Dates</th>
                <th className="px-4 py-2 font-semibold">Days</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Decision</th>
                <th className="px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: r.typeColor }} aria-hidden />
                      {r.typeName}
                    </span>
                    {r.reason && (
                      <div className="text-[0.6875rem] text-muted-foreground mt-0.5 max-w-48 truncate" title={r.reason}>
                        “{r.reason}”
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {fmtDay(r.startDate)} → {fmtDay(r.endDate)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{r.days}</td>
                  <td className="px-4 py-2.5">
                    <span className={cn("inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium", LEAVE_STATUS_BADGE[r.status])}>
                      {LEAVE_STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-[0.8125rem] max-w-56 truncate">
                    {r.decidedBy ? `${r.decidedBy}${r.decisionNote ? `: ${r.decisionNote}` : ""}` : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {(r.status === "PENDING" || r.status === "APPROVED") && (
                      <CancelRequestButton requestId={r.id} wasApproved={r.status === "APPROVED"} onDone={load} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <RequestFormModal
        open={showForm}
        onClose={() => setShowForm(false)}
        types={types}
        balances={balances}
        holidays={holidays}
        balanceYear={year}
        onCreated={async () => {
          setShowForm(false);
          await load();
          bumpRefresh();
        }}
      />
    </div>
  );
}

function CancelRequestButton({
  requestId, wasApproved, onDone,
}: { requestId: string; wasApproved: boolean; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const { bumpRefresh } = useApp();
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await cancelLeaveRequest({ requestId });
        setBusy(false);
        if (res.ok) {
          toast.success(wasApproved ? "Request cancelled — balance restored" : "Request cancelled");
          await onDone();
          bumpRefresh();
        } else {
          toast.error(res.error);
        }
      }}
      className="f-btn f-btn-ghost f-btn-sm text-muted-foreground"
    >
      <X size={12} /> {busy ? "Cancelling…" : "Cancel"}
    </button>
  );
}

function RequestFormModal({
  open, onClose, types, balances, holidays, balanceYear, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  types: LeaveTypeT[];
  balances: LeaveBalanceT[];
  /** F1.1 — the workspace holiday calendar (±1 year around now), so the
   * live preview matches the server's holiday-aware day counting. */
  holidays: HolidayT[];
  /** The calendar year `balances` were loaded for (the view's year selector). */
  balanceYear: number;
  onCreated: () => Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedType = types.find((t) => t.id === typeId);
  const selectedBalance = balances.find((b) => b.leaveTypeId === typeId);
  // F1.1 — holiday-aware preview: same math as the server's createLeaveRequest
  // (lib/working-days.ts), so the number the member sees is the number that
  // gets denormalized onto the request.
  const holidayMap = useMemo(() => holidayLookupFrom(holidays), [holidays]);
  const days = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return 0;
    return workingDaysBetween(
      new Date(`${startDate}T00:00:00.000Z`),
      new Date(`${endDate}T00:00:00.000Z`),
      holidayMap,
    );
  }, [startDate, endDate, holidayMap]);
  const rangeHolidays = useMemo(
    () => holidaysInRange(startDate, endDate, holidays),
    [startDate, endDate, holidays],
  );
  const endBeforeStart = Boolean(startDate && endDate && endDate < startDate);
  // QA-7: the balances in `balances` are for `balanceYear` (the view's
  // year). A range starting in a different year is validated by the server
  // against THAT year's fresh entitlement — the client-side balance guard
  // must not apply to it. (QA-8 regression: this originally referenced the
  // parent's `year` state directly, which is not in scope here — the whole
  // Leave view crashed with `ReferenceError: year is not defined`.)
  const startYear = startDate ? Number(startDate.slice(0, 4)) : balanceYear;
  const crossYear = Boolean(startDate) && startYear !== balanceYear;

  return (
    <Modal open={open} onClose={onClose} title="Request leave">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await createLeaveRequest({ leaveTypeId: typeId, startDate, endDate, reason: reason || undefined });
          setBusy(false);
          if (res.ok) {
            toast.success(`Request submitted — ${res.data.days} working day${res.data.days === 1 ? "" : "s"}`);
            setStartDate(""); setEndDate(""); setReason("");
            await onCreated();
          } else {
            // toResult guarantees user-facing messages for every failure mode
            // — the {ok:false, error} Result is not a thrown Error object, so
            // isActionError() does not apply (bugs-view convention).
            toast.error(res.error);
          }
        }}
      >
        <FormRow>
          <Field label="Leave type">
            <select
              id="leave-type"
              className="f-input"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              required
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {selectedBalance && t.id === typeId
                    ? ` — ${selectedBalance.available} day${selectedBalance.available === 1 ? "" : "s"} available`
                    : ""}
                </option>
              ))}
            </select>
          </Field>
          {selectedType?.policy && (
            <div className="flex items-end">
              <p className="text-[0.6875rem] text-muted-foreground pb-2">
                Max {selectedType.policy.maxConsecutiveDays} consecutive days ·{" "}
                {selectedType.policy.minNoticeDays} day(s) notice
                {selectedType.requiresDoc ? " · documentation required" : ""}
              </p>
            </div>
          )}
        </FormRow>
        <FormRow>
          <Field label="First day">
            <input
              id="leave-start"
              type="date"
              className="f-input"
              value={startDate}
              min={today}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
              }}
              required
            />
          </Field>
          <Field label="Last day">
            <input
              id="leave-end"
              type="date"
              className="f-input"
              value={endDate}
              min={startDate || today}
              onChange={(e) => setEndDate(e.target.value)}
              required
            />
          </Field>
        </FormRow>
        <Field label="Reason (optional)">
          <textarea
            id="leave-reason"
            className="f-input min-h-20"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="A short note for your approver"
          />
        </Field>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {days > 0
              ? `${days} working day${days === 1 ? "" : "s"} (weekends${rangeHolidays.length > 0 ? " and holidays" : ""} excluded)`
              : endBeforeStart
                ? "End date is before the start date"
                : startDate && endDate
                  ? "That range contains no working days (Mon–Fri, holidays excluded)"
                  : "Pick a date range"}
          </span>
          {rangeHolidays.length > 0 && days > 0 && (
            <span className="text-[0.6875rem] text-muted-foreground truncate max-w-[14rem]">
              {rangeHolidays.map((h) => h.label || h.date).join(", ")}
            </span>
          )}
          {selectedBalance && days > 0 && crossYear && (
            <span className="text-muted-foreground tabular-nums">
              {startYear} entitlement applies — the server validates on submit
            </span>
          )}
          {selectedBalance && days > 0 && !crossYear && (
            <span className={cn("tabular-nums", days > selectedBalance.available ? "text-destructive font-medium" : "text-muted-foreground")}>
              {days} of {selectedBalance.available} available
            </span>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Close</button>
          <button
            type="submit"
            className="f-btn f-btn-primary f-btn-sm"
            disabled={
              busy ||
              days === 0 ||
              endBeforeStart ||
              // QA-7: the loaded balance is for the CURRENT year — a range
              // that starts in a different year is validated server-side
              // against that year's fresh entitlement, so the client must
              // not block it (it only showed a misleading "X of Y available").
              (Boolean(selectedBalance) && !crossYear && days > (selectedBalance?.available ?? 0))
            }
          >
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
