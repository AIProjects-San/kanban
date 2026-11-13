"use server";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the IRD filing server actions.
//
// Every action requires payroll:manage (ADMIN + HR + SUPER_ADMIN — the
// same guard as every other payroll action). The pages hosting these
// actions additionally sit behind the payroll admin layout guard. All
// heavy lifting lives in src/lib/ird/* (pure builders + the filing
// service); this file is permissioning, validation, audit and DTOs.
//
// Fernly NEVER uploads anything to myIR — it builds the file, the user
// downloads it and uploads it themselves (CSV file upload is the only
// self-service route since Gateway Services went behind the portal).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/infra/db";
import { toResult } from "./result";
import { AuthorizationError } from "./auth-guard";
import { requirePermission } from "./auth-guard";
import { logAudit } from "./shared";
import type { ActionResult } from "@/lib/shared/action-result";
import { isValidEmployerIrdNumber } from "@/lib/ird/ird-number";
import { workingDaysRemaining } from "@/lib/ird/deadline";
import { isFilingCadence } from "@/lib/ird/pay-cycle";
import { reconcilePaydayFiling, type ReconciliationReport } from "@/lib/ird/reconciliation";
import {
  flagOverdueFilings,
  generateAmendmentFiling,
  generateEmployeeDetails,
  generatePaydayFiling,
  getFilingSettings,
  listPendingEmployeeDetails,
  markAmendmentAccepted,
  markAmendmentFiled,
  markAccepted,
  markEmployeeDetailsAccepted,
  markEmployeeDetailsFiled,
  markEmployeeDetailsRejected,
  markFiled,
  markRejected,
} from "@/lib/ird/filing-service";
import type {
  EmployeeDetailsViewT,
  PaydayFilingSummaryT,
  PayrollFilingSettingsT,
  RunFilingPanelT,
} from "@/lib/ird/filing-types";
import type { PaydayFiling, EmployeeDetailsFiling, PaydayAmendmentFiling, PayrollRun } from "@prisma/client";
import { toCents } from "@/lib/payroll/payroll-math";

const cuidish = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const saveFilingSettingsSchema = z
  .object({
    employerIrdNumber: z.string().trim().min(1, "Enter the employer IRD number."),
    employerName: z.string().trim().min(1, "Enter the employer name as registered with IRD."),
    payeIntermediaryIrd: z.string().trim().optional().default(""),
    payrollContactName: z.string().trim().min(1, "Enter the payroll contact's name (IRD contacts them when a file bounces).").max(20, "The contact name must be 20 characters or fewer."),
    payrollContactPhone: z.string().trim().min(1, "Enter the payroll contact's work phone.").max(12, "The contact phone must be 12 characters or fewer."),
    payrollContactEmail: z.string().trim().min(1, "Enter the payroll contact's email.").max(60, "The contact email must be 60 characters or fewer."),
    payrollPackageIdentifier: z.string().trim().min(1, "Enter the payroll package identifier (e.g. Fernly v1.0).").max(80, "The package identifier must be 80 characters or fewer."),
    irFormVersionNumber: z.literal("0001", { message: "The IR form version must be 0001." }),
  })
  .strict();

function parseOrThrowThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const err = new Error(first ? `${first.path.join(".") ? `${first.path.join(".")}: ` : ""}${first.message}` : "Invalid input.") as Error;
    err.name = "ValidationError";
    throw err;
  }
  return parsed.data;
}

export async function getPayrollFilingSettings(): Promise<ActionResult<PayrollFilingSettingsT | null>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const s = await getFilingSettings();
    if (!s) return null;
    return {
      employerIrdNumber: s.employerIrdNumber,
      employerName: s.employerName,
      payeIntermediaryIrd: s.payeIntermediaryIrd ?? "",
      payrollContactName: s.payrollContactName,
      payrollContactPhone: s.payrollContactPhone,
      payrollContactEmail: s.payrollContactEmail,
      payrollPackageIdentifier: s.payrollPackageIdentifier,
      irFormVersionNumber: s.irFormVersionNumber,
    };
  });
}

