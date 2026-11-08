# Fernly × Frappe HR — Complete Feature Parity Matrix

**Benchmark: Frappe HR (`frappe/hrms`) @ `88161025` · row-level source of truth**

| | |
| --- | --- |
| Document | `docs/Fernly_HRMS_Feature_Parity_Matrix.md` |
| Date | 2026-11-07 |
| Status | Row-level companion of the plan — **supersedes the coverage matrices of `Fernly_HR_Payroll_Enhancement_Plan.md` §6.1 and `Fernly_HR_Payroll_Parity_Reassessment.md` §5** at a finer grain; the plan remains the epic/roadmap layer |
| Benchmark state | `frappe/hrms` @ `8816102577c92979df49c20a1807b8c7ab948eb3` (`develop` tip, 2026-11-06 14:15 +0530; merge of PR #5608). Delta from the reassessment's `1c28527` is 5 commits / 4 files — appointment-letter UI polish only (Appendix B) |
| Fernly code state | `bb2e046` (`origin/main`; F1.1–F1.6 all landed — Phase 1 of the plan complete) |
| Method | Every benchmark artifact at the pin — doctype, child table, single, report, dashboard chart, number card, notification, print format, web form, web page, scheduler job, PWA API method, plus the cross-cutting behaviors (workflow states, validation chains, derivation rules) — is mapped to a Fernly surface or an explicit absence, verified in code (Appendix C lists the Fernly surface inventory) |
| Companion docs | `Fernly_HR_Payroll_Enhancement_Plan.md` (epics; families P1–P21, L1–L18, E1–E10, R1–R13, F1–F8, X1–X7), `Fernly_Domain_Modules_Architecture_Plan.md` (module-level assignment of every row — the four logic modules, added 2026-11-07), `Fernly_HR_Payroll_Parity_Reassessment.md` (findings F-R1–F-R19), `HR_MODULE_PLAN.md`, `RECRUITMENT_MODULE_PLAN.md`, `DECISIONS.md` |

---

## 1. Purpose and Method

The plan's §6.1 matrix benchmarked **77 feature families**; the reassessment refreshed their statuses. This document goes one level deeper: **every feature artifact of the benchmark, one row each**, so that "each and every feature" of frappe/hrms has a named Fernly surface (or a named absence with a reason and, where planned, the epic that closes it).

What was enumerated at the pin (reproduction: `scripts/hrms_inventory.py` over the clone in `.analysis/hrms`):

| Benchmark artifact class | Count | Notes |
| --- | --- | --- |
| Doctypes (standard / child / single) | **157** (114 hr + 43 payroll) | 75+35+4 in `hr`, 23+18+2 in `payroll`; one child table (`Appointment Letter content`) merged into its parent since the plan's `159548fa` |
| Reports | **25** (17 hr + 8 payroll) | 24 script reports, 1 query report |
| Dashboard charts (+ chart sources) | **35 + 2** (31 hr + 4 payroll) | not previously inventoried |
| Number cards | **37** (31 hr + 6 payroll) | not previously inventoried |
| Email notifications | **7** (6 hr + 1 payroll) | previously counted as 0 — they live in nested dirs the old script missed |
| Print formats | **8** (2 appointment letter, 3 job offer, 3 salary slip) | not previously inventoried |
| Web forms | **1** (`job_application`) | public application intake |
| Web pages (`www/`) | **3** (`/jobs` board, `/roster`, `/hrms`) | the `/jobs` board is the public recruitment portal |
| Scheduler jobs | **16** distinct cron jobs (hooks.py `scheduler_events`) | |
| PWA/mobile API methods | **34** whitelisted methods (`hrms/api/__init__.py`) + roster API + oauth | the mobile self-service surface |
| Roster app | separate Vue app at repo root (`roster/`) + `hrms/api/roster.py` | shift planning UI |
| Reminder engine | birthday, work anniversary, advance-holiday reminders (`hrms/controllers/employee_reminders.py`) | daily/weekly/monthly |
| Cross-module doc-event wiring | ~30 doctypes with hooks (payments, JV, employee master, boarding, telemetry) | |
| Workspaces / guided setup | 9 workspaces + `tenure/` module-onboarding steps | navigation surfaces |

Every row below carries: the benchmark artifact, its key features (states / validations / behaviors, condensed from the controllers), the Fernly surface at `bb2e046` (model / action / view, with file citations), a status, and — where relevant — the plan family and epic that covers it.

**Status legend** (as in the plan): **Parity** — functionally equivalent for Fernly's context (marked "workspace scope" where equivalence holds for a single-workspace product and the benchmark's multi-company machinery is consciously out of scope) · **Partial** — present but materially thinner than the benchmark · **Missing** — absent (planned epic named if any) · **Out of scope** — deliberately not built (ADR-014 / architecture boundary / locked product decision; reason given).

**Row ID scheme** — domains: `PR` payroll · `LV` leave & holidays · `AT` attendance & shifts · `EM` employee lifecycle · `RJ` recruitment & joining (the Onboarding module) · `PF` performance & training (HR future breadth) · `EX` expenses, travel & grievance (HR future breadth) · `PL` platform surfaces. `*-B##` rows are cross-cutting **behaviors** (validation chains, derivations, jobs); plain rows are **artifacts** (doctypes, reports, charts, …). The `Family` column links back to the plan's §6.1 family IDs.

---

## 2. Payroll Module (domain `PR`)

### 2.1 Doctype artifacts

