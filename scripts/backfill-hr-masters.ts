// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — one-off backfill, the SQLite twin of
// prisma/migrations/20261210000000_hr_master_tables/migration.sql.
//
// The canonical migration carries the data backfill in Postgres SQL for
// CI's `migrate deploy` / PGlite replay; the sandbox applies schema with
// `db push` (ADR-008), which never runs migration SQL — so this script
// performs the identical master-creation + linking through Prisma on
// whatever DB the DATABASE_URL points at (the backfill-salary-assignments
// discipline).
//
//   • Department masters from the distinct non-empty profile.department
//     strings — name = the DEPARTMENT_LABELS label, code = the enum key.
//   • Designation masters from distinct jobTitle strings (named by the
//     string itself).
//   • Grade masters from distinct grade strings (level = a deterministic
//     alphabetical placeholder; HR reorders in the masters UI).
//   • Link every profile row (department by code, designation/grade by
//     name) and the transfer/promotion documents' from/to snapshots.
//
// Idempotent: existing masters are matched (never duplicated), and only
// NULL links are filled — re-running after new hires simply picks up the
// newcomers.
//
// Run: bash scripts/run-with-env.sh bun scripts/backfill-hr-masters.ts
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { DEPARTMENT_LABELS } from "../src/lib/shared/config";

const db = new PrismaClient();

const LABEL_BY_KEY = new Map(DEPARTMENT_LABELS.map((d) => [d.key, d.label]));

/** Slugify a master name into the deterministic backfill id (never
 * collides with the cuid()s the UI creates). */
function backfillId(prefix: string, name: string): string {
  return `${prefix}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(0, 60);
}

async function main(): Promise<void> {
  console.log("📋 P2.1 backfill — HR masters (Department / Designation / Grade)…");

  // ---- Departments -------------------------------------------------------
  const deptStrings = await db.employeeProfile.findMany({
    where: { department: { not: "" } },
    select: { department: true },
    distinct: ["department"],
  });
  let deptCreated = 0;
  for (const { department } of deptStrings) {
    const label = LABEL_BY_KEY.get(department as never) ?? department;
    const existing = await db.department.findFirst({
      where: { OR: [{ code: department }, { name: label }] },
      select: { id: true },
    });
    if (existing) continue;
    await db.department.create({
      data: { id: backfillId("dept", department), name: label, code: department },
    });
    deptCreated++;
  }

  // ---- Designations ------------------------------------------------------
  const titleStrings = await db.employeeProfile.findMany({
    where: { jobTitle: { not: "" } },
    select: { jobTitle: true },
    distinct: ["jobTitle"],
  });
  let desigCreated = 0;
  for (const { jobTitle } of titleStrings) {
    const existing = await db.designation.findUnique({ where: { name: jobTitle }, select: { id: true } });
    if (existing) continue;
    await db.designation.create({
      data: { id: backfillId("desig", jobTitle), name: jobTitle },
    });
    desigCreated++;
  }

  // ---- Grades -------------------------------------------------------------
  const gradeStrings = await db.employeeProfile.findMany({
    where: { grade: { not: "" } },
    select: { grade: true },
    distinct: ["grade"],
  });
  const gradesByName = new Map<string, string>();
  let gradeCreated = 0;
  for (const { grade } of [...gradeStrings].sort((a, b) => a.grade.localeCompare(b.grade))) {
    const existing = await db.grade.findUnique({ where: { name: grade }, select: { id: true } });
    if (existing) {
      gradesByName.set(grade, existing.id);
      continue;
    }
    const created = await db.grade.create({
      data: {
        id: backfillId("grade", grade),
        name: grade,
        level: gradesByName.size + gradeCreated + 1,
      },
    });
    gradesByName.set(grade, created.id);
    gradeCreated++;
  }

  // ---- Link the profiles --------------------------------------------------
  const profiles = await db.employeeProfile.findMany({
    select: { id: true, department: true, jobTitle: true, grade: true, departmentId: true, designationId: true, gradeId: true },
    take: 5_000,
  });
  let linked = 0;
  for (const p of profiles) {
    const patch: { departmentId?: string; designationId?: string; gradeId?: string } = {};
    if (!p.departmentId && p.department) {
      const d = await db.department.findFirst({ where: { OR: [{ code: p.department }, { name: p.department }] }, select: { id: true } });
      if (d) patch.departmentId = d.id;
    }
    if (!p.designationId && p.jobTitle) {
      const d = await db.designation.findUnique({ where: { name: p.jobTitle }, select: { id: true } });
      if (d) patch.designationId = d.id;
    }
    if (!p.gradeId && p.grade) {
      const g = await db.grade.findUnique({ where: { name: p.grade }, select: { id: true } });
      if (g) patch.gradeId = g.id;
    }
    if (Object.keys(patch).length > 0) {
      await db.employeeProfile.update({ where: { id: p.id }, data: patch });
      linked++;
    }
  }

  // ---- Link the documents -------------------------------------------------
  let docsLinked = 0;
  const transfers = await db.employeeTransfer.findMany({
    select: { id: true, fromDepartment: true, toDepartment: true, fromDepartmentId: true, toDepartmentId: true },
    take: 5_000,
  });
  for (const t of transfers) {
    const patch: { fromDepartmentId?: string; toDepartmentId?: string } = {};
    if (!t.fromDepartmentId && t.fromDepartment) {
      const d = await db.department.findFirst({ where: { OR: [{ code: t.fromDepartment }, { name: t.fromDepartment }] }, select: { id: true } });
      if (d) patch.fromDepartmentId = d.id;
    }
    if (!t.toDepartmentId && t.toDepartment) {
      const d = await db.department.findFirst({ where: { OR: [{ code: t.toDepartment }, { name: t.toDepartment }] }, select: { id: true } });
      if (d) patch.toDepartmentId = d.id;
    }
    if (Object.keys(patch).length > 0) {
      await db.employeeTransfer.update({ where: { id: t.id }, data: patch });
      docsLinked++;
    }
  }
  const promotions = await db.employeePromotion.findMany({
    select: { id: true, fromJobTitle: true, toJobTitle: true, fromDesignationId: true, toDesignationId: true },
    take: 5_000,
  });
  for (const p of promotions) {
    const patch: { fromDesignationId?: string; toDesignationId?: string } = {};
    if (!p.fromDesignationId && p.fromJobTitle) {
      const d = await db.designation.findUnique({ where: { name: p.fromJobTitle }, select: { id: true } });
      if (d) patch.fromDesignationId = d.id;
    }
    if (!p.toDesignationId && p.toJobTitle) {
      const d = await db.designation.findUnique({ where: { name: p.toJobTitle }, select: { id: true } });
      if (d) patch.toDesignationId = d.id;
    }
    if (Object.keys(patch).length > 0) {
      await db.employeePromotion.update({ where: { id: p.id }, data: patch });
      docsLinked++;
    }
  }

  console.log(
    `  ✓ masters: ${deptCreated} department(s), ${desigCreated} designation(s), ${gradeCreated} grade(s) created` +
      ` (existing masters matched, never duplicated)`
  );
  console.log(`  ✓ ${linked} profile(s) linked, ${docsLinked} transfer/promotion document(s) linked`);
  console.log("Done: HR masters backfill complete (idempotent — re-run picks up newcomers).");
}

main()
  .catch((e) => {
    console.error("HR masters backfill failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
