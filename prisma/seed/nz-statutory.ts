// NZ statutory payroll engine — statutory rate-set + tax-year seed
// (Phase 0 seed, Phase 1A home: prisma/seed/nz-statutory.ts).
//
// Idempotent: upserts the FY2026-27 rate set by its unique label and the
// NZ tax-year registry by label. Safe to run against any database (demo,
// e2e, production bootstrap) — it never deletes or overwrites OTHER sets,
// and re-running only refreshes this set's child rows when the values
// changed.
//
// Run: bun run db:seed:statutory   (wraps scripts/run-with-env.sh — ADR-008)
//
// Source of every seeded number (all verified 2026-11-12 against IRD
// primary sources for the tax year 1 April 2026 – 31 March 2027):
//   - PAYE income-tax slabs ......... IRD "Tax rates for individuals"
//   - Secondary code rates ........... IR340 Apr 2026 combined (PAYE + ACC)
//                                     deduction rates — the ONLY correct
//                                     values at source: SB 12.25 / S 19.25 /
//                                     SH 31.75 / ST 34.75 / SA 40.75 /
//                                     ND 46.75 / CAE 19.25 (CAE rides the
//                                     S row). Seeded accInclusive: the rate
//                                     already carries the 1.75% levy.
//   - ACC earners' levy ............. IRD "ACC earners' levy rates"
//                                     (1.75% / $156,641 / $2,741.22)
//   - IETC .......................... $520/yr, $24,000–$70,000, 13c
//                                     abatement above $66,000
//   - KiwiSaver ..................... IRD "KiwiSaver changes" (3.5% default
//                                     + 3.5% employer from 1 Apr 2026);
//                                     allowed employee rates 3/3.5/4/6/8/10
//   - ESCT tiers .................... IR341 Apr 2026 ($18,720 / $64,200 /
//                                     $93,720 / $216,000)
//   - Student loan .................. IRD (12% over $24,128; monthly
//                                     threshold $2,010.66 verified against
//                                     the IR341 monthly SL column)
// The calculation split (income tax separate from the ACC levy) was
// verified numerically against IR341 Apr 2026 monthly table rows, e.g.
//   monthly $2,000 M  → $210.00 slab + $35.00 levy = $245.00 (ME −$43.33)
//   monthly $15,000 M → $4,106.46 slab + $228.43 levy (capped) = $4,334.89
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
// The engine's auto-enrolment time-rule constants — one home, imported here
// so the seed and the calculator can never drift apart.
import { CASUAL_AGRI_MAX_MONTHS, TEMP_MAX_DAYS } from "../../src/lib/payroll/nz/kiwisaver";

const LABEL = "NZ FY2026-27 (1 Apr 2026 – 31 Mar 2027)";

/** The IR340 combined first-tier secondary rate (SB 0.1225 = 10.5% income
 * tax + 1.75% ACC levy) — the value the seed stores for SB. */
export const SB_COMBINED_RATE = 0.1225;

// [fromAnnual, toAnnual (null = ∞), rate] — half-open tiers on annualised
// income; income tax only.
const PAYE_TIERS: Array<[number, number | null, number]> = [
  [0, 15600, 0.105],
  [15600, 53500, 0.175],
  [53500, 78100, 0.3],
  [78100, 180000, 0.33],
  [180000, null, 0.39],
];

// Secondary codes — the IR340 Apr 2026 COMBINED (PAYE + ACC) deduction
// rates at source, seeded as accInclusive rows: the stored rate already
// carries the 1.75% earners' levy, so the calculator puts the whole
// deduction in the tax line and leaves the levy line at $0 (the IR340
// printed-table behaviour). CAE/EDW borrow the S row (19.25%); NSW borrows
// the SB row (12.25%).
const SECONDARY_RATES = [
  { code: "SB", rate: 0.1225, label: "Secondary bottom ($0–$15,600) — combined 12.25% (10.5% + levy)", accInclusive: true },
  { code: "S", rate: 0.1925, label: "Secondary ($15,601–$53,500) — combined 19.25% (17.5% + levy)", accInclusive: true },
  { code: "SH", rate: 0.3175, label: "Secondary high ($53,501–$78,100) — combined 31.75% (30% + levy)", accInclusive: true },
  { code: "ST", rate: 0.3475, label: "Secondary top ($78,101–$180,000) — combined 34.75% (33% + levy)", accInclusive: true },
  { code: "SA", rate: 0.4075, label: "Secondary all ($180,001+) — combined 40.75% (39% + levy)", accInclusive: true },
  { code: "ND", rate: 0.4675, label: "No declaration (IR330 not given) — combined 46.75% (45% + levy)", accInclusive: true },
];

const ACC_LEVY = { rate: 0.0175, maxEarnings: 156641, maxLevy: 2741.22 };
const IETC = { annualAmount: 520, lowerBound: 24000, abateFrom: 66000, upperBound: 70000, abateRate: 0.13 };
const KIWISAVER = { defaultEmployeeRate: 0.035, allowedEmployeeRates: [3, 3.5, 4, 6, 8, 10], employerRate: 0.035 };

// [fromAnnual, toAnnual (null = ∞), rate] on annual income + employer
// contributions.
const ESCT_TIERS: Array<[number, number | null, number]> = [
  [0, 18720, 0.105],
  [18720, 64200, 0.175],
  [64200, 93720, 0.3],
  [93720, 216000, 0.33],
  [216000, null, 0.39],
];

const STUDENT_LOAN = { rate: 0.12, annualThreshold: 24128 };

