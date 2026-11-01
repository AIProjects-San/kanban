// Check remote _prisma_migrations state
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const rows = await p.$queryRawUnsafe(
    'SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at, applied_steps_count FROM _prisma_migrations ORDER BY migration_name'
  );
  for (const m of rows) {
    console.log(
      `${m.finished ? 'DONE ' : 'PEND '} ${m['migration_name']}  steps=${m['applied_steps_count']} rolledBack=${m['rolled_back_at'] ? 'YES' : 'no'}`
    );
  }
  await p.$disconnect();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
