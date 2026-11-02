# HR Module — Implementation Plan

**Date:** 2026-11-02 · **Status:** DELIVERED (all four features) · **Owner:** Fernly workspace

> **Delivery record** — every feature below shipped through the full pipeline
> (plan → review → dev → BDD → unit + automation suites → complete e2e →
> review → commit → push):
>
> | Feature | Commit |
> |---|---|
> | F1 — Foundation + leave management | `18db279` |
> | F2 — Employee directory | `b2bf437` |
> | F3 — Performance reviews | `10f789f` |
> | F4 — Onboarding | `f9529ca` |
>
> Verified green on the full suite: 1009 unit tests (+ coverage gates), 49
> e2e scenarios / 345 steps, lint + typecheck clean.

This plan follows the repo's per-feature pipeline: **Plan → Review plan → development →
BDD test cases → update/create test suite → automation test suite → run complete e2e →
review → fixes → commit → push** (see docs/TESTING.md). Each feature ships as one
conventional commit after a green local suite; CI (verify + build + e2e on Postgres)
is the final gate.

---

## 1. Scoping decisions (user-confirmed)

| Question | Decision |
|---|---|
| Features in scope | **Leave management, Employee directory, Performance reviews, Onboarding** (all four) |
| RBAC model | **New `HR` role** — HR permissions only, on top of MEMBER baseline |
| Leave approval | **Single approver** — the employee's manager (`User.managerId`, existing org chart), fallback: any ADMIN |
| Leave ↔ app integration | **Calendar** (approved leave renders as blocked days) **+ Time guard** (logging hours on a leave day is rejected server-side) |
| Performance review model | **Self-assessment + manager review** (draft → submitted → reviewed → acknowledged); 360 feedback is future phase |
| Build order | **Foundation + Leave → Directory → Performance → Onboarding** |
| Demo data | **Full seed** — leave types/policies/balances/requests in every status, profiles, review cycle, onboarding checklist |
| e2e depth | **Exhaustive** — every status transition, cancel/reject flows, permission denials, policy edge cases |

## 2. Research summary (what "HR module" means here)

Surveyed HR-module feature sets (BambooHR/Zoho-people-class tools, leave-management
guides, performance-management comparisons):

1. **Employee database / directory** — job data (title, department, manager, hire date),
   contact data, skills. The workspace already has `User` + `TeamMember`; the missing
   piece is a structured `EmployeeProfile`.
2. **Leave management** — typed leave (annual/sick/unpaid), policies (entitlement,
   carry-over, notice, max consecutive days), requests with an approval workflow,
   balance tracking, and a team leave calendar. Consistently the #1 core HR feature.
3. **Performance management** — review cycles with self-assessment, manager review,
   ratings and comments; 360/peer feedback is the common next phase.
4. **Onboarding** — checklist templates instantiated per new hire, staged tasks with
   assignees and completion tracking.

Deliberately OUT of scope (recorded so it is a decision, not an omission): payroll,
attendance/clock-in, recruitment/at ATS, org-chart editing UI, anonymous 360 surveys,
localization of leave law per jurisdiction.

## 3. Architecture fit (how it maps onto this codebase)

- **Auth/RBAC** (`src/lib/rbac.ts`): new role `HR` (rank 2 — same rank as MANAGER, so
  `outranks()` stays strict and hierarchy management is unaffected), new permissions
  `hr:view` (ADMIN/MANAGER/HR), `hr:admin` (ADMIN/HR), `leave:request` (all roles),
  `review:manage` (ADMIN/MANAGER/HR), `onboarding:manage` (ADMIN/HR). ADMIN keeps every
  permission (existing test invariant). HR gets the MEMBER baseline plus hr:* — no
  project/task powers.
