// Time-based greeting helper.
// IMPORTANT: must be deterministic between server render and client hydration.
// We compute it on the server using the user's explicit timezone so the
// server-rendered HTML matches what the client expects.

/**
 * Returns "Good morning" | "Good afternoon" | "Good evening" based on the
 * current hour in the given IANA timezone (e.g. "Pacific/Auckland").
 * Falls back to UTC if the timezone is invalid.
 */
export function getGreeting(timezone: string | undefined | null): string {
  const tz = timezone && timezone.trim() ? timezone : "UTC";
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    }).format(new Date());
    const hour = parseInt(hourStr, 10);
    if (isNaN(hour)) return "Hello";
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  } catch {
    // Invalid timezone string — fall back to a neutral greeting
    return "Hello";
  }
}

/**
 * Returns today's date as a "YYYY-MM-DD" string in the given IANA timezone.
 * This is used for "is this overdue?" comparisons that must be deterministic
 * between server render and client hydration (the server may run in UTC while
 * the client is in the user's timezone, so `new Date().toDateString()` would
 * produce different results).
 */
export function getTodayDateStr(timezone: string | undefined | null): string {
  const tz = timezone && timezone.trim() ? timezone : "UTC";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz,
    }).format(new Date()); // en-CA gives YYYY-MM-DD
  } catch {
    // Fall back to UTC
    return new Date().toISOString().slice(0, 10);
  }
}
