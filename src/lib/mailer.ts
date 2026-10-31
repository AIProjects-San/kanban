// ---------------------------------------------------------------------------
// L-P0-11 — Pluggable transactional mail service.
//
// `Mailer` interface satisfied by any provider (Resend, SES, Postmark,
// SendGrid). `ConsoleMailer` (dev/test default), `FakeMailer` (test-only),
// `createMailer()` factory (picks a real mailer when configured, falls back
// to ConsoleMailer with a production warning otherwise).
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

  if (process.env.NODE_ENV === "production" && !process.env.RESEND_API_KEY && !process.env.SES_REGION) {
    console.warn(
      "[mail] No transactional mail provider configured (RESEND_API_KEY / " +
      "SES_REGION not set). Falling back to ConsoleMailer — password reset " +
      "emails will NOT reach users. Wire a real provider before launch (L-P0-11).",
    );
  }

  cachedMailer = new ConsoleMailer();
  return cachedMailer;
}

/** Test-only: reset the cached mailer so a new one is created on next call. */
export function _resetMailerCacheForTests(): void {
  cachedMailer = null;
}
