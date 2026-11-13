// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — pre-flight reconciliation: the filed return
// and the general ledger must agree to the cent.
//
// Eight checks around every EI generation (Step 2.10):
//   1. Σ payslip PAYE line (income tax only)           == EI field 15
//   2. Σ payslip ACC levy — LOGGED ONLY (never filed; IRD derives the
//      levy from the rate; the YTD cap excess is deferred per ADR-017/18)
//   3. Σ payslip KiwiSaver employee                     == EI field 22
//   4. Σ payslip employer KiwiSaver NET                 == EI field 23
//   5. Σ payslip ESCT                                   == EI field 24
//   6. Σ payslip student loan                           == EI field 19
//   7. Σ payslip TAXABLE gross (statutory snapshot)     == EI field 11
//   8. The Phase 1D POSTED JournalEntry credits for the run:
//        2100 == field 15 · 2120 == field 22 · 2130 == field 23
//        2140 == field 24 · 2150 == field 19
//
// A mismatch means the EI file would disagree with the books — the
// filing service REFUSES to generate and reports every failed check.
//
// The core is PURE (runReconciliation) so the service can reconcile
// BEFORE anything is written; reconcilePaydayFiling re-runs the same
// checks against a persisted filing for the UI.
//
// Money sources (deliberately independent):
//   • Filing side   — the built EiTotals (prospective) or the persisted
//     PaydayFiling line rows.
//   • Payslip side  — the deduction JSON line keys (paye/acc/ks/sl) and
//     the employer Decimal columns: exactly what the GL posted from.
//   • Ledger side   — the POSTED JournalEntry's credits per account code.
// ---------------------------------------------------------------------------

