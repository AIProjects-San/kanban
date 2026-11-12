#!/usr/bin/env bash
# ============================================================================
# verify-phase-1a.sh — Single-file Phase 1A verification (Fernly NZ statutory)
#
# Usage:
#   bash verify-phase-1a.sh                 # run from repo root
#   bash verify-phase-1a.sh /path/to/repo   # or point at repo explicitly
#
# Exit codes:
#   0 = Phase 1A COMPLETE (or COMPLETE with warnings)
#   1 = Phase 1A INCOMPLETE
#   2 = script could not start (repo not found, etc.)
#
# Instructions for AI running this script:
#   1. Save the content between ```bash and ``` as verify-phase-1a.sh
#   2. Run: bash verify-phase-1a.sh
#   3. Read the final "Phase 1A: ..." verdict
#   4. For every [FAIL] line, fix the named file/feature, then re-run
#   5. Do NOT skip warnings — they indicate items the script could not
#      verify dynamically but which must exist somewhere in the codebase.
# ============================================================================

set -uo pipefail

REPO_ROOT="${1:-$(pwd)}"
if [ ! -d "$REPO_ROOT" ]; then
  echo "ERROR: repo root '$REPO_ROOT' does not exist" >&2
  exit 2
fi
cd "$REPO_ROOT" || exit 2

if [ ! -f "prisma/schema.prisma" ]; then
  echo "ERROR: prisma/schema.prisma not found — is this the Fernly repo root?" >&2
  exit 2
fi

