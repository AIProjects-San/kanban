const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const migrations = await db.$queryRaw`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name`;
  console.log("Recorded migrations in DB:");
  for (const m of migrations) console.log(`  ${m["migration_name"]}`);
  console.log("");
  const cols = await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name='User' ORDER BY ordinal_position`;
  console.log("User columns:", cols.map(c => c["column_name"]).join(", "));
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  console.log("Tables:", tables.map(t => t["tablename"]).join(", "));
  const counts = await db.$queryRaw`
    SELECT (SELECT COUNT(*) FROM "User") AS users,
           (SELECT COUNT(*) FROM "Task") AS tasks,
           (SELECT COUNT(*) FROM "Project") AS projects,
           (SELECT COUNT(*) FROM "PasswordResetToken") AS reset_tokens`;
  console.log("Row counts:", JSON.stringify(counts[0]));
  await db.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
