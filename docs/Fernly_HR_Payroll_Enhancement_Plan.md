# Fernly HR & Payroll Enhancement Plan

**Benchmark: ERPNext / Frappe HR (`frappe/hrms`)**

| | |
| --- | --- |
| Document | `docs/Fernly_HR_Payroll_Enhancement_Plan.md` |
| Date | 2026-11-06 → **updated 2026-11-07** (benchmark re-pinned, row-level matrix added, Phase 1 marked complete, Phase 2/3 re-sequenced) |
| Status | Epic plan — **Phase 1 (F1.1–F1.6) COMPLETE**; coverage matrices superseded by `docs/Fernly_HRMS_Feature_Parity_Matrix.md` (row-level, 314 rows) with `Fernly_HR_Payroll_Parity_Reassessment.md` §5 as the family-level status layer |
| Scope | Payroll, HR (people & leave), Onboarding/Joining, Hiring — benchmarked against Frappe HR (ERPNext's HR + Payroll successor app) |
| Companion docs | `docs/Fernly_HRMS_Feature_Parity_Matrix.md` (row-level truth), `docs/Fernly_Domain_Modules_Architecture_Plan.md` (structural companion — the four logic modules + M-track, added 2026-11-07), `docs/Fernly_HR_Payroll_Parity_Reassessment.md`, `docs/PRD.md`, `docs/HR_MODULE_PLAN.md`, `docs/RECRUITMENT_MODULE_PLAN.md`, `docs/Fernly_Persona_Acceptance_Assessment.md`, `docs/DECISIONS.md` (ADR-001…ADR-014) |

---

## 1. Executive Summary

Fernly was benchmarked against **Frappe HR (`frappe/hrms`)** — the app that has contained all of ERPNext's HR and Payroll functionality since the ERPNext v14 module split (verified against the `frappe/erpnext` `main` branch on 2026-11-06: no `hr/` or `payroll/` module directories remain in the core repo). The benchmark was analyzed structurally (every one of its **157 HR/Payroll doctypes** inventoried by script at the current pin `88161025`; 158 at the original `159548fa` — one child table was merged into its parent since) and functionally (deep reading of the core controllers: salary slip, payroll entry, salary structure assignment, leave application/ledger, attendance, onboarding, recruitment funnel, appraisal, expense claim). The **2026-11-07 refresh** added the surfaces the first pass had not inventoried: 35 dashboard charts + 37 number cards, 7 email notifications, 8 print formats, the public jobs board + application web form, all 16 scheduler jobs, the 34-method mobile/PWA API, the roster app, and the engagement reminder engine — every one of them now mapped row-by-row in `Fernly_HRMS_Feature_Parity_Matrix.md` (314 rows).

Headline findings:

1. **Fernly's foundations are honest and sound.** Real arithmetic (`src/lib/payroll-math.ts`), snapshot isolation, one-way run locking, self-scoped member views, mailStatus honesty, RBAC-tested server actions, and audit logging are all genuinely working. The assessment report's six P0 defects are closed on `origin/main`.
2. **Fernly covers the last mile and — after Phase 1 — six floor stones of the middle.** Of 77 benchmarked feature families: **12 at parity (16%), 23 partial (30%), 36 missing (47%), 6 consciously out of scope (8%)** at `bb2e046` (row-level: 31 / 84 / 161 / 37 of 314 rows). The remaining missing middle is concentrated in four places: *shifts and the attendance correction loop*, *carry-forward/encashment/earned-leave (the ledger's unwritten phases)*, *the employee lifecycle between "joined" and "left" (promotion, transfer, offboarding, full-and-final)*, and *payroll's post-computation surfaces (arrears, corrections, benefits, bank export, payslip delivery)* — plus the newly inventoried analytics/notifications/mobile surfaces (Phase 3 breadth).
3. **The gap is bridgeable on the current stack.** ERPNext's depth is mostly *statutory + accounting + multi-company* machinery that Fernly deliberately does not build (ADR-014). The functional core that matters to a small organization — attendance, holiday calendars, a leave ledger, an employment lifecycle, offboarding with settlement, appraisal cycles with KRAs, expense claims and advances — fits Fernly's Next.js + Prisma + SQLite architecture without new infrastructure.
4. **Recommended path:** three phases — **Foundation** (6 epics: holiday calendar, leave ledger, attendance, attendance→LOP link, component catalog, employment lifecycle — **ALL LANDED, Phase 1 complete**), **Growth** (10 epics after the 2026-11-07 re-sequencing: offboarding/FnF, **joining hardening (F2.10 — LANDED)**, encashment, PayAdjustment adapter, earned-leave accrual, promotions/transfers, payroll exports, appraisal cycles, expense claims, half-days + interview templates — **F2.4 + F2.1 + F2.10 LANDED**), **Parity** (breadth: corrections/arrears, benefits accrual, gratuity rules, deduction slabs, shifts, public job openings, training, grievance, report suite, **engagement reminders (new F3.10)**).
5. **The codebase is being reorganized into four domain logic modules (2026-11-07).** All benchmark functionality is incorporated through four separate logic modules — **HR** (people & time; 145 matrix rows), **Admin** (governance & platform; 24 rows + the machinery under every other row), **Account** (employment money; 93 rows), **Joining** (candidate → employee; 52 rows) — specified in `docs/Fernly_Domain_Modules_Architecture_Plan.md`. Every one of the matrix's 314 rows is assigned to exactly one module (or an explicit declination owner); business logic migrates from flat server-action files into `src/modules/**` behind lint-enforced boundaries; and a structural track (**M0–M4**) interleaves with the functional epics below. The M-track changes no behavior and no matrix status — only where the code that will change them lives.

The plan explicitly borrows the benchmark's best engineering patterns (ledger-as-truth, savepoint-per-item batches, config-driven validation, derived statuses, watermark-based scheduled jobs) while consciously declining its hazards (double-entry GL, user-authored formula sandboxes, multi-company roll-ups, statutory engines).

---

## 2. Scope, Method and Sources

### 2.1 What was analyzed

| Source | Version / commit | Method |
| --- | --- | --- |
| `github.com/frappe/hrms` | `159548fa` (2026-11-03) → `1c28527` (2026-11-06, reassessment) → **`88161025`** (`develop` tip, 2026-11-06 14:15 +0530; merge of PR #5608 — delta from `1c28527` is 5 commits of appointment-letter UI polish, logged in the matrix doc's Appendix B) | Partial clone; scripted structural inventory of every doctype JSON + controller; deep functional reading of core controllers and reports; **2026-11-07 pass: full enumeration of charts, cards, notifications, print formats, web forms, www pages, scheduler jobs, PWA API, roster app** |
| `github.com/frappe/erpnext` | `main` (checked 2026-11-06 via GitHub contents API) | Verification of the module split: `erpnext/hr` and `erpnext/payroll` no longer exist in core |
| Fernly (this repo) | `b932258` at original writing → **`bb2e046`** at the 2026-11-07 refresh (F1.1–F1.6 landed) | Full read of Prisma schema, RBAC matrix, server actions, views, seed script, docs; every matrix row re-verified against the working tree |

### 2.2 Method and honesty about depth

"Analyse thoroughly without missing a single line" was interpreted as: **complete structural coverage + functional depth on everything that matters**, not a literal line-by-line read of ~1M LOC, which would not fit any usable report. Concretely:

- A script (`scripts/hrms_inventory.py`) parsed **every doctype JSON** in `hrms/hr` and `hrms/payroll` — all 158 at `159548fa`, 157 at the current pin — extracting field counts, state machines (Select-field options), link graphs, child tables, submittability, permission roles, and controller sizes. Nothing was sampled or skipped; the full inventory is reproduced in Appendix A. The 2026-11-07 refresh additionally enumerated every non-doctype surface (charts, cards, notifications, print formats, web forms, www pages, scheduler jobs, PWA API, roster app) — mapped in the matrix doc.
- The core controllers (salary slip 2,859 lines, payroll entry 2,003 lines, leave application 1,591 lines, attendance, expense claim 1,045 lines, onboarding, appraisal, interviews, offers, full & final, gratuity, and others) were read functionally: state machines, validation order, business rules, scheduled jobs, and cross-module couplings were extracted with file references.
- Fernly's side was inventoried with equal rigor: every Prisma model, every server action and its permission gate, every view, and the standing conventions established by the P0 remediation.

Line numbers cited from hrms are approximate to the analyzed commit. This report contains **no invented facts**: every claim about Fernly cites a file path, and every claim about the benchmark cites the hrms source.

### 2.3 What "parity" means here

Full ERPNext parity is **not** the goal and should never be: ERPNext is a multi-company, multi-currency, double-entry-accounting ERP with statutory engines per country. Fernly is a deliberately honest, pre-statutory, single-workspace PM suite (ADR-014). "Parity" in this plan means: **for the operational core a 20–200 person organization runs on, Fernly should be able to do what Frappe HR does — with Fernly's honesty constraints intact.** Features whose cost center is statutory compliance or accounting are marked *out of scope* with rationale, not silently omitted.

---

## 3. The Benchmark: Frappe HR Architecture

### 3.1 Product lineage

ERPNext ≤ v13 shipped `hr` and `payroll` modules inside the monolith. From v14 onward, all HR and Payroll functionality moved to the dedicated **Frappe HR** app (`hrms`), which now owns 114 HR doctypes + 43 Payroll doctypes (157 total at the current pin `88161025`; 115 + 43 at the original writing — one child table merged since). The Employee doctype master still lives in ERPNext (`erpnext.setup.doctype.employee`); hrms extends it via `override_doctype_class` (`hrms/overrides/employee_master.py`) and `doc_events` hooks. This is itself a useful lesson: **the benchmark itself decided HR deserves its own bounded context**, separate from the core product.

### 3.2 Architectural model

Five recurring mechanisms power nearly every hrms module:

1. **Doctypes with a two-axis state model** — a Frappe `docstatus` (Draft → Submitted → Cancelled, an immutable-on-submit lifecycle) plus a semantic `status` field (e.g. Salary Slip: `Draft/Submitted/Cancelled/Withheld`; Payroll Entry adds `Queued/Failed`). Fernly's equivalent is its single semantic status + one-way locks (PayrollRun `OPEN/LOCKED`).
2. **Ledgers as the source of truth** — balances are never stored as mutable numbers. `Leave Ledger Entry` (append-only signed rows: allocations positive, consumption negative, expiry negative-with-flag) and `Employee Benefit Ledger` (accrual/payout) derive every balance by aggregation. Cancellation deletes or reverses ledger rows rather than updating a balance column.
3. **Config doctypes driving validation** — one `Leave Type` (33 fields), `Shift Type`, `Salary Component`, `Overtime Type`, or `Gratuity Rule` centralizes dozens of behavioral switches, keeping transaction controllers thin.
4. **Scheduled, watermark-based jobs** — `update_last_sync_of_checkin` (hourly), `process_auto_attendance_for_all_shifts`, `process_expired_allocation` / `allocate_earned_leaves` / `generate_leave_encashment` (daily), `close_expired_job_openings`. Each is resumable via persisted watermarks (`last_sync_of_checkin`, `create_shifts_after`, Earned-Leave-Schedule rows carrying `attempted/failed/failure_reason`).
5. **Safe bulk operations** — savepoint-per-item in every batch flow (payroll entry slip creation, salary structure bulk assignment, attendance marking, appraisal bulk creation, leave policy assignment): one bad record rolls back alone, and its failure is reported per-row.

### 3.3 Module inventory (complete counts)

| Module | Standard doctypes | Child tables | Singles | Reports |
| --- | --- | --- | --- | --- |
| HR | 75 (33 submittable) | 35 | 4 (HR Settings, Leave Control Panel, Employee Attendance Tool, Shift Assignment Tool) | 17 |
| Payroll | 23 (16 submittable) | 18 | 2 (Payroll Settings, Bulk Salary Structure Assignment) | 8 |
| **Total** | **98** | **53** | **6** | **25** |

Beyond doctypes and reports, the 2026-11-07 enumeration added (previously uncounted): **35 dashboard charts + 2 chart sources, 37 number cards, 7 email notifications, 8 print formats, 1 web form, 3 www pages, 16 scheduler jobs, 34 PWA API methods, a standalone roster app, and the birthday/anniversary/holiday reminder engine** — all mapped in `Fernly_HRMS_Feature_Parity_Matrix.md`.

The full per-doctype inventory (fields, state machines, controller sizes) is in Appendix A.

---

## 4. Benchmark Feature Inventory

### 4.1 Payroll engine

**Salary components.** A `Salary Component` master (36 fields) defines each earning/deduction/employer-contribution: `amount` or `amount_based_on_formula` + `formula` (Code) + `condition` (Code), `depends_on_payment_days`, `statistical_component`, `is_tax_applicable`, `is_flexible_benefit`, `variable_based_on_taxable_salary`, `remove_if_zero_valued`, `round_to_the_nearest_integer`, `accrual_component`, `payout_method`, per-company GL accounts. Formulas are evaluated in a hardened AST-denylist sandbox (`hrms/payroll/utils.py`, `_safe_eval`) with a context of all component abbreviations pre-seeded to zero, salary-slip fields, and whitelisted globals (`round/ceil/floor/min/max/getdate`).

**Structures and assignments.** `Salary Structure` groups component rows with `payroll_frequency` (Monthly/Fortnightly/Bimonthly/Weekly/Daily), timesheet mode with hourly rate, `max_benefits`, active/default flags. `Salary Structure Assignment` (SSA) is the temporal binding: employee + structure + `from_date` + `base` + `variable` + `income_tax_slab` + cost-center split (must sum to 100%) + opening balances (`taxable_earnings_till_date`, `tax_deducted_till_date`). One submitted SSA per employee per `from_date` (duplicate guard). The SSA is also the **formula evaluation engine**: one shared pass resolves earnings → injects `gross_pay` → deductions → employer contributions, producing both prorated and full-cycle values — the same math drives slips, CTC previews, and job-offer compensation.

**Salary slip pipeline** (`salary_slip.py`, 99 fields, 2,859 lines). Validation order: withholding check → active-employee gate → **duplicate-slip guard** (unique employee+period, payroll-entry-aware) → period derivation from frequency → structure/SSA loading → net pay computation → YTD/MTD and per-component YTD → leave balances. **Payment days**: total working days minus holidays (configurable include), DOJ/relieving clipping, then either *Leave mode* (LWP and partially-paid leaves with `fraction_of_daily_salary_per_leave`, half-days) or *Attendance mode* (Absent/Half Day/On Leave records, unmarked-as-absent option). Computation order: earnings → gross → deductions → **loan repayment** (lending-app-gated) → regional statutory hook → employer contributions (display-only, never in net) → rounding → `net = gross − deductions − loan`. Additional salaries merge with overwrite semantics; flexible benefits pro-rate by sub-period with last-cycle payout; tax components append last. Emails on submit (bulk-queued, optionally password-protected PDFs).

**Income tax engine.** `Income Tax Slab` (effective_from, slab rows with `condition` code, `allow_tax_exemption` + `standard_tax_exemption_amount` as the regime switch, `other_taxes_and_charges` with min/max income bands). Projection: previous-period taxable earnings from submitted slips + SSA opening balances + current period (payment-days based) + future periods (current full-cycle × remaining sub-periods) − exemptions. Monthly tax = `(annual tax − tax already paid) / remaining sub_periods`. Declarations (employee-entered) vs Proof Submissions (actuals, enforced in the last period). Full-year recomputation reports (`income_tax_computation`, 652 lines).

**Payroll entry (batch runs).** Status `Draft/Submitted/Cancelled/Queued/Failed` plus `salary_slips_created/submitted` flags. Employee filtering: active structures by company/currency/frequency → SSA join against DOJ/relieving window → already-payrolled employees removed. **>30 employees → queued background processing with per-slip savepoints**; failures logged to `error_message` and status `Failed`. Accounting: accrual Journal Entries aggregated per component × cost center, employer-contribution JE, bank entry excluding statistical components and loan repayments, dedicated withheld-salary flow. Cancellation cascades (delete slips, cancel JEs, reset flags).

**Benefits, adjustments, gratuities.** Flexible benefits elected yearly (`Employee Benefit Application`, capped by structure `max_benefits`) or per-SSA fallback; claims create `Additional Salary`; the **Employee Benefit Ledger** (append-only Accrual/Payout) makes claimable = accrued − paid. `Additional Salary` is the universal one-off adapter — every special flow (gratuity, encashment, benefit claim, arrear, correction, referral, incentive, retention bonus, advance return) funnels into it via `ref_doctype/ref_docname`. **Arrears** re-simulate every past slip under the new structure and emit positive diffs. **Payroll Correction** reverses N LWP days of a past slip. **Salary Withholding** holds whole cycles with `Draft → Withheld → Released` driven by JE doc_events. **Gratuity Rules** are slab tables (years → fraction) with three experience-computation methods, base = last submitted slip's applicable earnings.

**Payroll Settings** toggles behavior globally: `payroll_based_on` (Leave vs Attendance), include-holidays flags, `consider_unmarked_attendance_as`, `daily_wages_fraction_for_half_day`, `disable_rounded_total`, `email_salary_slip_to_employee` + `encrypt_salary_slips_in_emails` + password policy, `process_payroll_accounting_entry_based_on_employee`, `show_leave_balances_in_salary_slip`, `create_overtime_slip`.

### 4.2 Leave, attendance, shifts, holidays

**Leave engine.** `Leave Type` (33 fields) configures: LWP / partially-paid (with salary fraction) / earned (frequency + allocate-on + rounding) / compensatory / carry-forward (cap + expiry days) / include-holiday / allow-negative / over-allocation / `applicable_after` days from joining / max continuous days / encashment knobs / optional leave. The **`Leave Ledger Entry` is the single source of truth**: signed rows from Allocation/Adjustment/Application/Encashment, `is_carry_forward`, `is_expired`; the daily `process_expired_allocation` job writes negative expiry rows. `Leave Allocation` (597 lines) validates overlap, carry-forward caps, backdating, and writes two ledger entries on submit (new + CF parts with their own expiry dates). `Leave Application` (1,591 lines) runs a ten-step validation chain: active employee → dates → balance (with the subtle *balance-for-consumption = min(balance, days left in allocation)* rule) → overlap → max consecutive days (walking across adjacent applications) → block lists → **salary-processed-days guard (LWP cannot overlap an already-processed slip)** → attendance conflict → applicable-after → self-approval policy → approver resolution (employee-level → department → workflow). On approval: marks attendance "On Leave"/"Half Day", writes negative ledger rows **split at allocation and CF-expiry boundaries**. Encashment computes encashable days × per-day rate (from SSA) and pays via Additional Salary; auto-encashment drafts are generated daily for allocations that ended yesterday.

**Leave policy assignment.** Policies hold per-type annual allocations; assignment (by leave period or joining date, overlap-forbidden) bulk-creates allocations with per-employee savepoints, pro-rates by DOJ, and pre-computes an **Earned Leave Schedule** (one row per future period with `is_allocated/attempted/failed/failure_reason`) that the daily scheduler consumes — clamped to annual quota, with failure reasons persisted and emailed to HR Managers.

**Attendance.** Statuses Present/Absent/On Leave/Half Day (+ `half_day_status`)/Work From Home, late-entry/early-exit flags, in/out times, working hours, shift, overtime linkage. Duplicate guard per employee+date with row locks; leave-record cross-derivation. `Attendance Request` is the employee correction flow (WFH/On Duty over a range, shift-consistency and overlap validation, Skip/Overwrite semantics). `Employee Checkin` (device/API log, IN/OUT, lat/long, geo-fencing radius vs shift locations) feeds **auto-attendance**: `Shift Type` buffers (early check-in allowance, late check-out allowance), pairing modes, grace periods → derived Present/Half Day/Absent by working-hours thresholds, then absent-marking for no-show days bounded by buffer days. Hourly/daily scheduled jobs drive it with a persisted sync watermark.

**Shifts & roster.** Shift Assignment (Active/Inactive, overlap-of-timings validation incl. midnight wrap, nightly expiry job), Shift Request (Draft → Approved/Rejected, approver chain, creates assignments), Shift Schedule + Schedule Assignment materialize concrete assignments ~90 days ahead via an hourly job advancing `create_shifts_after`. **Overtime**: attendance rows carry `overtime_type` + duration; Overtime Type defines calculation (fixed hourly vs salary-component-based), standard/weekend/holiday multipliers, caps; Overtime Slips span a payroll period and submit Additional Salary rows grouped by component. (A separate `roster/` app at the repo root is emerging for shift planning.)

**Holidays.** Holiday Lists (date, description, weekly-off, half-day flags) resolved per employee via Holiday List Assignments (employee- or company-scoped, date-ranged); every consumer — payment days, attendance, leave day counting, monthly attendance sheet — segments date ranges per applicable list.

### 4.3 Employee lifecycle

**Employee master** (in ERPNext, extended by hrms): naming by series/employee-number/full-name; status Active/Inactive/Suspended/Left with relieving date and retirement age; grouping by branch/department/designation/grade/employment-type; per-employee leave/expense approver wiring with automatic role grants and doc sharing; **Internal Work History** child rows (branch/designation/department snapshots with from/to dates) maintained on every change; Employee Property History (property/current/new) powers Promotion/Transfer diffs; `validate_onboarding_process` **blocks employee creation while mandatory onboarding tasks are incomplete**; creation back-flips the Job Applicant and Offer to Accepted.

**Onboarding.** `Employee Onboarding Template` = ordered `Employee Boarding Activity` rows (activity, `user` XOR `role` assignee, begin-on offset in days, duration, `required_for_employee_creation`, task weight). Submitting an Employee Onboarding creates a Project + per-activity Tasks (dates pushed off holidays, assigned to the user plus all holders of the role), and `boarding_status` is **derived from Project.percent_complete via hooks** — never hand-edited. Employee creation is gated on every `required_for_employee_creation` task being Completed. **Separation** is the symmetric flow (template → tasks → gating).

**Exit & full-and-final.** Exit Interview (Pending → Scheduled → Completed/Cancelled; one per employee; questionnaire email sent once via template + web form). `Full and Final Statement` auto-builds **payables** (withheld salary slips, gratuity, expense claims, bonuses, leave encashment) and **receivables** (outstanding employee advances, loans), reconstructs asset obligations from Asset Movements, blocks settlement while anything is Unsettled, and pays via a Journal Entry whose submission flips statuses reactively.

### 4.4 Recruitment funnel

Job Requisition (Pending → Open & Approved/Rejected/On Hold/Filled/Cancelled, with time-to-fill) → **Staffing Plan** (per-company/date-range vacancy budgeting per designation, parent/subsidiary roll-up validation, `number_of_positions = vacancies + current_count`) → Job Opening (WebsiteGenerator — publishes to `jobs/<company>/<title>`, daily auto-close, staffing-plan vacancy enforcement) → Job Applicant (email-named, status Open/Replied/Shortlisted/Rejected/Hold/Accepted, Kanban board, sources + referrals) → **Interview** (round templates via Interview Type with Expected Skill Set and target average rating; status Pending → Under Review → Cleared/Rejected/Cancelled; reminder scheduler; reschedule emails) → **Interview Feedback** (one per interviewer; per-skill 0–1 ratings → average; interview's rating = mean of feedback averages) → **Job Offer** (Draft → Ready to Send → Awaiting Response → Accepted/Rejected/Cancelled; status advances on *actual sent communication*; duplicate-applicant guard; vacancy validation; **compensation engine** builds a prospective SSA and either derives CTC from base or solves base for target CTC, emitting a ctc_breakup with earnings, employer contributions, gross, CTC, take-home; term templates) → Appointment Letter (template-driven print format) → Employee creation via mapper. Employee Referral (unique per email, referral-bonus payout status riding the Additional Salary pattern).

### 4.5 Performance & training

Appraisal Template (KRAs with weights summing to 100 + rating criteria summing to 100, enforced by a shared mixin). Appraisal Cycle (Not Started → In Progress → Completed; employee selection by org filters; designation→template mapping; bulk appraisal creation >30 enqueued; optional sanitized `final_score_formula`). Appraisal (one per employee per cycle): KRA scores **auto-derived from root-level Goal progress** (goal_score = completion × weightage/100), self-ratings, peer/reviewer feedback averaged, `final_score` = mean of the three axes or the formula. **Goals are a NestedSet tree** (parent goals, auto-derived status from progress, progress roll-up to parents, KRA cascades to children). Training: Program (catalog) → Event (attendance tracking) → Result (marks completion) → Feedback loop; Employee Skill Map links skills to employees; Interview Type's Expected Skill Set reuses the same Skill master.

### 4.6 Expenses & miscellaneous

Expense Claim (59 fields, 1,045 lines): typed expense rows (default accounts per Expense Claim Type, sanctioned ≤ claimed, mandatory cost center), taxes, advance allocation with receivable-account enforcement; approval_status (workflow-aware, self-approval prevention) and computed payment status (Draft → Submitted → Paid/Partially Paid/Unpaid/Rejected/Cancelled); GL postings, exchange gain/loss, **reactive recomputation of reimbursed amounts from payment-ledger hooks**; ESS scoping (self claims only). Employee Advance (Draft → Unpaid/Partially Paid/Paid → Claimed/Returned combos, APLE-derived). Travel Request (itinerary + costings), Vehicle Log (odometer monotonicity, expense-claim bridge). Employee Grievance (type, against-party via DynamicLink, Open → Investigated → Resolved/Invalid). Reports: recruitment_analytics (funnel), appraisal_overview, employee_exits (exit + FnF pending), employee_analytics, birthdays, monthly_attendance_sheet (P/A/HD/H/WO/L grid), leave balances, unpaid expense claims, salary register, bank remittance, CTC break-up.

### 4.7 Platform & delivery surfaces (added by the 2026-11-07 enumeration)

Beyond doctypes, the benchmark ships: a **dashboard layer** — 35 charts and 37 number cards across HR and Payroll (funnel, headcount by axis, attendance counts, outgoing salary, time-to-fill) fed by 2 chart sources; **7 email notifications** (leave pending/status/cancelled, exit interview scheduled, training scheduled/feedback, retention bonus); **8 print formats** (salary slip classic/compact/detailed, job offer classic/minimal/with-salary-breakup, appointment letter standard/classic); a **public jobs board** (`www/jobs`) with filters/sort/pagination and a `job_application` web form; **16 scheduler jobs** (interview reminders, birthday/anniversary/holiday-in-advance reminders, shift expiry/materialization, leave expiry/encashment/earned-leave, job-opening auto-close, check-in sync); a **mobile/PWA API** of 34 whitelisted methods (attendance, leave balances, expense claims, shifts, notifications, attachments); a standalone **roster app**; and the engagement **reminder engine** (`employee_reminders.py`). All are mapped row-by-row in `Fernly_HRMS_Feature_Parity_Matrix.md` §9.

---

## 5. Fernly Current State

Inventoried from the codebase at `b932258` and **re-verified at `bb2e046` after Phase 1 landed** (roles `ADMIN | MANAGER | MEMBER | HR`, 33 permissions in `src/lib/rbac.ts` — `attendance:manage` joined at F1.3, App Router single-page view switcher, canonical Postgres schema + generated SQLite sandbox variant per ADR-008). The five Phase-1 epics changed the picture this section described: the leave ledger now exists (F1.2), attendance records exist (F1.3), the holiday calendar exists (F1.1), the component catalog exists (F1.5), and the employment lifecycle exists (F1.6). Sub-section verdicts below are kept as originally written for the record; current statuses live in `Fernly_HRMS_Feature_Parity_Matrix.md` (row-level) and the reassessment §5 (family-level).

### 5.1 Payroll (module R7)

- **Data:** `SalaryStructure` (`prisma/schema.local.prisma:1199` — components stored as `OfferComponent[]` JSON: annual amounts, kind EARNING/EMPLOYER_CONTRIBUTION/DEDUCTION, mode FIXED/PERCENT_OF_BASIC; one active per employee, revisions retire the previous), `PayrollRun` (`:1218` — `period "YYYY-MM"` unique, `OPEN → LOCKED` one-way), `Payslip` (`:1240` — JSON `PayslipLine[]` copies, `lopDays`, `gross`, `net`, unique per run+user, `slipNo PS-<period>-<seq>`).
- **Actions** (`src/server-actions/payroll.ts`, `payroll:manage` = ADMIN+HR): structure CRUD with revision history, `createStructureFromOffer` (copies a SIGNED offer), `createPayrollRun` (snapshots every active structure; monthly = annual ÷ 12), `updatePayslip` (OPEN-only; server-side invariants: unique line keys, `lopDays ≤ days-in-period`, `net ≥ 0` — persona-audit D-01), `addPayslip` (mid-period joiner), `lockPayrollRun` (one-way), plus **`getMyPayslips`** — the self-scoped member surface (zero inputs, LOCKED runs only, YTD per calendar year).
- **Math:** real and shared with the seed — `src/lib/payroll-math.ts` (`computeLop` = gross × days / days-in-period, `round2` everywhere) on top of `src/lib/offer-math.ts` (percent-of-basic resolution). No random or fabricated numbers.
- **Honesty:** ADR-014 pre-statutory positioning with a permanent banner (payroll does not compute or file PF/ESI/professional tax/TDS/Form 16); banner text is test-pinned.
- **Verdict — *honest mechanics, demo-grade scope.*** Real arithmetic, snapshot discipline, guarded edits, one-way finality, member self-service. Pre-statutory by design: no exports, no payslip email, Float money, single currency, calendar-year YTD, no proration beyond manual LOP, no corrections.

### 5.2 HR / People

- **Data:** `LeaveType` (code, `requiresDoc`, `paid`, color) + `LeavePolicy` (1:1 per type: `annualDays`, `maxCarryOver`, `minNoticeDays`, `maxConsecutiveDays`); `LeaveRequest` (`:779` — `PENDING → APPROVED | REJECTED`, `→ CANCELLED`, decidedById/note, denormalized `days` from Mon–Fri working-day count); `LeaveBalance` (`:805` — per user/type/year, `entitled/carriedOver/used`, mutated transactionally); `EmployeeProfile` (`:823` — jobTitle, department, hireDate, contact, skills, notes; org chart via `User.managerId`); `PerformanceReview` (`:848` — `DRAFT → SUBMITTED → REVIEWED → ACKNOWLEDGED`, self + manager ratings 1–5); `OnboardingChecklist`/`OnboardingTask` (5-task default template, auto-completes).
- **Actions:** `hr-leave.ts` (`getMyLeaveData`/request/cancel self-service; `getLeaveQueue` chain-scoped for MANAGER; `decideLeaveRequest` gated to the requester's manager or ADMIN; leave-type admin at `hr:admin`), `hr-directory.ts`, `hr-reviews.ts`, `hr-onboarding.ts`, `users.ts` (role:manage, soft delete), `members.ts` (roster).
- **Verdict — *solid self-service core, thin operational surface.*** Leave requests with policy guards, transactional balances and chain-scoped approvals are real and tested. Missing: attendance entirely, holiday awareness (working days hardcoded Mon–Fri), half-days, encashment, compensatory/earned leave, offboarding, probation, and any leave/attendance→payroll link.

### 5.3 Hiring (modules R1–R8) — the strongest module

- **Data:** `HiringStageConfig` (typed stages: SCREENING/INTERVIEW/ASSESSMENT/BG_CHECK/DOCUMENTS/OFFER/CUSTOM, ownerRole, order), `Candidate` (`:950` — `ACTIVE → SELECTED → HIRED | REJECTED | WITHDRAWN` + REACTIVATE; reject reason required), `CandidateStage` (snapshot label/type; `PENDING → IN_PROGRESS → PASSED | FAILED | SKIPPED`; scorecard rating 1–5 + strengths/concerns + STRONG_HIRE/HIRE/NO_HIRE; calendar linkage), `MailOutbox` (QUEUED → SENT/SKIPPED/FAILED), `CandidateDocument` (REQUESTED → RECEIVED → VERIFIED/REJECTED), `BackgroundCheck` (INITIATED → IN_REVIEW → CLEARED/FLAGGED), `OfferTemplate`/`OfferRecord` (DRAFT → SENT → SIGNED/DECLINED, 7-day single-use token, typed full-name signature, immutable after send).
- **Actions** (`src/server-actions/hiring.ts`): board/funnel reads; candidate CRUD + stage flow at `hiring:manage`; decisions with duplicate-email and duplicate-mail guards; `scheduleInterview` (interviewer-axis ±59-minute conflict check, CalendarEvent + Reminder); **`saveScorecard`/`getMyInterviews` owner-scoped (P0-5)**; joining formalities (documents, BGV); offer send with `mailStatus`.
- **Joining** (`markJoined`): transaction creates User (deterministic email, random one-time password never emailed), TeamMember, EmployeeProfile, 5-task checklist, sets candidate HIRED, queues WELCOME outbox mail; P0-4 joiner handout (printable day-one set-password slip) covers the no-mail-provider case honestly.
- **Verdict — *end-to-end pipeline works in one sitting*** with snapshot isolation, audited outbox, server-enforced RBAC. Edges: manual-only intake (no public openings), no offer approval step (D-20), reschedules orphan calendar events (D-08), no interview round templates with skill criteria.

### 5.4 Standing conventions every enhancement must respect

1. **Self-scoped member views** — own-data actions take zero inputs, filter by session userId, nav leaves deliberately not permission-gated, labels chosen to avoid gated-module substring assertions in e2e (`src/config/navigation.ts:98-113`).
2. **MailStatus honesty** — compose (pure fn) → MailOutbox QUEUED → provider attempt → SENT/SKIPPED/FAILED; status returned to UI; Noop provider in prod-without-key; banners keyed to the same env truth.
3. **RBAC extension pattern** — Permission union + `ROLE_PERMISSIONS` + nav leaf + `requirePermission` server-side; session-only exception for own-data.
4. **Snapshot-isolation config contract** — workspace templates edited freely; per-candidate/per-employee records snapshot labels/components at creation.
5. **ADR-008 schema discipline** — edit canonical `prisma/schema.prisma` + hand-checked migration with `down.sql`; SQLite variant generated, never committed.
6. **ADR-014 payroll honesty** — no statutory computation without superseding the ADR; banner text test-pinned.
7. **Seed discipline** — `scripts/seed.js` mirrors production math deterministically; every status gets seeded data.
8. **CI gates** (`/.github/workflows/ci.yml`) — lint + typecheck + coverage-gated unit tests, bundle-budget production build, Cucumber e2e on Postgres with migrate+seed.
9. **Audit every mutation** (`logAudit` before/after) + `ActionResult` envelope + validation via `parseOrThrow`.

---

## 6. Gap Analysis

### 6.1 Coverage matrix

> **Superseded as the status layer (2026-11-07).** The rows below keep their original pre-Phase-1 "Fernly today" text except where stamped with an F1.x landing; the **row-level truth** now lives in `docs/Fernly_HRMS_Feature_Parity_Matrix.md` (314 rows, verified at `bb2e046`) and the family-level current statuses in `Fernly_HR_Payroll_Parity_Reassessment.md` §5.

Status legend — **Parity**: functionally equivalent for Fernly's context · **Partial**: works but materially thinner than the benchmark · **Missing**: absent · **Out of scope**: deliberately not built (ADR-014 or architecture boundary; rationale given).

#### Payroll

| # | Feature family | Frappe HR | Fernly today | Status |
| --- | --- | --- | --- | --- |
| P1 | Salary component catalog (master data, typed, reusable) | `Salary Component` master with 36 config fields | **F1.5 LANDED:** `SalaryComponent` master (code-unique, label/kind/mode/defaultAmount/isActive/sortOrder) with `payroll:manage` CRUD, structure-editor picker, offer mapping + auto-registration | **Parity (workspace scope)** (was Partial) |
| P2 | Component kinds incl. employer contribution | Earning / Deduction / Employer Contribution | `OfferComponent.kind` has all three | **Parity** |
| P3 | Component formulas & conditions (sandboxed eval) | AST-sandboxed `formula`/`condition` per component | FIXED / PERCENT_OF_BASIC only | **Out of scope** (see §7.0) |
| P4 | Temporal structure assignment (SSA timeline) | employee+structure+from_date, base/variable, opening balances | `effectiveFrom` + revision history, no variable/opening balances | **Partial** |
| P5 | Payroll frequencies | Monthly/Fortnightly/Bimonthly/Weekly/Daily | monthly only | **Partial** |
| P6 | Payment-days proration (DOJ/exit clipping, half days) | 5-setting proration engine, ~100 lines | manual `lopDays`, auto line, days-in-period denominator | **Partial** |
| P7 | Attendance/LWP-driven proration | Leave or Attendance mode with PPL fractions | **F1.4 LANDED:** `createPayrollRun`/`addPayslip` derive `lopDays` from attendance (ABSENT=1, HALF_DAY=0.5) + unpaid leave; `lopSource AUTO\|MANUAL` provenance with audited overrides | **Partial** (was Missing) |
| P8 | Salary slip lifecycle & finality | Draft/Submitted/Cancelled/Withheld + docstatus | OPEN/LOCKED one-way lock, immutable lines | **Partial** |
| P9 | Duplicate-slip idempotency | employee+period guard, payroll-entry-aware | `@@unique([runId, userId])` + period unique | **Parity** |
| P10 | Period aggregates (YTD/MTD/component-wise) | YTD + MTD + per-component YTD on slip | calendar-year YTD at read time | **Partial** |
| P11 | One-off adjustments | `Additional Salary` (recurring/one-shot, overwrite mode) | manual line edits while run OPEN | **Partial** |
| P12 | Arrears & corrections | reverse-simulation of past periods, LWP corrections | none | **Missing** |
| P13 | Salary withholding | Withheld status + release via JE hooks | none | **Missing** |
| P14 | Benefits & accrual ledger | flexi benefits, election, append-only accrual ledger | none | **Missing** |
| P15 | Income tax engine & exemptions | slab engine, projection, declarations vs proofs | none — pre-statutory by design | **Out of scope** (ADR-014) |
| P16 | Gratuity | rule slabs, experience methods, payout adapter | none | **Missing** |
| P17 | Loan deduction integration | lending-app-gated salary_slip_loan_utils | none | **Missing** |
| P18 | Accounting posting (GL/JV) | accrual + bank JEs, cost centers | none — no accounting module | **Out of scope** |
| P19 | Bank remittance / payment-mode export | bank_remittance, ECS reports | none | **Missing** |
| P20 | Payslip delivery (email + protected PDF) | queued emails, password policy | print view in payslip modal; no email | **Partial** |
| P21 | Payroll reports | salary register, CTC break-up, payment-mode matrix | YTD panel only | **Partial** |

#### Leave, attendance, shifts, holidays

| # | Feature family | Frappe HR | Fernly today | Status |
| --- | --- | --- | --- | --- |
| L1 | Leave type configuration richness | 33-field config doctype | paid/requiresDoc + 4 policy numbers | **Partial** |
| L2 | Leave policy & assignment | policies + bulk assignment with pro-rata | 1:1 policy per type, year-based entitlement | **Partial** |
| L3 | Append-only leave ledger | `Leave Ledger Entry` as single source of truth | **F1.2 LANDED:** `LeaveLedgerEntry` (GRANT/CARRY/CONSUME/EXPIRE/ADJUST + `isReversal`) is the source of truth; `LeaveBalance` a derived cache; EXPIRE/CARRY writers are F2.4 | **Partial** (was Missing) |
| L4 | Allocation lifecycle & expiry | periods, CF expiry rows, daily job | year rollover with maxCarryOver cap | **Partial** |
| L5 | Leave request validation chain | 10-step chain incl. processed-salary guard | notice, consecutive, overlap, balance guards (`hr-shared.ts`) | **Partial** |
| L6 | Half-day semantics | half_day across application/attendance/payroll | none | **Missing** |
| L7 | Holiday-aware day counting | holiday lists segmented per range | **F1.1 LANDED:** workspace calendar + `workingDaysBetween` + denormalized snapshots (per-employee lists out of scope) | **Parity (workspace scope)** (was Missing) |
| L8 | Leave block lists | dates + department scoping + allow-list | none | **Missing** |
| L9 | Leave encashment | encashable-days math, auto-drafts, payout adapter | none | **Missing** |
| L10 | Compensatory leave | worked-holiday validation, ledger appends | none | **Missing** |
| L11 | Earned leave accrual | schedule rows + daily job + caps + retries | none | **Missing** |
| L12 | Attendance records & statuses | Present/Absent/On Leave/Half/WFH + late/early flags | **F1.3 LANDED:** `AttendanceRecord` — 5 statuses, HR marking, leave-derived ON_LEAVE, self-service read; late/early flags absent | **Partial** (was Missing) |
| L13 | Attendance correction requests | `Attendance Request` with Skip/Overwrite | none | **Missing** |
| L14 | Check-in capture (device/geo) | `Employee Checkin`, geo-fencing, auto-attendance | none | **Out of scope** (hardware boundary) |
| L15 | Shift types & assignments | overlap-safe assignments, nightly expiry | none | **Missing** |
| L16 | Shift schedules / roster automation | hourly materialization + watermarks | none | **Missing** |
| L17 | Overtime capture → payroll | typed multipliers, slips → Additional Salary | none | **Missing** |
| L18 | Holiday calendars | lists + assignments + weekly offs | **F1.1 LANDED:** `HolidayCalendarEntry` — workspace calendar, seeded, admin CRUD | **Parity (workspace scope)** (was Missing) |

#### Employee lifecycle

| # | Feature family | Frappe HR | Fernly today | Status |
| --- | --- | --- | --- | --- |
| E1 | Employee master breadth | grouping axes, approver wiring, work history | `EmployeeProfile` + org chart + roster | **Partial** |
| E2 | Employment status lifecycle | Active/Inactive/Suspended/Left, relieving, retirement | **F1.6 LANDED:** `employmentStatus` PROBATION/ACTIVE/SUSPENDED/EXITED + probation/notice/LWD fields; guarded `transitionEmployment`; §9.3 hard gate | **Parity (workspace scope)** (was Missing) |
| E3 | Structured change history (property diffs) | Employee Property History child table | generic audit log (before/after) | **Partial** |
| E4 | Onboarding templates → tasks | ordered activity templates, user-XOR-role, holiday-aware dates | fixed 5-task default template | **Partial** |
| E5 | Onboarding gates employee creation | `IncompleteTaskError` | employee created at `markJoined` regardless of checklist | **Missing** |
| E6 | Promotion / transfer workflows | property-diff docs with history maintenance | none | **Missing** |
| E7 | Separation checklist | symmetric template flow | none | **Missing** |
| E8 | Exit interview | lifecycle + questionnaire email-once | none | **Missing** |
| E9 | Full & final settlement | auto payables/receivables, gated settlement | none | **Missing** |
| E10 | Asset tracking & recovery | Asset Movement reconstruction in FnF | none | **Out of scope** |

#### Recruitment

| # | Feature family | Frappe HR | Fernly today | Status |
| --- | --- | --- | --- | --- |
| R1 | Job requisition & approval | status machine, time-to-fill | none | **Missing** |
| R2 | Staffing plan / vacancy budgeting | designation budget roll-ups | none | **Missing** |
| R3 | Public job openings & intake | WebsiteGenerator + daily close | candidates created manually | **Missing** |
| R4 | Applicant sources & referrals | source master, referral payouts | none | **Missing** |
| R5 | Candidate pipeline & stage config | applicant status + Kanban | `HiringStageConfig` + per-candidate stage snapshots | **Parity** |
| R6 | Kanban funnel & analytics | recruitment_analytics report | funnel panel + stage counts | **Parity** |
| R7 | Interview scheduling w/ conflict checks | reminders + reschedule emails | ±59-min conflict check, CalendarEvent + Reminder | **Parity** |
| R8 | Structured scorecards | per-skill ratings, normalized averages | rating 1–5 + strengths/concerns + recommendation | **Parity** |
| R9 | Interview round templates & skill criteria | Interview Type w/ Expected Skill Set + target rating | stage types only; no skills/targets | **Partial** |
| R10 | Offer letters with component breakup & e-sign | term templates + compensation engine + CTC solver | templates, components, single-use sign flow | **Parity** |
| R11 | Offer approval before send | workflow-ready | none (D-20) | **Missing** |
| R12 | Appointment letter (post-offer) | template print format | none (offer letter only) | **Missing** |
| R13 | Recruitment reporting | recruitment_analytics | funnel only | **Partial** |

#### Performance & training

| # | Feature family | Frappe HR | Fernly today | Status |
| --- | --- | --- | --- | --- |
| F1 | Review lifecycle (self + manager + acknowledge) | appraisal flow | `PerformanceReview` 4-state lifecycle | **Parity** |
| F2 | Appraisal cycles w/ bulk creation | cycle status machine, enqueued bulk | none (one-off reviews) | **Missing** |
| F3 | KRAs & weightage | weighted KRAs, shared mixin validation | none | **Missing** |
| F4 | Goals & progress roll-up | NestedSet tree, auto status, parent roll-up | none | **Missing** |
| F5 | Multi-rater feedback | peer + reviewer feedback averaged | self + manager only | **Partial** |
| F6 | Score normalization / final score | disciplined normalization + formulas | none | **Missing** |
| F7 | Training lifecycle | program → event → result → feedback | none | **Missing** |
| F8 | Skill matrix | Skill master + maps + interview reuse | free-text skills on profile | **Partial** |

#### Expenses & misc

| # | Feature family | Frappe HR | Fernly today | Status |
| --- | --- | --- | --- | --- |
| X1 | Expense claims w/ approval & payment status | 59-field claim, reactive payment status | none | **Missing** |
| X2 | Employee advances | full status machine, APLE-derived | none | **Missing** |
| X3 | Travel requests | itinerary + costings | none | **Missing** |
| X4 | Vehicle logs | odometer + expense bridge | none | **Out of scope** |
| X5 | Grievance tracking | typed grievance lifecycle | none | **Missing** |
| X6 | Notifications & reminders engine | email templates + schedulers | Reminders + Notifications + Calendar | **Parity** |
| X7 | HR report suite | 17 HR reports + 8 payroll reports | analytics views (role-scoped) | **Partial** |

### 6.2 Coverage summary

Current at `bb2e046` (Phase 1 complete; matches the reassessment's running tally and the matrix doc's family rollup):

| Status | Count | Share |
| --- | --- | --- |
| Parity | **12** | 16% |
| Partial | **23** | 30% |
| Missing | **36** | 47% |
| Out of scope (deliberate) | 6 | 8% |
| **Total families benchmarked** | **77** | 100% |

Row-level (314 rows in the matrix doc): 31 parity · 84 partial · 161 missing · 37 out of scope · 1 beyond-benchmark.

The pre-Phase-1 snapshot this section originally showed (9 / 21 / 41 / 6) is preserved in git history.

Where Fernly is already strong (hiring pipeline, interview scheduling, scorecards, offer e-sign, review lifecycle, notifications), it reached parity with the benchmark's *shape* while staying far smaller. Where it is weakest is the **operational middle**: attendance (L12–L18), the leave ledger (L3), the employment lifecycle (E2, E5–E9), and everything payroll does *after* net pay is computed (P12–P21).

### 6.3 Narratives for the critical gaps

> **Historical (written pre-Phase-1, kept for the record).** The first two narratives below were the F1.2 and F1.3 problem statements and are now resolved; the third is resolved by F1.6 for the status arc itself (promotion/transfer and offboarding/FnF remain F2.5/F2.1); the fourth and fifth are still current.

**The leave balance is a number, not a story.** Fernly's `LeaveBalance` stores `entitled/carriedOver/used` and mutates them inside approve/cancel transactions. The invariant `used == Σ APPROVED request days` is maintained in code, but there is no audit-grade record of *when* balance changed or *why* — no grant rows, no expiry rows, no per-request consumption rows. The benchmark's answer is the append-only `Leave Ledger Entry`: every allocation, consumption, expiry and encashment is a signed row, balances are aggregates, and cancellation writes reversals. This single refactor unlocks encashment (L9), compensatory leave (L10), earned-leave accrual (L11), carry-forward expiry (L4) and honest leave reports — it is the highest-leverage change in this plan.

**Nothing observes whether people showed up.** Fernly has no attendance module at all. The benchmark derives Present/Absent/Half/WFH from check-ins or manual marking, feeds "On Leave" from approved leave, and then drives payroll proration from it. Fernly's LOP days are typed by hand. An attendance record set (L12) with a correction flow (L13) and an attendance→LOP derivation (P7) is what turns payroll from "numbers I typed" into "numbers the system observed" — while staying honest, because the derivation stays overridable with an audit note.

**Employment is a date, not a lifecycle.** `EmployeeProfile.hireDate` exists; probation, notice period, suspension, last working day, promotion and transfer do not (E2, E6). Offboarding is entirely absent (E7–E9): no separation checklist, no exit interview, no full-and-final settlement — yet Fernly already owns every ingredient (checklist machinery from onboarding, payroll runs and structures for dues, leave balances for encashment). The benchmark's FnF auto-assembles payables and receivables and gates settlement; a Fernly equivalent can do the same on the current stack as a computed statement plus a settlement flag.

**Payroll stops at the number.** Net pay is computed, locked, and visible to the member — then nothing happens (P19–P21): no bank CSV, no emailed payslip, no register, no corrections (P12), no arrears. These are small, high-visibility features compared to the engine itself, and they ride existing patterns (MailOutbox for email honesty; print CSS already present; LOP corrections can reuse the reverse-simulation idea at toy scale).

**Appraisals are one-off events, not a cycle.** `PerformanceReview` models a single DRAFT→ACKNOWLEDGED flow per review; the benchmark runs organization-wide cycles with weighted KRAs, goal progress feeding KRA scores, and multi-rater averaging (F2–F6). Fernly's four-state lifecycle is a good base; cycles and weightage are additive, not a rewrite.
---

## 7. Enhancement Plan — Phased Epics

### 7.0 Guiding principles

**Patterns borrowed from the benchmark** (adapted to Fernly's stack):

1. **Ledger-as-truth** — append-only signed rows; balances are aggregates; corrections are reversals, never edits (from `Leave Ledger Entry` / `Employee Benefit Ledger`).
2. **Savepoint-per-item batches** — Prisma interactive transactions per record in every bulk flow, so one failure rolls back alone (from payroll entry / bulk SSA assignment).
3. **Config-driven validation** — behavioral switches live in master data (leave types, component catalog), keeping actions thin (from `Leave Type` / `Salary Component`).
4. **Derived statuses** — completion percentages and payment statuses computed from facts via hooks, never hand-edited (from `boarding_status` / reactive claim payment status).
5. **Watermark-based scheduled jobs** — Fernly already has an authenticated cron route; every recurring job persists its cursor and is idempotent (from earned-leave schedule / check-in sync).
6. **Universal adjustment adapter** — one `PayAdjustment` shape carries every special flow (encashment, gratuity, correction) with `sourceType/sourceId` linking back (from `Additional Salary`).
7. **Policy-as-data (2026-11-08 directive)** — every organization-variable knob (leave quotas, allocation strategies, negative-leave floor, deduction modes, holiday dates, encashment/FnF slabs) is a DB row behind the existing admin surfaces; code owns the strategy *space*, the database owns the *instance*. All deciding logic is pure functions in each module's `rules/` (clock-free, I/O-free — `asOf` injected). Full model: `Fernly_Policy_Engine_Design.md`.

**Consciously not building** (each declination mapped to a hazard identified in the benchmark):

| Declined capability | hrms carrier | Why not |
| --- | --- | --- |
| User-authored formula/condition sandbox | Salary Component eval | Security-sensitive trusted-input sandbox; structured modes (FIXED / PERCENT_OF_BASIC, later flat slabs) cover the need |
| Statutory engines (PF/ESI/TDS/Form 16/professional tax) | regional hooks, income tax engine | ADR-014 — honesty over half-implementation; any configurable deduction slabs must be labeled non-statutory |
| Double-entry accounting posting | JEs, cost centers, payment ledger | Fernly has no accounting module; totals + payment flags suffice |
| Multi-company / multi-currency | company scoping, exchange rates | Single-workspace product; adds schema + testing cost everywhere |
| Timesheet-based payroll | salary_slip timesheet path | Third code path in the benchmark; one (fixed monthly) is the honest scope |
| Device check-in, geo-fencing | Employee Checkin + shift locations | Hardware boundary; manual + CSV import covers a small org |
| Regional statutory plugin architecture | `allow_regional` hooks | No statutory surface to hook into |

**Stack rule:** every epic ships on Next.js + Prisma + SQLite sandbox / Postgres canonical — no new infrastructure, no background workers (the cron route and request-scoped transactions suffice at ≤200-employee scale).

### 7.1 Phase 1 — Foundation (6 epics)

The load-bearing gaps. Each is a prerequisite for Phase 2 features and each lands independently.

> **STATUS: COMPLETE (2026-11-07).** All six epics landed first-commit-clean with CI green, in the order F1.1 (`58b0fa7`) → F1.3 (`5ef0dd1`) → F1.4 (`534b2f4` + CI fixes to `c68e1c3`) → F1.2 (`89c0844`) → F1.5 (`42c6d82`) → F1.6 (`bfd1bd9`); full landing evidence per epic is in `Fernly_HR_Payroll_Parity_Reassessment.md` §7.1. The epic texts below are kept as the accepted specs. Fold-ins that rode along: F-R4 (working-day notice, F1.2), F-R1 (transactional retire+create, F1.5), F-R13 (DB-aware `checkPermission`, F1.5), F-R15-payroll-half (F1.4). Coverage moved 9→12 parity, 41→36 missing.

**F1.1 Holiday calendar.** *Goal:* replace hardcoded Mon–Fri working-day math with a workspace holiday calendar. *Data:* `HolidayCalendarEntry` (date unique, label, `isHalfDay`, `kind PUBLIC/WEEKLY_OFF`). *Scope:* admin CRUD at `hr:admin`; a `workingDaysBetween()` helper in `src/lib/` consumed by leave-day counting and the LOP denominator; seed the current + next year. *Acceptance:* leave request days and payslip `days-in-period` respect holidays; unit tests for the helper; e2e with a holiday inside a request range. *Size:* **S**. *Depends on:* none.

**F1.2 Leave ledger refactor.** *Goal:* append-only `LeaveLedgerEntry` (userId, leaveTypeId, year, `delta` signed, `entryType GRANT/CONSUME/EXPIRE/ADJUST/CARRY`, sourceType/sourceId, note, createdAt) as the source of truth; `LeaveBalance` becomes a derived cache or is dropped in favor of aggregate queries. *Method:* migration backfills ledger rows from existing balances + approved requests (idempotent, reversible via `down.sql` per ADR-008 discipline). *Acceptance:* invariant test `used == Σ CONSUME`; approve/cancel write reversal rows, never mutate; all existing leave e2e stays green unchanged. *Size:* **M**. *Depends on:* none. *This is the highest-leverage epic in the plan.*

**F1.3 Attendance records.** *Goal:* `AttendanceRecord` (userId, date, status `PRESENT/ABSENT/HALF_DAY/WFH/ON_LEAVE`, optional inTime/outTime, note, source `MANUAL/IMPORT/DERIVED`), unique per user+date. *Scope:* HR/admin marking at a new `attendance:manage` permission (ADMIN+HR); member read of own month (`getMyAttendance`, self-scoped convention); approved leave auto-marks `ON_LEAVE` rows (ADR-009 virtual-event precedent); monthly grid view in the HR area. *Decision (§9.1):* no member self-marking — WFH is a status HR sets, never a member self-request; card scanning is a future phase. *Acceptance:* duplicate-guard test; leave→attendance derivation test; RBAC e2e. *Size:* **M**. *Depends on:* none.

**F1.4 Attendance→LOP derivation.** *Goal:* `createPayrollRun` pre-computes each payslip's `lopDays` from attendance (`ABSENT` = 1, `HALF_DAY` = 0.5) plus unpaid leave days (LeaveType `paid = false`), using F1.1's denominator; the payslip shows `lopSource: AUTO|MANUAL` and manual overrides set it to MANUAL with an audit note. *Acceptance:* unit tests of the derivation (absent/half/unpaid-leave mix); e2e: run with absent days produces the LOP line automatically; honesty note visible. *Size:* **S**. *Depends on:* F1.1, F1.3.

**F1.5 Salary component catalog.** *Goal:* promote components from embedded JSON to a `SalaryComponent` master (code unique, label, kind, mode, percent, `active`), with structures referencing codes; existing JSON contracts migrate losslessly (snapshot discipline preserved — structures keep their copies). *Scope:* catalog CRUD at `payroll:manage`; structure editor picks from catalog; `createStructureFromOffer` maps through the catalog. *Acceptance:* roundtrip unit tests (catalog → structure → payslip lines); existing payroll e2e green. *Size:* **M**. *Depends on:* none.

**F1.6 Employment lifecycle fields.** *Goal:* `employmentStatus PROBATION/ACTIVE/SUSPENDED/EXITED` + `probationEndsAt`, `noticePeriodWeeks`, `lastWorkingDay` on EmployeeProfile; guarded transitions with audit; hireDate feeds probation defaults. *Decision (§9.3):* `PROBATION → ACTIVE` is a **hard gate** — the transition is rejected while the probation review is outstanding. *Acceptance:* transition tests incl. the gate (review pending → transition refused; completed → allowed); directory shows status; exit path (Phase F2.1) can rely on it. *Size:* **S**. *Depends on:* none.


### 7.1.1 Phase 1 — Residual Sweep (added 2026-11-08, user-directed)

The 2026-11-08 audit re-verified every Phase 1 family against the row-level matrix and the code. All six epics hold at epic-spec level, but each family left residuals. This sweep closes them **one item per commit**, in risk-first order (defects → attendance → pay-day engine → leave tools → lifecycle → hygiene), under the standing directives: core domain logic in pure functions, every organization-variable knob a DB/config row, same plan→develop→review→commit steps.

| # | ID(s) | Item | Decision (2026-11-08 answers) |
| --- | --- | --- | --- |
| S1 | F-R2 (A) | **DONE** `updatePayslip` optimistic lock — `Payslip.version`, expected-version refusal, conflict surfaced in the modal | version column, friendly conflict error |
| S2 | AT-B02/B03 | **DONE** Late-entry/early-exit flags + working hours computed from in/out | reference = workspace default day (Settings, default 09:00–17:30), computed on save |
| S3 | F-R15 (C) | **DONE** Server-side guard: attendance marks rejected on non-working days | hard guard matching the grid shading |
| S4 | PR-B07/AT-B08 | `unmarkedAttendanceMode IGNORED\|ABSENT` knob feeding the LOP derivation | default IGNORED (zero behavior change, ADR-008) |
| S5 | PR-B06 | Joiner/exiter payment-day clipping (DOJ/LWD within the period) | default ON — deliberate correctness fix (F2.10 gate precedent), e2e-pinned |
| S6 | PR-B02 | Per-component `dependsOnPaymentDays` opt-out (catalog + snapshot) | default true (today's implicit behavior) |
| S7 | PR-B23 | Configurable payroll rounding policy | default ROUND_2DP (zero behavior change) |
| S8 | PR-B03 | Statistical components (display-only, excluded from net) | new STATISTICAL kind |
| S9 | LV-10 | HR leave adjustment tool — user-facing ADJUST ledger writer | `hr:admin`, reason required, floor-honest |
| S10 | LV-B10 | Salary-processed guard — unpaid leave cannot overlap a LOCKED slip | validation-chain step |
| S11 | LV-B11 | Attendance-conflict guard in the leave chain | refuse on explicit (non-derived) marks in range |
| S12 | LV-B08 | Cross-request max-consecutive-days walk | pure helper, adjacency by calendar day |
| S13 | EM-B01 | Employee-number series EMP-0001 | zero-padded 4-digit, deterministic backfill |
| S14 | EM-B04/LV-B13 | Leave-approver override | `EmployeeProfile.leaveApproverId`, chain: override → manager → ADMIN/HR |
| S15 | F-R3 (B) | YTD dual-basis note in the payslip modal | one honesty line |
| S16 | F-R14 (C) | Dead enum/constants cleanup | remove `IMPORT` source + dead exports, fix comment drift |
| S17 | F-R12 (B) | Transactional multi-row hiring mutations | one `$transaction` per action |
| S18 | F-R18 (C) | Interview-event timezone honesty | day-basis consistency for the duplicate guard |

**Explicitly out of this sweep** (not Phase-1 families): E1 employee-master breadth (branch/grade/employment-type grouping axes, EM-03/EM-09 — the E1 breadth epic), encashment (F2.2), PayAdjustment (F2.3), property history (F2.5), payslip PDF (F2.6), half-day request shape (F2.9), shifts (F3.5), reports/cards (X7/F3.9). Stale matrix rows found by the audit (e.g. LV-B17, satisfied by F2.4's `prorateForJoiners`) are corrected in the matrix as each landing updates it.


### 7.2 Phase 2 — Growth (10 epics)

Operational parity for daily HR running. Ordered by user-visible value.

> **Re-sequenced 2026-11-07** after the row-level matrix pass: **F2.1 stays next** (it consumes F1.6's EXITED arc), and the new **F2.10 (joining hardening) runs second** — the Onboarding module is a user-named core module, and the matrix's RJ/EM rows show its gaps are concentrated, cheap, and high-visibility (offer expiry/approval, payroll-ready joining, the joining gate, interview-invite email). Recommended order: **F2.1 → F2.10 → F2.2 → F2.3 → F2.4 → F2.5 → F2.6 → F2.7 → F2.8 → F2.9**. F2.9's offer-approval scope moved into F2.10.

**F2.1 Offboarding & full-and-final lite.** Separation checklist (reuse the onboarding checklist machinery with a `SEPARATION` kind), `ExitInterview` record (scheduled/completed + notes), and a computed `FullAndFinalStatement`: payables (current OPEN run's net if unprocessed, unused-leave encashment per F2.2, any pending bonuses) minus receivables (outstanding advances per F2.8) with `UNSETTLED → SETTLED`. Settlement locks editing and audits amounts. *Acceptance:* statement math unit tests; e2e hire→probation→exit→settled. *Size:* **M**. *Depends on:* F1.6.

> **STATUS: COMPLETE (2026-11-08).** Landed first-commit-clean: pure kernel `lib/full-and-final.ts` — `computeFullAndFinal` assembles payables (every OPEN run's payslip net; an OPEN run WITHOUT a payslip yields a visible note, not a silent zero) + paid-type encashment (positive ledger balances × daily rate = monthly gross ÷ the LWD month's holiday-aware working days, the F2.2-default `GROSS_OVER_WORKING_DAYS` basis until F2.2's knobs land) minus receivables (negative paid-type balances — F2.4's advance leave recovered at exit, per the policy design §5.2/§5.5) — 20 statement-math tests (the acceptance criterion). Writers in `server-actions/hr-offboarding.ts`: the overview read (EXITED ∪ separation-checklist ∪ live-interview ∪ FnF-row orbit, live computation per read), the exit-interview lifecycle (PENDING → SCHEDULED → COMPLETED/CANCELLED, one LIVE per employee, in-app scheduling notification — EM-T01 lite under the F-R17 zero-mail discipline), `generateFullAndFinal` (EXITED + LWD gated, UNSETTLED row with generation snapshot) and `settleFullAndFinal` (freezes the LIVE amounts, audits them, one-way). Separation checklists reuse the onboarding machinery end-to-end (`kind` column + 5-task default template + manager auto-assignment — EM-14). "Settlement locks editing": `updatePayslip`/`addPayslip` refuse an employee with a SETTLED statement; `createLeaveRequest` refuses an EXITED employee (offboarding finality). UI: the hr console Offboarding tab (cards with checklist ticks, interview actions, statement lines/totals/notes, generate/settle). Seed: Soren Lindqvist as the demo leaver (EXITED + LWD this month, OPEN-run payslip, Annual +4 / Advance −2 ledger story, 3/5 checklist, COMPLETED interview, UNSETTLED statement). Migration `20261124000000_offboarding_fnf` (additive, zero-behavior defaults, down.sql). Full local suite 110 files / 2030 tests green (19 new offboarding action tests + 2 payslip-lock + 2 leave-guard); lint + typecheck + build green. E2E `hr-offboarding.feature`: exit→settled on Rafael + the seeded-leaver settle→payslip-lock scenario (the hire→probation legs ride the existing hiring/hr-directory features); local e2e blocked by the same pre-existing sandbox Chrome login quirk (reproduced on unchanged scenarios — and traced further this round: the sandbox browser drops session cookies on document navigation while fetches carry them) — CI's containerized e2e is the gate. Matrix: EM-14/EM-15/EM-16 + EM-B12/B14 + EM-T01 → Partial; row-level 37/83/156 → 37/89/150.

**F2.2 Leave encashment.** Encashment request per leave type with policy knobs (`encashable` flag, `maxEncashableDays`, `nonEncashableDays`); amount = encashable days × daily rate (structure gross ÷ working days, via F1.1 math); payout materializes as a **PayAdjustment (F2.3)** consumed by the next OPEN run — payroll stays single-writer. *Acceptance:* ledger CONSUME row on approval; amount math tests; e2e request→approval→payslip line. *Size:* **M**. *Depends on:* F1.2, F1.1.

**F2.3 PayAdjustment universal adapter.** `PayAdjustment` (userId, `sourceType/sourceId`, componentCode, amount, `period "YYYY-MM"`, `status PENDING/CONSUMED/SKIPPED`, note). `createPayrollRun` imports PENDING adjustments for the period into payslip lines and marks CONSUMED (with reversal handling on run reopen — none, since locks are one-way; skipped with note instead). *(2026-11-08 extension)* Component calc modes grow `PERCENT_OF_GROSS` and `PERCENT_OF_NET` — the run is the consumer, so the two-pass ordering spec (gross-based deductions first, then percent-of-net sequentially in `sortOrder`, no fixed-point iteration) lands with this epic; pure math in `account/rules/deductions.ts` per the policy design §5.1. *Acceptance:* adapter unit tests; one e2e per source type; deduction-ordering golden tests. *Size:* **M**. *Depends on:* F1.5.

> **STATUS: COMPLETE (2026-11-08).** Landed first-commit-clean: pure kernel `lib/leave-policy.ts` (41 rule-matrix tests) + job core `lib/leave-allocation-core.ts` (9 writer tests) + `/api/cron/leave-allocation` (own maintenance-lock key, compose scheduler wired) + strategy-aware materialization in `hr-shared.ts` (MANUAL byte-identical legacy path) + floor-aware guards in `hr-leave.ts` (8 new action tests, suite 88 green) + the strategy editor in the hr console + advance rendering in the Leave view + the seeded "Advance Annual" demo type with per-month GRANT ledger mirrors + migration `20261123000000_leave_policy_strategy` (additive, zero-behavior defaults, down.sql). Full local suite 108 files / 1987 tests green; row-level parity 31 → 37 (matrix rows LV-B02/B04/B05/B06/B07/J03 to Parity; LV-04/B18 to Partial — the leave family stays Partial family-level until F2.2's encashment lands). Local e2e could not run (sandbox Chrome cannot complete login→shell — pre-existing, reproduced on unchanged scenarios); CI's containerized e2e is the gate.

**F2.4 Leave policy engine — allocation strategies, negative allowance, earned leave, carry expiry (expanded 2026-11-08).** `LeavePolicy` grows an allocation-strategy block (design doc §4.1): `allocationStrategy MANUAL | ANNUAL_LUMP_SUM | EARNED | AFTER_SERVICE` with knobs `accrualFrequency` (MONTHLY/QUARTERLY/HALF_YEARLY/ANNUAL), `allocateOnDay`, `accrualRounding` (quarter-day floor + final-period true-up), `accrualCap`, `grantOn`, `prorateForJoiners`, `minServiceMonths`, `accrueDuringProbation`, `allowNegative` + `negativeFloor`, `carryExpiresAfterMonths`, `countHolidaysInLeave` — covering the directive's organizations verbatim: advance leave repaid by monthly accrual (EARNED + allowNegative), and the full-year deposit after 12 months of service (AFTER_SERVICE). The engine is three writers over one pure rule `dueGrants(policy, employmentFacts, projection, asOf)` in `hr/rules/allocation.ts`: request-time lazy materialization (today's shape), the cron `allocateDue` job (watermarked, idempotent via deterministic `POLICY:<user>:<type>:<year>:<period>` source keys — matrix LV-J03/B18), and the year-end rollover (CARRY ≤ `maxCarryOver`, EXPIRE for cap + expiry). The overdraft guard extracts to `hr/rules/leave-guard.ts` and becomes floor-aware: reject when `available − requested < −negativeFloor` (identical to today at floor 0). Negative balance renders honestly in the UI ("N day(s) in advance"). *Decision (§9.5 unchanged):* accrual is configured per leave type — types may differ in strategy. *Acceptance:* negative-floor guard tests (approve at floor, reject past it); EARNED idempotency (double-run → single row); accrual sums to `annualDays` exactly (floor + true-up); lump-sum DOJ pro-rata math; AFTER_SERVICE grant on the service anniversary; cap enforcement. *Size:* **M**. *Depends on:* F1.2. *Closes matrix LV-B02/B06/B18, LV-J03, and the strategy half of LV-01/LV-04.*

**F2.5 Promotion & transfer with property history.** `EmploymentChange` (userId, `kind PROMOTION/TRANSFER`, effectiveDate, structured field diffs `property/from/to`) applying to jobTitle/department/manager; applied transactionally with audit; feeds the org chart and directory. *Acceptance:* diff application + revert tests; e2e. *Size:* **M**. *Depends on:* F1.6.

**F2.6 Payroll delivery & exports.** Payslip PDF (server-rendered print layout — reuse the existing modal print CSS as the source of truth) as a **download only — never emailed** (decision §9.2: the email component is descoped); bank CSV export per locked run (columns configurable once, non-statutory disclaimer in header comment), salary register CSV. *Acceptance:* CSV golden-file test; PDF snapshot test; download e2e. *Size:* **M**. *Depends on:* none (uses existing outbox).

**F2.7 Appraisal cycles + goals + KRAs.** `AppraisalCycle` (period, status `DRAFT/ACTIVE/COMPLETED`) bulk-creating `PerformanceReview`s; `Kra` master with weightage (Σ=100 validation, shared mixin pattern); flat `Goal` list (owner, cycle, KRA, progress 0–100, status derived from progress) whose completion feeds KRA scores; final score = weighted normalization (borrow hrms's normalization discipline; no free-form formula). *Acceptance:* weight-sum validation test; goal→score derivation test; e2e cycle run. *Size:* **L**. *Depends on:* none.

**F2.8 Expense claims & advances lite.** `ExpenseClaim` (typed line items, total, `approval_status`, `paymentStatus UNPAID/PAID`, per-line receipt `fileRef` string — no upload yet, matching the candidate-document convention) and `EmployeeAdvance` (amount, `status OPEN/SETTLED/RETURNED`, outstanding derived); advance recovery suggests a DEDUCTION PayAdjustment. *Acceptance:* state-machine tests; e2e claim→approve→paid; advance→payslip deduction. *Size:* **L**. *Depends on:* F2.3 (for advance recovery).

**F2.9 Half-day semantics + interview round templates.** Half-day leave requests (`halfDayDate` inside range, 0.5-day consumption; attendance HALF_DAY interplay from F1.3); `InterviewRoundTemplate` (skills with expected ratings → scorecard criteria) reused by stage config. *(The offer-approval step and the whole joining-hardening bundle moved to F2.10 at the 2026-11-07 re-sequencing.)* *Acceptance:* each rides its module's existing e2e file. *Size:* **M**. *Depends on:* F1.3.

**F2.10 Joining hardening — the Onboarding-module epic (added 2026-11-07).** The benchmark's offer→join chain gates and automates what Fernly currently leaves to HR memory (reassessment §7.3, now epic-sized because Onboarding is a named core module). Scope, in the order it hurts: (1) **offer expiry + approval** — `OfferRecord` gains an `EXPIRED` outcome (F-R5: expired links stop counting as "awaiting"; `declineOffer` honors the expiry check) and a `DRAFT → APPROVED → SENT` approval step gated to a manager role distinct from the composer (R11/D-20); (2) **payroll-ready joining** — `markJoined` copies the signed offer into a `SalaryStructure` inside its transaction (or immediately after, with a visible payroll-ready flag) so no joiner is silently unpaid (F-R7); (3) **joining gate** — configurable precondition that every mandatory document is VERIFIED and any background check is terminal before `markJoined` runs (E5/F-R9, mirroring the benchmark's `required_for_employee_creation`); (4) **onboarding template unification** — one template source with assignable tasks, no inline copy in `markJoined` (F-R8); (5) **interview-invite email** — write the reserved `INTERVIEW_INVITE` outbox kind on schedule/reschedule and clean up the orphaned CalendarEvent/Reminder pair (F-R10 + F-R6); (6) **`{{startDate}}` LetterVars fix** (F-R11); (7) **appointment letter** — post-sign printable letter with the benchmark's placeholder discipline (R12), riding the print pattern the offer-sign page already proves. *Acceptance:* expiry/approval state-machine tests (live vs expired link both counted honestly); join→structure roundtrip e2e; gate-refusal e2e; invite email e2e; appointment-letter render test. *Size:* **L**. *Depends on:* none hard — F1.5's catalog makes (2) a mapping, not a copy. *Runs second, after F2.1.*

> **STATUS: COMPLETE (2026-11-08).** Landed first-commit-clean, all seven items: **(1) offer expiry + approval** — `OfferRecord` gains `approvedById/approvedAt/startDate` + the `EXPIRED` outcome; new `hiring:approve` permission (MANAGER + ADMIN, deliberately NOT HR — the composer's role) backs `approveOffer`'s four-eyes rule (the composer can never approve their own draft), `sendOffer` now requires APPROVED, an edit to an APPROVED offer demotes it back to DRAFT (re-approval), `declineOffer` honors the expiry check symmetric with `signOffer`, and `lapseExpiredSentOffers()` lazily flips stale SENT links to EXPIRED on hiring reads (the F2.4 lazy-materialization pattern) while the funnel counts `awaiting` through the pure `isOfferLinkExpired` predicate and reports `expired` separately — R11/D-20 + F-R5 closed. **(2) payroll-ready joining** — `markJoined` copies the signed offer into an ACTIVE `SalaryStructure` inside its own transaction (createStructureFromOffer's catalog discipline inlined: canonical labels, offer amounts, unseen codes auto-register), returns `payrollReady` (false + a loud amber warning when the offer had no components — never silently unpaid), and the hired summary + day-one handout render the verdict — F-R7 closed. **(3) joining gate** — `Workspace.joiningGateEnabled` (default **true**, a deliberate behavior change mirroring the benchmark's `required_for_employee_creation`; toggle in Settings → General) gates `markJoined` on the pure rule `evaluateJoiningGate` (`lib/joining-gate.ts`): every ACTIVE+MANDATORY `DocumentTypeConfig` VERIFIED and every background check terminal (FLAGGED is a decision, not a blocker); the refusal lists the blockers and the formalities panel renders the same verdict before it bites — F-R9/E5 closed. **(4) template unification** — new `OnboardingTemplateTask` table (kind/title/dueOffsetDays/assignSelf/isActive/sortOrder, `onboarding:manage` CRUD, HR console editor) with the canonical constants (`lib/onboarding-template.ts`) as the empty-table fallback; `createChecklist` AND `markJoined` instantiate through the ONE shared `instantiateChecklist` (manager auto-assignment included — the drift fix), and the joiner handout prints the REAL instantiated tasks from markJoined's return instead of its third client copy — F-R8 closed. **(5) interview-invite email** — `composeInterviewInviteEmail` (`lib/hiring-email.ts`, pure) + the shared `sendOutboxMail` helper (F-R16's extracted QUEUED→send→resolve dance, now used by sendOffer/markJoined/scheduleInterview too) write the reserved `INTERVIEW_INVITE` kind on every schedule AND reschedule (no same-day guard by design — the email carries the new time); `scheduleInterview`'s event/reminder/stage writes are one transaction and a reschedule deletes the previous pair via the new `Reminder.eventId` link — F-R10 + F-R6 closed. **(6) `{{startDate}}`** — `OfferRecord.startDate` (optional) feeds `formatOfferDate` into the letter at generation; the draft editor exposes the date field — F-R11 closed. **(7) appointment letter** — the signed state of the public `/offer/[token]` page renders a printable Letter of Appointment (heading + letter snapshot + package table + "Accepted electronically" signature block) riding the payslip modal's `.print-area`/`window.print()` pattern — R12 closed (lite: no template master). Writers: `approveOffer`, `getOffersAwaitingApproval` (the manager's lean queue — no tokens/letters), `getHiringPermissions` + `canApprove`; UI: the Offer approvals panel (manager view), the offer builder's APPROVED/EXPIRED chips + approval trail + start-date field, the joining-gate status block + payroll-ready line, the onboarding template editor, the settings toggle. Seed: the 10 template rows, Priyanka's DRAFT with a real start date (+ her older EXPIRED QA-band attempt for the funnel's expired count), Sam's SKIPPED INTERVIEW_INVITE outbox row. Migration `20261125000000_joining_hardening` (additive except the documented gate default; down.sql). Full local suite **113 files / 2095 tests green** (65 new: 14 offer-lifecycle/joining-gate/onboarding-template/invite-composer rule tests, 38 hiring action tests incl. the approval state machine, gate refusal/pass, structure copy, reschedule cleanup + invite, and the approvals queue, 10 onboarding action tests, 9 offer-sign-view appointment-letter tests, + rbac matrix/handout/formalities fixtures). Lint + typecheck + build green; reseed green. E2e `hiring.feature`: the manager-approves scenario, the send/sign flow behind approval + the appointment-letter assertion, the gate-refusal + formalities-completion scenarios, and the interview-invite scenario; local e2e still blocked by the same pre-existing sandbox Chrome login quirk (reproduced on the unchanged my-interviews feature — sessions drop on navigation), CI's containerized e2e is the gate. Matrix: RJ-11/B12/B13, EM-13, RJ-B07 → Parity; EM-12, EM-B08, RJ-14, RJ-16 → Partial; row-level 37/89/150 → **40/92/144**.

### 7.3 Phase 3 — Parity breadth (10 epics)

**F3.1 Payroll corrections & arrears-lite.** Re-simulate a LOCKED period under a corrected input (structure change or LWP correction) → emit the delta as a PayAdjustment in the next OPEN run with a link back. Toy-scale reverse-simulation, honestly labeled. *Size:* **M**.

**F3.2 Benefits accrual lite.** Annual per-employee election of benefit components; accrual rows per locked run; claims against accrued balance. *Size:* **M**.

**F3.3 Gratuity rules lite.** Slab config (years → fraction) × final-average-earnings, computed on demand into FnF; non-statutory disclaimer. *Size:* **S**.

**F3.4 Configurable deduction slabs.** Flat rate-table deductions (name → banded percentages) as *custom rules*, explicitly non-statutory. **Requires superseding/extending ADR-014** — an explicit product decision, not a silent scope change. *Decision (§9.4): rejected for now — ADR-015 stays deferred; do not start without a new product decision.* *Size:* **M**.

**F3.5 Shifts lite.** Shift types + assignments + attendance shift scoping (no auto check-in pairing). *Size:* **M**.

**F3.6 Public job openings & requisitions.** Job opening publication (public route like `/offer/[token]`), application intake creating candidates; internal requisition approval. *Size:* **L**.

**F3.7 Training lite.** Program → event → attendance → feedback. *Size:* **M**.

**F3.8 Grievance tracking.** Typed grievance with `Open → Investigated → Resolved/Invalid`. *Size:* **S**.

**F3.9 Report suite.** Leave balances, monthly attendance sheet, salary register, recruitment funnel — CSV/XLSX export + analytics views, role-scoped (ADR-013 pattern). *(2026-11-07: scope now explicitly includes the humane subset of the benchmark's analytics surface surfaced by the matrix — the leave-ledger report view, key number cards on existing views, and the `employee_exits` report once F2.1 lands — NOT a full dashboard/chart framework.)* *Size:* **M**.

**F3.10 Engagement reminders lite (added 2026-11-07).** Birthday + work-anniversary + advance-holiday reminders riding the proven cron-route pattern (`/api/cron/prune-audit`) with MailOutbox honesty — surfaced by the row-level matrix (benchmark jobs EM-J01–03, notification engine PL-02; the `employee_birthday` report rides along). Small, high-visibility, zero new infrastructure. *Size:* **S**.

### 7.4 Sequencing summary

```
Phase 1 (Foundation)      Phase 2 (Growth)                       Phase 3 (Parity)
F1.1 holidays ───────────► F1.4 LOP derivation   [all DONE]
F1.2 leave ledger ────────► F2.2 encashment, F2.4 leave policy engine
F1.3 attendance ──────────► F2.9 half-days, F1.4
F1.5 component catalog ──► F2.3 PayAdjustment ─► F2.8 advances, F3.1 corrections
F1.6 employment status ──► F2.1 offboarding/FnF, F2.5 promotion/transfer
(2026-11-07 order)        F2.1 → F2.10 joining hardening → F2.2 → F2.3 → F2.4
                            → F2.5 → F2.6 → F2.7 → F2.8 → F2.9
(independent)              F2.6 delivery/exports, F2.7 appraisal cycles
```

Suggested order within Phase 1 (executed): F1.1 → F1.3 → F1.4 (visible value: attendance + honest LOP), then F1.2 → F1.5 → F1.6 (structural depth) — **all six landed; Phase 1 complete**. Phase 2 order after the 2026-11-07 re-sequencing: **F2.1 → F2.10 → F2.2 → F2.3 → F2.4 → F2.5 → F2.6 → F2.7 → F2.8 → F2.9** — as executed, F2.4 landed FIRST (the 2026-11-08 purity/policy directive pulled the leave-policy engine ahead of its slot), F2.1 second and F2.10 third (2026-11-08, joining hardening); remaining: **F2.2 → F2.3 → F2.5 → F2.6 → F2.7 → F2.8 → F2.9**. Each epic follows the house pipeline: plan → review → code → code review → tests (unit + manual + automation) → final review → CI benchmark → doc update → one commit → push → CI green. **Structural interleave (2026-11-07):** M0 fences → M1 hr module → M2 account module → **F2.1** → M3 joining module → **F2.10** → F2.2–F2.9 → M4 admin module → Phase 3 — each functional epic lands inside its module home (§7.5; full sequencing in `Fernly_Domain_Modules_Architecture_Plan.md` §9). *(M0–M2 have not run yet — F2.4, F2.1 and F2.10 all landed on the pre-M layout (`src/lib` + `src/server-actions`), by the same note as the policy design's Appendix C/D.)*

### 7.5 Structural track — domain modules (M0–M4, added 2026-11-07)

Per the 2026-11-07 modularization directive, all benchmark functionality is incorporated through **four separate logic modules** — `src/modules/{hr,admin,account,joining}` over a `shared` kernel — to enhance modularity. Full charters, the complete 314-row module assignment (145 / 24 / 93 / 52), module contracts, ESLint boundary fences, coverage-gate changes, and per-epic file-move maps live in `docs/Fernly_Domain_Modules_Architecture_Plan.md`; `scripts/module_rollup.py` reproduces the module × status rollup.

| Epic | Scope | Size |
| --- | --- | --- |
| **M0 Scaffold & fences** | Five module skeletons, ESLint `no-restricted-imports` boundary fences (layering shared ← admin ← hr ← account/joining), vitest coverage gate for `src/modules/**`. Zero logic moves | **S** |
| **M1 HR module** | Kernels (`leave-ledger`, `working-days`, `employment`, `hierarchy`, `lop-derivation`) → `hr/rules`; the seven hr action files → `hr/services`; action files become thin `"use server"` wrappers | **M** |
| **M2 Account module** | `payroll-math` → `account/rules`; `payroll.ts` split into structures/runs/slips services; the offer→structure seam becomes the explicit joining→account API | **M** |
| **M3 Joining module** | **Split the `hiring.ts` monolith** (2,030 LOC) into pipeline / formalities / offers / provisioning / funnel services; `hr-onboarding.ts` + `offer-math` + `hiring-email` move in; `markJoined` orchestrates `admin.provisionUser` + hr + account public APIs | **L** |
| **M4 Admin module** | users/workspace/audit/privacy/export/config actions + libs → `modules/admin`; composite reads (dashboard/analytics/pagination) rewritten as composition-layer imports | **M** |

Hard rules per M-commit: **no behavior change, no schema change, no matrix status change**; all suites green before and after with the new `src/modules/**` coverage threshold held; transport files become wrappers (never re-export barrels — the Turbopack constraint documented in `server-actions/data.ts`), so no view import path ever changes. Sequencing: M0 immediately; M1–M2 before F2.1; M3 before F2.10; M4 before the Phase 3 admin surfaces (F3.9/F3.10).

---

## 8. Data Model Mapping (benchmark → Fernly)

| Frappe HR doctype | Fernly target | State |
| --- | --- | --- |
| Salary Component | `SalaryComponent` (new, F1.5) | Phase 1 |
| Salary Structure / SSA | `SalaryStructure` (extend: variable, timeline view) | Phase 1–2 |
| Salary Slip | `Payslip` (exists; add source-tagged LOP, adjustment provenance) | Phase 1–2 |
| Payroll Entry | `PayrollRun` (exists; add derived LOP, adjustment import) | Phase 1–2 |
| Additional Salary | `PayAdjustment` (new, F2.3) | Phase 2 |
| Income Tax Slab | `DeductionSlab` (new, F3.4, non-statutory) | Phase 3 |
| Leave Ledger Entry | `LeaveLedgerEntry` (new, F1.2) | Phase 1 |
| Leave Allocation | ledger GRANT rows + policy | Phase 1 |
| Leave Encashment | `LeaveEncashmentRequest` (new, F2.2) | Phase 2 |
| Attendance | `AttendanceRecord` (new, F1.3) | Phase 1 |
| Attendance Request | correction flow on AttendanceRecord | Phase 2+ |
| Shift Type / Assignment | `ShiftType`/`ShiftAssignment` (F3.5) | Phase 3 |
| Holiday List / Assignment | `HolidayCalendarEntry` (new, F1.1) | Phase 1 |
| Employee | `User` + `EmployeeProfile` (extend employment fields, F1.6) | Phase 1 |
| Employee Property History | diff rows on `EmploymentChange` (F2.5) | Phase 2 |
| Employee Onboarding / Template | `OnboardingChecklist` (extended F2.1: `kind` ONBOARDING/SEPARATION; templates + gating stay F2.10) | Phase 1–2 |
| Exit Interview | `ExitInterview` (**landed F2.1**: PENDING→SCHEDULED→COMPLETED/CANCELLED, one live per employee) | Phase 2 |
| Full and Final Statement | `FullAndFinalStatement` (**landed F2.1** lite: UNSETTLED→SETTLED, frozen lines/totals) | Phase 2 |
| Job Applicant | `Candidate` (exists) | parity |
| Interview / Interview Type | `CandidateStage` + `InterviewRoundTemplate` (F2.9) | Phase 2 |
| Interview Feedback | scorecard fields on `CandidateStage` (exists) | parity |
| Job Offer | `OfferRecord` (exists; add approval state, F2.9) | Phase 2 |
| Appraisal Cycle / Appraisal | `AppraisalCycle` + `PerformanceReview` (extend, F2.7) | Phase 2 |
| Goal | `Goal` (new, flat, F2.7) | Phase 2 |
| Expense Claim | `ExpenseClaim` (new, F2.8) | Phase 2 |
| Employee Advance | `EmployeeAdvance` (new, F2.8) | Phase 2 |
| Gratuity Rule / Gratuity | `GratuityRule` config (F3.3) | Phase 3 |
| Training Program/Event/Result | `TrainingEvent` family (F3.7) | Phase 3 |
| Employee Grievance | `Grievance` (F3.8) | Phase 3 |
| Staffing Plan / Job Requisition | staffing models (F3.6) | Phase 3 |
| Payroll Settings / HR Settings | workspace config module (exists) | extend |
| Dashboard chart / number card (35 + 37) | analytics views (extend the humane subset — key cards on existing views) | Phase 3 (F3.9) |
| Email notification templates (7) | `MailOutbox` kinds (extend; `INTERVIEW_INVITE` reserved) | Phase 2–3 (F2.10, F3.10) |
| Employee reminder engine (birthday/anniversary/holiday) | cron-route job + MailOutbox (new, F3.10) | Phase 3 |
| Appointment Letter / Template | post-sign printable letter (new, F2.10) | Phase 2 |

---

## 9. Risks and Open Questions

**Risks.**

1. **Ledger migration (F1.2) is the riskiest change** — it rewrites the leave module's storage while leaving behavior identical. Mitigation: backfill migration with invariant assertions + `down.sql`, full e2e suite green before merge, and a feature-freeze on leave during the epic.
2. **Float money.** Fernly stores money as `Float` with `round2` discipline; the benchmark uses decimal precision everywhere. Acceptable at current scale, but every new epic multiplies Float surface — budget a Decimal/int-cents migration as its own epic before Phase 3.
3. **SQLite transaction scope.** Prisma interactive transactions on SQLite serialize writes; savepoint-per-item patterns must stay short-lived. At ≤200 employees this holds; the Postgres CI path is the real gate.
4. **ADR-014 boundary creep.** F3.4 (deduction slabs) and F2.2 (encashment rates) brush against "statutory-looking" math. Every such surface needs the same honest framing as the existing banner — and F3.4 explicitly requires an ADR update.
5. **CI budget.** Each epic adds unit + e2e coverage; the bundle budget and e2e runtime are finite. New views must stay lean and reuse existing test harnesses rather than adding per-feature browser flows.
6. **Scope gravity.** The benchmark is an ERP; this plan is deliberately a fraction of it. Every future "wouldn't it be nice" should be checked against §7.0's declination table first.
7. **Analytics & mobile breadth is the new scope magnet (2026-11-07).** The row-level matrix surfaced ~135 benchmark artifacts the 77-family matrix hid (charts, cards, notifications, print formats, the public jobs board, the 16-job scheduler, the 34-method PWA API, the roster app). The plan owns the humane subset (F2.6 exports, F2.10 joining emails, F3.9 report suite + key cards, F3.10 engagement reminders) and **deliberately declines the rest**: no dashboard/chart framework, no mobile/PWA app, no standalone roster UI — a web-only product at ≤200 employees does not need them. Any widening of that line is a product decision, not an epic-side effect.
8. **Structural migration — the M-track (added 2026-11-07).** Moving ~9,000 LOC of actions and kernels into the four domain modules risks regressions disproportionate to zero user-visible change — the `hiring.ts` (2,030 LOC) split above all. Mitigations: ESLint boundary fences land in M0 *before* any code moves; one module per commit with all suites green before and after; action files become thin wrappers (not re-export shims), so every existing import path stays stable; the `markJoined` transaction boundary stays intact inside `joining/services/provisioning.ts`; the workspace-PM legacy is explicitly parked rather than dragged along. Full risk table: `Fernly_Domain_Modules_Architecture_Plan.md` §10.

**Product decisions — resolved 2026-11-06 (locked; recorded from the planning session).**

1. **Attendance has no member self-marking.** Records are auto-derived (approved leave → `ON_LEAVE`) or entered by HR/managers only; card scanning / check-in pairing is a future phase, explicitly outside Phases 1–3. This confirms F1.3's `attendance:manage` design and declines the benchmark's Attendance-Request / WFH self-service pattern (no `attendance:self` permission will exist).
2. **Payslips are downloadable only — never emailed.** F2.6's email component is descoped; the epic keeps the payslip PDF download, the bank CSV export and the salary register. The User.email vs EmployeeProfile routing question is void.
3. **Probation review is a hard gate.** `PROBATION → ACTIVE` (F1.6) is blocked until the probation review is completed — a guarded transition, not a date + reminder label.
4. **Deduction slabs (F3.4) are rejected for now.** ADR-015 stays deferred; F3.4 remains in the plan as a deliberately-unstarted Parity item and must not be pulled forward silently.
5. **Earned-leave accrual is configurable per leave type.** A knob on `LeaveType` (feeding F2.4) decides whether — and from when — a type accrues; paid/annual and sick leave may differ. No single global rule.
6. **The joining gate is ON by default (added 2026-11-08, F2.10).** `markJoined` refuses while any mandatory document is un-VERIFIED or any background check is non-terminal (FLAGGED counts as a decision HR may proceed on) — mirroring the benchmark's `required_for_employee_creation`. The gate is per-workspace configurable (Settings → General) so the advisory flow remains reachable, but the shipped default is the gated one.
7. **Offer approval is four-eyes (added 2026-11-08, F2.10).** A manager holding `hiring:approve` — a role distinct from the HR composer — must approve every DRAFT offer before it can be sent, and the composer can never approve their own draft. An edit to an approved offer demotes it back to DRAFT: re-approval is always required.

---

## Appendix A — Complete Frappe HR doctype inventory

Generated by `scripts/hrms_inventory.py` — every doctype in `hrms/hr` and `hrms/payroll` at commit `159548fa`. Submittable doctypes are marked \*. "py lines" = controller size.

> **Pin note (2026-11-07):** the current benchmark pin is `88161025`; the list below is materially identical there — the only delta across `159548fa → 1c28527 → 88161025` is that the `Appointment Letter content` child table (hr) was merged into its parent doctype, moving the totals to **157 doctypes (75 standard / 35 child / 4 singles in hr)**. The surfaces this appendix never counted — 35 charts, 37 cards, 7 notifications, 8 print formats, 1 web form, 3 www pages, 16 scheduler jobs, 34 PWA API methods, the roster app — are enumerated and mapped in `Fernly_HRMS_Feature_Parity_Matrix.md` (§§2–9 + Appendix A/B), which is the authoritative inventory going forward.


### Module: hr
- Doctypes: 115 total (75 standard, 36 child tables, 4 singles)
- Reports: 17 | Notifications: 0 | Workflows: 0 | Dashboards: 0 | Charts: 0 | Cards: 0

#### hr standard doctypes (submittable marked *)
- Appointment Letter — 10 fields, 51 py lines
- Appointment Letter Template — 4 fields, 28 py lines
- Appraisal* — 36 fields, 381 py lines
- Appraisal Cycle — 24 fields, 307 py lines | status=Not Started,In Progress,Completed
- Appraisal Template — 6 fields, 33 py lines
- Attendance* — 28 fields, 555 py lines | status=Present,Absent,On Leave,Half Day,Work From Home
- Attendance Request* — 16 fields, 421 py lines
- Compensatory Leave Request* — 14 fields, 181 py lines
- Employee Advance* — 29 fields, 459 py lines | status=Draft,Paid,Partially Paid,Unpaid,Claimed,Returned,Partly Claimed and Returned,Cancelled
- Employee Checkin — 24 fields, 514 py lines
- Employee Feedback Criteria — 1 fields, 20 py lines
- Employee Grade — 3 fields, 22 py lines
- Employee Grievance* — 26 fields, 48 py lines | status=Open,Investigated,Resolved,Invalid,Cancelled
- Employee Health Insurance — 1 fields, 20 py lines
- Employee Onboarding* — 21 fields, 128 py lines
- Employee Onboarding Template — 8 fields, 29 py lines
- Employee Performance Feedback* — 21 fields, 109 py lines
- Employee Promotion* — 14 fields, 64 py lines
- Employee Referral* — 26 fields, 124 py lines | status=Pending,In Process,Accepted,Rejected,Cancelled
- Employee Separation* — 18 fields, 48 py lines
- Employee Separation Template — 8 fields, 29 py lines
- Employee Skill Map — 8 fields, 28 py lines
- Employee Transfer* — 13 fields, 99 py lines
- Employment Type — 1 fields, 20 py lines
- Exit Interview* — 26 fields, 177 py lines | status=Pending,Scheduled,Completed,Cancelled
- Expense Claim* — 59 fields, 1045 py lines | approval_status=Draft,Approved,Rejected,Cancelled; status=Draft,Paid,Partially Paid,Unpaid,Rejected,Submitted,Cancelled
- Expense Claim Type — 4 fields, 48 py lines
- Full and Final Statement* — 24 fields, 455 py lines | status=Paid,Unpaid,Cancelled
- Goal — 23 fields, 287 py lines | status=Pending,In Progress,Completed,Archived,Closed
- Grievance Type — 2 fields, 20 py lines
- HR Telemetry Milestone — 1 fields, 8 py lines
- Holiday List Assignment* — 12 fields, 66 py lines
- Identification Document Type — 1 fields, 20 py lines
- Interest — 1 fields, 20 py lines
- Interview* — 23 fields, 474 py lines | status=Pending,Under Review,Cleared,Rejected,Cancelled
- Interview Feedback* — 13 fields, 106 py lines
- Interview Type — 9 fields, 42 py lines
- Job Applicant — 28 fields, 295 py lines | status=Open,Replied,Shortlisted,Rejected,Hold,Accepted
- Job Applicant Source — 2 fields, 21 py lines
- Job Offer* — 62 fields, 507 py lines | status=Draft,Ready to Send,Awaiting Response,Accepted,Rejected,Cancelled
- Job Offer Term Template — 2 fields, 23 py lines
- Job Opening — 36 fields, 182 py lines | status=Open,Closed
- Job Opening Template — 15 fields, 47 py lines
- Job Requisition — 25 fields, 119 py lines | status=Pending,Open & Approved,Rejected,Filled,On Hold,Cancelled
- KRA — 2 fields, 21 py lines
- Leave Adjustment* — 20 fields, 166 py lines
- Leave Allocation* — 28 fields, 597 py lines
- Leave Application* — 30 fields, 1591 py lines | status=Open,Approved,Rejected,Cancelled
- Leave Block List — 10 fields, 116 py lines
- Leave Encashment* — 31 fields, 384 py lines | status=Draft,Unpaid,Paid,Submitted,Cancelled
- Leave Ledger Entry* — 15 fields, 295 py lines
- Leave Period — 6 fields, 35 py lines
- Leave Policy* — 5 fields, 37 py lines
- Leave Policy Assignment* — 12 fields, 613 py lines
- Leave Type — 33 fields, 111 py lines
- Offer Term — 1 fields, 20 py lines
- Overtime Slip* — 18 fields, 535 py lines
- Overtime Type — 16 fields, 40 py lines
- PWA Notification — 10 fields, 60 py lines
- Purpose of Travel — 1 fields, 20 py lines
- Shift Assignment* — 17 fields, 740 py lines | status=Active,Inactive
- Shift Location — 8 fields, 30 py lines
- Shift Request* — 11 fields, 173 py lines | status=Draft,Approved,Rejected
- Shift Schedule* — 6 fields, 62 py lines
- Shift Schedule Assignment — 12 fields, 162 py lines
- Shift Type — 28 fields, 546 py lines
- Skill — 2 fields, 22 py lines
- Staffing Plan* — 11 fields, 311 py lines
- Training Event* — 26 fields, 69 py lines
- Training Feedback* — 11 fields, 66 py lines
- Training Program — 13 fields, 28 py lines | status=Scheduled,Completed,Cancelled
- Training Result* — 5 fields, 65 py lines
- Travel Request* — 31 fields, 49 py lines
- Vehicle Log* — 21 fields, 136 py lines
- Vehicle Service Item — 1 fields, 20 py lines

#### hr child tables
- Appointment Letter content — 2 fields
- Appraisal Goal — 7 fields
- Appraisal KRA — 5 fields
- Appraisal Template Goal — 2 fields
- Appraisee — 7 fields
- Department Approver — 1 fields
- Designation Skill — 1 fields
- Earned Leave Schedule — 10 fields
- Employee Boarding Activity — 11 fields
- Employee Feedback Rating — 3 fields
- Employee Property History — 4 fields
- Employee Skill — 3 fields
- Employee Training — 2 fields
- Expected Skill Set — 2 fields
- Expense Claim Account — 2 fields
- Expense Claim Advance — 16 fields
- Expense Claim Detail — 16 fields
- Expense Taxes and Charges — 14 fields
- Full and Final Asset — 11 fields
- Full and Final Outstanding Statement — 9 fields
- Interview Detail — 1 fields
- Interviewer — 1 fields
- Job Offer Component — 5 fields
- Job Offer Term — 3 fields
- Leave Block List Allow — 1 fields
- Leave Block List Date — 2 fields
- Leave Policy Detail — 2 fields
- Overtime Details — 7 fields
- Overtime Salary Component — 1 fields
- Skill Assessment — 2 fields
- Staffing Plan Detail — 8 fields
- Training Event Employee — 7 fields
- Training Result Employee — 9 fields
- Travel Itinerary — 15 fields
- Travel Request Costing — 7 fields
- Vehicle Service — 4 fields

#### hr singles
- Employee Attendance Tool — 25 fields
- HR Settings — 52 fields
- Leave Control Panel — 23 fields
- Shift Assignment Tool — 28 fields

#### hr reports
- appraisal_overview (script)
- employee_advance_summary (script)
- employee_analytics (script)
- employee_birthday (script)
- employee_exits (script)
- employee_hours_utilization_based_on_timesheet (script)
- employee_information (query)
- employee_leave_balance (script)
- employee_leave_balance_summary (script)
- employees_working_on_a_holiday (script)
- leave_ledger (script)
- monthly_attendance_sheet (script)
- project_profitability (script)
- recruitment_analytics (script)
- shift_attendance (script)
- unpaid_expense_claim (script)
- vehicle_expenses (script)

### Module: payroll
- Doctypes: 43 total (23 standard, 18 child tables, 2 singles)
- Reports: 8 | Notifications: 0 | Workflows: 0 | Dashboards: 0 | Charts: 0 | Cards: 0

#### payroll standard doctypes (submittable marked *)
- Additional Salary* — 23 fields, 397 py lines
- Arrear* — 16 fields, 481 py lines
- Employee Benefit Application* — 19 fields, 119 py lines
- Employee Benefit Claim* — 16 fields, 251 py lines
- Employee Benefit Ledger — 17 fields, 152 py lines
- Employee Incentive* — 13 fields, 57 py lines
- Employee Other Income* — 11 fields, 27 py lines
- Employee Tax Exemption Category — 3 fields, 22 py lines
- Employee Tax Exemption Declaration* — 14 fields, 102 py lines
- Employee Tax Exemption Proof Submission* — 18 fields, 80 py lines
- Employee Tax Exemption Sub Category — 4 fields, 35 py lines
- Gratuity* — 23 fields, 348 py lines | status=Draft,Unpaid,Paid,Submitted,Cancelled
- Gratuity Rule — 12 fields, 66 py lines
- Income Tax Slab* — 16 fields, 136 py lines
- Payroll Correction* — 21 fields, 274 py lines
- Payroll Entry* — 45 fields, 2003 py lines | status=Draft,Submitted,Cancelled,Queued,Failed
- Payroll Period — 6 fields, 153 py lines
- Retention Bonus* — 14 fields, 89 py lines
- Salary Component — 36 fields, 201 py lines
- Salary Slip* — 99 fields, 2859 py lines | status=Draft,Submitted,Cancelled,Withheld
- Salary Structure* — 31 fields, 523 py lines
- Salary Structure Assignment* — 31 fields, 554 py lines
- Salary Withholding* — 21 fields, 228 py lines | status=Draft,Withheld,Released,Cancelled

#### payroll child tables
- Employee Benefit Application Detail — 3 fields
- Employee Benefit Detail — 3 fields
- Employee Cost Center — 2 fields
- Employee Tax Exemption Declaration Category — 4 fields
- Employee Tax Exemption Proof Submission Detail — 6 fields
- Gratuity Applicable Component — 1 fields
- Gratuity Rule Slab — 3 fields
- Income Tax Slab Other Charges — 7 fields
- Payroll Correction Child — 2 fields
- Payroll Employee Detail — 6 fields
- Payroll Period Date — 2 fields
- Salary Component Account — 3 fields
- Salary Detail — 30 fields
- Salary Slip Leave — 6 fields
- Salary Slip Loan — 9 fields
- Salary Slip Timesheet — 2 fields
- Salary Withholding Cycle — 4 fields
- Taxable Salary Slab — 6 fields

#### payroll singles
- Bulk Salary Structure Assignment — 19 fields
- Payroll Settings — 26 fields

#### payroll reports
- accrued_earnings_report (script)
- bank_remittance (script)
- employee_ctc_break_up (script)
- income_tax_computation (script)
- income_tax_deductions (script)
- salary_payments_based_on_payment_mode (script)
- salary_payments_via_ecs (script)
- salary_register (script)
---

## Appendix B — Sources and Reproduction

- Benchmark clone: `frappe/hrms` — `159548fa` (2026-11-03, original) → `1c28527` (2026-11-06, reassessment) → **`88161025` (2026-11-07 refresh, current pin)**; partial clone (`--filter=blob:none --depth 300`) under `.analysis/hrms` (excluded from the repo via `.git/info/exclude`). Delta `1c28527 → 88161025`: 5 commits / 4 files, appointment-letter UI polish only — logged row-by-row in `Fernly_HRMS_Feature_Parity_Matrix.md` Appendix B.
- Split verification: GitHub contents API for `frappe/erpnext` `main` (2026-11-06) — no `hr/`/`payroll/` modules in the core package.
- Structural inventory: `scripts/hrms_inventory.py` → `.analysis/hrms_inventory.json` + Appendix A. Reproduce with `python3 scripts/hrms_inventory.py` after cloning hrms to `.analysis/hrms`. (Known gap, closed by manual enumeration this pass: the script's `collect_json_dir` glob misses nested notification / print-format / web-form dirs — see matrix Appendix A.)
- Fernly state: repo at `b932258` at original writing; **`bb2e046` at the 2026-11-07 refresh** (Phase 1 complete), all paths cited inline and re-verified.
- Functional depth: core hrms controllers read in full (salary_slip, payroll_entry, salary_structure_assignment, salary_component, leave_application, leave_allocation, leave_ledger_entry, attendance, employee_checkin, shift_type, expense_claim, employee_onboarding, full_and_final_statement, job_offer, interview, appraisal, gratuity, and others); state machines and validation chains above are extracted from those files with approximate line references.
- Row-level mapping: `docs/Fernly_HRMS_Feature_Parity_Matrix.md` — 314 rows covering every doctype + report + chart + card + notification + print format + web form + www page + scheduler job + PWA API method + cross-cutting behavior, verified at `bb2e046`.
- Related internal docs: `docs/PRD.md`, `docs/HR_MODULE_PLAN.md`, `docs/RECRUITMENT_MODULE_PLAN.md`, `docs/Fernly_Persona_Acceptance_Assessment.md`, `docs/DECISIONS.md` (ADR-008, ADR-009, ADR-014).
