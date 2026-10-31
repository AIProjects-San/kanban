// L-P0-12 regression — demo credential gating. Both the seed guard and the
// login screen must be gated behind SEED_DEMO / NEXT_PUBLIC_SEED_DEMO.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("L-P0-12 seed safety guard (scripts/seed.js)", () => {
  function runSeed(env: Record<string, string | undefined>): {
    exitCode: number;
    stderr: string;
  } {
    // Start from a clean PATH-only env so .env values from the test runner
    // don't leak in. Then apply the caller's overrides.
    const envClean: Record<string, string | undefined> = { PATH: process.env.PATH ?? "" };
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) envClean[k] = v;
    }
    try {
      execFileSync("node", ["scripts/seed.js"], {
        cwd: "/home/z/my-project",
        env: envClean as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      return { exitCode: 0, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      return { exitCode: e.status ?? 1, stderr: e.stderr?.toString() ?? "" };
    }
  }

  it("refuses when SEED_DEMO is unset (regardless of NODE_ENV)", () => {
    const { exitCode, stderr } = runSeed({ NODE_ENV: "development" });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Refusing to seed: SEED_DEMO=1 not set/);
  });

  it("refuses when NODE_ENV=production (even with SEED_DEMO=1)", () => {
    const { exitCode, stderr } = runSeed({ SEED_DEMO: "1", NODE_ENV: "production" });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Refusing to seed: NODE_ENV=production/);
  });

  it("refuses on NODE_ENV=production alone", () => {
    const { exitCode, stderr } = runSeed({ NODE_ENV: "production" });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/NODE_ENV=production/);
  });
});

describe("L-P0-12 login screen demo gating (src/components/auth/login-screen.tsx)", () => {
  const src = readFileSync(resolve(__dirname, "../login-screen.tsx"), "utf-8");

  it("reads NEXT_PUBLIC_SEED_DEMO (build-time env var, not runtime)", () => {
    expect(src).toMatch(/NEXT_PUBLIC_SEED_DEMO/);
  });

  it("gates the email/password prefill behind SEED_DEMO", () => {
    expect(src).toMatch(/useState\(SEED_DEMO \? "demo@fernly\.app" : ""\)/);
    expect(src).toMatch(/useState\(SEED_DEMO \? "fernly123" : ""\)/);
  });

  it("gates the Demo accounts panel render behind SEED_DEMO", () => {
    expect(src).toMatch(/\{SEED_DEMO && \(/);
  });

  it("does not leak demo credentials in the error toast when SEED_DEMO is off", () => {
    expect(src).toMatch(/Invalid email or password\./);
    expect(src).toMatch(/SEED_DEMO\s*\?\s*["`].*Try a demo account below/);
  });
});
