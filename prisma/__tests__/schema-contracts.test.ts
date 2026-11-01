// L-P0-5 + L-P0-6 + L-P0-14 — schema-level regression tests (indexes,
// migrations adopted, soft-delete declarations). Disk inspection is
// deterministic and doesn't need a DB connection.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const schema = readFileSync(resolve(__dirname, "../schema.prisma"), "utf-8");

function modelBlock(name: string): string {
  const re = new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)^\\}`, "m");
  const match = schema.match(re);
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

// ---------------------------------------------------------------------------
// L-P0-5 — secondary indexes.
// ---------------------------------------------------------------------------

describe("L-P0-5 secondary indexes declared in prisma/schema.prisma", () => {
  describe("Task", () => {
    const task = modelBlock("Task");
    it("indexes projectId", () => expect(task).toMatch(/@@index\(\[projectId\]\)/));
    it("indexes assigneeId", () => expect(task).toMatch(/@@index\(\[assigneeId\]\)/));
    it("indexes status", () => expect(task).toMatch(/@@index\(\[status\]\)/));
  });
  describe("TimeEntry", () => {
    const te = modelBlock("TimeEntry");
    it("indexes memberId", () => expect(te).toMatch(/@@index\(\[memberId\]\)/));
    it("indexes projectId", () => expect(te).toMatch(/@@index\(\[projectId\]\)/));
    it("indexes date", () => expect(te).toMatch(/@@index\(\[date\]\)/));
  });
  describe("Project", () => {
    const project = modelBlock("Project");
    it("indexes ownerUserId", () => expect(project).toMatch(/@@index\(\[ownerUserId\]\)/));
    it("indexes status", () => expect(project).toMatch(/@@index\(\[status\]\)/));
  });
});

// ---------------------------------------------------------------------------
// L-P0-6 — Prisma migrations adopted, --accept-data-loss removed.
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, "../..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));

describe("L-P0-6 Prisma migrations adopted", () => {
  it("has a prisma/migrations/ directory with at least one migration", () => {
    const migrationsDir = resolve(repoRoot, "prisma", "migrations");
    expect(existsSync(migrationsDir)).toBe(true);
    const migrationDirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(migrationDirs.length).toBeGreaterThan(0);
    for (const dir of migrationDirs) {
      expect(existsSync(resolve(migrationsDir, dir.name, "migration.sql"))).toBe(true);
    }
  });

  it("has a baseline migration recorded", () => {
    const entries = readdirSync(resolve(repoRoot, "prisma", "migrations"));
    expect(entries.some((name) => name.toLowerCase().includes("baseline"))).toBe(true);
  });

  it("no db:* script passes --accept-data-loss", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    for (const [name, script] of Object.entries(scripts)) {
      if (name.startsWith("db:")) {
        expect(script, `db script ${name} must not pass --accept-data-loss`).not.toMatch(/--accept-data-loss/);
      }
    }
  });

  it("has a db:deploy script that uses `migrate deploy` (production-safe)", () => {
    expect(packageJson.scripts["db:deploy"]).toMatch(/migrate deploy/);
  });

  it("has a db:status script for checking migration state", () => {
    expect(packageJson.scripts["db:status"]).toMatch(/migrate status/);
  });
});

// ---------------------------------------------------------------------------
// L-P0-14 — soft-delete schema declarations + delete actions use update.
// ---------------------------------------------------------------------------

describe("L-P0-14 soft-delete schema declarations", () => {
  it("User has a nullable deletedAt column", () => expect(modelBlock("User")).toMatch(/deletedAt\s+DateTime\?/));
  it("Project has a nullable deletedAt column", () => expect(modelBlock("Project")).toMatch(/deletedAt\s+DateTime\?/));
  it("Message has a nullable deletedAt column", () => expect(modelBlock("Message")).toMatch(/deletedAt\s+DateTime\?/));
  it("TeamMember has a nullable deletedAt column", () => expect(modelBlock("TeamMember")).toMatch(/deletedAt\s+DateTime\?/));
});

describe("L-P0-14 delete actions use soft-delete (update, not delete)", () => {
  const projectsSrc = readFileSync(resolve(__dirname, "../../src/server-actions/projects.ts"), "utf-8");
  const usersSrc = readFileSync(resolve(__dirname, "../../src/server-actions/users.ts"), "utf-8");
  const messagesSrc = readFileSync(resolve(__dirname, "../../src/server-actions/messages.ts"), "utf-8");

  it("deleteProject calls db.project.update with deletedAt (not db.project.delete)", () => {
    expect(projectsSrc).toMatch(/db\.project\.update\(\{\s*where:\s*\{\s*id\s*\},\s*data:\s*\{\s*deletedAt:\s*new Date\(\)\s*\}/);
    expect(projectsSrc.match(/db\.project\.delete\(/)).toBeNull();
  });

  it("deleteUser calls db.user.update with deletedAt (not db.user.delete)", () => {
    expect(usersSrc).toMatch(/db\.user\.update\(\{\s*where:\s*\{\s*id:\s*userId\s*\},\s*data:\s*\{\s*deletedAt:\s*now\s*\}/);
    expect(usersSrc.match(/db\.user\.delete\(/)).toBeNull();
  });

  it("deleteUser also soft-deletes the matching TeamMember row", () => {
    expect(usersSrc).toMatch(/db\.teamMember\.updateMany\(/);
  });

  it("deleteMessage calls db.message.update with deletedAt (not db.message.delete)", () => {
    expect(messagesSrc).toMatch(/db\.message\.update\(\{\s*where:\s*\{\s*id\s*\},\s*data:\s*\{\s*deletedAt:\s*new Date\(\)\s*\}/);
    expect(messagesSrc.match(/db\.message\.delete\(/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ADR-008 — committed datasource provider stays postgresql; the SQLite
// sandbox preview runs through a GENERATED, gitignored variant schema.
// Commit 76e2e51 leaked the local provider="sqlite" override into the repo
// and every CI run since failed the e2e job's `migrate deploy` step with
// Prisma P1012 (provider/URL protocol mismatch). These guards fail fast in
// the verify job instead of 10 minutes later in e2e.
// ---------------------------------------------------------------------------

function datasourceBlock(): string {
  const match = schema.match(/datasource db \{([\s\S]*?)^\}/m);
  if (!match) throw new Error("datasource db block not found in schema.prisma");
  return match[1];
}

describe("ADR-008 canonical prisma provider is postgresql", () => {
  it("datasource db declares provider postgresql (CI/compose/Supabase target)", () => {
    expect(datasourceBlock()).toMatch(/provider\s*=\s*"postgresql"/);
  });

  it("datasource db reads the url from env(DATABASE_URL)", () => {
    expect(datasourceBlock()).toMatch(/url\s*=\s*env\("DATABASE_URL"\)/);
  });

  it("run-with-env.sh swaps in a generated variant instead of editing the committed schema", () => {
    const wrapper = readFileSync(resolve(repoRoot, "scripts", "run-with-env.sh"), "utf-8");
    expect(wrapper).toMatch(/schema\.local\.prisma/);
    // the committed schema must never be rewritten in place
    expect(wrapper).not.toMatch(/\bsed\b[^#]*schema\.prisma/);
  });

  it("the generated variant schema is gitignored", () => {
    const gitignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf-8");
    expect(gitignore).toMatch(/prisma\/schema\.local\.prisma/);
  });
});
