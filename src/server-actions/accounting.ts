"use server";

// ---------------------------------------------------------------------------
// Phase 1C (G2) — accounting server actions: the trial balance report, the
// period close, and the reversal writer.
//
// RBAC: payroll:manage (ADMIN + HR) — the same ceiling as every payroll
// path. The pages live under the (admin) route group (SUPER_ADMIN gate at
// the layout); the actions themselves hold the payroll boundary.
//
//   getTrialBalance(periodId)      — one row per account: opening (from
//                                    prior periods), in-period debits /
//                                    credits, closing; totals row proves
//                                    debits = credits.
//   exportTrialBalanceCsv          — the same report as CSV.
//   closePeriod(periodId)          — flips isClosed; every future posting
//                                    into the period is refused (the engine
//                                    checks before writing).
//   reverseJournalEntry(entryId)   — the corrections path: a NEW entry in
//                                    an OPEN period that mirrors the
//                                    original's lines (debits ↔ credits)
//                                    and references it; the original flips
//                                    to status REVERSED with its lines
//                                    byte-identical (immutable history,
//                                    visible negation).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { parseOrThrow, reverseJournalEntrySchema } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { csvEscape } from "@/lib/report-csv";
import { round2 } from "@/lib/money";

export interface TrialBalanceRowT {
  code: string;
  name: string;
  type: string;
  opening: number;
  debits: number;
  credits: number;
  closing: number;
}

export interface TrialBalanceT {
  period: { id: string; startDate: string; endDate: string; isClosed: boolean };
  rows: TrialBalanceRowT[];
  totals: { opening: number; debits: number; credits: number; closing: number };
}

/** Only POSTED and REVERSED entries are ledger money: a REVERSED original
 *  plus its POSTED reversal net to zero (both stay visible). DRAFT never
 *  counts. */
const LEDGER_STATUSES = ["POSTED", "REVERSED"];

function toNum(v: { toNumber(): number }): number {
  return v.toNumber();
}

export async function getAccountingPeriods(): Promise<
  ActionResult<Array<{ id: string; startDate: string; endDate: string; isClosed: boolean; entryCount: number }>>
> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const periods = await db.accountingPeriod.findMany({
      orderBy: { startDate: "desc" },
      include: { _count: { select: { journalEntries: true } } },
    });
    return periods.map((p) => ({
      id: p.id,
      startDate: p.startDate.toISOString(),
      endDate: p.endDate.toISOString(),
      isClosed: p.isClosed,
      entryCount: p._count.journalEntries,
    }));
  });
}

export async function getTrialBalance(periodId: string): Promise<ActionResult<TrialBalanceT>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const period = await db.accountingPeriod.findUnique({ where: { id: periodId } });
    if (!period) throw new AuthorizationError("Accounting period not found.");

    const accounts = await db.ledgerAccount.findMany({ orderBy: { code: "asc" } });

    // Opening: every ledger line in periods BEFORE the selected one.
    const priorLines = await db.journalEntryLine.findMany({
      where: {
        journalEntry: { status: { in: LEDGER_STATUSES }, period: { endDate: { lt: period.startDate } } },
      },
      select: { accountId: true, debit: true, credit: true },
    });
    // In-period movement: every ledger line in the selected period.
    const periodLines = await db.journalEntryLine.findMany({
      where: {
        journalEntry: { status: { in: LEDGER_STATUSES }, periodId: period.id },
      },
      select: { accountId: true, debit: true, credit: true },
    });

    const openingById = new Map<string, number>();
    for (const l of priorLines) {
      openingById.set(l.accountId, (openingById.get(l.accountId) ?? 0) + toNum(l.debit) - toNum(l.credit));
    }
    const debitById = new Map<string, number>();
    const creditById = new Map<string, number>();
    for (const l of periodLines) {
      debitById.set(l.accountId, (debitById.get(l.accountId) ?? 0) + toNum(l.debit));
      creditById.set(l.accountId, (creditById.get(l.accountId) ?? 0) + toNum(l.credit));
    }

    const rows: TrialBalanceRowT[] = accounts.map((a) => {
      const opening = round2(openingById.get(a.id) ?? 0);
      const debits = round2(debitById.get(a.id) ?? 0);
      const credits = round2(creditById.get(a.id) ?? 0);
      return {
        code: a.code,
        name: a.name,
        type: a.type,
        opening,
        debits,
        credits,
        closing: round2(opening + debits - credits),
      };
    });

    const sum = (sel: (r: TrialBalanceRowT) => number) => round2(rows.reduce((s, r) => s + sel(r), 0));
    return {
      period: {
        id: period.id,
        startDate: period.startDate.toISOString(),
        endDate: period.endDate.toISOString(),
        isClosed: period.isClosed,
      },
      rows,
      totals: {
        opening: sum((r) => r.opening),
        debits: sum((r) => r.debits),
        credits: sum((r) => r.credits),
        closing: sum((r) => r.closing),
      },
    };
  });
}

