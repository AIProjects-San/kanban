import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getAdminEmployees } from "@/server-actions/tax-admin";

// ---------------------------------------------------------------------------
// Task 3.4 — the employee index for the tax-profile editor. The [id] page
// is the real editor; this list keeps it reachable.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const EMPLOYMENT_LABELS: Record<string, string> = {
  PERMANENT: "Permanent",
  CASUAL: "Casual",
  TEMPORARY: "Temporary",
  CASUAL_AGRICULTURAL: "Casual agricultural",
};

export default async function AdminEmployeesPage() {
  const res = await getAdminEmployees();
  const employees = res.ok ? res.data : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Employee tax profiles</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The IR330 declaration, KiwiSaver election and employment status behind
          every statutory line — Section A (tax code), Section B (KiwiSaver),
          Section C (employment / casual status).
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
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Tax code</th>
                <th className="px-4 py-3 font-medium">Employment</th>
                <th className="px-4 py-3 font-medium">Profile</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.userId} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <p className="font-medium">{e.name}</p>
                    <p className="text-xs text-muted-foreground">{e.email}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{e.role}</td>
                  <td className="px-4 py-3 font-mono text-xs">{e.taxCode || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {EMPLOYMENT_LABELS[e.employmentType] ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {e.hasProfile ? (
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                        on file
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
                        not set up
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/employees/${e.userId}/tax-profile`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      Open <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </td>
                </tr>
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
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
