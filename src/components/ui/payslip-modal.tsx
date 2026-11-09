"use client";

// Recruitment R7 — the payslip editor + print view
// (docs/RECRUITMENT_MODULE_PLAN.md §5). While the run is OPEN, earnings and
// deduction lines are editable with live gross/net (lib/payroll-math.ts);
// loss-of-pay is entered as DAYS and auto-computes the pro-rated "lop"
// deduction line. LOCKED runs render the same modal read-only as the
// print-friendly slip (the .print-area class scopes window.print() to the
// slip; the chrome buttons are .no-print).
// F1.4 — the LOP box carries a provenance note: lopSource AUTO = derived at
// run creation from attendance + unpaid leave; MANUAL = an HR override.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Lock, Plus, Printer, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import type { PayslipT, PayslipLineT } from "@/lib/types";
import { updatePayslip } from "@/server-actions/payroll";
import { computeLop, payslipTotals, lopBasisGross, withRoundingLine, LOP_LINE_KEY, ROUNDING_LINE_KEY, type PayrollRoundingMode } from "@/lib/payroll-math";
import { componentYtdAmount } from "@/lib/payslip-aggregates";
// P16 (PR-11) — the fiscal-year label for the YTD chip ("2026/27" when the
// workspace basis isn't the calendar year).
import { fiscalYearLabel, fiscalYearOf, parsePayrollPeriodKey } from "@/lib/payroll-windows";

