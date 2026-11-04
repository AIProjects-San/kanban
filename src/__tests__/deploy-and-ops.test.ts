// L-P1-17 + L-P1-24 + L-P1-22/25/26 + L-P1-21 — config + deploy + runbook
// contract tests (bundle budget script, eslint rules, Dockerfile/compose/
// nginx, ops runbooks). Disk inspection is deterministic.

import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
} from "../lib/audit-retention-config";

const repoRoot = resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// L-P1-24 — ESLint rules re-enabled.
// ---------------------------------------------------------------------------

const eslintConfig = readFileSync(resolve(repoRoot, "eslint.config.mjs"), "utf-8");

describe("L-P1-24 ESLint high-value rules are enabled", () => {
  const requiredErrorRules = [
    "@typescript-eslint/no-unused-vars",
    "react-hooks/exhaustive-deps",
    "no-debugger",
    "no-fallthrough",
    "no-unreachable",
    "prefer-const",
  ];

  for (const rule of requiredErrorRules) {
    it(`"${rule}" is set to "error"`, () => {
      const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`["']${escaped}["']\\s*:\\s*(["']error["']|\\["error")`);
      expect(eslintConfig).toMatch(re);
    });
  }

  it("the config documents which rules are re-enabled and why (L-P1-24)", () => {
    expect(eslintConfig).toMatch(/L-P1-24/);
  });
});

// ---------------------------------------------------------------------------
// L-P1-17 — bundle budget script exists.
// ---------------------------------------------------------------------------

describe("L-P1-17 bundle budget script", () => {
  const path = resolve(repoRoot, "scripts", "check-bundle-budget.mjs");
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";

  it("exists", () => expect(existsSync(path)).toBe(true));
  it("defines the 200KB main budget (the audit's target)", () => {
    expect(content).toMatch(/main:\s*200/);
  });
  it("categorizes into framework/main/lazy buckets", () => {
    expect(content).toMatch(/framework/);
    expect(content).toMatch(/lazy/);
  });
});

// ---------------------------------------------------------------------------
// L-P1-21 — Dockerfile + docker-compose + nginx LB.
// ---------------------------------------------------------------------------

describe("L-P1-21 Dockerfile", () => {
  const dockerfile = existsSync(resolve(repoRoot, "Dockerfile"))
    ? readFileSync(resolve(repoRoot, "Dockerfile"), "utf-8") : "";

  it("exists", () => expect(existsSync(resolve(repoRoot, "Dockerfile"))).toBe(true));
  it("is multi-stage (deps + builder + runner)", () => {
    expect(dockerfile).toMatch(/FROM .* AS deps/);
    expect(dockerfile).toMatch(/FROM .* AS builder/);
    expect(dockerfile).toMatch(/FROM .* AS runner/);
  });
  it("runs as a non-root user (security)", () => {
    expect(dockerfile).toMatch(/USER nextjs/);
  });
  it("includes a HEALTHCHECK probing /api/health (L-P0-4 integration)", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/\/api\/health/);
  });
  it("does NOT set NEXT_PUBLIC_SEED_DEMO=1 by default (L-P0-12)", () => {
    expect(dockerfile).toMatch(/ARG NEXT_PUBLIC_SEED_DEMO=0/);
  });
});

describe("L-P1-21 docker-compose.yml", () => {
  const compose = existsSync(resolve(repoRoot, "docker-compose.yml"))
    ? readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf-8") : "";

  it("exists", () => expect(existsSync(resolve(repoRoot, "docker-compose.yml"))).toBe(true));
  it("defines a Redis service (shared state for L-P0-10 rate limiter)", () => {
    expect(compose).toMatch(/redis:/);
    expect(compose).toMatch(/REDIS_URL/);
  });
  it("defines the Fernly app service with multiple replicas", () => {
    expect(compose).toMatch(/fernly-1:/);
    expect(compose).toMatch(/replicas:\s*2/);
  });
  it("defines an nginx load balancer service", () => {
    expect(compose).toMatch(/nginx:/);
  });
  it("the app service does NOT set SEED_DEMO=1 (L-P0-12)", () => {
    expect(compose).toMatch(/SEED_DEMO:\s*""/);
  });
});

