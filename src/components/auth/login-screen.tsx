"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { Leaf, Mail, Lock, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { RoleBadge } from "../fernly/role-badge";

// ---------------------------------------------------------------------------
// L-P0-12 — demo credentials must not leak into production builds.
//
// All demo affordances are gated behind NEXT_PUBLIC_SEED_DEMO=1 (a build-time
// env var inlined into the client bundle). Production builds that don't set
// it get a clean login screen: no prefill, no demo accounts panel, no
// credential hints in error toasts.
// ---------------------------------------------------------------------------
const SEED_DEMO = process.env.NEXT_PUBLIC_SEED_DEMO === "1";

export function LoginScreen() {
  const [email, setEmail] = useState(SEED_DEMO ? "demo@fernly.app" : "");
  const [password, setPassword] = useState(SEED_DEMO ? "fernly123" : "");
  const [loading, setLoading] = useState(false);

  // If redirected back with ?error=CredentialsSignin, show toast
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (error === "CredentialsSignin" || error === "Configuration") {
      // L-P0-12: don't leak the demo credentials in the error toast.
      toast.error(SEED_DEMO
        ? "Invalid credentials. Try a demo account below."
        : "Invalid email or password.");
      // Clean the URL
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    // Use redirect: false so we control the redirect ourselves.
    // window.location.reload() stays on the current origin (critical for
    // reverse-proxy / preview environments where NextAuth might detect the
    // wrong base URL). The session cookie is set by the POST response, and
    // the reload picks it up.
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
      callbackUrl: "/",
    });
    setLoading(false);
    if (res?.error) {
      toast.error(SEED_DEMO
        ? "Invalid credentials. Try a demo account below."
        : "Invalid email or password.");
    } else if (res?.ok || res?.url) {
      // Success — reload the current page to pick up the session cookie.
      // Use replace so the login page doesn't stay in browser history.
      window.location.replace(window.location.pathname);
    } else {
      // Unexpected response — try reloading anyway
      window.location.reload();
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Left — form */}
      <div className="flex-1 flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-2 mb-8">
            <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
              <Leaf size={20} />
            </div>
            <span className="text-lg font-semibold tracking-tight">Fernly</span>
          </div>

          <h1 className="text-2xl font-bold text-foreground tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground mt-1.5 mb-6">
            Sign in to your workspace to continue.
          </p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">Email</label>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="email"
                  className="f-input pl-9"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">Password</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="password"
                  className="f-input pl-9"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="f-btn f-btn-primary w-full"
            >
              {loading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>
                  Sign in <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          {SEED_DEMO && (
            <div className="mt-6 p-3 rounded-lg bg-muted/60 border border-border">
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Demo accounts (all password: fernly123)
              </div>
              <div className="space-y-1.5">
                <DemoAccount email="demo@fernly.app" role="Admin" onClick={() => { setEmail("demo@fernly.app"); setPassword("fernly123"); }} />
                <DemoAccount email="manager@fernly.app" role="Manager" onClick={() => { setEmail("manager@fernly.app"); setPassword("fernly123"); }} />
                <DemoAccount email="member@fernly.app" role="Member" onClick={() => { setEmail("member@fernly.app"); setPassword("fernly123"); }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right — brand panel */}
      <div className="hidden lg:flex flex-1 relative overflow-hidden bg-primary">
        <div className="absolute inset-0 opacity-20" style={{
          backgroundImage: `radial-gradient(circle at 25% 30%, white 1px, transparent 1px), radial-gradient(circle at 75% 70%, white 1px, transparent 1px)`,
          backgroundSize: "60px 60px, 40px 40px",
        }} />
        <div className="relative flex flex-col justify-center px-12 text-primary-foreground">
          <Leaf size={48} className="mb-6" />
          <h2 className="text-4xl font-bold tracking-tight leading-tight max-w-md">
            Project management that grows with your team.
          </h2>
          <p className="mt-4 text-base text-primary-foreground/80 max-w-md leading-relaxed">
            Plan sprints, track tasks, schedule events, and visualize your team's performance — all in one calm, focused workspace.
          </p>
          <div className="mt-8 flex gap-6">
            <Stat label="Projects" value="24" />
            <Stat label="Team members" value="12" />
            <Stat label="Avg. on-time" value="87%" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-primary-foreground/70">{label}</div>
    </div>
  );
}

function DemoAccount({ email, role, onClick }: { email: string; role: string; onClick: () => void }) {
  // Map the Title-case display label to the Role enum expected by RoleBadge
  const roleKey = role.toUpperCase() as "ADMIN" | "MANAGER" | "MEMBER";
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-background transition-colors text-left"
    >
      <span className="text-xs font-mono text-foreground">{email}</span>
      <RoleBadge role={roleKey} />
    </button>
  );
}
