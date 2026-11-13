import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// P2-23 regression — Prisma query logging only in development.
// In production the original config logged every query (noise + mild info
// leak). The fix: `log: ['query', 'error', 'warn']` in dev, `['error']` only
// in production.
// ---------------------------------------------------------------------------

const ENV_KEYS = ["NODE_ENV"] as const;
type EnvSnap = Record<string, string | undefined>;
// `process.env.NODE_ENV` is typed as a readonly literal in @types/node —
// cast through a record so we can reassign it in tests.
const env = process.env as Record<string, string | undefined>;

function snap(): EnvSnap {
  const s: EnvSnap = {} as EnvSnap;
  for (const k of ENV_KEYS) s[k] = env[k];
  return s;
}
function restore(s: EnvSnap) {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete env[k];
    else env[k] = s[k]!;
  }
}
async function freshDb() {
  vi.resetModules();
  const mod = await import("@/lib/infra/db");
  return mod.db;
}

describe("prisma log config (P2-23)", () => {
  const original = snap();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restore(original);
  });

  it("loads the db client without throwing in development", async () => {
    env.NODE_ENV = "development";
    const db = await freshDb();
    expect(db).toBeDefined();
  });

  it("loads the db client without throwing in production", async () => {
    env.NODE_ENV = "production";
    const db = await freshDb();
    expect(db).toBeDefined();
    // The global cache should be skipped in production so each request gets
    // its own client (no shared connection pool across hot-reloads).
  });
});

// ---------------------------------------------------------------------------
// Direct source-level assertion: load the db.ts source and grep for the
// log config. This is a static check that survives even if Prisma's
// constructor doesn't expose the log array at runtime.
// ---------------------------------------------------------------------------

describe("prisma log config — static source check (P2-23)", () => {
  it("the db.ts source branches on NODE_ENV === 'development' for the log array", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../db.ts"),
      "utf8",
    );
    expect(src).toMatch(/NODE_ENV.*=.*['"]development['"]/);
    expect(src).toMatch(/\['query',\s*'error',\s*'warn'\]/);
    expect(src).toMatch(/\['error'\]/);
    // And the cache should be dev-only.
    expect(src).toMatch(/NODE_ENV.*!==.*['"]production['"]/);
  });
});
