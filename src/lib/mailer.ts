// ---------------------------------------------------------------------------
// L-P0-11 — Pluggable transactional mail service.
//
// `Mailer` interface satisfied by any provider (Resend, SES, Postmark,
// SendGrid). `ConsoleMailer` (dev/test default), `ResendMailer` (production,
// wired via RESEND_API_KEY — no SDK dependency, plain fetch), `FakeMailer`
// (test-only), `createMailer()` factory.
//
// Deep-dive review F-04: the factory previously checked RESEND_API_KEY /
// SES_REGION but ALWAYS returned ConsoleMailer — no real provider existed.
// Two consequences: (1) password-reset emails silently never sent in
// production, and (2) the single-use reset token URL was printed into
// production server logs, where anyone with log access could use it to take
// over the account. Now:
//   • RESEND_API_KEY set            → ResendMailer (real delivery).
//   • no key + NODE_ENV=production  → NoopMailer — the mail is DROPPED, not
//     logged, so reset tokens can never leak into prod logs. The operator
//     gets a loud error-level warning to wire a provider.
//   • no key + development          → ConsoleMailer (full body incl. the reset
//     URL — that's the dev workflow for testing the reset flow).
// ---------------------------------------------------------------------------

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  sendMail(input: SendMailInput): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  async sendMail(input: SendMailInput): Promise<void> {
    console.info(
      `[mail:console] To: ${input.to}\n` +
      `Subject: ${input.subject}\n` +
      `---\n${input.text}\n---`,
    );
  }
}

/** Dev/no-op mailer that logs only the ENVELOPE — never the body. Used in
 * production when no provider is wired, so reset-token URLs can't leak into
 * logs (deep-dive review F-04). */
export class NoopMailer implements Mailer {
  async sendMail(input: SendMailInput): Promise<void> {
    console.error(
      `[mail:noop] DROPPED mail to ${input.to} (subject: ${input.subject}) — ` +
      `no mail provider configured. Set RESEND_API_KEY to enable delivery. ` +
      `Body intentionally NOT logged (may contain single-use tokens).`,
    );
  }
}

/** Production mailer backed by Resend's HTTP API (no SDK needed). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendMail(input: SendMailInput): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    if (!res.ok) {
      // Read the body for the provider's error detail, but never log the
      // message body itself (may contain single-use reset tokens).
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Resend API error ${res.status} for mail to ${input.to}: ${detail.slice(0, 300)}`,
      );
    }
  }
}

export class FakeMailer implements Mailer {
  readonly sent: SendMailInput[] = [];
  async sendMail(input: SendMailInput): Promise<void> {
    this.sent.push(input);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

let cachedMailer: Mailer | null = null;

export interface MailerFactoryOptions {
  /** Inject a custom mailer (used by tests + production wiring). */
  mailer?: Mailer;
}

export function createMailer(opts?: MailerFactoryOptions): Mailer {
  if (cachedMailer) return cachedMailer;

  if (opts?.mailer) {
    cachedMailer = opts.mailer;
    return cachedMailer;
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    cachedMailer = new ResendMailer(
      resendKey,
      process.env.MAIL_FROM ?? "Fernly <onboarding@resend.dev>",
    );
    return cachedMailer;
  }

  if (process.env.NODE_ENV === "production") {
    console.error(
      "[mail] No transactional mail provider configured (RESEND_API_KEY not " +
      "set). Falling back to NoopMailer — password reset emails are DROPPED " +
      "and reset tokens are never logged. Wire a provider before launch " +
      "(L-P0-11 / deep-dive F-04).",
    );
    cachedMailer = new NoopMailer();
    return cachedMailer;
  }

  cachedMailer = new ConsoleMailer();
  return cachedMailer;
}

/** Test-only: reset the cached mailer so a new one is created on next call. */
export function _resetMailerCacheForTests(): void {
  cachedMailer = null;
}
