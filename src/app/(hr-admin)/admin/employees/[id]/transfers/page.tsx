import { notFound } from "next/navigation";
import {
  getEmployeeTransfers,
  getEmploymentDocumentContext,
} from "@/server-actions/hr-employment-docs";
import { getHrMasterOptions } from "@/server-actions/hr-masters";
import { EmployeeTransfersView } from "@/components/admin/employee-transfers-view";

// ---------------------------------------------------------------------------
// P1 G6 — the employee's transfer documents: list + create + the lifecycle
// actions (submit / approve / cancel / make effective).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function EmployeeTransfersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [ctx, list, masters] = await Promise.all([
    getEmploymentDocumentContext(id),
    getEmployeeTransfers(id),
    getHrMasterOptions(),
  ]);
  if (!ctx.ok) {
    // Unknown / deleted employee → the 404 (the id came from our own index).
    notFound();
  }
  return (
    <EmployeeTransfersView
      context={ctx.data}
      transfers={list.ok ? list.data : []}
      departments={masters.ok ? masters.data.departments : []}
      today={new Date().toISOString().slice(0, 10)}
    />
  );
}
