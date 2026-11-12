// Retry the GL posting for a locked run (the documented idempotent path
// when the lock-time posting failed and the cause was fixed).
// Run: bash scripts/run-with-env.sh bun scripts/post-run-to-gl.ts <period>
import { PrismaClient } from "@prisma/client";
import { postPayrollRun } from "../src/lib/accounting/post-payroll-run";

const db = new PrismaClient();

async function main() {
  const period = process.argv[2];
  if (!period) throw new Error("usage: post-run-to-gl.ts <period>");
  const run = await db.payrollRun.findUnique({ where: { period } });
  if (!run) throw new Error(`no run ${period}`);
  const je = await postPayrollRun(run.id);
  let dr = 0;
  let cr = 0;
  for (const l of je.lines) {
    dr += l.debit.toNumber();
    cr += l.credit.toNumber();
  }
  console.log(`JE ${je.id} (${je.status}) for ${period}: ${je.lines.length} lines, Dr ${Math.round(dr * 100) / 100} = Cr ${Math.round(cr * 100) / 100}`);
  await db.$disconnect();
}

main();