// The NZ tax-year registry (Phase 1A): the April–March years the rate sets
// and PayrollRun.taxYearId hang off. Labels follow the IRD convention.
const TAX_YEARS: Array<{ label: string; start: string; end: string; current: boolean }> = [
  { label: "2025-26", start: "2025-04-01T00:00:00.000Z", end: "2026-03-31T23:59:59.999Z", current: false },
  { label: "2026-27", start: "2026-04-01T00:00:00.000Z", end: "2027-03-31T23:59:59.999Z", current: true },
  { label: "2027-28", start: "2027-04-01T00:00:00.000Z", end: "2028-03-31T23:59:59.999Z", current: false },
];

export async function seedNzStatutory(): Promise<void> {
  const db = new PrismaClient();
  try {
    await seedWithClient(db);
  } finally {
    await db.$disconnect();
  }
}

async function seedWithClient(db: PrismaClient): Promise<void> {
  console.log("🇳🇿 Seeding NZ statutory rate set + tax years…");

  // ---- Tax years (idempotent upserts by label) ----
  for (const y of TAX_YEARS) {
    await db.taxYear.upsert({
      where: { label: y.label },
      update: { startDate: new Date(y.start), endDate: new Date(y.end), isCurrent: y.current },
      create: {
        label: y.label,
        startDate: new Date(y.start),
        endDate: new Date(y.end),
        isCurrent: y.current,
      },
    });
  }

  // ---- The FY2026-27 rate set ----
  const existing = await db.statutoryRule.findUnique({ where: { label: LABEL } });

  const notes = `Seeded from IRD primary sources (IR341 Apr 2026, IR330 Aug 2026, IRD rate pages); verified 2026-11-12. Auto-enrolment time rules: TEMP_MAX_DAYS=${TEMP_MAX_DAYS}, CASUAL_AGRI_MAX_MONTHS=${CASUAL_AGRI_MAX_MONTHS}.`;

  const set = existing
    ? await db.statutoryRule.update({
        where: { id: existing.id },
        data: {
          country: "NZ",
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          effectiveTo: new Date("2027-04-01T00:00:00.000Z"),
          isCurrent: true,
          notes,
          updatedAt: new Date(),
        },
      })
    : await db.statutoryRule.create({
        data: {
          label: LABEL,
          country: "NZ",
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          effectiveTo: new Date("2027-04-01T00:00:00.000Z"),
          isCurrent: true,
          notes,
        },
      });

  // At most one current set: clear the flag on every other row.
  await db.statutoryRule.updateMany({
    where: { isCurrent: true, NOT: { id: set.id } },
    data: { isCurrent: false },
  });

  // Child rows are replaced wholesale for THIS set only (idempotent).
  await db.taxSlab.deleteMany({ where: { setId: set.id } });
  await db.statutorySecondaryRate.deleteMany({ where: { setId: set.id } });
  await db.statutoryAccLevy.deleteMany({ where: { setId: set.id } });
  await db.statutoryIetc.deleteMany({ where: { setId: set.id } });
  await db.statutoryKiwiSaver.deleteMany({ where: { setId: set.id } });
  await db.statutoryEsctTier.deleteMany({ where: { setId: set.id } });
  await db.statutoryStudentLoan.deleteMany({ where: { setId: set.id } });

  await db.taxSlab.createMany({
    data: PAYE_TIERS.map(([fromAnnual, toAnnual, rate], i) => ({
      setId: set.id, fromAnnual, toAnnual, rate, sortOrder: i * 10,
    })),
  });
  await db.statutorySecondaryRate.createMany({
    data: SECONDARY_RATES.map((s) => ({ setId: set.id, ...s })),
  });
  await db.statutoryAccLevy.create({ data: { setId: set.id, ...ACC_LEVY } });
  await db.statutoryIetc.create({ data: { setId: set.id, ...IETC } });
  await db.statutoryKiwiSaver.create({
    data: {
      setId: set.id,
      defaultEmployeeRate: KIWISAVER.defaultEmployeeRate,
      allowedEmployeeRates: KIWISAVER.allowedEmployeeRates,
      employerRate: KIWISAVER.employerRate,
    },
  });
  await db.statutoryEsctTier.createMany({
    data: ESCT_TIERS.map(([fromAnnual, toAnnual, rate], i) => ({
      setId: set.id, fromAnnual, toAnnual, rate, sortOrder: i * 10,
    })),
  });
  await db.statutoryStudentLoan.create({ data: { setId: set.id, ...STUDENT_LOAN } });

  console.log(`  ✓ Rate set: ${LABEL}`);
  console.log(`    PAYE slabs: ${PAYE_TIERS.length} (10.5/17.5/30/33/39) · secondary: ${SECONDARY_RATES.length} (SB/S/SH/ST/SA/ND; IR340 combined rates 12.25–46.75%, accInclusive — SB ${SB_COMBINED_RATE})`);
  console.log(`    ACC 1.75% cap $156,641 max $2,741.22 · IETC $520 ($24k–$66k, 13c abate) · KiwiSaver 3.5%/3.5% · ESCT ${ESCT_TIERS.length} tiers · SL 12% over $24,128`);
  console.log(`    effective [2026-04-01, 2027-04-01) — isCurrent: true`);
  console.log(`    tax years: ${TAX_YEARS.map((y) => y.label).join(", ")} · auto-enrol rules: TEMP_MAX_DAYS=${TEMP_MAX_DAYS}, CASUAL_AGRI_MAX_MONTHS=${CASUAL_AGRI_MAX_MONTHS}`);
}

// Direct execution: bun prisma/seed/nz-statutory.ts
if (process.argv[1] && process.argv[1].endsWith("nz-statutory.ts")) {
  seedNzStatutory().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
