"use client";

// HR module — the HR console (docs/HR_MODULE_PLAN.md §4).
// Tab "Requests": the leave queue. Admin/HR see the whole workspace; a
// MANAGER sees only their subtree (they can only decide for their reports —
// the queue must not leak other teams' leave reasons to them).
// Tab "Types & Policies" (hr:admin): leave type CRUD + policy editing.
// Directory / Reviews / Onboarding tabs arrive with features 2–4.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Briefcase, Check, X, Plus, Settings2, ClipboardCheck, ListChecks, CalendarDays, CalendarCheck } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "../ui/modal";
import { Field, FormRow } from "../ui/field";
import { FilterBar } from "../ui/filter-bar";
import { LEAVE_STATUS_BADGE, LEAVE_STATUS_LABELS } from "@/lib/config";
import type { LeaveRequestT, LeaveTypeT } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  getLeaveQueue,
  decideLeaveRequest,
  createLeaveType,
  updateLeaveType,
} from "@/server-actions/hr-leave";
import { DirectoryTab } from "./hr-directory";
import { ReviewsTab } from "./hr-reviews";
import { OnboardingTab } from "./hr-onboarding";
import { HolidaysTab } from "./hr-holidays";
import { AttendanceTab } from "./hr-attendance";

interface CurrentUser {
  id: string;
  name: string;
  role: string;
}

type Tab = "requests" | "types" | "holidays" | "attendance" | "directory" | "reviews" | "onboarding";

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

export function HRView({ currentUser }: { currentUser: CurrentUser }) {
  const [tab, setTab] = useState<Tab>("requests");
  const [requests, setRequests] = useState<LeaveRequestT[]>([]);
  const [types, setTypes] = useState<LeaveTypeT[]>([]);
  const [canAdmin, setCanAdmin] = useState(false);
  // F1.3 — the Attendance tab's gate (attendance:manage; NOT hr:admin).
  const [canManageAttendance, setCanManageAttendance] = useState(false);
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
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  if (!loaded) {
    return <div className="p-6 text-sm text-muted-foreground">Loading HR console…</div>;
  }

  const pending = requests.filter((r) => r.status === "PENDING");

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
            {pending.length} pending decision{pending.length === 1 ? "" : "s"}
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
        <TabButton active={tab === "directory"} onClick={() => setTab("directory")}>
          <Briefcase size={13} /> Directory
        </TabButton>
        <TabButton active={tab === "reviews"} onClick={() => setTab("reviews")}>
          <ClipboardCheck size={13} /> Reviews
        </TabButton>
        <TabButton active={tab === "onboarding"} onClick={() => setTab("onboarding")}>
          <ListChecks size={13} /> Onboarding
        </TabButton>
      </div>

      {tab === "requests" && (
        <RequestsTab
          requests={requests}
          currentUserId={currentUser.id}
          onChanged={load}
        />
      )}
      {tab === "types" && canAdmin && (
        <TypesTab types={types} onChanged={load} />
      )}
      {tab === "holidays" && canAdmin && <HolidaysTab />}
      {tab === "attendance" && canManageAttendance && <AttendanceTab />}
      {tab === "directory" && <DirectoryTab />}
      {tab === "reviews" && <ReviewsTab />}
      {tab === "onboarding" && <OnboardingTab />}
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
  requests, currentUserId, onChanged,
}: {
  requests: LeaveRequestT[];
  currentUserId: string;
  onChanged: () => Promise<void>;
}) {
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [deciding, setDeciding] = useState<LeaveRequestT | null>(null);

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
    </div>
  );
}

function DecideButton({ request, onDecide }: { request: LeaveRequestT; onDecide: () => void }) {
  return (
    <button onClick={onDecide} className="f-btn f-btn-primary f-btn-sm" data-testid={`decide-${request.id}`}>
      Decide
    </button>
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

      <CreateTypeModal open={creating} onClose={() => setCreating(false)} onChanged={onChanged} />
    </div>
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
          <span className={cn("text-[0.625rem] px-1.5 py-0.5 rounded", type.paid ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400")}>
            {type.paid ? "paid" : "unpaid"}
          </span>
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
  const [policy, setPolicy] = useState({
    annualDays: type.policy?.annualDays ?? 20,
    maxCarryOver: type.policy?.maxCarryOver ?? 5,
    minNoticeDays: type.policy?.minNoticeDays ?? 1,
    maxConsecutiveDays: type.policy?.maxConsecutiveDays ?? 15,
  });
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${type.name}`}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await updateLeaveType(type.id, { name, color, policy });
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
        <PolicyFields policy={policy} setPolicy={setPolicy} />
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
  const [policy, setPolicy] = useState({ annualDays: 20, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15 });
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title="New leave type">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await createLeaveType({ name, code: code.toUpperCase(), color, requiresDoc, paid, policy });
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
        <PolicyFields policy={policy} setPolicy={setPolicy} />
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
  policy, setPolicy,
}: {
  policy: { annualDays: number; maxCarryOver: number; minNoticeDays: number; maxConsecutiveDays: number };
  setPolicy: (p: { annualDays: number; maxCarryOver: number; minNoticeDays: number; maxConsecutiveDays: number }) => void;
}) {
  const num = (v: string): number => (v === "" ? 0 : Number(v));
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Field label="Days / year">
        <input id="pf-annual" type="number" min={0} max={365} step={0.5} className="f-input" value={policy.annualDays}
          onChange={(e) => setPolicy({ ...policy, annualDays: num(e.target.value) })} required />
      </Field>
      <Field label="Max carry-over">
        <input id="pf-carry" type="number" min={0} max={365} step={0.5} className="f-input" value={policy.maxCarryOver}
          onChange={(e) => setPolicy({ ...policy, maxCarryOver: num(e.target.value) })} required />
      </Field>
      <Field label="Min notice (days)">
        <input id="pf-notice" type="number" min={0} max={90} className="f-input" value={policy.minNoticeDays}
          onChange={(e) => setPolicy({ ...policy, minNoticeDays: Math.round(num(e.target.value)) })} required />
      </Field>
      <Field label="Max consecutive (days)">
        <input id="pf-max" type="number" min={1} max={365} className="f-input" value={policy.maxConsecutiveDays}
          onChange={(e) => setPolicy({ ...policy, maxConsecutiveDays: Math.max(1, Math.round(num(e.target.value))) })} required />
      </Field>
    </div>
  );
}
