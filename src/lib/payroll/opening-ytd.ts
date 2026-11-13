// P16 (PR-04) — the SSA opening-YTD rows: the defensive parser (pure) and
// the per-user loader (db read). Extracted from server-actions/payroll.ts so
// every payslip-aggregate consumer — the run view, self-service, the
// structures serializer — shares ONE loader (one truth for fiscal basis).

import { db } from "@/lib/infra/db";
import type { OpeningYtdRowT } from "@/lib/types";
import { fiscalYearOf } from "@/lib/payroll/payroll-windows";
import type { OpeningYtdEntry } from "@/lib/payroll/payslip-aggregates";

/** P16 (PR-04) — parse a structure's stored opening rows defensively
 * (null / malformed → null; the write path guarantees the shape). */
export function parseOpeningYtd(raw: unknown): OpeningYtdRowT[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const rows = raw.filter(
      (r): r is OpeningYtdRowT =>
        !!r && typeof r === "object" &&
        typeof (r as { key?: unknown }).key === "string" && (r as { key: string }).key.length > 0 &&
        ((r as { side?: unknown }).side === "EARNING" || (r as { side?: unknown }).side === "DEDUCTION") &&
        Number.isFinite((r as { amount?: unknown }).amount),
    );
    if (rows.length === 0) return null;
    return rows.map((r) => ({
      key: r.key,
      label: typeof r.label === "string" ? r.label : r.key,
      side: r.side,
      amount: Math.max(0, Number(r.amount) || 0),
    }));
  }
  return null;
}

/** P16 (PR-04) — the SSA opening entries for the aggregate kernel: every
 * structure (active OR retired — an opening is a fact of what was earned)
 * whose parsed opening rows exist and whose effectiveFrom falls in a fiscal
 * year ANY of the given users has (or will have) a slip in. The entry's
 * fiscalStartYear is resolved through the SAME fiscalYearOf the kernel uses,
 * so basis flips re-attribute openings consistently on the next read. */
export async function openingEntriesForUsers(
  userIds: string[],
  fiscalYearStartMonth: number,
): Promise<OpeningYtdEntry[]> {
  if (userIds.length === 0) return [];
  const structures = await db.salaryStructure.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, effectiveFrom: true, openingYtd: true },
  });
  const out: OpeningYtdEntry[] = [];
  for (const s of structures) {
    const rows = parseOpeningYtd(s.openingYtd);
    if (!rows) continue;
    out.push({
      userId: s.userId,
      fiscalStartYear: fiscalYearOf(s.effectiveFrom.getTime(), fiscalYearStartMonth),
      components: rows.map((r) => ({
        key: r.key,
        label: r.label || r.key,
        side: r.side,
        amount: r.amount,
      })),
    });
  }
  return out;
}
