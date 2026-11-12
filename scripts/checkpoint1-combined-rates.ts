/* eslint-disable no-console */
// Phase 1A gap-closure — CHECKPOINT 1.
//
// Runs the PRODUCTION calculator (calculatePaye, rate-set-resolved params)
// against the SEEDED FY2026-27 rate set (loaded from the DB through the same
// resolveNzRateSet the payroll run uses) for every secondary code, ND and
// CAE at $1,000 weekly gross, and checks each produces exactly the IR340
// combined (PAYE + ACC) deduction value:
//
//   SB 12.25% → $122.50   S 19.25% → $192.50   SH 31.75% → $317.50
//   ST 34.75% → $347.50   SA 40.75% → $407.50   ND 46.75% → $467.50
//   CAE 19.25% → $192.50  (NSW borrows SB → $122.50, bonus check)
//
// Run: bash scripts/run-with-env.sh bun scripts/checkpoint1-combined-rates.ts
// ---------------------------------------------------------------------------
import { calculatePaye } from "../src/lib/payroll/nz/paye";
import { resolveNzRateSet } from "../src/lib/payroll/nz/calculate";
import type { NzTaxProfileInput } from "../src/lib/payroll/nz/types";

const EXPECTED: Array<{ code: string; combined: number }> = [
  { code: "SB", combined: 122.5 },
  { code: "S", combined: 192.5 },
  { code: "SH", combined: 317.5 },
  { code: "ST", combined: 347.5 },
  { code: "SA", combined: 407.5 },
  { code: "ND", combined: 467.5 },
  { code: "CAE", combined: 192.5 },
  { code: "NSW", combined: 122.5 }, // borrows the SB row
];

function baseProfile(taxCode: string): NzTaxProfileInput {
  return {
    taxCode,
    isCasual: false,
    employmentCategory: "PERMANENT",
    employmentStartDate: null,
    casualHolidayPayInWages: false,
    kiwiSaverStatus: "NOT_ENROLLED",
    kiwiSaverRate: null,
    employerKiwiSaverRate: null,
    esctRateOverride: null,
    taxCodeSpecialRate: null,
    stcAccTreatment: null,
    stcStudentLoanRate: null,
    stcStudentLoanThresholdApplies: true,
  };
}

async function main() {
  const set = await resolveNzRateSet(new Date("2026-11-30T00:00:00.000Z"));
  if (!set) {
    console.error("  ✗ No statutory rate set effective 2026-11-30 — run `bun run db:seed:statutory` first");
    process.exit(1);
  }
  console.log(`  Rate set from DB: ${set.label}`);
  console.log(`  Seeded secondary rows:`);
  for (const s of set.secondaryRates) {
    console.log(`    ${s.code.padEnd(3)} rate ${(s.rate * 100).toFixed(2).padStart(6)}%  accInclusive=${s.accInclusive === true}`);
  }
  console.log("");

  let failed = 0;
  for (const { code, combined } of EXPECTED) {
    const r = calculatePaye({
      gross: 1000,
      frequency: "WEEKLY",
      taxProfile: baseProfile(code),
      payeTiers: set.payeTiers,
      secondaryRates: set.secondaryRates,
      accLevy: set.accLevy,
      ietc: set.ietc,
    });
    const ok = r.tax === combined && r.acc === 0 && r.total === combined;
    if (ok) {
      console.log(`  ✓ ${code.padEnd(4)} $1,000 weekly → tax $${r.tax.toFixed(2)} + acc $${r.acc.toFixed(2)} = total $${r.total.toFixed(2)} (combined, method ${r.method})`);
    } else {
      failed += 1;
      console.log(`  ✗ ${code.padEnd(4)} expected { tax: ${combined}, acc: 0, total: ${combined} }, got { tax: ${r.tax}, acc: ${r.acc}, total: ${r.total} }`);
    }
  }

  // Primary codes must be UNCHANGED (split: tax-only slabs + capped levy line).
  const m = calculatePaye({
    gross: 1000,
    frequency: "WEEKLY",
    taxProfile: baseProfile("M"),
    payeTiers: set.payeTiers,
    secondaryRates: set.secondaryRates,
    accLevy: set.accLevy,
    ietc: set.ietc,
  });
  const mOk = m.tax === 154 && m.acc === 17.5 && m.total === 171.5;
  console.log(
    `${mOk ? "  ✓" : "  ✗"} M  $1,000 weekly → tax $${m.tax.toFixed(2)} + acc $${m.acc.toFixed(2)} = $${m.total.toFixed(2)} (primary split unchanged, expected 154.00 + 17.50)`,
  );
  if (!mOk) failed += 1;

  console.log(failed === 0 ? "\n  CHECKPOINT 1: PASS — every code produces the IR340 combined value\n" : `\n  CHECKPOINT 1: ${failed} FAILURE(S)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