- **Approver resolution**: reuse the existing org chart (`User.managerId`, walked via
  `lib/hierarchy.ts`). No new manager model needed in F1. Leave decisions follow the
  §1 single-approver rule (the employee's IMMEDIATE manager, admin fallback); review
  decisions (§6) accept the subject's full manager chain via `getManagerChain()`
  (QA-17 — the original wording named `getManagerChain()` for both, contradicting the
  user-confirmed §1 row).
- **Server actions**: one file per feature — `src/server-actions/hr-leave.ts`,
  `hr-directory.ts`, `hr-reviews.ts`, `hr-onboarding.ts` (+ shared helpers in
  `hr-shared.ts`). Same shape as `bugs.ts`: `requirePermission` → zod `parseOrThrow` →
  domain asserts → `db` write → `logAudit` → `toResult`.
- **UI**: two new nav entries — **Leave** (self-service, every role; view key `leave`)
  and **HR** (admin console, `hr:view` roles; view key `hr`). The HR view grows a tab
  per feature (Requests / Directory / Reviews / Onboarding / Types & Policies).
  Client-side data loading follows the BugsView pattern (fetch actions + toast).
- **Calendar integration**: approved leave is merged into the calendar's event feed at
  read time (virtual `CalendarEvent`s, type `LEAVE`) — no duplicated rows, so
  cancel/reject updates propagate automatically.
- **Time guard**: `logTime` / `logTaskTime` reject an entry whose date falls on that
  member's approved leave ("double-booking" guard) — server-side only, per ADR-007's
  write-time-enforcement philosophy.
- **Auditing**: new `leave.*` / `hr.*` actions in `lib/audit-meta.ts` (with icons/classes
  so the audit view renders them).
- **Notifications**: request → notify approver; decision → notify requester
  (best-effort, mirrors existing per-user routing).
- **Migrations**: one Postgres-valid migration per feature (+ `down.sql`, repo
  convention). Sandbox applies via `prisma db push` (ADR-008); CI validates via
  `migrate deploy` on Postgres 16. Types stay SQLite-compatible (String/Int/Float/
  Boolean/DateTime only).
- **Seed**: `scripts/seed.js` grows an HR section; every demo scenario the e2e suite
  depends on is deterministic (fresh DB in CI, re-seed locally).

## 4. Feature 1 — Foundation + Leave management (first)

**Data model** (migration `20261103000000_hr_leave`):

- `LeaveType` — name/code unique, `requiresDoc`, `paid`, `color`, `active`.
- `LeavePolicy` — per type: `annualDays`, `maxCarryOver`, `minNoticeDays`,
  `maxConsecutiveDays`.
- `LeaveRequest` — leaveTypeId, userId, startDate, endDate, computed `days` (working
  days, weekends skipped), reason, status `PENDING|APPROVED|REJECTED|CANCELLED`,
  decidedById/decidedAt/decisionNote.
- `LeaveBalance` — per (user, type, year): entitled, carriedOver, used; unique trio.
  `available = entitled + carriedOver − used`.

**Rules** (enforced server-side, all unit-tested):

- Request: end ≥ start; `days` counts Mon–Fri only; policy checks — min notice
  (`start ≥ today + minNoticeDays`), max consecutive; balance check
  (`days ≤ available`) — insufficient balance rejects at submission (per scoping).
  Overlap check: no two PENDING/APPROVED requests may overlap for the same user.
- Approve/reject: caller must be the requester's manager (`User.managerId` — single
  approver per §1, admin fallback) or ADMIN;
  status must be PENDING; approve increments `used`; reject leaves balance untouched.
- Cancel: requester (or ADMIN) may cancel while PENDING or APPROVED; cancelling an
  APPROVED request decrements `used` again (balance restored).
- Balance read: current-year row, lazily defaulted from policy entitlement.
- Types & policies CRUD: `hr:admin` only; types referenced by requests can be
  deactivated, not deleted.

**UI**: Leave view (my balances, request form with live day-count, my request history
with status chips, cancel button); HR view → Requests tab (queue for approvers with
approve/reject + note, filters by status/user) and Types & Policies tab (`hr:admin`).

**Integration**: calendar merge (LEAVE events, all-day, colored by type); time guard
in both time-entry actions.

