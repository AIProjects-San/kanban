import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Building2, Briefcase, Medal } from "lucide-react";
import { getSession } from "@/server-actions/auth-guard";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the HR masters route group shell.
//
// Guard: a session (the G5 group's discipline — the layout never hard-gates
// a permission; every page's data action enforces hr:view / hr:admin and
// renders the refusal as its access panel).
//
// URLs (the group name is stripped): /admin/settings/hr/departments,
// /admin/settings/hr/designations, /admin/settings/hr/grades.
// ---------------------------------------------------------------------------

const NAV = [
  { href: "/admin/settings/hr/departments", label: "Departments", icon: Building2 },
  { href: "/admin/settings/hr/designations", label: "Designations", icon: Briefcase },
  { href: "/admin/settings/hr/grades", label: "Grades", icon: Medal },
];

export default async function HrMastersLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/");
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
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-500/15">
              <Building2 className="h-4 w-4 text-indigo-600" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold">HR masters</p>
              <p className="text-[11px] text-muted-foreground">Departments · designations · grades</p>
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
