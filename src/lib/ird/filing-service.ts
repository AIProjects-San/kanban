// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the filing service.
//
// generatePaydayFiling(runId)  build + validate + persist one EI filing
//                              for a LOCKED run's payday.
// markFiled / markAccepted /
// markRejected                 the status machine (GENERATED → FILED →
//                              ACCEPTED | REJECTED; regeneration refused
//                              once FILED; REJECTED may regenerate).
// flagOverdueFilings()         the 2-working-day deadline watch.
// generateEmployeeDetails()    ED notifications for joiners/leavers.
// generateAmendmentFiling()    the EIA2 correction flow.
//
// Guards (in order): settings exist → run exists → run LOCKED → cadence
// has a pay-cycle code → no payslip already filed → per-payslip statutory
// data present → build (structural asserts) → RECONCILIATION against the
// payslips + the posted JE → ONE transaction writes the filing + lines.
//
// This module is lib-level (no auth): the server actions in
// src/server-actions/payday-filing.ts wrap every entry point with
// requirePermission("payroll:manage") + audit.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { db } from "@/lib/infra/db";
import { getHolidayLookup } from "@/lib/holidays";
import { holidayLookupFrom, type HolidayLookup } from "@/lib/working-days";
import type { PayslipStatutoryT } from "@/lib/types";
import { buildEiFile, type EiEmployeeLine } from "./ei-file";
import { buildEdFile, type EdEmployeeLine, type EdFilingKind } from "./ed-file";
import { buildEia2File, type AmendmentCorrection, type AmendmentLineValues } from "./amendment-file";
import { computeDueDate } from "./deadline";
import { isFilingCadence, mapPayCycle } from "./pay-cycle";
import { normaliseIrd } from "./ird-number";
import { splitFullName, toCents, IrdFormatError } from "./format";
import {
  loadJournalCredits,
  reconciliationRefusalMessage,
  runReconciliation,
  type ReconciliationReport,
} from "./reconciliation";
import { payCycleToFrequency } from "./pay-cycle";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface FilingSettings {
  employerIrdNumber: string;
  employerName: string;
  payeIntermediaryIrd: string | null;
  payrollContactName: string;
  payrollContactPhone: string;
  payrollContactEmail: string;
  payrollPackageIdentifier: string;
  irFormVersionNumber: string;
  nzBusinessHolidays: unknown;
}

/** The PayrollSettings singleton (null until the admin completes it). */
export async function getFilingSettings(): Promise<FilingSettings | null> {
  const row = await db.payrollSettings.findUnique({ where: { id: "default" } });
  if (!row) return null;
  return {
    employerIrdNumber: row.employerIrdNumber,
    employerName: row.employerName,
    payeIntermediaryIrd: row.payeIntermediaryIrd,
    payrollContactName: row.payrollContactName,
    payrollContactPhone: row.payrollContactPhone,
    payrollContactEmail: row.payrollContactEmail,
    payrollPackageIdentifier: row.payrollPackageIdentifier,
    irFormVersionNumber: row.irFormVersionNumber,
    nzBusinessHolidays: row.nzBusinessHolidays,
  };
}

async function requireSettings(): Promise<FilingSettings> {
  const settings = await getFilingSettings();
  if (!settings) {
    throw new Error("The employer's payroll filing settings are not configured — set the employer IRD number and payroll contact before generating any IRD file.");
  }
  return settings;
}

/** The holiday lookup for the deadline walk: the settings override when
 * present, else the workspace holiday calendar (Phase 1A kernel data). */
