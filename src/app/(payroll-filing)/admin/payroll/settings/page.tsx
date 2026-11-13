import { notFound } from "next/navigation";
import { getPayrollFilingSettings } from "@/server-actions/payday-filing";
import { PayrollFilingSettingsView } from "@/components/admin/payday/payroll-filing-settings-view";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the employer filing profile: the IRD number
// every EI/ED header carries, the payroll contact myIR names on an error,
// and the package/form-version stamps.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function FilingSettingsPage() {
  const res = await getPayrollFilingSettings();
  if (!res.ok) notFound();
  return <PayrollFilingSettingsView initial={res.data} />;
}
