import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Landmark,
  ScrollText,
  ArrowLeftRight,
  Users,
  ArrowLeft,
  ShieldAlert,
} from "lucide-react";
import { getSession, checkPermission } from "@/server-actions/auth-guard";

// ---------------------------------------------------------------------------
// NZ statutory engine — Phase 3: the super-admin route group shell.
//
// Guard: `statutory:manage` — SUPER_ADMIN only (the Phase 0 RBAC ceiling:
// plain ADMINs run payroll but can never rewrite the tax tables). Signed
// out → back to the app root (which renders the login screen); signed in
// without the permission → an explicit access-denied panel (no redirect
// loop, no accidental information leak).
//
// The (admin) group is stripped from URLs: the pages live at /settings/tax/*,
// /employees and /employees/[id]/tax-profile.
// ---------------------------------------------------------------------------

const NAV = [
  { href: "/settings/tax/slabs", label: "Tax years & slabs", icon: Landmark },
  { href: "/settings/tax/rules", label: "Statutory rules", icon: ScrollText },
  { href: "/settings/tax/component-mapping", label: "Component mapping", icon: ArrowLeftRight },
  { href: "/employees", label: "Employee tax profiles", icon: Users },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/");
  }
  const allowed = await checkPermission(session.role, "statutory:manage");
  if (!allowed) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert className="h-6 w-6 text-destructive" />
          </div>
          <h1 className="text-lg font-semibold">Super admin only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The NZ statutory admin area is restricted to the SUPER_ADMIN role —
            it owns the rate tables every payslip computes from. You are signed
            in as <span className="font-medium text-foreground">{session.name}</span> ({session.role}).
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
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-500/15">
              <Landmark className="h-4 w-4 text-violet-500" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold">Statutory admin</p>
              <p className="text-[11px] text-muted-foreground">NZ payroll · super admin</p>
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
        {/* Mobile nav — same links, horizontally scrollable. */}
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
