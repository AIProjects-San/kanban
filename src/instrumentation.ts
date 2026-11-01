// ---------------------------------------------------------------------------
// Next.js instrumentation hook.
//
// register() runs in BOTH the Node.js and the Edge runtime. The Edge runtime
// does not support process.on()/process.exit()/unref(), and Turbopack still
// statically PARSES everything reachable from this file when it builds the
// Edge copy — guard-style runtime checks inside this file only prevented the
// code from EXECUTING, not from being compiled, so every request logged 7
// "Node.js API used in Edge Runtime" warning blocks that drowned the real
// dev-server output (and the CI e2e dev.log dump with it).
//
// The documented fix (see the Next.js docs on instrumenting the Edge runtime)
// is to branch on process.env.NEXT_RUNTIME and dynamically import a separate
// Node-only module: the bundler replaces NEXT_RUNTIME at build time and
// dead-code-eliminates the import entirely, so the Edge bundle never sees
// the Node-only code.
// ---------------------------------------------------------------------------

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
