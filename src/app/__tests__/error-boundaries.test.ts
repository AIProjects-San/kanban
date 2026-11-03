// L-P0-3 regression — error boundary / not-found / loading files exist and
// export the right shape. Next.js requires specific file names + default
// exports for boundaries; a typo silently falls back to the raw error page.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("L-P0-3 error boundary / loading / not-found files exist", () => {
  it("src/app/error.tsx exports a default client component", async () => {
    const mod = await import("../error");
    expect(typeof mod.default).toBe("function");
  });

  it("src/app/not-found.tsx exports a default server component", async () => {
    const mod = await import("../not-found");
    expect(typeof mod.default).toBe("function");
  });

  it("src/app/loading.tsx exports a default server component", async () => {
    const mod = await import("../loading");
    expect(typeof mod.default).toBe("function");
  });

  it("PR-40: global-error renders without inline style attributes (CSP style-src 'self')", () => {
    // global-error replaces the ENTIRE document, so it cannot lean on layout
    // classes alone — but it imports globals.css, so utility classes resolve.
    // Inline style attributes would be blocked by the hardened production CSP
    // (style-src 'self', no unsafe-inline) and render the crash page unstyled.
    const src = readFileSync(resolve(__dirname, "..", "global-error.tsx"), "utf-8");
    expect(src).not.toMatch(/style=\{\{/);
  });

  it("src/app/global-error.tsx exists, is a client component, and has a default export", () => {
    // Read on disk — importing pulls in globals.css which jsdom can't parse.
    const filePath = resolve(__dirname, "..", "global-error.tsx");
    const src = readFileSync(filePath, "utf-8");
    expect(src).toMatch(/^"use client"/m);
    expect(src).toMatch(/export\s+default\s+function\s+GlobalError/);
    expect(src).toMatch(/<html/);
    expect(src).toMatch(/<body/);
    expect(src).toMatch(/globals\.css/);
  });
});