export async function savePayrollFilingSettings(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(saveFilingSettingsSchema, input);

    // IRD number validation — the spec-exact mod-11 check (myIR rejects
    // the whole file on a bad employer IRD). See lib/ird/ird-number.ts
    // for why this is not the Phase 1 helper.
    const digits = data.employerIrdNumber.replace(/\D/g, "");
    if (!isValidEmployerIrdNumber(digits)) {
      throw new AuthorizationError(`"${data.employerIrdNumber}" is not a valid employer IRD number (9 digits, mod-11 check, inside IRD's issued range) — enter the employer's real IRD number.`);
    }
    if (data.payeIntermediaryIrd !== "") {
      const pi = data.payeIntermediaryIrd.replace(/\D/g, "");
      if (!isValidEmployerIrdNumber(pi)) {
        throw new AuthorizationError(`"${data.payeIntermediaryIrd}" is not a valid PAYE intermediary IRD number — leave it blank if no intermediary files for this employer.`);
      }
    }
    if (/[,]/.test(data.payrollContactName) || /[,]/.test(data.payrollPackageIdentifier)) {
      throw new AuthorizationError("Commas are never allowed in IRD file fields — remove them from the contact name / package identifier.");
    }
    if (!/^[A-Za-z0-9]+$/.test(data.payrollContactPhone)) {
      throw new AuthorizationError("The contact phone must be digits (and letters) only — no spaces, dashes or symbols.");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.payrollContactEmail)) {
      throw new AuthorizationError("Enter a valid email address for the payroll contact.");
    }

    await db.payrollSettings.upsert({
      where: { id: "default" },
      update: {
        employerIrdNumber: digits.padStart(9, "0"),
        employerName: data.employerName,
        payeIntermediaryIrd: data.payeIntermediaryIrd === "" ? null : data.payeIntermediaryIrd.replace(/\D/g, "").padStart(9, "0"),
        payrollContactName: data.payrollContactName,
        payrollContactPhone: data.payrollContactPhone,
        payrollContactEmail: data.payrollContactEmail,
        payrollPackageIdentifier: data.payrollPackageIdentifier,
        irFormVersionNumber: data.irFormVersionNumber,
      },
      create: {
        id: "default",
        employerIrdNumber: digits.padStart(9, "0"),
        employerName: data.employerName,
        payeIntermediaryIrd: data.payeIntermediaryIrd === "" ? null : data.payeIntermediaryIrd.replace(/\D/g, "").padStart(9, "0"),
        payrollContactName: data.payrollContactName,
        payrollContactPhone: data.payrollContactPhone,
        payrollContactEmail: data.payrollContactEmail,
        payrollPackageIdentifier: data.payrollPackageIdentifier,
        irFormVersionNumber: data.irFormVersionNumber,
      },
    });

    await logAudit({
      actor: auth,
      action: "payday.settings_saved",
      entityType: "PAYROLL_SETTINGS",
      entityId: "default",
      entityLabel: data.employerName,
      detail: `${auth.name} saved the payroll filing settings (employer IRD …${digits.slice(-3)}, contact ${data.payrollContactName}).`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Filing panel (per run)
// ---------------------------------------------------------------------------

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function toSummary(row: PaydayFiling, runPeriods: string[]): PaydayFilingSummaryT {
  return {
    id: row.id,
    employerIrd: row.employerIrd,
    payDate: row.payDate.toISOString(),
    periodStart: isoOrNull(row.periodStart),
    periodEnd: isoOrNull(row.periodEnd),
    payCycle: row.payCycle,
    status: row.status,
    totalEmployeeLines: row.totalEmployeeLines,
    totalGrossCents: row.totalGrossCents,
    totalPayeCents: row.totalPayeCents,
    totalKiwisaverEmployeeCents: row.totalKiwisaverEmployeeCents,
    totalKiwisaverEmployerNetCents: row.totalKiwisaverEmployerNetCents,
    totalEsctCents: row.totalEsctCents,
    totalStudentLoanCents: row.totalStudentLoanCents,
    dueDate: row.dueDate.toISOString(),
    overdueFlaggedAt: isoOrNull(row.overdueFlaggedAt),
    generatedAt: isoOrNull(row.generatedAt),
    generatedById: row.generatedById,
    filedAt: isoOrNull(row.filedAt),
    filedById: row.filedById,
    irdReference: row.irdReference,
    acceptedAt: isoOrNull(row.acceptedAt),
    rejectedAt: isoOrNull(row.rejectedAt),
    irdErrorReport: row.irdErrorReport,
    amendedByFilingId: row.amendedByFilingId,
    hasFile: row.fileContent != null,
    workingDaysRemaining: workingDaysRemaining(new Date(), row.dueDate),
    runPeriods,
  };
}

export async function getRunFilingPanel(input: { runId: string }): Promise<ActionResult<RunFilingPanelT>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const runId = String(input?.runId ?? "").trim();
    const run = await db.payrollRun.findUnique({ where: { id: runId } });
    if (!run) throw new AuthorizationError("Payroll run not found.");

    // Which filings cover this run's payslips (normally exactly one).
    const runSlips = await db.payslip.findMany({ where: { runId }, select: { id: true } });
    const lines = runSlips.length > 0
      ? await db.paydayFilingLine.findMany({
          where: { payslipId: { in: runSlips.map((p) => p.id) } },
          select: { filingId: true },
        })
      : [];
    const filingIds = [...new Set(lines.map((l) => l.filingId))];
    const filings = filingIds.length > 0 ? await db.paydayFiling.findMany({ where: { id: { in: filingIds } } }) : [];
    const filing = filings[0] ?? null;

    let reconciliation: ReconciliationReport | null = null;
    if (filing) {
      try {
        reconciliation = await reconcilePaydayFiling(filing.id);
      } catch {
        reconciliation = null; // the panel shows the raw filing; a broken reconciliation shows as unavailable
      }
    }

    const amendments = filing
      ? await db.paydayAmendmentFiling.findMany({
          where: { originalFilingId: filing.id },
          orderBy: { createdAt: "desc" },
        })
      : [];

    return {
      run: {
        id: run.id,
        period: run.period,
        frequency: run.frequency,
        status: run.status,
        startDate: isoOrNull(run.startDate),
        endDate: isoOrNull(run.endDate),
        payDate: isoOrNull(run.payDate),
      },
      filingCadenceSupported: isFilingCadence(run.frequency),
      filing: filing ? toSummary(filing, [run.period]) : null,
      reconciliation,
      amendments: amendments.map((a) => ({
        id: a.id,
        status: a.status,
        correctionCount: a.correctionCount,
        generatedAt: isoOrNull(a.generatedAt),
        filedAt: isoOrNull(a.filedAt),
        acceptedAt: isoOrNull(a.acceptedAt),
      })),
    };
  });
}

