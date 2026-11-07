# Fernly Domain Modules Architecture Plan

**Four logic modules — HR · Admin · Account · Joining**

| | |
| --- | --- |
| Document | `docs/Fernly_Domain_Modules_Architecture_Plan.md` |
| Date | 2026-11-07 |
| Status | Architecture plan — the structural companion to `Fernly_HR_Payroll_Enhancement_Plan.md` (functional epics). Defines the four domain logic modules that will incorporate **every functionality present in Frappe HR**, and the migration track (M0–M4) that builds them without behavior change |
| Directive | "Plan to incorporate all functionalities present in Frappe HR for HR, Admin, Account and Joining modules. If possible create separate logic modules for each one of it to enhance modularity." (2026-11-07) |
| Fernly code state | `e40949e` (`origin/main`; Phase 1 of the enhancement plan complete, matrix landed) |
| Benchmark | Frappe HR (`frappe/hrms`) @ `88161025` — the 314-row inventory in `Fernly_HRMS_Feature_Parity_Matrix.md` is the functional source of truth this plan assigns module-by-module |
| Companion docs | `Fernly_HR_Payroll_Enhancement_Plan.md` (epics F1.x–F3.x), `Fernly_HRMS_Feature_Parity_Matrix.md` (row-level truth), `Fernly_HR_Payroll_Parity_Reassessment.md`, `ARCHITECTURE.md`, `CODING_STANDARDS.md`, `DECISIONS.md` (ADR-001…ADR-014) |

---

## 1. Purpose and Scope

Fernly's Frappe-parity effort has so far been organized by **epic** (F1.1–F1.6 landed; F2.1–F3.10 planned). This document adds the missing **structural** axis: the codebase will be reorganized into four domain logic modules, and every functionality the benchmark carries will be incorporated **through one of them**:

| Module | One-line charter | Benchmark rows owned (of 314) |
| --- | --- | --- |
| `src/modules/hr` | **People & time** — the employee from day one: lifecycle, leave, attendance & shifts, performance, grievance | 145 |
| `src/modules/admin` | **Governance & platform** — identity, roles, settings, audit, notifications, scheduler, reports/exports | 24 (+ the machinery under every other row) |
| `src/modules/account` | **Employment money** — payroll components/structures/runs/slips, adjustments, claims & advances, full-and-final | 93 |
| `src/modules/joining` | **Candidate → employee** — recruitment funnel, offers, joining formalities, onboarding checklists, appointment letters | 52 |

**What "logic module" means here.** Fernly is a single Next.js (App Router) application whose server-side business logic lives in `src/server-actions/**` (transport) and `src/lib/**` (kernels). A *logic module* is therefore a **server-only TypeScript package** under `src/modules/<name>/` with:

- a single **public API** (`index.ts`) — the only import path other modules and the app layer may use;
- its own **types, zod schemas, pure rules, services and repository code**, colocated with its tests;
- **explicit, lint-enforced dependencies** on lower layers only (§3.2).

It is emphatically **not** a microservice, a separate build, or a separate database: modules share one Prisma schema, one process, one CI pipeline (§3.4). The modularity payoff is single-home-per-domain code, enforceable boundaries, and a place where each Phase 2/3 epic lands without further crowding flat files.

**Non-goals of this plan.** No user-visible behavior change at any point; no navigation or permission renaming (the UI keeps its current "HR / Payroll / Hiring" areas — module names are code-organization names); no dashboard/chart framework, no mobile/PWA surface, no standalone roster app (enhancement-plan risk 7 stands); no schema split; no new infrastructure (ADR-008/ADR-014 boundaries unchanged).

---

## 2. Current State (verified at `e40949e`)

### 2.1 Where logic lives today

| Layer | Files | LOC (non-test) | Character |
| --- | --- | --- | --- |
| `src/server-actions/**` | 40 | 12,775 | All business orchestration, validation, Prisma access, audit/notification side-effects in `"use server"` files — flat by feature-file |
| `src/lib/**` | 42 | 6,912 | Pure domain kernels + cross-cutting infra; the only layer with real separation today |
| `src/components/views/**` + `ui/**` | 61 | 18,471 | Client logic (unchanged by this plan) |
| API routes `src/app/api/**` | 7 | — | Infra-only (auth/cron/health/metrics/client-errors); business transport is Server Actions |

### 2.2 The five structural problems this plan fixes

| # | Problem | Evidence at `e40949e` |
| --- | --- | --- |
| P1 | **The hiring monolith spans four domains.** | `server-actions/hiring.ts` — 2,030 LOC: recruitment pipeline + joining formalities/BGV + offers + `markJoined` (creates User, TeamMember, EmployeeProfile, checklist, WELCOME mail — i.e. Admin + HR + Joining + Account handoffs in one file) |
| P2 | **Flat cross-domain files.** | `lib/validation.ts` (770 LOC, ~85 schemas for all domains), `lib/types/index.ts` (624), `lib/config.ts` (335, status vocabularies of every domain), `lib/audit-meta.ts` (362) — every domain edited through the same four files |
| P3 | **No enforced boundaries.** | `eslint.config.mjs` has no import-restriction rules; anything may import anything. The only structural seam is the `server-actions/data.ts` barrel (150 LOC) |
| P4 | **Placement ambiguity.** | `hr-onboarding.ts` (348 LOC, post-hire checklists) lives in the HR console but is functionally the Joining arc; `lop-derivation.ts` is attendance math consumed by payroll; `createStructureFromOffer` (payroll.ts) reads OfferRecord — the offer→payroll seam is implicit |
| P5 | **Unowned legacy mass.** | ~2,589 LOC of workspace-PM actions (projects/tasks/bugs/messages/calendar/time) fit none of the four Frappe-derived modules and have no declared home |

