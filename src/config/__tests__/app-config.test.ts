// ---------------------------------------------------------------------------
// App-config centralization tests (maintainability pass).
//
// Rule under test: the product name and derived identifiers live ONLY in
// src/config/app.ts. The files below are the user-facing surfaces that
// previously hardcoded "Fernly" — this test fails if someone reintroduces
// a literal instead of importing from the config.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP, STORAGE_KEYS, ERROR_BRIDGE_KEY, DEFAULT_MAIL_FROM, DEFAULT_WORKSPACE_NAME } from "@/config/app";

/** Files that MUST import the app config (user-facing brand surfaces). */
const CONFIG_CONSUMERS = [
  "src/app/layout.tsx",
  "src/app/not-found.tsx",
  "src/app/loading.tsx",
  "src/app/api/route.ts",
  "src/components/ui/sidebar.tsx",
  "src/components/auth/login-screen.tsx",
  "src/components/views/settings-view.tsx",
  "src/components/views/help-view.tsx",
  "src/server-actions/password-reset.ts",
  "src/server-actions/ics-export.ts",
  "src/lib/email/mailer.ts",
  "src/lib/infra/config-loader.ts",
  "src/lib/i18n.ts",
  "src/store/app-store.ts",
];

describe("app config (src/config/app.ts)", () => {
  it("exposes a coherent brand identity", () => {
    expect(APP.name.length).toBeGreaterThan(0);
    expect(APP.slug).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(APP.supportEmail).toContain("@");
    expect(APP.supportEmail.endsWith(`@${APP.domain}`)).toBe(true);
    expect(APP.tagline.length).toBeGreaterThan(0);
  });

  it("derives storage keys and the error bridge from the slug", () => {
    // PR-65 — one per-user theme blob replaces the three shared flat keys.
    expect(STORAGE_KEYS.theme).toBe(`${APP.slug}-theme`);
    expect(ERROR_BRIDGE_KEY).toBe(`__${APP.slug}CaptureError`);
    expect(DEFAULT_MAIL_FROM.startsWith(APP.name)).toBe(true);
    expect(DEFAULT_WORKSPACE_NAME.startsWith(APP.name)).toBe(true);
  });

  it("every user-facing brand surface imports from the config, not a literal", () => {
    for (const rel of CONFIG_CONSUMERS) {
      const src = readFileSync(resolve(__dirname, "../../..", rel), "utf-8");
      expect(src, `${rel} must import from @/config/app`).toMatch(
        /from ["']@\/config\/app["']/,
      );
    }
  });

  it("branded email subjects/bodies are templated, not literal", () => {
    // password-reset email + ICS export previously hardcoded the name.
    const pw = readFileSync(
      resolve(__dirname, "../../..", "src/server-actions/password-reset.ts"),
      "utf-8",
    );
    expect(pw).toMatch(/\$\{APP\.name\}/);
    const ics = readFileSync(
      resolve(__dirname, "../../..", "src/server-actions/ics-export.ts"),
      "utf-8",
    );
    expect(ics).toMatch(/PRODID:-\/\//);
    expect(ics).not.toMatch(/PRODID:-\/\/Fernly/);
  });
});
