"use client";

// Recruitment R6 — the PUBLIC offer signing view
// (docs/RECRUITMENT_MODULE_PLAN.md §5, milestone R6).
//
// Rendered at /offer/[token] with NO session: the 256-bit single-use token in
// the URL is the authorization (minted by sendOffer, expires after 7 days,
// consumed on signature/decline). The page shows exactly what HR sent — the
// rendered letter + the component numbers snapshot — and captures a TYPED
// signature (the full legal name, must match the candidate's name
// case-insensitively — the deliberate ceremony), storing it with a timestamp
// for the audit trail. Declining is one click and equally final.

import { useState } from "react";
import { Leaf, Loader2, PenLine, Printer, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { signOffer, declineOffer } from "@/server-actions/hiring-offers";
import { formatMoney } from "@/lib/hiring/offer-math";

/** The public (token-gated) projection of an offer — internal notes and the
 * outbox are never exposed here. `token` rides along so the sign/decline
 * actions can address the offer; it is never displayed. */
export type PublicOfferT = {
  token: string;
  offerId: string;
  candidateName: string;
  position: string;
  workspaceName: string;
  templateLabel: string;
  letterText: string;
  components: { key: string; label: string; kind: string; mode: string; amount: number; resolved: number }[];
  benefits: string[];
  totals: { earnings: number; employerContributions: number; deductions: number; net: number; ctc: number };
  expiresAt: string;
};

const KIND_LABEL: Record<string, string> = {
  EARNING: "Earning",
  EMPLOYER_CONTRIBUTION: "Employer contribution",
  DEDUCTION: "Deduction",
};

export function OfferSignView({
  offer,
  initialOutcome = null,
  signedAt = null,
  signedName = null,
}: {
  offer: PublicOfferT;
  /** Set by the page when the token was already consumed (reload of a
   * signed/declined link) — the recorded outcome renders immediately. */
  initialOutcome?: "signed" | "declined" | null;
  signedAt?: string | null;
  signedName?: string | null;
}) {
  const [signedNameInput, setSignedNameInput] = useState("");
  const [busy, setBusy] = useState<"sign" | "decline" | null>(null);
  // idle → signed | declined (both terminal — the token is single-use).
  const [outcome, setOutcome] = useState<"signed" | "declined" | null>(initialOutcome);

  const sign = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("sign");
    const res = await signOffer({ token: offer.token, signedName: signedNameInput });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setOutcome("signed");
  };

  const decline = async () => {
    setBusy("decline");
    const res = await declineOffer({ token: offer.token });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setOutcome("declined");
  };

  return (
    <OfferSignShell offer={offer}>
      {outcome === "signed" ? (
        <>
          {/* F2.10 (R12) — the post-sign APPOINTMENT LETTER: the signed
              offer's durable printable confirmation (letter snapshot +
              package + the recorded signature), riding the payslip modal's
              .print-area / window.print() pattern. The heading + signature
              block are what make it an appointment letter rather than a
              re-read of the offer. */}
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-6 text-center print:hidden" data-testid="offer-signed-state">
            <ShieldCheck size={28} className="mx-auto text-emerald-600" />
            <h2 className="mt-3 text-lg font-semibold text-foreground">You&apos;re signed — welcome aboard!</h2>
            <p className="mt-1.5 text-sm text-muted-foreground max-w-md mx-auto">
              {signedAt
                ? `Recorded ${new Date(signedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}${signedName ? ` by ${signedName}` : ""}.`
                : "Your acceptance was recorded with a timestamp and cannot be changed."}{" "}
              {offer.workspaceName} will be in touch about your start date and your first day.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Your letter of appointment is below — print or save it for your records.
            </p>
          </div>
          {/* The printable letter — everything inside is .print-area, so
              window.print() emits exactly this sheet. */}
          <div className="rounded-lg border border-border bg-card p-6 print-area" data-testid="appointment-letter">
            <div className="flex items-center gap-2 pb-4 border-b border-border">
              <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
                <Leaf size={16} />
              </div>
              <span className="font-semibold tracking-tight text-foreground">{offer.workspaceName}</span>
            </div>
            <h2 className="mt-5 text-xl font-bold tracking-tight text-foreground">Letter of Appointment</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {signedAt
                ? new Date(signedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
                : new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
            </p>
            <pre className="mt-4 whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">{offer.letterText}</pre>
            <div className="mt-4 rounded-md border border-border divide-y divide-border" data-testid="appointment-letter-package">
              <div className="px-3 py-2 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                Your annual package — {offer.templateLabel}
              </div>
              {offer.components.map((c) => (
                <div key={c.key} className="px-3 py-1.5 flex items-baseline justify-between gap-3 text-sm">
                  <span>{c.label}</span>
                  <span className="tabular-nums font-medium">{formatMoney(c.resolved)}</span>
                </div>
              ))}
              <div className="px-3 py-2 bg-muted/40 flex items-baseline justify-between gap-3 text-sm font-semibold">
                <span>Net take-home / yr</span>
                <span className="tabular-nums text-primary">{formatMoney(offer.totals.net)}</span>
              </div>
              <div className="px-3 py-2 bg-muted/40 flex items-baseline justify-between gap-3 text-sm font-semibold">
                <span>Total package (CTC) / yr</span>
                <span className="tabular-nums text-emerald-600">{formatMoney(offer.totals.ctc)}</span>
              </div>
            </div>
            <div className="mt-6 pt-4 border-t border-border text-sm space-y-1" data-testid="appointment-letter-signature">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Accepted electronically</div>
              <div>
                <span className="font-semibold">{signedName || offer.candidateName}</span>
                {signedAt ? (
                  <span className="text-muted-foreground">
                    {" · "}{new Date(signedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">For and on behalf of {offer.workspaceName}</div>
            </div>
          </div>
          <div className="flex justify-end print:hidden">
            <button
              type="button"
              className="f-btn f-btn-secondary"
              onClick={() => window.print()}
              data-testid="appointment-letter-print"
            >
              <Printer size={14} /> Print appointment letter
            </button>
          </div>
        </>
      ) : outcome === "declined" ? (
        <div className="rounded-lg border border-border bg-muted/40 p-6 text-center" data-testid="offer-declined-state">
          <XCircle size={28} className="mx-auto text-muted-foreground" />
          <h2 className="mt-3 text-lg font-semibold text-foreground">Offer declined</h2>
          <p className="mt-1.5 text-sm text-muted-foreground max-w-md mx-auto">
            This decision was recorded. If this was a mistake, please reply to the offer email or contact{" "}
            {offer.workspaceName}&apos;s hiring team.
          </p>
        </div>
      ) : (
        <>
          {/* The letter exactly as HR rendered it — the immutable snapshot. */}
          <div className="rounded-lg border border-border bg-card p-5">
            <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed" data-testid="offer-letter">
              {offer.letterText}
            </pre>
          </div>

          {/* Component numbers */}
          <div className="rounded-lg border border-border" data-testid="offer-components">
            <div className="px-4 py-2.5 border-b border-border text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Your annual package — {offer.templateLabel}
            </div>
            <div className="divide-y divide-border">
              {offer.components.map((c) => (
                <div key={c.key} className="px-4 py-2 flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    {c.label}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {KIND_LABEL[c.kind] ?? c.kind}
                      {c.mode === "PERCENT_OF_BASIC" ? ` · ${c.amount}% of basic` : c.mode === "PERCENT_OF_GROSS" ? ` · ${c.amount}% of gross` : ""}
                    </span>
                  </span>
                  <span className="tabular-nums font-medium">{formatMoney(c.resolved)}</span>
                </div>
              ))}
              <div className="px-4 py-2 bg-muted/40 flex items-baseline justify-between gap-3 text-sm font-semibold">
                <span>Net take-home / yr</span>
                <span className="tabular-nums text-primary">{formatMoney(offer.totals.net)}</span>
              </div>
              <div className="px-4 py-2 bg-muted/40 flex items-baseline justify-between gap-3 text-sm font-semibold">
                <span>Total package (CTC) / yr</span>
                <span className="tabular-nums text-emerald-600">{formatMoney(offer.totals.ctc)}</span>
              </div>
            </div>
          </div>

          {/* Benefits */}
          {offer.benefits.length > 0 && (
            <div className="rounded-lg border border-border p-4" data-testid="offer-benefits">
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Benefits</div>
              <ul className="text-sm text-foreground space-y-1 list-disc pl-4">
                {offer.benefits.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          )}

          {/* Typed signature */}
          <form onSubmit={sign} className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3" data-testid="offer-sign-form">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <PenLine size={15} /> Sign this offer
            </div>
            <p className="text-xs text-muted-foreground">
              Type your full legal name — <strong>{offer.candidateName}</strong> — exactly as it appears above. Your
              typed name, the time, and your connection details are recorded as the signature.
            </p>
            <input
              className="f-input"
              value={signedNameInput}
              onChange={(e) => setSignedNameInput(e.target.value)}
              placeholder="Your full legal name"
              aria-label="Your full legal name"
              data-testid="offer-sign-name"
              maxLength={120}
              required
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="f-btn f-btn-primary" disabled={busy !== null} data-testid="offer-sign-submit">
                {busy === "sign" ? <Loader2 size={15} className="animate-spin" /> : <PenLine size={15} />} Sign offer
              </button>
              <button
                type="button"
                className="f-btn f-btn-ghost"
                disabled={busy !== null}
                onClick={() => void decline()}
                data-testid="offer-decline-btn"
              >
                {busy === "decline" ? <Loader2 size={15} className="animate-spin" /> : null} Decline
              </button>
              <span className="text-xs text-muted-foreground ml-auto">
                Link expires {new Date(offer.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · single use
              </span>
            </div>
          </form>
        </>
      )}
    </OfferSignShell>
  );
}

/** Framing shared by every state of the signing page (brand header + card). */
function OfferSignShell({ offer, children }: { offer: PublicOfferT; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-10 space-y-5" data-testid="offer-sign-page">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
            <Leaf size={18} />
          </div>
          <span className="font-semibold tracking-tight text-foreground">{offer.workspaceName}</span>
          <span className="ml-auto text-xs text-muted-foreground">Offer for {offer.position || "the role"}</span>
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground" data-testid="offer-headline">
            {offer.candidateName}, your offer awaits your signature
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review everything below, then sign at the bottom. Nothing changes until you do.
          </p>
        </div>
        {children}
        <p className="text-center text-xs text-muted-foreground">
          This link is personal — forwarded copies cannot be signed twice.
        </p>
      </div>
    </div>
  );
}

/** The error state for invalid / expired / already-consumed tokens. */
export function OfferLinkInvalid({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-lg border border-border bg-card p-8 text-center" data-testid="offer-invalid-state">
        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center mx-auto text-muted-foreground">
          <Leaf size={20} />
        </div>
        <h1 className="mt-4 text-lg font-bold text-foreground">This offer link can&apos;t be opened</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <p className="mt-4 text-xs text-muted-foreground">
          Signing links are single-use and expire after 7 days. If you were expecting an offer, reach out to the
          hiring team — they can resend a fresh link.
        </p>
      </div>
    </div>
  );
}
