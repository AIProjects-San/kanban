import Link from "next/link";
import { ArrowLeftRight, TrendingUp } from "lucide-react";
import { getEmploymentDocumentEmployees } from "@/server-actions/hr-employment-docs";
import { departmentLabel } from "@/lib/shared/config";

// ---------------------------------------------------------------------------
// P1 G6 — the employment-documents index: every employee with their current
// facts and the two document surfaces (transfers / promotions).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function EmploymentDocumentsIndexPage() {
  const res = await getEmploymentDocumentEmployees();
  const employees = res.ok ? res.data : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Employment documents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The approval-gated employment changes: a transfer moves a person
          across department, title, reporting line or location; a promotion
          raises their designation (and optionally grade). Facts apply only
          when the document goes effective on its date.
        </p>
      </div>

      {!res.ok ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {res.error}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 font-medium">Job title</th>
                <th className="px-4 py-3 font-medium">Department</th>
                <th className="px-4 py-3 font-medium">Grade</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <p className="font-medium">{e.name}</p>
                    <p className="text-xs text-muted-foreground">{e.email}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{e.jobTitle || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {e.department ? departmentLabel(e.department) : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{e.grade || "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        href={`/admin/employees/${e.id}/transfers`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" /> Transfers
                      </Link>
                      <Link
                        href={`/admin/employees/${e.id}/promotions`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                      >
                        <TrendingUp className="h-3.5 w-3.5" /> Promotions
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No employees found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
