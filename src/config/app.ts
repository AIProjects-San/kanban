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

/**
 * localStorage keys — derived from the app slug.
 *
 * PR-65 — appearance is PER-USER. The three flat keys below (one shared set
 * per browser) let one account's theme/rail choices leak into every other
 * account on that machine; they are now collapsed into ONE versioned blob
 * tagged with the owning user id (`theme`), which AppShell rebinds on login.
 * LEGACY_* lists the old flat keys purely so boot can delete them.
 */
export const STORAGE_KEYS = {
  theme: `${APP.slug}-theme`,
} as const;

export const LEGACY_STORAGE_KEYS = [
  `${APP.slug}-accent`,
  `${APP.slug}-dark`,
  `${APP.slug}-rail`,
] as const;

/** The per-user appearance cache blob stored under STORAGE_KEYS.theme. */
export interface ThemeCache {
  /** Which user this cached appearance belongs to (rebound on login). */
  userId: string | null;
  accent: string;
  dark: boolean;
  rail: boolean;
}

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