export async function exportTrialBalanceCsv(
  periodId: string,
): Promise<ActionResult<{ filename: string; csv: string; mime: string }>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const res = await getTrialBalance(periodId);
    if (!res.ok) throw new Error(res.error);
    const { period, rows, totals } = res.data;
    const cell = csvEscape;
    const lines = [
      `Trial balance,${period.startDate.slice(0, 10)},${period.endDate.slice(0, 10)}`,
      "Code,Account,Type,Opening,Debits,Credits,Closing",
      ...rows.map((r) =>
        [r.code, r.name, r.type, r.opening.toFixed(2), r.debits.toFixed(2), r.credits.toFixed(2), r.closing.toFixed(2)]
          .map(cell)
          .join(","),
      ),
      ["", "TOTALS", "", totals.opening.toFixed(2), totals.debits.toFixed(2), totals.credits.toFixed(2), totals.closing.toFixed(2)].join(","),
    ];
    return {
      filename: `trial-balance-${period.startDate.slice(0, 10)}.csv`,
      csv: lines.join("\n"),
      mime: "text/csv",
    };
  });
}

/** Close an accounting period: every future posting into it is refused
 *  (the engine checks period.isClosed before writing); corrections go
 *  through a reversal entry in an open period. */
export async function closePeriod(periodId: string): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const period = await db.accountingPeriod.findUnique({ where: { id: periodId } });
    if (!period) throw new AuthorizationError("Accounting period not found.");
    if (period.isClosed) throw new AuthorizationError("That accounting period is already closed.");
    await db.accountingPeriod.update({ where: { id: periodId }, data: { isClosed: true } });
    await logAudit({
      actor: auth,
      action: "accounting.period_closed",
      entityType: "ACCOUNTING_PERIOD",
      entityId: periodId,
      entityLabel: `${period.startDate.toISOString().slice(0, 10)} → ${period.endDate.toISOString().slice(0, 10)}`,
      detail: `${auth.name} closed the accounting period ${period.startDate.toISOString().slice(0, 10)} → ${period.endDate.toISOString().slice(0, 10)} — future postings are refused; corrections must be reversal entries in an open period.`,
    });
    revalidatePath("/accounting/trial-balance");
    return { ok: true };
  });
}

/** Reverse a POSTED entry: a mirrored entry in an OPEN period (the period
 *  covering today, or the explicit target), referencing the original. The
 *  original's lines are never touched — only its status moves to REVERSED. */
export async function reverseJournalEntry(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(reverseJournalEntrySchema, input);

    const original = await db.journalEntry.findUnique({
      where: { id: data.entryId },
      include: { lines: true, period: true },
    });
    if (!original) throw new AuthorizationError("Journal entry not found.");
    if (original.status !== "POSTED") {
      throw new AuthorizationError("Only POSTED entries can be reversed.");
    }
    if (original.reversalOfId) {
      throw new AuthorizationError("A reversal entry cannot itself be reversed — reverse the original instead.");
    }

    // The target period: explicit, else the open period covering today.
    const today = new Date();
    const target = data.periodId
      ? await db.accountingPeriod.findUnique({ where: { id: data.periodId } })
      : await db.accountingPeriod.findFirst({
          where: { startDate: { lte: today }, endDate: { gte: today } },
        });
    if (!target) throw new AuthorizationError("No open accounting period covers today — create one first.");
    if (target.isClosed) throw new AuthorizationError("The target accounting period is closed.");
    if (target.id === original.periodId) {
      throw new AuthorizationError("Pick an OPEN period — the original's period is closed.");
    }

    const created = await db.$transaction(async (tx) => {
      const reversal = await tx.journalEntry.create({
        data: {
          date: today,
          memo: `Reversal of ${original.id}${original.memo ? ` (${original.memo})` : ""}`,
          periodId: target.id,
          sourceType: original.sourceType,
          sourceId: original.sourceId,
          status: "POSTED",
          postedAt: today,
          postedById: auth.userId,
          reversalOfId: original.id,
          lines: {
            create: original.lines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              costCenter: l.costCenter,
              employeeId: l.employeeId,
              description: l.description ? `${l.description} (reversal)` : "reversal",
            })),
          },
        },
      });
      // The original's flag moves; its lines stay byte-identical.
      await tx.journalEntry.update({
        where: { id: original.id },
        data: { status: "REVERSED", reversedById: auth.userId },
      });
      return reversal;
    });

    await logAudit({
      actor: auth,
      action: "accounting.entry_reversed",
      entityType: "JOURNAL_ENTRY",
      entityId: created.id,
      entityLabel: original.memo ?? original.id,
      detail: `${auth.name} reversed journal entry ${original.id} (${original.lines.length} lines mirrored into ${target.startDate.toISOString().slice(0, 10)} → ${target.endDate.toISOString().slice(0, 10)}); the original is now REVERSED with its lines untouched.`,
    });
    revalidatePath("/accounting/trial-balance");
    return { id: created.id };
  });
}