export async function generatePaydayFilingAction(input: unknown): Promise<ActionResult<{ filingId: string; reconciliation: ReconciliationReport }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ runId: cuidish }).strict(), input);

    // Was there a previous (REJECTED/GENERATED) filing for these payslips?
    const priorLines = await db.paydayFilingLine.findMany({
      where: { payslipId: { in: (await db.payslip.findMany({ where: { runId: data.runId }, select: { id: true } })).map((p) => p.id) } },
      select: { filingId: true },
    });
    const isRegeneration = priorLines.length > 0;

    const result = await generatePaydayFiling(data.runId, { generatedById: auth.userId });
    await logAudit({
      actor: auth,
      action: isRegeneration ? "payday.filing_regenerated" : "payday.filing_generated",
      entityType: "PAYDAY_FILING",
      entityId: result.id,
      entityLabel: `EI ${result.payDate.toISOString().slice(0, 10)}`,
      detail: `${auth.name} generated the Employment Information file for payday ${result.payDate.toISOString().slice(0, 10)} (${result.totalEmployeeLines} employee line(s), gross ${(result.reconciliation.checks[6]?.filingCents ?? 0) / 100} — due ${result.dueDate.toISOString().slice(0, 10)}). Reconciliation: all ${result.reconciliation.checks.length} checks pass.`,
    });
    revalidatePath("/");
    return { filingId: result.id, reconciliation: result.reconciliation };
  });
}

export async function downloadPaydayFilingFile(input: unknown): Promise<ActionResult<{ filename: string; csv: string; mime: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ filingId: cuidish }).strict(), input);
    const filing = await db.paydayFiling.findUnique({ where: { id: data.filingId } });
    if (!filing) throw new AuthorizationError("Payday filing not found.");
    if (!filing.fileContent) throw new AuthorizationError("This filing has no stored file content.");
    await logAudit({
      actor: auth,
      action: "payday.filing_downloaded",
      entityType: "PAYDAY_FILING",
      entityId: filing.id,
      entityLabel: `EI ${filing.payDate.toISOString().slice(0, 10)}`,
      detail: `${auth.name} downloaded the Employment Information file for payday ${filing.payDate.toISOString().slice(0, 10)} (sha256 ${filing.fileHash?.slice(0, 12) ?? "n/a"}…).`,
    });
    return {
      filename: `EI-${filing.employerIrd}-${filing.payDate.toISOString().slice(0, 10).replace(/-/g, "")}.csv`,
      csv: filing.fileContent,
      mime: "text/csv",
    };
  });
}

