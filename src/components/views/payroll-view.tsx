"use client";

// Recruitment R7 — the Payroll view (docs/RECRUITMENT_MODULE_PLAN.md §5).
// ADMIN + HR only (payroll:manage gates the nav leaf AND every action):
//   • Runs — one per month, OPEN (editable payslips) → LOCKED (paid,
//     immutable). Creating a run snapshots every active salary structure.
//   • Payslips — per-employee monthly lines (earnings/deductions, pro-rated
//     LOP) editable while OPEN; the slip number + YTD net ride along.
//   • Structures — per-employee annual salary components (÷12 for the
//     monthly gross), copied from the signed offer or entered manually.

import { useCallback, useEffect, useState } from "react";
import { Award, Banknote, BarChart3, BookOpen, CalendarPlus, CircleDollarSign, Download, FileText, HeartPulse, Landmark, Layers, Loader2, Lock, Pause, Plus, RotateCcw, Scale, ShieldAlert, Undo2, Users, Wallet } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { PayrollRunT, PayslipT, SalaryStructureT } from "@/lib/types";
import {
  createPayrollRun,
  getPayrollAnalytics,
  getPayrollData,
  getPayrollRun,
  lockPayrollRun,
  applyPayAdjustmentsToRun,
  exportPayrollRunCsv,
} from "@/server-actions/payroll";
import { computeOffer, formatMoney } from "@/lib/offer-math";
// P10 — the pure windows kernel drives the new-run form's live preview and
// the client-side period label for run rows (same functions the server
// resolves with — one authority).
import {
  PAYROLL_FREQUENCY_OPTIONS,
  payrollPeriodLabel,
  resolvePayrollWindow,
  type PayrollFrequency,
} from "@/lib/payroll-windows";
import { StructureModal } from "../ui/structure-modal";
import { PayslipModal } from "../ui/payslip-modal";
import { ComponentCatalogModal } from "../ui/component-catalog-modal";
import { PayAdjustmentModal } from "../ui/pay-adjustment-modal";
import { ArrearsModal } from "../ui/arrears-modal";
import { LwpCorrectionModal } from "../ui/lwp-correction-modal";
import { BenefitsModal } from "../ui/benefits-modal";
import { RetentionBonusModal } from "../ui/retention-bonus-modal";
import { GratuityRuleModal } from "../ui/gratuity-rule-modal";
import { WithholdingModal } from "../ui/withholding-modal";
import { BulkStructureModal } from "../ui/bulk-structure-modal";
import { getDirectory } from "@/server-actions/hr-directory";
// P22 (PR-C01–04, PR-N01–06) — the analytics payload type + the shared
// dependency-free SVG chart pair (recharts stays in the lazy Analytics chunk —
// L-P1-17 bundle budget) + the StatCard the six number cards ride.
import type { PayrollAnalytics } from "@/lib/payroll-analytics";
import { TrendChart, BarListChart } from "../ui/svg-charts";
import { StatCard } from "../ui/stat-card";

