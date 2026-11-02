const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const rows = await db.leaveRequest.findMany({ where: { reason: { startsWith: "QA " } }, orderBy: { createdAt: "asc" } });
  for (const r of rows) console.log(r.createdAt.toISOString(), r.status, r.days + "d", r.startDate.toISOString().slice(0,10), "->", r.endDate.toISOString().slice(0,10), JSON.stringify(r.reason));
  console.log("count:", rows.length);
  await db.$disconnect();
})();
