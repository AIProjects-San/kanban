import { notFound } from "next/navigation";
import {
  getAccountingPeriods,
  getTrialBalance,
} from "@/server-actions/accounting";
import { TrialBalanceView } from "@/components/admin/trial-balance-view";

// ---------------------------------------------------------------------------
// Phase 1C (G2) — the trial balance: one row per account (opening from
// prior periods, in-period debits / credits, closing) with the totals row
// proving debits = credits. Filterable by accounting period, exportable as
// CSV, plus the period-close control.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;
  const periodsRes = await getAccountingPeriods();
  if (!periodsRes.ok) notFound();
  const periods = periodsRes.data;
  if (periods.length === 0) notFound();

  // Default: the open period covering today, else the latest period.
  const today = new Date().toISOString();
  const fallback =
    periods.find((p) => p.startDate <= today && p.endDate >= today && !p.isClosed) ??
    periods.find((p) => p.startDate <= today && p.endDate >= today) ??
    periods[0];
  const selectedId = periodParam && periods.some((p) => p.id === periodParam) ? periodParam : fallback.id;

  const balanceRes = await getTrialBalance(selectedId);
  if (!balanceRes.ok) notFound();

  return (
    <TrialBalanceView
      periods={periods}
      selectedId={selectedId}
      balance={balanceRes.data}
    />
  );
}
