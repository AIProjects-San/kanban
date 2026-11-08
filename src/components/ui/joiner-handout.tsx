"use client";

// Persona-audit D-03 (P0-4) — the joiner's day-one handout.
//
// The lockout: markJoined creates the account with a random one-time
// password that is NEVER emailed, and the welcome mail that tells the hire
// their sign-in email + "Forgot password?" instructions is provider-gated —
// with no RESEND_API_KEY the hire is locked out with nothing to type and
// nothing in their inbox. The honest toast tells HR, but a toast is gone in
// five seconds; the handout is the durable artifact HR can print and put in
// the joiner's hands on day one (the fix direction the assessment named:
// "onboarding printout with set-password instructions").
//
// Print works exactly like the payslip modal: the .print-area class scopes
// window.print() to this sheet; the buttons are .no-print.

import { Printer } from "lucide-react";
import { Modal } from "./modal";

export interface JoinerHandout {
  name: string;
  position: string;
  email: string;
  workspaceName: string;
  mailStatus: string;
  /** F2.10 (F-R7) — the salary-structure copy verdict. */
  payrollReady: boolean;
  /** F2.10 (F-R8) — the REAL instantiated checklist tasks (title + "day N"),
   * replacing this file's former DAY_ONE_TASKS constant (the third drifted
   * copy of the template — now the server sends the data it created). */
  tasks: { title: string; due: string }[];
}

export function JoinerHandoutModal({ handout, onClose }: { handout: JoinerHandout | null; onClose: () => void }) {
  if (!handout) return null;
  const first = handout.name.split(/\s+/)[0];
  const delivered = handout.mailStatus === "SENT";
  // The sign-in URL the joiner types — the origin of the page HR is on.
  // (Computed at render so the printed sheet always carries the URL the
  // workspace is actually served from, dev or prod.)
  const appUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <Modal
      open
      onClose={onClose}
      title={`Day-one handout — ${handout.name}`}
      description={delivered ? "Printable sign-in instructions for the new joiner" : "Welcome email NOT delivered — print this and hand it to the joiner"}
      size="md"
    >
      <div className="space-y-4 print-area" data-testid="joiner-handout">
        {!delivered && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
            data-testid="joiner-handout-warning"
          >
            The welcome email was <strong>not delivered</strong> ({handout.mailStatus === "FAILED" ? "provider error" : "no mail provider configured"}) —
            this sheet is the joiner&apos;s only copy of their sign-in instructions. Hand it to {first} on day one.
          </div>
        )}

        <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm space-y-1">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {handout.workspaceName} — your account
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <div>Signed in as: <strong data-testid="joiner-handout-email">{handout.email}</strong></div>
            {handout.position && <div>Role: {handout.position}</div>}
          </div>
          {appUrl && <div className="text-xs text-muted-foreground">Sign in at {appUrl}</div>}
          {/* F2.10 (F-R7) — the payroll-ready verdict rides the sheet too. */}
          <div
            className={"text-xs " + (handout.payrollReady ? "text-emerald-600" : "text-amber-600")}
            data-testid="joiner-handout-payroll"
          >
            {handout.payrollReady
              ? "Payroll-ready — your salary structure was created from the signed offer."
              : "Payroll is NOT set up yet — no salary components were on the offer. Follow up with HR."}
          </div>
        </div>

        <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Set your password</div>
        <ol className="list-decimal list-inside space-y-1 text-sm">
          <li>Open {appUrl || "the app"} and click <strong>&quot;Forgot password?&quot;</strong></li>
          <li>Enter <strong>{handout.email}</strong> and submit</li>
          <li>Open the reset link emailed to you (valid for 1 hour) and choose your password</li>
        </ol>
        {!delivered && (
          <div className="text-xs text-muted-foreground">
            No mail provider is configured yet, so step 3&apos;s email cannot arrive. Until one is: your
            administrator sets you a starter password (Users → your row → Reset password) — change it after
            your first sign-in (Settings → Change password).
          </div>
        )}

        <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Your first two weeks</div>
        <ul className="space-y-1 text-sm">
          {handout.tasks.map((t) => (
            <li key={t.title} className="flex items-baseline gap-2">
              <span className="inline-block w-3.5 h-3.5 shrink-0 translate-y-[2px] rounded-[3px] border border-border" aria-hidden />
              <span className="grow">{t.title}</span>
              <span className="text-xs text-muted-foreground shrink-0">{t.due}</span>
            </li>
          ))}
        </ul>
        <div className="text-xs text-muted-foreground">
          The same checklist is waiting inside the app. Welcome to {handout.workspaceName}, {first}!
        </div>

        <div className="flex justify-end gap-2 no-print">
          <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Close</button>
          <button type="button" className="f-btn f-btn-secondary" onClick={() => window.print()} data-testid="joiner-handout-print">
            <Printer size={14} /> Print / save PDF
          </button>
        </div>
      </div>
    </Modal>
  );
}