async function holidayLookupFor(payDate: Date, override: unknown): Promise<HolidayLookup | undefined> {
  if (Array.isArray(override)) {
    const rows = override as Array<{ date?: string; isHalfDay?: boolean }>;
    const parsed = rows
      .filter((r) => typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
      .map((r) => ({ date: r.date as string, isHalfDay: Boolean(r.isHalfDay) }));
    if (parsed.length > 0) return holidayLookupFrom(parsed);
  }
  const from = new Date(payDate.getTime());
  const to = new Date(payDate.getTime() + 21 * 86_400_000); // deadline walks at most a few days out
  return getHolidayLookup(from, to);
}

// ---------------------------------------------------------------------------
// EI generation
// ---------------------------------------------------------------------------

/** Minimal Prisma Decimal duck-type. */
interface DecimalLike {
  toNumber(): number;
}

function dec(v: DecimalLike | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  return v.toNumber();
}

/** The row shape generatePaydayFiling reads (Prisma or test doubles). */
interface FilingPayslipRow {
  id: string;
  userId: string;
  slipNo: string;
  runId: string;
  deductions: string;
  taxCodeApplied: string;
  statutory: PayslipStatutoryT | null;
  employerKiwiSaverNet: DecimalLike | null;
  employerEsct: DecimalLike | null;
}

export interface GeneratedPaydayFiling {
  id: string;
  status: string;
  payDate: Date;
  dueDate: Date;
  totalEmployeeLines: number;
  reconciliation: ReconciliationReport;
}

/** The UK-style "in period" test for employment dates (UTC midnights). */
function inPeriod(d: Date, start: Date, end: Date): boolean {
  return d.getTime() >= start.getTime() && d.getTime() <= end.getTime();
}

/**
 * Generate (or regenerate, from DRAFT/GENERATED/REJECTED) the EI filing
 * for a LOCKED run's payday. Refuses — loudly, before any write — when
 * the run is open, the cadence has no pay-cycle code, any payslip is
 * already filed, statutory data is missing, the file would fail IRD
 * structural validation, or the reconciliation against the payslips and
 * the posted journal entry fails.
 */
export async function generatePaydayFiling(
  runId: string,
  opts: { generatedById?: string } = {},
): Promise<GeneratedPaydayFiling> {
  const settings = await requireSettings();

  const run = await db.payrollRun.findUnique({
    where: { id: runId },
    include: { payslips: true },
  });
  if (!run) throw new Error(`Payroll run ${runId} not found.`);
  if (run.status !== "LOCKED") {
    throw new Error(`The run for ${run.period} is still OPEN — lock it (mark it paid) before generating its Employment Information file.`);
  }
  if (run.payslips.length === 0) {
    throw new Error(`The run for ${run.period} has no payslips — nothing to file.`);
  }
  if (!isFilingCadence(run.frequency)) {
    // mapPayCycle's message explains the refusal in full.
    mapPayCycle(run.frequency);
  }
  const payCycle = mapPayCycle(run.frequency);
  const payDate = run.payDate;
  const periodStart = run.startDate ?? run.payDate;
  const periodEnd = run.endDate ?? run.payDate;

  // ---- The never-file-twice guard ---------------------------------------
  const payslipIds = run.payslips.map((p) => p.id);
  const existingLines = await db.paydayFilingLine.findMany({
    where: { payslipId: { in: payslipIds } },
    include: { filing: true },
  });
  let replaceFilingId: string | null = null;
  if (existingLines.length > 0) {
    // Every existing line's filing must be THIS payday's regenerable row.
    const byFiling = new Map<string, typeof existingLines>();
    for (const l of existingLines) {
      const list = byFiling.get(l.filingId) ?? [];
      list.push(l);
      byFiling.set(l.filingId, list);
    }
    for (const [filingId, lines] of byFiling) {
      const filing = lines[0].filing;
      if (filing.status === "FILED" || filing.status === "ACCEPTED" || filing.status === "AMENDED") {
        throw new Error(
          `A filing for this payday was already uploaded to myIR on ${filing.filedAt?.toISOString().slice(0, 10) ?? "an earlier date"} (status ${filing.status}) — a filed return is never regenerated. Correct it with an amendment instead.`,
        );
      }
      if (filing.employerIrd !== settings.employerIrdNumber || filing.payDate.getTime() !== payDate.getTime()) {
        throw new Error(
          `A payslip in this run is already part of the filing for payday ${filing.payDate.toISOString().slice(0, 10)} (employer ${filing.employerIrd}) — a payslip can be filed in exactly one Employment Information return. Regenerate that filing from its own run instead.`,
        );
      }
      // Regenerable (DRAFT/GENERATED/REJECTED) for THIS payday — but only
      // if the old filing covers exactly this run (no cross-run mixing).
      const otherRun = lines.find((l) => {
        const slip = run.payslips.find((p) => p.id === l.payslipId);
        return !slip;
      });
      if (otherRun || lines.length !== run.payslips.length) {
        // Lines outside this run: fetch their runs to explain.
        throw new Error(
          "The existing filing for this payday covers payslips from more than this run — regenerate it from the run that originally created it, or amend the filed return.",
        );
      }
      replaceFilingId ??= filingId;
    }
  }

  // ---- Per-payslip data ----------------------------------------------------
  const userIds = [...new Set(run.payslips.map((p) => p.userId))];
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const taxProfiles = await db.employeeTaxProfile.findMany({ where: { userId: { in: userIds } } });
  const profileByUser = new Map(taxProfiles.map((t) => [t.userId, t]));

  const eiLines: EiEmployeeLine[] = [];
  const reconcileSlips: Array<{ payslipId: string; runId: string; deductions: string; employerKiwiSaverNet: number; employerEsct: number; statutory: PayslipStatutoryT | null }> = [];

  for (const slip of run.payslips as unknown as FilingPayslipRow[]) {
    const snap = slip.statutory;
    if (!snap) {
      throw new Error(
        `Payslip ${slip.slipNo} was never priced by the statutory engine (no frozen computation) — re-save the payslip on an OPEN run, or re-price before the next lock. It cannot be filed.`,
      );
    }
    const taxCode = (slip.taxCodeApplied || snap.taxCode || "").trim();
    if (taxCode === "") {
      throw new Error(`Payslip ${slip.slipNo} has no tax code applied — the IR330 declaration is missing, so the return cannot be filed.`);
    }
    const profile = profileByUser.get(slip.userId);
    const ird = normaliseIrd(profile?.irdNumber ?? "");
    const name = userName.get(slip.userId) ?? "Unknown Unknown";
    const employeeName = splitFullName(name, `Payslip ${slip.slipNo} (${name})`).surnameFirstnames;

    eiLines.push({
      employeeIrd: ird === "" ? "000000000" : ird,
      employeeName,
      taxCode,
      // Spec: employment dates are filed only when they fall INSIDE the
      // period being reported (otherwise IRD already has them from the ED).
      employmentStart: profile?.employmentStartDate && inPeriod(profile.employmentStartDate, periodStart, periodEnd) ? profile.employmentStartDate : null,
      employmentEnd: profile?.employmentEndDate && inPeriod(profile.employmentEndDate, periodStart, periodEnd) ? profile.employmentEndDate : null,
      periodStart,
      periodEnd,
      frequency: run.frequency,
      // Fernly tracks paid days, not hours — the spec's "Default 0 if not
      // held" (ADR-018).
      hoursPaidCents: 0,
      grossCents: toCents(snap.taxableGross, `${slip.slipNo} taxable gross`),
      priorGrossAdjCents: 0,
      notLiableAccCents: 0, // YTD ACC cap deferred (ADR-018)
      lumpSumIndicator: "0",
      // Income tax ONLY (the ACC levy is a separate line IRD derives);
      // clamp at 0 exactly like the payslip line + GL credit.
      payeCents: toCents(Math.max(0, snap.paye.tax), `${slip.slipNo} PAYE`),
      priorPayeAdjCents: 0,
      childSupportCents: 0,
      childSupportCode: null,
      studentLoanCents: toCents(snap.studentLoan, `${slip.slipNo} student loan`),
      slcirCents: 0,
      slborCents: 0,
      kiwisaverEmployeeCents: toCents(snap.kiwiSaver.employee, `${slip.slipNo} KiwiSaver employee`),
      kiwisaverEmployerNetCents: toCents(dec(slip.employerKiwiSaverNet) || snap.kiwiSaver.employerNet, `${slip.slipNo} employer KiwiSaver net`),
      esctCents: toCents(dec(slip.employerEsct) || snap.kiwiSaver.esct, `${slip.slipNo} ESCT`),
      donationsCents: 0,
      familyTaxCreditCents: 0,
      shareSchemeCents: 0,
    });
    reconcileSlips.push({
      payslipId: slip.id,
      runId: slip.runId,
      deductions: slip.deductions,
      employerKiwiSaverNet: dec(slip.employerKiwiSaverNet) || snap.kiwiSaver.employerNet,
      employerEsct: dec(slip.employerEsct) || snap.kiwiSaver.esct,
      statutory: snap,
    });
  }

  // ---- Build + reconcile BEFORE any write ---------------------------------
  const built = buildEiFile({
    header: {
      employerIrd: settings.employerIrdNumber,
      payDate,
      payeIntermediaryIrd: settings.payeIntermediaryIrd,
      contactName: settings.payrollContactName,
      contactPhone: settings.payrollContactPhone,
      contactEmail: settings.payrollContactEmail,
      packageIdentifier: settings.payrollPackageIdentifier,
      irFormVersion: settings.irFormVersionNumber,
    },
    lines: eiLines,
  });

  const journalCredits = await loadJournalCredits([runId]);
  const reconciliation = runReconciliation({
    filingId: replaceFilingId ?? "prospective",
    totals: {
      payeCents: built.totals.payeCents,
      kiwisaverEmployeeCents: built.totals.kiwisaverEmployeeCents,
      kiwisaverEmployerNetCents: built.totals.kiwisaverEmployerNetCents,
      esctCents: built.totals.esctCents,
      studentLoanCents: built.totals.studentLoanCents,
      grossCents: built.totals.grossCents,
    },
    payslips: reconcileSlips,
    journalCredits,
  });
  if (!reconciliation.allPass) {
    throw new Error(reconciliationRefusalMessage(reconciliation));
  }

  const holidays = await holidayLookupFor(payDate, settings.nzBusinessHolidays);
  const dueDate = computeDueDate(payDate, holidays);
  const fileHash = createHash("sha256").update(built.content, "utf8").digest("hex");

  // ---- Persist (one transaction) -------------------------------------------
  const lineRows = eiLines.map((l, i) => ({
    payslipId: payslipIds[i],
    employeeId: run.payslips[i].userId,
    employeeIrd: l.employeeIrd,
    employeeName: l.employeeName,
    taxCode: l.taxCode,
    employmentStart: l.employmentStart,
    employmentEnd: l.employmentEnd,
    periodStart: l.periodStart,
    periodEnd: l.periodEnd,
    payCycle,
    hoursPaidCents: l.hoursPaidCents,
    grossCents: l.grossCents,
    priorGrossAdjCents: l.priorGrossAdjCents,
    notLiableAccCents: l.notLiableAccCents,
    lumpSumIndicator: l.lumpSumIndicator,
    payeCents: l.payeCents,
    priorPayeAdjCents: l.priorPayeAdjCents,
    childSupportCents: l.childSupportCents,
    childSupportCode: l.childSupportCode,
    studentLoanCents: l.studentLoanCents,
    slcirCents: l.slcirCents,
    slborCents: l.slborCents,
    kiwisaverEmployeeCents: l.kiwisaverEmployeeCents,
    kiwisaverEmployerNetCents: l.kiwisaverEmployerNetCents,
    esctCents: l.esctCents,
    donationsCents: l.donationsCents,
    familyTaxCreditCents: l.familyTaxCreditCents,
    shareSchemeCents: l.shareSchemeCents,
  }));

  const filingId = await db.$transaction(async (tx) => {
    if (replaceFilingId) {
      // Cascade removes the old lines first (frees the payslipId uniques).
      await tx.paydayFiling.delete({ where: { id: replaceFilingId } });
    }
    const created = await tx.paydayFiling.create({
      data: {
        employerIrd: settings.employerIrdNumber,
        payDate,
        periodStart,
        periodEnd,
        payCycle,
        status: "GENERATED",
        fileContent: built.content,
        fileHash,
        totalEmployeeLines: built.totals.employeeLines,
        totalGrossCents: built.totals.grossCents,
        totalPayeCents: built.totals.payeCents,
        totalKiwisaverEmployeeCents: built.totals.kiwisaverEmployeeCents,
        totalKiwisaverEmployerNetCents: built.totals.kiwisaverEmployerNetCents,
        totalEsctCents: built.totals.esctCents,
        totalStudentLoanCents: built.totals.studentLoanCents,
        generatedAt: new Date(),
        generatedById: opts.generatedById ?? "",
        dueDate,
        lines: { create: lineRows },
      },
      select: { id: true },
    });
    return created.id;
  });

  return {
    id: filingId,
    status: "GENERATED",
    payDate,
    dueDate,
    totalEmployeeLines: built.totals.employeeLines,
    reconciliation: { ...reconciliation, filingId },
  };
}

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

async function loadFiling(filingId: string) {
  const filing = await db.paydayFiling.findUnique({ where: { id: filingId } });
  if (!filing) throw new Error(`Payday filing ${filingId} not found.`);
  return filing;
}

/** GENERATED → FILED (the user confirms the upload to myIR). */
export async function markFiled(
  filingId: string,
  input: { filedById: string; irdReference?: string | null },
): Promise<void> {
  const filing = await loadFiling(filingId);
  if (filing.status !== "GENERATED") {
    throw new Error(`Only a GENERATED filing can be marked as filed — this one is ${filing.status}.`);
  }
  await db.paydayFiling.update({
    where: { id: filingId },
    data: {
      status: "FILED",
      filedAt: new Date(),
      filedById: input.filedById,
      irdReference: input.irdReference?.trim() ? input.irdReference.trim() : null,
    },
  });
}

/** FILED → ACCEPTED. */
export async function markAccepted(filingId: string): Promise<void> {
  const filing = await loadFiling(filingId);
  if (filing.status !== "FILED") {
    throw new Error(`Only a FILED filing can be marked accepted — this one is ${filing.status}.`);
  }
  await db.paydayFiling.update({ where: { id: filingId }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
}

/** FILED → REJECTED (requires the pasted myIR error report). */
export async function markRejected(filingId: string, input: { errorReport: string }): Promise<void> {
  const filing = await loadFiling(filingId);
  if (filing.status !== "FILED") {
    throw new Error(`Only a FILED filing can be marked rejected — this one is ${filing.status}.`);
  }
  if (!input.errorReport || input.errorReport.trim() === "") {
    throw new Error("Paste the myIR error report (View and export error report) when marking a filing rejected.");
  }
  await db.paydayFiling.update({
    where: { id: filingId },
    data: { status: "REJECTED", rejectedAt: new Date(), irdErrorReport: input.errorReport },
  });
}

// ---------------------------------------------------------------------------
// Deadline watch
// ---------------------------------------------------------------------------

/**
 * Flag GENERATED/FILED filings whose 2-working-day deadline has passed.
 * Idempotent (only rows with a null overdueFlaggedAt are touched).
 * Returns the number newly flagged.
 */
export async function flagOverdueFilings(now: Date = new Date()): Promise<number> {
  const result = await db.paydayFiling.updateMany({
    where: {
      status: { in: ["GENERATED", "FILED"] },
      dueDate: { lt: now },
      overdueFlaggedAt: null,
    },
    data: { overdueFlaggedAt: now },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Employee Details (ED)
// ---------------------------------------------------------------------------

export interface PendingEmployeeDetails {
  userId: string;
  name: string;
  email: string;
  phone: string;
  kind: EdFilingKind;
  reason: string;
}

/** Employees whose join/departure falls in the window and who have no ED
 * notification of that kind yet (the "never notify twice" listing). */
export async function listPendingEmployeeDetails(
  periodStart: Date,
  periodEnd: Date,
): Promise<PendingEmployeeDetails[]> {
  const started = await db.employeeTaxProfile.findMany({
    where: {
      employmentStartDate: { gte: periodStart, lte: periodEnd },
    },
  });
  const ended = await db.employeeTaxProfile.findMany({
    where: {
      employmentEndDate: { gte: periodStart, lte: periodEnd },
    },
  });
  const existing = await db.employeeDetailsFiling.findMany({
    select: { employeeId: true, kind: true },
  });
  const done = new Set(existing.map((e) => `${e.employeeId}:${e.kind}`));

  const allUserIds = [...new Set([...started, ...ended].map((t) => t.userId))];
  const users = allUserIds.length > 0
    ? await db.user.findMany({ where: { id: { in: allUserIds } }, select: { id: true, name: true, email: true } })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const profiles = allUserIds.length > 0
    ? await db.employeeProfile.findMany({ where: { userId: { in: allUserIds } }, select: { userId: true, phone: true } })
    : [];
  const phoneByUser = new Map(profiles.map((p) => [p.userId, p.phone]));

  const out: PendingEmployeeDetails[] = [];
  for (const t of started) {
    if (done.has(`${t.userId}:NEW`)) continue;
    if (ended.some((e) => e.userId === t.userId)) continue; // same-window start+end: only the departure is notified
    const user = userById.get(t.userId);
    if (!user) continue;
    out.push({
      userId: t.userId,
      name: user.name,
      email: user.email,
      phone: phoneByUser.get(t.userId) ?? "",
      kind: "NEW",
      reason: `employment started ${t.employmentStartDate?.toISOString().slice(0, 10)}`,
    });
  }
  for (const t of ended) {
    if (done.has(`${t.userId}:DEPARTING`)) continue;
    const user = userById.get(t.userId);
    if (!user) continue;
    out.push({
      userId: t.userId,
      name: user.name,
      email: user.email,
      phone: phoneByUser.get(t.userId) ?? "",
      kind: "DEPARTING",
      reason: `employment ended ${t.employmentEndDate?.toISOString().slice(0, 10)}`,
    });
  }
  return out;
}

export interface GeneratedEmployeeDetails {
  ids: string[];
  employeeLineCount: number;
}

/**
 * Generate ED notifications for the given employees (one shared HED2 +
 * DED + TED file). Kind is derived per employee: an employment end date
 * makes it DEPARTING, otherwise NEW. Refuses when the employee was
 * already notified for that kind, or when a mandatory field cannot be
 * sourced (the builder's IrdFormatError carries the exact field).
 */
export async function generateEmployeeDetails(
  input: { employeeIds: string[]; generatedById?: string },
): Promise<GeneratedEmployeeDetails> {
  const settings = await requireSettings();
  if (input.employeeIds.length === 0) {
    throw new Error("Select at least one employee to notify.");
  }

  const taxProfiles = await db.employeeTaxProfile.findMany({
    where: { userId: { in: input.employeeIds } },
  });
  const users = await db.user.findMany({
    where: { id: { in: input.employeeIds } },
    select: { id: true, name: true, email: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));
  const profiles = await db.employeeProfile.findMany({
    where: { userId: { in: input.employeeIds } },
    select: { userId: true, phone: true, birthDate: true },
  });
  const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
  const byUser = new Map(taxProfiles.map((t) => [t.userId, t]));

  const existing = await db.employeeDetailsFiling.findMany({
    where: { employeeId: { in: input.employeeIds } },
    select: { employeeId: true, kind: true, status: true },
  });
  const existingByKind = new Map(existing.map((e) => [`${e.employeeId}:${e.kind}`, e.status]));

  const lines: EdEmployeeLine[] = [];
  const kinds: EdFilingKind[] = [];
  for (const userId of input.employeeIds) {
    const t = byUser.get(userId);
    const user = userById.get(userId);
    if (!t || !user) throw new Error(`Employee ${userId} has no tax profile — record their IRD number and tax code before notifying IRD.`);
    const kind: EdFilingKind = t.employmentEndDate ? "DEPARTING" : "NEW";
    const priorStatus = existingByKind.get(`${userId}:${kind}`);
    if (priorStatus) {
      throw new Error(
        `${user.name} already has a ${kind === "NEW" ? "new-employee" : "departing-employee"} notification (${priorStatus}) — IRD is notified at most once per employee per event.`,
      );
    }
    if (!t.employmentStartDate) {
      throw new Error(`${user.name} has no employment start date — IRD requires it on every Employee Details line (even for a departure).`);
    }
    if (kind === "NEW" && existingByKind.has(`${userId}:DEPARTING`)) {
      // A departure was already notified; a NEW line now would be noise.
      throw new Error(`${user.name} already has a departing-employee notification — file at most one event per direction.`);
    }
    const p = profileByUser.get(userId);
    lines.push({
      kind,
      employeeIrd: normaliseIrd(t.irdNumber ?? ""),
      fullName: user.name,
      taxCode: t.taxCode || "M", // as declared (base + optional SL suffix)
      dateOfBirth: p?.birthDate ?? null,
      employmentStart: t.employmentStartDate,
      employmentEnd: t.employmentEndDate,
      kiwiSaverStatus: t.kiwiSaverStatus,
      isCasual: t.isCasual || t.employmentType === "CASUAL" || t.employmentType === "CASUAL_AGRICULTURAL",
      email: user.email,
      phone: p?.phone ?? "",
    });
    kinds.push(kind);
  }

  const built = buildEdFile(
    {
      employerIrd: settings.employerIrdNumber,
      packageIdentifier: settings.payrollPackageIdentifier,
    },
    lines,
  );
  const fileHash = createHash("sha256").update(built.content, "utf8").digest("hex");

  const ids = await db.$transaction(async (tx) => {
    const created: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const row = await tx.employeeDetailsFiling.create({
        data: {
          employerIrd: settings.employerIrdNumber,
          employeeId: input.employeeIds[i],
          employeeIrd: lines[i].employeeIrd,
          employeeName: lines[i].fullName,
          kind: kinds[i],
          status: "GENERATED",
          fileContent: built.content,
          fileHash,
          generatedAt: new Date(),
          generatedById: input.generatedById ?? "",
        },
        select: { id: true },
      });
      created.push(row.id);
    }
    return created;
  });

  return { ids, employeeLineCount: built.employeeLineCount };
}

/** ED status transitions (same machine minus AMENDED). */
export async function markEmployeeDetailsFiled(id: string, input: { filedById: string }): Promise<void> {
  const row = await db.employeeDetailsFiling.findUnique({ where: { id } });
  if (!row) throw new Error(`Employee details filing ${id} not found.`);
  if (row.status !== "GENERATED") throw new Error(`Only a GENERATED employee details notification can be marked filed — this one is ${row.status}.`);
  await db.employeeDetailsFiling.update({
    where: { id },
    data: { status: "FILED", filedAt: new Date(), filedById: input.filedById },
  });
}

export async function markEmployeeDetailsAccepted(id: string): Promise<void> {
  const row = await db.employeeDetailsFiling.findUnique({ where: { id } });
  if (!row) throw new Error(`Employee details filing ${id} not found.`);
  if (row.status !== "FILED") throw new Error(`Only a FILED employee details notification can be marked accepted — this one is ${row.status}.`);
  await db.employeeDetailsFiling.update({ where: { id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
}

export async function markEmployeeDetailsRejected(id: string, input: { errorReport: string }): Promise<void> {
  const row = await db.employeeDetailsFiling.findUnique({ where: { id } });
  if (!row) throw new Error(`Employee details filing ${id} not found.`);
  if (row.status !== "FILED") throw new Error(`Only a FILED employee details notification can be marked rejected — this one is ${row.status}.`);
  if (!input.errorReport || input.errorReport.trim() === "") {
    throw new Error("Paste the myIR error report when marking an employee details notification rejected.");
  }
  await db.employeeDetailsFiling.update({
    where: { id },
    data: { status: "REJECTED", rejectedAt: new Date(), irdErrorReport: input.errorReport },
  });
}

// ---------------------------------------------------------------------------
// Amendments (EIA2)
// ---------------------------------------------------------------------------

export interface AmendmentCorrectionInput {
  /** The employee whose filed line is corrected. */
  employeeId: string;
  /** The corrected values (dollars→cents done by the caller); any field
   * left undefined keeps the as-filed value. Null = DELETE the line. */
  amended: Partial<
    Pick<
      AmendmentLineValues,
      | "hoursPaidCents" | "grossCents" | "priorGrossAdjCents" | "notLiableAccCents"
      | "lumpSumIndicator" | "payeCents" | "priorPayeAdjCents" | "childSupportCents"
      | "childSupportCode" | "studentLoanCents" | "slcirCents" | "slborCents"
      | "kiwisaverEmployeeCents" | "kiwisaverEmployerNetCents" | "esctCents"
      | "donationsCents" | "familyTaxCreditCents" | "shareSchemeCents"
    >
  > & { employeeIrd?: string; employeeName?: string; taxCode?: string }
   | null;
}

export interface GeneratedAmendment {
  id: string;
  originalFilingId: string;
  pairCount: number;
}

/**
 * Generate an EIA2 amendment for a FILED (or already amended) EI filing.
 * The DTI side is reconstructed from the frozen PaydayFilingLine rows —
 * exactly what the uploaded file contained. The original filing flips to
 * AMENDED with amendedByFilingId pointing at the new row.
 */
export async function generateAmendmentFiling(
  originalFilingId: string,
  corrections: AmendmentCorrectionInput[],
  opts: { generatedById?: string } = {},
): Promise<GeneratedAmendment> {
  const settings = await requireSettings();
  const original = await db.paydayFiling.findUnique({
    where: { id: originalFilingId },
    include: { lines: true },
  });
  if (!original) throw new Error(`Payday filing ${originalFilingId} not found.`);
  if (original.status === "DRAFT" || original.status === "GENERATED") {
    throw new Error(`An amendment corrects a filing that was uploaded to myIR — this one is still ${original.status}. Regenerate it instead.`);
  }
  if (corrections.length === 0) {
    throw new Error("An amendment needs at least one correction.");
  }

  const lineByEmployee = new Map(original.lines.map((l) => [l.employeeId, l]));

  /** The frozen as-filed record for one stored line. */
  const frozenValues = (l: (typeof original.lines)[number]): AmendmentLineValues => ({
    employeeIrd: l.employeeIrd,
    employeeName: l.employeeName,
    taxCode: l.taxCode,
    employmentStart: l.employmentStart,
    employmentEnd: l.employmentEnd,
    periodStart: l.periodStart,
    periodEnd: l.periodEnd,
    frequency: payCycleToFrequency(l.payCycle),
    hoursPaidCents: l.hoursPaidCents,
    grossCents: l.grossCents,
    priorGrossAdjCents: l.priorGrossAdjCents,
    notLiableAccCents: l.notLiableAccCents,
    lumpSumIndicator: l.lumpSumIndicator,
    payeCents: l.payeCents,
    priorPayeAdjCents: l.priorPayeAdjCents,
    childSupportCents: l.childSupportCents,
    childSupportCode: l.childSupportCode,
    studentLoanCents: l.studentLoanCents,
    slcirCents: l.slcirCents,
    slborCents: l.slborCents,
    kiwisaverEmployeeCents: l.kiwisaverEmployeeCents,
    kiwisaverEmployerNetCents: l.kiwisaverEmployerNetCents,
    esctCents: l.esctCents,
    donationsCents: l.donationsCents,
    familyTaxCreditCents: l.familyTaxCreditCents,
    shareSchemeCents: l.shareSchemeCents,
  });

  const pairs: AmendmentCorrection[] = [];
  for (const c of corrections) {
    const line = lineByEmployee.get(c.employeeId);
    if (!line) {
      throw new Error(`Employee ${c.employeeId} is not on the filing being amended — to ADD a new employee line, generate the amendment with their payslip data through the run's filing panel.`);
    }
    const originalValues = frozenValues(line);

    if (c.amended === null) {
      // DELETE: filed values in, nil out.
      pairs.push({ original: originalValues, amended: null });
      continue;
    }

    // UPDATE: merge the corrections over the frozen record (undefined
    // keys keep the as-filed value — strip them before spreading).
    const profile = await db.employeeTaxProfile.findUnique({ where: { userId: c.employeeId } });
    const user = await db.user.findUnique({ where: { id: c.employeeId }, select: { name: true } });
    const clean = Object.fromEntries(
      Object.entries(c.amended).filter(([, v]) => v !== undefined),
    ) as Record<string, unknown>;
    const merged: AmendmentLineValues = {
      ...originalValues,
      ...clean,
      employeeIrd: c.amended.employeeIrd ?? (profile?.irdNumber ? normaliseIrd(profile.irdNumber) : originalValues.employeeIrd),
      employeeName: c.amended.employeeName ?? (user ? splitFullName(user.name, `Amendment for ${user.name}`).surnameFirstnames : originalValues.employeeName),
      taxCode: c.amended.taxCode ?? originalValues.taxCode,
      employmentStart: originalValues.employmentStart,
      employmentEnd: originalValues.employmentEnd,
      periodStart: originalValues.periodStart,
      periodEnd: originalValues.periodEnd,
      frequency: originalValues.frequency,
    };
    pairs.push({ original: originalValues, amended: merged });
  }

  const built = buildEia2File(
    {
      employerIrd: settings.employerIrdNumber,
      payDate: original.payDate,
      payeIntermediaryIrd: settings.payeIntermediaryIrd,
      contactName: settings.payrollContactName,
      contactPhone: settings.payrollContactPhone,
      irFormVersion: settings.irFormVersionNumber,
    },
    pairs,
  );
  const fileHash = createHash("sha256").update(built.content, "utf8").digest("hex");

  const amendmentId = await db.$transaction(async (tx) => {
    const created = await tx.paydayAmendmentFiling.create({
      data: {
        originalFilingId,
        employerIrd: settings.employerIrdNumber,
        payDate: original.payDate,
        status: "GENERATED",
        fileContent: built.content,
        fileHash,
        correctionCount: built.pairCount,
        generatedAt: new Date(),
        generatedById: opts.generatedById ?? "",
      },
      select: { id: true },
    });
    await tx.paydayFiling.update({
      where: { id: originalFilingId },
      data: { status: "AMENDED", amendedByFilingId: created.id },
    });
    return created.id;
  });

  return { id: amendmentId, originalFilingId, pairCount: built.pairCount };
}

/** EIA2 status transitions. */
export async function markAmendmentFiled(id: string, input: { filedById: string }): Promise<void> {
  const row = await db.paydayAmendmentFiling.findUnique({ where: { id } });
  if (!row) throw new Error(`Amendment filing ${id} not found.`);
  if (row.status !== "GENERATED") throw new Error(`Only a GENERATED amendment can be marked filed — this one is ${row.status}.`);
  await db.paydayAmendmentFiling.update({
    where: { id },
    data: { status: "FILED", filedAt: new Date(), filedById: input.filedById },
  });
}

export async function markAmendmentAccepted(id: string): Promise<void> {
  const row = await db.paydayAmendmentFiling.findUnique({ where: { id } });
  if (!row) throw new Error(`Amendment filing ${id} not found.`);
  if (row.status !== "FILED") throw new Error(`Only a FILED amendment can be marked accepted — this one is ${row.status}.`);
  await db.paydayAmendmentFiling.update({ where: { id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
}

export { IrdFormatError };
