/**
 * Board-enhancement backfill — populates the new columns added by the
 * 20261102010000_task_time_bug_board migration with sensible demo data:
 *
 *   1. Bug.boardOrder     — stable per-status ordering for the bug board.
 *   2. Task.estimateMinutes — deterministic pseudo-random estimates (2–16h
 *                            in 30-minute increments) for tasks that don't
 *                            have one yet.
 *   3. TimeEntry.taskId   — attaches previously unlinked entries to tasks
 *                            with the same project AND the same assignee
 *                            (memberId === task.assigneeId), up to 2 per
 *                            task, so the task time log shows spent hours.
 *   4. Bug.taskId         — links a few bugs to tasks in the same project
 *                            so the Task ↔ Bug relation is visible.
 *
 * Idempotent: safe to re-run; it only fills gaps.
 * Run:  SEED_DEMO=1 bash scripts/run-with-env.sh node scripts/backfill-board-enhancements.js
 */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

// Small deterministic PRNG so re-runs produce the same numbers.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  // ---------------------------------------------------------------------
  // 1. Bug.boardOrder — number bugs within each status by createdAt.
  // ---------------------------------------------------------------------
  const bugs = await db.bug.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true },
  });
  const perStatus = new Map();
  for (const bug of bugs) {
    const next = (perStatus.get(bug.status) ?? -1) + 1;
    perStatus.set(bug.status, next);
    await db.bug.update({ where: { id: bug.id }, data: { boardOrder: next } });
  }
  console.log(`boardOrder set for ${bugs.length} bugs`);

  // ---------------------------------------------------------------------
  // 2. Task.estimateMinutes — deterministic estimates in 30-min steps.
  // ---------------------------------------------------------------------
  const tasks = await db.task.findMany({
    select: { id: true, estimateMinutes: true },
    orderBy: { createdAt: "asc" },
  });
  const rand = mulberry32(20261102);
  let estimatesSet = 0;
  for (const task of tasks) {
    if (task.estimateMinutes > 0) continue; // already has an estimate
    const hours = 2 + Math.floor(rand() * 15); // 2..16 hours
    const minutes = hours * 60 + (rand() < 0.4 ? 30 : 0);
    await db.task.update({ where: { id: task.id }, data: { estimateMinutes: minutes } });
    estimatesSet++;
  }
  console.log(`estimateMinutes set on ${estimatesSet} tasks`);

  // ---------------------------------------------------------------------
  // 3. TimeEntry.taskId — attach unlinked entries to matching tasks
  //    (same project + same assignee), max 2 per task.
  // ---------------------------------------------------------------------
  const assignees = await db.task.findMany({
    where: { assigneeId: { not: null }, projectId: { not: null } },
    select: { id: true, assigneeId: true, projectId: true },
  });
  const openTasks = new Map(); // key: `${projectId}:${assigneeId}` → [taskIds]
  for (const t of assignees) {
    const key = `${t.projectId}:${t.assigneeId}`;
    if (!openTasks.has(key)) openTasks.set(key, []);
    openTasks.get(key).push(t.id);
  }
  const entries = await db.timeEntry.findMany({
    where: { taskId: null, memberId: { not: null }, projectId: { not: null } },
    orderBy: { date: "asc" },
    select: { id: true, memberId: true, projectId: true },
  });
  const perTask = new Map();
  let attached = 0;
  for (const e of entries) {
    const key = `${e.projectId}:${e.memberId}`;
    const candidates = openTasks.get(key);
    if (!candidates) continue;
    // Pick the candidate with the fewest entries so far (max 2 each).
    let best = null;
    let bestCount = 3;
    for (const taskId of candidates) {
      const c = perTask.get(taskId) ?? 0;
      if (c < bestCount) { bestCount = c; best = taskId; }
    }
    if (!best) continue;
    perTask.set(best, bestCount + 1);
    await db.timeEntry.update({ where: { id: e.id }, data: { taskId: best } });
    attached++;
  }
  console.log(`taskId attached to ${attached} time entries`);

  // ---------------------------------------------------------------------
  // 4. Bug.taskId — link unlinked bugs to a task in the same project.
  // ---------------------------------------------------------------------
  const unlinkedBugs = await db.bug.findMany({
    where: { taskId: null, projectId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, projectId: true },
  });
  let linked = 0;
  for (const bug of unlinkedBugs.slice(0, 4)) {
    const task = await db.task.findFirst({
      where: { projectId: bug.projectId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!task) continue;
    await db.bug.update({ where: { id: bug.id }, data: { taskId: task.id } });
    linked++;
  }
  console.log(`${linked} bugs linked to tasks`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => db.$disconnect());
