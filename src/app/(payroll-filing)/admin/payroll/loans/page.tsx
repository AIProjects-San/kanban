import { getLoansOverview } from "@/server-actions/loans";
import { LoansOverviewView } from "@/components/admin/loans-overview-view";

// ---------------------------------------------------------------------------
// G3 — the payroll-admin loans overview: every ACTIVE loan with the
// installment due in the selected period (default: the current month) and
// the workspace's loan type catalog.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function PayrollLoansPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period } = await searchParams;
  const res = await getLoansOverview(period);
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return <LoansOverviewView data={res.data} />;
}
