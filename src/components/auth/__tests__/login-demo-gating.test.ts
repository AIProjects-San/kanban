// L-P0-12 regression — demo credential gating. Both the seed guard and the
// login screen must be gated behind SEED_DEMO / NEXT_PUBLIC_SEED_DEMO.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("L-P0-12 seed safety guard (scripts/seed.js)", () => {
  function runSeed(env: Record<string, string | undefined>, cwd = "/home/z/my-project"): {
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
      execFileSync("node", [resolve(__dirname, "../../../../scripts/seed.js")], {
        cwd,
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

  it("refuses BEFORE wiping when NEXT_PUBLIC_DEMO_PASSWORD is unset (SEED_DEMO=1)", () => {
    // Simulate the misconfiguration with an EMPTY override: Prisma's
    // dotenv always finds the project .env via the schema dir (it never
    // overrides an existing var), so an empty string is exactly the
    // "not configured" state. The password check sits before the wipe +
    // any DB call, so a bad environment can never destroy data and then
    // fail (ADR-006).
    const { exitCode, stderr } = runSeed({
      SEED_DEMO: "1",
      NODE_ENV: "development",
      NEXT_PUBLIC_DEMO_PASSWORD: "",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/NEXT_PUBLIC_DEMO_PASSWORD/);
  });
});

describe("L-P0-12 login screen demo gating (src/components/auth/login-screen.tsx)", () => {
  const src = readFileSync(resolve(__dirname, "../login-screen.tsx"), "utf-8");

  it("reads NEXT_PUBLIC_SEED_DEMO (build-time env var, not runtime)", () => {
    expect(src).toMatch(/NEXT_PUBLIC_SEED_DEMO/);
  });

  // Launch gate 11 — the ORIGINAL fix only gated the UI behind SEED_DEMO,
  // but the credential literals survived dead-code elimination and shipped
  // in the production client chunks (found by grepping the built bundle).
  // The component must now carry ZERO literals; the data comes from
  // NEXT_PUBLIC_DEMO_* env vars that are only set in dev/demo builds.
  it("contains NO demo credential literals — data is env-injected (launch gate 11)", () => {
    expect(src).not.toMatch(/fernly123/);
    expect(src).not.toMatch(/demo@fernly\.app/);
    expect(src).not.toMatch(/manager@fernly\.app/);
    expect(src).not.toMatch(/member@fernly\.app/);
    expect(src).toMatch(/NEXT_PUBLIC_DEMO_ACCOUNTS/);
    expect(src).toMatch(/NEXT_PUBLIC_DEMO_PASSWORD/);
  });

  it("gates the email/password prefill behind SEED_DEMO", () => {
    expect(src).toMatch(/useState\(SEED_DEMO && DEMO_ACCOUNTS\[0\] \? DEMO_ACCOUNTS\[0\]\.email : ""\)/);
    expect(src).toMatch(/useState\(SEED_DEMO \? DEMO_PASSWORD : ""\)/);
  });

  it("gates the Demo accounts panel render behind SEED_DEMO", () => {
    expect(src).toMatch(/\{SEED_DEMO && DEMO_ACCOUNTS\.length > 0 && \(/);
  });

  it("does not leak demo credentials in the error toast when SEED_DEMO is off", () => {
    expect(src).toMatch(/Invalid email or password\./);
    expect(src).toMatch(/SEED_DEMO\s*\?\s*["`].*Try a demo account below/);
  });

  it("the i18n dictionary does not carry the demo password either", () => {
    const i18n = readFileSync(resolve(__dirname, "../../../lib/i18n.ts"), "utf-8");
    expect(i18n).not.toMatch(/fernly123/);
  });

  it("no source file owns the demo password literal — .env is the single home", () => {
    // Secret hygiene (docs/SECURITY.md): NEXT_PUBLIC_DEMO_PASSWORD in .env
    // is the ONLY place the demo credential lives. The seed reads it from
    // the environment; scripts and e2e go through their shared helpers.
    const seed = readFileSync(resolve(__dirname, "../../../../scripts/seed.js"), "utf-8");
    expect(seed).not.toMatch(/fernly123/);
    expect(seed).toMatch(/NEXT_PUBLIC_DEMO_PASSWORD/);

    const e2eSteps = readFileSync(
      resolve(__dirname, "../../../../e2e/steps/common-steps.js"),
      "utf-8",
    );
    expect(e2eSteps).not.toMatch(/fernly123/);

    const k6 = readFileSync(
      resolve(__dirname, "../../../../scripts/load-test.k6.js"),
      "utf-8",
    );
    expect(k6).not.toMatch(/fernly123/);
  });
});
