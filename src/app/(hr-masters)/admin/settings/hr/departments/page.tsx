import { getDepartments } from "@/server-actions/hr-masters";
import { HrDepartmentsView } from "@/components/admin/hr-departments-view";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the Department master's tree editor.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function HrDepartmentsPage() {
  const res = await getDepartments();
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return <HrDepartmentsView departments={res.data} />;
}
