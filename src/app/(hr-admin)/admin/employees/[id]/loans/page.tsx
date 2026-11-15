import { notFound } from "next/navigation";
import { db } from "@/lib/infra/db";
import { getEmployeeLoans, getLoanTypes } from "@/server-actions/loans";
import { EmployeeLoansView } from "@/components/admin/employee-loans-view";

// ---------------------------------------------------------------------------
// G3 — the employee's loans: list + create + the lifecycle actions
// (submit / approve / reject / cancel / activate). The schedule and
// repayment history live on the [loanId] detail page.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function EmployeeLoansPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [employee, list, types] = await Promise.all([
    db.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, deletedAt: true } }),
    getEmployeeLoans(id),
    getLoanTypes(),
  ]);
  if (!employee || employee.deletedAt) {
    // Unknown / deleted employee → the 404 (the id came from our own pages).
    notFound();
  }
  return (
    <EmployeeLoansView
      employee={{ id: employee.id, name: employee.name, email: employee.email }}
      loans={list.ok ? list.data : []}
      types={types.ok ? types.data : []}
    />
  );
}