### 2.3 The seam that already works

The `server-actions/data.ts` barrel proves the re-export discipline (and documents the constraint that a `"use server"` barrel cannot re-export — Turbopack strips re-exports from action modules). The pure kernels (`payroll-math`, `offer-math`, `leave-ledger`, `working-days`, `employment`, `hierarchy`, `lop-derivation`) are already dependency-free and tested — they move to module homes with zero logic change. The migration strategy (§8) is built on these two facts.

---

## 3. Target Architecture

### 3.1 Module map and layering

```
                        src/app/**                     src/components/**
                   (routes, offer page,               (views, modals —
                    cron routes, layout)                unchanged this track)
                              │                                  │
                              ▼                                  ▼
              ┌─────────────────────────────────────────────────────────┐
              │  TRANSPORT + COMPOSITION LAYER (app-level, thin)        │
              │  src/server-actions/**   "use server" wrappers:         │
              │    parse input → session ctx → toResult(module service) │
              │  composite reads: dashboard, analytics, pagination      │
              │  barrel: data.ts (unchanged import path for views)      │
              └───────┬───────────┬───────────┬───────────┬─────────────┘
                      ▼           ▼           ▼           ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
              │  L3      │ │  L3      │ │  L2      │ │  L1      │
              │ JOINING  │ │ ACCOUNT  │ │   HR     │ │  ADMIN   │
              │ candidate│ │ payroll  │ │ people & │ │ identity,│
              │ →employee│ │ & money  │ │   time   │ │ settings,│
              └────┬─────┘ └────┬─────┘ └────┬─────┘ │ audit,…  │
                   │            │            │       └────┬─────┘
                   │            └────► HR ◄──┼────────────┘
                   └─────────────────────────┘
              ┌─────────────────────────────────────────────────────────┐
              │  L0  src/modules/shared — kernel (no domain knowledge)  │
              │  db · auth/guards · result/errors · money · time ·      │
              │  observability · mail transport + outbox writer ·       │
              │  notify · calendar/reminder primitives · audit writer   │
              └─────────────────────────────────────────────────────────┘
```

### 3.2 Dependency rules (acyclic, lint-enforced in M0)

| Module (layer) | May import | May NOT import |
| --- | --- | --- |
| `shared` (L0) | nothing but node/platform | any domain module |
| `admin` (L1) | `shared` | `hr`, `account`, `joining` |
| `hr` (L2) | `shared`, `admin` | `account`, `joining` |
| `account` (L3) | `shared`, `admin`, `hr` | `joining` |
| `joining` (L3) | `shared`, `admin`, `hr`, `account` | — |
| transport/composition (`src/server-actions/**`, `src/app/**`) | any module's **public API only** (`@/modules/<m>`) | module internals (`@/modules/<m>/**` deep paths) |

