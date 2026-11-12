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
  for token in "2026-27" "156641" "2741.22" "0.0175" "0.1225" "0.035" \
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
    echo "        │ GOLDEN PAYE VALUES (NZ 2026-27, annualise-divide method)   │"
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
    echo "        │ SB, weekly \$1,000 → tax \$105.00, no ACC                  │"
    echo "        │ S,  monthly \$3,000 → tax \$525.00, no ACC                 │"
    echo "        │ ND, monthly \$5,000 → tax \$2,250.00, no ACC               │"
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
import { calculateKiwiSaver, resolveKiwiSaverStatus } from "@/lib/payroll/nz/kiwisaver";
import { calculateStudentLoan } from "@/lib/payroll/nz/student-loan";

const r2 = (n: number) => Math.round(n * 100) / 100;
const SLABS = [
  { taxCodeGroup: "PRIMARY", lowerBound: 0,      upperBound: 15600,  rate: 0.1225, accInclusive: true,  sortOrder: 1 },
  { taxCodeGroup: "PRIMARY", lowerBound: 15601,  upperBound: 53500,  rate: 0.1925, accInclusive: true,  sortOrder: 2 },
  { taxCodeGroup: "PRIMARY", lowerBound: 53501,  upperBound: 78100,  rate: 0.3175, accInclusive: true,  sortOrder: 3 },
  { taxCodeGroup: "PRIMARY", lowerBound: 78101,  upperBound: 156641, rate: 0.3475, accInclusive: true,  sortOrder: 4 },
  { taxCodeGroup: "PRIMARY", lowerBound: 156642, upperBound: 180000, rate: 0.3300, accInclusive: false, sortOrder: 5 },
  { taxCodeGroup: "PRIMARY", lowerBound: 180001, upperBound: null,   rate: 0.3900, accInclusive: false, sortOrder: 6 },
  { taxCodeGroup: "SECONDARY", code: "SB", rate: 0.1050 },
  { taxCodeGroup: "SECONDARY", code: "S",  rate: 0.1750 },
  { taxCodeGroup: "SECONDARY", code: "SH", rate: 0.3000 },
  { taxCodeGroup: "SECONDARY", code: "ST", rate: 0.3300 },
  { taxCodeGroup: "SECONDARY", code: "SA", rate: 0.3900 },
  { taxCodeGroup: "SECONDARY", code: "CAE", rate: 0.1925 },
];
const ACC = { rate: 0.0175, cap: 156641, maxLevy: 2741.22 };

const mk = (o: any = {}) => ({
  taxCode: "M", studentLoan: false, kiwiSaverStatus: "NOT_ENROLLED",
  kiwiSaverEmployeeRate: 3.5, kiwiSaverEmployerRate: 3.5,
  esctRateOverride: null, taxCodeSpecialRate: null, stcAccTreatment: "INC",
  stcStudentLoanRate: null, employmentType: "PERMANENT",
  casualHolidayPayInWages: false, employmentStartDate: null, employmentEndDate: null, ...o,
});