function money(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function newLine(): PayslipLineT {
  return { key: "", label: "", amount: 0 };
}

/** Derive a line key from the label (like the offer/structure editors). */
function keyFromLabel(label: string, fallbackIdx: number): string {
  const k = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  return k || `line_${fallbackIdx}`;
}

export function PayslipModal({
  payslip,
  unmarkedMode = "IGNORED",
  roundingMode = "ROUND_2DP",
  onClose,
  onChanged,
}: {
  /** The payslip to show; null → closed. */
  payslip: PayslipT | null;
  /** PR-B07 (S4) — the workspace's unmarked-day policy, for the AUTO
   * provenance note (the derivation is a creation-time snapshot; the note
   * states the policy that produced it). */
  unmarkedMode?: "IGNORED" | "ABSENT";
  /** PR-B23 (S7) — the workspace's rounding policy; drives the live
   * preview's auto rounding line exactly as the server will store it. */
  roundingMode?: PayrollRoundingMode;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [earnings, setEarnings] = useState<PayslipLineT[]>([]);
  const [deductions, setDeductions] = useState<PayslipLineT[]>([]);
  // F1.4 — string state so typing "1.5" works (a controlled number input
  // swallows the decimal point: "1." parses to 1 and React snaps the DOM
  // back to "1"). Parsed once for math, clamped 0–31, rounded to 2 decimals.
  const [lopDaysInput, setLopDaysInput] = useState("0");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (payslip) { setEarnings(payslip.earnings.filter((l) => l.key !== ROUNDING_LINE_KEY && !l.statistical).map((l) => ({ ...l }))); setDeductions(payslip.runStatus === "OPEN" ? payslip.deductions.filter((l) => l.key !== LOP_LINE_KEY && l.key !== ROUNDING_LINE_KEY).map((l) => ({ ...l })) : payslip.deductions.map((l) => ({ ...l }))); setLopDaysInput(String(payslip.lopDays)); setNote(payslip.note); }
  }, [payslip]);

  const editable = payslip?.runStatus === "OPEN";
  const lopDays = Math.max(0, Math.min(31, Math.round((Number(lopDaysInput) || 0) * 100) / 100));

  const totals = useMemo(() => {
    if (!editable && payslip) {
      // The stored, paid record — amounts as locked.
      const lop = payslip.deductions.find((l) => l.key === LOP_LINE_KEY)?.amount ?? 0;
      const manual = payslip.deductions
        .filter((l) => l.key !== LOP_LINE_KEY)
        .reduce((s, l) => s + l.amount, 0);
      const roundingAdj = payslip.earnings.find((l) => l.key === ROUNDING_LINE_KEY)?.amount
        ?? payslip.deductions.find((l) => l.key === ROUNDING_LINE_KEY)?.amount ?? 0;
      return { gross: payslip.gross, lop, manualDeductions: manual, roundingAdj, net: payslip.net };
    }
    // S6 — the LOP basis excludes window-exempt lines (the server's
    // lopBasisGross); the live preview matches the stored math exactly.
    const gross = payslipTotals(earnings, []).gross;
    const lopBasis = lopBasisGross(earnings);
    // F1.1 — divide by the run's holiday-aware working-day count when the
    // run carries one (post-F1.1 runs), so the live preview matches the
    // server's stored LOP math exactly.
    const lop = computeLop(
      lopBasis,
      lopDays,
      payslip?.runPeriod ?? "2026-01",
      payslip && payslip.runWorkingDays > 0 ? payslip.runWorkingDays : undefined,
    );
    const manualDeductions = deductions.reduce((s, l) => s + l.amount, 0);
    // S7 — the auto rounding line rides the preview exactly as saved.
    const rounded = withRoundingLine(
      [...earnings, ...(lop > 0 ? [{ key: LOP_LINE_KEY, label: "Loss of pay", amount: lop }] : [])],
      deductions,
      roundingMode,
    );
    const roundingAdj = rounded.earnings.find((l) => l.key === ROUNDING_LINE_KEY)?.amount
      ?? rounded.deductions.find((l) => l.key === ROUNDING_LINE_KEY)?.amount ?? 0;
    const net = Math.round((gross - lop - manualDeductions) * 100) / 100;
    return { gross, lop, manualDeductions, roundingAdj, net: Math.round((net + roundingAdj) * 100) / 100 };
  }, [editable, payslip, earnings, deductions, lopDays, roundingMode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payslip) return;
    if (earnings.some((l) => !l.key.trim() || !l.label.trim()) || deductions.some((l) => !l.key.trim() || !l.label.trim())) {
      toast.error("Every line needs a label.");
      return;
    }
    setBusy(true);
    const res = await updatePayslip({
      payslipId: payslip.id,
      // F-R2 — optimistic lock: refuse silently overwriting another editor's
      // save; the server bounces stale versions with a reopen hint.
      expectedVersion: payslip.version,
      earnings,
      deductions,
      lopDays,
      note,
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Payslip ${payslip.slipNo} saved — net ${money(totals.net)}.`);
    onChanged();
    onClose();
  };

  if (!payslip) return null;
  const p = payslip;

  // P16 (PR-11) — the YTD chip: the fiscal-year label when the workspace
  // basis isn't the calendar year (null at startMonth 1 — the chip and the
  // basis sentence stay hidden, byte-identical to the pre-P16 modal).
  const fyStart = p.fiscalYearStartMonth ?? 1;
  const ytdBasisChip =
    fyStart !== 1
      ? fiscalYearLabel(
          fiscalYearOf(parsePayrollPeriodKey(p.runPeriod)?.end?.getTime() ?? 0, fyStart),
          fyStart,
        )
      : null;

  const lineEditor = (
    lines: PayslipLineT[],
    setLines: React.Dispatch<React.SetStateAction<PayslipLineT[]>>,
    kind: "earnings" | "deductions",
  ) => (
    <div className="space-y-1.5">
      <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">{kind === "earnings" ? "Earnings (monthly)" : "Deductions (monthly)"}</div>
      {lines.map((l, i) => {
        // P11 (PR-B09) — the line's component YTD through this period
        // (read-time; statistical lines never carry one).
        const ytd = l.statistical ? 0 : componentYtdAmount(
          { componentYtd: p.componentYtd },
          kind === "earnings" ? "EARNING" : "DEDUCTION",
          l.key,
        );
        return (
        <div key={i} className="flex items-center gap-1.5 flex-wrap" data-testid={`payslip-${kind}-${i}`}>
          <input
            className="f-input text-xs grow min-w-[130px]" placeholder="Label (e.g. Basic Salary)"
            value={l.label}
            disabled={!editable}
            onChange={(e) => setLines((prev) => prev.map((x, idx) => idx === i
              ? { ...x, label: e.target.value, key: x.key && x.key !== LOP_LINE_KEY ? x.key : keyFromLabel(e.target.value, i) }
              : x))}
            maxLength={120}
          />
          <input
            className="f-input text-xs w-28" type="number" min={0} step="0.01"
            value={l.amount}
            disabled={!editable}
            onChange={(e) => setLines((prev) => prev.map((x, idx) => idx === i ? { ...x, amount: Number(e.target.value) } : x))}
            aria-label="Amount"
          />
          {ytd > 0 && (
            <span
              className="text-[0.6875rem] text-muted-foreground tabular-nums shrink-0"
              title={`This component's year-to-date total through ${p.runPeriod} (read-time; recalculated as slips are saved or finalized)`}
              data-testid={`payslip-${kind}-ytd-${i}`}
            >
              YTD {money(ytd)}
            </span>
          )}
          <button
            type="button" className="f-btn f-btn-icon text-destructive no-print" aria-label={`Remove ${l.label || "line"}`}
            disabled={!editable}
            onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
          >
            <Trash2 size={13} />
          </button>
        </div>
        );
      })}
      {editable && (
        <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => setLines((prev) => [...prev, newLine()])} data-testid={`payslip-add-${kind}`}>
          <Plus size={13} /> Add {kind === "earnings" ? "earning" : "deduction"}
        </button>
      )}
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Payslip ${p.slipNo}`}
      description={`${p.userName}${p.jobTitle ? ` · ${p.jobTitle}` : ""} · ${p.runPeriod} · ${p.runStatus}`}
      size="lg"
    >
      <form onSubmit={submit} className="space-y-3 print-area" data-testid="payslip-modal">
        {lineEditor(earnings, setEarnings, "earnings")}

        {/* PR-B03 (S8) — statistical lines: display-only info rows from the
            structure snapshot; never editable, never money. */}
        {(payslip.earnings.filter((l) => l.statistical)).length > 0 && (
          <div
            className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 space-y-1"
            data-testid="payslip-statistical"
          >
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              For information (not counted in pay)
            </div>
            {payslip.earnings.filter((l) => l.statistical).map((l) => (
              <div key={l.key} className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <span>{l.label}</span>
                <span className="tabular-nums">{money(l.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {/* LOP — days in, pro-rated money out (edit affordance only) */}
        {editable ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex items-center gap-3 flex-wrap">
            <Field label="Loss-of-pay days (pro-rated: gross × days ÷ working days — halves allowed)">
              <input
                type="number" min={0} max={31} step={0.5}
                className="f-input text-xs w-20"
                value={lopDaysInput}
                onChange={(e) => setLopDaysInput(e.target.value)}
                data-testid="payslip-lop-days"
              />
            </Field>
            {totals.lop > 0 && (
              <div className="text-xs text-amber-700" data-testid="payslip-lop-amount">
                LOP deduction: <strong>{money(totals.lop)}</strong> (auto line)
              </div>
            )}
            <div className="w-full text-[0.6875rem] text-muted-foreground" data-testid="payslip-lop-source">
              {p.lopSource === "AUTO"
                ? "Auto-derived at run creation from attendance (absent / half-day) and unpaid or partially-paid leave — saving a different value records a manual override."
                : "Manually set by HR — overrides the run-creation derivation."}
              {unmarkedMode === "ABSENT" ? " Workspace policy: unmarked working days count as absent (runs created while the policy is on)." : ""}
            </div>
          </div>
        ) : p.lopDays > 0 ? (
          // F1.4 — read-only honesty note on the paid record: where the
          // docked days came from.
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700" data-testid="payslip-lop-source">
            Loss of pay: {p.lopDays} day{p.lopDays === 1 ? "" : "s"} · {p.lopSource === "AUTO" ? "auto-derived from attendance and unpaid or partially-paid leave" : "manually set by HR"}
          </div>
        ) : null}

        {/* P15 (PR-06) — the frozen charge breakdown (the Salary Slip Leave
            child, Fernly-shaped): which leave covered the window (days
            taken × the type's salary fraction → days charged) plus the
            attendance-side docks. AUTO slips only — a manual override
            cleared it, and the note above says so. */}
        {p.lopDetail && p.lopSource === "AUTO" && (
          <div
            className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[0.6875rem] text-muted-foreground space-y-1"
            data-testid="payslip-lop-detail"
          >
            <div className="uppercase tracking-wide">Loss-of-pay breakdown (frozen at run creation)</div>
            {p.lopDetail.leave.length > 0 && (
              <ul className="space-y-0.5">
                {p.lopDetail.leave.map((row) => (
                  <li key={row.leaveTypeId}>
                    {row.name}: {row.takenDays} day{row.takenDays === 1 ? "" : "s"} taken
                    {row.fraction < 1 ? ` at ${Math.round(row.fraction * 100)}% salary` : ""} →{" "}
                    <span className={row.chargedDays > 0 ? "text-amber-700 dark:text-amber-400" : ""}>
                      {row.chargedDays} day{row.chargedDays === 1 ? "" : "s"} charged
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {(p.lopDetail.absentDays > 0 || p.lopDetail.halfDays > 0 || p.lopDetail.unmarkedDays > 0) && (
              <div>
                Attendance docks: {p.lopDetail.absentDays} absent + {p.lopDetail.halfDays} half-day
                {p.lopDetail.unmarkedDays > 0 ? ` + ${p.lopDetail.unmarkedDays} unmarked (policy)` : ""} (working-day fractions)
              </div>
            )}
          </div>
        )}

        {/* PR-B06 (S5) — the employment-window day breakdown. Full-month
            slips (paidDays == workingDays, or pre-S5 null) render nothing. */}
        {editable && p.paidDays != null && p.runWorkingDays > 0 && p.paidDays < p.runWorkingDays && (
          <div
            className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-400"
            data-testid="payslip-paid-days"
          >
            Paid days: <strong>{p.paidDays}</strong> of {p.runWorkingDays} working days — this slip is
            clipped to the employment window (joined or left mid-month); the lines above are scaled
            pro-rata, and loss-of-pay is capped at the paid days.
          </div>
        )}
        {!editable && p.paidDays != null && p.runWorkingDays > 0 && p.paidDays < p.runWorkingDays && (
          <div className="text-xs text-muted-foreground" data-testid="payslip-paid-days">
            Paid days: {p.paidDays} of {p.runWorkingDays} working days (employment window) — lines scaled pro-rata.
          </div>
        )}

        {lineEditor(deductions, setDeductions, "deductions")}

        {/* Totals — P11 (PR-B09): the period aggregates ride the same box
            (YTD gross/net through this period + the month-to-date net, which
            sums this calendar month's slips — meaningful when several runs
            land in one month, e.g. weekly cadences). P16: the YTD cells name
            the fiscal basis when it isn't the calendar year. */}
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 grid grid-cols-3 gap-2 text-xs" data-testid="payslip-totals">
          <div><div className="text-muted-foreground">Gross</div><div className="font-semibold tabular-nums">{money(totals.gross)}</div></div>
          <div><div className="text-muted-foreground">Deductions</div><div className="font-semibold tabular-nums text-destructive">{money(totals.lop + totals.manualDeductions)}</div></div>
          <div><div className="text-muted-foreground">Net pay{totals.roundingAdj !== 0 ? " (rounded)" : ""}</div><div className="font-semibold tabular-nums text-primary">{money(totals.net)}</div></div>
          <div><div className="text-muted-foreground">YTD gross{ytdBasisChip ? ` · ${ytdBasisChip}` : ""}</div><div className="font-semibold tabular-nums" data-testid="payslip-ytd-gross">{money(p.ytdGross)}</div></div>
          <div><div className="text-muted-foreground">YTD net{ytdBasisChip ? ` · ${ytdBasisChip}` : ""}</div><div className="font-semibold tabular-nums" data-testid="payslip-ytd-net">{money(p.ytdNet)}</div></div>
          <div><div className="text-muted-foreground">Month-to-date net</div><div className="font-semibold tabular-nums" data-testid="payslip-mtd-net">{money(p.mtdNet)}</div></div>
        </div>
        <div className="text-xs text-muted-foreground" data-testid="payslip-ytd-basis">
          YTD net (through {p.runPeriod}): <strong data-testid="payslip-ytd">{money(p.ytdNet)}</strong>
          {editable ? " — updates when this slip is saved." : ""}
          {ytdBasisChip ? ` YTD basis: fiscal year ${ytdBasisChip} (resets at the fiscal boundary, not January 1).` : ""}
          {" "}Per-line "YTD" figures are each component's year total through this period (read-time).
          {" "}HR basis: every run of the year including this OPEN one — your
          employees' own payslip view counts locked (paid) runs only, so the
          two surfaces can differ while a month is open.
        </div>

        <Field label="Note (shown on the printed slip)">
          <input
            className="f-input text-xs"
            value={note}
            disabled={!editable}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            data-testid="payslip-note"
          />
        </Field>

        {p.runStatus === "OPEN" ? (
          <div className="flex justify-end gap-2 no-print">
            <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="f-btn f-btn-primary" disabled={busy} data-testid="payslip-save">
              {busy ? <Loader2 size={14} className="animate-spin" /> : null} Save payslip
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Lock size={12} /> The run is locked — this slip is the paid, immutable record.
            </div>
            <button type="button" className="f-btn f-btn-secondary no-print" onClick={() => window.print()} data-testid="payslip-print">
              <Printer size={14} /> Print / save PDF
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
