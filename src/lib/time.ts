/**
 * Time formatting utilities — shared across the app to avoid duplicating
 * the same relative-time logic in every component that shows timestamps.
 */

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * Examples: "just now", "3m ago", "2h ago", "5d ago", "12 Oct 2026"
 *
 * Falls back to an absolute date for anything older than 7 days so old
 * entries don't show misleading "30d ago" / "365d ago" values.
 */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  // For older events, show the actual date.
  return new Date(iso).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
