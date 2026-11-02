const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const reqs = await db.leaveRequest.findMany({ select: { id: true, status: true, days: true, reason: true, startDate: true, userId: true, leaveTypeId: true } });
  const users = await db.user.findMany({ select: { id: true, name: true, email: true, managerId: true } });
  const types = await db.leaveType.findMany({ select: { id: true, name: true } });
  console.log("=== ALL REQUESTS ===");
  for (const r of reqs) console.log(r.status.padEnd(10), (r.days + "d").padEnd(4), r.startDate.toISOString().slice(0,10), "reason:", JSON.stringify(r.reason), "| owner:", users.find(u=>u.id===r.userId)?.name, "| type:", types.find(t=>t.id===r.leaveTypeId)?.name);
  const cls = await db.onboardingChecklist.findMany({ include: { tasks: true } });
  console.log("=== CHECKLISTS ===");
  for (const c of cls) {
    const hire = users.find(u=>u.id===c.newHireId)?.name;
    console.log(JSON.stringify(c.title), "hire:", hire, "completedAt:", c.completedAt, "tasks:", c.tasks.map(t=>`${t.done?"[x]":"[ ]"}${t.title}(@${users.find(u=>u.id===t.assigneeId)?.name??"unassigned"})`).join(" | "));
  }
  const revs = await db.performanceReview.findMany();
  console.log("=== REVIEWS ===");
  for (const r of revs) console.log(r.status, JSON.stringify(r.title), "subject:", users.find(u=>u.id===r.userId)?.name, "period:", r.periodStart.toISOString().slice(0,10), "->", r.periodEnd.toISOString().slice(0,10));
  await db.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
