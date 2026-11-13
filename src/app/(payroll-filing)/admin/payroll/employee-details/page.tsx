import { notFound } from "next/navigation";
import { getEmployeeDetailsView, getPayrollFilingSettings } from "@/server-actions/payday-filing";
import { EmployeeDetailsFilingView } from "@/components/admin/payday/employee-details-view";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — Employee Details (ED) notifications: pending
// joiners/leavers for a month, the never-notify-twice history, generation
// and the myIR lifecycle.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function EmployeeDetailsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const sp = await searchParams;
  const [viewRes, settingsRes] = await Promise.all([
    getEmployeeDetailsView({ periodKey: sp.period || undefined }),
    getPayrollFilingSettings(),
  ]);
  if (!viewRes.ok) notFound();
  return (
    <EmployeeDetailsFilingView
      view={viewRes.data}
      settings={settingsRes.ok ? settingsRes.data : null}
    />
  );
}
