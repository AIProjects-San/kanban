import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/infra/db";
import { getSession } from "@/server-actions/auth-guard";
import { getMyTimesheets, getEmployeeTimesheets } from "@/server-actions/timesheets";
import { EmployeeTimesheetsView } from "@/components/admin/employee-timesheets-view";

// ---------------------------------------------------------------------------
// G4 — one employee's timesheets: the self-service surface (the signed-in
// employee drafting + submitting their own hours — no permission beyond
// the session, the getMyPayslips precedent) AND the HR surface
// (attendance:manage reads any employee). The page decides from the
// session: owner → the session-scoped reader; otherwise the gated reader
// (its refusal renders as the access panel below).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function EmployeeTimesheetsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");
  const isSelf = session.userId === id;

  const employee = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, deletedAt: true },
  });
  if (!employee || employee.deletedAt) notFound();

  const listRes = isSelf ? await getMyTimesheets() : await getEmployeeTimesheets(id);
  if (!listRes.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {listRes.error}
      </div>
    );
  }

  return (
    <EmployeeTimesheetsView
      employee={{ id: employee.id, name: employee.name, email: employee.email }}
      sheets={listRes.data}
      isSelf={isSelf}
    />
  );
}
