"use client";

// HR module — the HR console (docs/HR_MODULE_PLAN.md §4).
// Tab "Requests": the leave queue. Admin/HR see the whole workspace; a
// MANAGER sees only their subtree (they can only decide for their reports —
// the queue must not leak other teams' leave reasons to them).
// Tab "Types & Policies" (hr:admin): leave type CRUD + policy editing.
// Directory / Reviews / Onboarding tabs arrive with features 2–4.
// Tab "Offboarding" (hr:admin, F2.1): separation checklists, exit
// interviews and full-and-final settlement.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Briefcase, Check, CircleDollarSign, Loader2, X, Plus, Settings2, ClipboardCheck, ListChecks, CalendarDays, CalendarCheck, CalendarClock, DoorOpen, Scale, Layers, Users, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "../ui/modal";
import { Field, FormRow } from "../ui/field";
import { FilterBar } from "../ui/filter-bar";
import { LEAVE_STATUS_BADGE, LEAVE_STATUS_LABELS } from "@/lib/config";
import type { LeaveRequestT, LeaveTypeT, CompLeaveRequestT } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  getLeaveQueue,
  decideLeaveRequest,
  createLeaveType,
  updateLeaveType,
  adjustLeaveBalance,
} from "@/server-actions/hr-leave";
import { DirectoryTab } from "./hr-directory";
import { ReviewsTab } from "./hr-reviews";
import { OnboardingTab } from "./hr-onboarding";
import { HolidaysTab } from "./hr-holidays";
import { AttendanceTab } from "./hr-attendance";
import { OffboardingTab } from "./hr-offboarding";
import { BalancesTab } from "./hr-leave-balances";
import { getEncashmentQueue, decideLeaveEncashment } from "@/server-actions/leave-encashment";
import type { LeaveEncashmentT } from "@/lib/types";
// P30 (LV-01/LV-11) — the compensatory claim queue + its decision action.
import {
  getCompensatoryQueue,
  decideCompensatoryLeaveRequest,
} from "@/server-actions/compensatory-leave";
import { getDirectory } from "@/server-actions/hr-directory";
// P27 (LV-08) — the leave period master (named allocation windows).
import {
  listLeavePeriods,
  createLeavePeriod,
  deleteLeavePeriod,
  type LeavePeriodT,
} from "@/server-actions/leave-periods";
// P28 (LV-02/LV-03) — the policy set master + the bulk assignment tool.
import {
  listLeavePolicyState,
  createLeavePolicySet,
  updateLeavePolicySet,
  deleteLeavePolicySet,
  bulkAssignLeavePolicySet,
  deleteLeavePolicyAssignment,
  type LeavePolicyStateT,
  type LeavePolicySetT,
} from "@/server-actions/leave-policy-sets";
import { fmtDay } from "@/lib/format";

interface CurrentUser {
  id: string;
  name: string;
  role: string;
}

type Tab = "requests" | "types" | "holidays" | "attendance" | "balances" | "directory" | "reviews" | "onboarding" | "offboarding";

export function HRView({ currentUser }: { currentUser: CurrentUser }) {
  const [tab, setTab] = useState<Tab>("requests");
  const [requests, setRequests] = useState<LeaveRequestT[]>([]);
  const [types, setTypes] = useState<LeaveTypeT[]>([]);
  const [canAdmin, setCanAdmin] = useState(false);
  // F1.3 — the Attendance tab's gate (attendance:manage; NOT hr:admin).
  const [canManageAttendance, setCanManageAttendance] = useState(false);
  // P2 (LV-09, F2.2) — the encashment decision queue rides the Requests tab.
  const [encashments, setEncashments] = useState<LeaveEncashmentT[]>([]);
  // P30 (LV-01/LV-11) — the comp-off claim queue rides the Requests tab too.
  const [compRequests, setCompRequests] = useState<CompLeaveRequestT[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await getLeaveQueue();
    if (res.ok) {
      setRequests(res.data.requests);
      setTypes(res.data.types);
      setCanAdmin(res.data.canAdmin);
      setCanManageAttendance(res.data.canManageAttendance);
    } else {
      toast.error(res.error);
    }
    const enc = await getEncashmentQueue();
    if (enc.ok) setEncashments(enc.data.requests);
    const comp = await getCompensatoryQueue();
    if (comp.ok) setCompRequests(comp.data);
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  if (!loaded) {
    return <div className="p-6 text-sm text-muted-foreground">Loading HR console…</div>;
  }

  const pendingCount = requests.filter((r) => r.status === "PENDING").length + compRequests.length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <Briefcase className="h-6 w-6 text-pink-500" />
            HR
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {pendingCount} pending decision{pendingCount === 1 ? "" : "s"}
            {currentUser.role === "MANAGER" ? " · your team" : " · whole workspace"}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabButton active={tab === "requests"} onClick={() => setTab("requests")}>
          <Briefcase size={13} /> Requests
        </TabButton>
        {canAdmin && (
          <TabButton active={tab === "types"} onClick={() => setTab("types")}>
            <Settings2 size={13} /> Types &amp; Policies
          </TabButton>
        )}
        {canAdmin && (
          <TabButton active={tab === "holidays"} onClick={() => setTab("holidays")}>
            <CalendarDays size={13} /> Holidays
          </TabButton>
        )}
        {canManageAttendance && (
          <TabButton active={tab === "attendance"} onClick={() => setTab("attendance")}>
            <CalendarCheck size={13} /> Attendance
          </TabButton>
        )}
        {/* P21 (LV-R01) — the balance report (hr:view, the queue's surface):
            one row per type × member, from the ledger. */}
        <TabButton active={tab === "balances"} onClick={() => setTab("balances")}>
          <Scale size={13} /> Balances
        </TabButton>
        <TabButton active={tab === "directory"} onClick={() => setTab("directory")}>
          <Briefcase size={13} /> Directory
        </TabButton>
        <TabButton active={tab === "reviews"} onClick={() => setTab("reviews")}>
          <ClipboardCheck size={13} /> Reviews
        </TabButton>
        <TabButton active={tab === "onboarding"} onClick={() => setTab("onboarding")}>
          <ListChecks size={13} /> Onboarding
        </TabButton>
        {canAdmin && (
          <TabButton active={tab === "offboarding"} onClick={() => setTab("offboarding")}>
            <DoorOpen size={13} /> Offboarding
          </TabButton>
        )}
      </div>

      {tab === "requests" && (
        <RequestsTab
          requests={requests}
          types={types}
          canAdmin={canAdmin}
          currentUserId={currentUser.id}
          onChanged={load}
          encashments={encashments}
          compRequests={compRequests}
        />
      )}
      {tab === "types" && canAdmin && (
        <TypesTab types={types} onChanged={load} />
      )}
      {tab === "holidays" && canAdmin && <HolidaysTab />}
      {tab === "attendance" && canManageAttendance && <AttendanceTab />}
      {tab === "balances" && <BalancesTab types={types} />}
      {tab === "directory" && <DirectoryTab />}
      {tab === "reviews" && <ReviewsTab />}
      {tab === "onboarding" && <OnboardingTab />}
      {tab === "offboarding" && canAdmin && <OffboardingTab />}
    </div>
  );
}

function TabButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Requests tab
// ---------------------------------------------------------------------------

