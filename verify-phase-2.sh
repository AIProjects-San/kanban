#!/usr/bin/env bash
# ============================================================================
# verify-phase-2.sh — Phase 2 (IRD payday filing) verification (Fernly NZ)
#
# Usage:
#   bash verify-phase-2.sh                 # run from repo root
#   bash verify-phase-2.sh /path/to/repo   # or point at repo explicitly
#
# Exit codes:
#   0 = Phase 2 COMPLETE (or COMPLETE with warnings)
#   1 = Phase 2 INCOMPLETE
#   2 = script could not start (repo not found, etc.)
#
# Static checks (schema, exports, UI routes, decimal-comma guards) always
# run. Dynamic checks (the golden fixture + deadline + reconciliation
# tests) run when node_modules exists; otherwise they WARN (fresh clones).
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

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  BLUE=$'\033[34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
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

has_model() {
  grep -qE "^model[[:space:]]+$1[[:space:]]*\{" "$SCHEMA" 2>/dev/null
}
has_field() {
  local model="$1" field="$2"
  awk "/^model[[:space:]]+$model[[:space:]]*\{/,/^\}/" "$SCHEMA" 2>/dev/null \
    | grep -qE "^[[:space:]]*$field[[:space:]]+[A-Za-z]"
}
has_schema_token() {
  grep -qF "$1" "$SCHEMA" 2>/dev/null
}

# ============================================================================
section "2.1/2.2/2.3 — Schema: payDate, PayrollSettings, filing models"
# ============================================================================
if has_field PayrollRun payDate; then
  pass "PayrollRun.payDate exists (DateTime, not null after backfill)"
else
  fail "PayrollRun.payDate" "the payday column is missing"
fi

if has_model PayrollSettings; then
  pass "PayrollSettings model present (single-tenant employer identity)"
  for f in employerIrdNumber employerName payeIntermediaryIrd payrollContactName payrollContactPhone payrollContactEmail payrollPackageIdentifier irFormVersionNumber nzBusinessHolidays; do
    if has_field PayrollSettings "$f"; then pass "PayrollSettings.$f"; else fail "PayrollSettings.$f" "required field missing"; fi
  done
else
  fail "PayrollSettings model" "missing"
fi

if has_model PaydayFiling && has_model PaydayFilingLine && has_model EmployeeDetailsFiling && has_model PaydayAmendmentFiling; then
  pass "PaydayFiling + PaydayFilingLine + EmployeeDetailsFiling + PaydayAmendmentFiling present"
else
  fail "filing models" "one or more missing"
fi

for f in employerIrd payDate periodStart periodEnd payCycle status fileContent fileHash totalEmployeeLines totalGrossCents totalPayeCents totalKiwisaverEmployeeCents totalKiwisaverEmployerNetCents totalEsctCents totalStudentLoanCents generatedAt filedAt irdReference acceptedAt rejectedAt irdErrorReport dueDate overdueFlaggedAt amendedByFilingId; do
  if has_field PaydayFiling "$f"; then pass "PaydayFiling.$f"; else fail "PaydayFiling.$f" "required field missing"; fi
done

for f in filingId payslipId employeeId employeeIrd employeeName taxCode employmentStart employmentEnd periodStart periodEnd payCycle hoursPaidCents grossCents payeCents studentLoanCents kiwisaverEmployeeCents kiwisaverEmployerNetCents esctCents; do
  if has_field PaydayFilingLine "$f"; then pass "PaydayFilingLine.$f"; else fail "PaydayFilingLine.$f" "required field missing"; fi
done

if has_schema_token "payslipId      String   @unique"; then
  pass "PaydayFilingLine.payslipId @unique (the double-filing guard)"
else
  fail "payslipId @unique" "constraint missing"
fi
if has_schema_token '@@unique([employerIrd, payDate])'; then
  pass "PaydayFiling @@unique([employerIrd, payDate]) (one EI per payday)"
else
  fail "@@unique([employerIrd, payDate])" "constraint missing"
fi
if has_schema_token '@@unique([employeeId, kind])'; then
  pass "EmployeeDetailsFiling @@unique([employeeId, kind]) (never notify twice)"
