// Shared demo-password resolution for the e2e step definitions.
//
// Secret hygiene (docs/SECURITY.md): the demo password's only home is .env
// (NEXT_PUBLIC_DEMO_PASSWORD). Cucumber does not load .env itself, so this
// helper parses it. Feature files say "with the demo password" — they must
// never contain the literal credential.
//
// CI-stabilization round 3: this logic used to live inline in
// common-steps.js only. The "I sign out and back in as …" step in
// hiring-steps.js read process.env.DEMO_PASSWORD — a var CI never sets —
// and fell back to the hardcoded literal "fernly123", which is NOT the
// CI-seeded password (NEXT_PUBLIC_DEMO_PASSWORD=ci-only-demo-password).
// Every scenario using that step then failed its re-login with a 401 in CI
// while passing locally (persona-audit CI stabilization; failed scenarios
// "The document-type editor is config-gated (R4)" in both prior runs).
// One resolution point for every step that needs the credential.

const fs = require("node:fs");
const path = require("node:path");

function loadDemoPassword() {
  if (process.env.NEXT_PUBLIC_DEMO_PASSWORD) return process.env.NEXT_PUBLIC_DEMO_PASSWORD;
  const envPath = path.join(__dirname, "..", "..", ".env");
  try {
    const line = fs
      .readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("NEXT_PUBLIC_DEMO_PASSWORD="));
    // Strip surrounding quotes — dotenv and shell sourcing both do this, so
    // a quoted .env value (`PASSWORD="x"`) must not leak the quote chars
    // into the login form (bcrypt mismatch → 401 → limiter exhaustion).
    const value = line
      ? line.slice("NEXT_PUBLIC_DEMO_PASSWORD=".length).trim().replace(/^["'](.*)["']$/, "$1")
      : "";
    if (value) return value;
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    "e2e: NEXT_PUBLIC_DEMO_PASSWORD is not set — add it to .env " +
      "(see .env.example) or export it before `bun run test:e2e`.",
  );
}

const DEMO_PASSWORD = loadDemoPassword();

module.exports = { DEMO_PASSWORD, loadDemoPassword };
