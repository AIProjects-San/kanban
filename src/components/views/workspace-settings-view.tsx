"use client";

import { useState, useEffect } from "react";
import {
  Settings2, Save, Loader2, Plus, Shield,
  Tag, Flag, Building2, Calendar, CheckSquare, FolderKanban, Bell, RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useRefresh } from "@/hooks/use-refresh";
import { Section } from "../ui/section";
import { Field, FormRow } from "../ui/field";
import {
  loadWorkspaceConfig, updateWorkspaceSettings,
  updateConfigItem, createConfigItem, deleteConfigItem,
  updateRole, createRole, deleteRole,
  updateNotificationTemplate, resetNotificationTemplate,
  type WorkspaceConfig } from "@/server-actions/data";
import { actionErrorMessage } from "@/lib/action-result";
// P24 — the notification template registry + renderer (pure, client-safe:
// the editor previews render locally with the registry's sample values).
import {
  NOTIFICATION_TEMPLATE_EVENTS,
  sampleTemplateVars,
  renderTemplate,
  type NotificationTemplateEventDef,
} from "@/lib/email/notification-template";

interface WorkspaceSettingsViewProps {
  currentUser: { id: string; name: string; role: string };
}

export function WorkspaceSettingsView({ currentUser: _currentUser }: WorkspaceSettingsViewProps) {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("general");
  const refresh = useRefresh();

  // Reload the workspace config from the server. Called after every
  // successful mutation so child components get a fresh prop reference
  // (React doesn't see `Object.assign` mutations on the same object).
  // Also calls `refresh()` so server-component props (e.g. the task
  // status list used by the Kanban view) are re-fetched.
  const reload = async () => {
    const fresh = await loadWorkspaceConfig();
    if (fresh.ok) {
      setConfig(fresh.data);
    }
    refresh();
  };

  useEffect(() => {
    loadWorkspaceConfig()
      .then((res) => {
        if (res.ok) setConfig(res.data);
        else toast.error(res.error);
      })
      .catch(() => toast.error("Failed to load workspace config"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Loading workspace config…
      </div>
    );
  }

  if (!config) {
    return <div className="text-center py-20 text-sm text-muted-foreground">Failed to load config.</div>;
  }

  const tabs = [
    { key: "general", label: "General", icon: Settings2 },
    { key: "task-statuses", label: "Task Statuses", icon: CheckSquare },
    { key: "project-statuses", label: "Project Statuses", icon: FolderKanban },
    { key: "event-types", label: "Event Types", icon: Calendar },
    { key: "tags", label: "Tags", icon: Tag },
    { key: "priorities", label: "Priorities", icon: Flag },
    { key: "departments", label: "Departments", icon: Building2 },
    { key: "roles", label: "Roles & Permissions", icon: Shield },
    // P24 (PL-01) — the notification template master.
    { key: "notification-templates", label: "Notifications", icon: Bell },
  ];

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Settings2 size={22} className="text-primary" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Workspace Config</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Manage statuses, tags, priorities, departments, roles, and workspace defaults — all stored in the database.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 p-1 bg-muted/60 rounded-lg flex-wrap">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              data-testid={`settings-tab-${t.key}`}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5",
                activeTab === t.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon size={12} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "general" && <GeneralSettings config={config} reload={reload} />}
      {activeTab === "task-statuses" && <ConfigListEditor config={config} reload={reload} type="taskStatuses" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "accentClass", label: "Accent class", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "project-statuses" && <ConfigListEditor config={config} reload={reload} type="projectStatuses" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "badgeClass", label: "Badge class", type: "text" },
        { key: "dotClass", label: "Dot class", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "event-types" && <ConfigListEditor config={config} reload={reload} type="eventTypes" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "dotClass", label: "Dot class", type: "text" },
        { key: "bgClass", label: "BG class", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "tags" && <ConfigListEditor config={config} reload={reload} type="taskTags" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "color", label: "Color (oklch)", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "priorities" && <ConfigListEditor config={config} reload={reload} type="priorities" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "color", label: "Color (oklch)", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "departments" && <ConfigListEditor config={config} reload={reload} type="departments" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "roles" && <RolesEditor config={config} reload={reload} />}
      {activeTab === "notification-templates" && <NotificationTemplatesPanel config={config} reload={reload} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// General workspace settings
// ---------------------------------------------------------------------------

function GeneralSettings({ config, reload }: { config: WorkspaceConfig; reload: () => Promise<void> }) {
  const { workspace } = config;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(workspace);

  async function save() {
    setSaving(true);
    try {
      await updateWorkspaceSettings(form);
      toast.success("Workspace settings updated");
      await reload();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section icon={Settings2} title="General" description="Workspace-level defaults and policies">
      <div className="space-y-4">
        {/* P0-6 (D-05/D-18) — first-run guidance: candidate emails are silently
            recorded as SKIPPED until a mail provider is wired. Surfaced here so
            the workspace admin learns WHY sends never arrive. */}
        {!config.mail.configured && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600"
            data-testid="mail-config-banner"
          >
            <span className="font-semibold">No mail provider configured.</span>{" "}
            Offer, welcome and rejection emails are recorded as <span className="font-semibold">skipped</span> in the audited outbox — nothing is actually delivered.{" "}
            Set <code className="rounded bg-amber-500/15 px-1 py-0.5 text-xs">RESEND_API_KEY</code>{" "}
            (and optionally <code className="rounded bg-amber-500/15 px-1 py-0.5 text-xs">MAIL_FROM</code>) in the server environment to enable delivery.
          </div>
        )}
        <Field label="Workspace name">
          <input className="f-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <FormRow>
          <Field label="Default timezone">
            <input className="f-input" value={form.defaultTimezone} onChange={(e) => setForm({ ...form, defaultTimezone: e.target.value })} />
          </Field>
          <Field label="Default role for new users">
            <select className="f-input" value={form.defaultUserRole} onChange={(e) => setForm({ ...form, defaultUserRole: e.target.value })}>
              {config.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Default department">
            <select className="f-input" value={form.defaultDepartment} onChange={(e) => setForm({ ...form, defaultDepartment: e.target.value })}>
              {config.departments.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Default avatar color">
            <input className="f-input" value={form.defaultAvatarColor} onChange={(e) => setForm({ ...form, defaultAvatarColor: e.target.value })} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Default job title">
            <input className="f-input" value={form.defaultJobTitle} onChange={(e) => setForm({ ...form, defaultJobTitle: e.target.value })} />
          </Field>
          <Field label="Min password length">
            <input type="number" className="f-input" value={form.minPasswordLength} onChange={(e) => setForm({ ...form, minPasswordLength: Number(e.target.value) })} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Workload full capacity (open tasks = 100%)">
            <input type="number" className="f-input" value={form.workloadFullCapacity} onChange={(e) => setForm({ ...form, workloadFullCapacity: Number(e.target.value) })} />
          </Field>
          <Field label="Audit log limit">
            <input type="number" className="f-input" value={form.auditLogLimit} onChange={(e) => setForm({ ...form, auditLogLimit: Number(e.target.value) })} />
          </Field>
        </FormRow>
        <FormRow>
          {/* Deep-dive review F-09 — retention window (days) for pruneAuditLogs.
              Distinct from the display limit above; server clamps to 30–3650. */}
          <Field label="Audit retention (days, min 30)">
            <input
              type="number"
              className="f-input"
              value={form.auditRetentionDays ?? 180}
              onChange={(e) => setForm({ ...form, auditRetentionDays: Number(e.target.value) })}
            />
          </Field>
          {/* P33 (EM-B02) — the retirement-age display knob (the benchmark's
              HR Settings retirement_age). Blank = not configured → the
              directory's profile modal renders no projection; 40–80 bounds
              the age. Display-only: nothing gates on it. */}
          <Field label="Retirement age (years, blank = off)">
            <input
              type="number"
              className="f-input"
              min={40}
              max={80}
              value={form.retirementAge ?? ""}
              data-testid="retirement-age-input"
              onChange={(e) =>
                setForm({
                  ...form,
                  retirementAge: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </Field>
        </FormRow>
        <FormRow>
          {/* F2.10 (F-R9/E5) — the joining gate: markJoined refuses while any
              mandatory document is un-VERIFIED or a background check is
              non-terminal. Default ON (the benchmark's
              required_for_employee_creation discipline). */}
          <label className="flex items-start gap-2.5 text-sm cursor-pointer rounded-md border border-border px-3 py-2.5">
            <input
              type="checkbox"
              className="accent-primary mt-0.5"
              checked={form.joiningGateEnabled ?? true}
              onChange={(e) => setForm({ ...form, joiningGateEnabled: e.target.checked })}
              data-testid="joining-gate-toggle"
            />
            <span>
              <span className="font-medium">Joining gate</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                A candidate can only be marked joined when every mandatory document is VERIFIED and every
                background check is terminal (cleared or flagged). Turn off for the advisory-only flow.
              </span>
            </span>
          </label>
          <div />
        </FormRow>
        <FormRow>
          {/* AT-B02/B03 (S2) — the reference day for attendance late/early
              flags + working hours. The rule is pure (lib/attendance-flags.ts);
              this row owns the instance (policy-as-data). Shifts (F3.5) will
              supersede the reference. */}
          <Field label="Attendance day start (HH:MM)">
            <input
              type="time"
              className="f-input"
              value={form.attendanceDayStart ?? "09:00"}
              onChange={(e) => setForm({ ...form, attendanceDayStart: e.target.value })}
              data-testid="attendance-day-start"
            />
          </Field>
          <Field label="Attendance day end (HH:MM)">
            <input
              type="time"
              className="f-input"
              value={form.attendanceDayEnd ?? "17:30"}
              onChange={(e) => setForm({ ...form, attendanceDayEnd: e.target.value })}
              data-testid="attendance-day-end"
            />
          </Field>
        </FormRow>
        <FormRow>
          {/* PR-B07 (S4) — consider_unmarked_attendance_as. The rule is pure
              (lib/lop-derivation.ts); this row owns the instance. Applies to
              runs created while it is on — existing payslips keep their
              snapshot lopDays. */}
          <Field label="Unmarked attendance days">
            <select
              className="f-input"
              value={form.unmarkedAttendanceMode ?? "IGNORED"}
              onChange={(e) => setForm({ ...form, unmarkedAttendanceMode: e.target.value as "IGNORED" | "ABSENT" })}
              data-testid="unmarked-mode-select"
            >
              <option value="IGNORED">Ignore (never charge loss-of-pay)</option>
              <option value="ABSENT">Count as absent (charge loss-of-pay)</option>
            </select>
          </Field>
          {/* PR-B23 (S7) — the payslip rounding policy. The rule is pure
              (lib/payroll-math.ts withRoundingLine); this row owns the
              instance. Applies to slips created/saved while it is on. */}
          <Field label="Payslip rounding">
            <select
              className="f-input"
              value={form.payrollRoundingMode ?? "ROUND_2DP"}
              onChange={(e) => setForm({ ...form, payrollRoundingMode: e.target.value as "ROUND_2DP" | "ROUND_NET_NEAREST" })}
              data-testid="rounding-mode-select"
            >
              <option value="ROUND_2DP">Two decimals (no rounding line)</option>
              <option value="ROUND_NET_NEAREST">Round net to whole dollars (auto line)</option>
            </select>
          </Field>
          {/* P16 (PR-11) — the fiscal year YTD basis. The rule is pure
              (lib/payroll-windows.ts fiscalYearOf + the payslip-aggregates
              kernel); this row owns the instance. Read-time only — changing
              it re-bases every YTD on the next read, nothing stored moves. */}
          <Field label="Fiscal year starts">
            <select
              className="f-input"
              value={form.fiscalYearStartMonth ?? 1}
              onChange={(e) => setForm({ ...form, fiscalYearStartMonth: Number(e.target.value) })}
              data-testid="fiscal-year-select"
            >
              {[
                [1, "January (calendar year)"],
                [2, "February"],
                [3, "March"],
                [4, "April (NZ fiscal year)"],
                [5, "May"],
                [6, "June"],
                [7, "July"],
                [8, "August"],
                [9, "September"],
                [10, "October"],
                [11, "November"],
                [12, "December"],
              ].map(([m, label]) => (
                <option key={m} value={m}>{label}</option>
              ))}
            </select>
          </Field>
          {/* P17 (PR-B27) — who decides the daily loss-of-pay charge (the
              benchmark's payroll_based_on). The rule is pure
              (lib/lop-derivation.ts basisMode); this row owns the
              instance. Applies to runs created while it is set — existing
              payslips keep their snapshot lopDays; the payslip modal's
              AUTO note names the basis. */}
          <Field label="Loss-of-pay basis">
            <select
              className="f-input"
              value={form.lopBasisMode ?? "HYBRID"}
              onChange={(e) => setForm({ ...form, lopBasisMode: e.target.value as "HYBRID" | "LEAVE" | "ATTENDANCE" })}
              data-testid="lop-basis-select"
            >
              <option value="HYBRID">Hybrid — leave first, then attendance</option>
              <option value="LEAVE">Leave only — attendance marks never charge</option>
              <option value="ATTENDANCE">Attendance only — leave never charges</option>
            </select>
          </Field>
        </FormRow>
        <FormRow>
          {/* P9 (PR-B26) — pay attendance overtime into payroll. The rule is
              pure (lib/overtime-bridge.ts: derived minutes × gross ÷ working
              days ÷ 8h); this row owns the instance. Applies to runs created
              while it is on — existing payslips keep their snapshot lines. */}
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="overtime-pay-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.overtimePayEnabled ?? false}
              onChange={(e) => setForm({ ...form, overtimePayEnabled: e.target.checked })}
            />
            <span>
              <span className="font-medium">Pay attendance overtime into payroll</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                New runs add an "Overtime" earning line per employee — the period&apos;s derived overtime minutes
                (beyond the day end above), priced from the structure&apos;s monthly gross ÷ working days ÷ 8h.
                Applies to runs created while on; existing payslips keep their snapshots.
              </span>
            </span>
          </label>
          {/* P17 (PR-B25) — show each employee's live leave balances on the
              payslip (the benchmark's show_leave_balances_in_salary_slip).
              Read-time on both payslip surfaces (run + my payslips); never
              snapshotted onto the slip, so turning it on/off changes only
              what is displayed, nothing stored moves. */}
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="leave-balances-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.showLeaveBalancesOnSlip ?? false}
              onChange={(e) => setForm({ ...form, showLeaveBalancesOnSlip: e.target.checked })}
            />
            <span>
              <span className="font-medium">Show leave balances on payslips</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                Payslips display each employee&apos;s live leave balances (per type, available days) — read at
                open time, never part of the frozen payslip record. Existing slips show/hide immediately.
              </span>
            </span>
          </label>
        </FormRow>
        <FormRow>
          {/* P18 (PR-B16) — email each payslip when its run locks (the
              benchmark's email_salary_slip_to_employee, narrowed: an HTML
              summary — the PDF itself stays the download-only decision
              §9.2). One PAYSLIP outbox row per slip rides the lock
              transaction; delivery is best-effort and failures show in the
              audited Outbox. Applies to runs locked while it is on. */}
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="payslip-email-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.emailPayslipsOnLock ?? false}
              onChange={(e) => setForm({ ...form, emailPayslipsOnLock: e.target.checked })}
            />
            <span>
              <span className="font-medium">Email payslips when a run locks</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                Locking a run queues one email per payslip — a summary of gross, deductions and net, with a link
                to download the printable PDF under My payslips. Delivery is best-effort and audited in the Outbox;
                the PDF itself is never attached. Applies to runs locked while on.
              </span>
            </span>
          </label>
          {/* P21 (LV-T01/LV-T02) — opt-in leave email notifications (the
              benchmark's Leave Application Pending Approval / Status Update
              notifications, on the P18 rail). One LEAVE_PENDING row per
              resolved approver when a request is created and one
              LEAVE_DECIDED row to the requester on decision; the in-app
              notifications stay unconditional. Best-effort, audited in the
              Outbox. */}
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="leave-email-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.emailLeaveNotifications ?? false}
              onChange={(e) => setForm({ ...form, emailLeaveNotifications: e.target.checked })}
            />
            <span>
              <span className="font-medium">Email leave notifications</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                New leave requests email the resolved approvers, and decisions email the requester — a summary of
                type, dates and duration. Delivery is best-effort and audited in the Outbox; in-app notifications
                stay on regardless. Applies to requests and decisions made while on.
              </span>
            </span>
          </label>
          {/* P31 (LV-J02 / LV-09's remainder) — the encashment auto-draft
              switch (the benchmark's daily generate_leave_encashment job).
              Off by default: drafting encashment requests on members'
              behalf is a workspace policy choice, never a surprise queue
              row. One live draft per (member × encashable type × year); a
              rejection stands for the year. */}
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="auto-encashment-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.autoLeaveEncashment ?? false}
              onChange={(e) => setForm({ ...form, autoLeaveEncashment: e.target.checked })}
            />
            <span>
              <span className="font-medium">Auto-draft leave encashment</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                The daily scheduler drafts one encashment request per member whose balance exceeds the type&apos;s
                non-encashable floor (capped per request, quarter-day steps) — pending in the HR queue, payout next
                month. One live draft per member and type; a rejection stands for the year.
              </span>
            </span>
          </label>
          {/* P25 (PL-02/EM-23) — the engagement reminder switches (the
              benchmark HR Settings' reminders block, incl. its
              stop-birthday-reminders field). The three in-app digests fire
              from the daily scheduler's engagement pass — no scheduler, no
              rows; the email rail is opt-in like every routine mail. */}
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="birthday-reminders-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.remindBirthdays ?? true}
              onChange={(e) => setForm({ ...form, remindBirthdays: e.target.checked })}
            />
            <span>
              <span className="font-medium">Birthday reminders</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                A daily in-app digest lists the members whose birthday it is (needs the scheduler&apos;s engagement
                pass; switch it off for nobody&apos;s birthday to be broadcast).
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="anniversary-reminders-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.remindAnniversaries ?? true}
              onChange={(e) => setForm({ ...form, remindAnniversaries: e.target.checked })}
            />
            <span>
              <span className="font-medium">Work-anniversary reminders</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                A daily in-app digest lists the members marking whole years since their hire date.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="holiday-reminders-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.remindHolidays ?? true}
              onChange={(e) => setForm({ ...form, remindHolidays: e.target.checked })}
            />
            <span>
              <span className="font-medium">Upcoming-holiday reminders</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                An in-app digest fires exactly N days before each public holiday — one notice per holiday, never a
                daily countdown.
              </span>
            </span>
          </label>
          <Field label="Holiday reminder — days ahead" className="max-w-xs">
            <input
              type="number"
              min={1}
              max={30}
              className="f-input"
              value={form.holidayReminderDaysAhead ?? 7}
              data-testid="holiday-days-ahead-input"
              onChange={(e) => setForm({ ...form, holidayReminderDaysAhead: Number(e.target.value) })}
            />
          </Field>
          {/* P25 — the EMAIL half of the engagement engine: one digest outbox
              row per live member per due event, rendered through the
              notification template registry (Settings → Notifications).
              Default OFF = the zero-mail posture. */}
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="engagement-email-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.emailEngagementReminders ?? false}
              onChange={(e) => setForm({ ...form, emailEngagementReminders: e.target.checked })}
            />
            <span>
              <span className="font-medium">Email engagement reminders</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                Birthday, work-anniversary and upcoming-holiday digests also email every member (best-effort,
                audited in the Outbox; one email per member per digest). Off = in-app only.
              </span>
            </span>
          </label>
          {/* P26 (PL-03/RJ-B18) — the interview reminder switches. The in-app
              nudge fires from the daily scheduler's interview pass — one
              personal notification per interviewer per same-day scheduled
              interview; the email rail is opt-in like every routine mail. */}
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="interview-reminders-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.remindInterviews ?? true}
              onChange={(e) => setForm({ ...form, remindInterviews: e.target.checked })}
            />
            <span>
              <span className="font-medium">Interview reminders</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                Interviewers get an in-app nudge on the morning of each scheduled interview (needs the scheduler&apos;s
                daily pass; one notification per interview, never a broadcast).
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer" data-testid="interview-email-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.emailInterviewReminders ?? false}
              onChange={(e) => setForm({ ...form, emailInterviewReminders: e.target.checked })}
            />
            <span>
              <span className="font-medium">Email interview reminders</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                The day-of interview nudges also email the interviewer (best-effort, audited in the Outbox; one email
                per newly nudged interview). Off = in-app only.
              </span>
            </span>
          </label>
        </FormRow>
        <div className="flex justify-end pt-2">
          <button onClick={save} disabled={saving} className="f-btn f-btn-primary f-btn-sm">
            {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : <><Save size={14} /> Save settings</>}
          </button>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Generic config list editor — handles all 6 domain-enum tables
// ---------------------------------------------------------------------------

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number";
}

function ConfigListEditor({
  config,
  reload,
  type,
  labelKey,
  fields,
}: {
  config: WorkspaceConfig;
  reload: () => Promise<void>;
  type: keyof WorkspaceConfig;
  labelKey: string;
  fields: FieldDef[];
}) {
  const items = config[type] as unknown as Array<Record<string, unknown> & { id?: string }>;
  // The server-action signature already constrains `table` to the literal
  // union of the six config tables. Mirror that union here so the call
  // sites don't need `as any` to satisfy it.
  type ConfigTable =
    | "taskStatusConfig"
    | "projectStatusConfig"
    | "eventTypeConfig"
    | "taskTagConfig"
    | "priorityConfig"
    | "departmentConfig";
  const tableMap: Record<keyof WorkspaceConfig, ConfigTable> = {
    taskStatuses: "taskStatusConfig",
    projectStatuses: "projectStatusConfig",
    eventTypes: "eventTypeConfig",
    taskTags: "taskTagConfig",
    priorities: "priorityConfig",
    departments: "departmentConfig",
    // WorkspaceConfig carries five more keys that this editor never
    // reaches (workspace settings, the computed mail section, the P24
    // notification templates, and role/permission management have their
    // own editors/surfaces). The record must still be exhaustive; we map
    // them to a placeholder table that will never be hit at runtime.
    workspace: "taskStatusConfig",
    mail: "taskStatusConfig",
    roles: "taskStatusConfig",
    permissions: "taskStatusConfig",
    notificationTemplates: "taskStatusConfig",
  };
  const table: ConfigTable = tableMap[type];

  const [editing, setEditing] = useState<string | null>(null);
  const [newItem, setNewItem] = useState<Record<string, unknown>>({});
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSave(id: string, data: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await updateConfigItem(table, id, data);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Updated");
      setEditing(null);
      // Refresh config + server-component props (replaces the buggy
      // `Object.assign(config, fresh.data)` mutation that React never saw).
      await reload();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to update"));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    setSaving(true);
    try {
      const res = await createConfigItem(table, { ...newItem, isVisible: true });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Created");
      setNewItem({});
      setShowNew(false);
      await reload();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to create"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this config item?")) return;
    setSaving(true);
    try {
      const res = await deleteConfigItem(table, id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Deleted");
      await reload();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to delete"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{items.length} items</p>
        <button onClick={() => setShowNew(!showNew)} className="f-btn f-btn-secondary f-btn-sm">
          <Plus size={14} /> Add item
        </button>
      </div>

      {/* New item form */}
      {showNew && (
        <div className="f-card p-4 space-y-3 border-primary/30">
          <h4 className="text-xs font-semibold text-foreground">New item</h4>
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <Field key={f.key} label={f.label}>
                <input
                  type={f.type}
                  className="f-input"
                  value={(newItem[f.key] as string | number | undefined) ?? ""}
                  onChange={(e) => setNewItem({
                    ...newItem,
                    [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value,
                  })}
                />
              </Field>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowNew(false)} className="f-btn f-btn-ghost f-btn-sm">Cancel</button>
            <button onClick={handleCreate} disabled={saving} className="f-btn f-btn-primary f-btn-sm">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create
            </button>
          </div>
        </div>
      )}

      {/* Items list */}
      <div className="f-card overflow-hidden">
        {items.map((item, i) => {
          const id = item.id ?? `idx-${i}`;
          const isEditing = editing === id;
          return (
            <div key={id} className="border-b border-border last:border-0">
              {isEditing ? (
                <ConfigItemEditor
                  item={item}
                  fields={fields}
                  onSave={(data) => handleSave(id, data)}
                  onCancel={() => setEditing(null)}
                  saving={saving}
                />
              ) : (
                <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30">
                  <span className="text-sm font-medium text-foreground flex-1">{String(item[labelKey])}</span>
                  {Boolean(item.color) && (
                    <span className="w-4 h-4 rounded-full border border-border" style={{ background: String(item.color) }} />
                  )}
                  {Boolean(item.accentClass || item.dotClass) && (
                    <span className={cn("w-3 h-3 rounded-full", String(item.accentClass || item.dotClass))} />
                  )}
                  <span className="text-[0.625rem] text-muted-foreground font-mono">{String(item.key)}</span>
                  <button onClick={() => setEditing(id)} className="text-xs text-primary hover:underline">Edit</button>
                  <button onClick={() => handleDelete(id)} className="text-xs text-destructive hover:underline">Delete</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfigItemEditor({
  item,
  fields,
  onSave,
  onCancel,
  saving,
}: {
  item: Record<string, unknown>;
  fields: FieldDef[];
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [data, setData] = useState(item);
  return (
    <div className="p-4 space-y-3 bg-muted/20">
      <div className="grid grid-cols-2 gap-3">
        {fields.map((f) => (
          <Field key={f.key} label={f.label}>
            <input
              type={f.type}
              className="f-input"
              value={String(data[f.key] ?? "")}
              onChange={(e) => setData({
                ...data,
                [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value,
              })}
            />
          </Field>
        ))}
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="f-btn f-btn-ghost f-btn-sm">Cancel</button>
        <button onClick={() => onSave(data)} disabled={saving} className="f-btn f-btn-primary f-btn-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles editor — permission matrix with checkboxes
// ---------------------------------------------------------------------------

function RolesEditor({ config, reload }: { config: WorkspaceConfig; reload: () => Promise<void> }) {
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);

  // Group permissions by group
  const permGroups = config.permissions.reduce<Record<string, typeof config.permissions>>((acc, p) => {
    (acc[p.group] ||= []).push(p);
    return acc;
  }, {});

  async function handlePermissionToggle(roleId: string, role: typeof config.roles[0], permKey: string) {
    const newPerms = role.permissions.includes(permKey)
      ? role.permissions.filter((p) => p !== permKey)
      : [...role.permissions, permKey];
    setSaving(true);
    try {
      const res = await updateRole(roleId, { permissions: newPerms });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Permissions updated");
      await reload();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to update"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRole(roleId: string, label: string) {
    if (!confirm(`Delete role "${label}"?`)) return;
    setSaving(true);
    try {
      const res = await deleteRole(roleId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Role deleted");
      await reload();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to delete"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {config.roles.length} roles · {config.permissions.length} permissions · System roles can't be deleted
        </p>
        <button onClick={() => setShowNew(!showNew)} className="f-btn f-btn-secondary f-btn-sm">
          <Plus size={14} /> Add role
        </button>
      </div>

      {/* New role form */}
      {showNew && <NewRoleForm config={config} reload={reload} onDone={() => setShowNew(false)} />}

      {/* Roles list with permission matrix */}
      {config.roles.map((role) => (
        <div key={role.id} className="f-card overflow-hidden">
          {/* Role header */}
          <div className="flex items-center gap-3 p-4 border-b border-border">
            <span className={cn("f-badge", role.badgeClass)}>{role.label}</span>
            {role.isSystem && <span className="text-[0.625rem] text-muted-foreground">system</span>}
            <span className="text-xs text-muted-foreground flex-1">{role.description}</span>
            <span className="text-[0.625rem] text-muted-foreground">{role.permissions.length} perms</span>
            <button onClick={() => setEditingRole(editingRole === role.id ? null : role.id)} className="text-xs text-primary hover:underline">
              {editingRole === role.id ? "Close" : "Edit permissions"}
            </button>
            {!role.isSystem && (
              <button onClick={() => handleDeleteRole(role.id, role.label)} disabled={saving} className="text-xs text-destructive hover:underline">
                Delete
              </button>
            )}
          </div>

          {/* Permission matrix */}
          {editingRole === role.id && (
            <div className="p-4 space-y-4 f-view-enter">
              {Object.entries(permGroups).map(([group, perms]) => (
                <div key={group}>
                  <h4 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{group}</h4>
                  <div className="space-y-1">
                    {perms.map((p) => {
                      const checked = role.permissions.includes(p.key);
                      return (
                        <label key={p.key} className="flex items-center gap-3 py-1.5 cursor-pointer hover:bg-muted/30 rounded px-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handlePermissionToggle(role.id, role, p.key)}
                            disabled={saving}
                            className="accent-[var(--primary)]"
                          />
                          <div className="flex-1">
                            <div className="text-xs font-medium text-foreground">{p.label}</div>
                            <div className="text-[0.625rem] text-muted-foreground">{p.description}</div>
                          </div>
                          <code className="text-[0.625rem] text-muted-foreground/60">{p.key}</code>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function NewRoleForm({ config, reload, onDone }: { config: WorkspaceConfig; reload: () => Promise<void>; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!key.trim() || !label.trim()) {
      toast.error("Key and label are required");
      return;
    }
    setSaving(true);
    try {
      const res = await createRole({
        key: key.trim().toUpperCase().replace(/\s+/g, "_"),
        label: label.trim(),
        description,
        permissions,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Role created");
      await reload();
      onDone();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to create role"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="f-card p-4 space-y-3 border-primary/30">
      <h4 className="text-xs font-semibold text-foreground">New role</h4>
      <FormRow>
        <Field label="Key (e.g. REVIEWER)">
          <input className="f-input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="REVIEWER" />
        </Field>
        <Field label="Label (e.g. Reviewer)">
          <input className="f-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Reviewer" />
        </Field>
      </FormRow>
      <Field label="Description">
        <input className="f-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Can review tasks but not delete them" />
      </Field>
      <div>
        <label className="block text-xs font-medium text-foreground mb-1.5">Permissions</label>
        <div className="max-h-40 overflow-y-auto f-scroll space-y-1 border border-border rounded-lg p-2">
          {config.permissions.map((p) => (
            <label key={p.key} className="flex items-center gap-2 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={permissions.includes(p.key)}
                onChange={() => setPermissions(permissions.includes(p.key) ? permissions.filter((x) => x !== p.key) : [...permissions, p.key])}
                className="accent-[var(--primary)]"
              />
              <span className="font-medium text-foreground">{p.label}</span>
              <span className="text-muted-foreground">— {p.group}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onDone} className="f-btn f-btn-ghost f-btn-sm">Cancel</button>
        <button onClick={create} disabled={saving} className="f-btn f-btn-primary f-btn-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create role
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// P24 (PL-01) — Notification templates (the master editor)
//
// One card per registry event. A card with no override row starts from the
// BUILT-IN default templates ({{placeholders}} visible — the admin edits
// from the real text); Save upserts the override row, Reset deletes it.
// The live preview renders locally with the registry's sample values — no
// server round-trip, and the exact renderer the writers use (the pure
// renderTemplate kernel is shared client/server).
// ---------------------------------------------------------------------------

function NotificationTemplatesPanel({ config, reload }: { config: WorkspaceConfig; reload: () => Promise<void> }) {
  return (
    <Section icon={Bell} title="Notification templates" description="Customize what Fernly writes in its notifications — every event without a customization uses the system default.">
      <div className="space-y-5">
        {NOTIFICATION_TEMPLATE_EVENTS.map((def) => (
          <NotificationTemplateCard
            // The key flips when the override state changes (system default ↔
            // customized): the card REMOUNTS and its form re-initializes from
            // the fresh row/default — the reset-without-an-effect pattern
            // (lint forbids setState-in-effect; identity-stable otherwise, so
            // unrelated re-renders never clobber the admin's edits).
            key={`${def.eventKey}:${config.notificationTemplates.find((t) => t.eventKey === def.eventKey) ? "custom" : "default"}`}
            def={def}
            row={config.notificationTemplates.find((t) => t.eventKey === def.eventKey) ?? null}
            reload={reload}
          />
        ))}
        <p className="text-xs text-muted-foreground">
          Emails ride the workspace&apos;s opt-in toggles (leave email, payslip email — Settings → General); in-app
          notifications are always on. Placeholders use {"{{name}}"} — the chips above each field list what the event
          provides, and saving refuses an unknown name so a typo can never blank a field.
        </p>
      </div>
    </Section>
  );
}

function NotificationTemplateCard({
  def,
  row,
  reload,
}: {
  def: NotificationTemplateEventDef;
  row: { eventKey: string; subjectTemplate: string; bodyTemplate: string; titleTemplate: string; messageTemplate: string } | null;
  reload: () => Promise<void>;
}) {
  const [form, setForm] = useState(() => ({
    subject: row?.subjectTemplate ?? def.defaults.subject,
    body: row?.bodyTemplate ?? def.defaults.body,
    title: row?.titleTemplate ?? def.defaults.title,
    message: row?.messageTemplate ?? def.defaults.message,
  }));
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  // No effect re-seeding the form: the parent's key flip (see above) remounts
  // this card after every save/reset, re-initializing the form from the
  // fresh row/default — and the saved values equal what the admin typed.

  const samples = sampleTemplateVars(def.eventKey);
  const preview = {
    subject: renderTemplate(form.subject, samples),
    title: renderTemplate(form.title, samples),
    message: renderTemplate(form.message, samples),
  };

  async function save() {
    setSaving(true);
    try {
      const res = await updateNotificationTemplate({ eventKey: def.eventKey, ...form });
      if (!res.ok) throw new Error(res.error);
      toast.success(`“${def.label}” template saved`);
      await reload();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to save the template"));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setResetting(true);
    try {
      const res = await resetNotificationTemplate({ eventKey: def.eventKey });
      if (!res.ok) throw new Error(res.error);
      toast.success(`“${def.label}” reset to the system default`);
      await reload();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to reset the template"));
    } finally {
      setResetting(false);
    }
  }

  const variableChip = (name: string, description: string) => (
    <span
      key={name}
      title={description}
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.6875rem] font-mono bg-muted text-muted-foreground border border-border cursor-help"
    >
      {`{{${name}}}`}
    </span>
  );

  return (
    <div
      className="rounded-lg border border-border p-4 space-y-3"
      data-testid={`notification-template-card-${def.eventKey}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{def.label}</span>
            <span className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">{def.eventKey}</span>
            <span
              className={`text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full border ${
                row ? "bg-violet-500/10 text-violet-600 border-violet-500/30" : "bg-muted text-muted-foreground border-border"
              }`}
              data-testid={`tpl-badge-${def.eventKey}`}
            >
              {row ? "Customized" : "System default"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-xl">{def.description} Channels: {def.channels}.</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={reset}
            disabled={resetting || !row}
            className="f-btn f-btn-ghost f-btn-sm"
            data-testid={`tpl-reset-${def.eventKey}`}
            title={row ? "Delete the customization — the event falls back to the system default" : "Nothing to reset — the system default is already in force"}
          >
            {resetting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Reset
          </button>
          <button onClick={save} disabled={saving} className="f-btn f-btn-primary f-btn-sm" data-testid={`tpl-save-${def.eventKey}`}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {def.variables.map((v) => variableChip(v.name, v.description))}
      </div>

      <FormRow>
        <Field label="In-app title">
          <input
            className="f-input font-mono text-xs"
            value={form.title}
            maxLength={250}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            data-testid={`tpl-title-${def.eventKey}`}
          />
        </Field>
        <Field label="Email subject">
          <input
            className="f-input font-mono text-xs"
            value={form.subject}
            maxLength={250}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            data-testid={`tpl-subject-${def.eventKey}`}
          />
        </Field>
      </FormRow>
      <Field label="In-app message">
        <textarea
          className="f-input min-h-16 font-mono text-xs"
          value={form.message}
          maxLength={1000}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          data-testid={`tpl-message-${def.eventKey}`}
        />
      </Field>
      <Field label="Email body (plain text — the Outbox audit copy)">
        <textarea
          className="f-input min-h-32 font-mono text-xs"
          value={form.body}
          maxLength={5000}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          data-testid={`tpl-body-${def.eventKey}`}
        />
      </Field>

      {/* Live preview — the shared renderer with the registry's samples. */}
      <div className="rounded-md bg-muted/50 border border-border p-3 space-y-1.5">
        <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground">Preview (sample values)</div>
        <div className="text-sm font-semibold text-foreground" data-testid={`tpl-preview-title-${def.eventKey}`}>{preview.title}</div>
        <div className="text-sm text-foreground" data-testid={`tpl-preview-message-${def.eventKey}`}>{preview.message}</div>
      </div>
    </div>
  );
}
