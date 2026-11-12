import { notFound } from "next/navigation";
import { getEmployeeTaxProfileAdmin } from "@/server-actions/tax-admin";
import { EmployeeTaxProfileView } from "@/components/admin/employee-tax-profile-view";

// ---------------------------------------------------------------------------
// Task 3.4 (revised) — the employee tax profile editor: Section A (tax code
// + STC certificate), Section B (KiwiSaver), Section C (employment / casual
// status), with the live auto-enrolment preview and the three guardrails.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function EmployeeTaxProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await getEmployeeTaxProfileAdmin(id);
  if (!res.ok) {
    // Unknown / deleted employee → the workspace 404 (not an error panel:
    // the id came from our own employee index).
    notFound();
  }
  return <EmployeeTaxProfileView profile={res.data} today={new Date().toISOString().slice(0, 10)} />;
}
