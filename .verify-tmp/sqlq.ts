// TEMP verification helper (delete after the verification run): run a SQL
// query against the SQLite DB and print rows as JSON.
// Usage: bun .verify-tmp/sqlq.ts "SELECT ..." [db-path]
import { Database } from "bun:sqlite";

const sql = process.argv[2];
const dbPath = process.argv[3] ?? "/home/z/my-project/db/custom.db";
if (!sql) {
  console.error("usage: bun .verify-tmp/sqlq.ts <sql> [db-path]");
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });
try {
  const rows = db.query(sql).all();
  console.log(JSON.stringify(rows, null, 2));
} catch (e) {
  console.error("SQL ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  db.close();
}
