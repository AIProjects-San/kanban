import { describe, it, expect } from "vitest";

// R5 — offer math (src/lib/hiring/offer-math.ts): component resolution
// (fixed vs percent-of-basic), CTC vs net semantics, letter placeholders,
// and defensive JSON parsing for the TEXT columns.

import {
  basicKeyOf,
  computeOffer,
  parseBenefits,
  parseComponents,
  renderOfferLetter,
  formatMoney,
  type OfferComponent,
} from "@/lib/hiring/offer-math";

const STRUCTURE: OfferComponent[] = [
  { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 80_000 },
  { key: "housing", label: "Housing Allowance", kind: "EARNING", mode: "FIXED", amount: 12_000 },
  { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
  { key: "student_loan", label: "Student loan deduction", kind: "DEDUCTION", mode: "FIXED", amount: 2_000 },
];

describe("basicKeyOf", () => {
  it("prefers the explicit 'basic' key (case-insensitive)", () => {
    expect(basicKeyOf(STRUCTURE)).toBe("basic");
    expect(basicKeyOf([{ key: "Basic", label: "B", kind: "EARNING", mode: "FIXED", amount: 1 }])).toBe("Basic");
  });

  it("falls back to the first EARNING component, else null", () => {
    expect(basicKeyOf([{ key: "x", label: "X", kind: "EMPLOYER_CONTRIBUTION", mode: "FIXED", amount: 1 }, { key: "y", label: "Y", kind: "EARNING", mode: "FIXED", amount: 2 }])).toBe("y");
    expect(basicKeyOf([])).toBeNull();
  });
});

describe("computeOffer", () => {
  it("resolves percent-of-basic against the basic component", () => {
    const t = computeOffer(STRUCTURE);
    // 3% of 80,000 = 2,400.
    expect(t.resolved.kiwisaver).toBe(2_400);
    expect(t.basic).toBe(80_000);
  });

  it("splits earnings / employer contributions / deductions", () => {
    const t = computeOffer(STRUCTURE);
    expect(t.earnings).toBe(92_000);
    expect(t.employerContributions).toBe(2_400);
    expect(t.deductions).toBe(2_000);
  });

  it("CTC = earnings + employer contributions; net = earnings − deductions", () => {
    const t = computeOffer(STRUCTURE);
    expect(t.ctc).toBe(94_400);
    expect(t.net).toBe(90_000);
  });

  it("treats negative amounts as 0 (never a negative salary line)", () => {
    const t = computeOffer([
      { key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: -5 },
      { key: "x", label: "X", kind: "EARNING", mode: "FIXED", amount: Number.NaN },
    ]);
    expect(t.earnings).toBe(0);
    expect(t.ctc).toBe(0);
  });

  it("percent-of-basic resolves to 0 when no basic exists", () => {
    const t = computeOffer([
      { key: "bonus", label: "Bonus", kind: "EARNING", mode: "PERCENT_OF_BASIC", amount: 10 },
    ]);
    expect(t.resolved.bonus).toBe(0);
    expect(t.ctc).toBe(0);
  });
});

describe("parseComponents / parseBenefits", () => {
  it("round-trips valid JSON", () => {
    const parsed = parseComponents(JSON.stringify(STRUCTURE));
    expect(parsed).toHaveLength(4);
    expect(parsed[2]).toMatchObject({ key: "kiwisaver", mode: "PERCENT_OF_BASIC", amount: 3 });
    expect(parseBenefits(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("returns [] for malformed JSON, non-arrays, and invalid entries", () => {
    expect(parseComponents("not json")).toEqual([]);
    expect(parseComponents('{"a":1}')).toEqual([]);
    expect(parseComponents('[{"key":"x","label":"X","kind":"NOPE","mode":"FIXED","amount":1}]')).toEqual([]);
    expect(parseComponents('["string"]')).toEqual([]);
    expect(parseBenefits("nope")).toEqual([]);
    expect(parseBenefits('[1,2]')).toEqual([]);
  });
});

describe("renderOfferLetter", () => {
  const totals = computeOffer(STRUCTURE);

  it("substitutes every known placeholder", () => {
    const out = renderOfferLetter(
      "Hi {{candidateName}} — {{position}} at {{workspaceName}}, CTC {{annualCtc}}, net {{netPay}}, start {{startDate}}.",
      { candidateName: "Priyanka Menon", position: "Product Designer", workspaceName: "Fernly Workspace", startDate: "1 Dec" },
      totals,
    );
    expect(out).toBe("Hi Priyanka Menon — Product Designer at Fernly Workspace, CTC $94,400, net $90,000, start 1 Dec.");
  });

  it("unknown placeholders resolve to empty — braces never leak", () => {
    const out = renderOfferLetter("Hi {{candidateName}} {{totallyUnknown}}!", { candidateName: "Sam", position: "", workspaceName: "W" }, totals);
    expect(out).toBe("Hi Sam !");
    expect(out).not.toContain("{{");
  });

  it("falls back to generic wording for a blank position", () => {
    const out = renderOfferLetter("{{position}}", { candidateName: "X", position: "  ", workspaceName: "W" }, totals);
    expect(out).toBe("the role");
  });
});

describe("formatMoney", () => {
  it("groups whole dollars with an en-NZ locale", () => {
    expect(formatMoney(94_400)).toBe("$94,400");
    expect(formatMoney(0)).toBe("$0");
  });

  it("rounds cents away for clean offers", () => {
    expect(formatMoney(94_400.87)).toBe("$94,401");
  });
});
