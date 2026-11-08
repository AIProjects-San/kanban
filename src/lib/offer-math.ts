// ---------------------------------------------------------------------------
// R5 — offer math + letter rendering (docs/RECRUITMENT_MODULE_PLAN.md §5).
//
// Pure functions shared by the offer builder UI and the server actions:
//   • OfferComponent — one salary line: fixed annual amount, or a % of the
//     basic component (research: PF 12%, gratuity 4.81%, KiwiSaver 3%).
//   • computeOffer(components) — resolves percentages, sums earnings /
//     employer contributions / deductions, returns CTC + net take-home.
//   • renderOfferLetter(template, vars) — placeholder substitution for the
//     letter preview (R6 reuses it for the immutable signing snapshot).
//
// All amounts are ANNUAL, whole currency units, stored as numbers in JSON.
// ---------------------------------------------------------------------------

export type OfferComponentKind =
  | "EARNING"
  | "EMPLOYER_CONTRIBUTION"
  | "DEDUCTION"
  /** PR-B03 (S8) — display-only: resolves like any component but never
   * enters earnings/deductions/net/ctc (a slip info line, e.g. a package
   * total), and payslip statistical lines never affect money. */
  | "STATISTICAL";
export type OfferComponentMode = "FIXED" | "PERCENT_OF_BASIC";

export interface OfferComponent {
  key: string;
  label: string;
  kind: OfferComponentKind;
  mode: OfferComponentMode;
  /** Annual amount (FIXED) or percentage of basic (PERCENT_OF_BASIC, 12 = 12%). */
  amount: number;
  /** PR-B02 (S6) — depends_on_payment_days, snapshotted per line. Undefined
   * or true = the line scales with the employment-window paid days and is
   * docked by loss-of-pay (the implicit pre-S6 behavior for every line).
   * false = window-exempt: flat regardless of paid days / LOP. The catalog
   * row owns the knob; structures and payslips keep snapshot copies. */
  dependsOnPaymentDays?: boolean;
}

export interface OfferTotals {
  /** Resolved annual amount per component key (percent-of-basic computed). */
  resolved: Record<string, number>;
  /** The basic component's annual amount (0 when absent). */
  basic: number;
  /** Employee-facing annual earnings. */
  earnings: number;
  /** Employer contributions on top (KiwiSaver/PF/gratuity) — part of CTC. */
  employerContributions: number;
  /** Employee-side deductions (employee PF share, etc.). */
  deductions: number;
  /** Take-home = earnings − deductions. */
  net: number;
  /** Total cost to company = earnings + employerContributions. */
  ctc: number;
}

/** The "basic" anchor component: key "basic" (case-insensitive) or the
 * first FIXED earning when no explicit basic exists (a percent-of-basic
 * component can never anchor itself). */
export function basicKeyOf(components: OfferComponent[]): string | null {
  const explicit = components.find((c) => c.key.toLowerCase() === "basic");
  if (explicit) return explicit.key;
  return components.find((c) => c.kind === "EARNING" && c.mode === "FIXED")?.key ?? null;
}

export function computeOffer(components: OfferComponent[]): OfferTotals {
  const basicKey = basicKeyOf(components);
  const basic = basicKey
    ? Math.max(0, components.find((c) => c.key === basicKey)?.amount ?? 0)
    : 0;

  const resolved: Record<string, number> = {};
  let earnings = 0;
  let employerContributions = 0;
  let deductions = 0;

  for (const c of components) {
    const raw = c.mode === "PERCENT_OF_BASIC" ? (basic * c.amount) / 100 : c.amount;
    const value = Math.round(Math.max(0, Number.isFinite(raw) ? raw : 0) * 100) / 100;
    resolved[c.key] = value;
    if (c.kind === "EARNING") earnings += value;
    else if (c.kind === "EMPLOYER_CONTRIBUTION") employerContributions += value;
    else if (c.kind === "STATISTICAL") {
      // S8 — display-only: resolved for the info line, counted nowhere.
    } else deductions += value;
  }

  return {
    resolved,
    basic,
    earnings: round2(earnings),
    employerContributions: round2(employerContributions),
    deductions: round2(deductions),
    net: round2(earnings - deductions),
    ctc: round2(earnings + employerContributions),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Parse a components JSON string defensively (schema stores TEXT). */
export function parseComponents(json: string): OfferComponent[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is OfferComponent =>
        !!c && typeof c === "object" &&
        typeof (c as OfferComponent).key === "string" &&
        typeof (c as OfferComponent).label === "string" &&
        typeof (c as OfferComponent).amount === "number" &&
        ["EARNING", "EMPLOYER_CONTRIBUTION", "DEDUCTION", "STATISTICAL"].includes((c as OfferComponent).kind) &&
        ["FIXED", "PERCENT_OF_BASIC"].includes((c as OfferComponent).mode),
    );
  } catch {
    return [];
  }
}

/** Parse a benefits JSON string (string[]) defensively. */
export function parseBenefits(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((b): b is string => typeof b === "string");
  } catch {
    return [];
  }
}

export interface LetterVars {
  candidateName: string;
  position: string;
  workspaceName: string;
  startDate?: string;
}

/** Replace {{placeholder}} tokens; unknown tokens resolve to "" (never leak
 * the braces to the candidate-facing letter). */
export function renderOfferLetter(
  template: string,
  vars: LetterVars,
  totals: Pick<OfferTotals, "ctc" | "net">,
): string {
  const map: Record<string, string> = {
    candidateName: vars.candidateName,
    position: vars.position.trim() || "the role",
    workspaceName: vars.workspaceName,
    startDate: vars.startDate ?? "",
    annualCtc: formatMoney(totals.ctc),
    netPay: formatMoney(totals.net),
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (full, name: string) =>
    name in map ? map[name] : "",
  );
}

/** $95,000 — whole-dollar grouping, no cents for clean offers. */
export function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-NZ")}`;
}
