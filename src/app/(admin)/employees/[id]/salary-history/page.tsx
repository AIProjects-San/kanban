import { notFound } from "next/navigation";
import { getSalaryHistory } from "@/server-actions/salary-assignments";
import {
  getEmployeeTransfers,
  getEmployeePromotions,
} from "@/server-actions/hr-employment-docs";
import { SalaryHistoryView } from "@/components/admin/salary-history-view";

// ---------------------------------------------------------------------------
// Phase 1B (G8) — the employee's effective-dated salary timeline: every
// assignment window (fromDate → toDate) with its base / variable facts, and
// the revision writer that closes the current assignment and opens a new
// one atomically.
//
// P1 G6 — the transfers & promotions timeline rides alongside: the same
// effective-dated employment-change discipline, one chronological picture.
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
  const [transfers, promotions] = await Promise.all([
    getEmployeeTransfers(id),
    getEmployeePromotions(id),
  ]);
  return (
    <SalaryHistoryView
      history={res.data}
      today={new Date().toISOString().slice(0, 10)}
      employmentEvents={[
        ...(transfers.ok ? transfers.data : []).map((t) => ({
          kind: "TRANSFER" as const,
          id: t.id,
          effectiveDate: t.effectiveDate,
          status: t.status,
          summary:
            [
              t.toDepartment !== null ? `department → ${t.toDepartment}` : null,
              t.toJobTitle !== null ? `title → ${t.toJobTitle}` : null,
              t.toManagerId !== null ? "reporting line changed" : null,
              t.toLocation !== null ? `location → ${t.toLocation}` : null,
            ]
              .filter(Boolean)
              .join(", ") || "no net change",
        })),
        ...(promotions.ok ? promotions.data : []).map((p) => ({
          kind: "PROMOTION" as const,
          id: p.id,
          effectiveDate: p.effectiveDate,
          status: p.status,
          summary:
            `title → ${p.toJobTitle}` + (p.toGrade !== null ? `, grade → ${p.toGrade}` : ""),
        })),
      ].sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1))}
    />
  );
}
