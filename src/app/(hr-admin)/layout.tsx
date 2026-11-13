import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ArrowLeftRight, ShieldAlert } from "lucide-react";
import { getSession, checkPermission } from "@/server-actions/auth-guard";

// ---------------------------------------------------------------------------
// P1 G6 — the HR-admin route group shell for the employment documents.
//
// Guard: `hr:admin` (SUPER_ADMIN + ADMIN + HR — the same permission every
// employment-fact writer requires; the four-eyes approval inside the
// actions still refuses self-approval). Signed out → the app root (login);
// a role without the permission → an explicit access-denied panel.
//
// URLs (the group name is stripped): /admin/employees/[id]/transfers and
// /admin/employees/[id]/promotions.
// ---------------------------------------------------------------------------

export default async function HrAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/");
  }
  const allowed = await checkPermission(session.role, "hr:admin");
  if (!allowed) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert className="h-6 w-6 text-destructive" />
          </div>
          <h1 className="text-lg font-semibold">HR admin only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Employee transfers and promotions are restricted to the HR admin
            permission (SUPER_ADMIN, ADMIN, HR). You are signed in as{" "}
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
          >
            <ArrowLeft className="h-4 w-4" /> Back to Fernly
          </Link>
          <nav className="flex items-center gap-1">
            <Link
              href="/admin/employees"
              className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeftRight className="h-4 w-4" /> Employment documents
            </Link>
          </nav>
          <div className="ml-auto text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{session.name}</span> · {session.role}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
