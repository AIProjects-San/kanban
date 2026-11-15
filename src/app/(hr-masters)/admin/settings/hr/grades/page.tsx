import { getGrades } from "@/server-actions/hr-masters";
import { HrGradesView } from "@/components/admin/hr-grades-view";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the Grade ladder (list + salary band).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function HrGradesPage() {
  const res = await getGrades();
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return <HrGradesView grades={res.data} />;
}
