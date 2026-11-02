// Cucumber.js configuration for the Fernly Selenium E2E suite.
//
// Run with:            bun run test:e2e
// Prerequisites:       - Chrome or Chromium installed locally
//                      - the app running (bun run dev) or BASE_URL pointed at a deployment
//                      - seeded database (bun run db:seed)
//
// NOTE: this file is CommonJS on purpose. The previous .mjs config made
// Cucumber v13 ignore the `require` field (ESM mode expects `import`), so
// every step silently reported "undefined" and the suite printed
// "0 scenarios" while appearing to run — e2e was a no-op. (Found during
// the launch-blocker crosscheck.) The @cucumber/pretty-formatter was also
// removed: it is ESM-only and cannot be loaded from a CJS config; the
// built-in progress + summary formatters are enough for CI output.

module.exports = {
  default: {
    paths: ["e2e/features/**/*.feature"],
    require: ["e2e/steps/**/*.js", "e2e/support/**/*.js"],
    format: ["progress", "summary"],
    parallel: 0, // sequential — the app has shared state (no per-user DB isolation yet)
    retry: 1,
  },
};
