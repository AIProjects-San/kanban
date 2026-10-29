import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
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
        "src/server-actions/**": { statements: 90, branches: 80, functions: 85, lines: 90 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
