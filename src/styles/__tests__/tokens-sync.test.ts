// ---------------------------------------------------------------------------
// Token sync guard — enforces that src/styles/tokens.ts (the TS mirror used
// for inline styles) and src/styles/tokens.css (the real design tokens)
// never drift apart.
//
// Why: CSS custom properties can't be read at render time cheaply, so a
// small TS mirror exists for inline-style consumers (accent swatches,
// legends). Two copies can drift; this test makes drift a build failure
// instead of a subtle visual inconsistency.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { AVATAR_COLORS, TAG_FG_COLORS, PRIORITY_FG_COLORS } from "@/styles/tokens";

const css = readFileSync(resolve(__dirname, "../tokens.css"), "utf-8");

/** Extract `--name: value;` declarations from the CSS source. */
function cssVars(): Map<string, string> {
  const map = new Map<string, string>();
  const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    // First declaration wins — :root values are the canonical light theme.
    if (!map.has(m[1])) map.set(m[1], m[2].trim());
  }
  return map;
}

describe("design-token sync (tokens.css ↔ tokens.ts)", () => {
  const vars = cssVars();

  it("exposes every avatar token the TS mirror declares", () => {
    for (const [key, value] of Object.entries(AVATAR_COLORS)) {
      expect(vars.get(`avatar-${key}`), `--avatar-${key} missing from tokens.css`).toBe(value);
    }
  });

  it("exposes every tag foreground token the TS mirror declares", () => {
    for (const [key, value] of Object.entries(TAG_FG_COLORS)) {
      expect(vars.get(`tag-${key}-fg`), `--tag-${key}-fg missing from tokens.css`).toBe(value);
    }
  });

  it("exposes every priority foreground token the TS mirror declares", () => {
    for (const [key, value] of Object.entries(PRIORITY_FG_COLORS)) {
      expect(vars.get(`priority-${key}-fg`), `--priority-${key}-fg missing from tokens.css`).toBe(
        value,
      );
    }
  });

  it("globals.css contains no raw oklch() literals outside the token file", () => {
    const globals = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf-8");
    // Strip comments before scanning so explanatory comments don't count.
    const code = globals.replace(/\/\*[\s\S]*?\*\//g, "");
    // Any remaining oklch( uses must be accent-engine derivations that
    // compose var(--accent-*) — never raw numeric literals.
    const literalOk = code.match(/oklch\((?!var\()[^)]*\)/g) ?? [];
    expect(literalOk, `raw oklch literals in globals.css: ${literalOk.join(", ")}`).toEqual([]);
  });

  it("globals.css imports the shared token file", () => {
    const globals = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf-8");
    expect(globals).toMatch(/@import\s+"..\/styles\/tokens\.css"/);
  });

  it("the legacy JS tailwind config is gone (Tailwind v4 is CSS-first)", () => {
    // ADR-003 (docs/DECISIONS.md): the v3-style tailwind.config.ts drifted
    // out of sync (hsl() vs oklch()) and was silently ignored by v4.
    expect(existsSync(resolve(__dirname, "../../../..", "tailwind.config.ts"))).toBe(false);
  });
});
