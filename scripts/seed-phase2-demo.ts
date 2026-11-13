// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — demo data seeding for the DEV database.
//
// The base seed's runs predate the statutory engine (no frozen snapshots
// on their payslips), so they correctly REFUSE to file. This script adds
// one engine-priced, LOCKED, GL-posted month (2026-09) plus the employer
// filing profile, so the payday-filing UI has real data to walk through:
// generate → download → mark filed → accepted, ED notifications, and the
// filings list.
//
// Idempotent: skips any step whose artefact already exists.
//
// Usage: bash scripts/run-with-env.sh npx tsx scripts/seed-phase2-demo.ts
// ---------------------------------------------------------------------------

import { db } from "../src/lib/infra/db";
import { resolveNzRateSet, calculateNzStatutoryWithSet, toNzTaxProfile, type NzTaxProfileRow } from "../src/lib/payroll/nz/calculate";
import { serializeStatutorySnapshot, statutoryDeductionLines } from "../src/lib/payroll/nz/slip-statutory";
import type { PayslipStatutoryT } from "../src/lib/types";
import { postPayrollRun } from "../src/lib/accounting/post-payroll-run";
import type { OfferComponent } from "../src/lib/hiring/offer-math";

const PERIOD = "2026-09";
const WINDOW_START = new Date("2026-09-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-30T00:00:00.000Z");

async function main() {
  // ---- Employer filing profile ---------------------------------------------
  const settings = await db.payrollSettings.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      employerIrdNumber: "49091850", // IRD spec 5.8 example 1 — valid + in range
      employerName: "Fernly Demo Ltd",
      payrollContactName: "Bill Smith",
      payrollContactPhone: "041234567",
      payrollContactEmail: "payroll@email.com",
      payrollPackageIdentifier: "Fernly v1.0",
      irFormVersionNumber: "0001",
    },
  });
  console.log(`  ✓ employer filing profile (IRD …${settings.employerIrdNumber.slice(-4)}, contact ${settings.payrollContactName})`);

  // ---- The priced September run ---------------------------------------------
  const existing = await db.payrollRun.findUnique({ where: { period: PERIOD } });
  if (existing) {
    console.log(`  ✓ run ${PERIOD} already exists — nothing to do`);
    return;
  }

  const rateSet = await resolveNzRateSet(WINDOW_START);
  if (!rateSet) throw new Error("No seeded statutory rate set — run `npm run db:seed:statutory` first.");

  const structures = await db.salaryStructure.findMany({ where: { isActive: true, frequency: "MONTHLY" } });
  const profiles = await db.employeeTaxProfile.findMany();
  const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

  // A structure holder without a tax profile cannot be filed — record the
  // IR330 (the employer's real-world step).
  for (const s of structures) {
    if (profileByUser.has(s.userId)) continue;
    const created = await db.employeeTaxProfile.create({
      data: {
        userId: s.userId,
        irdNumber: "49091869",
        taxCode: "M",
        kiwiSaverStatus: "ACTIVE",
        employmentType: "PERMANENT",
        employmentStartDate: new Date("2024-08-19T00:00:00.000Z"),
        notes: "Phase 2 demo: IR330 recorded (mod-11 valid demo IRD).",
      },
    });
    profileByUser.set(s.userId, created);
    console.log(`  ✓ recorded IR330 for a structure holder without a tax profile (${s.userId.slice(-6)})`);
  }

  const slips: Array<{
    userId: string; earnings: string; deductions: string; gross: number; net: number;
    statutory: PayslipStatutoryT; employerKiwiSaverNet: number; employerEsct: number;
  }> = [];
  for (const s of structures) {
    const components = JSON.parse(s.components) as OfferComponent[];
    const earnings = components
      .filter((c) => c.kind === "EARNING")
      .map((c) => ({ key: c.key, label: c.label, amount: Math.round((c.amount / 12) * 100) / 100 }));
    const gross = Math.round(earnings.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    const profileRow = (profileByUser.get(s.userId) ?? null) as NzTaxProfileRow | null;
    const taxProfile = toNzTaxProfile(
      profileRow ?? { taxCode: "M", isCasual: false, kiwiSaverStatus: "ACTIVE", kiwiSaverEmployeeRate: null, kiwiSaverEmployerRate: null, taxCodeSpecialRate: null, stcAccTreatment: null, stcStudentLoanRate: null },
      { employmentCategory: "PERMANENT" },
    );
    const result = calculateNzStatutoryWithSet({ gross, frequency: "MONTHLY", taxProfile, payPeriodEnd: WINDOW_END, rateSet });
    const statutory = serializeStatutorySnapshot(result, { defaultedProfile: profileRow == null });
    const deductions = statutoryDeductionLines(result);
    slips.push({
      userId: s.userId,
      earnings: JSON.stringify(earnings),
      deductions: JSON.stringify(deductions),
      gross,
      net: Math.round((gross - deductions.reduce((a, l) => a + l.amount, 0)) * 100) / 100,
      statutory,
      employerKiwiSaverNet: result.kiwisaver.employerNet,
      employerEsct: result.kiwisaver.esct,
    });
  }

  const hr = await db.user.findFirst({ where: { role: "HR" }, select: { id: true } });
  const run = await db.payrollRun.create({
    data: {
      period: PERIOD,
      frequency: "MONTHLY",
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      payDate: WINDOW_END,
      status: "LOCKED",
      lockedById: hr?.id ?? "",
      lockedAt: new Date(),
      createdById: hr?.id ?? "",
      workingDays: 22,
      rateSetId: rateSet.id,
      payslips: {
        create: slips.map((p, i) => ({
          userId: p.userId,
          slipNo: `PS-${PERIOD}-${String(i + 1).padStart(3, "0")}`,
          earnings: p.earnings,
          deductions: p.deductions,
          gross: p.gross,
          net: p.net,
          paidDays: 22,
          taxCodeApplied: p.statutory.taxCode,
          statutoryRuleVersion: p.statutory.ruleVersion,
          statutory: p.statutory as never,
          employerKiwiSaverGross: p.statutory.kiwiSaver.employerGross,
          employerKiwiSaverNet: p.employerKiwiSaverNet,
          employerEsct: p.employerEsct,
        })),
      },
    },
  });
  console.log(`  ✓ run ${PERIOD} LOCKED (${slips.length} engine-priced payslips, payDate 2026-09-30)`);

  const posted = await postPayrollRun(run.id, { postedById: hr?.id });
  console.log(`  ✓ journal entry POSTED (${posted.lines.length} lines) — the filing reconciliation has a ledger to agree with`);
  console.log("Done. Open Payroll → the 2026-09 run → Filing to generate its Employment Information file.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("✗", e instanceof Error ? e.message : e);
    process.exit(1);
  });
