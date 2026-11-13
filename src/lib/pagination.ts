// ---------------------------------------------------------------------------
// Pagination kernel — the sync cursor helpers shared by the paginated list
// actions (server-actions/pagination.ts, bugs.ts).
//
// These MUST live outside any "use server" module: Next.js requires every
// runtime export of a server-actions file to be an async function (each
// export becomes an RPC endpoint), so a sync `export function` there is a
// build-time error ("Server Actions must be async functions" — it broke the
// dev server until the helpers moved here). Pure: no DB, no auth, no clock.
// ---------------------------------------------------------------------------

/**
 * P2 (edge-case audit) — validate the cursor format before passing it to
 * Prisma. A malformed or stale cursor (not a cuid, points to a hard-deleted
 * row) previously caused Prisma's `cursor: { id }` to throw P2015 → 500 →
 * broken UI. Now: return null (treated as "first page") so the caller gets
 * a clean result instead of an error.
 *
 * CUIDs are 24-char lowercase base-36 (typically start with 'c'). We accept
 * any 20-32 char alphanumeric string as a permissive sanity check.
 */
export function safeCursor(cursor: string | undefined): string | null {
  if (!cursor || typeof cursor !== "string") return null;
  const trimmed = cursor.trim();
  if (trimmed.length < 20 || trimmed.length > 32) return null;
  if (!/^[a-z0-9]+$/i.test(trimmed)) return null;
  return trimmed;
}

/** Slice one page + the hasMore flag + the next cursor from an
 * over-fetched row list (callers take limit+1 rows). */
export function pageOf<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;
  return { items, hasMore, nextCursor };
}