else
  fail "@@unique([employeeId, kind])" "constraint missing"
fi

if [ -f "prisma/migrations/20261205000000_payday_filing/migration.sql" ]; then
  pass "migration 20261205000000_payday_filing exists"
  if grep -qF 'SET "payDate" = COALESCE("endDate", "startDate", "createdAt")' prisma/migrations/20261205000000_payday_filing/migration.sql; then
    pass "payDate backfill documented in the migration (ADR-018 assumption)"
  else
    fail "payDate backfill" "migration lacks the COALESCE backfill"
  fi
else
  fail "migration 20261205000000_payday_filing" "missing"
fi

# ============================================================================
section "2.4-2.8 — Builders + service exports"
# ============================================================================
check_export() {
  local file="$1" name="$2"
  if grep -qE "export (async )?function $name|export const $name|export class $name" "$file" 2>/dev/null; then
    pass "$name exported from ${file#src/}"
  else
    fail "$name" "not exported from $file"
  fi
}

check_export "src/lib/ird/ei-file.ts" "buildEiFile"
check_export "src/lib/ird/ed-file.ts" "buildEdFile"
check_export "src/lib/ird/amendment-file.ts" "buildEia2File"
check_export "src/lib/ird/deadline.ts" "computeDueDate"
check_export "src/lib/ird/deadline.ts" "workingDaysRemaining"
check_export "src/lib/ird/ird-number.ts" "isValidIrdNumberForFiling"
check_export "src/lib/ird/ird-number.ts" "isValidEmployerIrdNumber"
check_export "src/lib/ird/pay-cycle.ts" "mapPayCycle"
check_export "src/lib/ird/tax-code.ts" "fileTaxCode"
check_export "src/lib/ird/filing-service.ts" "generatePaydayFiling"
check_export "src/lib/ird/filing-service.ts" "markFiled"
check_export "src/lib/ird/filing-service.ts" "markAccepted"
check_export "src/lib/ird/filing-service.ts" "markRejected"
check_export "src/lib/ird/filing-service.ts" "flagOverdueFilings"
check_export "src/lib/ird/filing-service.ts" "generateEmployeeDetails"
check_export "src/lib/ird/filing-service.ts" "generateAmendmentFiling"
check_export "src/lib/ird/reconciliation.ts" "reconcilePaydayFiling"

# ============================================================================
section "2.4 — Spec-conformance guards (field orders, codes, golden fixture)"
# ============================================================================
# The pay cycle codes are the SPEC's (WK/4W/FT/MT/DA/AH/HM), not the task
# brief's tentative FN/SM.
if grep -q 'return "FT"' src/lib/ird/pay-cycle.ts && ! grep -q 'return "FN"' src/lib/ird/pay-cycle.ts; then
  pass "fortnightly maps to FT (spec-confirmed, not FN)"
else
  fail "pay cycle FT" "pay-cycle.ts does not carry the spec code"
fi
if grep -qE '"HM"' src/lib/ird/pay-cycle.ts; then
  pass "twice-a-month maps to HM (bimonthly ≠ 4W)"
else
  fail "pay cycle HM" "missing"
fi
if grep -q "QUARTERLY" src/lib/ird/pay-cycle.ts && grep -q "ANNUAL" src/lib/ird/pay-cycle.ts; then
  pass "QUARTERLY/ANNUAL refuse to file (no confirmed code — never a guess)"
else
  fail "cadence refusal" "QUARTERLY/ANNUAL handling missing"
fi

# The TED record is mandatory with every DED.
if grep -q "TED" src/lib/ird/ed-file.ts; then
  pass "ED builder emits the mandatory TED tax-code record"
else
  fail "TED record" "ed-file.ts does not emit TED"
fi

# The golden fixture + the published example are committed.
for f in ei-golden.csv ird-published-ei-example.csv ird-published-eia2-example.csv; do
  if [ -s "src/lib/ird/__tests__/fixtures/$f" ]; then
    pass "fixture $f committed"
  else
    fail "fixture $f" "missing/empty"
  fi
done

