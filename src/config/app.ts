/**
 * Application configuration — the SINGLE source of truth for the product
 * name and every derived identifier.
 *
 * ADR-004 — Product identity is code, in one config module. Rebranding =
 * editing this file. Tests in src/config/__tests__/app-config.test.ts pin
 * the contract so literals cannot quietly return. See docs/DECISIONS.md.
 *
 * Rule (see docs/CODING_STANDARDS.md): user-visible product names, email
 * subjects, metadata titles, storage keys and protocol identifiers must be
 * imported from here — never written as a literal. To rebrand the app,
 * change this one file.
 *
 * This module is intentionally dependency-free so it can be imported from
 * server code, client components, and "use server" files alike.
 */

export const APP = {
  /** Product name shown in the UI, emails, and document metadata. */
  name: "Fernly",
  /** Machine slug — storage keys, window bridges, protocol ids. */
  slug: "fernly",
  /** Short descriptor used in the page title and API discovery. */
  tagline: "Project Management Dashboard",
  /** Support contact shown in the Help view. */
  supportEmail: "support@fernly.app",
  /** Domain for generated identifiers (ICS UIDs, example email placeholders). */
  domain: "fernly.app",
} as const;

export type AppConfig = typeof APP;

/** localStorage keys (theme persistence) — derived from the app slug. */
export const STORAGE_KEYS = {
  accent: `${APP.slug}-accent`,
  dark: `${APP.slug}-dark`,
  rail: `${APP.slug}-rail`,
} as const;

/**
 * Window bridge the client error boundary uses to hand captured errors to
 * the server-side proxy (which owns the request context). Both sides MUST
 * reference this constant — see src/proxy.ts and src/app/error.tsx.
 */
export const ERROR_BRIDGE_KEY = `__${APP.slug}CaptureError`;

/** Display name used when no workspace name has been configured. */
export const DEFAULT_WORKSPACE_NAME = `${APP.name} Workspace`;

/** Default MAIL_FROM for the Resend transactional mailer. */
export const DEFAULT_MAIL_FROM = `${APP.name} <onboarding@resend.dev>`;
