import { notFound } from "next/navigation";
import { getSalaryHistory } from "@/server-actions/salary-assignments";
import { SalaryHistoryView } from "@/components/admin/salary-history-view";

// ---------------------------------------------------------------------------
// Phase 1B (G8) — the employee's effective-dated salary timeline: every
// assignment window (fromDate → toDate) with its base / variable facts, and
// the revision writer that closes the current assignment and opens a new
// one atomically.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function SalaryHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await getSalaryHistory(id);
  if (!res.ok) {
    // Unknown / deleted employee → the workspace 404 (the id came from our
    // own employee index).
    notFound();
  }
  return <SalaryHistoryView history={res.data} today={new Date().toISOString().slice(0, 10)} />;
}
