/* eslint-disable @typescript-eslint/no-require-imports */
// NZ statutory payroll engine — Phase 0 statutory rate-set seed.
//
// Idempotent: upserts the FY2026-27 rate set by its unique label. Safe to
// run against any database (demo, e2e, production bootstrap) — it never
// deletes or overwrites OTHER sets, and re-running only refreshes this
// set's child rows when the values changed.
//
// Run: bun run db:seed:statutory   (wraps scripts/run-with-env.sh — ADR-008)
//
// Source of every seeded number (all verified 2026-11-12 against IRD
// primary sources for the tax year 1 April 2026 – 31 March 2027):
//   - PAYE income-tax slabs ......... IRD "Tax rates for individuals"
//   - Secondary code rates ........... IRD "Tax rates for individuals"
//                                     (table header: "before ACC levies")
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
//                                     threshold $2,010.67 verified against
//                                     the IR341 monthly SL column)
// The calculation split (income tax separate from the ACC levy) was
// verified numerically against IR341 Apr 2026 monthly table rows, e.g.
//   monthly $2,000 M  → $210.00 slab + $35.00 levy = $245.00 (ME −$43.33)
//   monthly $15,000 M → $4,106.46 slab + $228.43 levy (capped) = $4,334.89
// ---------------------------------------------------------------------------
const { PrismaClient, Prisma } = require("@prisma/client");
const db = new PrismaClient();

const LABEL = "NZ FY2026-27 (1 Apr 2026 – 31 Mar 2027)";

// [fromAnnual, toAnnual (null = ∞), rate] — half-open tiers on annualised
// income; income tax only.
const PAYE_TIERS = [
  [0, 15600, 0.105],
  [15600, 53500, 0.175],
  [53500, 78100, 0.3],
  [78100, 180000, 0.33],
  [180000, null, 0.39],
];

// Secondary codes — flat income-tax rates "before ACC levies" (IRD).
// accInclusive stays false: these are the split rates; a combined-rate
// row (e.g. the lump-sum table's 12.25% SB) is a Phase 3 admin edit.
const SECONDARY_RATES = [
  { code: "SB", rate: 0.105, label: "Secondary bottom ($0–$15,600)", accInclusive: false },
  { code: "S", rate: 0.175, label: "Secondary ($15,601–$53,500)", accInclusive: false },
  { code: "SH", rate: 0.3, label: "Secondary high ($53,501–$78,100)", accInclusive: false },
  { code: "ST", rate: 0.33, label: "Secondary top ($78,101–$180,000)", accInclusive: false },
  { code: "SA", rate: 0.39, label: "Secondary all ($180,001+)", accInclusive: false },
  { code: "ND", rate: 0.45, label: "No declaration (IR330 not given)", accInclusive: false },
];

const ACC_LEVY = { rate: 0.0175, maxEarnings: 156641, maxLevy: 2741.22 };
const IETC = { annualAmount: 520, lowerBound: 24000, abateFrom: 66000, upperBound: 70000, abateRate: 0.13 };
const KIWISAVER = { defaultEmployeeRate: 0.035, allowedEmployeeRates: [3, 3.5, 4, 6, 8, 10], employerRate: 0.035 };

// [fromAnnual, toAnnual (null = ∞), rate] on annual income + employer
// contributions.
const ESCT_TIERS = [
  [0, 18720, 0.105],
  [18720, 64200, 0.175],
  [64200, 93720, 0.3],
  [93720, 216000, 0.33],
  [216000, null, 0.39],
];

const STUDENT_LOAN = { rate: 0.12, annualThreshold: 24128 };

async function main() {
  console.log("🇳🇿 Seeding NZ statutory rate set…");

  const existing = await db.statutoryRateSet.findUnique({ where: { label: LABEL } });

  const set = existing
    ? await db.statutoryRateSet.update({
        where: { id: existing.id },
        data: {
          country: "NZ",
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          effectiveTo: new Date("2027-04-01T00:00:00.000Z"),
          isCurrent: true,
          notes: "Seeded from IRD primary sources (IR341 Apr 2026, IR330 Aug 2026, IRD rate pages); verified 2026-11-12.",
          updatedAt: new Date(),
        },
      })
    : await db.statutoryRateSet.create({
        data: {
          label: LABEL,
          country: "NZ",
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          effectiveTo: new Date("2027-04-01T00:00:00.000Z"),
          isCurrent: true,
          notes: "Seeded from IRD primary sources (IR341 Apr 2026, IR330 Aug 2026, IRD rate pages); verified 2026-11-12.",
        },
      });

  // At most one current set: clear the flag on every other row.
  await db.statutoryRateSet.updateMany({
    where: { isCurrent: true, NOT: { id: set.id } },
    data: { isCurrent: false },
  });

  // Child rows are replaced wholesale for THIS set only (idempotent).
  await db.statutoryPayeTier.deleteMany({ where: { setId: set.id } });
  await db.statutorySecondaryRate.deleteMany({ where: { setId: set.id } });
  await db.statutoryAccLevy.deleteMany({ where: { setId: set.id } });
  await db.statutoryIetc.deleteMany({ where: { setId: set.id } });
  await db.statutoryKiwiSaver.deleteMany({ where: { setId: set.id } });
  await db.statutoryEsctTier.deleteMany({ where: { setId: set.id } });
  await db.statutoryStudentLoan.deleteMany({ where: { setId: set.id } });

  await db.statutoryPayeTier.createMany({
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

  const counts = {
    payeTiers: PAYE_TIERS.length,
    secondaryRates: SECONDARY_RATES.length,
    esctTiers: ESCT_TIERS.length,
  };
  console.log(`  ✓ Rate set: ${LABEL}`);
  console.log(`    PAYE slabs: ${counts.payeTiers} (10.5/17.5/30/33/39) · secondary: ${counts.secondaryRates} (SB/S/SH/ST/SA/ND)`);
  console.log(`    ACC 1.75% cap $156,641 max $2,741.22 · IETC $520 ($24k–$66k, 13c abate) · KiwiSaver 3.5%/3.5% · ESCT ${counts.esctTiers} tiers · SL 12% over $24,128`);
  console.log(`    effective [2026-04-01, 2027-04-01) — isCurrent: true`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