**BDD** (`e2e/features/hr-leave.feature`, exhaustive): request→approve happy path;
request→reject with note; cancel while pending; cancel after approval (balance
restores); insufficient balance rejected at submission; weekend days not counted;
min-notice policy rejection; max-consecutive rejection; overlapping request rejected;
member sees only own requests; member cannot approve; non-manager cannot decide;
HR manages types; MEMBER does not see HR nav; approved leave shows on calendar;
time logging on leave day rejected.

**Unit tests** (`src/server-actions/__tests__/hr-leave.test.ts`): the same rule matrix
against mocked Prisma (bugs.test.ts pattern), plus RBAC matrix tests for the HR role in
`rbac.test.ts`, plus schema-contract guards for the new models.

## 5. Feature 2 — Employee directory

`EmployeeProfile` (userId unique, jobTitle, department, managerId display comes from
the existing `User.managerId`, hireDate, phone, location, emergency contact, skills
free-text, notes). Migration `20261104000000_hr_directory`. Self-service edit of own
contact fields (`settings:edit` baseline); HR/ADMIN edit everything. HR view →
Directory tab (searchable roster cards + profile modal); Team view links into profiles.
e2e `hr-directory.feature` + unit tests for permission splits.

## 6. Feature 3 — Performance reviews

`PerformanceReview` (userId, periodStart/End, title, status
`DRAFT|SUBMITTED|REVIEWED|ACKNOWLEDGED`, selfAssessment, selfRating 1–5,
managerComment, managerRating 1–5, decidedById, timestamps). Migration
`20261105000000_hr_reviews`. Employee edits self-assessment while DRAFT and submits;
manager (chain) reviews while SUBMITTED; employee acknowledges the result. Reviewers
must be in the subject's manager chain (or ADMIN/HR). Creation: `review:manage` for a
report. e2e `hr-reviews.feature` (all four transitions + denials + invalid rating) +
unit tests.

## 7. Feature 4 — Onboarding

`OnboardingChecklist` (newHireId, title, startedAt/completedAt) +
`OnboardingTask` (checklistId, title, assigneeId, dueOffsetDays, done, doneAt, notes).
Migration `20261106000000_hr_onboarding`. HR creates a checklist from a default
template; assignees tick tasks; checklist auto-completes when all tasks are done;
progress percentage on the card. e2e `hr-onboarding.feature` + unit tests.

## 8. Cross-cutting checklist (touched once, kept in sync)

- `lib/rbac.ts` (+ `rbac.test.ts`), `lib/types`, `lib/config` (leave/review/onboarding
  status labels), `lib/validation.ts` (zod schemas), `lib/audit-meta.ts`.
- `store/app-store.ts` ViewKey, `sidebar.tsx` nav + role gating, `app-shell.tsx`
  routing, `use-keyboard-shortcuts.ts` (G V / G R), command palette entries.
- `scripts/seed.js` HR section; help view content; `docs/ARCHITECTURE.md` module list;
  ADR-009 recording the HR role/permission model.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Postgres migration fails in CI (no local Postgres) | Migration lands with the feature commit; CI e2e is the designated verifier (ADR-008 workflow); hand-checked SQL, SQLite-compatible schema |
| Exhaustive e2e makes the suite slow/flaky | Deterministic seed data; assertions use accessible roles/text; scenarios are order-independent |
| Balance math drifts (used ≠ approved days) | `used` is only mutated in approve/cancel inside a transaction; unit tests assert invariant after each transition |
| RBAC blast radius on existing suites | HR role additive; existing invariants (ADMIN = all permissions, MEMBER set exact) preserved and re-asserted |
| Approver missing (managerId null) | Fallback: any ADMIN may decide; surfaced in the UI queue |

## 10. Definition of done (per feature)

Migration + down.sql applied on Postgres (CI) and via db push (sandbox); unit suite
green; exhaustive e2e feature green locally AND in CI; lint + typecheck + coverage
gates green; audit entries render in the audit view; seed produces the demo dataset;
conventional commit pushed; CI run on main fully green.
