import { getTaxYears } from "@/server-actions/tax-admin";
import { TaxSlabsView } from "@/components/admin/tax-slabs-view";

// ---------------------------------------------------------------------------
// Task 3.1 — tax year + slab admin. One editable table per TaxYear
// (group / code / lower / upper / rate / accInclusive / order), the
// single-value rule families under it, and the annualised-gross simulator.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function TaxSlabsPage() {
  const res = await getTaxYears();
  const taxYears = res.ok ? res.data : [];
  return <TaxSlabsView initialTaxYears={taxYears} loadError={res.ok ? null : res.error} />;
}
