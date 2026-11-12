// ---------------------------------------------------------------------------
// Phase 1 test fixtures — the FY2026-27 rate set exactly as
// prisma/seed/nz-statutory.ts seeds it (values verified against IRD primary
// sources in Phase 0). Hand-built here so the pure engine tests need no
// database.
// ---------------------------------------------------------------------------

import type {
  NzRateSetParams,
  NzTaxProfileInput,
} from "@/lib/payroll/nz/types";

export function fy2026RateSet(): NzRateSetParams {
  return {
    id: "test-set-fy2026",
    label: "NZ FY2026-27 (1 Apr 2026 – 31 Mar 2027)",
    payeTiers: [
      { fromAnnual: 0, toAnnual: 15600, rate: 0.105 },
      { fromAnnual: 15600, toAnnual: 53500, rate: 0.175 },
      { fromAnnual: 53500, toAnnual: 78100, rate: 0.3 },
      { fromAnnual: 78100, toAnnual: 180000, rate: 0.33 },
      { fromAnnual: 180000, toAnnual: null, rate: 0.39 },
    ],
    secondaryRates: [
      { code: "SB", rate: 0.105 },
      { code: "S", rate: 0.175 },
      { code: "SH", rate: 0.3 },
      { code: "ST", rate: 0.33 },
      { code: "SA", rate: 0.39 },
      { code: "ND", rate: 0.45 },
    ],
    accLevy: { rate: 0.0175, maxEarnings: 156641, maxLevy: 2741.22 },
    ietc: { annualAmount: 520, lowerBound: 24000, abateFrom: 66000, upperBound: 70000, abateRate: 0.13 },
    kiwiSaver: { defaultEmployeeRate: 0.035, allowedEmployeeRates: [3, 3.5, 4, 6, 8, 10], employerRate: 0.035 },
    esctTiers: [
      { fromAnnual: 0, toAnnual: 18720, rate: 0.105 },
      { fromAnnual: 18720, toAnnual: 64200, rate: 0.175 },
      { fromAnnual: 64200, toAnnual: 93720, rate: 0.3 },
      { fromAnnual: 93720, toAnnual: 216000, rate: 0.33 },
      { fromAnnual: 216000, toAnnual: null, rate: 0.39 },
    ],
    studentLoan: { rate: 0.12, annualThreshold: 24128 },
  };
}

/** A default engine profile — permanent, M code, KiwiSaver ACTIVE. */
export function baseProfile(overrides: Partial<NzTaxProfileInput> = {}): NzTaxProfileInput {
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

/** UTC midnight helper — the house date-only convention. */
export function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