Cross-module imports go through `index.ts` public APIs only, inside modules too. Rationale for the direction: *time facts flow down to money* (HR owns attendance/leave/holiday facts; Account derives LOP and encashment amounts from them), *the joining arc culminates in provisioning* (Joining calls Admin's identity service, HR's employee service, Account's structure service), and *Admin is machinery, not an aggregator* — cross-domain reads (dashboard, analytics, search) live in the composition layer, which may import everything, so no module ever imports upward.

### 3.3 The transport pattern (why action files stay forever)

Server Action files remain the RSC transport and **keep their current names and import paths** — views are untouched. After migration each action file is a thin wrapper:

```ts
// src/server-actions/hr-leave.ts — BEFORE (772 LOC of everything) → AFTER (~15 LOC/action)
"use server";
import { toResult } from "@/server-actions/result";
import { requireSession } from "@/modules/shared/auth";
import { hr } from "@/modules/hr";

export async function requestLeave(input: unknown) {
  return toResult(async () => hr.leave.request(input, { actor: await requireSession() }));
}
```

Wrappers — not re-export shims — because Turbopack strips re-exports from `"use server"` modules (the constraint documented in `data.ts`). The end state is *thin transport, fat modules*, with `data.ts` unchanged as the stable barrel views already import.

### 3.4 What deliberately stays outside the four modules

| Decision | Content | Reason |
| --- | --- | --- |
| **D-M1** | Workspace-PM legacy: `bugs`, `tasks`, `projects`, `messages`, `members`, `assignments`, `bulk`, `time-entries`, `events`, `reminders`, `mentions` actions + their views (~2,589 action LOC) | Fernly-original scope, absent from Frappe HR — no parity pull. Stays under current paths this track; a future `modules/workspace` track can absorb it once Phase 2 lands |
| **D-M2** | One unified `prisma/schema.prisma` (53 models, 28 migrations) | Prisma generates one client; module ownership of models is **logical** (each module's repo code touches only its models — §4 charters). Splitting schemas buys nothing at this scale |
| **D-M3** | Views/components (`src/components/**`) unchanged | They import actions by existing paths; module types reach them via public APIs when convenient, else the existing `lib/types` barrel keeps working |
| **D-M4** | Module names ≠ user-facing names | `account` = the Payroll module; `joining` = the Onboarding/Hiring module. Nav labels, permission keys (`payroll:manage`, `hiring:view`, …), and view names stay exactly as they are |
| **D-M5** | Cross-domain read surfaces stay compositional | `dashboard.ts`, `analytics.ts`, `search.ts`, `pagination.ts` import several modules' public APIs by design; they are app-level composition, not admin-owned aggregation |

---

## 4. Module Charters

Each charter states: mission · benchmark rows owned · Prisma models (logical owner) · current files that migrate in · public API sketch · the functional epics that will land inside it · owned declinations. Row assignments follow §5 exactly.

### 4.1 `src/modules/hr` — people & time (145 rows)

**Mission.** Everything about the employee from day one: the employment state machine, leave & holidays, attendance & shifts, performance & training, grievance. HR owns **time facts**: `workingDaysBetween()`, leave balances, attendance days, LOP-day derivation — which Account converts into money.

**Benchmark rows.** `LV` (47), `AT` (36), `PF` (21), `EM` minus 16 exceptions (39), `EX-06` grievance (1), `PL-08` roster (1). Coverage at `e40949e`: **9 Parity · 39 Partial · 85 Missing · 12 Out of scope**.

**Models (logical owner).** `EmployeeProfile`, `LeaveType`, `LeavePolicy`, `LeaveRequest`, `LeaveBalance`, `LeaveLedgerEntry`, `HolidayCalendarEntry`, `AttendanceRecord`, `PerformanceReview` — future: `EmploymentChange` (F2.5), `AppraisalCycle`/`Kra`/`Goal` (F2.7), `ShiftType`/`ShiftAssignment` (F3.5), `TrainingEvent` family (F3.7), `Grievance` (F3.8).

**Migrates in (M1).** Actions: `hr-leave` (772), `hr-attendance` (267), `hr-directory` (264), `hr-reviews` (408), `hr-holidays` (165), `employment` (184), `hr-shared` (491). Kernels → `rules/`: `leave-ledger`, `working-days`, `employment`, `hierarchy`, `lop-derivation`. Slices of `validation.ts`/`config.ts`/`types` → `schemas.ts`/`status.ts`/`types.ts`.

**Public API sketch.**

```ts
// src/modules/hr/index.ts
export { workingDaysBetween, countLeaveDays, deriveLopDays } from "./rules";
export { transitionEmployment, getEmploymentHistory } from "./services/employment";
export { requestLeave, decideLeaveRequest, cancelLeave, getLeaveQueue } from "./services/leave";
export { upsertAttendance, getAttendanceMonth, getMyAttendance } from "./services/attendance";
export { listHolidays, upsertHoliday, deleteHoliday } from "./services/holidays";
export { upsertProfile, getDirectory, getOrgChart } from "./services/directory";
export { createReview, submitReview, decideReview, acknowledgeReview } from "./services/reviews";
export type { LeaveRequestView, AttendanceDay, EmploymentStatus, DirectoryEntry } from "./types";
```

**Epics landing inside hr.** F2.1 (separation checklist + exit-interview half), F2.2 (request/approval/ledger half), F2.4, F2.5, F2.7, F2.9 (half-day semantics half), F3.5, F3.7, F3.8, F3.10 (data source: hireDate/birthday facts).

**Owned declinations.** Member self-marking of attendance (locked decision §9.1); device check-in/geo-fencing; goal roll-up trees (flat by design, PF-B04); free-form score formulas (PF-B07).

### 4.2 `src/modules/admin` — governance & platform (24 rows + the machinery)

**Mission.** The machinery every other module runs on: identity & access administration, workspace settings and DB-backed config tables, audit read/retention, the notification center, the scheduler (cron route) framework, report/export delivery, privacy tooling. Admin owns **no domain semantics** — leave policy lives in hr, component catalog in account; admin owns the *framework* they configure.

**Benchmark rows.** `PL` minus `PL-08`/`PL-13` (20), `EM-23` HR Settings, `EM-24` telemetry (declined), `EM-25` PWA store (declined), `PR-32` Payroll Settings. Coverage: **4 Parity · 13 Partial · 3 Missing · 4 Out of scope**.

**Models (logical owner).** `User`, `UserSettings`, `PasswordResetToken`, `Workspace`, `Role`, `Permission`, `RolePermission`, the six `*Config` tables, `AuditLog`. (Better Auth's `Session`/`Account`/`Verification` are owned by `shared/auth`; cross-cutting `Notification`, `CalendarEvent`, `Reminder`, `MailOutbox` are owned by `shared` primitives — admin builds read/admin surfaces over them.)

**Migrates in (M4).** Actions: `users` (743), `workspace` (329), `trash` (315), `password-reset` (289), `data-export` (161), `audit` (95), `audit-retention` (73), `auth-tokens` (69), `notifications` (51), `search` (138), `ics-export` (125). Libs: `config-loader` (469), `audit-meta` (362), `audit-prune-core`, `audit-retention-config`, `maintenance-lock`. Cron route `/api/cron/prune-audit` stays in `src/app/api/cron/**` and calls `admin.scheduler` — the same pattern every future job rides (F2.4, F3.10).

**Public API sketch.**

```ts
// src/modules/admin/index.ts
export { provisionUser, listUsers, updateUser, softDeleteUser, eraseUser } from "./services/users";
export { loadWorkspaceConfig, updateSettings, upsertConfigItem, updateRole } from "./services/config";
export { readAuditLog, readEntityHistory, pruneAudit } from "./services/audit";
export { markNotificationRead, markAllRead, listNotifications } from "./services/notifications";
export { exportMyData, exportReportCsv } from "./services/export";
export { runScheduledJobs } from "./scheduler";
export type { WorkspaceConfig, AuditEvent, UserSummary } from "./types";
```

`provisionUser()` is the API Joining's `markJoined` calls to create User + TeamMember inside its provisioning transaction (fixing P1's hidden cross-domain write).

**Epics landing inside admin.** F3.9 (report/export framework — content provided by domain modules), F3.10 (engagement-reminder engine + scheduler), the notification/outbox framework halves of F2.10 (interview-invite email) and F2.6 (PDF/CSV delivery plumbing).

**Owned declinations.** PWA/mobile API + push (PL-06/07); telemetry (PL-15); regional packs (PL-14); dashboard/chart framework and number-card framework (risk 7 — analytics-view and per-view cards only).

### 4.3 `src/modules/account` — employment money (93 rows)

**Mission.** Every amount tied to employment: the component catalog, salary structures and their history, payroll runs, payslips, LOP conversion (consuming hr's time facts), the universal PayAdjustment adapter, encashment/advance/claim payouts, and the full-and-final statement. Account owns **money math**; it never writes attendance or leave rows.

**Benchmark rows.** `PR` minus `PR-32` (71), `EX-01…05` + `EX-B01…07` minus grievance (18), `EM-16` + `EM-B12/B13/B14` (4). Coverage: **3 Parity · 20 Partial · 49 Missing · 21 Out of scope**.

**Models (logical owner).** `SalaryComponent`, `SalaryStructure`, `PayrollRun`, `Payslip` — future: `PayAdjustment` (F2.3), `ExpenseClaim` + `EmployeeAdvance` (F2.8), `FullAndFinalStatement` (F2.1), `LeaveEncashmentRequest` payout side (F2.2), `GratuityRule` (F3.3).

**Migrates in (M2).** Actions: `payroll` (782 — split into structures/runs/slips services), `payroll-components` (167). Kernel → `rules/payroll-math` (113). Slices of `validation.ts`/`config.ts`/`types`. The offer→structure seam becomes an **explicit joining→account API call**: `account.structures.createFromOffer(offerRecordId)` invoked by Joining's provisioning (F-R7's fix lands against this interface).

**Public API sketch.**

```ts
// src/modules/account/index.ts
export { computePayslipLines, projectYtd, round2 } from "./rules";
export { listComponents, upsertComponent, deactivateComponent } from "./services/components";
export { upsertStructure, createStructureFromOffer, retireStructure } from "./services/structures";
export { createRun, lockRun, addPayslip, overrideLop, listRuns } from "./services/runs";
export { getMyPayslips, getPayslip } from "./services/slips";
export { importAdjustments } from "./services/adjustments";   // F2.3
export { computeFullAndFinal } from "./services/fnf";          // F2.1
export type { PayslipView, SalaryStructureView, PayAdjustment } from "./types";
```

**Epics landing inside account.** F2.1 (FnF statement half), F2.2 (payout half), F2.3, F2.6, F2.8, F3.1, F3.2, F3.3.

**Owned declinations.** Double-entry GL/JEs/cost centers (PR-B15, ADR-014); statutory engines (PR-24…29, PR-B18); loan repayment merge (PR-07/B17); payslip email delivery (locked decision §9.2 — download only); five payroll frequencies beyond monthly (PR-B05).

### 4.4 `src/modules/joining` — candidate → employee (52 rows)

**Mission.** The whole entry arc: recruitment pipeline (stages, scorecards, interviews), offers (templates, records, signing), joining formalities (documents, background checks), the onboarding checklist/template machinery, the appointment letter, and the `markJoined` provisioning transaction that hands off to Admin (user), HR (employee profile), and Account (salary structure). Joining owns **everything before day one**; HR owns everything after.

**Benchmark rows.** `RJ` (42), `EM-11/12/13` + `EM-B05…B09` (onboarding arc, 9), `EM-17` referral (1), `PL-13` job-application web form (1). Coverage: **15 Parity · 12 Partial · 24 Missing · 1 Beyond benchmark** — the strongest module today (Fernly's hiring module is the parity leader), which is why its structural split (M3) is also the most delicate.

**Models (logical owner).** `HiringStageConfig`, `Candidate`, `CandidateStage`, `DocumentTypeConfig`, `CandidateDocument`, `BackgroundCheck`, `OfferTemplate`, `OfferRecord`, `OnboardingChecklist`, `OnboardingTask`.

**Migrates in (M3).** The `hiring.ts` monolith (2,030 LOC) splits into: `services/pipeline.ts` (candidates/stages/scorecards/interviews), `services/formalities.ts` (documents/BGV/config), `services/offers.ts` (templates/records/send/sign/decline), `services/provisioning.ts` (`markJoined` — now calling `admin.provisionUser`, `hr.directory.createEmployeeProfile`, `account.structures.createFromOffer`), `services/funnel.ts` (analytics). Plus `hr-onboarding.ts` (348 — the boundary flip of P4), `offer-math.ts` → `rules/`, `hiring-email.ts` → `templates/`. The public offer-sign page (`src/app/offer/[token]`) stays a route, calling `joining.offers` public API.

**Public API sketch.**

```ts
// src/modules/joining/index.ts
export { computeOfferTotals, renderLetter } from "./rules";
export { listCandidates, createCandidate, moveStage, saveScorecard, scheduleInterview } from "./services/pipeline";
export { listDocumentTypes, requestDocument, verifyDocument, initiateBgCheck } from "./services/formalities";
export { draftOffer, approveOffer, sendOffer, signOffer, declineOffer } from "./services/offers";
export { createChecklistFromTemplate, completeTask, myOnboardingTasks } from "./services/onboarding";
export { markJoined } from "./services/provisioning";
export type { CandidateView, OfferView, OnboardingChecklistView } from "./types";
```

**Epics landing inside joining.** F2.10 (all seven items), F3.6 (public job openings + requisitions — the public route rides the `/offer/[token]` precedent), F2.9 (interview round templates half).

**Owned declinations.** Multi-company staffing roll-ups (RJ-02); applicant-country analytics (RJ-C07); referral-bonus accounting rides Account's PayAdjustment, not a joining-side ledger.

---

## 5. Complete Functionality Assignment (all 314 matrix rows)

**Method.** Each matrix row's domain prefix implies a default module; **20 rows override the default** (they are functionalities whose benchmark domain differs from the module that must own them in Fernly's structure). The assignment is total: every row maps to exactly one module or to an explicit declination owner. Reproduce the counts with `python3 scripts/module_rollup.py` (Appendix B).

| Domain (matrix §) | Rows | Default module |
| --- | --- | --- |
| `PR` Payroll (§2) | 72 | `account` |
| `LV` Leave & holidays (§3) | 47 | `hr` |
| `AT` Attendance & shifts (§4) | 36 | `hr` |
| `EM` Employee lifecycle (§5) | 55 | `hr` |
| `RJ` Recruitment & joining (§6) | 42 | `joining` |
| `PF` Performance & training (§7) | 21 | `hr` |
| `EX` Expenses, travel & grievance (§8) | 19 | `account` |
| `PL` Platform surfaces (§9) | 22 | `admin` |

**Row-level exceptions (20).**

| Row(s) | Benchmark feature | Assigned to | Why |
| --- | --- | --- | --- |
| `EM-11`, `EM-12`, `EM-13` | Employee Onboarding + Template + creation gate | `joining` | The onboarding arc is the Joining module's charter (P4 boundary flip) |
| `EM-B05`–`EM-B09` | Onboarding task dates / assignee XOR / boarding status / creation gate / applicant back-flip | `joining` | Same arc — behaviors of the checklist machinery |
| `EM-17` | Employee Referral | `joining` | Feeds candidates into the funnel; its bonus payout rides Account's PayAdjustment |
| `EM-16`, `EM-B12`, `EM-B13`, `EM-B14` | Full and Final Statement + assemble/settlement rows | `account` | Money computation and settlement flags are Account's charter (F2.1's account half) |
| `EM-23`, `EM-24`, `EM-25` | HR Settings / telemetry / PWA store | `admin` | Platform singles — settings framework and declination ownership |
| `PR-32` | Payroll Settings (single) | `admin` | The settings *framework* is Admin's; the switches' semantics stay documented in account's charter |
| `EX-06` | Employee Grievance | `hr` | A people process, not money — the one `EX` row that is not employment-money |
| `PL-08` | Roster app + roster API | `hr` | Shift planning is the `AT` domain (F3.5) |
| `PL-13` | `job_application` web form | `joining` | Public recruitment intake (F3.6) |

**Module rollup (all 314 rows).**

| Module | Parity | Partial | Missing | Out of scope | Beyond | Total |
| --- | --- | --- | --- | --- | --- | --- |
| `hr` | 9 | 39 | 85 | 12 | 0 | **145** |
| `admin` | 4 | 13 | 3 | 4 | 0 | **24** |
| `account` | 3 | 20 | 49 | 21 | 0 | **93** |
| `joining` | 15 | 12 | 24 | 0 | 1 | **52** |
| **Total** | **31** | **84** | **161** | **37** | **1** | **314** |

Sanity-checked against the matrix §10 rollup (PASS). The Missing concentration confirms the enhancement plan's sequencing: `hr` carries the widest gap (shifts, encashment/earned-leave, promotion/transfer, appraisal cycles), `account` the deepest (adjustments, arrears, benefits, exports), `joining` the cheapest-to-harden (24 Missing rows, most already epic-owned by F2.10).

**Epics that span modules** (by design — the epic stays one delivery unit, code lands in each module):

| Epic | hr | account | joining | admin |
| --- | --- | --- | --- | --- |
| F2.1 Offboarding & FnF | separation checklist, exit interview | FnF statement, settlement gate | — | audit surfaces |
| F2.2 Leave encashment | request, approval, ledger CONSUME | payout math, PayAdjustment | — | — |
| F2.8 Expense claims & advances | — | claims, advances, deductions | — | notification center |
| F2.10 Joining hardening | — | `createFromOffer` API | expiry/approval/gate/templates/letters/invite | outbox framework |
| F3.9 Report suite | content providers | content providers | content providers | export framework |
| F3.10 Engagement reminders | hireDate/birthday facts | — | — | reminder engine, scheduler |

---

## 6. Module Contracts and Conventions

### 6.1 Anatomy of a module

```
src/modules/<name>/
  index.ts          # public API — types + service entry points; THE import surface
  types.ts          # DTOs (plain types; no Prisma-generated types leak out)
  schemas.ts        # zod schemas split from lib/validation.ts by domain
  status.ts         # status vocabularies + transition maps split from lib/config.ts
  rules/            # pure functions (no Prisma, no session) — the old lib kernels
  services/         # orchestration: validate → guard → transact → audit → notify
  repo.ts           # the module's Prisma access (touches only its own models)
  scheduler.ts      # cron-invoked entry points (admin; hr/account if ever needed)
  __tests__/        # tests colocated, moving with the code
```

### 6.2 Conventions every module inherits (unchanged house style)

1. **ActionResult at the transport edge only** — services throw typed errors (`action-errors.ts` taxonomy, moved to `shared`); wrappers convert via `toResult()`.
2. **`input: unknown` + zod parse at the service entry** — `parseOrThrow()` discipline, schemas owned per module.
3. **Permission gate first** — `requirePermission` / `requirePermissionForTarget` (from `shared/auth`) before any read of other users' data; the RBAC floor matrix (`rbac.ts`, 33 permissions) moves to `shared/auth`; Role/Permission *administration* stays in `admin`.
4. **Audit via the shared writer** — `logAudit()` (from `shared`) with action strings; display metadata (`audit-meta`) stays in `admin` as the audit-view owner.
5. **Money stays `Float` + `round2`** (risk 2 of the enhancement plan; a Decimal migration is its own future epic, not this track's business).
6. **Statuses stay plain strings + TS literal unions** (house style: no Prisma enums; DB-editable vocabularies stay `*Config` tables owned by admin).
7. **Transactions** — Prisma interactive transactions in services; savepoint-per-item in every bulk flow (enhancement plan §7.0).
8. **No `"use server"` inside modules** — the directive lives only in `src/server-actions/**` wrappers (Turbopack constraint, §3.3).

### 6.3 One vertical slice, end to end (the pattern M1–M4 repeats)

```ts
// transport — src/server-actions/hr-leave.ts ("use server", thin, forever)
export async function requestLeave(input: unknown) {
  return toResult(async () => hr.leave.request(input, { actor: await requireSession() }));
}

// public API — src/modules/hr/index.ts
export { requestLeave, decideLeaveRequest } from "./services/leave";
export { workingDaysBetween } from "./rules";

// service — src/modules/hr/services/leave.ts (no directive)
export async function request(input: unknown, ctx: ServiceCtx): Promise<LeaveRequestView> {
  const cmd = LeaveRequestSchema.parse(input);
  await ctx.auth.requirePermission("leave:request");
  const days = countLeaveDays(cmd.range, await ctx.repos.holidays(cmd.range)); // rules
  assertWithinBalance(cmd, await repo.balanceFor(cmd.userId, cmd.year));        // rules
  return repo.insertRequest(cmd, days, ctx.actor);                              // repo + audit
}
```

The existing 106 unit-test files and 111 e2e scenarios are the characterization suite that proves each migration epic changed nothing.

---

## 7. Boundary Enforcement

### 7.1 ESLint fences (land in M0, before any code moves)

Zero new dependencies — core `no-restricted-imports` with per-module overrides in `eslint.config.mjs`:

```js
// Module boundary fences — Fernly_Domain_Modules_Architecture_Plan.md §7.1
// Layering: shared(L0) ← admin(L1) ← hr(L2) ← account/joining(L3)
{ files: ["src/modules/shared/**"], rules: { "no-restricted-imports": ["error", { patterns: [
    { group: ["@/modules/admin", "@/modules/admin/**", "@/modules/hr", "@/modules/hr/**",
              "@/modules/account", "@/modules/account/**", "@/modules/joining", "@/modules/joining/**"],
      message: "shared is L0 — it must not depend on any domain module" } ] }] } },
{ files: ["src/modules/admin/**"], rules: { /* forbids @/modules/{hr,account,joining}(/**) */ } },
{ files: ["src/modules/hr/**"], rules: { /* forbids @/modules/{account,joining}(/**)  + deep imports of shared/admin */ } },
{ files: ["src/modules/account/**"], rules: { /* forbids @/modules/joining(/**)       + deep imports of shared/admin/hr */ } },
{ files: ["src/modules/joining/**"], rules: { /* forbids deep imports of shared/admin/hr/account — public APIs only */ } },
// Everyone outside a module imports public APIs only:
{ files: ["src/app/**", "src/server-actions/**", "src/components/**", "src/lib/**",
          "src/config/**", "src/hooks/**", "src/store/**"],
  rules: { "no-restricted-imports": ["error", { patterns: [
    { group: ["@/modules/*/**"], message: "Import the public API only: @/modules/<name>" } ] }] } },
```

Each fence bans both the public path and the deep paths of forbidden modules, so neither a shortcut nor an accidental deep import can erode the layering. `bun run lint` (already in CI `verify` and the pre-commit hook) becomes the boundary gate.

### 7.2 Coverage gates follow the code

`vitest.config.ts` gains the modules as a gated area from M0 on, so thresholds can never dip during the strangler:

```ts
coverage: {
  include: ["src/lib/**", "src/server-actions/**", "src/modules/**"],
  exclude: ["src/lib/types/**", "src/modules/*/types.ts"],
  thresholds: {
    "src/lib/**":           { statements: 90, branches: 80, functions: 85, lines: 90 },
    "src/server-actions/**": { statements: 90, branches: 80, functions: 85, lines: 90 },
    "src/modules/**":        { statements: 90, branches: 80, functions: 85, lines: 90 },
  },
}
```

Thin wrappers naturally sit near 100% (they are covered by the service tests' call paths plus the moved tests). The full existing gates on `src/lib/**` / `src/server-actions/**` stay until M4's exit review, then shrink to the paths that remain.

---

## 8. Migration Track (M0–M4) — structural epics

House pipeline for every M-epic, identical to the F-epics: plan → review → single commit → push → CI green. **Hard rule: an M-commit may not change behavior** — no schema changes, no new translations of business rules, no UI edits. Suites green before and after is the acceptance bar.

| Epic | Scope | Moves (see Appendix A) | Size | Risk |
| --- | --- | --- | --- | --- |
| **M0 Scaffold & fences** | Create the five module skeletons (`index.ts`, `types.ts` stubs, README charter), ESLint fences (§7.1), vitest include/thresholds (§7.2). Zero logic moves — CI proves the fences compile clean against the untouched codebase | none | **S** | trivial |
| **M1 HR module** | Extract hr: five kernels → `hr/rules`; seven action files → `hr/services/*`; hr slices of validation/config/types; action files become thin wrappers; tests move with code | 2,551 action LOC + kernels | **M** | low — kernels already pure; `hr-shared.ts` split is the only real surgery |
| **M2 Account module** | Extract account: `payroll-math` → `rules`; `payroll.ts` split into structures/runs/slips services; `payroll-components`; the `createStructureFromOffer` seam becomes the explicit joining→account API (still called from joining's action today — the wrapper keeps working until M3) | 949 action LOC + kernel | **M** | low-medium — run locking and LOP derivation are load-bearing; existing payroll tests + e2e hold |
| **M3 Joining module** | **Split the `hiring.ts` monolith** into pipeline / formalities / offers / provisioning / funnel services; `hr-onboarding.ts` and `offer-math`/`hiring-email` move in; `markJoined` becomes an explicit orchestration over `admin.provisionUser` + `hr` + `account` public APIs | 2,378 action LOC + kernels | **L** | the epic to be careful with — 38 exports, provisioning transaction, public offer-sign page; `hiring.test.ts` + `hiring.feature`/`my-interviews.feature` e2e are the net |
| **M4 Admin module** | Extract admin: users/workspace/trash/password-reset/data-export/audit/retention/tokens/notifications/search/ics + config-loader/audit-meta; composite reads (dashboard/analytics/pagination) rewritten as composition-layer imports of module public APIs; coverage gates consolidated | 2,388 action LOC + libs | **M** | low-medium — mostly mechanical; the composition rewrite must keep `analytics`' authorization matrix intact |

**Exit criteria, every M-epic:** (1) `bun run lint` + fences green; (2) `bun run typecheck` green; (3) full vitest suite green **with the new `src/modules/**` threshold held**; (4) e2e suite green; (5) `rg "@/server-actions/(hr-|payroll|hiring)" src/components` unchanged — no view imports touched; (6) the moved files' old paths still export the same names (transport wrappers), so `data.ts` and every direct import keep working.

**Sequencing rationale (§9):** M0 lands immediately (it is a pure fence); M1–M2 land **before F2.1** so the next functional epic is written directly against fresh module homes; M3 lands **before F2.10** (the joining-hardening epic, ~24 Missing rows); M4 lands before the Phase 3 surfaces that live in admin (F3.9/F3.10).

---

## 9. Sequencing with the Functional Epics

```
2026-11-07 →  M0 fences        (S — immediate, no logic moves)
              M1 hr module     (M)
              M2 account       (M)
              F2.1 offboarding & FnF lite        ← lands in hr + account module homes
              M3 joining       (L — the hiring.ts split)
              F2.10 joining hardening            ← lands in the fresh joining module
              F2.2 → F2.3 → F2.4 → F2.5 → F2.6 → F2.7 → F2.8 → F2.9   (each lands in its module)
              M4 admin         (M)
              F3.1 … F3.10     (Phase 3 breadth, all inside modules)
```

M-epics add no coverage rows — the matrix's 314 statuses are untouched by structural work; every status change still comes from an F-epic. The full epic texts, dependencies, and acceptance criteria remain in `Fernly_HR_Payroll_Enhancement_Plan.md` §7; §7.5 of that document now carries the M-track summary.

---

## 10. Risks and Mitigations

| # | Risk | Mitigation |
| --- | --- | --- |
| R-M1 | **Strangler drift** — during M1–M4, logic exists half in modules, half in actions, and a hotfix lands in the wrong place | M-epics are consecutive, not interleaved with F-epics (except F2.1 after M2 by design); the exit criteria forbid leaving an action file half-extracted |
| R-M2 | **The `hiring.ts` split regresses the provisioning transaction** (User + TeamMember + EmployeeProfile + checklist + candidate→HIRED + WELCOME outbox in one transaction) | Split in one commit only after the seam calls (`provisionUser`, `createFromOffer`) exist and are unit-tested; the transaction boundary stays inside `services/provisioning.ts`; e2e `hiring.feature` is the gate |
| R-M3 | **Coverage-gate gap** during transition (old paths thin out, new paths not yet at threshold) | `src/modules/**` gated from M0 (§7.2); old gates stay until M4; moved tests count for the new path immediately |
| R-M4 | **Boundary erosion over time** ("just this once" deep imports) | Fences are ERROR-level in CI + pre-commit; charter §4 makes ownership disputes resolvable by document, not memory |
| R-M5 | **Module = accidental god-object** (hr accumulating everything) | The 20-row exception table (§5) is the firewall: onboarding-arc rows belong to joining, money rows to account; new features must cite a charter section before landing |
| R-M6 | **Workspace legacy drifts** (P5 mass left unowned) | D-M1 parks it explicitly with a revisit trigger (after Phase 2); until then it stays lint-clean and covered by existing gates |
| R-M7 | **Over-modularization temptation** — events buses, repository interfaces, DI containers | §6 fixes the contract set: plain functions, ctx parameter, shared kernel services. Anything beyond that needs an ADR |

---

## Appendix A — File-move map (current → target)

### A.1 Server actions (12,775 LOC total)

| Current (`src/server-actions/`) | LOC | Target | M-epic |
| --- | --- | --- | --- |
| `hr-leave.ts` | 772 | wrapper + `modules/hr/services/leave.ts` | M1 |
| `hr-attendance.ts` | 267 | wrapper + `modules/hr/services/attendance.ts` | M1 |
| `hr-directory.ts` | 264 | wrapper + `modules/hr/services/directory.ts` | M1 |
| `hr-reviews.ts` | 408 | wrapper + `modules/hr/services/reviews.ts` | M1 |
| `hr-holidays.ts` | 165 | wrapper + `modules/hr/services/holidays.ts` | M1 |
| `employment.ts` | 184 | wrapper + `modules/hr/services/employment.ts` | M1 |
| `hr-shared.ts` | 491 | split into `modules/hr/rules/` + `services/_context.ts` | M1 |
| `payroll.ts` | 782 | wrappers + `modules/account/services/{structures,runs,slips}.ts` | M2 |
| `payroll-components.ts` | 167 | wrapper + `modules/account/services/components.ts` | M2 |
| `hiring.ts` | 2,030 | wrappers + `modules/joining/services/{pipeline,formalities,offers,provisioning,funnel}.ts` | M3 |
| `hr-onboarding.ts` | 348 | wrapper + `modules/joining/services/onboarding.ts` | M3 |
| `users.ts` | 743 | wrapper + `modules/admin/services/users.ts` | M4 |
| `workspace.ts` | 329 | wrapper + `modules/admin/services/config.ts` | M4 |
| `trash.ts` | 315 | wrapper + `modules/admin/services/privacy.ts` | M4 |
| `password-reset.ts` | 289 | wrapper + `modules/admin/services/password-reset.ts` | M4 |
| `data-export.ts` | 161 | wrapper + `modules/admin/services/export.ts` | M4 |
| `audit.ts` / `audit-retention.ts` | 95 / 73 | wrappers + `modules/admin/services/audit.ts` | M4 |
| `auth-tokens.ts` | 69 | wrapper + `modules/admin/services/tokens.ts` | M4 |
| `notifications.ts` | 51 | wrapper + `modules/admin/services/notifications.ts` | M4 |
| `search.ts` / `ics-export.ts` | 138 / 125 | wrappers + `modules/admin/services/{search,export}.ts` | M4 |
| `shared.ts` / `result.ts` / `auth-guard.ts` | 433 / 46 / 167 | `modules/shared/{audit, result, auth}/` | M1 (first movers) |
| `dashboard.ts` / `analytics.ts` / `pagination.ts` | 532 / 193 / 399 | stay in composition layer, rewritten over module public APIs | M4 |
| `data.ts` | 150 | unchanged (transport barrel) | — |
| `bugs`, `tasks`, `projects`, `messages`, `members`, `assignments`, `bulk`, `time-entries`, `events`, `reminders`, `mentions` | 2,589 | unchanged — workspace legacy (D-M1) | — |

### A.2 Lib kernels (selected; the rest of `src/lib` infra moves to `modules/shared` in M1/M4)

| Current (`src/lib/`) | LOC | Target |
| --- | --- | --- |
| `leave-ledger.ts`, `working-days.ts`, `employment.ts`, `hierarchy.ts`, `lop-derivation.ts` | 564 | `modules/hr/rules/` (M1) |
| `payroll-math.ts` | 113 | `modules/account/rules/` (M2) |
| `offer-math.ts`, `hiring-email.ts` | 214 | `modules/joining/{rules,templates}/` (M3) |
| `rbac.ts`, `auth-better.ts`, `jwt.ts`, `password.ts`, `breach-check.ts`, `db.ts`, `action-result.ts`, `action-errors.ts`, `mailer.ts`, `observability.ts`, `time.ts` | ~2,000 | `modules/shared/` (M1/M4) |
| `config-loader.ts`, `audit-meta.ts`, `audit-prune-core.ts`, `maintenance-lock.ts` | ~1,050 | `modules/admin/` (M4) |
| `validation.ts` (770), `config.ts` (335), `types/index.ts` (624) | 1,729 | split by domain into each module's `schemas.ts` / `status.ts` / `types.ts` (M1–M4); the barrels keep re-exporting during transition |

### A.3 Model ownership (53 models, logical)

`hr` (9): EmployeeProfile, LeaveType, LeavePolicy, LeaveRequest, LeaveBalance, LeaveLedgerEntry, HolidayCalendarEntry, AttendanceRecord, PerformanceReview · `account` (4): SalaryComponent, SalaryStructure, PayrollRun, Payslip · `joining` (10): HiringStageConfig, Candidate, CandidateStage, DocumentTypeConfig, CandidateDocument, BackgroundCheck, OfferTemplate, OfferRecord, OnboardingChecklist, OnboardingTask · `admin` (14): User, UserSettings, PasswordResetToken, Workspace, Role, Permission, RolePermission, TaskStatusConfig, ProjectStatusConfig, EventTypeConfig, TaskTagConfig, PriorityConfig, DepartmentConfig, AuditLog · `shared` (7): Session, Account, Verification (auth), Notification, CalendarEvent, Reminder, MailOutbox (primitives) · workspace legacy (9): Project, Task, TeamMember, TimeEntry, Message, MessageRead, ProjectAssignment, Bug, BugComment.

## Appendix B — Reproducing the §5 rollup

```bash
python3 scripts/module_rollup.py            # prints the module × status table
python3 scripts/module_rollup.py docs/Fernly_HRMS_Feature_Parity_Matrix.md
```

The script parses every matrix table row (`| XX-… |`), classifies the status cell (Parity / Partial / Missing / Out of scope / Beyond), applies the §5 default + 20-exception mapping, and sanity-checks the totals against the matrix §10 rollup (31 / 84 / 161 / 37 / 1 — currently PASS). Rerun it whenever the matrix gains rows; update the exception table here and in the script together.

---

*Every Fernly fact above was verified against the working tree at `e40949e` (file list, LOC via `wc -l`, eslint/vitest/CI configs read in full); every benchmark fact comes from `Fernly_HRMS_Feature_Parity_Matrix.md` @ `88161025`, whose §10 totals this plan's rollup reproduces exactly. The M-track changes no matrix status — only where the code that will change them lives.*
