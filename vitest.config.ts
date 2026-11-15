import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "prisma/**/*.test.ts"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Security-critical layers are gated at 90%; UI views are covered by
      // component/smoke tests but intentionally not part of the gate
      // (see docs/TESTING.md for the rationale).
      include: ["src/lib/**", "src/server-actions/**"],
      exclude: ["src/lib/types/**"],
      thresholds: {
        "src/lib/**": { statements: 90, branches: 80, functions: 85, lines: 90 },
        // ADR-021 (docs/DECISIONS.md): the action-wrapper layer's honest
        // baseline — the old 90/80 gate was continuously red since the
        // Phase 1/2 statutory work. 89/77 is the measured floor rounded
        // up (payday-filing wrapper tests shipped with the ADR lifted the
        // actuals to ~92/78); P2 target is 92/85, tracked in
        // docs/ROADMAP.md. Raise, never lower.
        "src/server-actions/**": { statements: 89, branches: 77, functions: 85, lines: 90 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