export async function markPaydayFilingFiled(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ filingId: cuidish, irdReference: z.string().trim().max(120).optional() }).strict(), input);
    await markFiled(data.filingId, { filedById: auth.userId, irdReference: data.irdReference ?? null });
    const filing = await db.paydayFiling.findUnique({ where: { id: data.filingId } });
    await logAudit({
      actor: auth,
      action: "payday.filing_marked_filed",
      entityType: "PAYDAY_FILING",
      entityId: data.filingId,
      entityLabel: `EI ${filing?.payDate.toISOString().slice(0, 10) ?? data.filingId}`,
      detail: `${auth.name} confirmed the Employment Information upload to myIR${data.irdReference ? ` (reference ${data.irdReference})` : ""}.`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

export async function markPaydayFilingAccepted(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ filingId: cuidish }).strict(), input);
    await markAccepted(data.filingId);
    await logAudit({
      actor: auth,
      action: "payday.filing_marked_accepted",
      entityType: "PAYDAY_FILING",
      entityId: data.filingId,
      detail: `${auth.name} marked the Employment Information filing accepted by myIR.`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

export async function markPaydayFilingRejected(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ filingId: cuidish, errorReport: z.string().trim().min(1, "Paste the myIR error report.").max(60_000) }).strict(), input);
    await markRejected(data.filingId, { errorReport: data.errorReport });
    await logAudit({
      actor: auth,
      action: "payday.filing_marked_rejected",
      entityType: "PAYDAY_FILING",
      entityId: data.filingId,
      detail: `${auth.name} recorded an IRD rejection (${data.errorReport.slice(0, 200)}${data.errorReport.length > 200 ? "…" : ""}).`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Filings list
// ---------------------------------------------------------------------------

export async function listPaydayFilings(input?: { status?: string; overdue?: boolean }): Promise<ActionResult<PaydayFilingSummaryT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    await flagOverdueFilings(); // the manual "refresh" — idempotent
    const rows = await db.paydayFiling.findMany({ orderBy: { payDate: "desc" } });

    // Map filings → run periods via their lines (display only).
    const lineRows = await db.paydayFilingLine.findMany({ select: { filingId: true, payslipId: true } });
    const slipRows = await db.payslip.findMany({ select: { id: true, runId: true } });
    const runRows = await db.payrollRun.findMany({ select: { id: true, period: true } });
    const slipRun = new Map(slipRows.map((s) => [s.id, s.runId]));
    const runPeriod = new Map(runRows.map((r) => [r.id, r.period]));
    const periodsByFiling = new Map<string, string[]>();
    for (const l of lineRows) {
      const period = runPeriod.get(slipRun.get(l.payslipId) ?? "");
      if (!period) continue;
      const list = periodsByFiling.get(l.filingId) ?? [];
      if (!list.includes(period)) list.push(period);
      periodsByFiling.set(l.filingId, list);
    }

    let summaries = rows.map((r) => toSummary(r, periodsByFiling.get(r.id) ?? []));
    if (input?.status) summaries = summaries.filter((s) => s.status === input.status);
    if (input?.overdue) summaries = summaries.filter((s) => s.workingDaysRemaining < 0 && s.status !== "ACCEPTED" && s.status !== "AMENDED");
    return summaries;
  });
}

export async function refreshOverdueFilings(): Promise<ActionResult<{ flagged: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const flagged = await flagOverdueFilings();
    if (flagged > 0) {
      await logAudit({
        actor: auth,
        action: "payday.overdue_refreshed",
        entityType: "PAYDAY_FILING",
        detail: `${auth.name} refreshed overdue filing flags — ${flagged} newly past their 2-working-day deadline.`,
      });
    }
    revalidatePath("/");
    return { flagged };
  });
}