# ─── Colors (auto-disable when not a TTY) ───────────────────────────────────
if [ -t 1 ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; NC=""
fi

PASS=0; FAIL=0; WARN=0
declare -a FAILED=() WARNED=()
pass() { PASS=$((PASS+1)); echo "  ${GREEN}[PASS]${NC} $1"; }
fail() { FAIL=$((FAIL+1)); FAILED+=("$1"); echo "  ${RED}[FAIL]${NC} $1${2:+ — $2}"; }
warn() { WARN=$((WARN+1)); WARNED+=("$1"); echo "  ${YELLOW}[WARN]${NC} $1${2:+ — $2}"; }
section() { echo ""; echo "${BLUE}${BOLD}━━━ $1 ━━━${NC}"; }

SCHEMA="prisma/schema.prisma"

# ─── Schema helpers ────────────────────────────────────────────────────────
has_model() {
  grep -qE "^model[[:space:]]+$1[[:space:]]*\{" "$SCHEMA" 2>/dev/null
}
has_field() {
  local model="$1" field="$2"
  awk "/^model[[:space:]]+$model[[:space:]]*\{/,/^\}/" "$SCHEMA" 2>/dev/null \
    | grep -qE "^[[:space:]]*$field[[:space:]]+[A-Za-z]"
}

# ============================================================================
section "Task 0.1 — Schema: SalaryComponent statutory flags"
# ============================================================================
if has_model SalaryComponent; then
  pass "SalaryComponent model present"
  for f in taxApplicable statutoryCategory wageBaseRef isSystemGenerated; do
    has_field SalaryComponent "$f" \
      && pass "SalaryComponent.$f" \
      || fail "SalaryComponent.$f missing — add to prisma/schema.prisma"
  done
else
  fail "SalaryComponent model missing"
fi

# ============================================================================
section "Task 0.2 — Schema: EmployeeTaxProfile"
# ============================================================================
if has_model EmployeeTaxProfile; then
  pass "EmployeeTaxProfile model present"
  for f in taxCode taxCodeSource taxCodeEffectiveFrom studentLoan \
           kiwiSaverStatus kiwiSaverEmployeeRate kiwiSaverEmployerRate \
           esctRateOverride irdNumber taxCodeSpecialRate stcAccTreatment \
           stcStudentLoanRate stcCertificateExpiry employmentType \
           casualHolidayPayInWages employmentStartDate employmentEndDate \
           autoEnrolExemption autoEnrolDueDate; do
    has_field EmployeeTaxProfile "$f" \
      && pass "EmployeeTaxProfile.$f" \
      || fail "EmployeeTaxProfile.$f missing — add to prisma/schema.prisma"
  done
else
  fail "EmployeeTaxProfile model missing"
fi

# ============================================================================
section "Task 0.3 — Schema: TaxYear / TaxSlab / StatutoryRule / Payslip fields"
# ============================================================================
for m in TaxYear TaxSlab StatutoryRule; do
  has_model "$m" && pass "$m model present" || fail "$m model missing"
done
for f in employerKiwiSaverGross employerEsct employerKiwiSaverNet \
         taxCodeApplied statutoryRuleVersion; do
  has_field Payslip "$f" \
    && pass "Payslip.$f" \
    || fail "Payslip.$f missing — add to prisma/schema.prisma"
done
# PayrollRun.taxYearId used by YTD query
has_field PayrollRun taxYearId \
  && pass "PayrollRun.taxYearId present" \
  || fail "PayrollRun.taxYearId missing — required for YTD by tax year"

# ============================================================================
section "Task 0.4 — Seed script"
# ============================================================================
SEED_FILE="prisma/seed/nz-statutory.ts"
if [ -f "$SEED_FILE" ]; then
  pass "seed file exists ($SEED_FILE)"
  # The tokens pin the seed to the IR340 combined secondary rates the
  # dynamic block below constructs — seed and verify values cannot drift.
  for token in "2026-27" "156641" "2741.22" "0.0175" "0.1225" "0.1925" \
               "0.3175" "0.3475" "0.4075" "0.4675" "accInclusive" "0.035" \
               "24128" "TEMP_MAX_DAYS" "CASUAL_AGRI_MAX_MONTHS"; do
    grep -q "$token" "$SEED_FILE" \
      && pass "seed contains '$token'" \
      || fail "seed missing '$token' — add to $SEED_FILE"
  done
else
  fail "seed file missing ($SEED_FILE)"
fi
if [ -f prisma/seed.ts ] && grep -q "nz-statutory" prisma/seed.ts; then
  pass "seed.ts imports nz-statutory"
else
  warn "seed.ts does not appear to import nz-statutory"
fi

# ============================================================================
section "Task 1.1 — PAYE calculator"
# ============================================================================
PAYE_FILE="src/lib/payroll/nz/paye.ts"
if [ -f "$PAYE_FILE" ]; then
  pass "paye.ts exists"
  grep -qE "(export (async )?function|export const)[[:space:]]+calculatePaye" "$PAYE_FILE" \
    && pass "calculatePaye exported" \
    || fail "calculatePaye not exported from paye.ts"
  grep -q "accInclusive" "$PAYE_FILE" \
    && pass "accInclusive slab property referenced" \
    || fail "accInclusive slab property not referenced"
  grep -qE "stcAccTreatment|ACC_PLUS|ACC_INC" "$PAYE_FILE" \
    && pass "STC ACC treatment handled" \
    || fail "STC ACC treatment not handled in paye.ts"
  grep -qE "0\.0175|1\.75|accRate|accRule" "$PAYE_FILE" \
    && pass "ACC rate (1.75%) referenced" \
    || fail "ACC rate not referenced in paye.ts"
  grep -qE "maxLevy|2741\.22|accCap" "$PAYE_FILE" \
    && pass "ACC cap referenced" \
    || fail "ACC cap not referenced in paye.ts"
  # The Phase 1A legacy flat-slab compat layer is GONE: no slabs/accRule
  # inputs, no taxCodeGroup shape anywhere in the engine.
  if grep -qE "slabs\?:|accRule\?:|NzLegacySlab|NzLegacyAccRule" "$PAYE_FILE"; then
    fail "paye.ts still accepts the legacy slabs/accRule input shape"
  else
    pass "paye.ts accepts only the production rate-set shape"
  fi
  if grep -rq "taxCodeGroup" src/lib/payroll/nz/ 2>/dev/null; then
    fail "legacy flat-slab shape (taxCodeGroup) still referenced under src/lib/payroll/nz"
  else
    pass "no legacy flat-slab shape under src/lib/payroll/nz"
  fi
else
  fail "paye.ts missing ($PAYE_FILE)"
fi

# ============================================================================
section "Task 1.2 — KiwiSaver calculator"
# ============================================================================
KS_FILE="src/lib/payroll/nz/kiwisaver.ts"
if [ -f "$KS_FILE" ]; then
  pass "kiwisaver.ts exists"
  grep -qE "(export (async )?function|export const)[[:space:]]+calculateKiwiSaver" "$KS_FILE" \
    && pass "calculateKiwiSaver exported" \
    || fail "calculateKiwiSaver not exported"
  grep -qE "(export (async )?function|export const)[[:space:]]+resolveKiwiSaverStatus" "$KS_FILE" \
    && pass "resolveKiwiSaverStatus exported" \
    || fail "resolveKiwiSaverStatus missing — casual auto-enrolment required"
  grep -q "TEMPORARY" "$KS_FILE" \
    && pass "TEMPORARY handling present" \
    || fail "TEMPORARY handling missing"
  grep -q "CASUAL_AGRICULTURAL" "$KS_FILE" \
    && pass "CASUAL_AGRICULTURAL handling present" \
    || fail "CASUAL_AGRICULTURAL handling missing"
  grep -qE "addMonths|28|TEMP_MAX_DAYS" "$KS_FILE" \
    && pass "28-day rule referenced" \
    || fail "28-day rule not referenced"
else
  fail "kiwisaver.ts missing ($KS_FILE)"
fi

# ============================================================================
section "Task 1.3 — Student loan calculator"
# ============================================================================
SL_FILE="src/lib/payroll/nz/student-loan.ts"
if [ -f "$SL_FILE" ]; then
  pass "student-loan.ts exists"
  grep -qE "(export (async )?function|export const)[[:space:]]+calculateStudentLoan" "$SL_FILE" \
    && pass "calculateStudentLoan exported" \
    || fail "calculateStudentLoan not exported"
  grep -q "stcStudentLoanRate" "$SL_FILE" \
    && pass "STC student-loan rate handled" \
    || fail "STC student-loan rate not handled"
  grep -qE "2010\.66|PERIOD_THRESHOLDS|periodThresholds" "$SL_FILE" \
    && pass "Period thresholds referenced" \
    || fail "Period thresholds not referenced"
else
  fail "student-loan.ts missing ($SL_FILE)"
fi

# ============================================================================
section "Task 1.4 — Aggregator"
# ============================================================================
CALC_FILE="src/lib/payroll/nz/calculate.ts"
if [ -f "$CALC_FILE" ]; then
  pass "calculate.ts exists"
  grep -qE "(export (async )?function|export const)[[:space:]]+calculateNzStatutory" "$CALC_FILE" \
    && pass "calculateNzStatutory exported" \
    || fail "calculateNzStatutory not exported"
  grep -q "ruleVersion" "$CALC_FILE" \
    && pass "ruleVersion captured" \
    || fail "ruleVersion not captured — audit trail required"
else
  fail "calculate.ts missing ($CALC_FILE)"
fi

# ============================================================================
section "Task 2.1 — Payroll integration"
# ============================================================================
PAYROLL="src/server-actions/payroll.ts"
if [ -f "$PAYROLL" ]; then
  pass "payroll.ts exists"
  grep -q "calculateNzStatutory" "$PAYROLL" \
    && pass "payroll.ts calls calculateNzStatutory" \
    || fail "payroll.ts does not call calculateNzStatutory"
  grep -q "persistStatutoryLines" "$PAYROLL" \
    && pass "persistStatutoryLines present" \
    || fail "persistStatutoryLines missing — system-generated lines not written"
else
  fail "src/server-actions/payroll.ts missing"
fi

# ============================================================================
section "Task 2.2 — Persist statutory lines (ACC separate + auto-enrol)"
# ============================================================================
if [ -f "$PAYROLL" ]; then
  grep -q "isSystemGenerated" "$PAYROLL" \
    && pass "isSystemGenerated flag used" \
    || fail "isSystemGenerated flag not used"
  grep -qE "ACC earner|statutoryCategory.*ACC|\"ACC\"" "$PAYROLL" \
    && pass "ACC persisted as separate line" \
    || fail "ACC not persisted as separate line"
  grep -qE "autoEnrolTriggered|KIWISAVER_AUTO_ENROLLED" "$PAYROLL" \
    && pass "Auto-enrolment transition persisted" \
    || warn "Auto-enrolment persistence not found in payroll.ts — check service layer"
fi

# ============================================================================
section "Task 2.3 — Payslip display"
# ============================================================================
if grep -rqE "Statutory Deductions|Statutory deductions|STATUTORY" src/app src/components 2>/dev/null; then
  pass "Statutory deductions section found in UI"
else
  fail "Statutory deductions section not found in UI"
fi
if grep -rqE "ACC earner|Employer Contributions|employerKiwiSaver" src/app src/components 2>/dev/null; then
  pass "Employer contributions / ACC line found in UI"
else
  fail "Employer contributions / ACC line not found in UI"
fi

# ============================================================================
section "Task 2.4 — YTD by tax year"
# ============================================================================
if [ -f "$PAYROLL" ]; then
  grep -qE "taxYearId|taxYear" "$PAYROLL" \
    && pass "YTD query references taxYear" \
    || fail "YTD does not reference taxYear — reset logic missing"
fi

# ============================================================================
section "Task 3.1–3.4 — Admin pages"
# ============================================================================
check_page() {
  local label="$1" pattern="$2"
  if find src/app -type f -name "page.tsx" 2>/dev/null | grep -qiE "$pattern"; then
    pass "$label page exists"
  else
    fail "$label page missing (pattern: $pattern)"
  fi
}
check_page "Task 3.1 Tax slabs"            "tax/slabs"
check_page "Task 3.2 Statutory rules"      "tax/rules"
check_page "Task 3.3 Component mapping"    "tax/component-mapping"
check_page "Task 3.4 Employee tax profile" "tax-profile"

# ============================================================================
section "Task 4 — Test file present"
# ============================================================================
[ -f src/lib/payroll/nz/__tests__/golden.test.ts ] \
  && pass "golden.test.ts exists" \
  || fail "src/lib/payroll/nz/__tests__/golden.test.ts missing"
find src/lib/payroll/nz -type f -name "*.test.ts" 2>/dev/null | grep -q . \
  && pass "At least one .test.ts under nz/" \
  || fail "No .test.ts files under src/lib/payroll/nz/"

# ============================================================================
section "Dynamic calculation tests (best-effort)"
# ============================================================================
run_dynamic_tests() {
  local runner="" cmd=""
  if command -v npx >/dev/null 2>&1; then
    if npx --no-install tsx --version >/dev/null 2>&1; then
      runner="tsx"; cmd="npx --no-install tsx"
    elif npx --no-install vitest --version >/dev/null 2>&1; then
      runner="vitest"; cmd="npx --no-install vitest run"
    fi
  fi

  if [ -z "$runner" ]; then
    warn "No TS runner (tsx / vitest) available — skipping dynamic calculation tests"
    echo "        To run them: npm install --save-dev tsx, then re-run this script."
    echo "        Expected values are listed below for manual verification."
    echo ""
    echo "        ┌─────────────────────────────────────────────────────────────┐"
    echo "        │ GOLDEN PAYE VALUES (NZ 2026-27, production rate-set path)  │"
    echo "        │ M, weekly      \$1,000  → tax \$154.00   + ACC \$17.50      │"
    echo "        │ M, fortnightly \$2,000  → tax \$308.00   + ACC \$35.00      │"
    echo "        │ M, monthly     \$5,000  → tax \$851.71   + ACC \$87.50      │"
    echo "        │ M, annual      \$15,600 → tax \$1,638.00 + ACC \$273.00     │"
    echo "        │ M, annual      \$53,500 → tax \$8,270.50 + ACC \$936.25     │"
    echo "        │ M, annual      \$78,100 → tax \$15,650.50+ ACC \$1,366.75   │"
    echo "        │ M, annual      \$156,641→ tax \$41,569.03+ ACC \$2,741.22*  │"
    echo "        │ M, annual      \$200,000→ tax \$57,077.50+ ACC \$2,741.22*  │"
    echo "        │  (* = ACC capped at max levy)                              │"
    echo "        │                                                            │"
    echo "        │ Secondary/ND/CAE — IR340 COMBINED rates (levy in the tax   │"
    echo "        │ line, separate ACC line \$0):                               │"
    echo "        │ SB  weekly \$1,000 → combined 12.25% = \$122.50             │"
    echo "        │ S   monthly \$3,000 → combined 19.25% = \$577.50             │"
    echo "        │ SH  weekly \$1,000 → combined 31.75% = \$317.50             │"
    echo "        │ ST  weekly \$1,000 → combined 34.75% = \$347.50             │"
    echo "        │ SA  weekly \$1,000 → combined 40.75% = \$407.50             │"
    echo "        │ ND  weekly \$1,000 → combined 46.75% = \$467.50             │"
    echo "        │ ND  monthly \$5,000 → combined 46.75% = \$2,337.50           │"
    echo "        │ CAE weekly \$1,000 → combined 19.25% = \$192.50             │"
    echo "        │ STC 18% INC  monthly \$5,000 → tax \$900.00, no ACC        │"
    echo "        │ STC 18% PLUS monthly \$5,000 → tax \$900.00 + ACC \$87.50  │"
    echo "        │                                                            │"
    echo "        │ KiwiSaver 3.5%, monthly \$5,000, ESCT 17.5%:              │"
    echo "        │   employee \$175.00, employer gross \$175.00,             │"
    echo "        │   ESCT \$30.63, employer net \$144.37                     │"
    echo "        │                                                            │"
    echo "        │ Student loan M SL monthly \$3,000 → \$118.72              │"
    echo "        │ Student loan M SL weekly  \$500   → \$4.32                │"
    echo "        │ Student loan S SL monthly \$3,000 → \$360.00              │"
    echo "        └─────────────────────────────────────────────────────────────┘"
    return
  fi

  local tmpdir
  tmpdir=$(mktemp -d)
  cat > "$tmpdir/test.ts" <<'TS_EOF'
import { calculatePaye } from "@/lib/payroll/nz/paye";
import { calculateKiwiSaver, resolveKiwiSaverDecision, resolveKiwiSaverStatus } from "@/lib/payroll/nz/kiwisaver";
import { calculateStudentLoan } from "@/lib/payroll/nz/student-loan";

const r2 = (n: number) => Math.round(n * 100) / 100;

// The PRODUCTION rate-set shape — exactly the family prisma/seed/nz-
// statutory.ts seeds and calculate.ts resolveNzRateSet hands the engine
// (the static checks above pin the seed file to these same values):
//   payeTiers      income-tax slabs, tax-only (primary codes M/ME)
//   secondaryRates the IR340 COMBINED (PAYE + ACC) deduction rates,
//                  accInclusive — the levy rides in the rate
//   accLevy        1.75% / $156,641 liable cap / $2,741.22 annual max
//   ietc           the ME independent-earner tax credit
//   studentLoan    12% over the $24,128 annual threshold
const RATE_SET = {
  payeTiers: [
    { fromAnnual: 0, toAnnual: 15600, rate: 0.105 },
    { fromAnnual: 15600, toAnnual: 53500, rate: 0.175 },
    { fromAnnual: 53500, toAnnual: 78100, rate: 0.3 },
    { fromAnnual: 78100, toAnnual: 180000, rate: 0.33 },
    { fromAnnual: 180000, toAnnual: null, rate: 0.39 },
  ],
  secondaryRates: [
    { code: "SB", rate: 0.1225, accInclusive: true }, // 10.5% + 1.75% levy
    { code: "S", rate: 0.1925, accInclusive: true },  // 17.5% + 1.75%
    { code: "SH", rate: 0.3175, accInclusive: true }, // 30% + 1.75%
    { code: "ST", rate: 0.3475, accInclusive: true }, // 33% + 1.75%
    { code: "SA", rate: 0.4075, accInclusive: true }, // 39% + 1.75%
    { code: "ND", rate: 0.4675, accInclusive: true }, // 45% + 1.75%
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

// The engine's canonical NzTaxProfileInput (the shape toNzTaxProfile
// adapts EmployeeTaxProfile rows into).
const mk = (o: any = {}) => ({
  taxCode: "M", isCasual: false, employmentCategory: "PERMANENT",
  employmentStartDate: null, casualHolidayPayInWages: false,
  kiwiSaverStatus: "ACTIVE", kiwiSaverRate: null, employerKiwiSaverRate: null,
  esctRateOverride: null, taxCodeSpecialRate: null, stcAccTreatment: "INC",
  stcStudentLoanRate: null, stcStudentLoanThresholdApplies: true, ...o,
});

let pass = 0, fail = 0;
const t = (label: string, actual: any, expected: any) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else    { fail++; console.log(`  FAIL  ${label}  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
};

const paye = (gross: number, freq: string, p: any = mk()) => {
  const r = calculatePaye({
    gross, frequency: freq, taxProfile: p,
    payeTiers: RATE_SET.payeTiers,
    secondaryRates: RATE_SET.secondaryRates,
    accLevy: RATE_SET.accLevy,
    ietc: RATE_SET.ietc,
  });
  return { tax: r2(r.tax), acc: r2(r.acc), total: r2(r.total) };
};

// ---- Primary M: tax-only slabs + the capped levy line (UNCHANGED) ----
t("M weekly $1,000",       paye(1000, "WEEKLY"),      { tax: 154.00,   acc: 17.50,   total: 171.50 });
t("M fortnightly $2,000",  paye(2000, "FORTNIGHTLY"), { tax: 308.00,   acc: 35.00,   total: 343.00 });
t("M monthly $5,000",      paye(5000, "MONTHLY"),     { tax: 851.71,   acc: 87.50,   total: 939.21 });
t("M annual $15,600",      paye(15600, "ANNUAL"),     { tax: 1638.00,  acc: 273.00,  total: 1911.00 });
t("M annual $53,500",      paye(53500, "ANNUAL"),     { tax: 8270.50,  acc: 936.25,  total: 9206.75 });
t("M annual $78,100",      paye(78100, "ANNUAL"),     { tax: 15650.50, acc: 1366.75, total: 17017.25 });
t("M annual $156,641",     paye(156641, "ANNUAL"),    { tax: 41569.03, acc: 2741.22, total: 44310.25 });
t("M annual $200,000",     paye(200000, "ANNUAL"),    { tax: 57077.50, acc: 2741.22, total: 59818.72 });

// ---- Secondary / ND / CAE: the IR340 COMBINED rates — the whole
//      deduction in the tax line, separate ACC line $0 ----
t("SB weekly $1,000 (combined 12.25%)",  paye(1000, "WEEKLY",  mk({ taxCode: "SB" })), { tax: 122.50,  acc: 0, total: 122.50 });
t("S monthly $3,000 (combined 19.25%)",  paye(3000, "MONTHLY", mk({ taxCode: "S" })),  { tax: 577.50,  acc: 0, total: 577.50 });
t("SH weekly $1,000 (combined 31.75%)",  paye(1000, "WEEKLY",  mk({ taxCode: "SH" })), { tax: 317.50,  acc: 0, total: 317.50 });
t("ST weekly $1,000 (combined 34.75%)",  paye(1000, "WEEKLY",  mk({ taxCode: "ST" })), { tax: 347.50,  acc: 0, total: 347.50 });
t("SA weekly $1,000 (combined 40.75%)",  paye(1000, "WEEKLY",  mk({ taxCode: "SA" })), { tax: 407.50,  acc: 0, total: 407.50 });
t("ND weekly $1,000 (combined 46.75%)",  paye(1000, "WEEKLY",  mk({ taxCode: "ND" })), { tax: 467.50,  acc: 0, total: 467.50 });
t("ND monthly $5,000 (combined 46.75%)", paye(5000, "MONTHLY", mk({ taxCode: "ND" })), { tax: 2337.50, acc: 0, total: 2337.50 });
t("CAE weekly $1,000 (combined 19.25%)", paye(1000, "WEEKLY",  mk({ taxCode: "CAE" })), { tax: 192.50, acc: 0, total: 192.50 });
t("STC 18% INC $5,000",    paye(5000, "MONTHLY", mk({ taxCode: "STC", taxCodeSpecialRate: 0.18, stcAccTreatment: "INC" })),  { tax: 900.00, acc: 0,     total: 900.00 });
t("STC 18% PLUS $5,000",   paye(5000, "MONTHLY", mk({ taxCode: "STC", taxCodeSpecialRate: 0.18, stcAccTreatment: "PLUS" })), { tax: 900.00, acc: 87.50, total: 987.50 });

// KiwiSaver — the CANONICAL engine form (the payroll run's path):
// resolution from resolveKiwiSaverDecision + rate-set params.
const ksProfile = mk({ kiwiSaverRate: 0.035, employerKiwiSaverRate: 0.035 });
const ks = calculateKiwiSaver({
  gross: 5000, frequency: "MONTHLY", taxProfile: ksProfile,
  resolution: resolveKiwiSaverDecision(ksProfile, new Date("2026-11-30")),
  kiwiSaver: RATE_SET.kiwiSaver, esctTiers: RATE_SET.esctTiers,
});
t("KS 3.5% elected, ESCT 17.5% band",
  { employee: r2(ks.employee), employerGross: r2(ks.employerGross), esct: r2(ks.esct), employerNet: r2(ks.employerNet) },
  { employee: 175.00, employerGross: 175.00, esct: 30.63, employerNet: 144.37 });
const ksOptedOut = mk({ kiwiSaverStatus: "OPTED_OUT" });
const ksZero = calculateKiwiSaver({
  gross: 5000, frequency: "MONTHLY", taxProfile: ksOptedOut,
  resolution: resolveKiwiSaverDecision(ksOptedOut, new Date("2026-11-30")),
  kiwiSaver: RATE_SET.kiwiSaver, esctTiers: RATE_SET.esctTiers,
});
t("KS opted-out zeroes",
  { employee: r2(ksZero.employee), employerGross: r2(ksZero.employerGross), esct: r2(ksZero.esct), employerNet: r2(ksZero.employerNet) },
  { employee: 0, employerGross: 0, esct: 0, employerNet: 0 });

// Casual auto-enrolment (canonical profile shape)
const pEnd = new Date("2027-01-31");
t("Temp 20 days",        resolveKiwiSaverStatus(mk({ employmentCategory: "TEMPORARY", employmentStartDate: new Date("2027-01-11") }), pEnd), "NOT_ENROLLED");
t("Temp 30 days",        resolveKiwiSaverStatus(mk({ employmentCategory: "TEMPORARY", employmentStartDate: new Date("2027-01-01") }), pEnd), "ENROLLED");
t("Casual agri 2 months", resolveKiwiSaverStatus(mk({ employmentCategory: "CASUAL_AGRICULTURAL", employmentStartDate: new Date("2026-11-30") }), pEnd), "NOT_ENROLLED");
t("Casual agri 4 months", resolveKiwiSaverStatus(mk({ employmentCategory: "CASUAL_AGRICULTURAL", employmentStartDate: new Date("2026-09-15") }), pEnd), "ENROLLED");

// Student loan (production studentLoan rate-set parameter)
t("M SL monthly $3,000", r2(calculateStudentLoan({ gross: 3000, frequency: "MONTHLY", taxProfile: mk({ taxCode: "M SL" }), studentLoan: RATE_SET.studentLoan })), 118.72);
t("M SL weekly $500",    r2(calculateStudentLoan({ gross: 500,  frequency: "WEEKLY",  taxProfile: mk({ taxCode: "M SL" }), studentLoan: RATE_SET.studentLoan })), 4.32);
t("S SL monthly $3,000", r2(calculateStudentLoan({ gross: 3000, frequency: "MONTHLY", taxProfile: mk({ taxCode: "S SL" }), studentLoan: RATE_SET.studentLoan })), 360.00);

console.log("");
console.log(`  DYNAMIC: PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
TS_EOF

  echo "  Running dynamic tests via $runner..."
  if $cmd "$tmpdir/test.ts" 2>&1 | sed 's/^/  /'; then
    pass "Dynamic calculation tests passed"
  else
    fail "Dynamic calculation tests failed — see output above"
  fi
  rm -rf "$tmpdir"
}

run_dynamic_tests

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo "${BLUE}${BOLD}══════════════════════════════════════════════════════════════${NC}"
printf "  ${GREEN}PASS: %d${NC}    ${RED}FAIL: %d${NC}    ${YELLOW}WARN: %d${NC}\n" "$PASS" "$FAIL" "$WARN"
echo "${BLUE}${BOLD}══════════════════════════════════════════════════════════════${NC}"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "${RED}${BOLD}Failed items (fix these to complete Phase 1A):${NC}"
  for c in "${FAILED[@]}"; do echo "  • $c"; done
fi
if [ "$WARN" -gt 0 ]; then
  echo ""
  echo "${YELLOW}${BOLD}Warnings (verify manually):${NC}"
  for w in "${WARNED[@]}"; do echo "  • $w"; done
fi

echo ""
if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  echo "${GREEN}${BOLD}Phase 1A: COMPLETE${NC}"
  exit 0
elif [ "$FAIL" -eq 0 ]; then
  echo "${GREEN}${BOLD}Phase 1A: COMPLETE (with warnings)${NC}"
  exit 0
else
  echo "${RED}${BOLD}Phase 1A: INCOMPLETE — $FAIL item(s) to fix${NC}"
  exit 1
fi
