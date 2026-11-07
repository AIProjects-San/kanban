# Fernly HR & Payroll Parity Reassessment

**Benchmark: Frappe HR (`frappe/hrms`) — refreshed · Current-state gap report and plan update**

| | |
| --- | --- |
| Document | `docs/Fernly_HR_Payroll_Parity_Reassessment.md` |
| Date | 2026-11-06 (evening) · **F1.4 status update appended after the epic landed (§7.1)** · **F1.2 status update appended after the epic landed (§7.1)** · **F1.5 status update appended after the epic landed (§7.1)** |
| Status | Current-state assessment — supersedes the gap matrix of `Fernly_HR_Payroll_Enhancement_Plan.md`; the epic plan itself is carried forward with updated status |
| Scope | Payroll, HR (people, leave, attendance, holidays), Onboarding/Joining, Hiring — benchmarked against Frappe HR |
| Fernly code state | `42c6d82` ("feat(payroll): F1.5 salary component catalog — master data + picker + offer mapping", first-commit-clean — CI green run 42340999260) |
| Benchmark state | `frappe/hrms` @ `1c28527` (2026-11-06, v17 develop; PR #5607 merge) — 3 days newer than the original plan's `159548fa` |
| Companion docs | `Fernly_HR_Payroll_Enhancement_Plan.md` (the plan), `HR_MODULE_PLAN.md`, `RECRUITMENT_MODULE_PLAN.md`, `Fernly_Persona_Acceptance_Assessment.md`, `DECISIONS.md` |

---

## 1. Executive Summary

This report re-runs the Frappe HR benchmark comparison against the codebase **as it stands today**, after the first five Phase-1 epics landed (`F1.1` holiday calendar @ `58b0fa7`, `F1.3` attendance records @ `5ef0dd1`, `F1.4` attendance→LOP derivation @ `534b2f4`, `F1.2` leave ledger @ `89c0844`, `F1.5` salary component catalog @ `42c6d82` — all CI green). The benchmark itself was refreshed to the tip of `frappe/hrms` develop (`1c28527`); the three-day delta contains no architectural change to HR or Payroll, so every structural conclusion of the original plan carries over unchanged.

**What changed since the plan was written:**

1. **Five Phase-1 epics are DONE and verified in code** (not just claimed): holiday-aware working-day math is real and denormalized onto every new leave request and payroll run; attendance records exist with five statuses, HR-only marking, and automatic `ON_LEAVE` derivation from approved leave; payroll now READS those facts — `createPayrollRun` derives each payslip's loss-of-pay from attendance + unpaid leave with `lopSource` provenance; the leave domain's source of truth is now an **append-only `LeaveLedgerEntry`** (GRANT/CARRY/CONSUME/EXPIRE/ADJUST + `isReversal` siblings; `LeaveBalance` demoted to a transactionally-synced derived cache; the QA-1 overdraft guard reads Σ(all deltas) from the ledger); and the salary-component vocabulary is now a **`SalaryComponent` catalog** (master CRUD at `payroll:manage`, the structure editor's picker, offer→structure mapping with auto-registration, and F-R1's transactional retire+create) — all pinned by unit + e2e tests.
2. **Coverage moved from 9 → 11 parity, 21 → 23 partial, 41 → 37 missing** of 77 benchmarked families (the F1.5 update moves P1, the salary-component-catalog family, to Parity at workspace scope). The leave-day and payroll-denominator machinery (L7) and the attendance data foundation (L12) crossed status lines with F1.1/F1.3; the attendance→payroll link (P7) crossed with F1.4; the leave ledger itself (L3) crossed with F1.2; the component catalog (P1) crossed with F1.5.
3. **The deep re-read found 19 verifiable defects/risks the original plan did not list** (§6) — mostly concurrency and lifecycle-hygiene items (non-transactional multi-writes, offer-expiry semantics, reschedule orphans, an unassigned-task drift between two copies of the onboarding template). None is a P0-style user-facing lie; all are cheap to fix while riding the next epics.
4. **The highest-value next move is now F1.6 (employment lifecycle)** — the last Phase-1 epic. With the component catalog landed, every master datum Phase 2's earning/deduction machinery (F2.3 PayAdjustment, F2.2 encashment, F2.8 advance recovery) will consume already exists: structures reference catalog codes, offers map through the catalog, and retire+create is atomic.

The recommended sequence after F1.5 remains the plan's own: **F1.6 (employment lifecycle) closes Phase 1**, then Phase 2 as written, with the §6 hygiene items folded into the matching epics. F1.5 itself landed (`42c6d82`, first-commit-clean — the catalog model + migration/backfill, the CRUD action, the editor picker, the offer mapping with auto-registration, F-R1's transactional retire+create, and F-R13's `checkPermission` probe went in as ONE commit; the date-dependent overlap test it exposed on a Saturday run was made calendar-independent inside it).

---

## 2. Method and Sources

| Source | Version | Method |
| --- | --- | --- |
| `github.com/frappe/hrms` | `1c28527` (develop tip, 2026-11-06) | Full clone; complete doctype + controller inventory of `hrms/payroll` (43 doctypes incl. tax & benefits), `hrms/hr` (114 doctypes — employee lifecycle, leave, attendance, shifts, expenses), recruitment + performance (doctypes, offer→employee flow, appraisal scoring), frontend self-service surface |
| `github.com/frappe/erpnext` | main (2026-11-06) | Confirmed: no `hr/` or `payroll/` modules remain in core since v14 — the Employee doctype master lives in ERPNext and is **extended** by hrms via `override_doctype_class` + custom fields. Any "compare with ERPNext" task is therefore a comparison with `hrms` |
| Fernly | `5ef0dd1` on `origin/main` | Full deep read of `prisma/schema.prisma`, every HR/payroll/hiring server action (function-by-function: gates, validation order, transitions, transactions, audit, mail), pure-math libs, all views, unit + e2e suites, seed, migrations, and git history |
| CI | run 42174851202 | `5ef0dd1` = success (after two stabilization rounds on the F1.1 epic: `fa7431c`, `0a8e8af`, `1e633dd`) |

Depth statement: "thorough without missing a single line" was again interpreted as **complete structural coverage + functional depth on everything that matters** — every exported action, every pure function, every model, every test file in the four target domains was read; nothing was sampled.

---

## 3. Benchmark Refresh (`159548fa` → `1c28527`)

The three-day delta on `hrms` develop contains no change to the HR/Payroll architecture described in the original plan's §3:

- **Doctype census unchanged**: 115 HR + 43 Payroll doctypes; all payroll/tax doctypes still physically under `hrms/payroll/doctype/`; the `tax_and_benefits`, `hr_setup`, `leaves`, `shift_and_attendance`, `expenses`, `tenure` folders remain workspace/sidebar/onboarding-only reorganizations (zero doctypes) — a presentation-layer split, not a code split.
- **Tip commit is itself cosmetic** (PR #5607 "better-appointment-letter" — appointment-letter placeholder/template polish; the placeholder list gained letter-date/offer-date/place-of-posting style variables).
- **Engine internals re-verified at `1c28527`** (details in the reference inventories this reassessment was built from): the projection-based tax engine (`compute_taxable_earnings_for_year` → `calculate_variable_tax`), the two-pass formula evaluation on Salary Structure Assignment (`_evaluate_all_components` with a full-cycle pseudo-slip context), the payment-day engine on Salary Slip (`get_working_days_details` with Leave-vs-Attendance modes, half-day fractions, PPL), the append-only `Leave Ledger Entry` with expiry scheduler, the shift/check-in matching algorithm with grace margins and absent sweep, the Additional-Salary universal injection mechanism, and the Job Offer → Employee/Onboarding handoff with `required_for_employee_creation` gating.

**Conclusion: the benchmark side of the original plan is still accurate. All gaps below are Fernly-side updates.**

---

## 4. Current-State Inventory (verified in code at `5ef0dd1`)

### 4.1 Payroll (`src/server-actions/payroll.ts`, `src/server-actions/payroll-components.ts`, `src/lib/payroll-math.ts`, `src/lib/working-days.ts`, `src/lib/offer-math.ts`)

**Data.** `SalaryStructure` (per-employee ANNUAL components JSON, `effectiveFrom`, `isActive` — single-active enforced in code, not DB; **retire+create atomic since F1.5**) → `PayrollRun` (`period` unique, `OPEN→LOCKED` one-way, `workingDays` denormalized at creation since F1.1) → `Payslip` (`@@unique([runId,userId])`, `slipNo PS-<period>-<seq>`, earnings/deductions JSON lines, `lopDays`, gross/net; YTD never stored — computed at read time). **F1.5 adds `SalaryComponent`** — the code-unique catalog master behind the structure editor's picker; structures keep their JSON snapshots (snapshot discipline), `createStructureFromOffer` maps offer lines through the catalog and auto-registers unseen codes.

**Math (pure, shared with the UI preview).** `round2` at every step; `monthlyEarningsFromStructure` = `computeOffer` resolution (FIXED or % of the `basic` anchor) ÷ **12 per line**, EARNING components only (employer contributions never reach the slip); `computeLop(gross, lopDays, period, workingDays?)` denominator = run's denormalized `workingDays`, falling back to calendar month length for pre-F1.1 runs; `withLopLine` replaces (never duplicates) the auto `lop` line; `workingDaysBetween` (F1.1) skips Sat/Sun always, subtracts full-day holidays, counts half-day holidays as 0.5, ignores `kind`, and is inert for weekend entries.

**Actions (14 exports, all `payroll:manage` = ADMIN+HR except `getMyPayslips` which is session-only, self-scoped, zero inputs).** `createPayrollRun` = single nested atomic create (run + all payslips snapshot from ACTIVE structures); `updatePayslip` = OPEN-runs-only, duplicate-line-keys rejected, `lopDays ≤ run.workingDays` (or calendar fallback), server-recomputed gross/net, **negative net rejected**; `addPayslip` = joiner snapshot with one `slipNo` race retry; `lockPayrollRun` = ≥1 payslip required; ESS `getMyPayslips` = **LOCKED runs only** with running calendar-year YTD. **F1.5 adds the catalog trio** (`getSalaryComponents`/`saveSalaryComponent`/`deleteSalaryComponent` — duplicate code → friendly error) and makes `saveSalaryStructure`/`createStructureFromOffer` transactional (F-R1).

**Verified F1.4 status at `5ef0dd1`: NOT implemented** — `createPayrollRun` never queried `attendanceRecord`, `lopDays` defaulted to 0, and no `lopSource` field existed anywhere (schema, types, actions). LOP was purely manual HR entry. *(Superseded the same day: F1.4 landed @ `534b2f4` — see §7.1.)*

### 4.2 HR (`src/server-actions/hr-*.ts`, `src/lib/config.ts`)

**Leave.** `LeaveType` (+1:1 `LeavePolicy`: annualDays/maxCarryOver/minNoticeDays/maxConsecutiveDays) → `LeaveRequest` (`PENDING→APPROVED|REJECTED|CANCELLED`, guarded status flips, `days` denormalized once from holiday-aware counting) → `LeaveBalance` (mutable entitled/carriedOver/used triple; `used` maintained only inside approve/cancel transactions with atomic `increment`/floored `decrement`). Validation chain (order): schema → active type → date order → holiday-aware day count → notice → consecutive → overlap → balance (re-checked inside the approval transaction). **Verified F1.2 status at `5ef0dd1`: NOT started** — no `LeaveLedgerEntry` model/migration/code existed; **`carriedOver` is written only ever as 0** and no year-end rollover job or action exists (`maxCarryOver` is configure-and-display only). *(Superseded the same day: F1.2 landed @ `89c0844` — see §7.1; `carriedOver` itself stays 0 until the F2.4 rollover writer.)*

**Attendance (F1.3, new).** `AttendanceRecord` (`@@unique([userId,date])`, statuses PRESENT/ABSENT/HALF_DAY/WFH/ON_LEAVE, optional `HH:mm` in/out, `source MANUAL/IMPORT/DERIVED`) at `attendance:manage` (ADMIN+HR — deliberately separate from `hr:admin`). Approval of leave derives `ON_LEAVE` rows transactionally (`deriveOnLeaveAttendance` — only into days with **no record of any kind**; explicit HR marks always win); cancellation removes them again unless another approved request still covers the day. Every explicit save forces `source:"MANUAL"` (editing a derived row converts it); the form schema rejects `ON_LEAVE` submissions outright. Member read is self-scoped, zero inputs. **`IMPORT` is a dead enum value — no writer exists.**

**Holidays (F1.1, new).** `HolidayCalendarEntry` (date unique, label, isHalfDay, kind PUBLIC/WEEKLY_OFF labeling-only), `hr:admin` CRUD with friendly duplicate-date errors; deleting a past entry deliberately recomputes nothing (denormalization discipline stated in schema, action and UI).

**Directory / reviews / onboarding.** `EmployeeProfile` (self-service contact-fields-only strict schema; HR full edit; **no employment-status fields** — verified F1.6 not started), `PerformanceReview` (`DRAFT→SUBMITTED→REVIEWED→ACKNOWLEDGED`, self-review ban, manager-chain + HR reviewer rules), `OnboardingChecklist`/`OnboardingTask` (hard-coded 5-task template, auto-complete/reopen, transactional assignment to the hire's manager).

### 4.3 Hiring & Joining (`src/server-actions/hiring.ts` — 38 exports, `src/lib/offer-math.ts`, `src/lib/hiring-email.ts`, `src/app/offer/[token]/`)

**Pipeline.** `HiringStageConfig` template (fully editable) → `Candidate` (email-unique; `ACTIVE→SELECTED→HIRED|REJECTED|WITHDRAWN` + REACTIVATE) with per-candidate **snapshot** stages (`CandidateStage`: PENDING→IN_PROGRESS→PASSED|FAILED + SKIPPED; scorecard rating/strengths/concerns/recommendation). Stage movement is button-driven (no drag-and-drop action exists).

**Interviews.** `scheduleInterview` (INTERVIEW stages only; ±59-minute interviewer conflict check, check-then-act) creates one `CalendarEvent` + one `Reminder` per call — **reschedules create new ones and orphan the old**. `saveScorecard` is session-scoped for the assigned interviewer (P0-5/D-04); `getMyInterviews` is the self-service surface. **No interview-invite email is ever sent** (`INTERVIEW_INVITE` outbox kind is schema-reserved, never written).

**Joining formalities.** `DocumentTypeConfig` → `CandidateDocument` (REQUESTED→RECEIVED→VERIFIED|REJECTED, idempotent re-request) and `BackgroundCheck` (INITIATED→IN_REVIEW→CLEARED|FLAGGED, repeatable). **Neither gates joining** — no precondition anywhere requires verified mandatory docs or a cleared BGV before `markJoined`.

**Offers.** `OfferTemplate` → `OfferRecord` (`DRAFT→SENT→SIGNED|DECLINED`; 256-bit single-use token, 7-day expiry enforced on read/sign; typed-name ceremony + IP capture; sent offers immutable). `sendOffer` and rejection/decision emails ride the **MailOutbox honesty pattern** (QUEUED before send → SENT/SKIPPED/FAILED, D-18 same-day duplicate guard). **No `EXPIRED` status exists** — expired tokens stay `SENT` forever (funnel "awaiting" overcounts), and `declineOffer` does not check expiry (asymmetric with `signOffer`). `{{startDate}}` is never populated by `createOfferRecord`.

**Joining chain (verified end-to-end).** `decideCandidate(SELECT)` → offer signed → `markJoined` — the module's **only transactional mutation**: creates User (deterministic email + random never-emailed OTP, role MEMBER) + TeamMember + EmployeeProfile + a 5-task onboarding checklist (inline duplicate of the HR template, **manager tasks left unassigned**, unlike `createChecklist`) + flips candidate HIRED; then queues the WELCOME mail and returns honest `mailStatus` + the day-one handout (D-03). **No SalaryStructure is created** — the joiner is invisible to payroll until HR manually runs `createStructureFromOffer`.

---

## 5. Updated Coverage Matrix

Status legend as in the original plan (Parity / Partial / Missing / Out of scope). **Bold status = changed since the plan was written.** Family numbering follows the plan's §6.1 so the two documents can be read side by side.

#### Payroll

| # | Feature family | Frappe HR | Fernly at `5ef0dd1` | Status |
| --- | --- | --- | --- | --- |
| P1 | Salary component catalog | `Salary Component` master (36 fields) | **F1.5: `SalaryComponent` catalog — code-unique master (label/kind/mode/defaultAmount/isActive/sortOrder) with payroll:manage CRUD, duplicate-code friendly errors, structure-editor picker, createStructureFromOffer mapping (canonical label/kind/mode per code + auto-registration of unseen codes), migration backfill from templates/structures/offers** — statutory fields (PF/ESI flags) stay out of scope (ADR-014) | **Parity (workspace scope)** (was Partial) |
| P2 | Component kinds incl. employer contribution | Earning/Deduction/Employer | `OfferComponent.kind` all three | Parity |
| P3 | Component formulas & conditions | AST sandbox eval | FIXED / PERCENT_OF_BASIC | Out of scope (ADR) |
| P4 | Temporal structure assignment | SSA timeline + opening balances | `effectiveFrom` + retire-on-revision | Partial |
| P5 | Payroll frequencies | 5 frequencies | monthly only | Partial |
| P6 | Payment-days proration | 5-setting engine | manual `lopDays`; **F1.1 working-day denominator + half-day holidays; F1.4 fractional LOP days (0.5/0.25)** | Partial **(improved)** |
| P7 | Attendance/LWP-driven proration | Leave/Attendance modes | **F1.4: `createPayrollRun`/`addPayslip` derive `lopDays` from attendance (ABSENT=1, HALF_DAY=0.5) + unpaid leave (leave-wins rule), `lopSource AUTO\|MANUAL` provenance with audited overrides, LOP line materialized at creation** — per-slip corrections stay manual overrides (no attendance-correction loop) | Partial **(was Missing)** |
| P8 | Slip lifecycle & finality | docstatus + Withheld | OPEN/LOCKED one-way, immutable lines | Partial |
| P9 | Duplicate-slip idempotency | guards | `@@unique` × 2 + pre-checks | Parity |
| P10 | YTD/MTD aggregates | YTD+MTD+per-component | calendar-year net YTD, two bases (HR incl. OPEN / ESS LOCKED-only) | Partial |
| P11 | One-off adjustments | Additional Salary | manual line edits while OPEN | Partial |
| P12–P14 | Arrears/corrections; withholding; benefits ledger | full | none | Missing |
| P15 | Income tax engine | projection engine | none | Out of scope (ADR-014) |
| P16 | Gratuity | rule slabs | none | Missing |
| P17 | Loan deduction | lending integration | none | Missing |
| P18 | Accounting posting | JEs, cost centers | none | Out of scope |
| P19 | Bank remittance export | reports | none | Missing |
| P20 | Payslip delivery | email + protected PDF | print view (`window.print()`); download-only decision §9.2 | Partial |
| P21 | Payroll reports | 8 reports | YTD panel | Partial |

#### Leave, attendance, shifts, holidays

| # | Feature family | Frappe HR | Fernly at `5ef0dd1` | Status |
| --- | --- | --- | --- | --- |
| L1 | Leave type configuration | 33-field doctype | paid/requiresDoc + 4 policy numbers | Partial |
| L2 | Leave policy & assignment | policies, bulk, pro-rata | 1:1 policy, year entitlement | Partial |
| L3 | Append-only leave ledger | Leave Ledger Entry | **F1.2: `LeaveLedgerEntry` — signed immutable rows (GRANT/CARRY/CONSUME/EXPIRE/ADJUST, `isReversal`), `LeaveBalance` a transactionally-synced derived cache, QA-1 guard = Σ(all deltas), cancel writes reversal siblings, migration backfills + drift-ADJUST rows** — EXPIRE/CARRY writers themselves are Phase-2 (F2.4), encashment consumption is F2.2 | Partial **(was Missing)** |
| L4 | Allocation lifecycle & expiry | periods, CF expiry, daily job | `carriedOver` structurally always 0; no rollover | Partial |
| L5 | Leave validation chain | 10-step chain | 7-step chain (holiday-aware counting **since F1.1**) | Partial |
| L6 | Half-day leave semantics | across modules | half-day exists only as holiday counting rule | Missing |
| L7 | Holiday-aware day counting | holiday lists per company/employee | **workspace calendar + workingDaysBetween + denormalized snapshots (F1.1)** — per-employee lists consciously out of scope | **Parity (workspace scope)** |
| L8 | Leave block lists | dates + scoping | none | Missing |
| L9–L11 | Encashment; compensatory; earned-leave accrual | full | none | Missing |
| L12 | Attendance records & statuses | 5 statuses + late/early flags | **5 statuses + HR marking + leave-derived ON_LEAVE + self-service read (F1.3)**; late/early flags absent | **Partial (was Missing)** |
| L13 | Attendance correction requests | Attendance Request | none (self-marking declined by decision §9.1) | Missing (deferred) |
| L14 | Check-in capture (device/geo) | Employee Checkin | none | Out of scope |
| L15–L17 | Shifts; rosters; overtime→payroll | full | none | Missing |
| L18 | Holiday calendars | lists + assignments | **workspace calendar, seeded, admin CRUD (F1.1)** | **Parity (workspace scope)** |

#### Employee lifecycle

| # | Feature family | Frappe HR | Fernly at `5ef0dd1` | Status |
| --- | --- | --- | --- | --- |
| E1 | Employee master breadth | grouping, approvers, work history | `EmployeeProfile` + org chart | Partial |
| E2 | Employment status lifecycle | Active/Left, probation, retirement | **verified absent — no status/probation/exit fields (F1.6 not started)** | Missing |
| E3 | Structured change history | Property History | generic audit log | Partial |
| E4 | Onboarding templates → tasks | configurable activity templates | hard-coded 5-task template × **two copies** (see §6 F-R8) | Partial |
| E5 | Onboarding gates employee creation | `IncompleteTaskError` | `markJoined` runs regardless of checklist | Missing |
| E6 | Promotion / transfer | property-diff docs | none | Missing |
| E7–E9 | Separation checklist; exit interview; FnF | full | none | Missing |
| E10 | Asset tracking | Asset Movement in FnF | none | Out of scope |

#### Recruitment / Joining

| # | Feature family | Frappe HR | Fernly at `5ef0dd1` | Status |
| --- | --- | --- | --- | --- |
| R1 | Job requisition & approval | status machine, time-to-fill | none | Missing |
| R2 | Staffing plan / vacancy budgeting | designation roll-ups | none | Missing |
| R3 | Public job openings & intake | WebsiteGenerator + daily close | manual candidate creation | Missing |
| R4 | Applicant sources & referrals | source master, referral payouts | free-text `source` field only | Missing |
| R5 | Pipeline & stage config | applicant status + kanban | `HiringStageConfig` + snapshots | Parity |
| R6 | Funnel & analytics | recruitment_analytics | funnel panel + stage counts + accept rate | Parity |
| R7 | Interview scheduling w/ conflicts | reminders + reschedule emails | ±59-min conflict check, event + reminder | Parity |
| R8 | Structured scorecards | per-skill ratings, averages | rating + strengths/concerns/recommendation | Parity |
| R9 | Interview round templates & skill criteria | Interview Type + skills | stage types only | Partial |
| R10 | Offer letters w/ component breakup & e-sign | terms + compensation engine | templates, components, single-use token e-sign | Parity **(expiry semantics gap — §6 F-R5)** |
| R11 | Offer approval before send | workflow-ready | none (D-20) | Missing |
| R12 | Appointment letter (post-offer) | template + placeholders | none | Missing |
| R13 | Recruitment reporting | analytics report | funnel only | Partial |

#### Performance & misc (unchanged from the plan)

F1 Parity (review lifecycle) · F2–F7 Missing/Partial (cycles, KRAs, goals, multi-rater, normalization, training) · F8 Partial (skills) · X1–X3 Missing (claims, advances, travel) · X4 Out of scope · X5 Missing (grievance) · X6 Parity (notifications/reminders) · X7 Partial (report suite).

### Updated coverage summary

| Status | Plan (pre-F1.1/F1.3) | At `5ef0dd1` (F1.1+F1.3) | At `c68e1c3` (+F1.4) | At `89c0844` (+F1.2) | Now (`42c6d82`, +F1.5) |
| --- | --- | --- | --- | --- | --- |
| Parity | 9 (12%) | 10 | 10 | 10 | **11** |
| Partial | 21 (27%) | 22 | 23 | 24 | **23** |
| Missing | 41 (53%) | 39 | 38 | 37 | **37** |
| Out of scope | 6 (8%) | 6 | 6 | 6 | 6 |
| **Total** | **77** | **77** | **77** | **77** | **77** |

The operational middle is still where the gap lives — but five of its floor stones (holiday math, attendance data, the attendance→payroll link, the leave ledger, and now the component catalog) are laid; the next structural move is F1.6 (employment lifecycle), which closes Phase 1 and unlocks the offboarding/transfer epics of Phase 2.

---

## 6. New Findings — Defects and Risks Found by This Deep Read

Not in the original plan; every item is verifiable at `5ef0dd1`. Severity: **A** = correctness/concurrency risk worth fixing in the next 1–2 epics; **B** = hygiene, fold into the matching epic; **C** = note/accept.

| ID | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| F-R1 | A | **Non-transactional structure retirement**: `saveSalaryStructure` and `createStructureFromOffer` do `updateMany({isActive:false})` + `create` as **two separate writes** — a crash between them leaves an employee with zero ACTIVE structures, silently dropping them from every future run. **Addressed by F1.5**: both actions now retire + create (+ offer-mapping registrations) inside ONE `$transaction` — the hand-off is atomic | `payroll.ts` (both actions; contrast `createPayrollRun`'s atomic nested create) |
| F-R2 | A | **`updatePayslip` last-write-wins**: no version/optimistic-lock column; two HR editors of the same OPEN slip overwrite each other (audit records each save, but not the interleaving) | `payroll.ts: updatePayslip` |
| F-R3 | B | **YTD bases diverge by design but undocumented in-product**: HR run view includes OPEN periods; ESS is LOCKED-only. Correct, but the payslip modal's "YTD net (through …)" means different things in the two surfaces | `getPayrollRun` vs `getMyPayslips` |
| F-R4 | B | **Notice check uses calendar days** though the `LeavePolicy` comment promises working days; `daysBetween(today, start) < minNoticeDays` counts weekends/holidays — **Addressed by F1.2**: notice now counts working days in (today, start], holiday-aware (near starts widen the holiday read by one day; far starts keep the F1.1 read scope via the 3N+1 guarantee) | `hr-leave.ts: createLeaveRequest` vs schema comment L764 |
| F-R5 | A | **Offer expiry semantics**: no `EXPIRED` status — expired tokens stay `SENT` (funnel "awaiting" overcounts stale links); `declineOffer` skips the expiry check entirely (asymmetric with `signOffer`/`getOfferByToken`) | `hiring.ts: sendOffer/getOfferByToken/signOffer/declineOffer` |
| F-R6 | B | **Reschedule orphans**: every `scheduleInterview` re-run creates a new CalendarEvent + Reminder; the previous pair is never deleted or updated via `stage.eventId` | `hiring.ts: scheduleInterview` |
| F-R7 | B | **No salary structure on joining**: `markJoined` provisions User/TeamMember/EmployeeProfile/Checklist but **not** `SalaryStructure`; the joiner is invisible to payroll until HR remembers `createStructureFromOffer` | `hiring.ts: markJoined` vs `payroll.ts: createStructureFromOffer` |
| F-R8 | B | **Onboarding template duplicated in code**: `markJoined` re-implements the 5-task list inline and leaves manager tasks **unassigned**, while `createChecklist` auto-assigns them — the two copies have already drifted | `hiring.ts:1892+` vs `hr-onboarding.ts: createChecklist` |
| F-R9 | C | **Joining formalities are advisory**: neither verified mandatory documents nor a cleared background check gate `markJoined` (benchmark gates employee creation on `required_for_employee_creation` tasks) | `hiring.ts: markJoined` preconditions |
| F-R10 | B | **Interview-invite email never sent**: `INTERVIEW_INVITE` is a reserved MailOutbox kind with no writer; candidates are never notified of a scheduled interview | `schema.prisma` L1078 vs hiring.ts (no writer) |
| F-R11 | C | **`{{startDate}}` never populated**: `createOfferRecord` renders letters without the start-date variable (renders empty) | `hiring.ts: createOfferRecord` LetterVars |
| F-R12 | B | **Non-transactional multi-row mutations in hiring**: `advanceStage` (two updates), `addCandidateStage` (sortOrder shift via `Promise.all`), `decideCandidate`, `sendOffer` (status flip before outbox write) | `hiring.ts` respective actions |
| F-R13 | B | **Static-vs-DB RBAC inconsistency**: `saveScorecard` and `getHiringPermissions` use raw `hasPermission()` (static floor only) while the rest of the module enforces via `requirePermission` (DB ceiling) — a DB-granted `hiring:manage` cannot authorize scorecard-on-behalf. **Addressed by F1.5**: `checkPermission` (DB-aware boolean probe) exported from auth-guard and used by both call sites; regression test pins the DB-grant authorization | `hiring.ts: saveScorecard/getHiringPermissions` |
| F-R14 | C | **Dead enum / dead constants**: attendance `IMPORT` source has no writer; `CANDIDATE_STATUSES`/`HIRING_STAGE_STATUSES` exported but unused (and omit SELECTED); schema comment for `Candidate.status` omits SELECTED (doc drift) | `hr-attendance.ts`, `validation.ts`, `schema.prisma` L990 |
| F-R15 | C | **Attendance grid honesty**: weekend/holiday shading is display-only — the server accepts marks on non-working days; grid capped at 500 members, no pagination. *Partially addressed by F1.4: the LOP derivation ignores marks on non-working days (the payroll-honest half); the server-side mark rejection remains deferred* | `hr-attendance.ts: upsertAttendanceRecord` |
| F-R16 | C | **Outbox email flow hand-rolled ×3**: QUEUED→send→resolve pattern duplicated inline in REJECTION/OFFER/WELCOME paths (only REJECTION routes the shared helper + duplicate guard) | `hiring.ts` |
| F-R17 | C | **HR module has zero mail side effects and cancel/acknowledge produce no notification at all** (in-app notifications only on request/decision paths) | `hr-leave.ts`, `hr-reviews.ts` |
| F-R18 | C | **Timezone naïveté in interview events** (server-local HH:MM) vs UTC-day duplicate guard | `hiring.ts: scheduleInterview` |
| F-R19 | C | **Positive finding worth keeping**: `findApprovedLeaveOn` already blocks time-logging on approved-leave days (a benchmark-style cross-module guard Fernly has and many clones forget) | `hr-shared.ts` + `time-entries.ts` |

**None of these changes an epic's shape** — they are folded in as tasks below.

---

## 7. Plan Status and Updated Sequencing

### 7.1 Phase 1 — Foundation status

| Epic | Status | Evidence / remaining work |
| --- | --- | --- |
| F1.1 Holiday calendar | **DONE** (`58b0fa7`, CI green at `0a8e8af`) | Model + working-day math + denormalization + seed + e2e (LOP denominator $319.05 pinned) |
| F1.2 Leave ledger | **DONE** (`89c0844`, first-commit-clean, CI green run 42217086646) | `LeaveLedgerEntry` (append-only: GRANT/CARRY/CONSUME/EXPIRE/ADJUST + `isReversal`, polymorphic sourceType/sourceId, migration `20261120000000_leave_ledger` + `down.sql`); `LeaveBalance` = derived cache re-synced by absolute set inside every ledger-writing transaction; QA-1 guard reads the ledger projection (Σ all deltas); approve → one CONSUME row, cancel → its reversal sibling (nets to zero); backfill writes GRANT/CARRY/CONSUME + drift-ADJUST rows (deterministic ids); pure `lib/leave-ledger.ts` 100% covered; seed mirrors production math (26 GRANT + 4 CONSUME/reversal rows; invariant `used == −ΣCONSUME` verified on the seeded DB); all existing leave e2e green unchanged — the epic's acceptance bar. **F-R4 folded in** (notice = working days, holiday-aware). Fixed on the way: the seed's Yuki `used=0` lie (a real invariant violation once the ledger exists) |
| F1.3 Attendance records | **DONE** (`5ef0dd1`, CI green) | 5 statuses, HR marking, ON_LEAVE derivation both directions, RBAC + self-service read, e2e loop pinned |
| F1.4 Attendance→LOP derivation | **DONE** (`534b2f4` epic + CI fixes `97ab3d6`/`c68e1c3`, CI green run 42206155692) | Pure `lib/lop-derivation.ts` (100% unit-covered: ABSENT=1, HALF_DAY=0.5, unpaid-leave days, leave-wins rule, working-day fractions incl. 0.5/0.25 on half-day holidays); wired into `createPayrollRun` + `addPayslip` with the LOP line materialized at creation; `lopSource AUTO\|MANUAL` with audited manual overrides in `updatePayslip`; migration `20261119000000_attendance_lop_derivation` (also fixes the latent `workingDays` Int lie); payslip modal provenance note + halves-capable input; seed derives the current-month run (Hana AUTO, Yuki MANUAL showcase keeping the $319.05 pin); e2e scenario derives "LOP 1.5d (auto)" from marked ABSENT+HALF_DAY days. **F-R15 fold-in:** the derivation-side guard IS in (non-working days never charge); the server-side mark rejection stays deferred (S-scope kept) |
| F1.5 Salary component catalog | **DONE** (`42c6d82`, first-commit-clean, CI green run 42340999260) | `SalaryComponent` master (code unique ↔ `OfferComponent.key`, label/kind/mode/defaultAmount/isActive/sortOrder) with `payroll:manage` CRUD (`payroll-components.ts` — duplicate code → friendly error naming the code, QA-18 convention); structure editor's "add from catalog" picker (active rows not already on the structure; amount editable — the catalog row is a suggestion); `createStructureFromOffer` maps offer lines through the catalog (canonical label/kind/mode per code, amount stays the offer's, unseen codes auto-registered with the offer's sighting) so the catalog converges on everything in use; migration `20261121000000_salary_component_catalog` + `down.sql` backfills from offer templates → structures → signed offers with `DISTINCT ON` dedup (codes repeat across bands — a bare NOT EXISTS cannot see same-statement rows) and deterministic `'bf-cat-<code>'` ids; snapshot discipline preserved (structures keep their JSON copies — catalog edits only change what the picker offers); 16 new tests incl. the acceptance roundtrip (catalog row → picker line → structure save → payslip earnings line) and the RBAC/CRUD/mapping/F-R1 transaction shapes. **F-R1 folded in** (retire+create one `$transaction` in both structure actions). **F-R13 folded in** (`checkPermission` DB-aware probe; `saveScorecard`/`getHiringPermissions` honor DB grants). Fixed on the way: the hr-leave overlap test's date-dependent window (a 2-day span at +7 is weekend-only on Saturday runs — the F1.1 no-working-days guard then fires ahead of the overlap check) |
| F1.6 Employment lifecycle | Not started | Verified absent; probation-review hard gate per decision §9.3 |

### 7.2 Recommended order (updated after F1.5 landed)

1. ~~**F1.4** (size S)~~ — **DONE** (`534b2f4`, CI green at `c68e1c3`). F-R15's fold-in was scoped down as planned: the payroll side ignores non-working-day marks; the attendance-form server guard (reject/mark-warn on non-working days) stays deferred.
2. ~~**F1.2** (size M)~~ — **DONE** (`89c0844`, first-commit-clean, CI green). The leave ledger refactor landed with F-R4 riding along (notice = working days); the leave-side transactional-writes discipline (the standing F-R2/F-R12 task) is now the house pattern for every ledger-writing action.
3. ~~**F1.5** (size M)~~ — **DONE** (`42c6d82`, first-commit-clean, CI green). The component catalog landed with F-R1 (transactional retire+create) and F-R13 (DB-aware `checkPermission` probe) riding along.
4. **F1.6** (size S) — employment lifecycle fields (`employmentStatus` + probation/notice/last-working-day, the probation-review hard gate). **Next up — closes Phase 1.**
5. Then Phase 2 as written (F2.1 offboarding/FnF … F2.9), with these **new fold-ins**: F-R5+F-R11 into F2.9 (offer approval/expiry work), F-R6+F-R10 into the hiring touchpoint of F2.9, F-R7+F-R8 into F2.1/F2.3's scope discussion (auto-structure-copy on join belongs with PayAdjustment/SSA thinking), F-R2+F-R12 as a standing "transactional writes" task inside the first epic that touches each action. ~~F-R13 as a one-line RBAC fix riding F1.5~~ — **DONE (rode F1.5)**.

### 7.3 Joining-module parity focus (the user-named third module)

The benchmark's offer→join chain gates and automates what Fernly currently leaves to HR memory. Concrete deltas, in the order they hurt:

1. **Offer expiry + approval** (F-R5, R11/D-20) — expired links must stop counting as "awaiting"; approval-before-send is a persona-audit-listed gap.
2. **Auto-provisioning on join** (F-R7) — copy the signed offer into a SalaryStructure inside `markJoined`'s transaction (or immediately after, with a visible "payroll-ready" flag) so no joiner is silently unpaid.
3. **Joining gating** (E5/R9) — make "all mandatory documents VERIFIED and (if any BGV exists) terminal" a configurable precondition of `markJoined`, mirroring the benchmark's `required_for_employee_creation`.
4. **Template unification** (F-R8) — one onboarding template source, assignable tasks, no inline copy.
5. **Interview-invite email** (F-R10) — the outbox kind already exists; compose-and-send on schedule/reschedule (and fix the orphaned events F-R6 at the same time).
6. **Appointment letter** (R12) — post-sign printable letter with the benchmark's placeholder discipline; the offer-sign page already proves the pattern.

---

## 8. Carried-Forward Decisions and Risks

All five locked product decisions from the plan's §9 (no member self-marking; payslips downloadable-only; probation-review hard gate; deduction slabs rejected pending ADR-015; earned-leave accrual per-type) remain in force — nothing in the current code or benchmark refresh contradicts them. The plan's risk register (ledger-migration risk, Float money, SQLite transaction scope, ADR-014 boundary creep, CI budget, scope gravity) is unchanged and re-endorsed.

Two additions from this reassessment:

- **Concurrency debt is the next silent risk class** (F-R1, F-R2, F-R12): the guarded-`updateMany` discipline that leave already has (QA-16) should become the house pattern for every status-flipping action the HR modules touch.
- **Funnel/analytics honesty** (F-R5): any metric that counts `SENT` offers must distinguish live vs expired links before Phase 2's appraisal/report epics multiply the pattern.

---

*Reference inventories used for the benchmark side (payroll/tax, HR domain, recruitment+performance at `1c28527`) were produced by scripted + manual deep reading of the hrms source; Fernly-side facts cite the files named in §4–§6. No claim in this document is invented; where a status is "not started" it was verified by absence in schema, migrations, and action code.*
