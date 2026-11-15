import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, CalendarRange, ClipboardList, Moon } from "lucide-react";
import { getSession } from "@/server-actions/auth-guard";

// ---------------------------------------------------------------------------
// G4 — the timesheet + shift route group shell.
//
// Guard: a session (signed out → the app root). The group deliberately
// does NOT hard-gate on a permission because ONE leaf in it —
// /admin/employees/[id]/timesheets — doubles as the EMPLOYEE self-service
// surface (the owner drafts and submits their own hours; the
// getMyPayslips session-identity precedent). Every OTHER page's data
// action enforces attendance:manage (SUPER_ADMIN + ADMIN + HR) and the
// page renders that refusal as its access panel — the actions are the
// gate, never the layout alone.
//
// URLs (the group name is stripped): /admin/timesheets,
// /admin/employees/[id]/timesheets, /admin/shifts, /admin/shifts/roster,
// /admin/shifts/roster/[date].
// ---------------------------------------------------------------------------

const NAV = [
  { href: "/admin/timesheets", label: "Timesheets", icon: ClipboardList },
  { href: "/admin/shifts", label: "Shifts", icon: Moon },
  { href: "/admin/shifts/roster", label: "Roster", icon: CalendarRange },
];

export default async function G4AttendanceLayout({ children }: { children: React.ReactNode }) {
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
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-teal-500/15">
              <CalendarRange className="h-4 w-4 text-teal-600" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold">Timesheets &amp; shifts</p>
              <p className="text-[11px] text-muted-foreground">Actual hours · expected hours · the roster</p>
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
