// PGlite replay harness — simulates CI's `prisma migrate deploy` on a fresh
// Postgres by executing every prisma/migrations/*/migration.sql in order
// against an in-memory PGlite (real Postgres 16 compiled to WASM).
//
// Usage: bun run replay.ts
// Exit code 1 on the first failing migration (like migrate deploy does),
// printing the Postgres error message + offending file.
//
// After a successful replay it dumps the resulting schema (tables, columns,
// enums, unique constraints, indexes) to schema-dump.json for the drift diff
// against the local db push-produced SQLite database.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "prisma", "migrations");

async function main() {
  const dirs = readdirSync(MIGRATIONS_DIR)
    .filter((d) => !d.startsWith(".") && d !== "migration_lock.toml")
    .sort();

  const db = new PGlite();
  console.log(`Replaying ${dirs.length} migrations against a fresh PGlite (Postgres 16 WASM)…\n`);

  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
    const t0 = Date.now();
    try {
      await db.exec(sql);
      console.log(`  ok  ${dir} (${Date.now() - t0}ms)`);
    } catch (err) {
      console.error(`\nFAILED at ${dir}/migration.sql:`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // Introspect the resulting schema for the drift diff.
  const tables = await db.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`);
  const columns = await db.query<{
    table_name: string; column_name: string; data_type: string;
    is_nullable: string; column_default: string | null; udt_name: string;
  }>(`
    SELECT table_name, column_name, data_type, is_nullable, column_default, udt_name::text
    FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
  const enums = await db.query<{ enum_name: string; label: string }>(`
    SELECT t.typname AS enum_name, e.enumlabel AS label
    FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder`);
  const uniques = await db.query<{ tablename: string; indexname: string; columns: string }>(`
    SELECT t.relname AS tablename, i.relname AS indexname,
           array_to_string(array_agg(a.attname ORDER BY a.attnum), ',') AS columns
    FROM pg_class i
    JOIN pg_index ix ON ix.indexrelid = i.oid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND ix.indisunique AND i.relkind = 'i'
    GROUP BY t.relname, i.relname ORDER BY t.relname, i.relname`);

  writeFileSync(join(import.meta.dir, "schema-dump.json"), JSON.stringify({
    tables: tables.rows.map((r) => r.table_name),
    columns: columns.rows,
    enums: enums.rows,
    uniques: uniques.rows,
  }, null, 2));
  console.log(`\nReplay OK — ${tables.rows.length} tables. Schema dump written to schema-dump.json`);
}

main();
