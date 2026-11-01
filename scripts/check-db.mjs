import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// 1. Bug statuses after the drag
const bugs = await db.bug.groupBy({ by: ["status"], _count: true });
console.log("Bug statuses:", bugs.map(b => `${b.status}:${b._count}`).join(", "));

// 2. Task link just changed
const safariBug = await db.bug.findFirst({ where: { title: { contains: "Safari 17" } }, include: { task: true } });
console.log("Safari bug → task:", safariBug?.task?.title ?? "none", "| status:", safariBug?.status);

// 3. Time entries per task (top 5) + the new E2E entry
const withTime = await db.task.findMany({
  where: { timeEntries: { some: {} } },
  include: { _count: { select: { timeEntries: true } } },
  orderBy: { id: "asc" },
});
console.log("Tasks with time entries:", withTime.length, "| total linked entries:", withTime.reduce((s, t) => s + t._count.timeEntries, 0));
const e2e = await db.timeEntry.findFirst({ where: { description: { contains: "E2E verification" } } });
console.log("New E2E entry:", e2e ? `${e2e.hours}h on ${e2e.taskId} (${e2e.description})` : "NOT FOUND");

// 4. Audit trail for today's new actions
const audits = await db.auditLog.findMany({
  where: { action: { in: ["bug.moved", "bug.linked", "bug.unlinked", "bug.status_changed", "time.logged", "time.deleted", "bug.resolved"] } },
  orderBy: { createdAt: "desc" }, take: 8,
});
console.log("Recent new-type audit entries:");
for (const a of audits) console.log(`  [${a.createdAt.toISOString().slice(11,19)}] ${a.action}: ${a.detail}`);

await db.$disconnect();
