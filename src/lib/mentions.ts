// ---------------------------------------------------------------------------
// L-P2-29 — @mention parsing (pure, testable).
//
// Parses `@Name` tokens from task descriptions / message bodies so the
// server can emit MENTION notifications to the referenced users.
//
// Each `@` occurrence yields the MAXIMAL two-word candidate ("@Ada Lovelace"
// → "Ada Lovelace"; "@Ada about" → "Ada about"). Whether a candidate refers
// to a real user is resolved by the caller (notifyMentionedUsers), which
// tries the full name first, then the first word alone when unambiguous —
// syntax alone cannot tell "Ada Lovelace" (a name) from "Ada about" (a name
// followed by prose).
// ---------------------------------------------------------------------------

/**
 * Extract candidate mentioned-name strings from a text body.
 *
 * Returns the maximal two-word form per `@` occurrence, without the leading
 * "@", de-duplicated case-insensitively, in order of appearance.
 *
 * Examples:
 *   extractMentionedNames("ping @Ada about the deploy")        → ["Ada about"]
 *   extractMentionedNames("cc @Ada Lovelace please")           → ["Ada Lovelace"]
 *   extractMentionedNames("@Ada and @grace hopper review this") → ["Ada and", "grace hopper"]
 *   extractMentionedNames("no mentions here")                  → []
 *   extractMentionedNames("email is ada@x.co")                 → [] (no @ word boundary)
 */
export function extractMentionedNames(text: string): string[] {
  if (!text) return [];
  const names: string[] = [];
  const seen = new Set<string>();

  // Match @ followed by 1-2 words. The negative character class before @
  // ensures we don't match the @ inside an email address (ada@x.co) — only
  // a @ that starts at a word boundary.
  const re = /(^|[^@\w])@([A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*)?)/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // Group 2 is a MANDATORY letter-initial capture ([A-Za-z]…), so it always
    // holds at least one non-whitespace character — no empty-guard needed.
    const raw = match[2].trim();
    // De-dup case-insensitively (the same person mentioned twice should only
    // notify once).
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(raw);
  }
  return names;
}

/**
 * Normalise a name for matching: lowercase, collapse whitespace. Used by the
 * caller to compare extracted mentions against real user names.
 */
export function normaliseNameForMention(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
