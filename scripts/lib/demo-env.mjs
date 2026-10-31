// Shared helper for Node-based dev scripts.
//
// Secret hygiene rule (docs/SECURITY.md): credential literals never live in
// this repo — the demo password's only home is .env
// (NEXT_PUBLIC_DEMO_PASSWORD). Scripts that need to log in programmatically
// read it through here so there is exactly one place to change it.
//
// The wrapper scripts in package.json load .env via scripts/run-with-env.sh;
// when calling a script directly, export the variable first.

export function demoPassword() {
  const pw = process.env.NEXT_PUBLIC_DEMO_PASSWORD;
  if (!pw) {
    console.error(
      "[demo-env] NEXT_PUBLIC_DEMO_PASSWORD is not set.\n" +
        "  Load .env first:  bash scripts/run-with-env.sh node scripts/<script>.mjs\n" +
        "  or export it:     export NEXT_PUBLIC_DEMO_PASSWORD=<value>",
    );
    process.exit(1);
  }
  return pw;
}
