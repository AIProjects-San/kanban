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
| PR-03 | `Salary Structure` (submittable, 31 fields) | `payroll_frequency` (5), timesheet mode + hourly rate, `max_benefits`, is_active/is_default, company, income-tax-slab linkage | `SalaryStructure` — components JSON, one ACTIVE per employee, revision history (retire-on-revision, atomic since F1.5/F-R1), `max_benefits` (P5) and `payroll_frequency` (P10: MONTHLY/BIMONTHLY/WEEKLY/FORTNIGHTLY/DAILY/QUARTERLY/ANNUAL — the five benchmark cadences plus two house extras, frequency-matched into runs); timesheet mode + hourly rate stay out (timesheet payroll, §7.0), no company scoping (single workspace) or tax-slab linkage (ADR-014) | Partial | P4/P5 / F2.x extend |
| PR-04 | `Salary Structure Assignment` (submittable, 31 fields) | temporal employee+structure+from_date+base+variable; duplicate guard; cost-center split Σ=100; opening balances; bulk-assign tool | `SalaryStructure.effectiveFrom` + revision chain (retire-on-revision, atomic since F1.5/F-R1) + the P14 bulk-assign tool (1–200 employees, per-employee transactions) + the P16 opening balances (`openingYtd` component rows seeding the fiscal year of the structure's effectiveFrom in the read-time aggregates — gross/net derive from the rows, both payslip surfaces agree) + the P16 duplicate-effectiveFrom guard (one structure per employee per effective date, friendly error). Base/variable split and cost centers stay unbuilt: every line is a full component row (the split is the benchmark's internal modeling — workspace-scope equivalence), and cost centers are multi-company machinery | **Parity (workspace scope)** (was Partial) | P4 / **P16 DONE (2026-11-10)** |
| PR-05 | `Salary Slip` (submittable, 99 fields, 2,859 py lines) | Draft/Submitted/Cancelled/**Withheld**; 8-step pipeline; payment-days engine; YTD/MTD/per-component YTD; leave balances on slip; email on submit | `Payslip` — OPEN/LOCKED one-way, immutable lines, `lopDays`+`lopSource AUTO\|MANUAL` (F1.4) with the P17 basis switch behind the derivation and the P15 frozen `lopDetail` breakdown, YTD/MTD/per-component aggregates through the one kernel (P11; fiscal-year basis P16), WITHHELD/RELEASED stamp + release bookkeeping (P8), optional live leave-balances box (P17, PR-B25), print modal; no email on submit (P20's opt-in) | Partial | P20 (email) — P8/P10/P11/P15/P16/P17 landed |
| PR-06 | `Salary Slip Leave` (child) | leave-driven payment-day deductions per slip (LWP + PPL fractions) | P15: the derivation consumes leave at its salary fraction — unpaid charges the working day in full, partially-paid types charge (1 − fraction) × the working fraction (`LeaveType.salaryFraction`, leave-wins rule unchanged) — and `Payslip.lopDetail` freezes the per-slip breakdown at creation (per-type rows {code, name, takenDays, chargedDays, fraction} + the attendance-side absent/half/unmarked buckets; rendered in the payslip modal's "Loss-of-pay breakdown" box; a MANUAL LOP override clears it, the note says "manually set by HR"); the LV-B10 salary-processed guard blocks partially-paid types in LOCKED windows like unpaid | **Parity (workspace scope)** (was Partial) | P7 / F1.4 / **P15 DONE (2026-11-09)** |
| PR-07 | `Salary Slip Loan` (child) | loan repayment rows merged into net pay | — (no lending integration) | Out of scope | P17 |
| PR-08 | `Salary Slip Timesheet` (child) | timesheet-based payroll rows | — (timesheet payroll declined, §7.0) | Out of scope | — |
| PR-09 | `Payroll Entry` (submittable, 45 fields, 2,003 py lines) | Draft/Submitted/Cancelled/Queued/Failed; employee filtering (SSA × frequency × DOJ window); >30 employees → queued with per-slip savepoints; accounting JEs; cancellation cascade | `PayrollRun` — period key unique (any P10 cadence), frequency-matched structure snapshots, one-way lock, mid-period `addPayslip`, LOP auto-derivation at creation, P13 chunked >30 with per-slip isolation + loud failure summary; employee filtering lands with P14 (run employee filter); the Queued state + background job are the declined queue infra (synchronous chunks), JE posting + cancellation cascade stay out (no accounting module; locks are one-way by design) | Partial | P8 / F2.3 extends |
| PR-10 | `Payroll Employee Detail` (child) | per-employee rows of the batch run | implicit — run creation snapshots eligible structures | Partial | — |
| PR-11 | `Payroll Period` + `Payroll Period Date` (child) | named multi-month periods with component-level start/end dates | P16: `Workspace.fiscalYearStartMonth` (1–12, default 1 = calendar year = zero behavior change) is the fiscal-year YTD basis — the pure `fiscalYearOf`/`fiscalYearBounds`/`fiscalYearLabel` helpers (lib/payroll-windows.ts) + the aggregates kernel reset YTD at the fiscal boundary on BOTH payslip surfaces (MTD stays the calendar month; the modal shows the "YTD · 2026/27" chip + basis note); the component-level start/end dates live as catalog validity windows (`SalaryComponent.effectiveFrom/effectiveTo` — the picker badges them, saveSalaryStructure refuses lines outside the window at the structure's effective date, structures keep their snapshots); named periods ARE the fiscal years (the label renders them) | **Parity (workspace scope)** (was Partial) | P4 / **P16 DONE (2026-11-10)** |
| PR-12 | `Additional Salary` (submittable, 23 fields) | universal one-off adapter — recurring or one-shot, overwrite mode, `ref_doctype/ref_docname` provenance; every special flow funnels here | P1/F2.3: `PayAdjustment` — ONE_SHOT/RECURRING (endPeriod + lastConsumedPeriod watermark)/OVERWRITE, provenance sourceType/sourceId, PENDING→CONSUMED/SKIPPED with visible reasons; consumed inside the run/slip creation transaction; FIXED/PERCENT_OF_GROSS/PERCENT_OF_NET calc modes on the pure two-pass kernel (`lib/pay-adjustment.ts` — gross-based first, percent-of-net sequentially); manual writer + row list + the explicit apply-to-OPEN-run action (`payroll.adjustment_created`/`adjustments_applied` audits) | **Parity (workspace scope)** (was Partial) | P11 / **P1 DONE (2026-11-09)** |
| PR-13 | `Arrear` (submittable, 481 py lines) | re-simulates every past slip under a new structure; emits positive diffs | P3/F3.1: the pure `simulateArrearsRun` kernel (lib/arrears.ts) replays the run-creation pipeline over each LOCKED slip's stored snapshots (paidDays S5, lopDays F1.4, the run's F1.1 denominator) under the CURRENT active structures; positive deltas only (overpayment recovery is a deliberate separate correction); preview (nothing written) then `generateArrears` emits ARREARS PayAdjustment rows onto a chosen payout period in one transaction, idempotent per slip (sourceId = payslipId, a slip cannot be paid arrears twice); the Payroll view's per-LOCKED-run Arrears button drives it. Remaining: per-component diff detail, submittable-doc states | Partial | P12 / **P3 DONE (2026-11-09)** |
| PR-14 | `Payroll Correction` (+child) | reverses N LWP days of a past submitted slip | P4/F3.1: `reverseLwpDays` (payroll:manage) refunds docked days on a PAID slip at its own stored per-day price (the stored LOP line ÷ lopDays — manual edits ride along), as an LWP_CREDIT PayAdjustment (sourceDays = the days, the reversal cap Σ reversed ≤ stored lopDays enforced from data, never note-parsing; SKIPPED credits don't consume it); preview action + the per-slip Reverse LWP button on LOCKED runs; OPEN slips are edited directly instead (the state's whole point). Remaining: the submittable-doc shape | Partial | P12 / **P4 DONE (2026-11-09)** |
| PR-15 | `Employee Benefit Application` (+detail child) | yearly flexi-benefit election, capped by structure `max_benefits` | P5/F3.2: `BenefitElection` — yearly, per employee × component (upsert = re-elect replaces), the pure `planBenefitElection` cap rule against `SalaryStructure.maxBenefits` (0 = no cap); the Benefits panel elects/cancels. Remaining: member self-service application, split frequencies | Partial | P14 / **P5 DONE (2026-11-09)** |
| PR-16 | `Employee Benefit Detail` (child of SSA) | per-SSA fallback benefit components | — | Missing | P14 / F3.2 |
| PR-17 | `Employee Benefit Claim` (submittable) | claims against accrued balance | P5/F3.2: `claimBenefit` — HR-filed single-step (audited; F2.8 generalizes the member-claim flow), the pure `planBenefitClaim` balance rule (claims cannot outrun locked accruals), pays through the adapter (BENEFIT_PAYOUT) with a −CLAIM ledger row in one transaction | **Parity (workspace scope)** (was Missing) | P14 / **P5 DONE** |
| PR-18 | `Employee Benefit Ledger` | append-only Accrual/Payout rows; claimable = accrued − paid | P5/F3.2: `BenefitAccrual` — +ACCRUAL rows written at every run LOCK (election ÷ 12, paid-days-scaled — S5's window discipline), −CLAIM rows at claim approval; balance = Σ deltas (the leave ledger's discipline, borrowed as planned) | **Parity (workspace scope)** (was Missing) | P14 / **P5 DONE** |
| PR-19 | `Salary Withholding` (+cycle child) | Draft → Withheld → Released, driven by JE doc_events | P8: `SalaryWithholding` — the ACTIVE hold window (fromPeriod→untilPeriod|null) with the terminal RELEASED state + release bookkeeping; payslips born inside the window are stamped WITHHELD (computed + frozen, net NOT disbursed); `releaseSalaryWithholding` flips slips RELEASED + emits per-slip WITHHELD_RELEASE adapter rows (the frozen stored nets) into the chosen payout period in one transaction. The JE doc-event driver is accounting-module machinery (out per ADR-014 — the release is explicit, not ledger-driven) | **Parity (workspace scope)** (was Missing) | **P8 DONE (2026-11-09)** |
| PR-20 | `Gratuity` (submittable) | rule-driven payout doc, Draft/Unpaid/Paid | P7: the GRATUITY line on the live full-and-final statement (rule-priced, disclaimer always rendered) riding the FnF NONE→UNSETTLED→SETTLED lifecycle — generate = the payout doc, settle = Paid, frozen amounts at settle | **Parity (workspace scope)** (was Missing) | **P7 DONE (2026-11-09)** |
| PR-21 | `Gratuity Rule` (+slab +applicable-component children) | slab table (years → fraction), 3 experience methods, applicable earnings | P7: `GratuityRule` (enabled, 1–12-month averaging window) + `GratuitySlab` (fromYears/toYears/fraction) as HR-editable data + the Gratuity rule modal; the pure kernel (`lib/gratuity.ts`) walks completed years through the slabs × final average earnings (last-N LOCKED payslip grosses, structure fallback). The benchmark's 3 statutory experience regimes collapse into the one generalized slab table — statutory regimes stay out per ADR-014 and the non-statutory disclaimer says so | **Parity (workspace scope)** (was Missing) | **P7 DONE (2026-11-09)** |
| PR-22 | `Employee Incentive` (submittable) | one-off incentive → Additional Salary | P1/P6: the PayAdjustment manual writer's INCENTIVE source IS the one-off incentive (label/amount/period, audited `payroll.adjustment_created`) | **Parity (workspace scope)** (was Missing) | **P6 DONE (2026-11-09)** |
| PR-23 | `Retention Bonus` (submittable) | retention payout with notification | P6: `createRetentionBonus` — the pure `planRetentionBonus` split (equal installments, the last absorbs rounding so Σ == total; 1–12 monthly ONE_SHOT rows through the adapter), the in-app notification + the RETENTION_BONUS outbox email (queued in the transaction, delivered outside — the INTERVIEW_INVITE pattern); the Retention bonus button + preview modal in the Payroll view. Remaining: the submittable-doc states | Partial | **P6 DONE (2026-11-09)** |
| PR-24 | `Employee Other Income` (submittable) | other-income declaration for tax projection | — (pre-statutory, ADR-014) | Out of scope | P15 |
| PR-25 | `Income Tax Slab` (+`Taxable Salary Slab`, `Income Tax Slab Other Charges` children) | slab engine with conditions, exemption regime switch, other taxes | — (ADR-014) | Out of scope | P15 |
| PR-26–29 | `Employee Tax Exemption Category` / `Sub Category` / `Declaration` / `Proof Submission` (+2 children) | declaration-vs-proof exemption workflow | — (ADR-014) | Out of scope | P15 |
| PR-30 | `Salary Component Account` (child) | per-company GL account mapping | — (no accounting module) | Out of scope | P18 |
| PR-31 | `Employee Cost Center` (child) | payroll cost-center split | — | Out of scope | P18 |
| PR-32 | `Payroll Settings` (single, 26 fields) | `payroll_based_on`, include-holidays flags, unmarked-as-absent, half-day wage fraction, rounding toggle, email/encrypt payslips, per-employee accounting, overtime slip | workspace config module (`lib/config.ts` + settings-view) + ADR-014 statutory banner (test-pinned); most switches moot in Fernly's single-model design | Partial | — |
| PR-33 | `Bulk Salary Structure Assignment` (single, 19 fields) | P14: `bulkAssignStructure` — one component set to 1–200 employees at once, each active structure replaced in its own transaction (retire + create, F-R1) with per-employee isolation + loud failure summary + honest replaced/createdFresh counts; the BulkStructureModal copies an existing active structure (the source), with cadence + effective date + notes + select-all employees | **Parity (workspace scope)** (was Missing) | **P14 DONE (2026-11-09)** |

### 2.2 Payroll behaviors (states, validations, derivations)

| ID | Benchmark behavior | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| PR-B01 | AST-sandboxed `formula`/`condition` per component | FIXED / PERCENT_OF_BASIC only — **declined** (§7.0 declination table) | Out of scope | P3 |
| PR-B02 | `depends_on_payment_days` per component | S6: `SalaryComponent.dependsOnPaymentDays` (catalog CRUD + checkbox, default true) snapshots sparsely onto structure/payslip lines (only false is stored); window-exempt lines stay flat under the S5 scaling AND stay out of the LOP basis (`lopBasisGross`) in createPayrollRun/addPayslip/updatePayslip + the modal's live preview; structure editor exposes the per-line toggle | **Parity (workspace scope)** (was Partial) | P6 / **S6 DONE** |
| PR-B03 | Statistical components (display-only totals) | S8: kind STATISTICAL on catalog/structure/offer surfaces (KIND_LABEL "Statistical (info)"); rides payslips as sparse `statistical: true` lines rendered in a "For information (not counted in pay)" block; excluded from computeOffer totals, lineSum, lopBasisGross, window scaling and the rounding line; preserved verbatim by updatePayslip (never editable) | **Parity (workspace scope)** (was Missing) | **S8 DONE** |
| PR-B04 | Flexible-benefit election & pro-rata | P5/F3.2: elections capped + replaced on re-elect; accruals pro-rated to the slip's paid days (the `accrualAmount` kernel) | **Parity (workspace scope)** (was Missing) | P14 / **P5 DONE** |
| PR-B05 | Five payroll frequencies | P10: all of them via the pure `lib/payroll-windows.ts` kernel — MONTHLY ("2026-11", unchanged), BIMONTHLY (calendar halves 1–15/16–end, the benchmark's exact Bimonthly), WEEKLY (ISO week Mon–Sun), FORTNIGHTLY (ISO week pairs; 53-week years end with a one-week F27 — the benchmark's fortnight is start→start+13 anchored anywhere, ISO pairs are the deterministic house calendar), DAILY, plus QUARTERLY/ANNUAL house extras; `PayrollRun.frequency` + `startDate`/`endDate` carry the real window (period keys stay unique, seven distinct formats); `SalaryStructure.frequency` is the frequency-matched run filter; per-window amounts = annual ÷ windowsInYear (the 52-vs-53 ISO-year drift mirrors the benchmark's own weekly behavior); every period-string comparison became a window-date comparison (adjustment due-ness by Additional-Salary date-overlap, hold windows, YTD attribution + ordering, gratuity last-N, the leave salary-processed guard) | **Parity (workspace scope)** (was Partial) | P5 / **P10 DONE (2026-11-09)** |
| PR-B06 | Payment-days engine: DOJ/relieving clipping, include-holiday settings, half-day fractions | S5: `Payslip.paidDays` — the pure `paymentWindow` rule clips each period to [max(start, hireDate), min(end, LWD)] (holiday-aware, halves count) and earnings scale by paidDays/workingDays at run/slip creation (`scaleEarningsToPaidDays`); addPayslip joiners scale automatically; updatePayslip caps LOP at paid days; pre-S5 rows read as full-period (null). F1.1 denominator + F1.4 fractions underneath | **Parity (workspace scope)** (was Partial) | P6 / **S5 DONE** |
| PR-B07 | `consider_unmarked_attendance_as` (absent/present) | S4: `Workspace.unmarkedAttendanceMode IGNORED\|ABSENT` (Settings → General, default IGNORED = zero behavior change) feeds the pure `deriveLopDays` opts — ABSENT charges unmarked working days inside each employee's [hireDate, lastWorkingDay] window (any record, incl. PRESENT/WFH/ON_LEAVE, counts as marked; paid leave shields); derivation now reads ALL attendance statuses; payslip modal's AUTO note states the policy | **Parity (workspace scope)** (was Missing) | P6 / **S4 DONE** |
| PR-B08 | Duplicate-slip idempotency (employee+period, payroll-entry-aware) | `@@unique([runId, userId])` + period-unique run + pre-checks | **Parity** | P9 |
| PR-B09 | YTD + MTD + per-component YTD on the slip | P11: ONE pure kernel (`lib/payslip-aggregates.ts` computeRunningAggregates) serves both surfaces — YTD **net + gross** per calendar year (window-end attribution, P10), **MTD net** (the calendar month of the window end — several runs can land in one month, e.g. weekly cadences), and **per-component YTD** rows merged by side+line key across slips (statistical lines are not money); the payslip modal's totals box shows YTD gross/net + month-to-date and every line row carries its component YTD chip; self-service's latest strip shows the MTD; WITHHELD/RELEASED money carries the last paid values forward, never accumulates; read-time by design (OPEN edits reflect on the next read, LOCKED history never rewritten); the two bases (HR includes OPEN runs vs ESS locked-only) stay an F-R3-documented divergence | **Parity (workspace scope)** (was Partial) | P10 / **P11 DONE (2026-11-09)** |
| PR-B10 | One-off adjustments (recurring/one-shot, overwrite semantics) | P1/F2.3: all three recurrences on `PayAdjustment` rows — one-shot consumed once, recurring re-emitted every period through endPeriod (watermarked, flips CONSUMED at the final period), overwrite replaces the same-key line for one period (skip-with-reason when no line matches) | **Parity (workspace scope)** (was Partial) | P11 / **P1 DONE** |
| PR-B11 | Arrears reverse-simulation | P3/F3.1: `simulateArrearsForSlip` — monthly earnings from the current structure ÷ scaled to the stored paidDays, the auto LOP line rebuilt from the stored lopDays + the run's denominator, the current rounding policy applied; baseline = the STORED net (manual edits ride along) | **Parity (workspace scope)** (was Missing) | P12 / **P3 DONE** |
| PR-B12 | LWP correction reversal of past slips | P4/F3.1: the pure `planLwpCorrection` kernel (lib/lwp-correction.ts) — quarter-day steps, the reversal cap with prior-credit awareness, per-day pricing from the stored LOP line | **Parity (workspace scope)** (was Missing) | P12 / **P4 DONE** |
| PR-B13 | Salary withholding flow (hold cycles, release) | — | P8: the full lite state machine — hold creation (overlap-refused, LOCKED-fromPeriod-refused: holds only affect unborn slips), WITHHELD stamping at run/slip creation, YTD + self-service exclusion of held/released nets, the Withholding modal (live hold balance per row, release preview), HELD/RELEASED badges on both payslip surfaces, and the settled-FnF double-pay guard | **Parity (workspace scope)** (was Missing) | **P8 DONE (2026-11-09)** |
| PR-B14 | >30-employee queued processing with per-slip savepoints | P13: chunked lite — the first 30 slips ride the run-creation transaction (byte-identical for ≤30-employee workspaces); every slip beyond the 30th writes in its OWN transaction (slip + its adjustment consumption, the S17 discipline per slip) with per-slip error isolation — one bad record never aborts the payroll; failures carry humanized reasons and surface in the result, the audit detail and a long-lived toast; counts stay honest (failures excluded); a failed slip's adjustments stay PENDING so the addPayslip joiner path recovers it after the fix. The benchmark's Queued state + background job are the queue infra the locked decision declines (synchronous chunks at the documented ≤200-employee scale) | **Parity (workspace scope)** (was Partial) | **P13 DONE (2026-11-09)** |
| PR-B15 | Accounting posting: accrual JE, bank JE, employer JE, cost centers | — (no accounting module) | Out of scope | P18 |
| PR-B16 | Payslip email on submit (bulk-queued, optional password-protected PDF) | P18: `Workspace.emailPayslipsOnLock` (default OFF, Settings → General) — when on, locking a run queues one PAYSLIP outbox row per payslip INSIDE the lock transaction (no email without its lock) and delivers best-effort after it (one row at a time; failures resolve FAILED and surface in the audited Outbox, never in the lock's result). The email is an HTML summary — greeting, gross/deductions/net, LOP note, withheld note, the My-payslips PDF pointer — with amounts kept OUT of the subject (subjects leak through previews); the body is the plain-text audit copy. The password-protected PDF attachment stays declined (§9.2 download-only decision — the mailer has no attachment support); the bulk shape is the run's own slips, delivered sequentially | **Parity (workspace scope)** (was Partial) | **P18 DONE (2026-11-10)** |
| PR-B17 | Loan repayment merge into net | — | Out of scope | P17 |
| PR-B18 | Regional statutory hook (`allow_regional`) | — (ADR-014; no statutory surface) | Out of scope | P15 |
| PR-B19 | Employer contributions display-only (never in net) | `kind EMPLOYER_CONTRIBUTION` supported and excluded from take-home (`offer-math.ts`/`payroll-math.ts`) | **Parity** | P2 |
| PR-B20 | Compensation engine: prospective SSA, derive CTC or solve base for target CTC, ctc_breakup | P12: derive (computeOffer's resolved-per-component breakup + CTC totals, live in both editors) AND the inverse — the pure `lib/ctc-solver.ts` `solveBaseForCtc` (CTC(B) = fixed + B×rate; the solved basic rounds to a granularity with the residue REPORTED, deductions/statistics never bend the solution, refusals visible: no basic / target below fixed cost); the shared `CtcSolverField` control rides both the structure editor and the offer builder; prospective SSA comparison (future-dated assignments side by side) remains unbuilt | Partial | R10 / **P12 DONE (2026-11-09)** |
| PR-B21 | SSA opening balances (taxable/tax deducted till date) | — | Missing | P4 |
| PR-B22 | Cost-center split Σ=100% validation | — | Out of scope | P18 |
| PR-B23 | Configurable rounding policy (`disable_rounded_total`) | S7: `Workspace.payrollRoundingMode ROUND_2DP\|ROUND_NET_NEAREST` (Settings → General, default ROUND_2DP = zero behavior change). ROUND_NET_NEAREST appends an auto "Rounding" line (earning when it pays up, deduction when it docks down) so NET lands on a whole dollar while still equaling Σ lines exactly — in createPayrollRun/addPayslip/updatePayslip + the modal's live preview (auto-managed like the LOP line, replaced never duplicated) | **Parity (workspace scope)** (was Partial) | **S7 DONE** |
| PR-B24 | `email_salary_slip_to_employee` + `encrypt_salary_slips_in_emails` + password policy | — (download-only decision §9.2) | Out of scope | P20 |
| PR-B25 | `show_leave_balances_in_salary_slip` | P17: `Workspace.showLeaveBalancesOnSlip` (default OFF, Settings → General) — when on, BOTH payslip surfaces (the run console's slips + self-service my-payslips) carry each employee's live leave balances read at open time: one row per type (the latest-year balance row per user×type, names joined in memory — LeaveBalance carries no LeaveType relation, a deleted type reads "(deleted type)"), rendered in the payslip modal's "Leave balances (live)" box with the read-time note; nothing is snapshotted onto the slip, so toggling shows/hides instantly | **Parity (workspace scope)** (was Missing) | **P17 DONE (2026-11-10)** |
| PR-B26 | Overtime slip creation setting | — | P9: `Workspace.overtimePayEnabled` (default OFF, Settings → General) — when on, run creation/addPayslip sum each employee's DERIVED overtimeMinutes over the period (the S2 fact) and emit one "Overtime" earning line priced gross ÷ working days ÷ 8h (`lib/overtime-bridge.ts`); the attendance grid shows "OT 2h" on the record. Shift-based multipliers stay with shifts (F3.5) | **Parity (workspace scope)** (was Missing) | **P9 DONE (2026-11-09)** |
| PR-B27 | Leave-vs-Attendance proration mode switch | P17: `Workspace.lopBasisMode` (Settings → General, consumed at run/slip creation) — HYBRID (default = the F1.4 leave-wins walk byte-for-byte: a covering span charges its salary-fraction complement, otherwise the attendance mark decides), LEAVE (spans only — attendance marks never charge and unmarked-as-absent is suspended), ATTENDANCE (marks only — leave never charges; spans still record taken days at charged 0 in the frozen breakdown, and unmarked-as-absent applies); unknown values clamp to HYBRID at both the loader and the kernel; the payslip modal's AUTO note names the basis | **Parity (workspace scope)** (was Partial) | P7 / F1.4 / **P17 DONE (2026-11-10)** |

### 2.3 Payroll reports, charts, cards, print formats, notifications

| ID | Benchmark surface | Fernly @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- |
| PR-R01 | `salary_register` report | P20: the per-LOCKED-run salary register CSV (`exportPayrollRunCsv` kind REGISTER — payroll:manage, audited `payroll.run_exported`) — one row per paid slip (slip no, employee no, name, job title, gross, deductions, net, LOP days, withhold state) + an honest TOTAL row; the leading comment lines carry the non-statutory disclaimer; RFC 4180 escaping (commas/quotes/newlines/padded spaces quoted, inner quotes doubled); the pure builder is lib/payroll-csv.ts (golden-file tested); the Payroll view's Register CSV button downloads it (the analytics Blob pattern) | **Parity (workspace scope)** (was Missing) | **P20 DONE (2026-11-10)** |
| PR-R02 | `bank_remittance` report | P20: the per-LOCKED-run bank remittance CSV (`exportPayrollRunCsv` kind BANK_REMITTANCE) — one payment row per DISBURSED net (employee no, name, blank bank-account column, amount, NZD, period, slip-no payment reference): WITHHELD nets never reach the bank file, the TOTAL row counts only the disbursed money; the account column stays blank by design — Fernly stores no bank details, the employer's bank maps accounts from its records (the lite shape the plan named); same disclaimer/escaping/audit/Button surface as the register | **Parity (workspace scope)** (was Missing) | **P20 DONE (2026-11-10)** |
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
| PR-P01–03 | Print formats: salary_slip_classic / compact / detailed | P19: the LOCKED payslip's print surface grows the three variants — a Classic/Compact/Detailed picker beside the Print button (choice persists in localStorage, garbage values clamp to Classic). CLASSIC (default) = the standard paper slip: lines + core Gross/Deductions/Net row + the LOP honesty note + the note field; COMPACT = the essentials only (lines + core totals, type tightened a notch — LOP note, note field, aggregates, breakdowns, balances, statistical rows, per-line YTD chips all off the paper); DETAILED = everything the modal shows + a print-only meta footer (slip no · period · working/paid days · withhold state · printed date). Screen output is byte-identical in all three modes — the variants are @media-print visibility keyed off the form's data-print-format (globals.css), no second render tree | **Parity (workspace scope)** (was Partial) | **P19 DONE (2026-11-10)** |
| PR-T01 | Notification `Retention Bonus` | — | P6: the RETENTION_BONUS outbox kind + the in-app notification on bonus creation (both surfaces, best-effort email) | **Parity (workspace scope)** (was Missing) | **P6 DONE** |

---

## 3. HR — Leave & Holidays (domain `LV`)

### 3.1 Doctype artifacts

| ID | Benchmark artifact | Key features (from controller) | Fernly surface @ `bb2e046` | Status | Family / epic |
| --- | --- | --- | --- | --- | --- |
| LV-01 | `Leave Type` (33 fields) | LWP / partially-paid (salary fraction) / earned (frequency, allocate-on, rounding) / compensatory / carry-forward (cap + expiry days) / include-holiday / allow-negative / over-allocation / applicable-after / max-continuous / encashment knobs / optional-leave | `LeaveType` + `LeavePolicy` with the F2.4 strategy block (allocationStrategy MANUAL/ANNUAL_LUMP_SUM/EARNED/AFTER_SERVICE, accrual frequency/on-day/rounding/cap, grantOn + pro-rata, minServiceMonths, accrueDuringProbation, allowNegative + negativeFloor, carryExpiresAfterMonths, countHolidaysInLeave — `lib/leave-policy.ts`, `hr:admin` editor); encashment knobs landed with P2 (F2.2) and the partially-paid salary fraction with P15 (`salaryFraction`, the "50% pay" badge, the fraction knob in the type editor); still missing: compensatory leave, optional-leave | Partial | L1 / **F2.4 + P15** |
| LV-02 | `Leave Policy` + `Leave Policy Detail` (child) | multi-type allocation template | `LeavePolicy` 1:1 per type (policy = type + numbers) | Partial | L2 |
| LV-03 | `Leave Policy Assignment` (submittable, 613 py lines) | assignment per employee × leave period; overlap-forbidden; bulk with per-employee savepoints; DOJ pro-rata; pre-computes earned-leave schedule | year-based entitlement per user — GRANT rows via policy/migration (F1.2 backfill); no assignment docs, no bulk tool, no pro-rata | Partial | L2 |
| LV-04 | `Leave Allocation` (submittable, 597 py lines) | validates overlap, CF caps, backdating; writes two ledger entries (new + CF parts with own expiry dates) | F2.4: strategy GRANT rows with deterministic period-key sourceIds (lazy + cron writers), year-end CARRY/EXPIRE pair capped by maxCarryOver, mid-year carry lapse; no submittable allocation documents, no per-row expiry dates (lapse is per-type), no backdating validation | Partial (improved) | L4 / **F2.4** |
| LV-05 | `Leave Application` (submittable, 1,591 py lines) | 10-step validation chain; split-at-CF-boundary consumption; attendance marking; approver chain | `LeaveRequest` PENDING → APPROVED/REJECTED → CANCELLED; 7-step chain (notice-working-days F1.2, holiday-aware counting F1.1, consecutive, overlap, balance); manager-or-admin decide; decideById/note | Partial | L5 |
| LV-06 | `Leave Ledger Entry` (submittable, 295 py lines) | append-only signed rows; is_carry_forward / is_expired; daily expiry job writes negatives | `LeaveLedgerEntry` (F1.2: GRANT/CARRY/CONSUME/EXPIRE/ADJUST + `isReversal`, polymorphic source; `LeaveBalance` a transactionally-synced derived cache; cancel writes reversal siblings; QA-1 guard = Σ deltas) | **Parity (workspace scope)** | L3 / F1.2 DONE |
| LV-07 | `Leave Block List` (+`Date`, `Allow` children) | blocked dates + department scoping + allow-list | — | Missing | L8 |
| LV-08 | `Leave Period` | named allocation windows | calendar year (implicit) | Partial | L4 |
| LV-09 | `Leave Encashment` (submittable, 384 py lines) | encashable-days math, auto-drafts daily, Draft/Unpaid/Paid, pays via Additional Salary | P2/F2.2: `LeaveEncashment` rides the P1 adapter end to end — policy knobs (encashable, maxEncashableDays, nonEncashableDays — default off), member request validated by the pure `planLeaveEncashment` kernel (quarter steps, per-request cap, balance floor) against the LEDGER projection, the S14 approver chain decides (assertLeaveDecider, QA-1 re-validation inside the transaction, QA-16 guarded flip), APPROVE writes the CONSUME ledger row + cache re-sync + the ENCASHMENT PayAdjustment in ONE transaction (amount snapshots: days × monthly gross ÷ the payout period's holiday-aware working days — the F2.1 basis), and the consuming run's LOCK flips the row PAID (paidRunId back-link). Remaining: the daily auto-draft job (LV-J02) and Unpaid/Paid doc states | Partial | L9 / **P2 DONE (2026-11-09)** |
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
| LV-B08 | Max-consecutive-days walk across adjacent applications | S12: the pure `checkCrossRequestConsecutive` (lib/leave-policy.ts) merges the new range with the member's ACTIVE same-type requests into chains — ranges chain when the calendar gap between them holds NO working day (weekend/holiday bridges are consecutive leave) — and counts the chain's holiday-aware working days against the cap; createLeaveRequest refuses with the chain span named; the per-request guard stays for single spans | **Parity (workspace scope)** (was Partial) | L5 / **S12 DONE** |
| LV-B09 | Block-list validation with department scoping | — | Missing | L8 |
| LV-B10 | Salary-processed guard (LWP cannot overlap a processed slip) | S10: createLeaveRequest refuses UNPAID-type ranges whose months (pure `monthsInRange`) intersect a LOCKED run's period — processed pay is immutable, so unpaid leave can't dock it retroactively; paid types and OPEN runs stay correctable | **Parity (workspace scope)** (was Missing) | L5 / **S10 DONE** |
| LV-B11 | Attendance conflict guard in the leave chain | S11: createLeaveRequest refuses ranges carrying an explicit mark (PRESENT/ABSENT/HALF_DAY/WFH — DERIVED ON_LEAVE rows never conflict), naming up to three date+status pairs — attendance and leave never double-encode the same day; derivation both directions stays (F1.3) | **Parity (workspace scope)** (was Partial) | L5 / **S11 DONE** |
| LV-B12 | Self-approval policy per leave type | requests decided by manager-of-requester or ADMIN/HR only — the benchmark's default posture, fixed | **Parity** | L5 |
| LV-B13 | Approver chain: employee-level → department → workflow | S14: `EmployeeProfile.leaveApproverId` (HR-set in the directory modal, self/ghost-validated) — the pure `resolveLeaveApprover` chain is override → reporting manager → ADMINs; getApproverIdsFor feeds BOTH decision permission (assertLeaveDecider) and request notifications, so the override user decides AND is notified while the bypassed manager is not; department-level wiring stays declined (chain-scoped leave privacy decision) | **Parity (workspace scope)** (was Partial) | E1/L5 / **S14 DONE** |
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
| AT-09 | `Overtime Type` + `Overtime Slip` (+`Overtime Details`, `Overtime Salary Component` children) | fixed-hourly vs component-based calc; standard/weekend/holiday multipliers; caps; slips span a payroll period and submit Additional Salary rows | P9: the lite bridge — derived `overtimeMinutes` on attendance (S2 discipline) + the payout knob + the gross-basis "Overtime" line materialized at run creation (snapshot discipline). Remaining: Overtime Type config (multipliers/caps) and the standalone slip doc — shift-based machinery parked with F3.5 | Partial (was Missing) | L17 / **P9 DONE** |
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
| EM-04 | Employee leave/expense approver wiring | per-employee approver fields; automatic role grants + doc sharing | S14: per-employee leave-approver override (`EmployeeProfile.leaveApproverId`) resolved by the pure chain (override → manager → ADMINs) for decisions + notifications; expense approvers N/A until F2.8; role-grant automation stays the static floor + DB ceiling (deliberate) | **Partial (improved)** | E1 / **S14** |
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
| EM-B01 | Employee naming (series / employee number / full name) | S13: `EmployeeProfile.employeeNumber` (unique, EMP-0001…) — the ONE `nextEmployeeNumber` helper assigns inside the creating transaction (markJoined); the migration backfills deterministically by (createdAt, id); the directory renders the number under the name; seed mirrors the backfill | **Parity (workspace scope)** (was Partial) | E1 / **S13 DONE** |
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
| RJ-B14 | CTC engine: derive CTC from base OR solve base for target CTC | P12: both directions — computeOffer derives (percent-of-basic resolution + CTC totals), the pure `lib/ctc-solver.ts` inverts (target CTC → basic, fixed amounts + percent rates held constant, whole-unit rounding residue reported, refusal reasons surfaced) through the shared CtcSolverField in the structure editor and the offer builder | **Parity (workspace scope)** (was Partial) | R10 / **P12 DONE (2026-11-09)** |
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

**P1 of the 2026-11-09 payroll sweep (§7.2.1 of the plan) status flips** — 2 rows, both Partial → **Parity (workspace scope)**: PR-12 (`PayAdjustment` — the universal one-off adapter: ONE_SHOT/RECURRING (endPeriod + lastConsumedPeriod watermark)/OVERWRITE, provenance sourceType/sourceId, PENDING→CONSUMED/SKIPPED with visible reasons, consumed inside the run/slip creation transaction) and PR-B10 (all three recurrences; the pure two-pass kernel `lib/pay-adjustment.ts` resolves FIXED/PERCENT_OF_GROSS first and PERCENT_OF_NET deductions sequentially — no fixed-point iteration). This paragraph also drift-corrects the census for the 2026-11-08 S-sweep's 12 unrecorded flips: **57 Parity · 81 Partial · 135 Missing · 36 Out of scope** (+2 beyond/split rows) over the ~311 single-count rows — the table above keeps its 314 multi-item counting.

**P2 of the 2026-11-09 payroll sweep (F2.2, LV-09)** — 1 row, Missing → **Partial**: LV-09 (leave encashment riding the adapter: policy knobs default-off, the request→approve→CONSUME+adjustment transaction→PAID-on-lock lifecycle; the daily auto-draft job LV-J02 and the Unpaid/Paid doc states remain). LV-01's note updated (the encashment knobs landed). Census after P2: **57 Parity · 82 Partial · 134 Missing · 36 Out of scope**.

**P3 of the 2026-11-09 payroll sweep (F3.1, PR-13/PR-B11)** — 2 rows, Missing → Partial/Parity: PR-13 (arrears reverse-simulation through the pure `simulateArrearsRun` kernel — preview + `generateArrears` emitting ARREARS adapter rows, idempotent per slip; per-component diffs and submittable-doc states remain → Partial) and PR-B11 (the per-slip reverse-simulation rule itself → Parity, workspace scope). Census after P3: **58 Parity · 83 Partial · 132 Missing · 36 Out of scope**.

**P4 of the 2026-11-09 payroll sweep (F3.1, PR-14/PR-B12)** — 2 rows, Missing → Partial/Parity: PR-14 (LWP correction reversal through the pure `planLwpCorrection` kernel — preview + `reverseLwpDays` emitting LWP_CREDIT adapter rows with the days as `sourceDays` data; the submittable-doc shape remains → Partial) and PR-B12 (the reversal rule itself, cap included → Parity, workspace scope). Census after P4: **59 Parity · 84 Partial · 130 Missing · 36 Out of scope**.

**P5 of the 2026-11-09 payroll sweep (F3.2, PR-15–18/PR-B04)** — 4 rows: PR-15 Missing → Partial (yearly capped elections + the Benefits panel; member self-service application and split frequencies remain), PR-17/PR-18/PR-B04 Missing → **Parity (workspace scope)** (claims against the accrued balance via the adapter; the append-only accrual ledger written at every run lock, ÷12 paid-days-scaled; the pro-rata election rules). Census after P5: **62 Parity · 85 Partial · 126 Missing · 36 Out of scope**.

**P6 of the 2026-11-09 payroll sweep (PR-22/PR-23/PR-T01)** — 3 rows: PR-22 Missing → **Parity (workspace scope)** (the INCENTIVE source on the P1 manual writer), PR-23 Missing → Partial (the installments writer with rounding-honest splits + dual notification; the submittable-doc states remain), PR-T01 Missing → **Parity (workspace scope)** (RETENTION_BONUS outbox email + in-app notification). Census after P6: **64 Parity · 86 Partial · 123 Missing · 36 Out of scope**.

**P7 of the 2026-11-09 payroll sweep (PR-20/PR-21, F3.3)** — 2 rows: PR-20 Missing → **Parity (workspace scope)** (the GRATUITY line on the live FnF with the UNSETTLED→SETTLED payout lifecycle), PR-21 Missing → **Parity (workspace scope)** (the rule + slabs as data — enabled, averaging window, years→fraction bands — with the generalized slab walk replacing the 3 statutory experience methods, non-statutory disclaimer rendered everywhere). Census after P7: **66 Parity · 86 Partial · 121 Missing · 36 Out of scope**. The user has set the end-state target for this matrix — **309 Parity · 0 Partial · 0 Missing · 0 Out of scope** — so the previously-declined ADR-014 set is now in scope for later epics once the P8–P23 sweep lands.

**P8 of the 2026-11-09 payroll sweep (PR-19/PR-B13, F3.3)** — 2 rows: PR-19 Missing → **Parity (workspace scope)** (the ACTIVE→RELEASED hold window with WITHHELD-stamped slips and the adapter-paid release; the benchmark's JE doc-event driver is accounting machinery, out per ADR-014), PR-B13 Missing → **Parity (workspace scope)** (the whole flow: overlap-refused hold creation, birth-time stamping, YTD/self-service exclusion, the Withholding modal + badges, the settled-FnF guard). Census after P8: **68 Parity · 86 Partial · 119 Missing · 36 Out of scope**.

**P9 of the 2026-11-09 payroll sweep (PR-B26, AT-09 lite)** — 2 rows: PR-B26 Missing → **Parity (workspace scope)** (the overtime payout setting + the derived-minutes → slip line bridge, gross-basis rate, default OFF), AT-09 Missing → Partial (the derived fact, the knob and the bridge line land; the Overtime Type config with standard/weekend/holiday multipliers and caps stays parked with shifts, F3.5). Census after P9: **69 Parity · 87 Partial · 117 Missing · 36 Out of scope**.

**P10 of the 2026-11-09 payroll sweep (PR-B05, PR-03's payroll_frequency)** — 1 row: PR-B05 Partial → **Parity (workspace scope)** (all five benchmark cadences — monthly/bimonthly/weekly/fortnightly/daily — plus quarterly/annual house extras, through the pure `lib/payroll-windows.ts` kernel: resolvePayrollWindow + parsePayrollPeriodKey make every period key bidirectional with its real window, so adjustment due-ness (the benchmark's Additional-Salary date-overlap), hold windows, YTD attribution/ordering, gratuity last-N and the leave salary-processed guard all compare dates instead of period strings; `SalaryStructure.frequency` is the frequency-matched run filter; per-window amounts = annual ÷ windowsInYear). PR-03 stays Partial (payroll_frequency landed; timesheet mode + hourly rate remain out with timesheet payroll §7.0). Census after P10: **70 Parity · 86 Partial · 117 Missing · 36 Out of scope**.

**P11 of the 2026-11-09 payroll sweep (PR-B09)** — 1 row: PR-B09 Partial → **Parity (workspace scope)** (read-time period aggregates through ONE pure kernel — `lib/payslip-aggregates.ts` — feeding both the HR console and self-service: YTD net + gross with calendar-year resets, MTD net resetting with the calendar month of the window end, per-component YTD merged by side+key with statistical lines excluded; the payslip modal renders the aggregates in its totals box and per-line component-YTD chips, self-service's latest strip shows the MTD; held/released money carries forward, never accumulates; the HR read's YTD basis switched to the same kernel so the two surfaces now share one aggregation truth). Census after P11: **71 Parity · 85 Partial · 117 Missing · 36 Out of scope**.

**P12 of the 2026-11-09 payroll sweep (PR-B20, RJ-B14)** — 1 row: RJ-B14 Partial → **Parity (workspace scope)** (the compensation engine's inverse: the pure `lib/ctc-solver.ts` solveBaseForCtc — CTC(B) = fixed + B×rate with deductions/statistics excluded from the rate — solves the basic that hits a target annual CTC, rounds to a granularity with the residue reported, refuses visibly when no basic can flex or the target sits below the fixed cost; the shared CtcSolverField control rides both the structure editor and the offer builder). PR-B20 stays Partial (derive + solve + ctc_breakup now all land; the prospective-SSA comparison of future-dated assignments remains unbuilt). Census after P12: **72 Parity · 84 Partial · 117 Missing · 36 Out of scope**.

**P13 of the 2026-11-09 payroll sweep (PR-B14, PR-09's >30 path)** — 1 row: PR-B14 Partial → **Parity (workspace scope)** (chunked-lite batch processing: the first 30 slips ride the run-creation transaction byte-identically, every slip beyond the 30th writes in its own transaction with per-slip error isolation — one bad record never aborts the payroll — and failures surface with humanized reasons in the result, audit and toast while counts stay honest; a failed slip's adjustments stay PENDING for the addPayslip recovery path; the benchmark's Queued state + background job are the queue infra the locked decision declines). PR-09's note updated (the >30 path + P10 cadences landed; employee filtering is P14's, JE/cancellation stay out). Census after P13: **73 Parity · 83 Partial · 117 Missing · 36 Out of scope**.

**P14 of the 2026-11-09 payroll sweep (PR-33, PR-04's employee filter)** — 1 row: PR-33 Missing → **Parity (workspace scope)** (the bulk structure assignment: one component set to many employees at once, per-employee transactions with the F-R1 retire+create discipline, per-employee isolation with named failures, honest counts, the BulkStructureModal copying an existing active structure as the source). PR-04's payroll-entry employee filter landed too (createPayrollRun's optional userIds — the audit names the filter); PR-04 stays Partial (base/variable split, cost centers and opening balances remain unbuilt). Census after P14: **74 Parity · 83 Partial · 116 Missing · 36 Out of scope**.

**P15 of the 2026-11-09 payroll sweep (PR-06)** — 1 row: PR-06 Partial → **Parity (workspace scope)** (partially-paid leave: `LeaveType.salaryFraction` 0–1 with a 1 default = zero behavior change; the derivation charges (1 − fraction) × the working fraction per covered day in the same leave-wins walk, and `Payslip.lopDetail` freezes the per-slip breakdown at creation — per-type rows with taken/charged days and the fraction, plus the attendance-side buckets — rendered in the payslip modal and cleared by a MANUAL LOP override; the LV-B10 salary-processed guard now blocks partially-paid types in LOCKED windows exactly like unpaid; the type editor exposes the knob and the card shows a "50% pay" badge; the seed demos Ingrid's 2 half-pay days → 1 charged). LV-01's note refreshed (the stale "encashment knobs still missing" corrected — P2 landed them; remaining: compensatory leave, optional-leave). Census after P15: **75 Parity · 83 Partial · 115 Missing · 36 Out of scope**.

**P16 of the payroll sweep (PR-11, PR-04 — first item of the §7.2.2 Partial Residual Sweep, 2026-11-10)** — 2 rows, both Partial → **Parity (workspace scope)**: PR-11 (the fiscal-year YTD basis: `Workspace.fiscalYearStartMonth` 1–12 with a 1 default = the calendar year = zero behavior change; the pure `fiscalYearOf`/`fiscalYearBounds`/`fiscalYearLabel` helpers in lib/payroll-windows.ts; the aggregates kernel resets YTD at the fiscal boundary on BOTH payslip surfaces while MTD stays the calendar month — a run belongs to the fiscal year its window ENDS in, so the HR run-selection spans calendar boundaries; the payslip modal renders the "YTD · 2026/27" chip + the basis note; component-level start/end dates live as catalog validity windows `SalaryComponent.effectiveFrom/effectiveTo` — the picker badges them, saveSalaryStructure refuses lines outside the window at the structure's effective date with a friendly error naming the component + window, and structures keep their snapshot copies) and PR-04 (the SSA opening balances: `SalaryStructure.openingYtd` component rows — gross/net openings DERIVE from the rows so Σ lines == the totals, the same discipline payslip lines follow — seeding the fiscal year containing the structure's effectiveFrom in the read-time aggregates, active OR retired rows (an opening is a fact of what was earned), WITHHELD first slips carrying the opening forward; plus the duplicate-effectiveFrom guard, one structure per employee per effective date). The structure editor grows the opening-YTD block (rows + live opening gross/net) and the client-side pre-check of the window refusal; Settings → General gains the fiscal-year select. Seed: the workspace demos the April (NZ) basis — byte-identical for the existing demo windows since they all sit inside FY 2026/27 — plus Diego's prior-employer opening rows ($39,000 earned / $1,300 deducted) created after the runs so no fixture moves. Census after P16: **77 Parity · 81 Partial · 115 Missing · 36 Out of scope**.

**P17 of the payroll sweep (PR-B27, PR-B25 — §7.2.2 Partial Residual Sweep, 2026-11-10)** — 2 rows: PR-B27 Partial → **Parity (workspace scope)** (the proration basis switch `Workspace.lopBasisMode`: HYBRID default = the pre-P17 leave-wins walk byte-for-byte; LEAVE = spans only — attendance marks never charge and unmarked-as-absent is suspended; ATTENDANCE = marks only — leave never charges, spans still record taken days at charged 0 in the frozen breakdown, and a covering span shields the day from its mark; unknown values clamp to HYBRID at both the loader and the kernel so a bad row can't invent a fourth mode; the knob rides `DeriveLopOptions` into run/slip creation, and the payslip modal's AUTO note names the basis) and PR-B25 Missing → **Parity (workspace scope)** (leave balances on the slip: `Workspace.showLeaveBalancesOnSlip` default OFF; when on, both payslip surfaces carry each employee's LIVE balances — the latest-year row per user×type, names joined in memory since LeaveBalance has no LeaveType relation — rendered in the modal's "Leave balances (live)" box with the read-time note; never snapshotted, so the toggle shows/hides instantly). Settings → General gains both knobs (the basis select beside the fiscal year, the balances toggle beside overtime); migration `20261128100000` with a lossless down (both defaults = the pre-P17 semantics). Census after P17: **79 Parity · 80 Partial · 114 Missing · 36 Out of scope**.

**P18 of the payroll sweep (PR-B16 — §7.2.2 Partial Residual Sweep, 2026-11-10)** — 1 row: PR-B16 Partial → **Parity (workspace scope)** (payslip email on lock: `Workspace.emailPayslipsOnLock` default OFF; when on, `lockPayrollRun` queues one PAYSLIP outbox row per slip on the lock transaction itself — the retention-bonus pattern, no email without its money — then delivers each best-effort outside it, one at a time, counting sent/skipped/failed into the lock audit; subjects carry no amounts, bodies are the plain-text audit copy rendered as HTML with the net line bolded — gross/deductions/net + LOP + withheld notes + the My-payslips PDF pointer; the pure builders live in lib/payslip-email.ts since a "use server" file may only export async functions; the password-protected PDF attachment stays declined per §9.2 — the PDF is the download). Settings → General gains the toggle; migration `20261128110000` with a lossless down (default false = the pre-P18 silence). Census after P18: **80 Parity · 79 Partial · 114 Missing · 36 Out of scope**.

**P19 of the payroll sweep (PR-P01–03 — §7.2.2 Partial Residual Sweep, 2026-11-10)** — 1 row (three benchmark artifacts): PR-P01–03 Partial → **Parity (workspace scope)** (payslip print formats: the LOCKED slip's print row grows a Classic/Compact/Detailed picker — persisted in localStorage, clamped to Classic on garbage; CLASSIC = the standard paper slip (lines + core totals + LOP note + note field), COMPACT = the essentials only at a tighter type, DETAILED = everything the modal shows plus a print-only meta footer (slip identity, period, working/paid days, withhold state, printed date); implemented as @media-print visibility keyed off the form's data-print-format in globals.css — screen output byte-identical in all three modes, no second render tree). Census after P19: **81 Parity · 78 Partial · 114 Missing · 36 Out of scope**.

**P20 of the payroll sweep (PR-R01, PR-R02 — §7.2.2 Partial Residual Sweep, 2026-11-10)** — 2 rows, both Missing → **Parity (workspace scope)**: PR-R01 (the salary register CSV: `exportPayrollRunCsv` kind REGISTER — payroll:manage, LOCKED runs only (paid money is the only money worth exporting), one row per paid slip with the identity joins in memory (employee no from the profile, name from the user, deductions re-totalled off the stored line snapshots) plus an honest TOTAL row; leading comment lines carry the non-statutory disclaimer (ADR-014); RFC 4180 escaping; the pure builder lib/payroll-csv.ts is golden-file tested; audited `payroll.run_exported`) and PR-R02 (the bank remittance CSV: one payment row per DISBURSED net — WITHHELD nets never reach the bank file, the TOTAL counts only disbursed money — with the bank-account column blank by design (Fernly stores no bank details; the employer's bank maps accounts from its records), NZD named as the codebase's established currency, the slip number as the payment reference). Both ride the Payroll view's LOCKED-row buttons (Register CSV / Bank CSV) downloading via the analytics Blob pattern. Census after P20: **83 Parity · 77 Partial · 113 Missing · 36 Out of scope**.

Family-level (the plan's 77 families, statuses current at `bb2e046` — matches the reassessment): **12 Parity · 23 Partial · 36 Missing · 6 Out of scope**. Module-level: every row above is assigned to exactly one of the four domain logic modules — **hr 145 · admin 24 · account 93 · joining 52** — via the domain default plus 20 row-level exceptions, in `Fernly_Domain_Modules_Architecture_Plan.md` §5 (reproducible: `python3 scripts/module_rollup.py`, totals sanity-checked against this section).

Where the row-level gap concentrates (Missing rows by domain): PR 31 · LV 26 · AT 22 · EM 24 · RJ 12 · PF 15 · EX 14 · PL 4. The **operational middle** verdict of the plan advances with Phase 2 — F2.4 (leave policy engine), F2.1 (offboarding & FnF) and F2.10 (joining hardening) have landed, and the 2026-11-09 payroll sweep is under way: **P1 (the PayAdjustment adapter, F2.3's core) DONE**; next up: P2 (leave encashment riding the adapter — F2.2), then P3/P4 (arrears + LWP corrections, F3.1) per the §7.2.1 risk-first order.

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
