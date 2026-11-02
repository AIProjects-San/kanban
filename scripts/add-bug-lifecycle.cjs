/**
 * Idempotent setup for the Bug life cycle feature.
 *
 * Adds:
 *   1. A `BUG` row to TaskTagConfig (so the tag picker / config page shows it).
 *   2. Eight seeded bug reports (tag=BUG) distributed across the four life-
 *      cycle stages, so the new Bugs board is non-empty.
 *
 * Does NOT wipe any existing data. Safe to re-run — uses upserts and
 * title-matching to skip rows that already exist.
 *
 * Usage:  node scripts/add-bug-lifecycle.cjs
 */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const BUG_TAG_ROW = {
  key: "BUG",
  label: "Bug",
  color: "oklch(0.62 0.22 25)",
  sortOrder: 5,
  isVisible: true,
};

// Same set as scripts/seed.js bugReports — kept in sync so a fresh seed
// and this idempotent updater produce the same eight bugs.
const BUG_REPORTS = [
  { title: "Login button stops responding after 5 failed attempts", status: "TODO",        priority: "HIGH",   projectIdx: 0,  memberIdx: 0 },
  { title: "Avatar uploader crops square images to 4:3 on Safari", status: "TODO",         priority: "MEDIUM", projectIdx: 1,  memberIdx: 1 },
  { title: "Kanban card drag drops on wrong column under fast double-click", status: "IN_PROGRESS", priority: "HIGH", projectIdx: 2, memberIdx: 0 },
  { title: "Calendar event tooltip clipped by sidebar on mobile", status: "IN_PROGRESS",   priority: "LOW",    projectIdx: 4,  memberIdx: 9 },
  { title: "Notifications badge never resets to 0 on Firefox", status: "IN_REVIEW",       priority: "MEDIUM", projectIdx: 18, memberIdx: 9 },
  { title: "Project delete confirm modal traps focus after close", status: "IN_REVIEW",    priority: "MEDIUM", projectIdx: 19, memberIdx: 1 },
  { title: "Time-entry date picker off-by-one across DST boundary", status: "DONE",        priority: "HIGH",   projectIdx: 14, memberIdx: 1 },
  { title: "Settings form silently drops timezone on save", status: "DONE",                priority: "MEDIUM", projectIdx: 1,  memberIdx: 0 },
];

function addDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

(async () => {
  const TODAY = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  console.log("== Bug life cycle setup ==");

  // 1. Upsert BUG TaskTagConfig row
  await db.taskTagConfig.upsert({
    where: { key: "BUG" },
    create: BUG_TAG_ROW,
    update: BUG_TAG_ROW,
  });
  console.log("  ✓ TaskTagConfig BUG row ensured");

  // 2. Find projects + members by index (mirrors the seed order)
  const projects = await db.project.findMany({ orderBy: { createdAt: "asc" }, take: 25 });
  const members = await db.teamMember.findMany({ orderBy: { createdAt: "asc" }, take: 15 });

  if (projects.length < 20 || members.length < 10) {
    console.warn(
      `  ! Expected ≥20 projects and ≥10 members; found ${projects.length} projects, ${members.length} members. Some bugs may be skipped.`
    );
  }

  // 3. Insert each bug report if it doesn't already exist (matched by title)
  let inserted = 0;
  let skipped = 0;
  let order = (await db.task.aggregate({ _max: { order: true } }))._max.order ?? 0;

  for (const bug of BUG_REPORTS) {
    const existing = await db.task.findFirst({ where: { title: bug.title } });
    if (existing) {
      // If it exists but isn't tagged BUG (e.g. an old non-bug task with the same
      // title), upgrade it to a bug so the Bugs board lights up. Otherwise skip.
      if (existing.tag !== "BUG") {
        await db.task.update({ where: { id: existing.id }, data: { tag: "BUG" } });
        console.log(`  ↻ Re-tagged existing task as BUG: "${bug.title}"`);
      } else {
        skipped++;
      }
      continue;
    }

    const project = projects[bug.projectIdx];
    const assignee = members[bug.memberIdx];
    if (!project || !assignee) {
      console.warn(`  ! Skipping "${bug.title}" — missing project or member`);
      continue;
    }

    const dueDate = Math.random() > 0.3 ? addDays(TODAY, Math.floor(Math.random() * 14) - 3) : null;
    await db.task.create({
      data: {
        title: bug.title,
        description: `**Steps to reproduce:**\n1. (see linked project)\n2. ...\n\n**Expected:** behaviour A.\n**Actual:** behaviour B.\n\n**Severity:** ${bug.priority === "HIGH" ? "Critical" : bug.priority === "MEDIUM" ? "Major" : "Minor"}.`,
        status: bug.status,
        priority: bug.priority,
        tag: "BUG",
        dueDate,
        order: ++order,
        projectId: project.id,
        assigneeId: assignee.id,
      },
    });
    inserted++;
  }
  console.log(`  ✓ ${inserted} bug reports inserted, ${skipped} already present`);

  // 4. Recalculate member stats for any member who got a new bug
  for (const m of members) {
    const open = await db.task.count({ where: { assigneeId: m.id, status: { not: "DONE" } } });
    const completed = await db.task.count({ where: { assigneeId: m.id, status: "DONE" } });
    const workload = Math.min(100, Math.round((open / 6) * 100));
    await db.teamMember.update({ where: { id: m.id }, data: { openTasks: open, completedTasks: completed, workload } });
  }
  console.log(`  ✓ Recomputed stats for ${members.length} members`);

  // 5. Sanity-check: count bugs by status
  const counts = await db.task.groupBy({
    by: ["status"],
    where: { tag: "BUG" },
    _count: { _all: true },
  });
  console.log("  ✓ Bug counts by status:", counts.map((c) => `${c.status}=${c._count._all}`).join(", "));

  await db.$disconnect();
  console.log("== Done ==");
})().catch(async (e) => {
  console.error("FATAL:", e);
  await db.$disconnect();
  process.exit(1);
});
