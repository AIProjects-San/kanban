// Sync the production _prisma_migrations checksums for the two migrations
// that were converted to no-ops (their changes are covered by the
// re-snapshotted baseline). Without this, `prisma migrate status` reports
// them as "edited" — deploy itself ignores checksums of applied
// migrations, this keeps status output clean.
const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const NAMES = [
  '20261030010000_soft_delete',
  '20261030020000_password_reset_tokens',
];

const p = new PrismaClient();

async function main() {
  for (const name of NAMES) {
    const sum = execSync(`sha256sum prisma/migrations/${name}/migration.sql`)
      .toString()
      .trim()
      .split(/\s+/)[0];
    const r = await p.$executeRawUnsafe(
      'UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2',
      sum,
      name
    );
    console.log(`${name}: checksum -> ${sum} (${r} row updated)`);
  }
  const rows = await p.$queryRawUnsafe(
    'SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name'
  );
  for (const m of rows) console.log(`${m['migration_name']}  ${m['checksum'].slice(0, 16)}...`);
  await p.$disconnect();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