/** The runs list badge: filing status per run id. */
export async function getRunFilingStatus(): Promise<ActionResult<Record<string, { status: string; filingId: string; dueDate: string }>>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const lineRows = await db.paydayFilingLine.findMany({ select: { filingId: true, payslipId: true } });
    const slipRows = await db.payslip.findMany({ select: { id: true, runId: true } });
    const filings = await db.paydayFiling.findMany({ select: { id: true, status: true, dueDate: true } });
    const filingById = new Map(filings.map((f) => [f.id, f]));
    const slipRun = new Map(slipRows.map((s) => [s.id, s.runId]));
    const out: Record<string, { status: string; filingId: string; dueDate: string }> = {};
    for (const l of lineRows) {
      const runId = slipRun.get(l.payslipId);
      const filing = filingById.get(l.filingId);
      if (!runId || !filing) continue;
      if (!out[runId]) out[runId] = { status: filing.status, filingId: filing.id, dueDate: filing.dueDate.toISOString() };
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Employee Details
// ---------------------------------------------------------------------------

export async function getEmployeeDetailsView(input?: { periodKey?: string }): Promise<ActionResult<EmployeeDetailsViewT>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const match = /^(\d{4})-(\d{2})$/.exec(input?.periodKey ?? "");
    const now = new Date();
    const y = match ? Number(match[1]) : now.getUTCFullYear();
    const m = match ? Number(match[2]) : now.getUTCMonth() + 1;
    const periodStart = new Date(Date.UTC(y, m - 1, 1));
    const periodEnd = new Date(Date.UTC(y, m, 0));
    const periodKey = `${y}-${String(m).padStart(2, "0")}`;

    const pending = await listPendingEmployeeDetails(periodStart, periodEnd);
    const filedRows = await db.employeeDetailsFiling.findMany({ orderBy: { createdAt: "desc" } });
    const filed = filedRows.map((r: EmployeeDetailsFiling) => ({
      id: r.id,
      employeeId: r.employeeId,
      employeeName: r.employeeName,
      employeeIrd: r.employeeIrd,
      kind: r.kind,
      status: r.status,
      generatedAt: isoOrNull(r.generatedAt),
      filedAt: isoOrNull(r.filedAt),
      acceptedAt: isoOrNull(r.acceptedAt),
      rejectedAt: isoOrNull(r.rejectedAt),
      irdErrorReport: r.irdErrorReport,
    }));
    return { periodKey, pending, filed };
  });
}

export async function generateEmployeeDetailsAction(input: unknown): Promise<ActionResult<{ ids: string[]; employeeLineCount: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ employeeIds: z.array(cuidish).min(1).max(200) }).strict(), input);
    const result = await generateEmployeeDetails({ employeeIds: data.employeeIds, generatedById: auth.userId });
    await logAudit({
      actor: auth,
      action: "payday.employee_details_generated",
      entityType: "EMPLOYEE_DETAILS_FILING",
      entityId: result.ids[0] ?? "",
      entityLabel: `${result.employeeLineCount} employee line(s)`,
      detail: `${auth.name} generated an Employee Details file (${result.employeeLineCount} line(s)) for new/departing employees.`,
    });
    revalidatePath("/");
    return result;
  });
}

export async function downloadEmployeeDetailsFile(input: unknown): Promise<ActionResult<{ filename: string; csv: string; mime: string }>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ id: cuidish }).strict(), input);
    const row = await db.employeeDetailsFiling.findUnique({ where: { id: data.id } });
    if (!row) throw new AuthorizationError("Employee details filing not found.");
    if (!row.fileContent) throw new AuthorizationError("This notification has no stored file content.");
    return {
      filename: `ED-${row.employerIrd}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${row.kind}.csv`,
      csv: row.fileContent,
      mime: "text/csv",
    };
  });
}

export async function markEmployeeDetailsFiledAction(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ id: cuidish }).strict(), input);
    await markEmployeeDetailsFiled(data.id, { filedById: auth.userId });
    await logAudit({
      actor: auth,
      action: "payday.employee_details_marked_filed",
      entityType: "EMPLOYEE_DETAILS_FILING",
      entityId: data.id,
      detail: `${auth.name} confirmed an Employee Details upload to myIR.`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

export async function markEmployeeDetailsAcceptedAction(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ id: cuidish }).strict(), input);
    await markEmployeeDetailsAccepted(data.id);
    await logAudit({
      actor: auth,
      action: "payday.employee_details_marked_accepted",
      entityType: "EMPLOYEE_DETAILS_FILING",
      entityId: data.id,
      detail: `${auth.name} marked an Employee Details filing accepted by myIR.`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

export async function markEmployeeDetailsRejectedAction(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ id: cuidish, errorReport: z.string().trim().min(1, "Paste the myIR error report.").max(60_000) }).strict(), input);
    await markEmployeeDetailsRejected(data.id, { errorReport: data.errorReport });
    await logAudit({
      actor: auth,
      action: "payday.employee_details_marked_rejected",
      entityType: "EMPLOYEE_DETAILS_FILING",
      entityId: data.id,
      detail: `${auth.name} recorded an IRD rejection on an Employee Details filing.`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

/** The filed lines of one filing (the amendment form's source). */
export async function listFilingLines(input: { filingId: string }): Promise<ActionResult<Array<{ employeeId: string; employeeName: string; grossCents: number; payeCents: number }>>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rows = await db.paydayFilingLine.findMany({
      where: { filingId: String(input?.filingId ?? "").trim() },
      select: { employeeId: true, employeeName: true, grossCents: true, payeCents: true },
      orderBy: { employeeName: "asc" },
    });
    return rows;
  });
}

