/* eslint-disable no-console */
// NZ statutory payroll engine — Phase 1 integration verification.
//
// Runs the REAL engine (src/lib/payroll/nz) against the SEEDED database
// rate set (prisma/seed/nz-statutory.ts): proves the resolver picks the
// FY2026-27 set, and that the seeded values reproduce the IRD-verified
// known-answer rows end-to-end — the same rows the pure unit tests check
// against hand-built fixtures, closing the loop fixture ↔ seed.
//
// Run: bun run verify:phase1   (wraps scripts/run-with-env.sh — ADR-008)
// ---------------------------------------------------------------------------
import { calculateNzStatutoryWithSet, nzRuleVersion, resolveNzRateSet, toNzTaxProfile } from "../src/lib/payroll/nz/calculate";
import type { NzTaxProfileInput, NzPayFrequency } from "../src/lib/payroll/nz/types";

interface Row {
  name: string;
  gross: number;
  frequency: NzPayFrequency;
  profile: Partial<NzTaxProfileInput>;
  paye?: { tax: number; acc: number; total: number };
  studentLoan?: number;
  netPay?: number;
}

const ROWS: Row[] = [
  {
    name: "IR341 monthly $15,000 M — 4,106.46 + 228.43 = 4,334.89",
    gross: 15_000, frequency: "MONTHLY", profile: { taxCode: "M" },
    paye: { tax: 4_106.46, acc: 228.43, total: 4_334.89 },
  },
  {
    name: "M weekly $1,000 — 154.00 + 17.50",
    gross: 1_000, frequency: "WEEKLY", profile: { taxCode: "M" },
    paye: { tax: 154.0, acc: 17.5, total: 171.5 },
  },
  {
    name: "ME monthly $2,000 — IETC 43.33 (M − 43.33)",
    gross: 2_000, frequency: "MONTHLY", profile: { taxCode: "ME" },
    paye: { tax: 215.67, acc: 35.0, total: 250.67 },
  },
  {
    name: "SB weekly $1,000 — IR340 combined 12.25% = 122.50 (spec §5.6)",
    gross: 1_000, frequency: "WEEKLY", profile: { taxCode: "SB" },
    paye: { tax: 122.5, acc: 0, total: 122.5 },
  },
  {
    name: "ND monthly $5,000 — combined 46.75% = 2,337.50",
    gross: 5_000, frequency: "MONTHLY", profile: { taxCode: "ND" },
    paye: { tax: 2_337.5, acc: 0, total: 2_337.5 },
  },
  {
    name: "CAE weekly $1,000 — S-row combined 19.25% = 192.50 (spec §5.7)",
    gross: 1_000, frequency: "WEEKLY", profile: { taxCode: "CAE" },
    paye: { tax: 192.5, acc: 0, total: 192.5 },
  },
  {
    name: "STC 18% PLUS monthly $5,000 — 900.00 + 87.50",
    gross: 5_000, frequency: "MONTHLY",
    profile: { taxCode: "STC", taxCodeSpecialRate: 0.18, stcAccTreatment: "PLUS" },
    paye: { tax: 900.0, acc: 87.5, total: 987.5 },
  },
  {
    name: "M SL monthly $5,000 — SL 358.72, net 3,527.07 (KS 3.5%)",
    gross: 5_000, frequency: "MONTHLY", profile: { taxCode: "M SL" },
    studentLoan: 358.72,
    netPay: 3_527.07,
  },
  {
    name: "NSW weekly $1,000 — SB-row combined 12.25%, no KS/SL, net 877.50",
    gross: 1_000, frequency: "WEEKLY", profile: { taxCode: "NSW" },
    netPay: 877.5,
  },
];

function baseProfile(overrides: Partial<NzTaxProfileInput>): NzTaxProfileInput {
  return {
    taxCode: "M",
    isCasual: false,
    employmentCategory: "PERMANENT",
    employmentStartDate: null,
    casualHolidayPayInWages: false,
    kiwiSaverStatus: "ACTIVE",
    kiwiSaverRate: null,
    employerKiwiSaverRate: null,
    esctRateOverride: null,
    taxCodeSpecialRate: null,
    stcAccTreatment: null,
    stcStudentLoanRate: null,
    stcStudentLoanThresholdApplies: true,
    ...overrides,
  };
}

async function main() {
  console.log("🇳🇿 Phase 1 verification — engine × seeded rate set…\n");

  const periodEnd = new Date("2026-11-30T00:00:00.000Z");
  const set = await resolveNzRateSet(periodEnd);
  if (!set) {
    console.error("  ✗ No statutory rate set effective on 2026-11-30 — run `bun run db:seed:statutory` first");
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ Resolved: ${set.label}`);
  console.log(`    PAYE tiers ${set.payeTiers.length} · secondary ${set.secondaryRates.length} · ACC ${(set.accLevy.rate * 100).toFixed(2)}% cap $${set.accLevy.maxEarnings.toLocaleString()} · ESCT tiers ${set.esctTiers.length} · SL ${(set.studentLoan?.rate ?? 0) * 100}% over $${set.studentLoan?.annualThreshold.toLocaleString()}`);
  console.log(`    ruleVersion ${nzRuleVersion(set)}\n`);

  let failed = 0;
  for (const row of ROWS) {
    const r = calculateNzStatutoryWithSet({
      gross: row.gross,
      frequency: row.frequency,
      taxProfile: baseProfile(row.profile),
      payPeriodEnd: periodEnd,
      rateSet: set,
    });
    const problems: string[] = [];
    if (row.paye) {
      if (r.paye.tax !== row.paye.tax) problems.push(`tax ${r.paye.tax} ≠ ${row.paye.tax}`);
      if (r.paye.acc !== row.paye.acc) problems.push(`acc ${r.paye.acc} ≠ ${row.paye.acc}`);
      if (r.paye.total !== row.paye.total) problems.push(`total ${r.paye.total} ≠ ${row.paye.total}`);
    }
    if (row.studentLoan != null && r.studentLoan !== row.studentLoan) {
      problems.push(`SL ${r.studentLoan} ≠ ${row.studentLoan}`);
    }
    if (row.netPay != null && r.netPay !== row.netPay) {
      problems.push(`net ${r.netPay} ≠ ${row.netPay}`);
    }
    if (problems.length === 0) {
      console.log(`  ✓ ${row.name}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${row.name} — ${problems.join("; ")}`);
    }
  }

  // The row adapter path: build a profile the way Phase 2 will.
  const adapted = toNzTaxProfile({
    taxCode: "M SL",
    isCasual: false,
    kiwiSaverStatus: "ACTIVE",
    kiwiSaverEmployeeRate: null,
    kiwiSaverEmployerRate: null,
    taxCodeSpecialRate: null,
    stcAccTreatment: null,
    stcStudentLoanRate: null,
  }, { hireDate: new Date("2026-05-01T00:00:00.000Z") });
  const r = calculateNzStatutoryWithSet({
    gross: 5_000, frequency: "MONTHLY", taxProfile: adapted, payPeriodEnd: periodEnd, rateSet: set,
  });
  if (r.netPay === 3_527.07) {
    console.log("  ✓ toNzTaxProfile adapter path — M SL monthly $5,000 net 3,527.07");
  } else {
    failed += 1;
    console.log(`  ✗ toNzTaxProfile adapter path — net ${r.netPay} ≠ 3,527.07`);
  }

  console.log(failed === 0 ? "\n  Phase 1 verification: ALL ROWS PASS\n" : `\n  Phase 1 verification: ${failed} ROW(S) FAILED\n`);
  if (failed > 0) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
