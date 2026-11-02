import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const rows = await db.auditLog.findMany({
  where: { action: "auth.signed_out" },
  orderBy: { createdAt: "desc" },
  take: 3,
  select: { action: true, actorName: true, actorRole: true, entityLabel: true, detail: true, createdAt: true },
});
console.log(JSON.stringify(rows, null, 2));
await db.$disconnect();