export async function generateAmendmentFilingAction(input: unknown): Promise<ActionResult<{ amendmentId: string; pairCount: number }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(
      z
        .object({
          originalFilingId: cuidish,
          corrections: z
            .array(
              z
                .object({
                  employeeId: cuidish,
                  delete: z.boolean().optional(),
                  gross: z.number().nonnegative().optional(),
                  paye: z.number().nonnegative().optional(),
                  studentLoan: z.number().nonnegative().optional(),
                  kiwisaverEmployee: z.number().nonnegative().optional(),
                  kiwisaverEmployerNet: z.number().nonnegative().optional(),
                  esct: z.number().nonnegative().optional(),
                })
                .strict(),
            )
            .min(1, "Add at least one correction."),
        })
        .strict(),
      input,
    );

    const result = await generateAmendmentFiling(
      data.originalFilingId,
      data.corrections.map((c) => ({
        employeeId: c.employeeId,
        amended: c.delete
          ? null
          : {
              grossCents: c.gross != null ? toCents(c.gross) : undefined,
              payeCents: c.paye != null ? toCents(c.paye) : undefined,
              studentLoanCents: c.studentLoan != null ? toCents(c.studentLoan) : undefined,
              kiwisaverEmployeeCents: c.kiwisaverEmployee != null ? toCents(c.kiwisaverEmployee) : undefined,
              kiwisaverEmployerNetCents: c.kiwisaverEmployerNet != null ? toCents(c.kiwisaverEmployerNet) : undefined,
              esctCents: c.esct != null ? toCents(c.esct) : undefined,
            },
      })),
      { generatedById: auth.userId },
    );
    await logAudit({
      actor: auth,
      action: "payday.amendment_generated",
      entityType: "PAYDAY_AMENDMENT_FILING",
      entityId: result.id,
      detail: `${auth.name} generated an EIA2 amendment (${result.pairCount} DTI/DAI pair(s)) for filing ${data.originalFilingId}.`,
    });
    revalidatePath("/");
    return { amendmentId: result.id, pairCount: result.pairCount };
  });
}

export async function downloadAmendmentFile(input: unknown): Promise<ActionResult<{ filename: string; csv: string; mime: string }>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ id: cuidish }).strict(), input);
    const row: PaydayAmendmentFiling | null = await db.paydayAmendmentFiling.findUnique({ where: { id: data.id } });
    if (!row) throw new AuthorizationError("Amendment filing not found.");
    if (!row.fileContent) throw new AuthorizationError("This amendment has no stored file content.");
    return {
      filename: `EIA2-${row.employerIrd}-${row.payDate.toISOString().slice(0, 10).replace(/-/g, "")}.csv`,
      csv: row.fileContent,
      mime: "text/csv",
    };
  });
}

export async function markAmendmentFiledAction(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ id: cuidish }).strict(), input);
    await markAmendmentFiled(data.id, { filedById: auth.userId });
    await logAudit({
      actor: auth,
      action: "payday.amendment_marked_filed",
      entityType: "PAYDAY_AMENDMENT_FILING",
      entityId: data.id,
      detail: `${auth.name} confirmed an EIA2 amendment upload to myIR.`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

export async function markAmendmentAcceptedAction(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrowThrow(z.object({ id: cuidish }).strict(), input);
    await markAmendmentAccepted(data.id);
    await logAudit({
      actor: auth,
      action: "payday.amendment_marked_accepted",
      entityType: "PAYDAY_AMENDMENT_FILING",
      entityId: data.id,
      detail: `${auth.name} marked an EIA2 amendment accepted by myIR.`,
    });
    revalidatePath("/");
    return { ok: true as const };
  });
}

/** Type re-exports for the pages (server components). */
export type { PayrollRun };
