import { describe, expect, it } from "vitest";

import { solveBaseForCtc } from "@/lib/hiring/ctc-solver";
import { computeOffer, type OfferComponent } from "@/lib/offer-math";

const C = (key: string, kind: OfferComponent["kind"], mode: OfferComponent["mode"], amount: number): OfferComponent =>
  ({ key, label: key, kind, mode, amount });

const PACKAGE: OfferComponent[] = [
  C("basic", "EARNING", "FIXED", 60_000),
  C("transport", "EARNING", "FIXED", 2_400),
  C("housing", "EARNING", "PERCENT_OF_BASIC", 10), // 10% of basic
  C("kiwisaver", "EMPLOYER_CONTRIBUTION", "PERCENT_OF_BASIC", 3), // 3% of basic
  C("student_loan", "DEDUCTION", "FIXED", 1_200), // never counts into CTC
];

describe("solveBaseForCtc (P12 / PR-B20 / RJ-B14)", () => {
  it("solves the basic that hits the target: CTC(B) = fixed + B×rate", () => {
    // fixed = transport 2,400; rate = 1 (basic) + 10% (housing) + 3% (kiwisaver) = 1.13
    // target 100,000 → B = (100,000 − 2,400) / 1.13 = 86,371.68… → rounds to 86,372.
    const res = solveBaseForCtc({ components: PACKAGE, targetCtc: 100_000 });
    expect(res.ok).toBe(true);
    expect(res.baseKey).toBe("basic");
    expect(res.base).toBe(86_372);
    // The achieved CTC recomputed honestly (residue from whole-unit rounding).
    const totals = computeOffer(PACKAGE.map((c) => (c.key === "basic" ? { ...c, amount: res.base } : c)));
    expect(res.achievedCtc).toBe(totals.ctc);
    expect(Math.abs(res.delta)).toBeLessThanOrEqual(1.13); // one rate-unit of rounding
    // Deductions never count: the solved base ignores the student loan.
    expect(totals.deductions).toBe(1_200);
  });

  it("an exact target is hit with zero delta when the math divides cleanly", () => {
    // fixed 0, rate 1.25: target 100,000 → B = 80,000 exactly.
    const res = solveBaseForCtc({
      components: [
        C("basic", "EARNING", "FIXED", 1),
        C("bonus", "EARNING", "PERCENT_OF_BASIC", 25),
      ],
      targetCtc: 100_000,
    });
    expect(res.ok).toBe(true);
    expect(res.base).toBe(80_000);
    expect(res.delta).toBe(0);
  });

  it("honours the roundTo granularity and reports the residue", () => {
    const res = solveBaseForCtc({
      components: [
        C("basic", "EARNING", "FIXED", 1),
        C("housing", "EARNING", "PERCENT_OF_BASIC", 10),
      ],
      targetCtc: 100_000,
      roundTo: 1_000,
    });
    // B* = 100,000 / 1.1 = 90,909.09 → rounds to 91,000.
    expect(res.base).toBe(91_000);
    // Achieved = 91,000 × 1.1 = 100,100 → delta +100 (reported, not hidden).
    expect(res.achievedCtc).toBe(100_100);
    expect(res.delta).toBe(100);
    expect(res.totals?.ctc).toBe(100_100);
  });

  it("solves with only the basic (rate 1) and with implicit-basic packages", () => {
    const only = solveBaseForCtc({ components: [C("basic", "EARNING", "FIXED", 1)], targetCtc: 75_000 });
    expect(only.ok).toBe(true);
    expect(only.base).toBe(75_000);
    expect(only.delta).toBe(0);

    // No explicit "basic" key: the first FIXED earning anchors (basicKeyOf).
    const implicit = solveBaseForCtc({
      components: [
        C("salary", "EARNING", "FIXED", 1),
        C("kiwisaver", "EMPLOYER_CONTRIBUTION", "PERCENT_OF_BASIC", 3),
      ],
      targetCtc: 103_000,
    });
    expect(implicit.ok).toBe(true);
    expect(implicit.baseKey).toBe("salary");
    expect(implicit.base).toBe(100_000);
    expect(implicit.delta).toBe(0);
  });

  it("refuses with visible reasons — no basic, impossible target, bad input", () => {
    // No anchor: deductions are not earnings, so nothing can flex (an
    // implicit basic needs at least one FIXED EARNING — basicKeyOf).
    expect(solveBaseForCtc({ components: [C("loan", "DEDUCTION", "FIXED", 1_000)], targetCtc: 100_000 }).reason)
      .toContain("No basic component to flex");
    expect(solveBaseForCtc({ components: [C("housing", "EARNING", "PERCENT_OF_BASIC", 10)], targetCtc: 100_000 }).reason)
      .toContain("No basic component to flex");
    // Fixed driver 50,000 with rate 1: target 40,000 → B negative.
    const below = solveBaseForCtc({
      components: [C("basic", "EARNING", "FIXED", 1), C("transport", "EARNING", "FIXED", 50_000)],
      targetCtc: 40_000,
    });
    expect(below.ok).toBe(false);
    expect(below.reason).toContain("below the fixed components' cost");
    expect(solveBaseForCtc({ components: PACKAGE, targetCtc: -5 }).reason).toContain("positive target CTC");
    expect(solveBaseForCtc({ components: PACKAGE, targetCtc: Number.NaN }).ok).toBe(false);
  });

  it("statistical and deduction percent components never bend the solution", () => {
    // A 50%-of-basic STATISTICAL line and a 20%-of-basic DEDUCTION must not
    // change the rate: target 100,000 with rate 1.1 → B = 90,909.09 → 90,909.
    const withNoise = solveBaseForCtc({
      components: [
        C("basic", "EARNING", "FIXED", 1),
        C("housing", "EARNING", "PERCENT_OF_BASIC", 10),
        C("package_note", "STATISTICAL", "PERCENT_OF_BASIC", 50),
        C("loan", "DEDUCTION", "PERCENT_OF_BASIC", 20),
      ],
      targetCtc: 100_000,
    });
    expect(withNoise.ok).toBe(true);
    expect(withNoise.base).toBe(90_909);
    expect(withNoise.totals?.deductions).toBe(round(90_909 * 0.2));
  });
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