let pass = 0, fail = 0;
const t = (label: string, actual: any, expected: any) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else    { fail++; console.log(`  FAIL  ${label}  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
};

const paye = (gross: number, freq: string, p: any = mk()) => {
  const r = calculatePaye({ gross, frequency: freq, taxProfile: p, slabs: SLABS, accRule: ACC });
  return { tax: r2(r.tax), acc: r2(r.acc), total: r2(r.total) };
};

t("M weekly $1,000",       paye(1000, "WEEKLY"),      { tax: 154.00,  acc: 17.50,   total: 171.50 });
t("M fortnightly $2,000",  paye(2000, "FORTNIGHTLY"), { tax: 308.00,  acc: 35.00,   total: 343.00 });
t("M monthly $5,000",      paye(5000, "MONTHLY"),     { tax: 851.71,  acc: 87.50,   total: 939.21 });
t("M annual $15,600",      paye(15600, "ANNUAL"),     { tax: 1638.00, acc: 273.00,  total: 1911.00 });
t("M annual $53,500",      paye(53500, "ANNUAL"),     { tax: 8270.50, acc: 936.25,  total: 9206.75 });
t("M annual $78,100",      paye(78100, "ANNUAL"),     { tax: 15650.50,acc: 1366.75, total: 17017.25 });
t("M annual $156,641",     paye(156641, "ANNUAL"),    { tax: 41569.03,acc: 2741.22, total: 44310.25 });
t("M annual $200,000",     paye(200000, "ANNUAL"),    { tax: 57077.50,acc: 2741.22, total: 59818.72 });
t("SB weekly $1,000",      paye(1000, "WEEKLY", mk({ taxCode: "SB" })),     { tax: 105.00,  acc: 0, total: 105.00 });
t("S monthly $3,000",      paye(3000, "MONTHLY", mk({ taxCode: "S" })),     { tax: 525.00,  acc: 0, total: 525.00 });
t("ND monthly $5,000",     paye(5000, "MONTHLY", mk({ taxCode: "ND" })),    { tax: 2250.00, acc: 0, total: 2250.00 });
t("STC 18% INC $5,000",    paye(5000, "MONTHLY", mk({ taxCode: "STC", taxCodeSpecialRate: 18, stcAccTreatment: "INC" })),  { tax: 900.00, acc: 0,      total: 900.00 });
t("STC 18% PLUS $5,000",   paye(5000, "MONTHLY", mk({ taxCode: "STC", taxCodeSpecialRate: 18, stcAccTreatment: "PLUS" })), { tax: 900.00, acc: 87.50,  total: 987.50 });

// KiwiSaver
const ks = calculateKiwiSaver({ gross: 5000, employeeRate: 0.035, employerRate: 0.035, esctRate: 0.175, status: "ENROLLED" });
t("KS 3.5% enrolled",      { employee: r2(ks.employee), employerGross: r2(ks.employerGross), esct: r2(ks.esct), employerNet: r2(ks.employerNet) },
                            { employee: 175.00, employerGross: 175.00, esct: 30.63, employerNet: 144.37 });
t("KS not enrolled zeroes", calculateKiwiSaver({ gross: 5000, employeeRate: 0.035, employerRate: 0.035, esctRate: 0.175, status: "NOT_ENROLLED" }),
                            { employee: 0, employerGross: 0, esct: 0, employerNet: 0 });

// Casual auto-enrolment
const pEnd = new Date("2027-01-31");
t("Temp 20 days",   resolveKiwiSaverStatus(mk({ employmentType: "TEMPORARY", employmentStartDate: new Date("2027-01-11") }), pEnd), "NOT_ENROLLED");
t("Temp 30 days",   resolveKiwiSaverStatus(mk({ employmentType: "TEMPORARY", employmentStartDate: new Date("2027-01-01") }), pEnd), "ENROLLED");
t("Casual 2 months", resolveKiwiSaverStatus(mk({ employmentType: "CASUAL_AGRICULTURAL", employmentStartDate: new Date("2026-11-30") }), pEnd), "NOT_ENROLLED");
t("Casual 4 months", resolveKiwiSaverStatus(mk({ employmentType: "CASUAL_AGRICULTURAL", employmentStartDate: new Date("2026-09-15") }), pEnd), "ENROLLED");

// Student loan
const th = { WEEKLY: 464, FORTNIGHTLY: 928, MONTHLY: 2010.6667 };
t("M SL monthly $3,000", r2(calculateStudentLoan({ gross: 3000, frequency: "MONTHLY", taxProfile: mk({ taxCode: "M SL", studentLoan: true }), periodThresholds: th, standardRate: 0.12 })), 118.72);
t("M SL weekly $500",    r2(calculateStudentLoan({ gross: 500,  frequency: "WEEKLY",  taxProfile: mk({ taxCode: "M SL", studentLoan: true }), periodThresholds: th, standardRate: 0.12 })), 4.32);
t("S SL monthly $3,000", r2(calculateStudentLoan({ gross: 3000, frequency: "MONTHLY", taxProfile: mk({ taxCode: "S SL", studentLoan: true }), periodThresholds: th, standardRate: 0.12 })), 360.00);

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
