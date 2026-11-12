// Trial balance on the canonical DB — mirrors getTrialBalance's core query
// (the server action needs a session). Verifies per-period Dr == Cr and the
// reversal semantics across the Dec/Jan boundary.
// Run: bash scripts/run-with-env.sh bun scripts/verify-trial-balance.ts <YYYY-MM-DD period start>
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const LEDGER_STATUSES = ["POSTED", "REVERSED"];
const round2 = (n: number) => Math.round(n * 100) / 100;

async function trialBalance(periodStart: string) {
  const period = await db.accountingPeriod.findFirst({
    where: { startDate: new Date(`${periodStart}T00:00:00.000Z`) },
  });
  if (!period) throw new Error(`no period starting ${periodStart}`);

  const accounts = await db.ledgerAccount.findMany({ orderBy: { code: "asc" } });
  const priorLines = await db.journalEntryLine.findMany({
    where: { journalEntry: { status: { in: LEDGER_STATUSES }, period: { endDate: { lt: period.startDate } } } },
    select: { accountId: true, debit: true, credit: true },
  });
  const periodLines = await db.journalEntryLine.findMany({
    where: { journalEntry: { status: { in: LEDGER_STATUSES }, periodId: period.id } },
    select: { accountId: true, debit: true, credit: true },
  });

  const openingById = new Map<string, number>();
  for (const l of priorLines) openingById.set(l.accountId, (openingById.get(l.accountId) ?? 0) + l.debit.toNumber() - l.credit.toNumber());
  const debitById = new Map<string, number>();
  const creditById = new Map<string, number>();
  for (const l of periodLines) {
    debitById.set(l.accountId, (debitById.get(l.accountId) ?? 0) + l.debit.toNumber());
    creditById.set(l.accountId, (creditById.get(l.accountId) ?? 0) + l.credit.toNumber());
  }

  const rows = accounts
    .map((a) => {
      const opening = round2(openingById.get(a.id) ?? 0);
      const debits = round2(debitById.get(a.id) ?? 0);
      const credits = round2(creditById.get(a.id) ?? 0);
      return { code: a.code, name: a.name, opening, debits, credits, closing: round2(opening + debits - credits) };
    })
    .filter((r) => r.opening !== 0 || r.debits !== 0 || r.credits !== 0);

  const totals = {
    opening: round2(rows.reduce((s, r) => s + r.opening, 0)),
    debits: round2(rows.reduce((s, r) => s + r.debits, 0)),
    credits: round2(rows.reduce((s, r) => s + r.credits, 0)),
    closing: round2(rows.reduce((s, r) => s + r.closing, 0)),
  };
  console.log(`\nTRIAL BALANCE ${period.startDate.toISOString().slice(0, 10)} → ${period.endDate.toISOString().slice(0, 10)} (closed=${period.isClosed})`);
  for (const r of rows) {
    console.log(
      `  ${r.code} ${r.name.padEnd(30)} open ${r.opening.toFixed(2).padStart(10)}  Dr ${r.debits.toFixed(2).padStart(10)}  Cr ${r.credits.toFixed(2).padStart(10)}  close ${r.closing.toFixed(2).padStart(10)}`,
    );
  }
  console.log(`  TOTALS: open ${totals.opening.toFixed(2)}  Dr ${totals.debits.toFixed(2)}  Cr ${totals.credits.toFixed(2)}  close ${totals.closing.toFixed(2)}`);
  const balanced = Math.abs(totals.debits - totals.credits) < 0.005 && Math.abs(totals.opening - totals.closing) < 0.005;
  console.log(`  ${balanced ? "✓ BALANCED (Dr = Cr; opening = closing)" : "✗ OUT OF BALANCE"}`);
  return { rows, totals, balanced };
}

async function main() {
  const dec = await trialBalance("2026-12-01");
  const jan = await trialBalance("2027-01-01");

  // Reversal semantics: December's posting + its January reversal must net
  // to zero — the January CLOSING balances must equal the December OPENING
  // balances (the state as of end of November) for every account.
  const decOpening = new Map(dec.rows.map((r) => [r.code, r.opening]));
  let mismatches = 0;
  for (const r of jan.rows) {
    const expected = decOpening.get(r.code) ?? 0;
    if (Math.abs(expected - r.closing) >= 0.005) {
      mismatches += 1;
      console.log(`  ✗ ${r.code}: Jan closing ${r.closing} != pre-December ${expected} — December not fully negated`);
    }
  }
  // Accounts present in December but entirely absent from January rows also matter.
  for (const [code, opening] of decOpening) {
    if (Math.abs(opening) >= 0.005 && !jan.rows.some((r) => r.code === code)) {
      mismatches += 1;
      console.log(`  ✗ ${code}: missing from January rows but had pre-December balance ${opening}`);
    }
  }
  console.log(
    mismatches === 0
      ? "\nREVERSAL SEMANTICS ✓ — every account's January closing equals its pre-December balance (December payroll fully negated by the reversal)."
      : `\nREVERSAL SEMANTICS ✗ — ${mismatches} account(s) where December survives.`,
  );
  const allOk = dec.balanced && jan.balanced && mismatches === 0;
  console.log(allOk ? "TRIAL BALANCE VERIFICATION: PASS" : "TRIAL BALANCE VERIFICATION: FAIL");
  if (!allOk) process.exitCode = 1;
  await db.$disconnect();
}
main();
