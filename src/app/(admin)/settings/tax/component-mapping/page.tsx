import { getComponentTaxMappings } from "@/server-actions/tax-admin";
import { ComponentMappingView } from "@/components/admin/component-mapping-view";

// ---------------------------------------------------------------------------
// Task 3.3 — component mapping admin: active SalaryComponents with their
// tax mapping (taxApplicable / statutoryCategory / wageBaseRef), edited
// inline. System-generated rows are read-only.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function ComponentMappingPage() {
  const res = await getComponentTaxMappings();
  const components = res.ok ? res.data : [];
  return <ComponentMappingView initialComponents={components} loadError={res.ok ? null : res.error} />;
}