// ---------------------------------------------------------------------------
// PR-33 (production-readiness round 2) — optional Redis AUTH in compose.
// Roadmap §6.2: "Redis without auth/TLS inside the compose network".
// Setting REDIS_PASSWORD in .env must flip Redis into requirepass mode AND
// propagate the password to the app's REDIS_URL in one step.
// ---------------------------------------------------------------------------

describe("PR-33 optional Redis authentication", () => {
  const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf-8");

  it("redis-server runs with requirepass bound to ${REDIS_PASSWORD} (empty = disabled)", () => {
    expect(compose).toMatch(
      /redis-server --maxmemory 64mb --maxmemory-policy volatile-lru --requirepass "\$\{REDIS_PASSWORD:-\}"/,
    );
  });

  it("the redis healthcheck authenticates only when a password is set", () => {
    expect(compose).toMatch(/-n "\$REDIS_PASSWORD"/);
    expect(compose).toMatch(/--no-auth-warning/);
  });

  it("the app's default REDIS_URL embeds the password slot", () => {
    expect(compose).toMatch(
      /REDIS_URL: "\$\{REDIS_URL:-redis:\/\/:\$\{REDIS_PASSWORD:-\}@redis:6379\}"/,
    );
  });
});

// ---------------------------------------------------------------------------
// PR-32 (production-readiness round 2) — the metrics endpoint must be
// referenced by the deployment docs so operators actually scrape it.
// ---------------------------------------------------------------------------

describe("PR-32 metrics endpoint is documented", () => {
  const deployDoc = readFileSync(resolve(repoRoot, "docs", "DEPLOY.md"), "utf-8");

  it("DEPLOY.md documents /api/metrics with the bearer-token scrape config", () => {
    expect(deployDoc).toMatch(/\/api\/metrics/);
    expect(deployDoc).toMatch(/CRON_SECRET/);
  });
});

describe("L-P1-21 nginx.conf (load balancer)", () => {
  const nginx = existsSync(resolve(repoRoot, "nginx.conf"))
    ? readFileSync(resolve(repoRoot, "nginx.conf"), "utf-8") : "";

  it("exists", () => expect(existsSync(resolve(repoRoot, "nginx.conf"))).toBe(true));
  it("defines an upstream pool pointing at the Fernly app", () => {
    expect(nginx).toMatch(/upstream fernly/);
    expect(nginx).toMatch(/fernly-1:3000/);
  });
  it("has passive health checking (max_fails + fail_timeout)", () => {
    expect(nginx).toMatch(/max_fails/);
    expect(nginx).toMatch(/fail_timeout/);
  });
  it("proxies traffic to the upstream pool", () => {
    expect(nginx).toMatch(/proxy_pass\s+http:\/\/fernly/);
  });
  it("sets X-Forwarded-* headers", () => {
    expect(nginx).toMatch(/X-Forwarded-For/);
  });
});

// ---------------------------------------------------------------------------
// L-P1-22 + L-P1-25 + L-P1-26 — ops runbooks + load test + region decision.
// ---------------------------------------------------------------------------

describe("L-P1-22 Backup/DR runbook", () => {
  const content = existsSync(resolve(repoRoot, "docs", "BACKUP_RECOVERY.md"))
    ? readFileSync(resolve(repoRoot, "docs", "BACKUP_RECOVERY.md"), "utf-8") : "";

  it("exists", () => expect(existsSync(resolve(repoRoot, "docs", "BACKUP_RECOVERY.md"))).toBe(true));
  it("defines RPO and RTO targets with concrete numbers", () => {
    expect(content).toMatch(/RPO.*Recovery Point Objective/i);
    expect(content).toMatch(/\d+\s*(minute|hour)/i);
  });
  it("documents the PITR (Point-In-Time Recovery) procedure", () => {
    expect(content).toMatch(/PITR|Point-In-Time Recovery/i);
  });
  it("includes a restore drill schedule", () => {
    expect(content).toMatch(/drill/i);
    expect(content).toMatch(/quarterly|schedule/i);
  });
  it("includes verification queries", () => {
    expect(content).toMatch(/SELECT COUNT/i);
  });
});

