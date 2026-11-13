import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, FileText, Landmark, ShieldAlert, Users, Settings } from "lucide-react";
import { getSession, checkPermission } from "@/server-actions/auth-guard";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the payroll-admin route group shell.
//
// Guard: `payroll:manage` (SUPER_ADMIN + ADMIN + HR — the same permission
// every payroll action requires). Signed out → the app root (login); a
// role without the permission → an explicit access-denied panel.
//
// URLs (the group name is stripped): /admin/payroll/filings,
// /admin/payroll/runs/[id]/filing, /admin/payroll/employee-details,
// /admin/payroll/settings.
// ---------------------------------------------------------------------------

const NAV = [
  { href: "/admin/payroll/filings", label: "EI filings", icon: FileText },
  { href: "/admin/payroll/employee-details", label: "Employee details", icon: Users },
  { href: "/admin/payroll/settings", label: "Filing profile", icon: Settings },
];

export default async function PayrollFilingLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/");
  }
  const allowed = await checkPermission(session.role, "payroll:manage");
  if (!allowed) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert className="h-6 w-6 text-destructive" />
          </div>
          <h1 className="text-lg font-semibold">Payroll admin only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            IRD payday filing is restricted to the payroll admin permission
            (SUPER_ADMIN, ADMIN, HR). You are signed in as{" "}
            <span className="font-medium text-foreground">{session.name}</span> ({session.role}).
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Fernly
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            title="Back to the Fernly workspace"
          >
            <ArrowLeft className="h-4 w-4" />
            Fernly
          </Link>
          <div className="h-5 w-px bg-border" aria-hidden />
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15">
              <Landmark className="h-4 w-4 text-emerald-600" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold">Payday filing</p>
              <p className="text-[11px] text-muted-foreground">IRD Employment Information · myIR file upload</p>
            </div>
          </div>
          <nav className="ml-auto hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto border-t border-border px-4 py-2 md:hidden">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
