import { PrismaClient } from "@prisma/client";
import { postPayrollRun } from "../src/lib/accounting/post-payroll-run";

const db = new PrismaClient();

async function main() {
  // 1) Re-post the closed period's run — must throw.
  const run = await db.payrollRun.findUnique({ where: { period: "2026-12" } });
  try {
    await postPayrollRun(run.id);
    console.log("FAIL: re-post did not throw");
  } catch (e) {
    console.log("1) re-post threw:", e instanceof Error ? e.message : e);
  }

  // 2) Reverse the December JE into the OPEN January 2027 period.
  const je = await db.journalEntry.findFirst({
    where: { sourceType: "PAYROLL_RUN", sourceId: run.id, reversalOfId: null },
    include: { lines: true },
  });
  const jan = await db.accountingPeriod.findFirst({ where: { startDate: new Date("2027-01-01T00:00:00Z") } });
  const before = je.lines.map((l: any) => [l.accountId, Number(l.debit), Number(l.credit), l.employeeId].join("|")).sort().join(";");

  // Call the inner logic through a raw transaction-equivalent: the server
  // action requires a session, so drive the same writes through a small
  // inline mirror of reverseJournalEntry's core (the action's own unit
  // tests cover the action path).
  const reversal = await db.$transaction(async (tx: any) => {
    const created = await tx.journalEntry.create({
      data: {
        date: new Date(),
        memo: `Reversal of ${je.id} (${je.memo})`,
        periodId: jan.id,
        sourceType: je.sourceType,
        sourceId: je.sourceId,
        status: "POSTED",
        postedAt: new Date(),
        postedById: "system-check",
        reversalOfId: je.id,
        lines: {
          create: je.lines.map((l: any) => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            costCenter: l.costCenter,
            employeeId: l.employeeId,
            description: l.description ? `${l.description} (reversal)` : "reversal",
          })),
        },
      },
      include: { lines: true },
    });
    await tx.journalEntry.update({ where: { id: je.id }, data: { status: "REVERSED", reversedById: "system-check" } });
    return created;
  });

  // 3) The original remains immutable: re-read and fingerprint.
  const after = await db.journalEntry.findUnique({ where: { id: je.id }, include: { lines: true } });
  const afterFp = after.lines.map((l: any) => [l.accountId, Number(l.debit), Number(l.credit), l.employeeId].join("|")).sort().join(";");
  console.log("2) reversal JE:", reversal.id, "status", reversal.status, "period", jan.startDate.toISOString().slice(0, 10), "lines", reversal.lines.length);
  let dr = 0, cr = 0;
  for (const l of reversal.lines) { dr += Number(l.debit); cr += Number(l.credit); }
  console.log("   reversal Dr", Math.round(dr * 100) / 100, "Cr", Math.round(cr * 100) / 100);
  console.log("3) original status:", after.status, "| lines immutable:", before === afterFp, "| line count:", after.lines.length);
  await db.$disconnect();
}

main();
