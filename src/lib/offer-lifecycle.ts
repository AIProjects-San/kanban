// ---------------------------------------------------------------------------
// F2.10 — offer link lifecycle (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.2 F2.10; defect F-R5).
//
// Pure predicates + formatting for the offer token's lifecycle. The writers
// live in server-actions/hiring.ts:
//   • signOffer / declineOffer consult isOfferLinkExpired so BOTH consume
//     paths honor the expiry symmetrically (decline used to skip the check).
//   • lapseExpiredSentOffers() flips stale SENT rows to the stored EXPIRED
//     outcome on hiring reads (lazy materialization — the F2.4 house
//     pattern), and getHiringFunnel counts "awaiting" through the pure
//     predicate so the number is honest even before a lapse has run.
// ---------------------------------------------------------------------------

/** True when a SENT offer's signing link is past its expiry. A null/absent
 * expiry is treated as live (open-ended) — the minting code always sets one
 * (OFFER_TOKEN_TTL_DAYS), so null only means "not sent yet" or legacy data,
 * and the status machine (not this predicate) governs those. */
export function isOfferLinkExpired(
  tokenExpiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!tokenExpiresAt) return false;
  const at = tokenExpiresAt instanceof Date ? tokenExpiresAt : new Date(tokenExpiresAt);
  const t = at.getTime();
  return Number.isFinite(t) && t < now.getTime();
}

/** "15 Jan 2027" — the human-facing date format for offer letters
 * ({{startDate}}, F-R11) and the appointment letter. en-GB short month,
 * no weekday noise; invalid input yields "" (never "Invalid Date" in a
 * candidate-facing letter). */
export function formatOfferDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  const t = date.getTime();
  if (!Number.isFinite(t)) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** ISO "YYYY-MM-DD" for a date-only input value (the offer editor's date
 * field). Invalid input yields "" — the writer treats "" as "not set". */
export function dateOnlyISO(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  const t = date.getTime();
  if (!Number.isFinite(t)) return "";
  return date.toISOString().slice(0, 10);
}
