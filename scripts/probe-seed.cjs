const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const types = await db.leaveType.findMany({ include: { policy: true } });
  console.log("=== LEAVE TYPES ===");
  for (const t of types) console.log(t.name, t.code, "active:", t.active, "policy:", JSON.stringify(t.policy));
  const balances = await db.leaveBalance.findMany();
  console.log("=== BALANCES ===");
  for (const b of balances) console.log(b.userId.slice(0,8), "type:", b.leaveTypeId.slice(0,8), "year:", b.year, "entitled:", b.entitled, "carried:", b.carriedOver, "used:", b.used);
  const users = await db.user.findMany({ where: { deletedAt: null }, select: { id: true, name: true, email: true, role: true, managerId: true } });
  console.log("=== USERS ===");
  for (const u of users) console.log(u.name, u.email, u.role, "manager:", users.find(x=>x.id===u.managerId)?.name ?? "-");
  const reqs = await db.leaveRequest.findMany({ select: { id: true, status: true, days: true, startDate: true, endDate: true } });
  console.log("=== REQUESTS ===", reqs.length);
  for (const r of reqs) console.log(r.status, r.days + "d", r.startDate.toISOString().slice(0,10), "->", r.endDate.toISOString().slice(0,10));
  await db.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
