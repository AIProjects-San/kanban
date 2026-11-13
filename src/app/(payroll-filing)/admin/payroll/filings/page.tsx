import { notFound } from "next/navigation";
import { listPaydayFilings } from "@/server-actions/payday-filing";
import { PaydayFilingsList } from "@/components/admin/payday/payday-filings-list";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — every Employment Information filing: payDate,
// period, due date, status, totals, days overdue; filters + overdue tab.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function FilingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; overdue?: string }>;
}) {
  const sp = await searchParams;
  const res = await listPaydayFilings({
    status: sp.status || undefined,
    overdue: sp.overdue === "1" || undefined,
  });
  if (!res.ok) notFound();
  return (
    <PaydayFilingsList
      filings={res.data}
      statusFilter={sp.status ?? ""}
      overdueOnly={sp.overdue === "1"}
    />
  );
}
