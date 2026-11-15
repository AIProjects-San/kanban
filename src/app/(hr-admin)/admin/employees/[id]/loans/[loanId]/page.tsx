import { notFound } from "next/navigation";
import { getLoanDetail } from "@/server-actions/loans";
import { LoanDetailView } from "@/components/admin/loan-detail-view";

// ---------------------------------------------------------------------------
// G3 — one loan: the amortization schedule table, the repayment history,
// and the early-repayment / final-settlement action.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function LoanDetailPage({
  params,
}: {
  params: Promise<{ id: string; loanId: string }>;
}) {
  const { loanId } = await params;
  const detail = await getLoanDetail(loanId);
  if (!detail.ok) {
    notFound();
  }
  return <LoanDetailView loan={detail.data} />;
}
