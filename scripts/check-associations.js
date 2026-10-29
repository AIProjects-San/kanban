/* eslint-disable @typescript-eslint/no-require-imports */
// Sanity check: verify project associations for each demo user
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

async function main() {
  const users = await db.user.findMany();
  for (const u of users) {
    const owned = await db.project.count({ where: { ownerName: u.name } });
    const assigned = await db.project.count({
      where: { tasks: { some: { assignee: { name: u.name } } } },
    });
    console.log(`${u.name} (${u.role}): owns ${owned} projects, assigned-in ${assigned} projects`);
  }
  const auditCount = await db.auditLog.count();
  console.log(`audit entries: ${auditCount}`);
}

main().finally(() => db.$disconnect());