function RequestsTab({
  requests, types, canAdmin, currentUserId, onChanged, encashments, compRequests,
}: {
  requests: LeaveRequestT[];
  types: LeaveTypeT[];
  canAdmin: boolean;
  currentUserId: string;
  onChanged: () => Promise<void>;
  encashments: LeaveEncashmentT[];
  compRequests: CompLeaveRequestT[];
}) {
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [deciding, setDeciding] = useState<LeaveRequestT | null>(null);
  // LV-10 (S9) — the HR leave adjustment writer's surface.
  const [adjusting, setAdjusting] = useState(false);

  const filters = useMemo(
    () => [
      { key: "PENDING", label: "Pending", count: requests.filter((r) => r.status === "PENDING").length },
      { key: "APPROVED", label: "Approved", count: requests.filter((r) => r.status === "APPROVED").length },
      { key: "REJECTED", label: "Rejected", count: requests.filter((r) => r.status === "REJECTED").length },
      { key: "CANCELLED", label: "Cancelled", count: requests.filter((r) => r.status === "CANCELLED").length },
      { key: "ALL", label: "All", count: requests.length },
    ],
    [requests],
  );
  const visible = requests.filter((r) => statusFilter === "ALL" || r.status === statusFilter);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <FilterBar filters={filters} value={statusFilter} onChange={(v) => setStatusFilter(v)} />
        {canAdmin && (
          <button
            type="button"
            className="f-btn f-btn-secondary f-btn-sm ml-auto"
            onClick={() => setAdjusting(true)}
            data-testid="adjust-balance-button"
          >
            <Scale size={13} /> Adjust a balance
          </button>
        )}
      </div>

      <div className="f-card overflow-hidden">
        {visible.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">Nothing here — no requests match this filter.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="px-4 py-2 font-semibold">Member</th>
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="px-4 py-2 font-semibold">Dates</th>
                <th className="px-4 py-2 font-semibold">Days</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Decision</th>
                <th className="px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-medium">{r.userName}</td>
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
                  <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
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
                    {r.status === "PENDING" && r.userId !== currentUserId && (
                      <DecideButton request={r} onDecide={() => setDeciding(r)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <DecisionModal
        request={deciding}
        onClose={() => setDeciding(null)}
        onChanged={onChanged}
      />

      {/* P2 (LV-09, F2.2) — the encashment queue: days sold back, decided
          by the same chain as time-off. Approve = CONSUME + adapter row. */}
      {encashments.length > 0 && (
        <div className="f-card overflow-hidden" data-testid="encashment-queue">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <CircleDollarSign size={14} className="text-teal-500" /> Encashment requests
            </h2>
            <span className="text-[0.6875rem] text-muted-foreground">{encashments.length} pending</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="px-4 py-2 font-semibold">Member</th>
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="px-4 py-2 font-semibold">Days</th>
                <th className="px-4 py-2 font-semibold">Payout run</th>
                <th className="px-4 py-2 font-semibold">Reason</th>
                <th className="px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {encashments.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0" data-testid="encashment-queue-row">
                  <td className="px-4 py-2.5 font-medium">{e.userName}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: e.typeColor }} aria-hidden />
                      {e.typeName}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{e.days}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{e.payoutPeriod}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-[0.8125rem] max-w-48 truncate" title={e.reason}>
                    {e.reason || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {e.userId !== currentUserId && <EncashmentDecideButtons encashment={e} onChanged={onChanged} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* P30 (LV-01/LV-11) — the comp-off claim queue: worked-holiday
          claims decided by the same chain as time-off. Approve = the comp
          GRANT ledger row lands. */}
      <CompOffQueueSection
        compRequests={compRequests}
        currentUserId={currentUserId}
        onChanged={onChanged}
      />

      {/* LV-10 (S9) — the ADJUST ledger writer: signed days, reason
          required, floor-honest. Mount-on-open keeps the form pristine. */}
      {canAdmin && adjusting && (
        <AdjustBalanceModal
          types={types}
          onClose={() => setAdjusting(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LV-10 (S9) — Adjust balance modal
// ---------------------------------------------------------------------------

function AdjustBalanceModal({
  types, onClose,
}: {
  types: LeaveTypeT[];
  onClose: () => void;
}) {
  const [members, setMembers] = useState<{ userId: string; name: string }[]>([]);
  const [userId, setUserId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState(types[0]?.id ?? "");
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [deltaInput, setDeltaInput] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // The member roster loads asynchronously on mount (getDirectory is
  // hr-scoped, same as the DecisionModal's approver fetch pattern).
  useEffect(() => {
    void (async () => {
      const res = await getDirectory();
      if (res.ok) setMembers(res.data.profiles.map((p) => ({ userId: p.userId, name: p.name })));
    })();
  }, []);

  const delta = Math.round((Number(deltaInput) || 0) * 100) / 100;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await adjustLeaveBalance({
      userId, leaveTypeId, year: Number(year), delta, reason,
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Balance adjusted — ${res.data.availableBefore} → ${res.data.availableAfter} day(s) available.`);
    onClose();
  };

  return (
    <Modal open onClose={onClose} title="Adjust a leave balance">
      <form className="space-y-3" onSubmit={submit}>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Adjustments are <strong>audited corrections on the append-only ledger</strong> — they never
          rewrite history. Positive deltas add entitlement, negative deltas dock it; the reason is
          required and lands on the ledger row.
        </div>
        <FormRow>
          <Field label="Member">
            <select className="f-input" value={userId} onChange={(e) => setUserId(e.target.value)} required data-testid="adjust-user">
              <option value="">Select a member…</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Leave type">
            <select className="f-input" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} required>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Year">
            <input className="f-input" type="number" min={2020} max={2100} value={year} onChange={(e) => setYear(e.target.value)} required />
          </Field>
          <Field label="Adjustment (days — signed, quarter steps)">
            <input
              className="f-input" type="number" step={0.25} value={deltaInput}
              onChange={(e) => setDeltaInput(e.target.value)}
              placeholder="e.g. 2 or -1.5"
              data-testid="adjust-delta"
              required
            />
          </Field>
        </FormRow>
        <Field label="Reason (required — recorded on the ledger row)">
          <textarea
            className="f-input min-h-16" maxLength={500} value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Court-ordered entitlement correction, accrual arrears from 2025"
            data-testid="adjust-reason"
            required
          />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary" disabled={busy || delta === 0} data-testid="adjust-save">
            {busy ? "Adjusting…" : "Write adjustment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DecideButton({ request, onDecide }: { request: LeaveRequestT; onDecide: () => void }) {
  return (
    <button onClick={onDecide} className="f-btn f-btn-primary f-btn-sm" data-testid={`decide-${request.id}`}>
      Decide
    </button>
  );
}

// P2 (LV-09, F2.2) — inline approve/reject for an encashment request: no
// modal (no extra facts to collect beyond the row), a busy lock, and the
// same toast + reload discipline as the leave decision modal.
function EncashmentDecideButtons({
  encashment, onChanged,
}: { encashment: LeaveEncashmentT; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<"" | "APPROVE" | "REJECT">("");
  const decide = async (decision: "APPROVE" | "REJECT") => {
    setBusy(decision);
    const res = await decideLeaveEncashment({ encashmentId: encashment.id, decision });
    setBusy("");
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(
      decision === "APPROVE"
        ? `Encashment approved — the amount lands on the ${encashment.payoutPeriod} run.`
        : "Encashment rejected.",
    );
    await onChanged();
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        className="f-btn f-btn-secondary f-btn-sm"
        disabled={busy !== ""}
        onClick={() => void decide("APPROVE")}
        data-testid={`encashment-approve-${encashment.id}`}
      >
        {busy === "APPROVE" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Approve
      </button>
      <button
        className="f-btn f-btn-ghost f-btn-sm"
        disabled={busy !== ""}
        onClick={() => void decide("REJECT")}
        data-testid={`encashment-reject-${encashment.id}`}
      >
        {busy === "REJECT" ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Reject
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// P30 (LV-01/LV-11) — the compensatory claim queue: worked-holiday claims,
// decided inline (approve = the comp GRANT ledger row + the balance lands;
// reject = nothing granted). Exported for the focused component test.
// ---------------------------------------------------------------------------
export function CompOffQueueSection({
  compRequests, currentUserId, onChanged,
}: {
  compRequests: CompLeaveRequestT[];
  currentUserId: string;
  onChanged: () => Promise<void>;
}) {
  if (compRequests.length === 0) return null;
  return (
    <div className="f-card overflow-hidden" data-testid="compoff-queue">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <CalendarClock size={14} className="text-lime-600 dark:text-lime-400" /> Comp-off claims
        </h2>
        <span className="text-[0.6875rem] text-muted-foreground">{compRequests.length} pending</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground border-b border-border">
            <th className="px-4 py-2 font-semibold">Member</th>
            <th className="px-4 py-2 font-semibold">Type</th>
            <th className="px-4 py-2 font-semibold">Worked</th>
            <th className="px-4 py-2 font-semibold">Days earned</th>
            <th className="px-4 py-2 font-semibold">Reason</th>
            <th className="px-4 py-2 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {compRequests.map((c) => (
            <tr key={c.id} className="border-b border-border last:border-0" data-testid="compoff-queue-row">
              <td className="px-4 py-2.5 font-medium">{c.userName}</td>
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.typeColor }} aria-hidden />
                  {c.typeName}
                </span>
              </td>
              <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                {fmtDay(c.workFromDate)} → {fmtDay(c.workToDate)}
              </td>
              <td className="px-4 py-2.5 tabular-nums">{c.days}</td>
              <td className="px-4 py-2.5 text-muted-foreground text-[0.8125rem] max-w-48 truncate" title={c.reason}>
                {c.reason || "—"}
              </td>
              <td className="px-4 py-2.5 text-right">
                {c.userId !== currentUserId && <CompOffDecideButtons claim={c} onChanged={onChanged} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// P30 — inline approve/reject for a comp-off claim (the EncashmentDecideButtons
// discipline: no modal — the row already shows every fact).
function CompOffDecideButtons({
  claim, onChanged,
}: { claim: CompLeaveRequestT; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<"" | "APPROVE" | "REJECT">("");
  const decide = async (decision: "APPROVE" | "REJECT") => {
    setBusy(decision);
    const res = await decideCompensatoryLeaveRequest({ compId: claim.id, decision });
    setBusy("");
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(
      decision === "APPROVE"
        ? `Comp-off approved — ${claim.days} day(s) earned on ${claim.typeName}.`
        : "Comp-off claim rejected.",
    );
    await onChanged();
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        className="f-btn f-btn-secondary f-btn-sm"
        disabled={busy !== ""}
        onClick={() => void decide("APPROVE")}
        data-testid={`compoff-approve-${claim.id}`}
      >
        {busy === "APPROVE" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Approve
      </button>
      <button
        className="f-btn f-btn-ghost f-btn-sm"
        disabled={busy !== ""}
        onClick={() => void decide("REJECT")}
        data-testid={`compoff-reject-${claim.id}`}
      >
        {busy === "REJECT" ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Reject
      </button>
    </span>
  );
}

function DecisionModal({
  request, onClose, onChanged,
}: {
  request: LeaveRequestT | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "APPROVE" | "REJECT">("");

  // Reset the note whenever a different request is opened.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setNote(""); }, [request?.id]);

  if (!request) return null;

  const decide = async (decision: "APPROVE" | "REJECT") => {
    if (!request) return;
    setBusy(decision);
    const res = await decideLeaveRequest({ requestId: request.id, decision, note: note || undefined });
    setBusy("");
    if (res.ok) {
      toast.success(decision === "APPROVE" ? "Request approved" : "Request rejected");
      onClose();
      await onChanged();
    } else {
      toast.error(res.error);
    }
  };

  return (
    <Modal open={Boolean(request)} onClose={onClose} title="Decide leave request">
      <div className="space-y-4">
        <div className="text-sm">
          <div className="font-medium text-foreground">
            {request.userName} · {request.typeName}
          </div>
          <div className="text-muted-foreground mt-1">
            {fmtDay(request.startDate)} → {fmtDay(request.endDate)} · {request.days} working day{request.days === 1 ? "" : "s"}
          </div>
          {request.reason && (
            <div className="text-muted-foreground mt-2 text-[0.8125rem] italic">“{request.reason}”</div>
          )}
        </div>
        <Field label="Note (optional — shown to the requester)">
          <textarea
            id="decision-note"
            className="f-input min-h-20"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Enjoy the break — coverage arranged."
          />
        </Field>
        <div className="flex justify-end gap-2">
          <button
            className="f-btn f-btn-ghost f-btn-sm"
            disabled={busy !== ""}
            onClick={() => void decide("REJECT")}
            data-testid="reject-request"
          >
            <X size={12} /> {busy === "REJECT" ? "Rejecting…" : "Reject"}
          </button>
          <button
            className="f-btn f-btn-primary f-btn-sm"
            disabled={busy !== ""}
            onClick={() => void decide("APPROVE")}
            data-testid="approve-request"
          >
            <Check size={12} /> {busy === "APPROVE" ? "Approving…" : "Approve"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Types & policies tab (hr:admin)
// ---------------------------------------------------------------------------

function TypesTab({ types, onChanged }: { types: LeaveTypeT[]; onChanged: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Entitlements and guard rails per leave type. Deactivating hides the type from request forms; history is kept.
        </p>
        <button className="f-btn f-btn-primary f-btn-sm" onClick={() => setCreating(true)}>
          <Plus size={14} /> New Type
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {types.map((t) => (
          <TypeCard key={t.id} type={t} onChanged={onChanged} />
        ))}
      </div>

      {/* P27 (LV-08) — the allocation windows the engine advances. An
          empty master = the implicit calendar year (the zero-change
          default the suite pins). */}
      <LeavePeriodsSection />

      {/* P28 (LV-02/LV-03) — the multi-type allocation templates + the
          bulk-assign tool. Empty masters = the per-type policies above are
          the whole world (the zero-change default). */}
      <PolicySetsSection types={types} onChanged={onChanged} />

      <CreateTypeModal open={creating} onClose={() => setCreating(false)} onChanged={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// P27 (LV-08) — the leave period master: named allocation windows
// (benchmark `Leave Period`). The section lists the chain, marks the live
// window, and creates/deletes future periods. The honest boundaries the
// actions enforce (forward-looking, engine-clean buckets, immutable
// history) surface here as the empty-state notice and the refusal toasts.
// ---------------------------------------------------------------------------
/** Exported for the focused component test (the whole HRView drags in
 * eight child views and their action modules — this section is the P27
 * surface the test pins). */
export function LeavePeriodsSection() {
  const [periods, setPeriods] = useState<LeavePeriodT[] | null>(null);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await listLeavePeriods();
    if (res.ok) setPeriods(res.data.periods);
    else toast.error(res.error);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload(); }, [reload]);

  const today = new Date().toISOString().slice(0, 10);

  async function submit() {
    if (busy) return;
    setBusy(true);
    const res = await createLeavePeriod({ name, startDate, endDate });
    setBusy(false);
    if (res.ok) {
      toast.success(`Leave period “${res.data.period.name}” created`);
      setName("");
      setStartDate("");
      setEndDate("");
      await reload();
    } else {
      toast.error(res.error);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    const res = await deleteLeavePeriod({ id });
    setBusy(false);
    if (res.ok) {
      toast.success("Leave period deleted before it took effect");
      await reload();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="f-card p-4" data-testid="leave-periods-section">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-foreground">Leave periods</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Named allocation windows the policy engine grants into — one ledger bucket per start year. With no periods, every year is an implicit Jan–Dec window.
          </p>
        </div>
      </div>

      {periods === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
          <Loader2 size={14} className="animate-spin" /> Loading periods…
        </div>
      ) : periods.length === 0 ? (
        <div className="text-sm text-muted-foreground mt-3 rounded-md border border-dashed border-border p-3" data-testid="leave-periods-empty">
          No named periods — allocations ride the implicit calendar year (Jan 1 → Dec 31). Create a future window to
          switch the workspace to named periods (e.g. an Apr→Mar fiscal leave year). Named periods are forward-looking:
          the first one must start in a year the engine has not yet granted into.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {periods.map((p, i) => {
            const status = p.startDate > today ? "upcoming" : p.endDate >= today ? "active" : "closed";
            return (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5"
                data-testid={`leave-period-row-${i}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground truncate" data-testid={`leave-period-name-${i}`}>{p.name}</span>
                    <span
                      className={cn(
                        "text-[0.625rem] px-1.5 py-0.5 rounded shrink-0",
                        status === "active" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                        status === "upcoming" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                        status === "closed" && "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
                      )}
                    >
                      {status}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {p.startDate} → {p.endDate} · ledger bucket {p.bucketYear}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {status === "upcoming" && (
                    <button
                      className="f-btn f-btn-ghost f-btn-sm text-muted-foreground"
                      onClick={() => void remove(p.id)}
                      data-testid={`leave-period-delete-${i}`}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 mt-3 items-end">
        <Field label="Name" className="min-w-0">
          <input
            className="f-input"
            placeholder="e.g. FY 2028/29 (Apr → Mar)"
            value={name}
            maxLength={80}
            data-testid="leave-period-name-input"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Starts">
          <input
            type="date"
            className="f-input"
            value={startDate}
            data-testid="leave-period-start-input"
            onChange={(e) => setStartDate(e.target.value)}
          />
        </Field>
        <Field label="Ends">
          <input
            type="date"
            className="f-input"
            value={endDate}
            data-testid="leave-period-end-input"
            onChange={(e) => setEndDate(e.target.value)}
          />
        </Field>
        <button
          className="f-btn f-btn-primary f-btn-sm"
          disabled={busy || !name.trim() || !startDate || !endDate}
          onClick={() => void submit()}
          data-testid="leave-period-create-button"
        >
          <Plus size={14} /> Add period
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// P28 (LV-02/LV-03) — the policy set master + the bulk assignment tool
// (benchmark `Leave Policy` + `Leave Policy Assignment`). The section lists
// the sets (one row per set: the allocation chips), the live assignments
// (granted badges, the honest delete refusals surfacing as toasts), and
// opens the set editor + the bulk-assign modal. An EMPTY master = the
// per-type policies above are the whole world (the zero-change default).
// ---------------------------------------------------------------------------
/** Exported for the focused component test (the same locality rule as
 * LeavePeriodsSection). */
export function PolicySetsSection({
  types,
  onChanged,
}: {
  types: LeaveTypeT[];
  onChanged: () => Promise<void>;
}) {
  const [state, setState] = useState<LeavePolicyStateT | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<LeavePolicySetT | null>(null);
  const [assigning, setAssigning] = useState<LeavePolicySetT | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await listLeavePolicyState();
    if (res.ok) setState(res.data);
    else toast.error(res.error);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload(); }, [reload]);

  async function removeSet(set: LeavePolicySetT) {
    if (busy) return;
    setBusy(true);
    const res = await deleteLeavePolicySet({ id: set.id });
    setBusy(false);
    if (res.ok) {
      toast.success(`Policy set “${set.name}” deleted`);
      await reload();
    } else {
      toast.error(res.error);
    }
  }

  async function removeAssignment(assignmentId: string) {
    if (busy) return;
    setBusy(true);
    const res = await deleteLeavePolicyAssignment({ id: assignmentId });
    setBusy(false);
    if (res.ok) {
      toast.success("Assignment deleted before anything was granted");
      await reload();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="f-card p-4" data-testid="policy-sets-section">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium text-foreground flex items-center gap-1.5">
            <Layers size={14} className="text-violet-500" /> Policy sets
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Multi-type allocation templates (one annual allocation per leave type) that HR bulk-assigns to employees per
            allocation window — the assigned numbers ride the policy engine; a mid-window joiner is DOJ-pro-rated (F2.4&rsquo;s rule).
          </p>
        </div>
        <button
          className="f-btn f-btn-primary f-btn-sm shrink-0"
          onClick={() => setCreating(true)}
          data-testid="policy-set-new-button"
        >
          <Plus size={14} /> New set
        </button>
      </div>

      {state === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
          <Loader2 size={14} className="animate-spin" /> Loading policy sets…
        </div>
      ) : state.sets.length === 0 ? (
        <div className="text-sm text-muted-foreground mt-3 rounded-md border border-dashed border-border p-3" data-testid="policy-sets-empty">
          No policy sets — every employee&rsquo;s entitlement comes from the per-type policies above (the default). Create a
          set to hand different allocation packages to different groups: define the rows once, then bulk-assign them to a
          whole window&rsquo;s roster.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {state.sets.map((s, i) => (
            <div
              key={s.id}
              className="rounded-md border border-border p-2.5"
              data-testid={`policy-set-row-${i}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground truncate" data-testid={`policy-set-name-${i}`}>{s.name}</span>
                    {!s.active && (
                      <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 shrink-0">
                        retired
                      </span>
                    )}
                    <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 shrink-0">
                      {s.assignmentCount} assignment{s.assignmentCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {s.description && (
                    <span className="text-xs text-muted-foreground block truncate">{s.description}</span>
                  )}
                  <span className="text-xs text-muted-foreground" data-testid={`policy-set-items-${i}`}>
                    {s.items.map((item) => `${item.typeName} ${item.annualDays}d`).join(" · ")}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="f-btn f-btn-primary f-btn-sm"
                    disabled={busy || !s.active || state.employees.length === 0}
                    onClick={() => setAssigning(s)}
                    data-testid={`policy-set-assign-${i}`}
                  >
                    <Users size={12} /> Assign…
                  </button>
                  <button
                    className="f-btn f-btn-ghost f-btn-sm"
                    disabled={busy}
                    onClick={() => setEditing(s)}
                    data-testid={`policy-set-edit-${i}`}
                  >
                    Edit
                  </button>
                  <button
                    className="f-btn f-btn-ghost f-btn-sm text-muted-foreground"
                    disabled={busy}
                    onClick={() => void removeSet(s)}
                    data-testid={`policy-set-delete-${i}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {state && state.assignments.length > 0 && (
        <div className="mt-4">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Live assignments
          </div>
          <div className="space-y-1.5" data-testid="policy-assignments-list">
            {state.assignments.map((a, i) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-xs"
                data-testid={`policy-assignment-row-${i}`}
              >
                <div className="min-w-0 truncate">
                  <span className="font-medium text-foreground">{a.userName}</span>
                  <span className="text-muted-foreground"> → {a.setName} · </span>
                  <span data-testid={`policy-assignment-bucket-${i}`}>{a.periodName ?? `calendar year ${a.bucketYear}`}</span>
                  <span className="text-muted-foreground"> · by {a.assignedByName}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {a.granted ? (
                    <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      granted
                    </span>
                  ) : (
                    <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                      pending window
                    </span>
                  )}
                  {!a.granted && (
                    <button
                      className="f-btn f-btn-ghost f-btn-sm text-muted-foreground"
                      disabled={busy}
                      onClick={() => void removeAssignment(a.id)}
                      data-testid={`policy-assignment-delete-${i}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <PolicySetModal
        open={creating || editing !== null}
        editing={editing}
        types={types}
        onClose={() => { setCreating(false); setEditing(null); }}
        onChanged={async () => { await reload(); await onChanged(); }}
      />
      {state && assigning !== null && (
        <BulkAssignPolicyModal
          open={assigning !== null}
          set={assigning}
          state={state}
          onClose={() => setAssigning(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The set editor (create + edit): one row per (leave type → annual
// allocation), prefilled from the type's own policy; the freeze notice
// covers the granted case (edits refused server-side with the reason).
// ---------------------------------------------------------------------------

interface SetEditorRow {
  leaveTypeId: string;
  annualDays: string;
}

function PolicySetModal({
  open,
  editing,
  types,
  onClose,
  onChanged,
}: {
  open: boolean;
  editing: LeavePolicySetT | null;
  types: LeaveTypeT[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [rows, setRows] = useState<SetEditorRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && editing) { setName(editing.name); setDescription(editing.description); setActive(editing.active); setRows(editing.items.map((item) => ({ leaveTypeId: item.leaveTypeId, annualDays: String(item.annualDays) }))); }
    // (create mode: the first row prefills from the first type's own policy
    // numbers — the editor starts from the workspace's current shape)
    if (open && !editing) { setName(""); setDescription(""); setActive(true); setRows(types[0] ? [{ leaveTypeId: types[0].id, annualDays: String(types[0].policy?.annualDays ?? 20) }] : []); }
  }, [open, editing, types]);

  const usedTypeIds = new Set(rows.map((r) => r.leaveTypeId));

  function setRow(i: number, patch: Partial<SetEditorRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    if (busy) return;
    const items = rows
      .filter((r) => r.leaveTypeId)
      .map((r) => ({ leaveTypeId: r.leaveTypeId, annualDays: Number(r.annualDays) }));
    if (!name.trim() || items.length === 0) {
      toast.error("A set needs a name and at least one type allocation.");
      return;
    }
    setBusy(true);
    const res = editing
      ? await updateLeavePolicySet({ id: editing.id, name, description, active, items })
      : await createLeavePolicySet({ name, description, items });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Policy set “${name}” ${editing ? "updated" : "created"}`);
    await onChanged();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit policy set — ${editing.name}` : "New policy set"}
      description="One row per leave type: the set's annual allocation (working days). Every other rule stays on the type's own policy."
      size="lg"
    >
      <div className="space-y-3" data-testid="policy-set-modal">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name">
            <input
              className="f-input"
              value={name}
              maxLength={80}
              placeholder="e.g. Standard 2027 package"
              data-testid="policy-set-name-input"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Description (optional)">
            <input
              className="f-input"
              value={description}
              maxLength={200}
              placeholder="e.g. Everyone except senior staff"
              data-testid="policy-set-desc-input"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>

        {editing && editing.assignmentCount > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {editing.assignmentCount} assignment{editing.assignmentCount === 1 ? "" : "s"} reference this set — the
            allocations freeze once any of them grants (history is immutable). Metadata stays editable.
          </div>
        )}

        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Allocations ({rows.length})
            </div>
            <button
              type="button"
              className="f-btn f-btn-ghost f-btn-sm ml-auto"
              disabled={rows.length >= 40 || rows.length >= types.length}
              onClick={() => {
                const next = types.find((t) => !usedTypeIds.has(t.id));
                if (next) {
                  setRows((prev) => [...prev, { leaveTypeId: next.id, annualDays: String(next.policy?.annualDays ?? 20) }]);
                }
              }}
              data-testid="policy-set-row-add"
            >
              <Plus size={12} /> Add type
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-border">
            {rows.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground">No rows — add a leave type.</div>
            )}
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_auto] gap-2 items-center px-3 py-2">
                <select
                  className="f-input"
                  value={row.leaveTypeId}
                  onChange={(e) => {
                    const picked = types.find((t) => t.id === e.target.value);
                    setRow(i, {
                      leaveTypeId: e.target.value,
                      annualDays: picked ? String(picked.policy?.annualDays ?? 20) : row.annualDays,
                    });
                  }}
                  data-testid={`policy-set-row-type-${i}`}
                >
                  <option value="">Pick a type…</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {usedTypeIds.has(t.id) && t.id !== row.leaveTypeId ? " (already in set)" : ""}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  className="f-input"
                  min={0}
                  max={365}
                  step={0.25}
                  value={row.annualDays}
                  onChange={(e) => setRow(i, { annualDays: e.target.value })}
                  data-testid={`policy-set-row-days-${i}`}
                />
                <button
                  type="button"
                  className="f-btn f-btn-ghost f-btn-sm text-muted-foreground"
                  onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                  aria-label="Remove row"
                  data-testid={`policy-set-row-remove-${i}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {editing && (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              data-testid="policy-set-active-toggle"
            />
            Active (offered in the assign picker — retiring never touches live assignments)
          </label>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="f-btn f-btn-primary"
            disabled={busy || !name.trim() || rows.length === 0}
            onClick={() => void submit()}
            data-testid="policy-set-submit"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Layers size={14} />}
            {editing ? "Save set" : "Create set"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The bulk-assign modal (P14's BulkStructureModal pattern): one set, one
// target window, employee checkboxes with DOJ hints; per-employee
// isolation server-side, loud failures here.
// ---------------------------------------------------------------------------

function BulkAssignPolicyModal({
  open,
  set,
  state,
  onClose,
  onChanged,
}: {
  open: boolean;
  set: LeavePolicySetT;
  state: LeavePolicyStateT;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bucketYear, setBucketYear] = useState<number>(state.buckets[0]?.bucketYear ?? 0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { setSelected(new Set()); setBucketYear(state.buckets[0]?.bucketYear ?? 0); }
  }, [open, state.buckets]);

  const bucket = state.buckets.find((b) => b.bucketYear === bucketYear) ?? null;
  const assignmentByUser = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of state.assignments) {
      if (a.bucketYear === bucketYear) map.set(a.userId, a.setName);
    }
    return map;
  }, [state.assignments, bucketYear]);

  function toggle(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function submit() {
    if (busy || selected.size === 0) return;
    setBusy(true);
    const res = await bulkAssignLeavePolicySet({
      setId: set.id,
      bucketYear,
      userIds: [...selected],
    });
    setBusy(false);
    if (!res.ok) {
      // The all-fail loud refusal (the P14 pattern): the failures surface as
      // the toast, the modal closes so the section below stays reachable —
      // the same posture as the partial-success path.
      toast.error(res.error, { duration: 10_000 });
      onClose();
      return;
    }
    const { assigned, pairsMaterialized, failures } = res.data;
    toast.success(
      `Assigned “${set.name}” to ${assigned} employee(s) for ${bucket?.label ?? bucketYear}` +
        (pairsMaterialized > 0 ? ` — ${pairsMaterialized} entitlement pair(s) materialized now` : " — the window grants on schedule"),
    );
    if (failures.length > 0) {
      toast.error(
        `${failures.length} employee(s) failed: ${failures.map((f) => f.reason).join("; ")}.`,
        { duration: 10_000 },
      );
    }
    await onChanged();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Assign policy set — ${set.name}`}
      description="Each employee gets this set's allocations for the target window in their own transaction; a joiner hired mid-window is DOJ-pro-rated."
      size="lg"
    >
      <div className="space-y-3" data-testid="bulk-policy-modal">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Policy set">
            <div className="f-input bg-muted/40 text-sm truncate" data-testid="bulk-policy-set">{set.name}</div>
          </Field>
          <Field label="Target window">
            <select
              className="f-input"
              value={bucketYear}
              onChange={(e) => setBucketYear(Number(e.target.value))}
              data-testid="bulk-policy-bucket"
            >
              {state.buckets.map((b) => (
                <option key={b.bucketYear} value={b.bucketYear}>{b.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs" data-testid="bulk-policy-totals">
          <div><div className="text-muted-foreground">Types in set</div><div className="font-semibold tabular-nums">{set.items.length}</div></div>
          <div><div className="text-muted-foreground">Selected</div><div className="font-semibold tabular-nums">{selected.size}</div></div>
          <div className="col-span-2"><div className="text-muted-foreground">Allocations</div><div className="font-semibold truncate">{set.items.map((i) => `${i.typeName} ${i.annualDays}d`).join(" · ")}</div></div>
        </div>

        <div className="rounded-md border border-border" data-testid="bulk-policy-employees">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Users size={14} className="text-sky-500" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Employees ({selected.size} selected)
            </div>
            <button
              type="button"
              className="f-btn f-btn-ghost text-xs ml-auto"
              onClick={() => setSelected(new Set(state.employees.map((e) => e.userId)))}
              data-testid="bulk-policy-select-all"
            >
              Select all
            </button>
            <button
              type="button"
              className="f-btn f-btn-ghost text-xs"
              onClick={() => setSelected(new Set())}
              data-testid="bulk-policy-clear"
            >
              Clear
            </button>
          </div>
          <div className="max-h-52 overflow-y-auto divide-y divide-border">
            {state.employees.map((e) => {
              const existing = assignmentByUser.get(e.userId);
              return (
                <label key={e.userId} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                  <input
                    type="checkbox"
                    checked={selected.has(e.userId)}
                    onChange={() => toggle(e.userId)}
                    data-testid={`bulk-policy-employee-${e.userId}`}
                  />
                  <span className="truncate">{e.name}</span>
                  {e.hireDate && <span className="text-muted-foreground shrink-0">joined {e.hireDate}</span>}
                  {existing && (
                    <span className="ml-auto text-[0.625rem] text-amber-600 dark:text-amber-400 shrink-0">
                      assigned: {existing}
                    </span>
                  )}
                </label>
              );
            })}
            {state.employees.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground">No employees found.</div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="f-btn f-btn-primary"
            disabled={busy || selected.size === 0 || !bucketYear}
            onClick={() => void submit()}
            data-testid="bulk-policy-submit"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />} Assign to {selected.size || "…"} employee(s)
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TypeCard({ type, onChanged }: { type: LeaveTypeT; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className={cn("f-card p-4", !type.active && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: type.color }} aria-hidden />
          <span className="font-medium text-foreground truncate">{type.name}</span>
          <span className="text-[0.625rem] font-mono text-muted-foreground">{type.code}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {type.requiresDoc && (
            <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">docs</span>
          )}
          {/* P30 (LV-01) — the optional-leave / compensatory type flags. */}
          {type.isOptionalLeave && (
            <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-600 dark:text-teal-400">optional</span>
          )}
          {type.isCompensatory && (
            <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-lime-500/10 text-lime-600 dark:text-lime-400">comp-off</span>
          )}
          <span className={cn("text-[0.625rem] px-1.5 py-0.5 rounded", type.paid ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400")}>
            {/* P15 (PR-06) — a paid type below full salary shows its
                fraction (the benchmark's partially-paid leave). */}
            {type.paid
              ? (type.salaryFraction ?? 1) < 1 ? `${Math.round((type.salaryFraction ?? 1) * 100)}% pay` : "paid"
              : "unpaid"}
          </span>
          {(type.policy?.allocationStrategy ?? "MANUAL") !== "MANUAL" && (
            <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">
              {STRATEGY_LABELS[type.policy?.allocationStrategy ?? "MANUAL"]}
            </span>
          )}
          {type.policy?.allowNegative && (
            <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
              advance
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-center">
        <PolicyStat label="days / year" value={type.policy?.annualDays ?? 0} />
        <PolicyStat label="carry over" value={type.policy?.maxCarryOver ?? 0} />
        <PolicyStat label="notice (d)" value={type.policy?.minNoticeDays ?? 0} />
        <PolicyStat label="max run" value={type.policy?.maxConsecutiveDays ?? 0} />
      </div>
      <div className="flex items-center justify-between mt-3">
        <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
          {type.active ? "Active" : "Inactive"}
        </span>
        <div className="flex gap-2">
          <button className="f-btn f-btn-ghost f-btn-sm" onClick={() => setEditing(true)}>Edit</button>
          <button
            className="f-btn f-btn-ghost f-btn-sm text-muted-foreground"
            onClick={async () => {
              const res = await updateLeaveType(type.id, { active: !type.active });
              if (res.ok) {
                toast.success(type.active ? "Type deactivated" : "Type reactivated");
                await onChanged();
              } else {
                toast.error(res.error);
              }
            }}
          >
            {type.active ? "Deactivate" : "Reactivate"}
          </button>
        </div>
      </div>

      <EditTypeModal type={type} open={editing} onClose={() => setEditing(false)} onChanged={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// F2.4 — leave policy strategy form state (docs/Fernly_Policy_Engine_Design.md
// §4.1). The wire type (LeaveTypeT.policy) keeps the strategy knobs optional
// for backward compatibility; the FORM state is always complete so both the
// create and the edit paths send the full block (an update that silently
// reset a strategy to MANUAL is exactly the drift this avoids).
// ---------------------------------------------------------------------------

const STRATEGY_LABELS: Record<string, string> = {
  MANUAL: "manual",
  ANNUAL_LUMP_SUM: "lump sum",
  EARNED: "earned",
  AFTER_SERVICE: "after service",
};

interface PolicyFormState {
  annualDays: number;
  maxCarryOver: number;
  minNoticeDays: number;
  maxConsecutiveDays: number;
  allocationStrategy: NonNullable<LeaveTypeT["policy"]>["allocationStrategy"];
  accrualFrequency: NonNullable<NonNullable<LeaveTypeT["policy"]>["accrualFrequency"]>;
  allocateOnDay: NonNullable<NonNullable<LeaveTypeT["policy"]>["allocateOnDay"]>;
  accrualRounding: NonNullable<NonNullable<LeaveTypeT["policy"]>["accrualRounding"]>;
  accrualCap: number | null;
  grantOn: NonNullable<NonNullable<LeaveTypeT["policy"]>["grantOn"]>;
  prorateForJoiners: boolean;
  minServiceMonths: number;
  accrueDuringProbation: boolean;
  allowNegative: boolean;
  negativeFloor: number;
  carryExpiresAfterMonths: number | null;
  countHolidaysInLeave: boolean;
  // P2 (LV-09, F2.2) — encashment knobs.
  encashable: boolean;
  maxEncashableDays: number;
  nonEncashableDays: number;
  // P30 (LV-01) — the optional-holiday count cap (null = no cap).
  maxOptionalHolidaysPerYear: number | null;
}

function defaultPolicyForm(): PolicyFormState {
  return {
    annualDays: 20,
    maxCarryOver: 5,
    minNoticeDays: 1,
    maxConsecutiveDays: 15,
    allocationStrategy: "MANUAL",
    accrualFrequency: "MONTHLY",
    allocateOnDay: "FIRST",
    accrualRounding: "FLOOR_QUARTER",
    accrualCap: null,
    grantOn: "PERIOD_START",
    prorateForJoiners: true,
    minServiceMonths: 0,
    accrueDuringProbation: true,
    allowNegative: false,
    negativeFloor: 0,
    carryExpiresAfterMonths: null,
    countHolidaysInLeave: false,
    encashable: false,
    maxEncashableDays: 5,
    nonEncashableDays: 5,
    maxOptionalHolidaysPerYear: null,
  };
}

function policyFormFrom(policy: LeaveTypeT["policy"]): PolicyFormState {
  const d = defaultPolicyForm();
  if (!policy) return d;
  return {
    annualDays: policy.annualDays ?? d.annualDays,
    maxCarryOver: policy.maxCarryOver ?? d.maxCarryOver,
    minNoticeDays: policy.minNoticeDays ?? d.minNoticeDays,
    maxConsecutiveDays: policy.maxConsecutiveDays ?? d.maxConsecutiveDays,
    allocationStrategy: policy.allocationStrategy ?? d.allocationStrategy,
    accrualFrequency: policy.accrualFrequency ?? d.accrualFrequency,
    allocateOnDay: policy.allocateOnDay ?? d.allocateOnDay,
    accrualRounding: policy.accrualRounding ?? d.accrualRounding,
    accrualCap: policy.accrualCap ?? null,
    grantOn: policy.grantOn ?? d.grantOn,
    prorateForJoiners: policy.prorateForJoiners ?? d.prorateForJoiners,
    minServiceMonths: policy.minServiceMonths ?? d.minServiceMonths,
    accrueDuringProbation: policy.accrueDuringProbation ?? d.accrueDuringProbation,
    allowNegative: policy.allowNegative ?? d.allowNegative,
    negativeFloor: policy.negativeFloor ?? d.negativeFloor,
    carryExpiresAfterMonths: policy.carryExpiresAfterMonths ?? null,
    countHolidaysInLeave: policy.countHolidaysInLeave ?? d.countHolidaysInLeave,
    encashable: policy.encashable ?? d.encashable,
    maxEncashableDays: policy.maxEncashableDays ?? d.maxEncashableDays,
    nonEncashableDays: policy.nonEncashableDays ?? d.nonEncashableDays,
    maxOptionalHolidaysPerYear: policy.maxOptionalHolidaysPerYear ?? null,
  };
}

function PolicyStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/50 px-2 py-1.5">
      <div className="text-sm font-semibold text-foreground tabular-nums">{value}</div>
      <div className="text-[0.5625rem] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function EditTypeModal({
  type, open, onClose, onChanged,
}: { type: LeaveTypeT; open: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(type.name);
  const [color, setColor] = useState(type.color);
  // P30 (LV-01) — the optional-leave / compensatory type flags ride the
  // edit form (type-level knobs, like paid/requiresDoc — not policy rows).
  const [isOptionalLeave, setIsOptionalLeave] = useState(type.isOptionalLeave ?? false);
  const [isCompensatory, setIsCompensatory] = useState(type.isCompensatory ?? false);
  // P15 (PR-06) — the partially-paid fraction rides the edit form too
  // (only rendered for paid types — an unpaid type is fraction 0 by
  // definition and the knob would read as a lie).
  const [fractionStr, setFractionStr] = useState(String(type.salaryFraction ?? 1));
  const [policy, setPolicy] = useState<PolicyFormState>(policyFormFrom(type.policy));
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${type.name}`}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await updateLeaveType(type.id, {
            name, color,
            isOptionalLeave,
            isCompensatory,
            ...(type.paid ? { salaryFraction: fractionStr === "" ? 1 : Number(fractionStr) } : {}),
            policy,
          });
          setBusy(false);
          if (res.ok) {
            toast.success("Leave type updated");
            onClose();
            await onChanged();
          } else {
            toast.error(res.error);
          }
        }}
      >
        <FormRow>
          <Field label="Name">
            <input id="lt-name" className="f-input" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Color">
            <input id="lt-color" type="color" className="f-input h-9 p-1" value={color} onChange={(e) => setColor(e.target.value)} />
          </Field>
        </FormRow>
        {/* P15 (PR-06) — the fraction knob on the edit form (paid types). */}
        {type.paid && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <Field label="Salary fraction (0–1)">
              <input
                id="lt-fraction" type="number" min={0} max={1} step={0.05}
                className="f-input" value={fractionStr}
                onChange={(e) => setFractionStr(e.target.value)}
                data-testid="lt-fraction"
              />
            </Field>
            <p className="text-xs text-muted-foreground pb-2">
              1 = fully paid · 0.5 = half paid — payroll docks (1 − fraction) days per working day taken.
            </p>
          </div>
        )}
        {/* P30 (LV-01) — the optional-leave / compensatory flags (type-level
            knobs; the optional count cap rides the policy fields below). */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <label className="flex items-center gap-2 text-sm text-foreground" data-testid="lt-optional">
            <input
              id="lt-optional-flag"
              type="checkbox"
              checked={isOptionalLeave}
              onChange={(e) => setIsOptionalLeave(e.target.checked)}
            />
            Optional leave (holiday/weekend applications don't consume balance)
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground" data-testid="lt-comp">
            <input
              id="lt-comp-flag"
              type="checkbox"
              checked={isCompensatory}
              onChange={(e) => setIsCompensatory(e.target.checked)}
            />
            Compensatory (days arrive via worked-holiday claims)
          </label>
        </div>
        <PolicyFields policy={policy} setPolicy={setPolicy} showOptionalCap={isOptionalLeave} />
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateTypeModal({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [color, setColor] = useState("#8b5cf6");
  const [requiresDoc, setRequiresDoc] = useState(false);
  const [paid, setPaid] = useState(true);
  // P30 (LV-01) — the optional-leave / compensatory flags (default false =
  // a classic type, the pre-P30 behavior).
  const [isOptionalLeave, setIsOptionalLeave] = useState(false);
  const [isCompensatory, setIsCompensatory] = useState(false);
  // P15 (PR-06) — partially-paid leave: fraction of daily salary paid per
  // leave day (paid types only; 1 = fully paid = the pre-P15 default).
  const [fractionStr, setFractionStr] = useState("1");
  const [policy, setPolicy] = useState<PolicyFormState>(defaultPolicyForm());
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title="New leave type">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await createLeaveType({
            name, code: code.toUpperCase(), color, requiresDoc, paid,
            isOptionalLeave,
            isCompensatory,
            salaryFraction: fractionStr === "" ? 1 : Number(fractionStr),
            policy,
          });
          setBusy(false);
          if (res.ok) {
            toast.success(`Leave type "${name}" created`);
            setName(""); setCode("");
            onClose();
            await onChanged();
          } else {
            toast.error(res.error);
          }
        }}
      >
        <FormRow>
          <Field label="Name">
            <input id="nlt-name" className="f-input" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="e.g. Parental" required />
          </Field>
          <Field label="Code (UPPER_CASE)">
            <input id="nlt-code" className="f-input font-mono" value={code} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="PARENTAL" required />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Color">
            <input id="nlt-color" type="color" className="f-input h-9 p-1" value={color} onChange={(e) => setColor(e.target.value)} />
          </Field>
          <div className="flex items-end gap-4 pb-2">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Paid
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={requiresDoc} onChange={(e) => setRequiresDoc(e.target.checked)} /> Requires docs
            </label>
          </div>
        </FormRow>
        {/* P15 (PR-06) — partially-paid leave knob (paid types only). */}
        {paid && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <Field label="Salary fraction (0–1)">
              <input
                id="nlt-fraction" type="number" min={0} max={1} step={0.05}
                className="f-input" value={fractionStr}
                onChange={(e) => setFractionStr(e.target.value)} placeholder="1"
                data-testid="nlt-fraction"
              />
            </Field>
            <p className="text-xs text-muted-foreground pb-2">
              1 = fully paid · 0.5 = half paid — payroll docks (1 − fraction) days per working day taken.
            </p>
          </div>
        )}
        {/* P30 (LV-01) — the optional-leave / compensatory flags; checking
            Compensatory usually pairs with Days/year 0 (earned days are a
            comp type's only entitlement). */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <label className="flex items-center gap-2 text-sm text-foreground" data-testid="nlt-optional">
            <input
              id="nlt-optional-flag"
              type="checkbox"
              checked={isOptionalLeave}
              onChange={(e) => setIsOptionalLeave(e.target.checked)}
            />
            Optional leave (holiday/weekend applications don't consume balance)
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground" data-testid="nlt-comp">
            <input
              id="nlt-comp-flag"
              type="checkbox"
              checked={isCompensatory}
              onChange={(e) => setIsCompensatory(e.target.checked)}
            />
            Compensatory (days arrive via worked-holiday claims)
          </label>
        </div>
        <PolicyFields policy={policy} setPolicy={setPolicy} showOptionalCap={isOptionalLeave} />
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy}>
            {busy ? "Creating…" : "Create type"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PolicyFields({
  policy, setPolicy, showOptionalCap = false,
}: {
  policy: PolicyFormState;
  setPolicy: (p: PolicyFormState) => void;
  /** P30 (LV-01) — render the optional-holiday count cap (the flag lives on
   * the type; the cap is a policy row — only meaningful for optional
   * types, so the modals pass the flag's state down). */
  showOptionalCap?: boolean;
}) {
  const num = (v: string): number => (v === "" ? 0 : Number(v));
  const set = (patch: Partial<PolicyFormState>) => setPolicy({ ...policy, ...patch });
  const strategy = policy.allocationStrategy;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Days / year">
          <input id="pf-annual" type="number" min={0} max={365} step={0.5} className="f-input" value={policy.annualDays}
            onChange={(e) => set({ annualDays: num(e.target.value) })} required />
        </Field>
        <Field label="Max carry-over">
          <input id="pf-carry" type="number" min={0} max={365} step={0.5} className="f-input" value={policy.maxCarryOver}
            onChange={(e) => set({ maxCarryOver: num(e.target.value) })} required />
        </Field>
        <Field label="Min notice (days)">
          <input id="pf-notice" type="number" min={0} max={90} className="f-input" value={policy.minNoticeDays}
            onChange={(e) => set({ minNoticeDays: Math.round(num(e.target.value)) })} required />
        </Field>
        <Field label="Max consecutive (days)">
          <input id="pf-max" type="number" min={1} max={365} className="f-input" value={policy.maxConsecutiveDays}
            onChange={(e) => set({ maxConsecutiveDays: Math.max(1, Math.round(num(e.target.value))) })} required />
        </Field>
      </div>

      {/* F2.4 — allocation strategy (docs/Fernly_Policy_Engine_Design.md §4.1) */}
      <fieldset className="border rounded-lg p-3 space-y-3">
        <legend className="px-1 text-xs uppercase tracking-wide text-muted-foreground">Allocation strategy</legend>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Strategy">
            <select
              id="pf-strategy"
              className="f-input"
              value={strategy}
              onChange={(e) => set({ allocationStrategy: e.target.value as PolicyFormState["allocationStrategy"] })}
            >
              <option value="MANUAL">Manual (grant on first use)</option>
              <option value="ANNUAL_LUMP_SUM">Annual lump sum</option>
              <option value="EARNED">Earned (accrues)</option>
              <option value="AFTER_SERVICE">After N months of service</option>
            </select>
          </Field>
          {strategy === "EARNED" && (
            <>
              <Field label="Accrual frequency">
                <select
                  id="pf-freq"
                  className="f-input"
                  value={policy.accrualFrequency}
                  onChange={(e) => set({ accrualFrequency: e.target.value as PolicyFormState["accrualFrequency"] })}
                >
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="HALF_YEARLY">Half-yearly</option>
                  <option value="ANNUAL">Yearly</option>
                </select>
              </Field>
              <Field label="Grant lands on">
                <select
                  id="pf-onday"
                  className="f-input"
                  value={policy.allocateOnDay}
                  onChange={(e) => set({ allocateOnDay: e.target.value as PolicyFormState["allocateOnDay"] })}
                >
                  <option value="FIRST">Period start</option>
                  <option value="LAST">Period end</option>
                  <option value="DOJ_DAY">Hire day-of-month</option>
                </select>
              </Field>
              <Field label="Rounding (0.25-day)">
                <select
                  id="pf-round"
                  className="f-input"
                  value={policy.accrualRounding}
                  onChange={(e) => set({ accrualRounding: e.target.value as PolicyFormState["accrualRounding"] })}
                >
                  <option value="FLOOR_QUARTER">Floor to quarter</option>
                  <option value="NEAREST">Nearest quarter</option>
                </select>
              </Field>
              <Field label="Standing cap (days, empty = days/year)">
                <input
                  id="pf-cap"
                  type="number"
                  min={0}
                  max={365}
                  step={0.5}
                  className="f-input"
                  value={policy.accrualCap ?? ""}
                  onChange={(e) => set({ accrualCap: e.target.value === "" ? null : num(e.target.value) })}
                />
              </Field>
            </>
          )}
          {strategy === "ANNUAL_LUMP_SUM" && (
            <>
              <Field label="Grant on">
                <select
                  id="pf-granton"
                  className="f-input"
                  value={policy.grantOn}
                  onChange={(e) => set({ grantOn: e.target.value as PolicyFormState["grantOn"] })}
                >
                  <option value="PERIOD_START">Jan 1 (pro-rate joiners)</option>
                  <option value="ANNIVERSARY">Hire anniversary</option>
                </select>
              </Field>
              <Field label="Pro-rate mid-year joiners">
                <label className="flex items-center gap-2 text-sm text-foreground h-9">
                  <input
                    id="pf-prorate"
                    type="checkbox"
                    checked={policy.prorateForJoiners}
                    disabled={policy.grantOn === "ANNIVERSARY"}
                    onChange={(e) => set({ prorateForJoiners: e.target.checked })}
                  />
                  Pro-rate
                </label>
              </Field>
            </>
          )}
          {strategy === "AFTER_SERVICE" && (
            <Field label="Months of service first">
              <input
                id="pf-minservice"
                type="number"
                min={0}
                max={600}
                className="f-input"
                value={policy.minServiceMonths}
                onChange={(e) => set({ minServiceMonths: Math.round(num(e.target.value)) })}
                required
              />
            </Field>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Advance (negative) leave">
            <label className="flex items-center gap-2 text-sm text-foreground h-9">
              <input
                id="pf-neg"
                type="checkbox"
                checked={policy.allowNegative}
                onChange={(e) => set({ allowNegative: e.target.checked })}
              />
              Allowed
            </label>
          </Field>
          <Field label="Advance floor (days)">
            <input
              id="pf-floor"
              type="number"
              min={0}
              max={365}
              step={0.5}
              className="f-input"
              value={policy.negativeFloor}
              disabled={!policy.allowNegative}
              onChange={(e) => set({ negativeFloor: num(e.target.value) })}
            />
          </Field>
          <Field label="Carry lapses after (months, empty = never)">
            <input
              id="pf-carryexp"
              type="number"
              min={1}
              max={24}
              className="f-input"
              value={policy.carryExpiresAfterMonths ?? ""}
              onChange={(e) => set({ carryExpiresAfterMonths: e.target.value === "" ? null : Math.round(num(e.target.value)) })}
            />
          </Field>
          <Field label="Holidays consume leave">
            <label className="flex items-center gap-2 text-sm text-foreground h-9">
              <input
                id="pf-holiday"
                type="checkbox"
                checked={policy.countHolidaysInLeave}
                onChange={(e) => set({ countHolidaysInLeave: e.target.checked })}
              />
              Count holidays
            </label>
          </Field>
          {showOptionalCap && (
            <Field label="Max optional applications / year (empty = no cap)">
              <input
                id="pf-optcap"
                type="number"
                min={1}
                max={365}
                className="f-input"
                value={policy.maxOptionalHolidaysPerYear ?? ""}
                onChange={(e) => set({ maxOptionalHolidaysPerYear: e.target.value === "" ? null : Math.round(num(e.target.value)) })}
                data-testid="pf-optcap"
              />
            </Field>
          )}
        </div>

        {(strategy === "EARNED" || strategy === "ANNUAL_LUMP_SUM") && (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              id="pf-probation"
              type="checkbox"
              checked={policy.accrueDuringProbation}
              onChange={(e) => set({ accrueDuringProbation: e.target.checked })}
            />
            Accrue while on probation
          </label>
        )}

        {/* P2 (LV-09, F2.2) — encashment knobs (default off: no type sells
            days back until an admin opts in). */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Encashable">
            <label className="flex items-center gap-2 text-sm text-foreground h-9">
              <input
                id="pf-encashable"
                type="checkbox"
                checked={policy.encashable}
                onChange={(e) => set({ encashable: e.target.checked })}
              />
              Allow
            </label>
          </Field>
          <Field label="Max / request (days)">
            <input
              id="pf-encashmax"
              type="number" min={0} max={365} step={0.5} className="f-input"
              value={policy.maxEncashableDays}
              disabled={!policy.encashable}
              onChange={(e) => set({ maxEncashableDays: num(e.target.value) })}
            />
          </Field>
          <Field label="Floor stays (days)">
            <input
              id="pf-encashfloor"
              type="number" min={0} max={365} step={0.5} className="f-input"
              value={policy.nonEncashableDays}
              disabled={!policy.encashable}
              onChange={(e) => set({ nonEncashableDays: num(e.target.value) })}
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          {strategy === "MANUAL" && "The full entitlement is granted the first time a balance is needed — the classic behavior."}
          {strategy === "ANNUAL_LUMP_SUM" && "The whole year's entitlement is granted once (Jan 1 or the hire anniversary); mid-year joiners are pro-rated by remaining calendar days."}
          {strategy === "EARNED" && "Entitlement accrues period by period (e.g. 2 days per month). Combine with advance leave for the take-now-repay-monthly organization."}
          {strategy === "AFTER_SERVICE" && "The whole year's entitlement is deposited once the employee completes the service requirement, repeating on that anniversary."}
        </p>
      </fieldset>
    </div>
  );
}