describe("L-P1-25 k6 load testing script", () => {
  const path = resolve(repoRoot, "scripts", "load-test.k6.js");
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";

  it("exists", () => expect(existsSync(path)).toBe(true));
  it("defines the three scenarios (browse, board_drag, login_storm)", () => {
    expect(content).toMatch(/browse:/);
    expect(content).toMatch(/board_drag:/);
    expect(content).toMatch(/login_storm:/);
  });
  it("sets p95 thresholds matching the audit's W4 exit criteria", () => {
    expect(content).toMatch(/p\(95\)<1500/);
    expect(content).toMatch(/p\(95\)<400/);
  });
  it("targets 500 VUs for the login storm", () => {
    expect(content).toMatch(/target:\s*500/);
  });
});

describe("L-P1-26 DB region decision", () => {
  const path = resolve(repoRoot, "docs", "DB_REGION_DECISION.md");
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";

  it("exists", () => expect(existsSync(path)).toBe(true));
  it("documents the current region (eu-west-1) and the audience (Pacific/Auckland)", () => {
    expect(content).toMatch(/eu-west-1/i);
    expect(content).toMatch(/Pacific\/Auckland/i);
  });
  it("records a decision (accept for launch, migrate post-launch to Sydney)", () => {
    expect(content).toMatch(/Sydney|ap-southeast-2/i);
  });
  it("includes a measurement plan with concrete commands", () => {
    expect(content).toMatch(/psql/i);
  });
  it("includes a migration checklist", () => {
    expect(content).toMatch(/Migration checklist/i);
    expect(content).toMatch(/pg_dump/);
  });
  it("records the decision date and owner", () => {
    expect(content).toMatch(/Date.*2026/i);
    expect(content).toMatch(/Owner/i);
  });
});

// ---------------------------------------------------------------------------
// Production-readiness audit (PR-01/24/25) — deploy stack contracts.
// ---------------------------------------------------------------------------

