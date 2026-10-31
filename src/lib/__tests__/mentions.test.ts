import { describe, it, expect } from "vitest";
import { extractMentionedNames, normaliseNameForMention } from "@/lib/mentions";

// L-P2-29 — @mention parsing (pure function). Each @ yields the MAXIMAL
// two-word candidate; the caller resolves candidates against real users.

describe("extractMentionedNames (L-P2-29)", () => {
  it("returns [] for empty or mention-free text", () => {
    expect(extractMentionedNames("")).toEqual([]);
    expect(extractMentionedNames("no mentions here")).toEqual([]);
  });

  it("extracts the maximal two-word candidate for a mention followed by prose", () => {
    expect(extractMentionedNames("ping @Ada about the deploy")).toEqual(["Ada about"]);
  });

  it("extracts a two-word name mention", () => {
    expect(extractMentionedNames("cc @Ada Lovelace please")).toEqual(["Ada Lovelace"]);
  });

  it("extracts multiple mentions in order", () => {
    expect(extractMentionedNames("@Ada and @grace hopper review this")).toEqual(["Ada and", "grace hopper"]);
  });

  it("does NOT match the @ inside an email address", () => {
    expect(extractMentionedNames("email is ada@x.co thanks")).toEqual([]);
  });

  it("does NOT match a bare @ with no name", () => {
    expect(extractMentionedNames("just an @ symbol")).toEqual([]);
  });

  it("de-duplicates the same candidate twice (case-insensitive)", () => {
    expect(extractMentionedNames("@Ada did you see @ada again?")).toEqual(["Ada did", "ada again"]);
  });

  it("matches a mention at the start of the text", () => {
    expect(extractMentionedNames("@Ada can you review")).toEqual(["Ada can"]);
  });

  it("handles a mention after punctuation", () => {
    expect(extractMentionedNames("thanks! @ada will handle it")).toEqual(["ada will"]);
  });

  it("ignores mentions that start with a digit", () => {
    expect(extractMentionedNames("ticket @123 is not a mention")).toEqual([]);
  });

  it("handles a single-word mention at the end of the text", () => {
    expect(extractMentionedNames("ping @Ada")).toEqual(["Ada"]);
  });
});

describe("normaliseNameForMention (L-P2-29)", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normaliseNameForMention("  Ada   Lovelace ")).toBe("ada lovelace");
  });

  it("handles single names", () => {
    expect(normaliseNameForMention("Ada")).toBe("ada");
  });
});
