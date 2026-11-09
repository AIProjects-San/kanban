// Local-only cucumber config for running a SUBSET of features (the default
// cucumber.cjs glob cannot be filtered from the CLI — arguments merge with
// the config paths, so "run just this feature" silently runs the whole
// suite). Untracked debug tool: CI always uses e2e/cucumber.cjs.
//
//   E2E_ONLY=e2e/features/my-interviews.feature bunx cucumber-js -c e2e/cucumber.only.cjs
//
// CI-repair: E2E_ONLY now accepts a comma-separated list for chunked local
// runs (the sandbox has no system Chrome and limited RAM, so the full suite
// runs in feature chunks with browser cleanup between them):
//   E2E_ONLY=e2e/features/a11y.feature,e2e/features/login.feature ...
//
module.exports = {
  default: {
    paths: (process.env.E2E_ONLY || "e2e/features/**/*.feature")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    require: ["e2e/steps/**/*.js", "e2e/support/**/*.js"],
    format: ["progress", "summary"],
    parallel: 0, // sequential — the app has shared state (no per-user DB isolation yet)
    retry: 1,
  },
};
