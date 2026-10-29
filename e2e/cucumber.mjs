// Cucumber.js configuration for the Fernly Selenium E2E suite.
//
// Run with:            bun run test:e2e
// Prerequisites:       - Chrome or Chromium installed locally
//                      - the app running (bun run dev) or BASE_URL pointed at a deployment
//                      - seeded database (bun run db:seed)

export default {
  default: {
    paths: ["e2e/features/**/*.feature"],
    requireModule: ["@cucumber/pretty-formatter"],
    require: ["e2e/steps/**/*.js", "e2e/support/**/*.js"],
    format: ["progress", "@cucumber/pretty-formatter:pretty"],
    parallel: 0, // sequential — the app has shared state (no per-user DB isolation yet)
    retry: 1,
  },
};
