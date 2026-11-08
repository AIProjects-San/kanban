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

// ---------------------------------------------------------------------------
// HR module (docs/HR_MODULE_PLAN.md) — schema-level guards: the four leave
// models exist with their balance invariant (unique user+type+year) and the
// request status column defaults to PENDING.
// ---------------------------------------------------------------------------

describe("HR module leave models are declared", () => {
  it("LeaveRequest defaults to PENDING and indexes status/user/dates", () => {
    const block = modelBlock("LeaveRequest");
    expect(block).toMatch(/status\s+String\s+@default\("PENDING"\)/);
    expect(block).toMatch(/@@index\(\[status\]\)/);
    expect(block).toMatch(/@@index\(\[userId\]\)/);
  });

  it("LeaveBalance enforces one row per user+type+year", () => {
    expect(modelBlock("LeaveBalance")).toMatch(/@@unique\(\[userId,\s*leaveTypeId,\s*year\]\)/);
  });

  it("LeaveType carries a unique code and an active flag", () => {
    const block = modelBlock("LeaveType");
    expect(block).toMatch(/code\s+String\s+@unique/);
    expect(block).toMatch(/active\s+Boolean\s+@default\(true\)/);
  });

  it("LeavePolicy is 1:1 with its leave type", () => {
    expect(modelBlock("LeavePolicy")).toMatch(/leaveTypeId\s+String\s+@unique/);
  });

  it("EmployeeProfile is 1:1 with the user (unique userId) — feature 2", () => {
    const block = modelBlock("EmployeeProfile");
    expect(block).toMatch(/userId\s+String\s+@unique/);
    expect(block).toMatch(/jobTitle\s+String\s+@default\(""\)/);
    expect(block).toMatch(/hireDate\s+DateTime\?/);
  });

  it("the hr_leave migration exists with a down.sql rollback (repo convention)", () => {
    const dir = resolve(repoRoot, "prisma", "migrations", "20261103000000_hr_leave");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
  });
});

describe("S2 (AT-B02/B03) — attendance timing facts + reference day", () => {
  it("AttendanceRecord declares the derived timing columns (nullable = not computable)", () => {
    const block = modelBlock("AttendanceRecord");
    expect(block).toMatch(/lateMinutes\s+Int\?/);
    expect(block).toMatch(/earlyMinutes\s+Int\?/);
    expect(block).toMatch(/workingHours\s+Float\?/);
  });

  it("Workspace declares the reference-day knobs with HH:MM defaults", () => {
    const block = modelBlock("Workspace");
    expect(block).toMatch(/attendanceDayStart\s+String\s+@default\("09:00"\)/);
    expect(block).toMatch(/attendanceDayEnd\s+String\s+@default\("17:30"\)/);
  });

  it("PR-B07 (S4) — Workspace declares the unmarked-day mode knob (default IGNORED)", () => {
    expect(modelBlock("Workspace")).toMatch(/unmarkedAttendanceMode\s+String\s+@default\("IGNORED"\)/);
    const dir = resolve(repoRoot, "prisma", "migrations", "20261126200000_unmarked_attendance_mode");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
    expect(readFileSync(resolve(dir, "migration.sql"), "utf8")).toMatch(
      /ADD COLUMN "unmarkedAttendanceMode" TEXT NOT NULL DEFAULT 'IGNORED'/,
    );
  });

  it("the timing migration exists with a down.sql rollback (repo convention)", () => {
    const dir = resolve(repoRoot, "prisma", "migrations", "20261126100000_attendance_timing");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
    const up = readFileSync(resolve(dir, "migration.sql"), "utf8");
    expect(up).toMatch(/ADD COLUMN "lateMinutes" INTEGER/);
    expect(up).toMatch(/ADD COLUMN "earlyMinutes" INTEGER/);
    expect(up).toMatch(/ADD COLUMN "workingHours" DOUBLE PRECISION/);
    expect(up).toMatch(/ADD COLUMN "attendanceDayStart" TEXT NOT NULL DEFAULT '09:00'/);
    expect(up).toMatch(/ADD COLUMN "attendanceDayEnd" TEXT NOT NULL DEFAULT '17:30'/);
  });
});

// ---------------------------------------------------------------------------
// Recruitment module R1 (docs/RECRUITMENT_MODULE_PLAN.md §2) — the pipeline
// schema contract: unique candidate email, per-candidate stage uniqueness,
// cascade deletion, and the template-edit snapshot guarantee.
// ---------------------------------------------------------------------------