| ID | Benchmark artifact | Key features (from controller) | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| PR-01 | `Salary Component` (36 fields, submittable) | earning/deduction/employer kinds; amount or formula+condition (AST sandbox); `depends_on_payment_days`, statistical, tax flags, flexible-benefit flag, `variable_based_on_taxable_salary`, rounding, accrual flag, payout method, per-company GL accounts | `SalaryComponent` master (F1.5: code unique, label, kind, mode FIXED/PERCENT_OF_BASIC, defaultAmount, isActive, sortOrder) + `payroll:manage` CRUD in `payroll-components.ts` + structure-editor picker + `createStructureFromOffer` auto-registration; statutory/formula fields declined | **Parity (workspace scope)** | P1 / F1.5 DONE |
| PR-02 | `Salary Detail` (child, 30 fields) | component row on structure/slip incl. formula, condition, statistical flags | embedded `OfferComponent[]` JSON on `SalaryStructure` + immutable `PayslipLine[]` snapshots on `Payslip` (snapshot discipline preserved) | Partial | P1/P8 |
| PR-03 | `Salary Structure` (submittable, 31 fields) | `payroll_frequency` (5), timesheet mode + hourly rate, `max_benefits`, is_active/is_default, company, income-tax-slab linkage | `SalaryStructure` — components JSON, one ACTIVE per employee, revision history (retire-on-revision, atomic since F1.5/F-R1), monthly only | Partial | P4/P5 / F2.x extend |
| PR-04 | `Salary Structure Assignment` (submittable, 31 fields) | temporal employee+structure+from_date+base+variable; duplicate guard; cost-center split Σ=100; opening balances; bulk-assign tool | `SalaryStructure.effectiveFrom` + revision chain (no base/variable split, no opening balances, no cost centers) | Partial | P4 |
| PR-05 | `Salary Slip` (submittable, 99 fields, 2,859 py lines) | Draft/Submitted/Cancelled/**Withheld**; 8-step pipeline; payment-days engine; YTD/MTD/per-component YTD; leave balances on slip; email on submit | `Payslip` — OPEN/LOCKED one-way, immutable lines, `lopDays`+`lopSource AUTO\|MANUAL` (F1.4), calendar-year net YTD (two bases), print modal; no email, no withheld state | Partial | P8/P10/P20 |
| PR-06 | `Salary Slip Leave` (child) | leave-driven payment-day deductions per slip (LWP + PPL fractions) | LOP derivation consumes unpaid leave days (`lop-derivation.ts`, leave-wins rule) | Partial | P7 / F1.4 DONE |
| PR-07 | `Salary Slip Loan` (child) | loan repayment rows merged into net pay | — (no lending integration) | Out of scope | P17 |
| PR-08 | `Salary Slip Timesheet` (child) | timesheet-based payroll rows | — (timesheet payroll declined, §7.0) | Out of scope | — |
| PR-09 | `Payroll Entry` (submittable, 45 fields, 2,003 py lines) | Draft/Submitted/Cancelled/Queued/Failed; employee filtering (SSA × frequency × DOJ window); >30 employees → queued with per-slip savepoints; accounting JEs; cancellation cascade | `PayrollRun` — period `YYYY-MM` unique, snapshots every active structure transactionally, one-way lock, mid-period `addPayslip`, LOP auto-derivation at creation; no queueing, no JE posting, no cancellation (locks are one-way) | Partial | P8 / F2.3 extends |
| PR-10 | `Payroll Employee Detail` (child) | per-employee rows of the batch run | implicit — run creation snapshots eligible structures | Partial | — |
| PR-11 | `Payroll Period` + `Payroll Period Date` (child) | named multi-month periods with component-level start/end dates | implicit calendar month (`"YYYY-MM"`) | Partial | P4 |
| PR-12 | `Additional Salary` (submittable, 23 fields) | universal one-off adapter — recurring or one-shot, overwrite mode, `ref_doctype/ref_docname` provenance; every special flow funnels here | manual line edits while run OPEN only (`updatePayslip`) — no persistent adjustment records | Partial | P11 / **F2.3** |
| PR-13 | `Arrear` (submittable, 481 py lines) | re-simulates every past slip under a new structure; emits positive diffs | — | Missing | P12 / F3.1 |
| PR-14 | `Payroll Correction` (+child) | reverses N LWP days of a past submitted slip | — | Missing | P12 / F3.1 |
| PR-15 | `Employee Benefit Application` (+detail child) | yearly flexi-benefit election, capped by structure `max_benefits` | — | Missing | P14 / F3.2 |
| PR-16 | `Employee Benefit Detail` (child of SSA) | per-SSA fallback benefit components | — | Missing | P14 / F3.2 |
| PR-17 | `Employee Benefit Claim` (submittable) | claims against accrued balance | — | Missing | P14 / F3.2 |
| PR-18 | `Employee Benefit Ledger` | append-only Accrual/Payout rows; claimable = accrued − paid | — (the leave-ledger pattern to borrow) | Missing | P14 / F3.2 |
| PR-19 | `Salary Withholding` (+cycle child) | Draft → Withheld → Released, driven by JE doc_events | — | Missing | P13 |
| PR-20 | `Gratuity` (submittable) | rule-driven payout doc, Draft/Unpaid/Paid | — | Missing | P16 / F3.3 |
| PR-21 | `Gratuity Rule` (+slab +applicable-component children) | slab table (years → fraction), 3 experience methods, applicable earnings | — | Missing | P16 / F3.3 |
| PR-22 | `Employee Incentive` (submittable) | one-off incentive → Additional Salary | — | Missing | — |
| PR-23 | `Retention Bonus` (submittable) | retention payout with notification | — | Missing | — |
| PR-24 | `Employee Other Income` (submittable) | other-income declaration for tax projection | — (pre-statutory, ADR-014) | Out of scope | P15 |
| PR-25 | `Income Tax Slab` (+`Taxable Salary Slab`, `Income Tax Slab Other Charges` children) | slab engine with conditions, exemption regime switch, other taxes | — (ADR-014) | Out of scope | P15 |
| PR-26–29 | `Employee Tax Exemption Category` / `Sub Category` / `Declaration` / `Proof Submission` (+2 children) | declaration-vs-proof exemption workflow | — (ADR-014) | Out of scope | P15 |
| PR-30 | `Salary Component Account` (child) | per-company GL account mapping | — (no accounting module) | Out of scope | P18 |
| PR-31 | `Employee Cost Center` (child) | payroll cost-center split | — | Out of scope | P18 |
| PR-32 | `Payroll Settings` (single, 26 fields) | `payroll_based_on`, include-holidays flags, unmarked-as-absent, half-day wage fraction, rounding toggle, email/encrypt payslips, per-employee accounting, overtime slip | workspace config module (`lib/config.ts` + settings-view) + ADR-014 statutory banner (test-pinned); most switches moot in Fernly's single-model design | Partial | — |
| PR-33 | `Bulk Salary Structure Assignment` (single, 19 fields) | bulk SSA creation tool | — (single-employee structure editor) | Missing | low |

### 2.2 Payroll behaviors (states, validations, derivations)

| ID | Benchmark behavior | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| PR-B01 | AST-sandboxed `formula`/`condition` per component | FIXED / PERCENT_OF_BASIC only — **declined** (§7.0 declination table) | Out of scope | P3 |
| PR-B02 | `depends_on_payment_days` per component | S6: `SalaryComponent.dependsOnPaymentDays` (catalog CRUD + checkbox, default true) snapshots sparsely onto structure/payslip lines (only false is stored); window-exempt lines stay flat under the S5 scaling AND stay out of the LOP basis (`lopBasisGross`) in createPayrollRun/addPayslip/updatePayslip + the modal's live preview; structure editor exposes the per-line toggle | **Parity (workspace scope)** (was Partial) | P6 / **S6 DONE** |
| PR-B03 | Statistical components (display-only totals) | S8: kind STATISTICAL on catalog/structure/offer surfaces (KIND_LABEL "Statistical (info)"); rides payslips as sparse `statistical: true` lines rendered in a "For information (not counted in pay)" block; excluded from computeOffer totals, lineSum, lopBasisGross, window scaling and the rounding line; preserved verbatim by updatePayslip (never editable) | **Parity (workspace scope)** (was Missing) | **S8 DONE** |
| PR-B04 | Flexible-benefit election & pro-rata | — | Missing | P14 / F3.2 |
| PR-B05 | Five payroll frequencies | monthly only | Partial | P5 |
| PR-B06 | Payment-days engine: DOJ/relieving clipping, include-holiday settings, half-day fractions | S5: `Payslip.paidDays` — the pure `paymentWindow` rule clips each period to [max(start, hireDate), min(end, LWD)] (holiday-aware, halves count) and earnings scale by paidDays/workingDays at run/slip creation (`scaleEarningsToPaidDays`); addPayslip joiners scale automatically; updatePayslip caps LOP at paid days; pre-S5 rows read as full-period (null). F1.1 denominator + F1.4 fractions underneath | **Parity (workspace scope)** (was Partial) | P6 / **S5 DONE** |
| PR-B07 | `consider_unmarked_attendance_as` (absent/present) | S4: `Workspace.unmarkedAttendanceMode IGNORED\|ABSENT` (Settings → General, default IGNORED = zero behavior change) feeds the pure `deriveLopDays` opts — ABSENT charges unmarked working days inside each employee's [hireDate, lastWorkingDay] window (any record, incl. PRESENT/WFH/ON_LEAVE, counts as marked; paid leave shields); derivation now reads ALL attendance statuses; payslip modal's AUTO note states the policy | **Parity (workspace scope)** (was Missing) | P6 / **S4 DONE** |
| PR-B08 | Duplicate-slip idempotency (employee+period, payroll-entry-aware) | `@@unique([runId, userId])` + period-unique run + pre-checks | **Parity** | P9 |
| PR-B09 | YTD + MTD + per-component YTD on the slip | calendar-year **net** YTD at read time; HR basis (incl. OPEN) vs ESS basis (LOCKED-only) — F-R3 documents the divergence | Partial | P10 |
| PR-B10 | One-off adjustments (recurring/one-shot, overwrite semantics) | manual OPEN-run line edits; no recurring, no overwrite mode | Partial | P11 / F2.3 |
| PR-B11 | Arrears reverse-simulation | — | Missing | P12 / F3.1 |
| PR-B12 | LWP correction reversal of past slips | — | Missing | P12 / F3.1 |
| PR-B13 | Salary withholding flow (hold cycles, release) | — | Missing | P13 |
| PR-B14 | >30-employee queued processing with per-slip savepoints | single transaction per run creation (savepoint-per-item pattern present in spirit; ≤200-employee scale) | Partial | — |
| PR-B15 | Accounting posting: accrual JE, bank JE, employer JE, cost centers | — (no accounting module) | Out of scope | P18 |
| PR-B16 | Payslip email on submit (bulk-queued, optional password-protected PDF) | print modal only; **F2.6 will ship download-only PDF** — email component descoped by locked decision §9.2 | Partial | P20 / F2.6 |
| PR-B17 | Loan repayment merge into net | — | Out of scope | P17 |
| PR-B18 | Regional statutory hook (`allow_regional`) | — (ADR-014; no statutory surface) | Out of scope | P15 |
| PR-B19 | Employer contributions display-only (never in net) | `kind EMPLOYER_CONTRIBUTION` supported and excluded from take-home (`offer-math.ts`/`payroll-math.ts`) | **Parity** | P2 |
| PR-B20 | Compensation engine: prospective SSA, derive CTC or solve base for target CTC, ctc_breakup | `offer-math.ts` computes component resolution + CTC totals on offers/structures; no solve-for-target-CTA inverse mode | Partial | R10 |
| PR-B21 | SSA opening balances (taxable/tax deducted till date) | — | Missing | P4 |
| PR-B22 | Cost-center split Σ=100% validation | — | Out of scope | P18 |
| PR-B23 | Configurable rounding policy (`disable_rounded_total`) | S7: `Workspace.payrollRoundingMode ROUND_2DP\|ROUND_NET_NEAREST` (Settings → General, default ROUND_2DP = zero behavior change). ROUND_NET_NEAREST appends an auto "Rounding" line (earning when it pays up, deduction when it docks down) so NET lands on a whole dollar while still equaling Σ lines exactly — in createPayrollRun/addPayslip/updatePayslip + the modal's live preview (auto-managed like the LOP line, replaced never duplicated) | **Parity (workspace scope)** (was Partial) | **S7 DONE** |
| PR-B24 | `email_salary_slip_to_employee` + `encrypt_salary_slips_in_emails` + password policy | — (download-only decision §9.2) | Out of scope | P20 |
| PR-B25 | `show_leave_balances_in_salary_slip` | payslip shows the LOP line only, not leave balances | Missing | — |
| PR-B26 | Overtime slip creation setting | — | Missing | L17 |
| PR-B27 | Leave-vs-Attendance proration mode switch | F1.4 hybrid: attendance (ABSENT=1, HALF_DAY=0.5) + unpaid leave, leave-wins rule, `lopSource` provenance with audited overrides | Partial | P7 / F1.4 DONE |

### 2.3 Payroll reports, charts, cards, print formats, notifications

| ID | Benchmark surface | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| PR-R01 | `salary_register` report | — (YTD panel only) | Missing | P21 / F2.6 |
| PR-R02 | `bank_remittance` report | — | Missing | P19 / F2.6 |
| PR-R03 | `salary_payments_via_ecs` report | — | Missing | P19 |
| PR-R04 | `salary_payments_based_on_payment_mode` report | — | Missing | P19 |
| PR-R05 | `employee_ctc_break_up` report | offer-level CTC breakup exists (`offer-math.ts`); no employee-level report | Missing | P21 |
| PR-R06 | `accrued_earnings_report` | — | Missing | P21 |
| PR-R07 | `income_tax_computation` report | — (ADR-014) | Out of scope | P15 |
| PR-R08 | `income_tax_deductions` report | — (ADR-014) | Out of scope | P15 |
| PR-C01 | Chart `outgoing_salary` | — | Missing | X7 |
| PR-C02 | Chart `department_wise_salary (last month)` | — | Missing | X7 |
| PR-C03 | Chart `designation_wise_salary (last month)` | — | Missing | X7 |
| PR-C04 | Chart `benefit_claims` | — | Missing | X7 |
| PR-N01–06 | Cards: total_outgoing_salary, total_salary_structure, benefit_claims, tax_exemption_proofs, total_declaration_submitted, total_incentive_given | — (payroll-view YTD panel is the only aggregate) | Missing | X7 |
| PR-P01–03 | Print formats: salary_slip_classic / compact / detailed | one payslip print layout (modal print CSS; F2.6 will formalize the PDF download) | Partial | P20 / F2.6 |
| PR-T01 | Notification `Retention Bonus` | — | Missing | — |

---

## 3. HR — Leave & Holidays (domain `LV`)

### 3.1 Doctype artifacts

| ID | Benchmark artifact | Key features (from controller) | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| LV-01 | `Leave Type` (33 fields) | LWP / partially-paid (salary fraction) / earned (frequency, allocate-on, rounding) / compensatory / carry-forward (cap + expiry days) / include-holiday / allow-negative / over-allocation / applicable-after / max-continuous / encashment knobs / optional-leave | `LeaveType` + `LeavePolicy` with the F2.4 strategy block (allocationStrategy MANUAL/ANNUAL_LUMP_SUM/EARNED/AFTER_SERVICE, accrual frequency/on-day/rounding/cap, grantOn + pro-rata, minServiceMonths, accrueDuringProbation, allowNegative + negativeFloor, carryExpiresAfterMonths, countHolidaysInLeave — `lib/leave-policy.ts`, `hr:admin` editor); still missing: partially-paid salary fraction, compensatory leave, encashment knobs (F2.2), optional-leave | Partial | L1 / **F2.4** |
| LV-02 | `Leave Policy` + `Leave Policy Detail` (child) | multi-type allocation template | `LeavePolicy` 1:1 per type (policy = type + numbers) | Partial | L2 |
| LV-03 | `Leave Policy Assignment` (submittable, 613 py lines) | assignment per employee × leave period; overlap-forbidden; bulk with per-employee savepoints; DOJ pro-rata; pre-computes earned-leave schedule | year-based entitlement per user — GRANT rows via policy/migration (F1.2 backfill); no assignment docs, no bulk tool, no pro-rata | Partial | L2 |
| LV-04 | `Leave Allocation` (submittable, 597 py lines) | validates overlap, CF caps, backdating; writes two ledger entries (new + CF parts with own expiry dates) | F2.4: strategy GRANT rows with deterministic period-key sourceIds (lazy + cron writers), year-end CARRY/EXPIRE pair capped by maxCarryOver, mid-year carry lapse; no submittable allocation documents, no per-row expiry dates (lapse is per-type), no backdating validation | Partial (improved) | L4 / **F2.4** |
| LV-05 | `Leave Application` (submittable, 1,591 py lines) | 10-step validation chain; split-at-CF-boundary consumption; attendance marking; approver chain | `LeaveRequest` PENDING → APPROVED/REJECTED → CANCELLED; 7-step chain (notice-working-days F1.2, holiday-aware counting F1.1, consecutive, overlap, balance); manager-or-admin decide; decideById/note | Partial | L5 |
| LV-06 | `Leave Ledger Entry` (submittable, 295 py lines) | append-only signed rows; is_carry_forward / is_expired; daily expiry job writes negatives | `LeaveLedgerEntry` (F1.2: GRANT/CARRY/CONSUME/EXPIRE/ADJUST + `isReversal`, polymorphic source; `LeaveBalance` a transactionally-synced derived cache; cancel writes reversal siblings; QA-1 guard = Σ deltas) | **Parity (workspace scope)** | L3 / F1.2 DONE |
| LV-07 | `Leave Block List` (+`Date`, `Allow` children) | blocked dates + department scoping + allow-list | — | Missing | L8 |
| LV-08 | `Leave Period` | named allocation windows | calendar year (implicit) | Partial | L4 |
| LV-09 | `Leave Encashment` (submittable, 384 py lines) | encashable-days math, auto-drafts daily, Draft/Unpaid/Paid, pays via Additional Salary | — | Missing | L9 / **F2.2** |
| LV-10 | `Leave Adjustment` (submittable) | HR adjustment writing ledger rows | S9: `adjustLeaveBalance` (hr:admin, HR console Requests tab → "Adjust a balance") — append-only ADJUST row (signed quarter-day delta, REASON required on the row), materialize-if-missing + cache re-sync in ONE transaction (corrections fold into `entitled` so member-facing available == Σ ledger deltas), floor-honest via the pure `planLeaveAdjustment` (never below −negativeFloor — consumption and corrections share the bound), `hr.leave_adjusted` audit with before/after | **Parity (workspace scope)** (was Partial) | L3 / **S9 DONE** |
| LV-11 | `Compensatory Leave Request` (submittable) | worked-holiday validation, ledger appends | — | Missing | L10 |
| LV-12 | `Leave Control Panel` (single, 23 fields) | bulk allocation tool | — (leave-type admin lives in settings-view) | Missing | L2 |
| LV-13 | `Holiday List` | dates, descriptions, weekly-off + half-day flags | `HolidayCalendarEntry` (F1.1: date unique, label, isHalfDay, kind PUBLIC/WEEKLY_OFF; admin CRUD; seeded current+next year) | **Parity (workspace scope)** | L18 / F1.1 DONE |
| LV-14 | `Holiday List Assignment` (submittable) | per-employee or company scoping, date-ranged | single workspace calendar — per-employee lists consciously declined (single-workspace product) | Out of scope | L7 |

### 3.2 Leave behaviors

| ID | Benchmark behavior | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| LV-B01 | LWP flag + partially-paid `fraction_of_daily_salary_per_leave` | boolean `paid` only (unpaid days charge full LOP) | Partial | L1 |
| LV-B02 | Earned-leave frequency, allocate-on-day, rounding | EARNED strategy: accrualFrequency MONTHLY/QUARTERLY/HALF_YEARLY/ANNUAL, allocateOnDay FIRST/LAST/DOJ_DAY, accrualRounding FLOOR_QUARTER/NEAREST + December true-up (`lib/leave-policy.ts`, cron + lazy writers) | **Parity (workspace scope)** | L11 / **F2.4 DONE** |
| LV-B03 | Compensatory-leave worked-holiday validation | — | Missing | L10 |
| LV-B04 | Carry-forward cap + expiry days (daily job) | F2.4: the daily leave-allocation job writes the year-end CARRY (≤ maxCarryOver) + EXPIRE pair and the carryExpiresAfterMonths lapse (idempotent sourceIds `carry`/`carry-expire`/`carry-lapse`) | **Parity (workspace scope)** | L4 / **F2.4 DONE** |
| LV-B05 | include-holiday-in-leave-count setting | F2.4: `countHolidaysInLeave` per type — full holidays consume a leave day, half-day entries still count 0.5 (server + live preview) | **Parity (workspace scope)** | L7 / **F2.4 DONE** |
| LV-B06 | allow-negative / over-allocation switches | F2.4: `allowNegative` + `negativeFloor` per type; the floor-aware guard (request + approval) allows spending into an advance down to −floor; negative balances render as "N days in advance" | **Parity (workspace scope)** | L1 / **F2.4 DONE** |
| LV-B07 | `applicable_after` days-in-service before leave allowed | F2.4: `minServiceMonths` gates submission (LV-B07) and doubles as AFTER_SERVICE's deposit threshold; no hire date on record passes (unknown ≠ ineligible) | **Parity (workspace scope)** | L1 / **F2.4 DONE** |
| LV-B08 | Max-consecutive-days walk across adjacent applications | per-request `maxConsecutiveDays` guard; cross-request walk unverified/absent | Partial | L5 |
| LV-B09 | Block-list validation with department scoping | — | Missing | L8 |
| LV-B10 | Salary-processed guard (LWP cannot overlap a processed slip) | S10: createLeaveRequest refuses UNPAID-type ranges whose months (pure `monthsInRange`) intersect a LOCKED run's period — processed pay is immutable, so unpaid leave can't dock it retroactively; paid types and OPEN runs stay correctable | **Parity (workspace scope)** (was Missing) | L5 / **S10 DONE** |
| LV-B11 | Attendance conflict guard in the leave chain | S11: createLeaveRequest refuses ranges carrying an explicit mark (PRESENT/ABSENT/HALF_DAY/WFH — DERIVED ON_LEAVE rows never conflict), naming up to three date+status pairs — attendance and leave never double-encode the same day; derivation both directions stays (F1.3) | **Parity (workspace scope)** (was Partial) | L5 / **S11 DONE** |
| LV-B12 | Self-approval policy per leave type | requests decided by manager-of-requester or ADMIN/HR only — the benchmark's default posture, fixed | **Parity** | L5 |
| LV-B13 | Approver chain: employee-level → department → workflow | manager → ADMIN/HR (no department approver wiring) | Partial | E1/L5 |
| LV-B14 | Balance-for-consumption = min(balance, days left in allocation) | annual-entitlement model; invariant `used == Σ CONSUME` maintained transactionally | Partial | L5 |
| LV-B15 | Consumption split at allocation / CF-expiry boundaries | — (no CF today) | Missing | L4 / F2.4 |
| LV-B16 | Auto-encashment drafts for allocations ended yesterday (daily job) | — | Missing | L9 / F2.2 |
| LV-B17 | Allocation pro-rata by joining date | — | Missing | L2 |
| LV-B18 | Earned-leave schedule: retries, failure reasons, HR email | F2.4: the job counts + logs failed pairs (savepoint-per-pair, the pass survives) and is idempotent; no retry queue, no failure-reason records, no HR email | Partial | L11 / **F2.4** |
| LV-B19 | Half-day leave application semantics | half-day exists only as holiday/LOP fractions (F1.1/F1.4), not as request shape | Missing | L6 / F2.9 |

### 3.3 Leave reports, charts, cards, notifications, jobs

| ID | Benchmark surface | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| LV-R01 | `employee_leave_balance` report | leave-view shows own balances; HR queue shows per-request days (no report view) | Partial | X7 |
| LV-R02 | `employee_leave_balance_summary` report | — | Missing | X7 / F3.9 |
| LV-R03 | `leave_ledger` report | ledger rows exist (F1.2) but no ledger report/view | Missing (cheap win — data exists) | X7 / F3.9 |
| LV-R04 | `employees_working_on_a_holiday` report | — | Missing | X7 |
| LV-C01 | Chart `leave_applications_by_type` | — | Missing | X7 |
| LV-N01 | Card `number_of_employees_on_leave (today)` | — | Missing | X7 |
| LV-N02 | Card `number_of_employees_on_leave (this month)` | — | Missing | X7 |
| LV-N03 | Card `holidays_in_this_month` | — | Missing | X7 |
| LV-T01 | Notification `Leave Application Pending Approval` (email, Save) | in-app Notification on request (no email — F-R17: zero mail side effects in HR) | Partial | X6 |
| LV-T02 | Notification `Leave Application Status Update` (email, Submit) | in-app Notification on decision (no email) | Partial | X6 |
| LV-T03 | Notification `Leave Application Cancelled` (email, Cancel) | — | Missing | X6 |
| LV-J01 | Daily job `process_expired_allocation` | — (F2.4's year-end EXPIRE writes; cron pattern proven by `/api/cron/prune-audit`) | Missing | L4 / F2.4 |
| LV-J02 | Daily job `generate_leave_encashment` | — | Missing | L9 / F2.2 |
| LV-J03 | Daily job `allocate_earned_leaves` | F2.4: `/api/cron/leave-allocation` (CRON_SECRET bearer, own maintenance-lock key, idempotent period-key grants) wired into the compose scheduler's daily pass | **Parity (workspace scope)** | L11 / **F2.4 DONE** |

---

## 4. HR — Attendance & Shifts (domain `AT`)

### 4.1 Doctype artifacts

| ID | Benchmark artifact | Key features (from controller) | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| AT-01 | `Attendance` (submittable, 555 py lines) | Present/Absent/On Leave/Half Day (+half_day_status)/WFH; late-entry/early-exit flags; in/out times; working hours; shift linkage; duplicate row-lock guard | `AttendanceRecord` (F1.3: 5 statuses incl. ON_LEAVE, inTime/outTime optional, note, source MANUAL/IMPORT/DERIVED; unique user+date; HR marking at `attendance:manage`) + S2 timing facts (lateMinutes/earlyMinutes/workingHours derived at write time vs the workspace default day) — no shift linkage (F3.5) | Partial | L12 / F1.3 DONE |
| AT-02 | `Attendance Request` (submittable, 421 py lines) | employee correction flow (WFH/On Duty over a range); shift-consistency; Skip/Overwrite semantics | — (**declined by locked decision §9.1: no member self-marking**, ever) | Out of scope | L13 |
| AT-03 | `Employee Checkin` (514 py lines) | device/API IN-OUT log with lat/long, geo-fencing radius vs shift locations, auto-attendance pairing | — (hardware boundary; manual + future CSV import) | Out of scope | L14 |
| AT-04 | `Shift Type` (546 py lines) | timing windows, check-in/out buffers, grace, pairing modes, auto-attendance thresholds | — | Missing | L15 / F3.5 |
| AT-05 | `Shift Assignment` (submittable, 740 py lines) | Active/Inactive; overlap-of-timings validation incl. midnight wrap; nightly expiry job | — | Missing | L15 / F3.5 |
| AT-06 | `Shift Request` (submittable) | Draft → Approved/Rejected; approver chain; creates assignments | — | Missing | L15 |
| AT-07 | `Shift Schedule` (submittable) + `Shift Schedule Assignment` | materialize assignments ~90 days ahead via hourly job (`create_shifts_after` watermark) | — | Missing | L16 |
| AT-08 | `Shift Location` | named locations for geo-fencing | — | Missing | L15 |
| AT-09 | `Overtime Type` + `Overtime Slip` (+`Overtime Details`, `Overtime Salary Component` children) | fixed-hourly vs component-based calc; standard/weekend/holiday multipliers; caps; slips span a payroll period and submit Additional Salary rows | — | Missing | L17 |
| AT-10 | `Employee Attendance Tool` (single) | bulk marking grid | monthly grid in `hr-attendance.tsx` (HR marking, 500-member cap — F-R15 pagination note) | Partial | L12 |
| AT-11 | `Shift Assignment Tool` (single) | bulk shift assignment | — | Missing | L15 |
| AT-12 | Roster app (repo-root `roster/` Vue app + `hrms/api/roster.py` + `www/roster`) | shift planning UI | — | Missing | L16 |

### 4.2 Attendance behaviors

| ID | Benchmark behavior | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| AT-B01 | `half_day_status` on attendance | HALF_DAY status exists (F1.3) and drives 0.5 LOP (F1.4) — the payroll-relevant half | Partial | L6 / F1.3+F1.4 |
| AT-B02 | Late-entry / early-exit flags | S2: derived at write time by the pure kernel `lib/attendance-flags.ts` against the workspace default day (`Workspace.attendanceDayStart/End`, Settings → General, defaults 09:00/17:30 — policy-as-data); stored `lateMinutes/earlyMinutes` (null = not computable), rendered as badges in My-attendance + tooltips in the grid + a live preview in the marking modal; a config change never retro-rewrites history | **Parity (workspace scope)** (was Missing) | L12 / **S2 DONE** |
| AT-B03 | Working-hours computation from in/out | S2: `workingHours` (Float, 2-dec) rides the same derivation + columns; shown as "7h 45m worked" | **Parity (workspace scope)** (was Missing) | L12 / **S2 DONE** |
| AT-B04 | Duplicate guard per employee+date with row locks | unique(user, date) + upsert semantics | **Parity** | L12 / F1.3 |
| AT-B05 | Skip/Overwrite correction semantics | — (declined with AT-02) | Out of scope | L13 |
| AT-B06 | Geo-fencing radius vs shift locations | — | Out of scope | L14 |
| AT-B07 | Check-in pairing modes + grace periods → auto attendance | — | Out of scope | L14 |
| AT-B08 | Unmarked days as absent (bounded by shift buffers) | S4/PR-B07: unmarked-as-absent is workspace-configurable (`unmarkedAttendanceMode`), bounded by the employment window (hireDate→LWD) instead of shift buffers (no shifts until F3.5); default IGNORED | **Parity (workspace scope)** (was Missing) | P6 / **S4 DONE** |
| AT-B09 | Attendance → payroll proration | F1.4 derivation: ABSENT=1, HALF_DAY=0.5 + unpaid leave, leave-wins, `lopSource AUTO\|MANUAL`, audited overrides, LOP line at creation | Partial | P7 / F1.4 DONE |
| AT-B10 | Shift overlap validation incl. midnight wrap | — | Missing | L15 |
| AT-B11 | Nightly shift-assignment expiry | — | Missing | L15 |
| AT-B12 | 90-day shift materialization watermark job | — | Missing | L16 |
| AT-B13 | Overtime multipliers + caps | — | Missing | L17 |
| AT-B14 | Overtime → Additional Salary bridge | — | Missing | L17 |
| AT-B15 | Leave↔attendance cross-derivation | F1.3 both directions (approve → ON_LEAVE; cancel → rows removed); leave days block time-logging (`findApprovedLeaveOn`, F-R19) | **Parity (workspace scope)** | L12 / F1.3 |

### 4.3 Attendance reports, charts, cards, jobs

| ID | Benchmark surface | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| AT-R01 | `monthly_attendance_sheet` report (P/A/HD/H/WO/L grid) | monthly grid view (`hr-attendance.tsx`, `getAttendanceMonth`; `my-attendance-view` self-service) | Partial | X7 / F3.9 |
| AT-R02 | `shift_attendance` report | — | Missing | X7 |
| AT-C01 | Chart `attendance_count` | — | Missing | X7 |
| AT-C02 | Chart `shift_assignment_breakup` | — | Missing | X7 |
| AT-N01–04 | Cards: total_present / total_absent / late_entry / early_exit (this month) | — | Missing | X7 |
| AT-J01 | Hourly job `update_last_sync_of_checkin` | — | Out of scope | L14 |
| AT-J02 | Hourly job `process_auto_attendance_for_all_shifts` | — | Out of scope | L14 |
| AT-J03 | Hourly job `process_auto_shift_creation` | — | Missing | L16 |
| AT-J04 | Daily job `mark_expired_shift_assignments_as_inactive` | — | Missing | L15 |

---

## 5. HR — Employee Lifecycle (domain `EM`)

The benchmark's `Employee` doctype lives in ERPNext but is functionally owned by hrms (overrides in `hrms/overrides/employee_master.py`). Its lifecycle machinery is mapped here.

### 5.1 Doctype artifacts

| ID | Benchmark artifact | Key features (from controller) | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| EM-01 | `Employee` master | naming by series/number/full-name; status Active/Inactive/Suspended/Left + relieving date + retirement age; grouping axes; approver wiring; Internal Work History; onboarding-process gate; applicant/offer back-flip on creation | `User` + `EmployeeProfile` (jobTitle, department, managerId, hireDate, contact, skills, notes; org chart via managerId; team roster) + `users.ts`/`members.ts` | Partial | E1 |
| EM-02 | Employee status lifecycle (Active/Inactive/Suspended/Left) | status field + relieving date + retirement-date math | `employmentStatus` "" / PROBATION / ACTIVE / SUSPENDED / EXITED + `probationEndsAt` / `noticePeriodWeeks` / `lastWorkingDay` (F1.6); single guarded writer `transitionEmployment` (`hr:admin`, `employment.ts`); legal-arc machine; §9.3 probation-review hard gate; EXITED requires lastWorkingDay; audit per transition; QA-19 ""-not-tracked | **Parity (workspace scope)** | E2 / F1.6 DONE |
| EM-03 | Employee grouping axes (branch / grade / employment type) | org slicing everywhere | department + jobTitle + manager only | Partial | E1 |
| EM-04 | Employee leave/expense approver wiring | per-employee approver fields; automatic role grants + doc sharing | requester's-manager rule + static role floor with DB permission ceiling; no per-employee override | Partial | E1 |
| EM-05 | `Internal Work History` (child) | branch/designation/department snapshots with from/to maintained on every change | — (generic AuditLog before/after only) | Missing | E3 / F2.5 |
| EM-06 | `Employee Property History` (child) | property/current/new diffs powering Promotion/Transfer | generic `AuditLog` (before/after JSON) — no structured property diffs | Partial | E3 / F2.5 |
| EM-07 | `Employee Promotion` (submittable) | property-diff doc; updates Employee + maintains history | — | Missing | E6 / **F2.5** |
| EM-08 | `Employee Transfer` (submittable) | property-diff doc; relocation semantics; history maintenance | — | Missing | E6 / F2.5 |
| EM-09 | `Employee Grade` | grade master used across payroll/leave rules | — | Missing | E1 |
| EM-10 | `Employment Type` | Full-Time/Part-Time/… master | — (deliberately out of scope per reassessment E2 note) | Out of scope | E2 |
| EM-11 | `Employee Onboarding` (submittable, 128 py lines) | creates Project + Tasks from template; `boarding_status` derived from Project percent; gates employee creation | `OnboardingChecklist` + `OnboardingTask` (F2.10: tasks instantiate from the configurable `OnboardingTemplateTask` source via ONE shared path; createChecklist auto-assigns; auto-complete; markJoined creates a checklist) | Partial | E4 |
| EM-12 | `Employee Onboarding Template` (+`Employee Boarding Activity` child) | ordered activities; `user` XOR `role` assignee; begin-on offset in days; duration; `required_for_employee_creation`; holiday-aware task dates | **F2.10 (F-R8):** `OnboardingTemplateTask` table (both kinds, `onboarding:manage` CRUD in the HR console, constants as empty-table fallback) — no user-XOR-role assignee, no per-task required flag, no holiday-aware dates | Partial | E4 |
| EM-13 | Onboarding gate on employee creation (`IncompleteTaskError`) | every `required_for_employee_creation` task must be Completed | **F2.10 (F-R9/E5):** `markJoined` refuses while any mandatory document is un-VERIFIED or any background check is non-terminal — `Workspace.joiningGateEnabled`, default on, refusal lists the blockers (documents/BGV play the required-task role at workspace scope) | **Parity (workspace scope)** | E5 |
| EM-14 | `Employee Separation` + Template | symmetric template flow gating the exit | F2.1: separation checklists reuse the onboarding machinery verbatim — `OnboardingChecklist.kind = SEPARATION`, a 5-task default template (handover, device return, access revocation, exit interview, FnF settlement), manager auto-assignment, auto-completion, `addTask`/`setTaskDone`; the template itself stays hard-coded (unification rides F2.10's onboarding-template work) | Partial | E7 / **F2.1** |
| EM-15 | `Exit Interview` (submittable, 177 py lines) | Pending → Scheduled → Completed/Cancelled; one per employee; questionnaire email-once via template + web form | F2.1: `ExitInterview` with the exact status machine (one LIVE record per employee, CANCELLED kept as history), interviewer + notes, in-app scheduling notification (EM-T01 lite); the questionnaire email/web form is not built (EM-B11) | Partial | E8 / **F2.1** |
| EM-16 | `Full and Final Statement` (submittable, 455 py lines) + `Full and Final Asset` / `Outstanding Statement` children | auto-assembles payables (withheld salary, gratuity, claims, bonuses, encashment) and receivables (advances, loans); asset reconstruction from Asset Movements; blocks settlement while unsettled; reactive JE status flips | F2.1 lite: `FullAndFinalStatement` — computed live on every read (OPEN-run salary + paid-type encashment − advance-leave recovery, `lib/full-and-final.ts`), UNSETTLED → SETTLED freezes amounts + audits + locks payslip editing; bonuses (F2.3), advances/loans (F2.8), gratuity (F3.3) extend the line set when they land; asset reconstruction declined (EM-B13) | Partial | E9 / **F2.1** |
| EM-17 | `Employee Referral` (submittable) | unique per email; Pending/In Process/Accepted/Rejected/Cancelled; referral-bonus payout riding Additional Salary | — | Missing | R4 |
| EM-18 | `Employee Skill Map` (+`Employee Skill`, `Skill Assessment` children) | per-employee skill ratings by designation skill set | free-text `skills` on `EmployeeProfile` | Partial | F8 |
| EM-19 | `Skill` master | shared between skill maps and interview Expected Skill Sets | — (free-text) | Partial | F8/R9 |
| EM-20 | `Employee Health Insurance` | 1-field stub in the benchmark | — | Missing (benchmark stub) | — |
| EM-21 | `Identification Document Type` | doc-type master for employee identification | `DocumentTypeConfig` exists for **candidate** documents (`hiring.ts` document types CRUD) — not employee docs | Partial | — |
| EM-22 | `Interest` (lending stub) | loan interest config | — | Out of scope | P17 |
| EM-23 | `HR Settings` (single, 52 fields) | reminders, approvals, stop-birthday-reminders, exit settings, retrenchment… | workspace config module (`lib/config.ts`, settings-view) — a fraction of the switches, all workspace-scoped | Partial | — |
| EM-24 | `HR Telemetry Milestone` | usage telemetry | — (deliberate: no product telemetry; `observability.ts` is ops-only) | Out of scope | — |
| EM-25 | `PWA Notification` | push-notification store for the mobile app | — (no mobile app) | Missing | PL |

### 5.2 Lifecycle behaviors

| ID | Benchmark behavior | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| EM-B01 | Employee naming (series / employee number / full name) | deterministic seed emails + cuid ids; no employee-number series | Partial | E1 |
| EM-B02 | Relieving date + retirement-age math | `lastWorkingDay` (F1.6) on the EXITED arc; retirement-age concept declined | Partial | E2 |
| EM-B03 | Work-history rows maintained on every employee change | — (audit log only) | Missing | E3 / F2.5 |
| EM-B04 | Approver role auto-grant + doc sharing on approver wiring | static ROLE_PERMISSIONS floor + DB-granted ceiling (`rbac.ts`, F1.5's `checkPermission`); no per-approver grants | Partial | E1 |
| EM-B05 | Onboarding task dates pushed off holidays | — (checklist tasks carry no dates) | Missing | E4 |
| EM-B06 | Task assignee = `user` XOR `role` (all role holders) | assignee = single user (manager default via the ONE shared instantiation — F2.10 closed the markJoined drift) | Partial | E4 |
| EM-B07 | `boarding_status` derived from Project.percent_complete (never hand-edited) | checklist completion derived from task facts (auto-completes) | **Parity (workspace scope)** | E4 |
| EM-B08 | Employee creation gated on required tasks (`IncompleteTaskError`) | **F2.10:** the joining gate (mandatory docs VERIFIED + BGV terminal, configurable, default on) — documents/checks instead of boarding tasks | Partial | E5 |
| EM-B09 | Employee creation back-flips Job Applicant + Job Offer to Accepted | `markJoined` sets Candidate → HIRED (+ offer stays SIGNED) inside the provisioning transaction | **Parity (workspace scope)** | — |
| EM-B10 | Property-diff application (promotion/transfer) with history | — | Missing | E6 / F2.5 |
| EM-B11 | Exit questionnaire email-once | — (F2.1 records interviewer + outcome notes in-app; the questionnaire email/web form itself is deferred with the email-notification work) | Missing | E8 / X6 |
| EM-B12 | FnF auto-assemble payables/receivables | F2.1: `computeFullAndFinal` auto-assembles the modeled facts — every OPEN run's payslip net (paid runs are not owed), paid-type positive balances as encashment, paid-type negative balances as advance-leave recovery at the daily rate (monthly gross ÷ the LWD month's holiday-aware working days); unpaid types excluded with a note | Partial | E9 / **F2.1** |
| EM-B13 | FnF asset-obligation reconstruction (Asset Movements) | — (no asset module) | Out of scope | E10 |
| EM-B14 | FnF settlement gate + reactive status flips on JE submit | F2.1 lite: UNSETTLED → SETTLED is a one-way freeze of the live amounts (audited with the totals) that also locks payslip editing (`updatePayslip`/`addPayslip` refuse a settled employee); no Journal-Entry coupling — payroll stays single-writer by design | Partial | E9 / **F2.1** |
| EM-B15 | Probation confirmation (date-driven in benchmark) | F1.6 **hard gate**: PROBATION → ACTIVE refused unless a PROBATION-kind review reached REVIEWED/ACKNOWLEDGED — deliberately stricter than the benchmark | **Parity+ (stricter by design)** | E2 / F1.6 DONE |
| EM-B16 | Suspension / reinstatement arcs | F1.6 legal arcs: ACTIVE↔SUSPENDED, EXITED terminal, no PROBATION→SUSPENDED bypass | **Parity (workspace scope)** | E2 / F1.6 DONE |

### 5.3 Lifecycle reports, charts, cards, notifications, jobs

| ID | Benchmark surface | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| EM-R01 | `employee_analytics` report | analytics-view (role-scoped hours/activity; PR-63) — not headcount analytics | Partial | X7 |
| EM-R02 | `employee_information` report | directory view (`hr-directory.tsx`, `getDirectory`) + org chart | Partial | X7 |
| EM-R03 | `employee_birthday` report | — (`lib/greeting.ts` is a time-of-day greeting, not birthdays) | Missing | X7 / F3.10 |
| EM-R04 | `employee_exits` report (exit + FnF pending) | — | Missing | X7 / F3.9 |
| EM-C01–04 | Charts `employees_by_age` / `by_branch` / `by_grade` / `by_type` | — | Missing | X7 |
| EM-C05 | Chart `gender_diversity_ratio` | — | Missing | X7 |
| EM-C06/07 | Charts `department_wise_employee_count` / `designation_wise_employee_count` | directory/roster show counts by area (no chart) | Partial | X7 |
| EM-C08/09 | Charts `y_o_y_promotions` / `y_o_y_transfers` | — | Missing | X7 / F2.5 |
| EM-N01 | Card `total_employees` | team roster + directory counts | Partial | X7 |
| EM-N02–07 | Cards new_hires / employees_joining / employees_relieving / employee_exits / separations / onboardings | directory status badge (F1.6) surfaces probation/active/exited per person — no aggregates | Missing | X7 / F3.9 |
| EM-T01 | Notification `Exit Interview Scheduled` (email, Days Before) | F2.1 lite: in-app Notification to the employee on schedule/reschedule (immediate, not days-before; no email — the F-R17 zero-mail discipline) | Partial | X6 / **F2.1** |
| EM-J01 | Daily job `send_birthday_reminders` | — | Missing | X6 / **F3.10** |
| EM-J02 | Daily job `send_work_anniversary_reminders` | — | Missing | X6 / F3.10 |
| EM-J03 | Weekly/monthly jobs `send_reminders_in_advance` (holiday reminders) | — | Missing | X6 / F3.10 |

---

## 6. Onboarding Module — Recruitment & Joining (domain `RJ`)

Fernly's hiring module (plan families R1–R13 + joining formalities) is the mapping target for the benchmark's entire recruitment funnel and the offer→join chain.

### 6.1 Doctype artifacts

| ID | Benchmark artifact | Key features (from controller) | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| RJ-01 | `Job Requisition` (25 fields) | Pending → Open & Approved / Rejected / Filled / On Hold / Cancelled; time-to-fill | — | Missing | R1 / F3.6 |
| RJ-02 | `Staffing Plan` (+`Detail` child) | per-company/date-range vacancy budgeting per designation; parent/subsidiary roll-up; `positions = vacancies + current` | — | Missing | R2 / F3.6 |
| RJ-03 | `Job Opening` (WebsiteGenerator, 36 fields) | publishes to `jobs/<company>/<title>`; daily auto-close; staffing-plan vacancy enforcement; publish salary range & applications-received toggles | — (candidates created manually) | Missing | R3 / **F3.6** |
| RJ-04 | `Job Opening Template` | reusable opening fields | — | Missing | R3 |
| RJ-05 | `/jobs` www page + `job_application` web form | public board with filters/sort/pagination; public application intake | — (no public intake; the only public route is `/offer/[token]`) | Missing | R3 / F3.6 |
| RJ-06 | `Job Applicant` (295 py lines) | email-named; status Open/Replied/Shortlisted/Rejected/Hold/Accepted; Kanban; sources; referrals | `Candidate` — status ACTIVE → SELECTED → HIRED / REJECTED / WITHDRAWN (+ REACTIVATE; reject reason required); duplicate-email guard; snapshot stages | **Parity (workspace scope)** | R5 |
| RJ-07 | `Job Applicant Source` | source master + referral payouts | free-text `source` field on Candidate | Partial | R4 |
| RJ-08 | `Interview` (submittable, 474 py lines) | rounds from Interview Type; Pending → Under Review → Cleared/Rejected/Cancelled; reminder scheduler; reschedule emails | `CandidateStage` (interview-kind stages: PENDING → IN_PROGRESS → PASSED/FAILED/SKIPPED) + `scheduleInterview` (±59-min interviewer conflict check, CalendarEvent + Reminder) | **Parity (workspace scope)** | R7 |
| RJ-09 | `Interview Type` (+`Expected Skill Set` child) | round templates with per-skill expected ratings + target average | stage `type` labels only (SCREENING/INTERVIEW/ASSESSMENT/BG_CHECK/DOCUMENTS/OFFER/CUSTOM) | Partial | R9 / **F2.9** |
| RJ-10 | `Interview Feedback` (submittable) + `Interviewer`/`Interview Detail` children | one per interviewer; per-skill 0–1 ratings → average; interview rating = mean of feedbacks | scorecard on the stage (rating 1–5 + strengths/concerns + STRONG_HIRE…NO_HIRE recommendation); `saveScorecard` owner-scoped (P0-5); one scorecard per interviewer per stage | **Parity (workspace scope)** | R8 |
| RJ-11 | `Job Offer` (submittable, 62 fields, 507 py lines) | Draft → Ready to Send → Awaiting Response → Accepted/Rejected/Cancelled; status advances on actual sent communication; duplicate-applicant guard; vacancy validation; compensation engine; term templates | `OfferRecord` — DRAFT → APPROVED → SENT → SIGNED/DECLINED/EXPIRED (F2.10: manager four-eyes approval, EXPIRED outcome lazily lapsed, decline honors expiry); 7-day single-use token; typed full-name signature; immutable after send; `sendOffer` mailStatus-honest; start date on the record | **Parity (workspace scope)** | R10 / F2.10 |
| RJ-12 | `Job Offer Component` (child) | earnings/deductions/employer rows on the offer | `OfferComponent[]` (kind EARNING/DEDUCTION/EMPLOYER_CONTRIBUTION; mode FIXED/PERCENT_OF_BASIC; annual amounts) | **Parity** | R10/P2 |
| RJ-13 | `Job Offer Term Template` + `Offer Term` | reusable term rows rendered into letters | `OfferTemplate` body + LetterVars — F2.10 closed F-R11: `OfferRecord.startDate` feeds `{{startDate}}` at generation (no reusable term rows) | Partial | R10 / F2.10 |
| RJ-14 | `Appointment Letter` (+ Template; content child merged at `88161025`) | post-acceptance printable letter with placeholders | **F2.10 (R12):** the signed state of `/offer/[token]` renders a printable Letter of Appointment (heading + letter snapshot + package + "Accepted electronically" block) via the print-area pattern — no separate template master | Partial | R12 / F2.10 |
| RJ-15 | Print formats `job_offer_classic` / `minimal` / `with_salary_breakup` | printable offer letters | offer letter is email-HTML + sign page (no print format) | Partial | R10 |
| RJ-16 | Print formats `standard_appointment_letter` / `appointment_letter_classic` | printable appointment letters | **F2.10:** one printable layout (window.print on the sign page); no named format variants | Partial | R12 / F2.10 |
| RJ-17 | Joining formalities (documents + background verification) | — (no benchmark equivalent; benchmark gates joining on onboarding tasks instead) | `CandidateDocument` (REQUESTED → RECEIVED → VERIFIED/REJECTED, fileRef) + `BackgroundCheck` (INITIATED → IN_REVIEW → CLEARED/FLAGGED) + `DocumentTypeConfig` CRUD | **Beyond benchmark** (Fernly strength) | — |
| RJ-18 | Joiner provisioning (Employee creation via mapper) | employee doc from offer mapper + applicant back-flip | `markJoined` transaction: User + TeamMember + EmployeeProfile + SalaryStructure copied from the signed offer (F2.10 closed F-R7 — `payrollReady` verdict included) + checklist from the ONE template source (F-R8 closed) + candidate→HIRED + WELCOME outbox mail + printable day-one handout (P0-4) | **Parity (workspace scope)** | — |

### 6.2 Recruitment behaviors

| ID | Benchmark behavior | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| RJ-B01 | Website route publication + daily auto-close of openings | — | Missing | R3 / F3.6 |
| RJ-B02 | Publish salary range / applications-received on the public board | — | Missing | R3 |
| RJ-B03 | Staffing vacancy enforcement on opening creation | — | Missing | R2 / F3.6 |
| RJ-B04 | Email-named applicant (email as document name) | email is the de-facto identity (duplicate-email guard; deterministic provisioned emails) | **Parity (workspace scope)** | R5 |
| RJ-B05 | Applicant Kanban board | hiring-view board with stage columns + drag flow | **Parity** | R6 |
| RJ-B06 | Interview reminder scheduler (cron, per-interview) | `Reminder` rows created with the CalendarEvent at scheduling | **Parity (workspace scope)** | R7 |
| RJ-B07 | Reschedule emails + cleanup of prior events | **F2.10:** reschedule deletes the previous event+reminder pair via `Reminder.eventId` (F-R6) and re-sends the INTERVIEW_INVITE with the new time (F-R10) — all in one transaction | **Parity (workspace scope)** | R7 / F2.10 |
| RJ-B08 | Per-skill ratings → normalized average | single 1–5 rating + structured strengths/concerns (F2.9 adds skill criteria via round templates) | Partial | R8 / F2.9 |
| RJ-B09 | One feedback per interviewer (enforced) | `saveScorecard` owner-scoped, per stage | **Parity** | R8 |
| RJ-B10 | Duplicate-applicant guard | duplicate-email guard with friendly error | **Parity** | R5 |
| RJ-B11 | Offer status advances only on actual sent communication | `sendOffer` flips to SENT only after the outbox write; mailStatus surfaced (QUEUED→SENT/SKIPPED/FAILED) | **Parity** | R10 |
| RJ-B12 | Offer expiry semantics | **F2.10:** EXPIRED is a stored outcome (lazily lapsed on hiring reads); sign + decline both honor expiry; the funnel's awaiting counts live links only and reports expired separately | **Parity (workspace scope)** | R10 / F2.10 |
| RJ-B13 | Offer approval before send | **F2.10 (R11/D-20):** `hiring:approve` (MANAGER/ADMIN, never the HR composer's role) must flip DRAFT → APPROVED before sendOffer; composer self-approval refused; edits demote back to DRAFT | **Parity (workspace scope)** | R11 / F2.10 |
| RJ-B14 | CTC engine: derive CTC from base OR solve base for target CTC | `offer-math.ts` resolves percent-of-basic + CTC totals; no inverse solve | Partial | R10 |
| RJ-B15 | Appointment-letter placeholder discipline | — | Missing | R12 / F2.9 |
| RJ-B16 | Interview-invite email to candidates | `INTERVIEW_INVITE` outbox kind reserved, never written (F-R10) | Missing | X6 / F2.9 |
| RJ-B17 | Daily job `close_expired_job_openings` | — | Missing | R3 / F3.6 |
| RJ-B18 | Daily job `send_interview_reminder` (all-minutes) | reminders surface in-app; no outbound email nudge | Partial | R7 |
| RJ-B19 | Daily job `send_daily_feedback_reminder` (interviewer nudge) | — | Missing | R7 / F2.9 |

### 6.3 Recruitment reports, charts, cards

| ID | Benchmark surface | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| RJ-R01 | `recruitment_analytics` report | funnel panel + stage counts + offer accept rate (`getHiringFunnel`) | **Parity (workspace scope)** | R13 |
| RJ-C01 | Chart `job_applicant_pipeline` | funnel panel covers the pipeline shape | Partial | R6 |
| RJ-C02–09 | Charts job_application_status / frequency / job_offer_status / interview_status / job_applicant_source / job_applicants_by_country / department_wise_openings / designation_wise_openings | — | Missing | R13 / F3.9 |
| RJ-N01 | Card `job_offer_acceptance_rate` | accept rate in the funnel panel | Partial | R6 |
| RJ-N02–06 | Cards accepted/rejected_job_applicants, applicant_to_hire_percentage, job_offers_(this_month), job_openings, time_to_fill | — (time-to-fill needs R1 requisition dates) | Missing | R13 / F3.9 |

---

## 7. HR Future Breadth — Performance & Training (domain `PF`)

Bucketed under HR per the plan's domain structure; statuses unchanged from the reassessment.

### 7.1 Doctype artifacts

| ID | Benchmark artifact | Key features | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| PF-01 | `Appraisal` (submittable, 381 py lines) | KRA scores auto-derived from Goal progress; self-ratings; peer/reviewer feedback averaged; final score (mean or sanitized formula) | `PerformanceReview` — DRAFT → SUBMITTED → REVIEWED → ACKNOWLEDGED; self + manager ratings 1–5; **kind STANDARD/PROBATION (F1.6)** feeds the probation hard gate | **Parity (workspace scope)** | F1 / F1.6 gate |
| PF-02 | `Appraisal Cycle` (307 py lines) | Not Started → In Progress → Completed; org-filter employee selection; designation→template mapping; bulk creation >30 enqueued | — (one-off reviews) | Missing | F2 / **F2.7** |
| PF-03 | `Appraisal Template` (+`Appraisal Goal`, `Appraisal KRA`, `Appraisal Template Goal` children) | KRAs with weights Σ=100 + rating criteria Σ=100 (shared mixin validation) | — | Missing | F3 / F2.7 |
| PF-04 | `Employee Performance Feedback` (+`Employee Feedback Criteria`, `Employee Feedback Rating` children) | peer/reviewer feedback with per-criteria ratings | self + manager assessments only | Partial | F5 / F2.7 |
| PF-05 | `Goal` (NestedSet, 287 py lines) | parent goals; auto status from progress; roll-up to parents; KRA cascade to children | — | Missing | F4 / F2.7 (flat goals) |
| PF-06 | `KRA` master | weighted KRA list | — | Missing | F3 / F2.7 |
| PF-07 | `Skill` / `Designation Skill` / `Expected Skill Set` / `Skill Assessment` | shared skill master across appraisals, interviews, maps | free-text `skills` on profile; no master | Partial | F8/R9 |
| PF-08 | `Training Program` / `Training Event` (+`Employee` child) / `Training Result` (+`Employee` child) / `Training Feedback` | program → event → result → feedback loop; attendance tracking | — | Missing | F7 / F3.7 |

### 7.2 Performance behaviors

| ID | Benchmark behavior | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| PF-B01 | Weight-sum validation (KRAs Σ=100, criteria Σ=100) | — | Missing | F3 / F2.7 |
| PF-B02 | Cycle bulk appraisal creation (>30 enqueued) | — | Missing | F2 / F2.7 |
| PF-B03 | Goal status auto-derived from progress | — | Missing | F4 / F2.7 |
| PF-B04 | Goal progress roll-up to parents | — (F2.7 goals are deliberately flat) | Out of scope (flat by design) | F4 |
| PF-B05 | KRA score = goal completion × weightage | — | Missing | F3 / F2.7 |
| PF-B06 | Multi-rater averaging (self + peers + reviewers) | self + manager two axes | Partial | F5 |
| PF-B07 | Sanitized `final_score_formula` | — (F2.7 uses weighted normalization only — no free-form formula, consistent with the §7.0 declination) | Out of scope (formula) / Missing (normalization) | F6 |
| PF-B08 | Designation→template mapping in cycles | — | Missing | F2 / F2.7 |

### 7.3 Performance reports, charts, cards, notifications

| ID | Benchmark surface | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| PF-R01 | `appraisal_overview` report | — | Missing | X7 / F3.9 |
| PF-C01 | Chart `appraisal_overview` | — | Missing | X7 |
| PF-N01–03 | Cards appraisals_(this_year) / goals_in_progress / ongoing_appraisal_cycles | — | Missing | X7 |
| PF-N04 | Card trainings_(this_month) | — | Missing | X7 |
| PF-T01/02 | Notifications `Training Scheduled` / `Training Feedback` (email, Submit) | — | Missing | X6 / F3.7 |

---

## 8. HR Future Breadth — Expenses, Travel & Grievance (domain `EX`)

### 8.1 Doctype artifacts

| ID | Benchmark artifact | Key features | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| EX-01 | `Expense Claim` (submittable, 59 fields, 1,045 py lines) + `Expense Claim Detail`/`Advance`/`Account`/`Expense Taxes and Charges` children | typed rows (sanctioned ≤ claimed, mandatory cost center); advance allocation; taxes; workflow-aware approval; reactive payment status from payment-ledger hooks; GL postings; ESS scoping | — | Missing | X1 / **F2.8** |
| EX-02 | `Expense Claim Type` | claim-type master with default accounts | — | Missing | X1 / F2.8 |
| EX-03 | `Employee Advance` (submittable, 459 py lines) | Draft → Unpaid/Partially Paid/Paid → Claimed/Returned combos; outstanding derived | — | Missing | X2 / F2.8 (lite: OPEN/SETTLED/RETURNED) |
| EX-04 | `Travel Request` (+`Travel Itinerary`, `Travel Request Costing` children) + `Purpose of Travel` | itinerary + costings | — | Missing | X3 |
| EX-05 | `Vehicle Log` (+`Vehicle Service`, `Vehicle Service Item` children) | odometer monotonicity; expense-claim bridge | — | Out of scope | X4 |
| EX-06 | `Employee Grievance` (+`Grievance Type`) | typed grievance; against-party DynamicLink; Open → Investigated → Resolved/Invalid | — | Missing | X5 / F3.8 |

### 8.2 Expense behaviors

| ID | Benchmark behavior | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| EX-B01 | Sanctioned ≤ claimed per row | — | Missing | X1 / F2.8 |
| EX-B02 | Mandatory cost center / default accounts | — (no accounting) | Out of scope | X1 |
| EX-B03 | Advance allocation with receivable enforcement | — (F2.8: advance recovery suggests a DEDUCTION PayAdjustment) | Missing | X2 / F2.8+F2.3 |
| EX-B04 | Workflow-aware approval + self-approval prevention | — (F2.8 lite: approval_status) | Missing | X1 / F2.8 |
| EX-B05 | Reactive payment status from Payment Entry / JV doc_events | — (no payment ledger; F2.8 uses a `paymentStatus` flag) | Out of scope (mechanism) / Missing (status) | X1 / F2.8 |
| EX-B06 | Exchange gain/loss on claims | — (single currency) | Out of scope | — |
| EX-B07 | ESS self-scoping of claims | — (no module yet; self-scoped convention ready) | Missing | X1 / F2.8 |

### 8.3 Expense reports, charts, cards

| ID | Benchmark surface | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| EX-R01 | `employee_advance_summary` report | — | Missing | X7 / F3.9 |
| EX-R02 | `unpaid_expense_claim` report | — | Missing | X7 / F3.9 |
| EX-R03 | `vehicle_expenses` report | — | Out of scope | X4 |
| EX-C01–04 | Charts claims_by_type / expense_claims / department_wise_expense_claims / employee_advance_status | — | Missing | X7 |
| EX-C05 | Chart grievance_type | — | Missing | X7 |
| EX-N01–03 | Cards approved/rejected/expense_claims (this month) | — | Missing | X7 |

---

## 9. Platform Surfaces (domain `PL`)

Cross-cutting machinery both products ship: settings, notifications, reminders, dashboards, exports, print, web, API, jobs, regional, telemetry.

### 9.1 Platform artifacts and behaviors

| ID | Benchmark artifact / behavior | Key features | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| PL-01 | Email notification engine (7 templates: leave ×3, exit interview, training ×2, retention bonus) | channel Email; event-driven (Save/Submit/Cancel/Days Before) | `MailOutbox` (QUEUED→SENT/SKIPPED/FAILED, mailStatus honesty) with 3 writers (REJECTION/OFFER/WELCOME) + in-app `Notification` model; `INTERVIEW_INVITE` reserved unwritten (F-R10); HR module zero mail side effects (F-R17) | Partial | X6 / F2.9, F3.10 |
| PL-02 | Reminder engine: birthday + work-anniversary (daily) + advance-holiday (weekly/monthly) | `employee_reminders.py`; sender resolution; per-recipient composition | `Reminder` model (user-scoped, manual + interview-scheduling); no birthday/anniversary/holiday engine | Partial | X6 / **F3.10** |
| PL-03 | Scheduler framework — 16 cron jobs (hooks `scheduler_events`) | all/hourly/daily/weekly/monthly buckets | one authenticated cron route `/api/cron/prune-audit` (CRON_SECRET, Redis overlap guard) — the pattern F2.4 rides; no HR jobs scheduled yet | Partial | X6 / F2.4 |
| PL-04 | Workspaces & dashboards (9 workspaces; charts+cards assembled per workspace) | role-scoped navigation with embedded analytics | nav areas (HR / Payroll / Hiring / Analytics / Settings / workspace) + `analytics-view.tsx` role-scoped (PR-63) | Partial | X7 |
| PL-05 | Number cards & dashboard charts framework (37 cards + 35 charts) | count/percentage/avg aggregates with time windows | analytics-view aggregates (hours/activity/headcount-lite) — no card/chart framework | Partial | X7 / F3.9 |
| PL-06 | PWA mobile app + 34 whitelisted API methods (`api/__init__.py`) | attendance calendar/requests, leave balances/applications, expense claims & types, shifts & requests, holidays, notifications, attachments upload/delete, workflow states, permitted fields | — (web-only; API routes exist only for auth/cron/health/metrics/client-errors) | Missing | — |
| PL-07 | PWA push notifications (`PWA Notification` doctype, `are_push_notifications_enabled`) | push to mobile devices | — | Missing | — |
| PL-08 | Roster API (`api/roster.py`, 393 lines) + roster Vue app | shift-planning endpoints + standalone UI | — | Missing | L16 / F3.5 |
| PL-09 | OAuth API (`api/oauth.py`) | mobile OAuth flow | better-auth session auth (`auth-better`) — equivalent need, different stack | **Parity (equivalent need)** | — |
| PL-10 | `www/hrms` page + help surfaces | product web pages | `help-view.tsx` + seeded demo workspace | Partial | — |
| PL-11 | Report export formats | print/PDF/XLSX/CSV per report | `exportMyData` (GDPR JSON self-export, NZ Privacy Act framing) + `exportCalendarIcs` — no tabular report exports | Partial | X7 / F2.6, F3.9 |
| PL-12 | Print format framework (8 formats) | Jinja print templates per doctype | print CSS surfaces: payslip modal, joiner day-one handout (P0-4) | Partial | P20/R12 |
| PL-13 | Web forms framework (`job_application`) | public form intake | — (public surface is offer-sign only) | Missing | R3 / F3.6 |
| PL-14 | Regional statutory hooks (`regional/`) | country packs for statutory computation | — (ADR-014: no statutory surface to hook into) | Out of scope | P15 |
| PL-15 | Telemetry (`telemetry.py`, milestone doctypes, daily pulse) | usage analytics to Frappe | — (deliberate: `observability.ts` is ops health, never product telemetry) | Out of scope | — |
| PL-16 | Patch/migration framework (65 patches) | versioned data migrations | Prisma migrations with `down.sql` (ADR-008 discipline, `check-migrations.cjs` in CI) | **Parity (equivalent discipline)** | — |
| PL-17 | ERPNext host overrides (`overrides/`, company fixtures, payment/JV doc_events) | deep host-app integration | — (standalone product by design) | Out of scope | — |
| PL-18 | Guided setup (`tenure/` module onboarding + setup wizard) | first-run onboarding steps | seeded demo workspace + help-view (no guided setup flow) | Partial | — |
| PL-19 | Field-level write permissions (`get_permitted_fields_for_write`, `get_doctype_fields/states` introspection) | introspection-driven mobile forms | 33 permissions (`rbac.ts`) role-floor + DB ceiling; no field-level permissions | Partial | — |
| PL-20 | Attachments upload/delete (`upload_base`, `delete_attachment`, `get_attachments`) | file attachments on records | per-line receipt `fileRef` string convention (candidate documents) — no upload storage | Partial | X1 / F2.8 |
| PL-21 | Unread-notifications count + mark-all-read | notification badge semantics | `notifications.ts`: `markNotificationRead`, `markAllNotificationsRead` (+ dashboard badge) | **Parity** | X6 |
| PL-22 | Global search | doctype-aware search | `search.ts` app-wide search | **Parity** | — |

### 9.2 Fernly surfaces beyond the benchmark (for completeness in the other direction)

Not gaps — Fernly ships these as part of its wider workspace product; the benchmark (an HR app inside an ERP) does not: kanban projects/tasks/bugs, messages + mentions, calendar with ICS export, time entries (with leave-conflict guard F-R19), audit log with retention purge + PII erasure/privacy tooling, breach-check password hygiene, rate limiting, observability/metrics, maintenance locks, GDPR self-export. These are excluded from the parity counts below.

---

## 10. Coverage Rollup

Counted over the **314 mapped rows** above (artifacts + behaviors + reports/charts/cards/notifications/jobs; multi-item rows such as `PR-N01–06` count once and are noted as such):

| Status | Rows | Share | Notes |
| --- | --- | --- | --- |
| **Parity / Parity (workspace scope) / Parity+** | 40 | 13% | incl. the six F1.x landings, the deliberately-stricter probation gate, six F2.4 landings (leave policy engine), and five F2.10 landings (offer approval + expiry, reschedule cleanup + invite email, onboarding gate) |
| **Partial** | 92 | 29% | working but materially thinner than the benchmark — incl. six F2.1 landings and five F2.10 landings (onboarding template source, creation gate on docs/BGV, appointment letter + print layout) |
| **Missing** | 144 | 46% | **76 of them already owned by a planned Phase 2/3 epic** (Family/epic column) |
| **Out of scope (deliberate)** | 37 | 12% | ADR-014 statutory, accounting/GL, hardware check-in, timesheet payroll, product telemetry, locked product decisions |
| **Beyond benchmark** | 1 | <1% | joining formalities — documents + background verification (the day-one handout rides RJ-18) |
| **Total** | **314** | 100% | |

**F2.4 (leave policy engine) status flips at this update** — 8 rows: to Parity: LV-B02 (earned-leave frequency/on-day/rounding), LV-B04 (carry cap + expiry job), LV-B05 (include-holiday), LV-B06 (allow-negative), LV-B07 (applicable-after), LV-J03 (daily `allocate_earned_leaves`); to Partial: LV-04 (allocation ledger writers, no submittable docs), LV-B18 (schedule failure counting, no retry queue/email). LV-01's note updated (strategy block landed; fraction/comp/encashment knobs remain).

**F2.1 (offboarding & full-and-final lite) status flips at this update** — 6 rows, all Missing → Partial: EM-14 (separation checklist on the shared machinery, hard-coded template), EM-15 (exit-interview status machine + notes, no questionnaire email), EM-16 (lite computed FnF + settlement freeze/lock), EM-B12 (auto-assemble of the modeled payables/receivables), EM-B14 (UNSETTLED → SETTLED gate + payslip lock, no JE coupling), EM-T01 (in-app scheduling notification). EM-B11 retagged X6 (questionnaire email deferred with the notification work).

**F2.10 (joining hardening) status flips at this update** — 11 rows: to **Parity (workspace scope)**: RJ-11 (offer status machine complete — approval + EXPIRED landed), RJ-B12 (expiry semantics: stored outcome, lazy lapse, symmetric decline, honest funnel), RJ-B13 (offer approval before send — the `hiring:approve` four-eyes step), RJ-B07 (reschedule cleanup via `Reminder.eventId` + the INTERVIEW_INVITE email), EM-13 (joining gate on employee creation — documents/BGV play the required-task role); to **Partial**: EM-12 (`OnboardingTemplateTask` template source + CRUD, no user-XOR-role/required-flag/holiday dates), EM-B08 (creation gate on mandatory docs + terminal BGV instead of boarding tasks), RJ-14 (printable post-sign appointment letter, no template master), RJ-16 (one printable appointment layout, no named formats). Notes updated without status change: EM-11, EM-B06 (the F-R8 drift closed — one template source, one instantiation path), RJ-13 (F-R11 `{{startDate}}` closed), RJ-18 (F-R7 salary-structure copy closed — `payrollReady` verdict). Row-level: **37/89/150 → 40/92/144**.

Family-level (the plan's 77 families, statuses current at `bb2e046` — matches the reassessment): **12 Parity · 23 Partial · 36 Missing · 6 Out of scope**. Module-level: every row above is assigned to exactly one of the four domain logic modules — **hr 145 · admin 24 · account 93 · joining 52** — via the domain default plus 20 row-level exceptions, in `Fernly_Domain_Modules_Architecture_Plan.md` §5 (reproducible: `python3 scripts/module_rollup.py`, totals sanity-checked against this section).

Where the row-level gap concentrates (Missing rows by domain): PR 33 · LV 26 · AT 22 · EM 24 · RJ 12 · PF 15 · EX 14 · PL 4. The **operational middle** verdict of the plan advances with Phase 2 — F2.4 (leave policy engine), F2.1 (offboarding & FnF) and F2.10 (joining hardening) have landed; next up: F2.2 (leave encashment) and F2.3 (the PayAdjustment adapter).

**Newly surfaced by this pass** (not visible in the 77-family matrix): the analytics surface (35 charts + 37 number cards), 7 email notifications, 8 print formats, the public jobs board + application web form, the 16-job scheduler surface, the mobile/PWA API (34 methods), the roster app, and the engagement reminder engine — ~70 rows covering ~135 benchmark artifacts, nearly all Missing, now owned by epics F2.6/F2.9/F3.6/F3.9/F3.10 or the declination table.

---

## Appendix A — Benchmark pin and reproduction

- Pin: `frappe/hrms` @ `8816102577c92979df49c20a1807b8c7ab948eb3` (`develop` tip, 2026-11-06 14:15:37 +0530; merge of PR #5608 "appointment-letter-layout").
- Clone: partial clone (`--filter=blob:none --depth 300`) at `.analysis/hrms` (git-excluded).
- Inventory: `python3 scripts/hrms_inventory.py` → `.analysis/hrms_inventory.json|.md` (doctypes, fields, statuses, links, reports). Notifications, print formats, web forms, charts, cards, www pages, scheduler jobs, and the API surface were enumerated by direct tree inspection this pass (they live in nested directories the script's glob misses — script noted for a future fix, not silently skipped).

## Appendix B — Benchmark delta `1c28527` → `88161025`

Five commits, four files, **appointment-letter UI polish only — no doctype, feature or behavior changes**:

| Commit | Subject | Files |
| --- | --- | --- |
| `719246d4` | style(appointment_letter): move working hours to the details tab and filter print formats by doctype | `appointment_letter.js/.json`, `hrms.bundle.scss` |
| `9b31297b` | style(appointment_letter): make the letter body editor taller | `appointment_letter.js` |
| `7d299e96` | fix(appointment_letter): keep the read-only letter body at its natural height | `letter_body.scss` |
| `035a90dd` | style(appointment_letter): drop the empty section at the top of the terms tab | `appointment_letter.json` |
| `88161025` | Merge pull request #5608 from asmitahase/appointment-letter-layout | merge |

Earlier absorbed drift (`159548fa` → `1c28527`, already reflected): the `Appointment Letter content` child table was merged into the `Appointment Letter` doctype — the doctype count moved 158 → 157. No other inventory deltas.

## Appendix C — Fernly surface inventory (verified at `bb2e046`)

- **Models (58, `prisma/schema.prisma`):** User, Session, Account, Verification, UserSettings, Project, Task, TeamMember, CalendarEvent, Notification, TimeEntry, Reminder, Message, MessageRead, AuditLog, ProjectAssignment, Workspace, TaskStatusConfig, ProjectStatusConfig, EventTypeConfig, TaskTagConfig, PriorityConfig, DepartmentConfig, Role, Permission, RolePermission, PasswordResetToken, Bug, BugComment, LeaveType, LeavePolicy, LeaveRequest, LeaveBalance, LeaveLedgerEntry, HolidayCalendarEntry, AttendanceRecord, SalaryComponent, EmployeeProfile (employmentStatus/probationEndsAt/noticePeriodWeeks/lastWorkingDay), PerformanceReview (kind STANDARD/PROBATION), OnboardingChecklist, OnboardingTask, HiringStageConfig, Candidate, CandidateStage, MailOutbox, DocumentTypeConfig, CandidateDocument, BackgroundCheck, OfferTemplate, OfferRecord, SalaryStructure, PayrollRun, Payslip (lopDays/lopSource).
- **HR/Payroll/Hiring server actions:** `hr-leave.ts` (6 exports), `hr-attendance.ts` (4), `hr-holidays.ts` (3), `hr-onboarding.ts` (4), `hr-reviews.ts` (7), `hr-directory.ts` (4), `employment.ts` (`transitionEmployment`), `payroll.ts` (10), `payroll-components.ts` (3), `hiring.ts` (38), `analytics.ts`, `data-export.ts`, `ics-export.ts`, `reminders.ts`, `notifications.ts`, `events.ts`.
- **Pure libs:** `payroll-math.ts`, `offer-math.ts`, `working-days.ts`, `leave-ledger.ts`, `lop-derivation.ts`, `employment.ts`, `hiring-email.ts`, `hr-shared.ts`, `config.ts`.
- **Views:** hr-view + hr-directory/hr-holidays/hr-attendance/hr-onboarding/hr-reviews/leave-view/my-attendance-view, payroll-view + my-payslips-view, hiring-view + my-interviews-view, analytics/audit/calendar/dashboard/settings/team/users/workspace-settings views, `offer/[token]` public sign page, login screen.
- **Permissions (33, `src/lib/rbac.ts`):** incl. `hr:view/hr:admin`, `leave:request`, `review:manage`, `onboarding:manage`, `attendance:manage`, `hiring:view/manage/config`, `payroll:manage`, `analytics:view`, `settings:edit`, `role:manage`, `audit:view` + the platform set.
- **Jobs:** `/api/cron/prune-audit` (authenticated, Redis overlap-guarded) — the cron pattern every F2.4/F3.10 job rides.

---

*Every Fernly claim above was verified against the working tree at `bb2e046`; every benchmark claim against the clone at `88161025`. Where a status is Missing it was verified by absence in schema, actions, and views. Planned-epic references point at `Fernly_HR_Payroll_Enhancement_Plan.md` §7 (updated in the same pass as this document).*