import { db } from "@/lib/infra/db";
import {
  parsePayslipLines,
  toCents,
  PAYE_LINE_KEY,
  ACC_LEVY_LINE_KEY,
  KIWISAVER_LINE_KEY,
  STUDENT_LOAN_LINE_KEY,
} from "@/lib/payroll/payroll-math";
import { STATUTORY_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import type { PayslipStatutoryT } from "@/lib/types";

/** Prisma Decimal | number | null → number. */
function toNum(v: { toNumber(): number } | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  return v.toNumber();
}

export interface ReconcileCheck {
  /** 1-8 (the Step 2.10 numbering). */
  index: number;
  label: string;
  /** The filing-side figure (EI field total), integer cents. */
  filingCents: number;
  /** The independent source figure, integer cents. */
  sourceCents: number;
  pass: boolean;
  /** Extra context (e.g. the ACC levy that is logged, never filed). */
  note?: string;
}

export interface ReconciliationReport {
  /** The filing these checks ran against (the prospective filing id, or
   * "prospective" during generation). */
  filingId: string;
  runIds: string[];
  checks: ReconcileCheck[];
  /** Check 2's figure — the ACC earners' levy total across the filed
   * payslips (internal reconciliation only; never written to the EI). */
  accLevyCents: number;
  allPass: boolean;
}

function sumLine(deductions: string, key: string): number {
  return parsePayslipLines(deductions)
    .filter((l) => l.key === key)
    .reduce((acc, l) => acc + l.amount, 0);
}

/** The account codes the ledger cross-check covers (check 8). */
export const RECONCILE_ACCOUNT_CODES = {
  PAYE: STATUTORY_ACCOUNT_CODES.PAYE, // 2100 ↔ EI field 15
  KIWISAVER_EMPLOYEE: STATUTORY_ACCOUNT_CODES.KIWISAVER_EMPLOYEE, // 2120 ↔ 22
  KIWISAVER_EMPLOYER: STATUTORY_ACCOUNT_CODES.KIWISAVER_EMPLOYER, // 2130 ↔ 23
  ESCT: STATUTORY_ACCOUNT_CODES.ESCT, // 2140 ↔ 24
  STUDENT_LOAN: STATUTORY_ACCOUNT_CODES.STUDENT_LOAN, // 2150 ↔ 19
} as const;

/** A payslip flattened for the reconciliation core. */
export interface ReconcilePayslip {
  payslipId: string;
  runId: string;
  deductions: string;
  employerKiwiSaverNet: number;
  employerEsct: number;
  statutory: PayslipStatutoryT | null;
}

/** The pure reconciliation core. */
export function runReconciliation(input: {
  filingId: string;
  /** The builder's totals (prospective) or the persisted totals. */
  totals: {
    payeCents: number;
    kiwisaverEmployeeCents: number;
    kiwisaverEmployerNetCents: number;
    esctCents: number;
    studentLoanCents: number;
    grossCents: number;
  };
  payslips: ReconcilePayslip[];
  /** Account code → Σ credits in DOLLARS, from the POSTED JEs. */
  journalCredits: Map<string, number>;
}): ReconciliationReport {
  const { payslips } = input;
  if (payslips.length === 0) throw new Error("Reconciliation needs at least one payslip.");

  let payeLines = 0;
  let accLines = 0;
  let ksLines = 0;
  let slLines = 0;
  let employerNet = 0;
  let esct = 0;
  let taxableGross = 0;
  const runIds = new Set<string>();
  for (const slip of payslips) {
    runIds.add(slip.runId);
    payeLines += sumLine(slip.deductions, PAYE_LINE_KEY);
    accLines += sumLine(slip.deductions, ACC_LEVY_LINE_KEY);
    ksLines += sumLine(slip.deductions, KIWISAVER_LINE_KEY);
    slLines += sumLine(slip.deductions, STUDENT_LOAN_LINE_KEY);
    employerNet += slip.employerKiwiSaverNet;
    esct += slip.employerEsct;
    if (!slip.statutory) {
      throw new Error(`Payslip ${slip.payslipId} has no statutory snapshot — it was never priced by the engine and cannot be filed.`);
    }
    taxableGross += slip.statutory.taxableGross;
  }

  const t = input.totals;
  const checks: ReconcileCheck[] = [
    {
      index: 1,
      label: "Σ payslip PAYE (income tax line only) == EI field 15 total",
      filingCents: t.payeCents,
      sourceCents: toCents(payeLines),
      pass: t.payeCents === toCents(payeLines),
    },
    {
      index: 2,
      label: "Σ payslip ACC earners' levy (logged only — never filed)",
      filingCents: 0,
      sourceCents: toCents(accLines),
      pass: true,
      note: "ACC is embedded in the tax rate; IRD derives the levy. Total logged for internal reconciliation.",
    },
    {
      index: 3,
      label: "Σ payslip KiwiSaver employee == EI field 22 total",
      filingCents: t.kiwisaverEmployeeCents,
      sourceCents: toCents(ksLines),
      pass: t.kiwisaverEmployeeCents === toCents(ksLines),
    },
    {
      index: 4,
      label: "Σ payslip employer KiwiSaver NET == EI field 23 total",
      filingCents: t.kiwisaverEmployerNetCents,
      sourceCents: toCents(employerNet),
      pass: t.kiwisaverEmployerNetCents === toCents(employerNet),
    },
    {
      index: 5,
      label: "Σ payslip ESCT == EI field 24 total",
      filingCents: t.esctCents,
      sourceCents: toCents(esct),
      pass: t.esctCents === toCents(esct),
    },
    {
      index: 6,
      label: "Σ payslip student loan == EI field 19 total",
      filingCents: t.studentLoanCents,
      sourceCents: toCents(slLines),
      pass: t.studentLoanCents === toCents(slLines),
    },
    {
      index: 7,
      label: "Σ payslip TAXABLE gross (statutory snapshot) == EI field 11 total",
      filingCents: t.grossCents,
      sourceCents: toCents(taxableGross),
      pass: t.grossCents === toCents(taxableGross),
    },
  ];

  const ledgerPairs: Array<{ code: string; field: string; filingCents: number }> = [
    { code: RECONCILE_ACCOUNT_CODES.PAYE, field: "EI field 15 (PAYE)", filingCents: t.payeCents },
    { code: RECONCILE_ACCOUNT_CODES.KIWISAVER_EMPLOYEE, field: "EI field 22 (KiwiSaver employee)", filingCents: t.kiwisaverEmployeeCents },
    { code: RECONCILE_ACCOUNT_CODES.KIWISAVER_EMPLOYER, field: "EI field 23 (employer KiwiSaver net)", filingCents: t.kiwisaverEmployerNetCents },
    { code: RECONCILE_ACCOUNT_CODES.ESCT, field: "EI field 24 (ESCT)", filingCents: t.esctCents },
    { code: RECONCILE_ACCOUNT_CODES.STUDENT_LOAN, field: "EI field 19 (student loan)", filingCents: t.studentLoanCents },
  ];
  for (const pair of ledgerPairs) {
    const jeCents = toCents(input.journalCredits.get(pair.code) ?? 0);
    checks.push({
      index: 8,
      label: `JournalEntry credits ${pair.code} == ${pair.field}`,
      filingCents: pair.filingCents,
      sourceCents: jeCents,
      pass: pair.filingCents === jeCents,
      note: runIds.size === 1 ? "the run's POSTED entry" : `${runIds.size} runs' POSTED entries`,
    });
  }

  return {
    filingId: input.filingId,
    runIds: [...runIds],
    checks,
    accLevyCents: toCents(accLines),
    allPass: checks.every((c) => c.pass),
  };
}

/** Load Σ credits (dollars) per account code from the POSTED payroll
 * journal entries of the given runs. */
export async function loadJournalCredits(runIds: string[]): Promise<Map<string, number>> {
  const credits = new Map<string, number>();
  if (runIds.length === 0) return credits;
  const entries = await db.journalEntry.findMany({
    where: { sourceType: "PAYROLL_RUN", sourceId: { in: runIds }, status: "POSTED", reversalOfId: null },
    include: { lines: { include: { account: { select: { code: true } } } } },
  });
  for (const entry of entries) {
    for (const jl of entry.lines) {
      const credit = toNum(jl.credit as { toNumber(): number });
      if (credit === 0) continue;
      credits.set(jl.account.code, (credits.get(jl.account.code) ?? 0) + credit);
    }
  }
  return credits;
}

/** Re-run the reconciliation against a PERSISTED filing (the UI's
 * "reconcile" view). */
export async function reconcilePaydayFiling(filingId: string): Promise<ReconciliationReport> {
  const filing = await db.paydayFiling.findUnique({
    where: { id: filingId },
    include: { lines: true },
  });
  if (!filing) throw new Error(`Payday filing ${filingId} not found.`);
  if (filing.lines.length === 0) throw new Error(`Payday filing ${filingId} has no lines to reconcile.`);

  // PaydayFilingLine carries payslipId without a Prisma relation (the
  // Phase 1 Payslip model stays untouched) — join in code.
  const slipRows = await db.payslip.findMany({
    where: { id: { in: filing.lines.map((l) => l.payslipId) } },
  });
  const slipById = new Map(slipRows.map((s) => [s.id, s]));

  const payslips: ReconcilePayslip[] = filing.lines.map((l) => {
    const slip = slipById.get(l.payslipId) as {
      id: string;
      runId: string;
      deductions: string;
      employerKiwiSaverNet: { toNumber(): number } | null;
      employerEsct: { toNumber(): number } | null;
      statutory: PayslipStatutoryT | null;
    } | undefined;
    if (!slip) throw new Error(`Payday filing line ${l.id} references a missing payslip — the filing is corrupt.`);
    return {
      payslipId: l.payslipId,
      runId: slip.runId,
      deductions: slip.deductions,
      employerKiwiSaverNet: toNum(slip.employerKiwiSaverNet),
      employerEsct: toNum(slip.employerEsct),
      statutory: slip.statutory,
    };
  });

  const journalCredits = await loadJournalCredits([...new Set(payslips.map((p) => p.runId))]);

  return runReconciliation({
    filingId,
    totals: {
      payeCents: filing.lines.reduce((a, l) => a + l.payeCents, 0),
      kiwisaverEmployeeCents: filing.lines.reduce((a, l) => a + l.kiwisaverEmployeeCents, 0),
      kiwisaverEmployerNetCents: filing.lines.reduce((a, l) => a + l.kiwisaverEmployerNetCents, 0),
      esctCents: filing.lines.reduce((a, l) => a + l.esctCents, 0),
      studentLoanCents: filing.lines.reduce((a, l) => a + l.studentLoanCents, 0),
      grossCents: filing.lines.reduce((a, l) => a + l.grossCents, 0),
    },
    payslips,
    journalCredits,
  });
}

/** Render a failed reconciliation into the refusal message. */
export function reconciliationRefusalMessage(report: ReconciliationReport): string {
  const failed = report.checks.filter((c) => !c.pass);
  const lines = failed.map(
    (c) => `  · Check ${c.index}: ${c.label} — filed ${c.filingCents}c vs source ${c.sourceCents}c (off by ${Math.abs(c.filingCents - c.sourceCents)}c)`,
  );
  return `The Employment Information file would disagree with the payroll records or the general ledger — refusing to generate. ${failed.length} check(s) failed:\n${lines.join("\n")}\nCorrect the underlying payslips (or post the run's journal entry) before filing.`;
}