describe("Recruitment R1 models are declared", () => {
  it("Candidate enforces one pipeline record per person (unique email)", () => {
    const block = modelBlock("Candidate");
    expect(block).toMatch(/email\s+String\s+@unique/);
    expect(block).toMatch(/userId\s+String\?/); // set on hire (R6)
  });

  it("CandidateStage is unique per candidate+stageKey and cascades with its candidate", () => {
    const block = modelBlock("CandidateStage");
    expect(block).toMatch(/@@unique\(\[candidateId,\s*stageKey\]\)/);
    expect(block).toMatch(/onDelete:\s*Cascade/);
  });

  it("CandidateStage snapshots the template (label + stageType are plain copies)", () => {
    const block = modelBlock("CandidateStage");
    expect(block).toMatch(/label\s+String\b/);          // copy, no @relation
    expect(block).toMatch(/stageType\s+String\s+@default\("CUSTOM"\)/);
    expect(block).toMatch(/rating\s+Int\?/);            // R2 scorecard slot
  });

  it("HiringStageConfig carries the template vocabulary + active flag", () => {
    const block = modelBlock("HiringStageConfig");
    expect(block).toMatch(/key\s+String\s+@unique/);
    expect(block).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    expect(block).toMatch(/sortOrder\s+Int\s+@default\(0\)/);
  });

  it("indexes the hot hiring query paths (status, ownerUserId, candidateId)", () => {
    const block = modelBlock("CandidateStage");
    expect(block).toMatch(/@@index\(\[candidateId\]\)/);
    expect(block).toMatch(/@@index\(\[ownerUserId\]\)/);
    expect(block).toMatch(/@@index\(\[status\]\)/);
    expect(modelBlock("Candidate")).toMatch(/@@index\(\[status\]\)/);
  });

  it("the hiring_foundation migration exists with a down.sql rollback (repo convention)", () => {
    const dir = resolve(repoRoot, "prisma", "migrations", "20261111000000_hiring_foundation");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
  });

  it("R2: interview scheduling + scorecard columns exist on CandidateStage", () => {
    const block = modelBlock("CandidateStage");
    expect(block).toMatch(/strengths\s+String\s+@default\(""\)/);
    expect(block).toMatch(/concerns\s+String\s+@default\(""\)/);
    expect(block).toMatch(/recommendation\s+String\?/);
    expect(block).toMatch(/eventId\s+String\?/);
    const dir = resolve(repoRoot, "prisma", "migrations", "20261112000000_hiring_interviews");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
  });

  it("R3: MailOutbox stores the audited email lifecycle (QUEUED→SENT/SKIPPED/FAILED)", () => {
    const block = modelBlock("MailOutbox");
    expect(block).toMatch(/kind\s+String\b/);
    expect(block).toMatch(/toAddress\s+String\b/);
    expect(block).toMatch(/subject\s+String\b/);
    expect(block).toMatch(/body\s+String\b/);
    expect(block).toMatch(/status\s+String\s+@default\("QUEUED"\)/);
    expect(block).toMatch(/providerMessageId\s+String\s+@default\(""\)/);
    // Candidate link keeps history on delete (SetNull), never cascades away.
    expect(block).toMatch(/onDelete:\s*SetNull/);
    expect(block).not.toMatch(/onDelete:\s*Cascade/);
    // Hot query paths: newest-first listing, per-candidate history, by status.
    expect(block).toMatch(/@@index\(\[createdAt\]\)/);
    expect(block).toMatch(/@@index\(\[candidateId\]\)/);
    expect(block).toMatch(/@@index\(\[status\]\)/);
    const dir = resolve(repoRoot, "prisma", "migrations", "20261113000000_hiring_mail_outbox");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
  });

  it("R4: document + BGV models declared with snapshot keys and cascades", () => {
    // Template list: unique key drives the checklist references.
    const dt = modelBlock("DocumentTypeConfig");
    expect(dt).toMatch(/key\s+String\s+@unique/);
    expect(dt).toMatch(/isMandatory\s+Boolean\s+@default\(false\)/);
    expect(dt).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    // Per-candidate row: unique (candidateId, docTypeKey); label snapshot.
    const cd = modelBlock("CandidateDocument");
    expect(cd).toMatch(/@@unique\(\[candidateId,\s*docTypeKey\]\)/);
    expect(cd).toMatch(/docTypeKey\s+String\b/);
    expect(cd).toMatch(/label\s+String\b/);
    expect(cd).toMatch(/status\s+String\s+@default\("REQUESTED"\)/);
    expect(cd).toMatch(/onDelete:\s*Cascade/);
    // BGV: vendor + lifecycle status + terminal completedAt.
    const bg = modelBlock("BackgroundCheck");
    expect(bg).toMatch(/vendor\s+String\b/);
    expect(bg).toMatch(/status\s+String\s+@default\("INITIATED"\)/);
    expect(bg).toMatch(/completedAt\s+DateTime\?/);
    expect(bg).toMatch(/onDelete:\s*Cascade/);
    expect(bg).toMatch(/@@index\(\[candidateId\]\)/);
    const dir = resolve(repoRoot, "prisma", "migrations", "20261114000000_hiring_bgv_documents");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
  });

  it("R5: offer templates + records declared (JSON components, snapshot label, R6 token columns)", () => {
    const tpl = modelBlock("OfferTemplate");
    expect(tpl).toMatch(/key\s+String\s+@unique/);
    expect(tpl).toMatch(/components\s+String\s+@default\("\[\]"\)/);
    expect(tpl).toMatch(/benefits\s+String\s+@default\("\[\]"\)/);
    expect(tpl).toMatch(/letterTemplate\s+String\s+@default\(""\)/);

    const rec = modelBlock("OfferRecord");
    expect(rec).toMatch(/candidateId\s+String\b/);
    // Snapshot of the source template label at generation time.
    expect(rec).toMatch(/templateLabel\s+String\s+@default\(""\)/);
    expect(rec).toMatch(/components\s+String\s+@default\("\[\]"\)/);
    expect(rec).toMatch(/status\s+String\s+@default\("DRAFT"\)/);
    // R6 lands with the schema now: single-use token + typed signature.
    // token is NULLABLE (NULL while DRAFT) and UNIQUE — a token can address
    // at most one offer, and uniqueness is enforced at the DB level.
    expect(rec).toMatch(/token\s+String\?\s+@unique/);
    expect(rec).toMatch(/tokenExpiresAt\s+DateTime\?/);
    expect(rec).toMatch(/signedAt\s+DateTime\?/);
    expect(rec).toMatch(/signedName\s+String\s+@default\(""\)/);
    expect(rec).toMatch(/signedIp\s+String\s+@default\(""\)/);
    expect(rec).toMatch(/onDelete:\s*Cascade/);
    const dir = resolve(repoRoot, "prisma", "migrations", "20261115000000_hiring_offers");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
  });

  it("R7: payroll models declared (structures, runs, payslips with LOP + unique slip no)", () => {
    const ss = modelBlock("SalaryStructure");
    expect(ss).toMatch(/userId\s+String\b/);
    expect(ss).toMatch(/components\s+String\s+@default\("\[\]"\)/);
    expect(ss).toMatch(/effectiveFrom\s+DateTime/);
    expect(ss).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    expect(ss).toMatch(/@@index\(\[userId\]\)/);

    const run = modelBlock("PayrollRun");
    expect(run).toMatch(/period\s+String\s+@unique/);
    expect(run).toMatch(/status\s+String\s+@default\("OPEN"\)/);
    expect(run).toMatch(/lockedAt\s+DateTime\?/);
    // F1.1 denormalized denominator; Float since F1.4 (half-day holidays
    // make the count fractional).
    expect(run).toMatch(/workingDays\s+Float\s+@default\(0\)/);

    const slip = modelBlock("Payslip");
    expect(slip).toMatch(/runId\s+String\b/);
    expect(slip).toMatch(/slipNo\s+String\s+@unique/);
    expect(slip).toMatch(/earnings\s+String\s+@default\("\[\]"\)/);
    expect(slip).toMatch(/deductions\s+String\s+@default\("\[\]"\)/);
    // F1.4 — Float (HALF_DAY charges 0.5) + the AUTO/MANUAL provenance flag.
    expect(slip).toMatch(/lopDays\s+Float\s+@default\(0\)/);
    expect(slip).toMatch(/lopSource\s+String\s+@default\("AUTO"\)/);
    // F-R2 (S1) — optimistic-lock version: updatePayslip refuses a save whose
    // expectedVersion doesn't match; incremented on every successful edit.
    expect(slip).toMatch(/version\s+Int\s+@default\(0\)/);
    expect(slip).toMatch(/gross\s+Float\s+@default\(0\)/);
    expect(slip).toMatch(/net\s+Float\s+@default\(0\)/);
    expect(slip).toMatch(/@@unique\(\[runId,\s*userId\]\)/);
    expect(slip).toMatch(/onDelete:\s*Cascade/);
    const dir = resolve(repoRoot, "prisma", "migrations", "20261117000000_hiring_payroll");
    expect(existsSync(resolve(dir, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(dir, "down.sql"))).toBe(true);
    // PR-B06 (S5) — the employment-window day snapshot; nullable = pre-S5.
    expect(slip).toMatch(/paidDays\s+Float\?/);
    const s5 = resolve(repoRoot, "prisma", "migrations", "20261126300000_payment_day_clipping");
    expect(existsSync(resolve(s5, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(s5, "down.sql"))).toBe(true);
    expect(readFileSync(resolve(s5, "migration.sql"), "utf8")).toMatch(/ADD COLUMN "paidDays" DOUBLE PRECISION/);
    // F-R2 (S1) — the optimistic-lock migration is committed with its down
    // path; additive, every stored slip reads as version 0.
    const s1 = resolve(repoRoot, "prisma", "migrations", "20261126000000_payslip_optimistic_lock");
    expect(existsSync(resolve(s1, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(s1, "down.sql"))).toBe(true);
    const s1up = readFileSync(resolve(s1, "migration.sql"), "utf8");
    expect(s1up).toMatch(/ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0/);
    // F1.4 — the attendance→LOP derivation migration (provenance column +
    // Int→Float widenings) is committed with its down path. Clause-level
    // assertions: Prisma emits multi-clause ALTER TABLE statements (SET
    // DEFAULT + SET DATA TYPE), so the type changes ride continuation lines.
    const f14 = resolve(repoRoot, "prisma", "migrations", "20261119000000_attendance_lop_derivation");
    expect(existsSync(resolve(f14, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(f14, "down.sql"))).toBe(true);
    const f14up = readFileSync(resolve(f14, "migration.sql"), "utf8");
    expect(f14up).toMatch(/ADD COLUMN\s+"lopSource" TEXT NOT NULL DEFAULT 'AUTO'/);
    expect(f14up).toMatch(/ALTER COLUMN "lopDays" SET DEFAULT 0/);
    expect(f14up).toMatch(/ALTER COLUMN "lopDays" SET DATA TYPE DOUBLE PRECISION/);
    expect(f14up).toMatch(/ALTER COLUMN "workingDays" SET DEFAULT 0/);
    expect(f14up).toMatch(/ALTER COLUMN "workingDays" SET DATA TYPE DOUBLE PRECISION/);

    // F1.5 — the salary component catalog: master data for the structure
    // editor's picker. Snapshot discipline: structures keep their JSON
    // copies, so the migration is a new table + deterministic backfill from
    // the JSON sources (templates first, then structures, then offers).
    const comp = modelBlock("SalaryComponent");
    expect(comp).toMatch(/code\s+String\s+@unique/);
    expect(comp).toMatch(/kind\s+String\s+@default\("EARNING"\)/);
    expect(comp).toMatch(/mode\s+String\s+@default\("FIXED"\)/);
    expect(comp).toMatch(/defaultAmount\s+Float\s+@default\(0\)/);
    expect(comp).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    expect(comp).toMatch(/@@index\(\[isActive\]\)/);
    const f15 = resolve(repoRoot, "prisma", "migrations", "20261121000000_salary_component_catalog");
    expect(existsSync(resolve(f15, "migration.sql"))).toBe(true);
    expect(existsSync(resolve(f15, "down.sql"))).toBe(true);
    const f15up = readFileSync(resolve(f15, "migration.sql"), "utf8");
    expect(f15up).toMatch(/CREATE TABLE "SalaryComponent"/);
    expect(f15up).toMatch(/CREATE UNIQUE INDEX "SalaryComponent_code_key"/);
    // The deterministic backfill: 'bf-cat-<code>' ids from the three JSON
    // sources, DISTINCT ON dedup per source (codes repeat across templates
    // and structures — a bare NOT EXISTS cannot see same-statement rows),
    // first sighting wins across sources.
    expect(f15up).toMatch(/'bf-cat-' \|\| d\."code"/);
    expect(f15up).toMatch(/DISTINCT ON \(elem->>'key'\)/);
    expect(f15up).toMatch(/FROM "OfferTemplate"/);
    expect(f15up).toMatch(/FROM "SalaryStructure"/);
    expect(f15up).toMatch(/FROM "OfferRecord"/);
    expect(f15up).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM "SalaryComponent"/);
  });
});