describe("PR-24/PR-25 deploy stack (production-readiness audit)", () => {
  const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf-8");
  const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf-8");
  const nginx = readFileSync(resolve(repoRoot, "nginx.conf"), "utf-8");

  it("PR-24: the Dockerfile has a migrator stage carrying prisma + CLI", () => {
    expect(dockerfile).toMatch(/AS migrator/);
    expect(dockerfile).toMatch(/migrate deploy/);
  });

  it("PR-24: compose wires the app behind the one-shot migrate gate", () => {
    expect(compose).toMatch(/migrate:/);
    expect(compose).toMatch(/service_completed_successfully/);
  });

  it("PR-24: compose offers the optional bundled PostgreSQL (local-db profile)", () => {
    expect(compose).toMatch(/postgres:16-alpine/);
    expect(compose).toMatch(/profiles:\s*\["local-db"\]/);
  });

  it("PR-24: Redis uses volatile-lru (limiter keys evictable, nothing else sacrificed)", () => {
    // Match the actual redis-server command line, not the prose comments.
    expect(compose).toMatch(/redis-server --maxmemory \d+mb --maxmemory-policy volatile-lru/);
    expect(compose).not.toMatch(/--maxmemory-policy allkeys-lru/);
  });

  it("PR-25: nginx exposes a REAL upstream health probe for external monitors", () => {
    expect(nginx).toMatch(/\/upstream-health/);
    expect(nginx).toMatch(/proxy_pass http:\/\/fernly\/api\/health/);
  });

  it("PR-25: TLS options are documented and materialised as config files", () => {
    expect(existsSync(resolve(repoRoot, "deploy", "Caddyfile.production"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "deploy", "nginx-tls.conf.example"))).toBe(true);
  });

  it("PR-01: the sandbox Caddyfile (port-transform handler) lives OUTSIDE the deploy root with a warning", () => {
    const sandbox = resolve(repoRoot, "deploy", "sandbox-preview", "Caddyfile");
    expect(existsSync(sandbox)).toBe(true);
    // The warning header must be present, and the production Caddyfile must
    // NOT contain the port-transform handler.
    expect(readFileSync(sandbox, "utf-8")).toMatch(/NEVER be exposed/i);
    expect(readFileSync(resolve(repoRoot, "deploy", "Caddyfile.production"), "utf-8"))
      .not.toMatch(/XTransformPort/);
  });

  it("PR-24: .env.example exists and documents the boot contract", () => {
    const env = readFileSync(resolve(repoRoot, ".env.example"), "utf-8");
    for (const key of [
      "DATABASE_URL", "BETTER_AUTH_SECRET", "APP_URL", "SERVER_ACTIONS_ALLOWED_ORIGINS",
      "REDIS_URL", "CRON_SECRET", "RESEND_API_KEY", "MAIL_FROM", "SENTRY_DSN",
    ]) {
      expect(env).toMatch(new RegExp(`^${key}=`, "m"));
    }
    expect(env).toMatch(/REFUSES to boot/);
  });

  it("PR-45: .env.example is committed — the `.env*` ignore glob must not swallow it", () => {
    // Regression pin (round 2): `.env*` in .gitignore kept the example out of
    // the repo through rounds 1–2, so fresh clones failed the boot contract
    // and a sandbox recycle silently deleted it. It must be negated (`!
    // .env.example`) AND actually tracked. Skipped gracefully outside git.
    const ignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf-8");
    expect(ignore).toMatch(/^\.env\*$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
    if (existsSync(resolve(repoRoot, ".git"))) {
      const tracked = execSync("git ls-files .env.example", {
        cwd: repoRoot,
        encoding: "utf-8",
      }).trim();
      expect(tracked).toBe(".env.example");
    }
  });

  it("PR-46: restore-preview.sh heals from git — never from a stale snapshot or inlined routes", () => {
    // Regression pin (round 2 continuation): the script used to copy a
    // stale /tmp/ws-extract snapshot over the tree and hand-inline a
    // weeks-old /api/health route (whose GET() had no request parameter —
    // it broke the build with 9 TS2554 errors on 2026-11-03, twice).
    const sh = readFileSync(resolve(repoRoot, "scripts", "restore-preview.sh"), "utf-8");
    expect(sh).not.toMatch(/ws-extract/);
    expect(sh).not.toMatch(/cat > src\/app\/api\/health/);
    // The self-heal: tracked files reset to HEAD (platform sync has reverted
    // committed files during recycles).
    expect(sh).toMatch(/git checkout -- \./);
    expect(sh).toMatch(/git status --porcelain/);
  });

  it("2026-11-04 outage: restore-preview.sh heals the FULL demo-env trio, not just the password", () => {
    // The 2026-11-04 sandbox recycle re-provisioned .env down to DATABASE_URL
    // only. The restore script healed NEXT_PUBLIC_DEMO_PASSWORD and
    // BETTER_AUTH_SECRET but NOT the panel vars — so the login screen
    // compiled with the demo quick-login panel hidden and demo logins
    // "didn't work" even after a restore. The panel only renders when
    // NEXT_PUBLIC_SEED_DEMO=1 AND NEXT_PUBLIC_DEMO_ACCOUNTS is non-empty
    // (src/components/auth/login-screen.tsx); both must be healed here.
    const sh = readFileSync(resolve(repoRoot, "scripts", "restore-preview.sh"), "utf-8");
    expect(sh).toMatch(/NEXT_PUBLIC_SEED_DEMO=1/);
    expect(sh).toMatch(/NEXT_PUBLIC_DEMO_ACCOUNTS=demo\@fernly\.app:Admin,manager\@fernly\.app:Manager,member\@fernly\.app:Member/);
    // The heal must be anchored greps (a substring grep on PASSWORD would
    // also match the ACCOUNTS line and silently skip healing it).
    expect(sh).toMatch(/grep -q '\^NEXT_PUBLIC_SEED_DEMO='/);
    expect(sh).toMatch(/grep -q '\^NEXT_PUBLIC_DEMO_ACCOUNTS='/);
    // The seeded demo accounts (scripts/seed.js) and the panel list must
    // stay in sync — all three emails, one per role.
    const seed = readFileSync(resolve(repoRoot, "scripts", "seed.js"), "utf-8");
    for (const email of ["demo@fernly.app", "manager@fernly.app", "member@fernly.app"]) {
      expect(seed).toContain(`"${email}"`);
      expect(sh).toContain(email);
    }
  });

  it("PR-42: the right-to-erasure privacy template exists and its retention numbers match the code", () => {
    // The owner signs off and publishes this notice; if the constants change
    // without the notice following, the published policy silently lies.
    const doc = readFileSync(
      resolve(repoRoot, "docs", "PRIVACY_ERASURE_TEMPLATE.md"),
      "utf-8",
    );
    // Every placeholder must be resolved before publishing — this test only
    // checks they are clearly MARKED (owner fills them in), not that they
    // are gone.
    expect(doc).toMatch(/【/);
    expect(doc).toMatch(/eraseUser/);
    expect(doc).toMatch(/two-step/);
    // Retention numbers pinned to the shipped constants.
    expect(doc).toMatch(new RegExp(`\\*\\*${DEFAULT_AUDIT_RETENTION_DAYS} days?\\*\\* by default`));
    expect(doc).toMatch(new RegExp(`floor \\*\\*${MIN_AUDIT_RETENTION_DAYS} days?\\*\\*`));
    // 90-day notification / read-state windows and the 24h token grace are
    // module-private constants in audit-prune-core.ts — literal tripwires.
    expect(doc).toMatch(/\*\*90 days\*\* after being read/);
    expect(doc).toMatch(/\*\*24 hours\*\* after use/);
    expect(doc).toMatch(/Erased user/);
  });
});

// ---------------------------------------------------------------------------
// PR-36 (production-readiness round 2) — HSTS includeSubDomains / preload
// are env-gated, opt-in, irreversible commitments. The header value must
// compose exactly from HSTS_INCLUDE_SUBDOMAINS / HSTS_PRELOAD, and preload
// must imply includeSubDomains (an invalid preload header would be rejected
// by the preload list).
// ---------------------------------------------------------------------------

describe("PR-36 HSTS env knobs (next.config headers)", () => {
  async function loadConfig() {
    vi.resetModules();
    const mod = await import("../../next.config");
    const cfg = (mod.default ?? mod) as { headers(): Promise<{ headers: { key: string; value: string }[] }[]> };
    const applied = await cfg.headers();
    return applied[0].headers.find((h) => h.key === "Strict-Transport-Security")!.value;
  }

  it("defaults to max-age only (no irreversible commitments by default)", async () => {
    delete process.env.HSTS_INCLUDE_SUBDOMAINS;
    delete process.env.HSTS_PRELOAD;
    expect(await loadConfig()).toBe("max-age=31536000");
  });

  it("HSTS_INCLUDE_SUBDOMAINS=1 adds includeSubDomains", async () => {
    process.env.HSTS_INCLUDE_SUBDOMAINS = "1";
    delete process.env.HSTS_PRELOAD;
    expect(await loadConfig()).toBe("max-age=31536000; includeSubDomains");
  });

  it("HSTS_PRELOAD=1 implies includeSubDomains + preload", async () => {
    delete process.env.HSTS_INCLUDE_SUBDOMAINS;
    process.env.HSTS_PRELOAD = "1";
    expect(await loadConfig()).toBe("max-age=31536000; includeSubDomains; preload");
  });

  it("both knobs compose to the full preload directive", async () => {
    process.env.HSTS_INCLUDE_SUBDOMAINS = "1";
    process.env.HSTS_PRELOAD = "1";
    expect(await loadConfig()).toBe("max-age=31536000; includeSubDomains; preload");
  });

  it("opt-out values (not exactly '1') keep the conservative default", async () => {
    process.env.HSTS_INCLUDE_SUBDOMAINS = "true";
    delete process.env.HSTS_PRELOAD;
    expect(await loadConfig()).toBe("max-age=31536000");
    delete process.env.HSTS_INCLUDE_SUBDOMAINS;
  });
});
