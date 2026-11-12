import { getTaxYears } from "@/server-actions/tax-admin";
import { TaxRulesView } from "@/components/admin/tax-rules-view";

// ---------------------------------------------------------------------------
// Task 3.2 — statutory rule admin, grouped by category. Editing a category
// creates a NEW VERSION (a cloned rate set with an effectiveFrom date);
// sets referenced by locked payslips are archive-only (delete blocked).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function TaxRulesPage() {
  const res = await getTaxYears();
  const taxYears = res.ok ? res.data : [];
  return <TaxRulesView initialTaxYears={taxYears} loadError={res.ok ? null : res.error} />;
}
