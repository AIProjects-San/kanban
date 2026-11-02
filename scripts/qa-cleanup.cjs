// QA helper — remove leave requests created by failed QA-hardening e2e runs
// (reason prefix "QA "), restoring any balance they debited. Seed data and
// other e2e artifacts are never touched.
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const rows = await db.leaveRequest.findMany({ where: { reason: { startsWith: "QA " } } });
  for (const r of rows) {
    console.log("removing:", r.status, r.reason, `(${r.days}d)`);
    if (r.status === "APPROVED") {
      const year = r.startDate.getUTCFullYear();
      const bal = await db.leaveBalance.findUnique({
        where: { userId_leaveTypeId_year: { userId: r.userId, leaveTypeId: r.leaveTypeId, year } },
      });
      if (bal) {
        await db.leaveBalance.update({
          where: { userId_leaveTypeId_year: { userId: r.userId, leaveTypeId: r.leaveTypeId, year } },
          data: { used: { decrement: Math.min(r.days, bal.used) } },
        });
        console.log("  restored", Math.min(r.days, bal.used), "days");
      }
    }
    await db.leaveRequest.delete({ where: { id: r.id } });
  }
  const theo = await db.user.findUnique({ where: { email: "member@fernly.app" }, select: { id: true } });
  const annual = await db.leaveType.findUnique({ where: { code: "ANNUAL" }, select: { id: true } });
  const bal = await db.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId: theo.id, leaveTypeId: annual.id, year: new Date().getUTCFullYear() } },
  });
  console.log("Theo Annual balance now: entitled", bal.entitled, "used", bal.used, "available", bal.entitled + bal.carriedOver - bal.used);
  await db.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