function money(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthLabel(period: string): string {
  return payrollPeriodLabel(period);
}

export function PayrollView({ currentUser }: { currentUser: { id: string; name: string; role: string } }) {
  const [structures, setStructures] = useState<SalaryStructureT[]>([]);
  const [runs, setRuns] = useState<PayrollRunT[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [payslips, setPayslips] = useState<PayslipT[]>([]);
  const [payslipsRun, setPayslipsRun] = useState<PayrollRunT | null>(null);
  const [unmarkedMode, setUnmarkedMode] = useState<"IGNORED" | "ABSENT">("IGNORED");
  const [roundingMode, setRoundingMode] = useState<"ROUND_2DP" | "ROUND_NET_NEAREST">("ROUND_2DP");
  // P17 (PR-B27) — the current proration basis, for the modal's AUTO note.
  const [lopBasisMode, setLopBasisMode] = useState<"HYBRID" | "LEAVE" | "ATTENDANCE">("HYBRID");
  const [openPayslip, setOpenPayslip] = useState<PayslipT | null>(null);
  const [structureModalOpen, setStructureModalOpen] = useState(false);
  const [editStructure, setEditStructure] = useState<SalaryStructureT | null>(null);
  // F1.5 — the component catalog manager (same permission surface).
  const [catalogOpen, setCatalogOpen] = useState(false);
  // P1 (F2.3) — the adjustment adapter panel + the explicit apply action.
  const [adjustmentModalOpen, setAdjustmentModalOpen] = useState(false);
  const [applyingAdjustments, setApplyingAdjustments] = useState(false);
  // P3 (F3.1) — the arrears reverse-simulation (LOCKED runs only).
  const [arrearsRun, setArrearsRun] = useState<PayrollRunT | null>(null);
  // P4 (F3.1) — the LWP correction reversal (LOCKED slips with LOP only).
  const [lwpSlip, setLwpSlip] = useState<PayslipT | null>(null);
  // P5 (F3.2) — the flexible-benefits panel.
  const [benefitsOpen, setBenefitsOpen] = useState(false);
  // P6 (PR-20/PR-23) — the retention-bonus writer.
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [gratuityOpen, setGratuityOpen] = useState(false);
  const [withholdingOpen, setWithholdingOpen] = useState(false);
  const [newFrequency, setNewFrequency] = useState<PayrollFrequency>("MONTHLY");
  const [newAnchorDate, setNewAnchorDate] = useState(() => new Date().toISOString().slice(0, 10));
  // P14 (PR-04) — the run's optional employee filter (empty = every active
  // structure of the cadence).
  const [runFilterUserIds, setRunFilterUserIds] = useState<Set<string>>(new Set());
  // P14 (PR-33) — the bulk structure assignment modal.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lockConfirmId, setLockConfirmId] = useState<string | null>(null);
  // The employee picker lists every account (not just those with structures).
  const [employees, setEmployees] = useState<{ userId: string; name: string }[]>([]);
  // P22 (PR-C01–04, PR-N01–06) — the read-time analytics payload (four charts
  // + six cards; LOCKED-run basis, refreshed on every load()).
  const [analytics, setAnalytics] = useState<PayrollAnalytics | null>(null);

  const load = useCallback(async () => {
    const res = await getPayrollData();
    if (res.ok) {
      setStructures(res.data.structures);
      setRuns(res.data.runs);
      // Keep a valid selection across reloads (default: newest run).
      setSelectedRunId((prev) => {
        const still = prev ? res.data.runs.find((r) => r.id === prev) : null;
        return still ? prev : res.data.runs[0]?.id ?? null;
      });
    } else {
      toast.error(res.error);
    }
    // P22 — the analytics panel refreshes with the same reload (read-time,
    // locked-run basis; a failed fetch leaves the last good panel up).
    const an = await getPayrollAnalytics();
    if (an.ok) setAnalytics(an.data);
    const dir = await getDirectory();
    if (dir.ok) setEmployees(dir.data.profiles.map((p) => ({ userId: p.userId, name: p.name })));
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const loadPayslips = useCallback(async (runId: string) => {
    const res = await getPayrollRun(runId);
    if (res.ok) {
      setPayslips(res.data.payslips);
      setPayslipsRun(res.data.run);
      // PR-B07 (S4) — the current workspace policy explains the AUTO note
      // in the payslip modal (the derivation itself is a creation-time
      // snapshot; the note states the policy, not a re-derivation). P17
      // (PR-B27) — the proration basis rides the same payload.
      setUnmarkedMode(res.data.unmarkedMode);
      setRoundingMode(res.data.roundingMode);
      setLopBasisMode(res.data.lopBasisMode);
    } else {
      toast.error(res.error);
      setPayslips([]);
      setPayslipsRun(null);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (selectedRunId) void loadPayslips(selectedRunId); }, [selectedRunId, loadPayslips]);

  const activeStructureCount = structures.filter((s) => s.isActive).length;

  // P10 — the live preview of the window the server WOULD resolve (the same
  // pure kernel the action runs; the server stays the authority).
  const previewWindow = resolvePayrollWindow(newFrequency, newAnchorDate);

  const createRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!previewWindow) { toast.error("Pick a valid anchor date."); return; }
    setBusy(true);
    const res = await createPayrollRun({
      frequency: newFrequency,
      anchorDate: newAnchorDate,
      ...(runFilterUserIds.size > 0 ? { userIds: [...runFilterUserIds] } : {}),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Run for ${previewWindow.periodKey} created — ${res.data.payslipCount} payslips from the active ${newFrequency.toLowerCase()} structures${runFilterUserIds.size > 0 ? ` (filtered to ${runFilterUserIds.size} employee(s))` : ""}${res.data.adjustmentsApplied > 0 ? `, ${res.data.adjustmentsApplied} adjustment(s) consumed` : ""}${res.data.adjustmentsSkipped > 0 ? `, ${res.data.adjustmentsSkipped} skipped` : ""}.`);
    // P13 (PR-B14/PR-09) — the loud failure summary: payslips beyond the
    // first 30 are isolated per slip, so a failure never aborts the run —
    // it is listed here instead (fix the cause, then add the payslip).
    // Defensive read: an older action result shape carries no failures.
    const failures = res.data.failures ?? [];
    if (failures.length > 0) {
      toast.error(
        `${failures.length} payslip(s) failed: ${failures.map((f) => `${f.slipNo} — ${f.reason}`).join("; ")}. Fix the cause, then add the payslip(s) to the OPEN run.`,
        { duration: 10_000 },
      );
    }
    setSelectedRunId(null);
    await load();
    // Select the fresh run (the newest one for that window).
    const runsRes = await getPayrollData();
    if (runsRes.ok) {
      const fresh = runsRes.data.runs.find((r) => r.period === previewWindow.periodKey);
      if (fresh) setSelectedRunId(fresh.id);
    }
  };

  const lockRun = async (runId: string) => {
    setBusy(true);
    const res = await lockPayrollRun({ runId });
    setBusy(false);
    setLockConfirmId(null);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Run locked — the period is paid and immutable.");
    await load();
    if (selectedRunId === runId) await loadPayslips(runId);
  };

  // P20 (PR-R01/PR-R02) — the per-run CSV exports (LOCKED only server-side;
  // the buttons live on LOCKED rows). The action returns the built file;
  // the download itself is the analytics pattern (Blob + anchor click).
  const exportCsv = async (runId: string, period: string, kind: "REGISTER" | "BANK_REMITTANCE") => {
    setBusy(true);
    const res = await exportPayrollRunCsv({ runId, kind });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    const blob = new Blob([res.data.csv], { type: res.data.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.data.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${kind === "REGISTER" ? "Salary register" : "Bank remittance"} for ${period} exported (${res.data.filename}).`);
  };

  // P1 — the explicit application: adjustments queued AFTER the run was
  // created land through this button (never silently on a read).
  const applyAdjustments = async (runId: string, period: string) => {
    setApplyingAdjustments(true);
    const res = await applyPayAdjustmentsToRun({ runId });
    setApplyingAdjustments(false);
    if (!res.ok) { toast.error(res.error); return; }
    if (res.data.applied === 0 && res.data.skipped === 0) {
      toast.info(`No pending adjustments for ${period}.`);
      return;
    }
    toast.success(`${res.data.applied} adjustment(s) applied to ${res.data.slipsTouched} payslip(s)${res.data.skipped > 0 ? `, ${res.data.skipped} skipped with reason` : ""}.`);
    await loadPayslips(runId);
    await load();
  };

  return (
    <div className="p-6 space-y-5" data-testid="payroll-view">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Landmark size={20} /> Payroll
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {runs.length} run{runs.length === 1 ? "" : "s"} · {activeStructureCount} active structure{activeStructureCount === 1 ? "" : "s"} · signed in as {currentUser.name}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="f-btn f-btn-ghost" onClick={() => setCatalogOpen(true)} data-testid="component-catalog-btn">
            <BookOpen size={15} /> Component catalog
          </button>
          <button className="f-btn f-btn-ghost" onClick={() => setAdjustmentModalOpen(true)} data-testid="adjustments-btn">
            <CircleDollarSign size={15} /> Adjustments
          </button>
          <button className="f-btn f-btn-ghost" onClick={() => setBenefitsOpen(true)} data-testid="benefits-btn">
            <HeartPulse size={15} /> Benefits
          </button>
          <button className="f-btn f-btn-ghost" onClick={() => setRetentionOpen(true)} data-testid="retention-btn">
            <Award size={15} /> Retention bonus
          </button>
          <button className="f-btn f-btn-ghost" onClick={() => setGratuityOpen(true)} data-testid="gratuity-btn">
            <Scale size={15} /> Gratuity rule
          </button>
          <button className="f-btn f-btn-ghost" onClick={() => setWithholdingOpen(true)} data-testid="withholding-btn">
            <Pause size={15} /> Withholding
          </button>
          <button className="f-btn f-btn-ghost" onClick={() => { setEditStructure(null); setStructureModalOpen(true); }} data-testid="new-structure-btn">
            <Plus size={15} /> Salary structure
          </button>
        </div>
      </div>

      {/* D-06 (P0-3, persona-audit) — statutory positioning, stated where
          payroll is used. The honest scope of this console: gross → net from
          structures + manual deduction lines; statutory computation (PF/ESI/
          PT/TDS, Form 16, declarations) is deliberately NOT built — the
          decision record is docs/DECISIONS.md ADR-014. Permanent (not
          env-gated): the scope statement must be visible in every demo.
          The parent's space-y-5 provides the gap to the form below. */}
      <div
        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 flex items-start gap-2"
        data-testid="statutory-scope-banner"
      >
        <Scale size={14} className="shrink-0 mt-0.5" />
        <span>
          <span className="font-semibold">Pre-statutory payroll.</span>{" "}
          Fernly computes gross → net from your structures and manual deduction lines — it does{" "}
          <span className="font-semibold">not</span> compute or file statutory amounts (PF, ESI, professional
          tax, TDS, Form 16, investment declarations). Enter statutory deductions as manual lines or run
          them through your compliance provider. Decision record: <span className="font-mono text-xs">docs/DECISIONS.md</span> (ADR-014).
        </span>
      </div>

      {/* P22 (PR-C01–04, PR-N01–06) — the analytics panel: the four benchmark
          payroll charts + the six number cards, read-time over LOCKED runs only
          (draft money never reaches an analytics surface — the same
          published-only basis as payslip self-service). The two statutory cards
          render "—" with the ADR-014 note instead of a misleading zero. */}
      {analytics && (
        <div className="rounded-lg border border-border" data-testid="payroll-analytics">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border flex-wrap">
            <BarChart3 size={14} className="text-sky-500" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Analytics</div>
            <span className="text-xs text-muted-foreground ml-auto" data-testid="analytics-window-note">
              {analytics.cards.outgoingSalaryMonths > 0
                ? `last ${analytics.cards.outgoingSalaryMonths} paid month${analytics.cards.outgoingSalaryMonths === 1 ? "" : "s"} · disbursed net (held money excluded)`
                : "no locked runs yet — analytics appear once a run is paid"}
            </span>
          </div>
          <div className="p-4 space-y-5">
            {/* PR-N01–06 — the six number cards. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3" data-testid="payroll-analytics-cards">
              <StatCard
                icon={Banknote}
                value={money(analytics.cards.totalOutgoingSalary)}
                label={`Outgoing salary · ${analytics.cards.outgoingSalaryMonths} month${analytics.cards.outgoingSalaryMonths === 1 ? "" : "s"}`}
                iconColor="text-emerald-600"
                iconBg="bg-emerald-500/10"
              />
              <StatCard
                icon={Layers}
                value={analytics.cards.totalSalaryStructures}
                label="Active salary structures"
                iconColor="text-sky-600"
                iconBg="bg-sky-500/10"
              />
              <StatCard
                icon={HeartPulse}
                value={money(analytics.cards.benefitClaimsTotal)}
                label={`Benefit claims · ${analytics.cards.benefitClaimsCount} claim${analytics.cards.benefitClaimsCount === 1 ? "" : "s"}`}
                iconColor="text-violet-600"
                iconBg="bg-violet-500/10"
              />
              <StatCard
                icon={ShieldAlert}
                value="—"
                label="Tax exemption proofs · statutory, declined (ADR-014)"
                iconColor="text-amber-600"
                iconBg="bg-amber-500/10"
              />
              <StatCard
                icon={FileText}
                value="—"
                label="Declarations submitted · statutory, declined (ADR-014)"
                iconColor="text-amber-600"
                iconBg="bg-amber-500/10"
              />
              <StatCard
                icon={Award}
                value={money(analytics.cards.incentiveTotal)}
                label={`Incentives given · ${analytics.cards.incentiveCount} row${analytics.cards.incentiveCount === 1 ? "" : "s"}`}
                iconColor="text-orange-600"
                iconBg="bg-orange-500/10"
              />
            </div>
            {/* PR-C01 / PR-C04 — the two month trends. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs font-semibold mb-2">Outgoing salary (disbursed net / month)</div>
                <TrendChart
                  title="Outgoing salary — disbursed net per month"
                  points={analytics.outgoing.map((m) => ({ label: m.label, value: m.net }))}
                  formatValue={(n) => money(n)}
                  emptyHint="No locked runs yet — the trend appears once a run is paid."
                  testId="chart-outgoing-salary"
                />
              </div>
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs font-semibold mb-2">Benefit claims ($ / month)</div>
                <TrendChart
                  title="Benefit claims — claimed amount per month"
                  points={analytics.benefitClaims.map((m) => ({ label: m.label, value: m.amount }))}
                  formatValue={(n) => money(n)}
                  color="#8b5cf6"
                  fill="rgba(139,92,246,0.12)"
                  emptyHint="No benefit claims yet — elect benefits and file a claim to see the trend."
                  testId="chart-benefit-claims"
                />
              </div>
            </div>
            {/* PR-C02 / PR-C03 — the latest-paid-month slices (the anchor rides
                each panel's header so the window is always stated). */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs font-semibold mb-2" data-testid="dept-salary-header">
                  Salary by department
                  {analytics.departmentSalary.anchorMonth && (
                    <span className="ml-2 font-normal text-muted-foreground">{analytics.departmentSalary.anchorMonth}</span>
                  )}
                </div>
                <BarListChart
                  title="Salary by department — gross in the latest paid month"
                  rows={analytics.departmentSalary.rows.map((r) => ({ label: r.label, value: r.amount }))}
                  formatValue={(n) => money(n)}
                  emptyHint="No locked runs yet — the slice appears once a run is paid."
                  testId="chart-department-salary"
                />
              </div>
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs font-semibold mb-2" data-testid="designation-salary-header">
                  Salary by job title
                  {analytics.designationSalary.anchorMonth && (
                    <span className="ml-2 font-normal text-muted-foreground">{analytics.designationSalary.anchorMonth}</span>
                  )}
                </div>
                <BarListChart
                  title="Salary by job title — gross in the latest paid month"
                  rows={analytics.designationSalary.rows.map((r) => ({ label: r.label, value: r.amount }))}
                  formatValue={(n) => money(n)}
                  color="#38bdf8"
                  emptyHint="No locked runs yet — the slice appears once a run is paid."
                  testId="chart-designation-salary"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* New run — P10: any cadence, resolved live through the windows kernel.
          P14 (PR-04): an optional employee filter scopes the snapshot. */}
      <form onSubmit={createRun} className="rounded-lg border border-border p-4 flex flex-wrap items-end gap-3" data-testid="new-run-form">
        <div className="min-w-[150px]">
          <label htmlFor="payroll-frequency" className="block text-xs font-medium text-foreground mb-1.5">Cadence</label>
          <select
            id="payroll-frequency"
            className="f-input"
            value={newFrequency}
            onChange={(e) => setNewFrequency(e.target.value as PayrollFrequency)}
            data-testid="new-run-frequency"
          >
            {PAYROLL_FREQUENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>
            ))}
          </select>
        </div>
        <div className="grow min-w-[170px]">
          <label htmlFor="payroll-period" className="block text-xs font-medium text-foreground mb-1.5">Anchor date (any day in the window)</label>
          <input
            id="payroll-period"
            type="date"
            className="f-input"
            value={newAnchorDate}
            onChange={(e) => setNewAnchorDate(e.target.value)}
            data-testid="new-run-period"
          />
        </div>
        <button type="submit" className="f-btn f-btn-primary" disabled={busy || !previewWindow} data-testid="create-run-btn">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />} Create run
        </button>
        {/* P14 (PR-33) — the bulk structure assignment tool. */}
        <button type="button" className="f-btn f-btn-secondary" onClick={() => setBulkOpen(true)} data-testid="bulk-assign-btn">
          <Users size={15} /> Bulk assign
        </button>
        <div className="text-xs text-muted-foreground basis-full sm:basis-auto" data-testid="new-run-preview">
          {previewWindow
            ? <>Window <span className="font-medium text-foreground">{previewWindow.label}</span> · key <span className="font-mono">{previewWindow.periodKey}</span> · snapshots the active {newFrequency.toLowerCase()} structures (annual ÷ windows){runFilterUserIds.size > 0 ? ` · ${runFilterUserIds.size} employee(s) selected` : ""}.</>
            : "Pick a valid anchor date."}
        </div>
        {/* P14 (PR-04) — the optional employee filter (open = pick employees;
            unchecked-all = every active structure of the cadence). */}
        <details className="basis-full" data-testid="run-employee-filter">
          <summary className="text-xs text-muted-foreground cursor-pointer select-none">
            Filter employees ({runFilterUserIds.size > 0 ? `${runFilterUserIds.size} selected` : "all"})
          </summary>
          <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
            {employees.map((e) => (
              <label key={e.userId} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                <input
                  type="checkbox"
                  checked={runFilterUserIds.has(e.userId)}
                  onChange={() => setRunFilterUserIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(e.userId)) next.delete(e.userId);
                    else next.add(e.userId);
                    return next;
                  })}
                  data-testid={`run-filter-${e.userId}`}
                />
                <span className="truncate">{e.name}</span>
              </label>
            ))}
          </div>
        </details>
      </form>

      {/* Runs */}
      <div className="rounded-lg border border-border" data-testid="payroll-runs">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <CalendarPlus size={14} className="text-sky-500" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Runs</div>
        </div>
        <div className="divide-y divide-border">
          {runs.map((r) => (
            <div key={r.id} className={cn("px-4 py-2.5 flex items-center gap-3 flex-wrap transition-colors", selectedRunId === r.id ? "bg-muted/60" : "hover:bg-muted/40")} data-testid={`run-row-${r.period}`}>
              <button
                className="text-left min-w-0 grow"
                onClick={() => setSelectedRunId(r.id)}
                data-testid={`run-select-${r.period}`}
              >
                <span className="text-sm font-medium">{monthLabel(r.period)}</span>
                {r.frequency && r.frequency !== "MONTHLY" && (
                  <span className="ml-2 text-[0.625rem] font-semibold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 align-middle" data-testid={`run-freq-${r.period}`}>
                    {r.frequency.toLowerCase()}
                  </span>
                )}
                <span className="block text-xs text-muted-foreground">
                  {r.payslipCount} payslip{r.payslipCount === 1 ? "" : "s"} · gross {money(r.totalGross)} · net {money(r.totalNet)}
                  {r.lockedBy ? ` · locked by ${r.lockedBy}` : ""}
                </span>
              </button>
              <span className={cn(
                "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0",
                r.status === "OPEN" ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-600",
              )}>
                {r.status}
              </span>
              {r.status === "LOCKED" && (
                <>
                  <button
                    className="f-btn f-btn-ghost text-xs no-print"
                    onClick={() => setArrearsRun(r)}
                    type="button"
                    data-testid={`arrears-btn-${r.period}`}
                    title="Re-simulate this paid period under the current structures"
                  >
                    <RotateCcw size={13} /> Arrears
                  </button>
                  {/* P20 (PR-R01/PR-R02) — the per-run CSV exports. */}
                  <button
                    className="f-btn f-btn-ghost text-xs no-print"
                    onClick={() => void exportCsv(r.id, r.period, "REGISTER")}
                    disabled={busy}
                    type="button"
                    data-testid={`export-register-btn-${r.period}`}
                    title="One row per paid slip: gross, deductions, net, LOP, withheld state"
                  >
                    <Download size={13} /> Register CSV
                  </button>
                  <button
                    className="f-btn f-btn-ghost text-xs no-print"
                    onClick={() => void exportCsv(r.id, r.period, "BANK_REMITTANCE")}
                    disabled={busy}
                    type="button"
                    data-testid={`export-bank-btn-${r.period}`}
                    title="One payment row per disbursed net (withheld nets stay out); the bank-account column is blank"
                  >
                    <Download size={13} /> Bank CSV
                  </button>
                </>
              )}
              {r.status === "OPEN" && (
                lockConfirmId === r.id ? (
                  <span className="flex items-center gap-1.5 no-print">
                    <span className="text-xs text-muted-foreground">Mark paid & lock?</span>
                    <button className="f-btn f-btn-ghost text-xs" onClick={() => setLockConfirmId(null)} type="button">Cancel</button>
                    <button className="f-btn f-btn-primary text-xs" disabled={busy} onClick={() => void lockRun(r.id)} type="button" data-testid={`lock-confirm-${r.period}`}>
                      <Lock size={13} /> Lock {r.period}
                    </button>
                  </span>
                ) : (
                  <button className="f-btn f-btn-ghost text-xs no-print" onClick={() => setLockConfirmId(r.id)} type="button" data-testid={`lock-run-${r.period}`}>
                    <Lock size={13} /> Lock
                  </button>
                )
              )}
            </div>
          ))}
          {loaded && runs.length === 0 && (
            <div className="text-sm text-muted-foreground px-4 py-6 text-center">
              No runs yet — create one above once salary structures exist.
            </div>
          )}
        </div>
      </div>

      {/* Selected run payslips */}
      {payslipsRun && (
        <div className="rounded-lg border border-border" data-testid="payslips-panel">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <Wallet size={14} className="text-emerald-600" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {monthLabel(payslipsRun.period)} payslips
            </div>
            <span className={cn(
              "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded",
              payslipsRun.status === "OPEN" ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-600",
            )}>
              {payslipsRun.status}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">
              net total {money(payslipsRun.totalNet)}
            </span>
            {payslipsRun.status === "OPEN" && (
              <button
                className="f-btn f-btn-ghost text-xs ml-2"
                disabled={applyingAdjustments}
                onClick={() => void applyAdjustments(payslipsRun.id, payslipsRun.period)}
                type="button"
                data-testid="apply-adjustments-btn"
              >
                {applyingAdjustments ? <Loader2 size={13} className="animate-spin" /> : <CircleDollarSign size={13} />} Apply pending adjustments
              </button>
            )}
          </div>
          <div className="divide-y divide-border">
            {payslips.map((p) => (
              <div key={p.id} className="w-full px-4 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-3 text-sm">
                <button
                  onClick={() => setOpenPayslip(p)}
                  className="text-left min-w-0 flex-1 flex items-center gap-3"
                  data-testid="payslip-row"
                >
                  <span className="text-xs font-mono text-muted-foreground shrink-0">{p.slipNo}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {p.userName}
                      {p.withholdStatus === "WITHHELD" && (
                        <span className="ml-1.5 inline-flex items-center gap-1 text-[0.625rem] font-semibold px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-600" data-testid={`held-badge-${p.slipNo}`}>
                          <Pause size={10} /> HELD
                        </span>
                      )}
                      {p.withholdStatus === "RELEASED" && (
                        <span className="ml-1.5 inline-flex items-center gap-1 text-[0.625rem] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600" data-testid={`released-badge-${p.slipNo}`}>
                          RELEASED
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      gross {money(p.gross)} · deductions {money(p.gross - p.net)}
                      {p.lopDays > 0 ? ` · LOP ${p.lopDays}d (${p.lopSource === "MANUAL" ? "manual" : "auto"})` : ""}
                      {p.withholdStatus === "WITHHELD" ? " · net held until release" : ""}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">YTD {money(p.ytdNet)}</span>
                  <span className="font-semibold tabular-nums text-primary shrink-0">{money(p.net)}</span>
                </button>
                {payslipsRun.status === "LOCKED" && p.lopDays > 0 && (
                  <button
                    className="f-btn f-btn-ghost text-xs shrink-0 no-print"
                    onClick={() => setLwpSlip(p)}
                    type="button"
                    data-testid={`lwp-btn-${p.slipNo}`}
                    title="Refund docked loss-of-pay days on this paid slip"
                  >
                    <Undo2 size={13} /> Reverse LWP
                  </button>
                )}
              </div>
            ))}
            {payslips.length === 0 && (
              <div className="text-sm text-muted-foreground px-4 py-6 text-center">No payslips in this run.</div>
            )}
          </div>
        </div>
      )}

      {/* Structures */}
      <div className="rounded-lg border border-border" data-testid="structures-panel">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <Landmark size={14} className="text-purple-500" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Salary structures</div>
          <span className="text-xs text-muted-foreground ml-auto">{structures.length} total</span>
        </div>
        <div className="divide-y divide-border">
          {structures.map((s) => {
            const annual = computeOffer(s.components);
            return (
              <button
                key={s.id}
                onClick={() => { setEditStructure(s); setStructureModalOpen(true); }}
                className="w-full text-left px-4 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-3 text-sm"
                data-testid="structure-row"
              >
                <span className={cn(
                  "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0",
                  s.isActive ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground",
                )}>
                  {s.isActive ? "ACTIVE" : "HISTORY"}
                </span>
                {/* P23 — the workspace default package chip: this structure's
                    components prefill new structures (a retired default still
                    prefills — the flag is a package pointer, not pay state). */}
                {s.isDefault && (
                  <span
                    className="text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    title="New structures prefill from this package's components."
                    data-testid="structure-default-chip"
                  >
                    DEFAULT PKG
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {s.userName}
                    {s.jobTitle ? ` · ${s.jobTitle}` : ""}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {s.components.length} components · effective {new Date(s.effectiveFrom).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    {s.source === "OFFER" ? " · from signed offer" : ""}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">CTC {formatMoney(annual.ctc)}</span>
                <span className="font-semibold tabular-nums text-primary shrink-0">{money(Math.round((annual.earnings / 12) * 100) / 100)}/mo</span>
              </button>
            );
          })}
          {loaded && structures.length === 0 && (
            <div className="text-sm text-muted-foreground px-4 py-6 text-center">
              No salary structures yet — create one, or copy it from a signed offer.
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <ComponentCatalogModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onChanged={load}
      />
      <PayAdjustmentModal
        open={adjustmentModalOpen}
        onClose={() => setAdjustmentModalOpen(false)}
        onChanged={load}
        employees={employees}
        defaultPeriod={payslipsRun?.period ?? previewWindow?.periodKey ?? ""}
      />
      {arrearsRun && (
        <ArrearsModal
          open={arrearsRun != null}
          onClose={() => setArrearsRun(null)}
          runId={arrearsRun.id}
          runPeriod={arrearsRun.period}
          onGenerated={load}
        />
      )}
      {lwpSlip && (
        <LwpCorrectionModal
          open={lwpSlip != null}
          onClose={() => setLwpSlip(null)}
          payslipId={lwpSlip.id}
          onReversed={load}
        />
      )}
      <BenefitsModal
        open={benefitsOpen}
        onClose={() => setBenefitsOpen(false)}
        onChanged={load}
        employees={employees}
      />
      <RetentionBonusModal
        open={retentionOpen}
        onClose={() => setRetentionOpen(false)}
        onChanged={load}
        employees={employees}
      />
      <GratuityRuleModal
        open={gratuityOpen}
        onClose={() => setGratuityOpen(false)}
        onChanged={load}
      />
      <WithholdingModal
        open={withholdingOpen}
        onClose={() => setWithholdingOpen(false)}
        onChanged={load}
        employees={employees}
      />
      <StructureModal
        open={structureModalOpen}
        onClose={() => setStructureModalOpen(false)}
        onChanged={load}
        edit={editStructure}
        employees={employees}
      />
      {/* P14 (PR-33) — the bulk structure assignment. */}
      <BulkStructureModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onChanged={load}
        employees={employees}
        structures={structures.filter((s) => s.isActive)}
      />
      <PayslipModal
        payslip={openPayslip}
        unmarkedMode={unmarkedMode}
        lopBasisMode={lopBasisMode}
        roundingMode={roundingMode}
        onClose={() => { setOpenPayslip(null); if (selectedRunId) void loadPayslips(selectedRunId); void load(); }}
        onChanged={() => { if (selectedRunId) void loadPayslips(selectedRunId); void load(); }}
      />
    </div>
  );
}
