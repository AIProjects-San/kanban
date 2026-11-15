import { getDesignations, getGrades } from "@/server-actions/hr-masters";
import { HrDesignationsView } from "@/components/admin/hr-designations-view";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the Designation master (list + grade link).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function HrDesignationsPage() {
  const [designations, grades] = await Promise.all([getDesignations(), getGrades()]);
  if (!designations.ok || !grades.ok) {
    const error = designations.ok ? (grades.ok ? null : grades.error) : designations.error;
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  return <HrDesignationsView designations={designations.data} grades={grades.data} />;
}
