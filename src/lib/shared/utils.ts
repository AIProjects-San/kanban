import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * PR-40 — map a 0-100 percentage to a static width class from the
 * `.f-w-0 … .f-w-100` grid in globals.css. Bar widths are data, which
 * cannot be a static class — but a pre-generated 1%-step grid can be, so
 * SSR HTML carries only class names and the hardened production CSP
 * (`style-src 'self'`, no 'unsafe-inline') holds. Values are clamped and
 * rounded to the nearest whole percent (a 0.5% visual delta is invisible
 * on a 128px-wide bar).
 */
export function barWidthClass(pct: number): string {
  // NaN → 0 (an unknown progress renders an empty bar, never a broken class);
  // ±Infinity flows into the clamp naturally (full / empty bar).
  const safe = Number.isNaN(pct) ? 0 : pct;
  const n = Math.round(Math.min(100, Math.max(0, safe)));
  return `f-w-${n}`;
}

/**
 * F-07 — escape user-controlled text before it lands in an HTML email.
 * Shared by the password-reset and hiring (R3 outbox) mail paths.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
