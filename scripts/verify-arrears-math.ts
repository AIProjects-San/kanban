// Cross-check the arrears math inputs: run.workingDays, holiday calendar,
// and who the weekly run pays.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function main() {
  const runs = await db.payrollRun.findMany({
    where: { period: { in: ["2026-10", "2026-11", "2026-12", "2026-W45"] } },
    select: { period: true, workingDays: true, frequency: true },
  });
  console.log("RUNS:", runs.map((r) => `${r.period} freq=${r.frequency} workingDays=${r.workingDays}`).join(" | "));

  const hol = await db.holidayCalendarEntry.findMany({
    where: { date: { gte: new Date("2026-10-01T00:00:00Z"), lte: new Date("2026-12-31T00:00:00Z") } },
    orderBy: { date: "asc" },
    select: { date: true, label: true, kind: true, isHalfDay: true },
  });
  console.log("HOLIDAYS Oct-Dec 2026:");
  for (const h of hol) console.log(`  ${h.date.toISOString().slice(0, 10)} ${h.label} kind=${h.kind} half=${h.isHalfDay}`);

  const yuki = await db.user.findUnique({ where: { email: "yuki@fernly.app" } });
  const w45 = await db.payrollRun.findUnique({ where: { period: "2026-W45" }, select: { id: true } });
  const slips = await db.payslip.findMany({ where: { runId: w45.id }, select: { userId: true } });
  const users = await db.user.findMany({ select: { id: true, email: true } });
  const byId = new Map(users.map((u) => [u.id, u.email]));
  console.log("W45 payslips for:", slips.map((s) => byId.get(s.userId)).join(", "), "| yuki in W45:", slips.some((s) => s.userId === yuki.id));
  await db.$disconnect();
}
main();
