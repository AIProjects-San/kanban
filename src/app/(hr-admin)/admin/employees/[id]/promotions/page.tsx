import { notFound } from "next/navigation";
import {
  getEmployeePromotions,
  getEmploymentDocumentContext,
} from "@/server-actions/hr-employment-docs";
import { getHrMasterOptions } from "@/server-actions/hr-masters";
import { EmployeePromotionsView } from "@/components/admin/employee-promotions-view";

// ---------------------------------------------------------------------------
// P1 G6 — the employee's promotion documents: list + create + the lifecycle
// actions (submit / approve / cancel / make effective).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function EmployeePromotionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [ctx, list, masters] = await Promise.all([
    getEmploymentDocumentContext(id),
    getEmployeePromotions(id),
    getHrMasterOptions(),
  ]);
  if (!ctx.ok) {
    notFound();
  }
  return (
    <EmployeePromotionsView
      context={ctx.data}
      promotions={list.ok ? list.data : []}
      designations={masters.ok ? masters.data.designations : []}
      grades={masters.ok ? masters.data.grades : []}
      today={new Date().toISOString().slice(0, 10)}
    />
  );
}
