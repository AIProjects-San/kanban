import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the behavioral migration test: the backfill half of
// 20261210000000_hr_master_tables, executed for real on PGlite (the
// scripts/pg-replay/replay.ts discipline, in test form). Every migration
// EXCEPT the new one replays first, fixture profiles with the legacy
// string axes are inserted, then the new migration runs — and the masters
// it creates from the distinct strings, and the links it draws, are
// asserted row by row.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
const NEW_MIGRATION = "20261210000000_hr_master_tables";

/** Replay every migration (optionally except the last-listed one) on a
 * fresh in-memory Postgres. */
async function replayAll(except?: string): Promise<PGlite> {
  const dirs = readdirSync(MIGRATIONS_DIR)
    .filter((d) => !d.startsWith(".") && d !== "migration_lock.toml" && d !== except)
    .sort();
  const db = new PGlite();
  for (const dir of dirs) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
  }
  return db;
}

/** A minimal User + EmployeeProfile fixture pair carrying the legacy
 * string axes. */
async function insertProfile(
  db: PGlite,
  id: string,
  department: string,
  jobTitle: string,
  grade: string,
): Promise<void> {
  await db.query(
    `INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'x', NOW(), NOW())`,
    [id, `${id}@example.test`, id],
  );
  await db.query(
    `INSERT INTO "EmployeeProfile" ("id", "userId", "jobTitle", "department", "grade", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
    [`p-${id}`, id, jobTitle, department, grade],
  );
}

describe("P2.1 hr_master_tables — the backfill, executed", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await replayAll(NEW_MIGRATION);
    // The pre-P2.1 world: profiles keyed on the raw strings.
    await insertProfile(db, "u-eng-1", "ENGINEERING", "Backend Engineer", "L4");
    await insertProfile(db, "u-eng-2", "ENGINEERING", "Backend Engineer", "");
    await insertProfile(db, "u-des-1", "DESIGN", "Product Designer", "L5");
    await insertProfile(db, "u-unset", "", "", "");
    // A stray non-enum string (a workspace that wrote past the zod
    // boundary) still gets a master — named by the string itself.
    await insertProfile(db, "u-stray", "People Ops", "People Operations Lead", "L3");
    // Now the migration under test.
    await db.exec(readFileSync(join(MIGRATIONS_DIR, NEW_MIGRATION, "migration.sql"), "utf8"));
  });

  it("creates one department master per distinct non-empty string, with the enum labels and codes", async () => {
    const rows = await db.query<{ name: string; code: string }>(
      `SELECT name, code FROM "Department" ORDER BY name`,
    );
    expect(rows.rows).toEqual([
      { name: "Design", code: "DESIGN" },
      { name: "Engineering", code: "ENGINEERING" },
      { name: "People Ops", code: "People Ops" },
    ]);
  });

  it("creates one designation master per distinct non-empty jobTitle", async () => {
    const rows = await db.query<{ name: string }>(`SELECT name FROM "Designation" ORDER BY name`);
    expect(rows.rows.map((r) => r.name)).toEqual([
      "Backend Engineer",
      "People Operations Lead",
      "Product Designer",
    ]);
  });

  it("creates one grade master per distinct non-empty grade with monotonic placeholder levels", async () => {
    const rows = await db.query<{ name: string; level: number }>(`SELECT name, level FROM "Grade" ORDER BY level`);
    expect(rows.rows.map((r) => r.name)).toEqual(["L3", "L4", "L5"]);
    const levels = rows.rows.map((r) => r.level);
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
  });

  it("links every profile: department by code, designation and grade by name — the unclassified profile stays null", async () => {
    const rows = await db.query<{
      user_id: string; department_id: string | null; designation_id: string | null; grade_id: string | null;
    }>(`
      SELECT ep."userId" AS user_id, ep."departmentId" AS department_id,
             ep."designationId" AS designation_id, ep."gradeId" AS grade_id
      FROM "EmployeeProfile" ep ORDER BY ep."userId"`);
    const byUser = new Map(rows.rows.map((r) => [r.user_id, r]));
    for (const u of ["u-eng-1", "u-eng-2"]) {
      expect(byUser.get(u)?.department_id).not.toBeNull();
      // The shared title resolves to the SAME designation master.
      expect(byUser.get(u)?.designation_id).toBe(byUser.get("u-eng-1")?.designation_id);
    }
    expect(byUser.get("u-eng-1")?.grade_id).not.toBeNull();
    expect(byUser.get("u-eng-2")?.grade_id).toBeNull(); // "" grade = unclassified
    expect(byUser.get("u-des-1")?.department_id).not.toBeNull();
    expect(byUser.get("u-stray")?.department_id).not.toBeNull(); // even the stray string links
    expect(byUser.get("u-unset")?.department_id).toBeNull();
    expect(byUser.get("u-unset")?.designation_id).toBeNull();
    expect(byUser.get("u-unset")?.grade_id).toBeNull();
  });

  it("the backfill half is idempotent: re-running it creates nothing new and re-links nothing", async () => {
    // `prisma migrate deploy` never re-runs an applied migration — the
    // half that must be re-runnable is the BACKFILL (the WHERE NOT
    // EXISTS / IS NULL guards the local twin script relies on).
    const sql = readFileSync(join(MIGRATIONS_DIR, NEW_MIGRATION, "migration.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf("-- Backfill: masters from the distinct non-empty strings."));
    const before = await db.query<{ c: string }>(
      `SELECT (SELECT COUNT(*) FROM "Department") + (SELECT COUNT(*) FROM "Designation") + (SELECT COUNT(*) FROM "Grade") AS c`,
    );
    await db.exec(backfill);
    const after = await db.query<{ c: string }>(
      `SELECT (SELECT COUNT(*) FROM "Department") + (SELECT COUNT(*) FROM "Designation") + (SELECT COUNT(*) FROM "Grade") AS c`,
    );
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  it("the down migration restores the pre-P2.1 shape (columns gone, strings intact)", async () => {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, NEW_MIGRATION, "down.sql"), "utf8"));
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'EmployeeProfile' AND column_name IN ('departmentId', 'designationId', 'gradeId')`,
    );
    expect(cols.rows).toEqual([]);
    const strings = await db.query<{ department: string }>(
      `SELECT "department" FROM "EmployeeProfile" WHERE "userId" = 'u-eng-1'`,
    );
    expect(strings.rows[0].department).toBe("ENGINEERING");
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Department', 'Designation', 'Grade')`,
    );
    expect(tables.rows).toEqual([]);
  });
});
