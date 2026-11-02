// L-P1-17 + L-P1-24 + L-P1-22/25/26 + L-P1-21 — config + deploy + runbook
// contract tests (bundle budget script, eslint rules, Dockerfile/compose/
// nginx, ops runbooks). Disk inspection is deterministic.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
      "DATABASE_URL", "NEXTAUTH_SECRET", "NEXTAUTH_URL", "SERVER_ACTIONS_ALLOWED_ORIGINS",
      "REDIS_URL", "CRON_SECRET", "RESEND_API_KEY", "MAIL_FROM", "SENTRY_DSN",
    ]) {
      expect(env).toMatch(new RegExp(`^${key}=`, "m"));
    }
    expect(env).toMatch(/REFUSES to boot/);
  });
});
