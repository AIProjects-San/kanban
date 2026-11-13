import { notFound } from "next/navigation";
import {
  getEmployeePromotions,
  getEmploymentDocumentContext,
} from "@/server-actions/hr-employment-docs";
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
  const [ctx, list] = await Promise.all([
    getEmploymentDocumentContext(id),
    getEmployeePromotions(id),
  ]);
  if (!ctx.ok) {
    notFound();
  }
  return (
    <EmployeePromotionsView
      context={ctx.data}
      promotions={list.ok ? list.data : []}
      today={new Date().toISOString().slice(0, 10)}
    />
  );
}
