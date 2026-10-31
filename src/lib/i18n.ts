// ---------------------------------------------------------------------------
// L-P2-32 — i18n scaffolding.
//
// The audit (§9.6 L-P2-32) recommends extracting strings to a t('...')
// indirection NOW even though only English ships at launch, because
// retrofitting i18n later costs triple. This module provides the indirection
// with English as the default (and only) locale; a second locale is a
// post-launch addition that only needs a new dictionary + locale detection.
//
// Usage:
//   import { t } from "@/lib/i18n";
//   t("auth.signIn")           // "Sign in"
//   t("errors.required", { field: "Email" })  // "Email is required."
//
// The dictionary is intentionally typed: a missing or misspelled key is a
// compile error, not a silent empty string at runtime.
// ---------------------------------------------------------------------------

// The dictionary type — every key must exist in EN. Adding a locale means
// adding a dictionary with the same shape.
const EN = {
  // Auth
  "auth.welcomeBack": "Welcome back",
  "auth.signIn": "Sign in",
  "auth.signOut": "Sign out",
  "auth.signingIn": "Signing in…",
  "auth.invalidCredentials": "Invalid email or password.",
  "auth.password": "Password",
  "auth.email": "Email",
  // Common errors
  "errors.required": "{field} is required.",
  "errors.notFound": "Page not found",
  "errors.notFoundBody": "The page you're looking for doesn't exist or has been moved.",
  "errors.generic": "Something went wrong",
  "errors.genericBody": "The page hit an unexpected error while loading. Your data is safe — you can try again, or reload the workspace.",
  "errors.tryAgain": "Try again",
  "errors.reloadWorkspace": "Reload workspace",
  "errors.backToFernly": "Back to Fernly",
  "errors.applicationError": "Application error",
  "errors.applicationErrorBody": "A critical error occurred while loading the application. Please try again.",
  // Loading
  "loading.workspace": "Loading workspace…",
  // Status labels (audit's L-P0-12 gated strings)
  "auth.demoAccounts": "Demo accounts",
} as const;

export type TranslationKey = keyof typeof EN;

/**
 * Translate a key. Parameters in `{braces}` are interpolated from `params`.
 * Unknown keys are a compile error (typed dictionary); at runtime a missing
 * key falls back to the key itself so a bug is visible, not silent.
 */
export function t(
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  let value: string = EN[key] ?? String(key);
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}

/** Exposed for tests + future locale negotiation. */
export const dictionaries = { en: EN } as const;
export type Locale = keyof typeof dictionaries;
export const DEFAULT_LOCALE: Locale = "en";