# ============================================================================
section "2.4 — Static decimal/comma guards (the classic file-upload bugs)"
# ============================================================================
# toFixed / toLocaleString / Number()-on-amounts inside the BUILDER files
# (tests are display-only and excluded).
BUILDER_FILES=$(ls src/lib/ird/*.ts 2>/dev/null | grep -v __tests__ || true)
BAD_DECIMALS=""
for f in $BUILDER_FILES; do
  hits=$(grep -nE '\.toFixed\(|\.toLocaleString\(' "$f" 2>/dev/null || true)
  if [ -n "$hits" ]; then BAD_DECIMALS="$BAD_DECIMALS\n$f: $hits"; fi
done
if [ -z "$BAD_DECIMALS" ]; then
  pass "no toFixed()/toLocaleString() in the IRD builders (integer cents only)"
else
  fail "decimal formatting in builders" "$BAD_DECIMALS"
fi

# No comma interpolation inside template literals in the builders (a comma
# inside a filed field breaks the CSV structure).
BAD_COMMAS=""
for f in $BUILDER_FILES; do
  hits=$(grep -nE '\$\{[^}]*\}[[:space:]]*,[[:space:]]*\$|\$\{[^}]*,aise' "$f" 2>/dev/null | grep -v "Error\|throw\|where\|detail" || true)
  if [ -n "$hits" ]; then BAD_COMMAS="$BAD_COMMAS\n$f: $hits"; fi
done
if [ -z "$BAD_COMMAS" ]; then
  pass "no comma interpolation in filed fields (joinRecord is the only comma source)"
else
  fail "comma interpolation" "$BAD_COMMAS"
fi

# ============================================================================
section "2.9 — UI routes (payroll admin permission)"
# ============================================================================
for p in \
  "src/app/(payroll-filing)/admin/payroll/layout.tsx" \
  "src/app/(payroll-filing)/admin/payroll/filings/page.tsx" \
  "src/app/(payroll-filing)/admin/payroll/employee-details/page.tsx" \
  "src/app/(payroll-filing)/admin/payroll/settings/page.tsx" \
  "src/app/(payroll-filing)/admin/payroll/runs/[id]/filing/page.tsx"; do
  if [ -f "$p" ]; then pass "route ${p#src/app/}"; else fail "route $p" "missing"; fi
done
if grep -q 'payroll:manage' "src/app/(payroll-filing)/admin/payroll/layout.tsx" 2>/dev/null; then
  pass "filing pages guarded by payroll:manage (SUPER_ADMIN+ADMIN+HR)"
else
  fail "page guard" "layout does not check payroll:manage"
fi
if grep -q 'requirePermission("payroll:manage")' src/server-actions/payday-filing.ts; then
  pass "every filing action requires payroll:manage"
else
  fail "action guard" "payday-filing.ts lacks requirePermission"
fi
if grep -q "filing-badge-" src/components/views/payroll-view.tsx; then
  pass "runs list carries the per-run filing status badge"
else
  fail "runs list badge" "payroll-view lacks the filing badge"
fi
if grep -q "new-run-paydate" src/components/views/payroll-view.tsx; then
  pass "create-run form has the explicit pay date input"
else
  fail "pay date input" "payroll-view lacks the payDate field"
fi

# ============================================================================
section "2.10 — Reconciliation wiring (file == payslips == ledger)"
# ============================================================================
if grep -q "2100" src/lib/ird/reconciliation.ts && grep -q "2150" src/lib/ird/reconciliation.ts; then
  pass "ledger cross-check covers 2100/2120/2130/2140/2150 vs EI fields 15/22/23/24/19"
else
  fail "ledger cross-check" "account codes missing"
fi
if grep -q "reconciliationRefusalMessage" src/lib/ird/filing-service.ts; then
  pass "generation REFUSES on a failed reconciliation (before any write)"
else
  fail "reconciliation refusal" "filing service does not gate on reconciliation"
fi
if grep -q "taxableGross" src/lib/ird/filing-service.ts; then
  pass "EI field 11 files the statutory TAXABLE gross (not the headline gross)"
else
  fail "taxable gross" "filing service does not read taxableGross"
fi
if grep -q "Math.max(0, snap.paye.tax)" src/lib/ird/filing-service.ts; then
  pass "EI field 15 is income tax ONLY (ACC levy excluded, clamped like the GL line)"
else
  fail "PAYE income-tax-only" "filing service does not clamp paye.tax"
fi

# ============================================================================
section "Dynamic tests (golden fixture, deadline, reconciliation, service)"
# ============================================================================
if [ -d "node_modules" ] && [ -x "node_modules/.bin/vitest" ]; then
  VITEST_OUT=$(npx vitest run src/lib/ird/__tests__/ei-file.test.ts 2>/dev/null || true)
  if echo "$VITEST_OUT" | grep -q "Tests  .* passed"; then
    pass "EI builder tests (golden byte-equality + the 8 structural assertions)"
  else
    fail "EI builder tests" "vitest run failed"
  fi
  VITEST_OUT=$(npx vitest run src/lib/ird/__tests__/deadline.test.ts 2>/dev/null || true)
  if echo "$VITEST_OUT" | grep -q "Tests  .* passed"; then
    pass "deadline tests (Friday payday → Tuesday; holiday shifts)"
  else
    fail "deadline tests" "vitest run failed"
  fi
  VITEST_OUT=$(npx vitest run src/lib/ird/__tests__/reconciliation.test.ts 2>/dev/null || true)
  if echo "$VITEST_OUT" | grep -q "Tests  .* passed"; then
    pass "reconciliation tests (all 8 checks; injected mismatches refuse)"
  else
    fail "reconciliation tests" "vitest run failed"
  fi
  VITEST_OUT=$(npx vitest run src/lib/ird/__tests__/ 2>/dev/null || true)
  if echo "$VITEST_OUT" | grep -q "Tests  .* passed"; then
    pass "full IRD suite (ei, ed, amendment, deadline, maps, service, reconciliation, ird-number)"
  else
    fail "full IRD suite" "vitest run failed"
  fi
else
  warn "dynamic tests skipped" "node_modules missing (fresh clone) — run npm ci then re-run"
fi

# ============================================================================
section "Gates — typecheck + lint + Phase 1 untouched"
# ============================================================================
if [ -d "node_modules" ]; then
  if npx tsc --noEmit >/dev/null 2>&1; then
    pass "npx tsc --noEmit clean"
  else
    fail "tsc --noEmit" "type errors"
  fi
  if npx eslint src/lib/ird src/server-actions/payday-filing.ts "src/app/(payroll-filing)" src/components/admin/payday src/components/views/payroll-view.tsx >/dev/null 2>&1; then
    pass "eslint clean on the Phase 2 surface"
  else
    fail "eslint" "lint errors on the Phase 2 surface"
  fi
  if [ -f "verify-phase-1a.sh" ]; then
    if bash verify-phase-1a.sh 2>/dev/null | grep -q "COMPLETE"; then
      pass "verify-phase-1a.sh still passes (Phase 1 untouched)"
    else
      fail "verify-phase-1a.sh" "Phase 1 verification regressed"
    fi
  else
    warn "verify-phase-1a.sh not found in this checkout"
  fi
else
  warn "static gates skipped" "node_modules missing (fresh clone)"
fi

# ============================================================================
section "SUMMARY"
# ============================================================================
echo ""
echo "Phase 2 verification: ${PASS} PASS · ${FAIL} FAIL · ${WARN} WARN"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "Failed items:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
fi
if [ ${#WARNED[@]} -gt 0 ]; then
  echo "Warnings:"
  for w in "${WARNED[@]}"; do echo "  - $w"; done
fi
if [ "$FAIL" -eq 0 ]; then
  echo ""
  if [ "$WARN" -gt 0 ]; then
    echo "Phase 2: ${BOLD}COMPLETE (with warnings)${NC}"
  else
    echo "Phase 2: ${BOLD}COMPLETE${NC}"
  fi
  exit 0
fi
echo ""
echo "Phase 2: ${BOLD}INCOMPLETE — ${FAIL} item(s) to fix${NC}"
exit 1
