# HR Module — QA Audit Findings (Rounds 1, 2 & 3)

> **Auditor stance:** adversarial ("devil principal QA") — every server action,
> schema, seed and e2e scenario of the HR module (docs/HR_MODULE_PLAN.md) was
> reviewed against the approved plan, then probed for boundary, permission and
> state-integrity failures. Every confirmed finding is reproduced manually
> below and covered by an automated regression test.
>
> **Verification gate (all green at audit close):** lint ✓ · typecheck ✓ ·
> unit **1051/1051** ✓ · e2e **53 scenarios / 403 steps** ✓ (fresh seed,
> full suite in file order).

## Summary

| ID | Severity | Component | Finding | Status |
|----|----------|-----------|---------|--------|
| QA-1 | P1 | leave / `decideLeaveRequest` | Balance validated at submission only — approving two individually-valid requests drove "days left" negative | **Fixed** |
| QA-1b | P1 | leave / decide + cancel | Balance debit/restore was a read-modify-write outside the transaction (lost-update race) | **Fixed** |
| QA-7 | P2 | leave / request form | A next-year range was blocked by the CURRENT year's leftover days ("12 of 6 available") | **Fixed** |
| QA-8 | P0 | leave / request form | Regression introduced by the QA-7 fix: `ReferenceError: year is not defined` crashed the whole Leave view | **Fixed** |
| QA-9 | P1 | platform / `/api/client-errors` | With `APP_URL`/`NEXTAUTH_URL` unset, every real browser error report was rejected 403 (browsers always send `Origin` on fetch POST) — the error bridge was silently dead | **Fixed** |
| QA-10 | P2 | directory / `upsertMyProfile` | Self-service accepted `jobTitle`/`department`/`hireDate` — any member could self-certify "CTO" in the shared roster (plan §5 says contact fields only) | **Fixed** |
| QA-10b | P3 | directory / `employeeProfileSchema` | `hireDate` regex accepted impossible dates ("2026-02-30") that exploded later at the Prisma write | **Fixed** |
| QA-11 | P1 | reviews / `assertReviewer` | Plan §6 grants the reviewer role to "the subject's manager chain (or **ADMIN/HR**)" — the code short-circuited ADMIN only, so HR could never complete a review | **Fixed** |
| QA-11b | P3 | reviews + leave / date schemas | Same impossible-date hole in `createReviewSchema` (periodStart/End) and `createLeaveRequestSchema` (start/end) | **Fixed** |
| QA-12 | P2 | onboarding / `addTask` | `assigneeId` was never validated — tasks could be assigned to nonexistent / soft-deleted users (untickable, blank assignee) | **Fixed** |
| QA-13 | P1 | seed / test coverage | **No user held the HR role** — the entire `hr:*` permission family (incl. the QA-11 gap) was never exercised by any e2e | **Fixed** |
| QA-14 | P3 | e2e infrastructure | Sandbox exports a platform `DATABASE_URL` pointing at `db/custom.db`; any tool that doesn't override it via `.env` silently hits the wrong database | **Mitigated** (documented + hook) |
| QA-15 | P3 | e2e infrastructure | The QA e2e scenarios were not re-runnable: failed runs left APPROVED requests that poisoned the next run (poisoned-state cascade) | **Fixed** (self-cleaning hook) |
| QA-16 | P1 | leave / decide + cancel | The PENDING/APPROVED precheck ran BEFORE the status write, outside the transaction — two tabs (or a decide/cancel interleave) both "won" and the balance was debited twice (or an APPROVED row was silently flipped to CANCELLED without restoring the days) | **Fixed** |
| QA-17 | P2 | reviews / `assertReviewer` | Plan §6 scopes reviewers to the subject's manager **chain** (§3 names `getManagerChain()`), but the guard resolved ONE level (`User.managerId`) — a grand-manager was rejected with "Only the employee's manager…" | **Fixed** |
| QA-18 | P3 | leave / `createLeaveType` | `LeaveType.name` and `.code` are `@unique`; a duplicate surfaced as the generic "Something went wrong" 500 — reads like a server bug, never succeeds on retry | **Fixed** |
| QA-19 | P3 | directory / `EmployeeProfile.department` | Column + self-create + admin-create all defaulted to `"ENGINEERING"` — any profile saved without a picked department showed up in the shared roster as "Engineering", an HR-owned classification nobody had asserted | **Fixed** |
| QA-20 | P3 | reviews / `decideReview` | ADMIN/HR bypass the chain check entirely, so a subject holding either role could review their own cycle, stamp themselves as the reviewer and rate themselves | **Fixed** |
| QA-21 | P3 | leave / `getMyLeaveData` | The loader resolved pending-approver ids for every PENDING request and folded their names into a map only ever read with `decidedById` (always null while PENDING) — dead `getApproverIdsFor` walks on every Leave-view load | **Fixed** |

Severity scale — **P0** crash/data loss on a main path · **P1** spec violation,
security/data-integrity hole, or silently-dead subsystem · **P2** correctness
against the approved plan · **P3** hardening / robustness.

---

## Finding detail

### QA-1 — leave overdraft at approval (P1)

**Where:** `src/server-actions/hr-leave.ts` → `decideLeaveRequest`.

**Root cause:** the balance was only checked in `createLeaveRequest`. Two
non-overlapping requests each pass it individually; approving both debited
`used` past the entitlement and the member's card showed a negative
"days left".

**Manual repro (pre-fix):** request 12 working days starting Monday+14 and
another 12 starting Monday+42 (Annual Leave, 20 entitled); approve the far
one, then the near one → the second approval succeeded and the balance went
negative.

**Fix:** the guard now runs INSIDE the approval transaction; a refused
approval rolls back and surfaces `Insufficient balance: 12 day(s) requested,
only N day(s) left…`. A missing balance row is materialized from the policy
default inside the same transaction (re-reading the winner on a unique-trio
race — fail closed).

**Tests:** unit (`hr-leave.test.ts` — refusal, inclusive boundary, missing-row
materialization) + e2e (`hr-qa-hardening.feature` — full browser repro with
relative balance assertions).

### QA-1b — non-atomic balance write (P1)

**Where:** same actions as QA-1.

**Root cause:** `used` was computed as `balance.used + request.days` from a
read OUTSIDE the transaction — a concurrent approval/cancel between the read
and the write was silently lost.

**Fix:** atomic `{ increment: request.days }` on approve; on cancel a
`{ decrement: Math.min(request.days, balance.used) }` with a zero floor so a
drifted balance can never go below zero.

**Tests:** the unit suite now asserts the atomic shapes
(`expect.objectContaining({ data: { used: { increment: 2 } } })`) plus the
zero-floor restore case.

### QA-7 — next-year range blocked by this year's balance (P2)

**Where:** `src/components/views/leave-view.tsx` → `RequestFormModal`.

**Root cause:** the client-side guard compared the requested working days
against the balance loaded for the CURRENT year. Entitlement resets on Jan 1,
and the server validates a next-year range against THAT year's fresh
entitlement — so the form wrongly disabled submission (and showed a
misleading "12 of 6 available").

**Manual repro:** with ≤ 11 annual days left this year, request 12 working
days starting next January → pre-fix, the submit button stayed disabled.

**Fix:** a range whose start year differs from the loaded balance's year is
excluded from the client guard (the form says "<year> entitlement applies —
the server validates on submit").

**Tests:** e2e (`A next-year request is not blocked by this year's remaining
balance`).

### QA-8 — self-inflicted P0 while fixing QA-7

**Where:** same component.

**Root cause:** the QA-7 fix referenced the parent's `year` state from inside
`RequestFormModal`, where it is not in scope. The whole Leave view crashed
with `ReferenceError: year is not defined` — found by the browser-console
probe, invisible to unit tests. (Lesson: an unverified fix is a new bug.)

**Fix:** the year arrives as an explicit `balanceYear` prop.

**Tests:** every Leave-view e2e (the view renders at all) + the QA-hardening
scenarios drive the form end-to-end.

### QA-9 — client error bridge dead in unconfigured environments (P1)

**Where:** `src/app/api/client-errors/route.ts` → `isSameOrigin`.

**Root cause:** with neither `APP_URL` nor `NEXTAUTH_URL` set (exactly the
sandbox / unconfigured-deploy case) the origin check fell back to
`return !origin`. Browsers send `Origin` on **every** fetch POST — same-origin
included — so 100% of real browser error reports were rejected with 403. The
browser console showed it twice during the Leave-view crash: the report of the
QA-8 crash itself was discarded.

**Manual repro:** unset both vars, throw any client error, watch the network
tab — `POST /api/client-errors → 403`.

**Fix:** the no-config fallback compares `Origin` against the request's own
`Host` header (a browser cannot make a cross-site POST whose Origin host
equals the target Host). Cross-origin floods still 403; Origin-less probes
still pass; production should still pin `APP_URL`.

**Tests:** 3 route tests (same-origin-with-Origin accepted, cross-origin
rejected, curl-style accepted).

### QA-10 — self-service could write HR-owned job data (P2)

**Where:** `src/server-actions/hr-directory.ts` → `upsertMyProfile` (and the
Settings card that drove it).

**Root cause:** the action (and the form) accepted `jobTitle`, `department`
and `hireDate`. The plan (§5) scopes self-service to **contact fields**;
"HR/ADMIN edit everything". Any member could self-certify the job title the
whole roster sees. The deviation was even encoded in an e2e scenario — the
test suite blessed the spec violation.

**Manual repro (pre-fix):** sign in as a member → Settings → Employee
profile → set Job title to "CTO" → it appeared in the directory for everyone.

**Fix:** new strict `employeeProfileSelfSchema` (phone, location, emergency
contact, skills only); the action runs inputs through it (HR-owned keys are
rejected outright), a self-created profile starts with empty job data, and the
Settings card renders job data read-only ("Job data (set by HR)").

**Tests:** schema tests (every HR-owned key rejected), action tests
(smuggling rejected, clean payload never carries job fields), e2e (member
saves contact fields, job data stays read-only across a hard reload).

### QA-10b / QA-11b — impossible calendar dates passed validation (P3)

**Where:** `src/lib/validation.ts` — `employeeProfileSchema.hireDate`,
`createReviewSchema.periodStart/End`, `createLeaveRequestSchema.start/end`.

**Root cause:** the `^\d{4}-\d{2}-\d{2}$` regex accepts "2026-02-30",
"9999-99-99", "2026-13-01". These either threw a generic "unexpected failure"
at the Prisma write (hireDate) or silently compared as `NaN` in the
period-end check (reviews).

**Fix:** shared `isoDateStr` / refined `isoDateish` — the date must round-trip
through `Date` back to the same calendar day.

**Tests:** leap-day acceptance plus a battery of impossible dates for all
three schemas.

### QA-11 — HR could not complete a review (P1, spec violation)

**Where:** `src/server-actions/hr-reviews.ts` → `assertReviewer`.

**Root cause:** plan §6 says reviewers are "the subject's manager chain (or
**ADMIN/HR**)" — the RBAC matrix even grants HR `review:manage` — but the
guard short-circuited `ADMIN` only, so HR (who organizes cycles and can create
them for anyone) was rejected with "Only the employee's manager…" when trying
to write the review itself.

**Manual repro (pre-fix):** as the HR user, open any SUBMITTED cycle →
Review → the toast rejected the call.

**Fix:** `assertReviewer` passes `ADMIN` **and** `HR`; chain members unchanged.

**Tests:** unit (HR completes a review outside the chain) + e2e (the seeded
HR user reviews Amara's cycle — see QA-13).

### QA-12 — onboarding tasks assignable to ghost users (P2)

**Where:** `src/server-actions/hr-onboarding.ts` → `addTask`.

**Root cause:** `assigneeId` was accepted as any cuid-shaped string without
an existence/soft-delete check — a task could be assigned to a nonexistent
user: nobody could ever tick it (except the hire/HR) and the UI rendered a
blank assignee.

**Fix:** assignee validated like the new-hire in `createChecklist`
(`Assignee not found.` on miss/soft-deleted).

**Tests:** 3 unit cases (missing, soft-deleted, valid).

### QA-13 — the HR role existed on paper only (P1, coverage hole)

**Where:** `scripts/seed.js` (+ the whole e2e suite).

**Root cause:** the RBAC matrix ships an `HR` role with the `hr:*` family,
but **no seeded user held it** (the onboarding seed even referenced a
nonexistent "Remy"). Every HR-role permission path — including the QA-11
reviewer gap — was therefore never exercised end-to-end. This is *why* QA-11
could ship unnoticed.

**Fix:** Remy Laurent (`remy@fernly.app`, HR, reports to the admin) is seeded
with a directory profile; a SUBMITTED review cycle for Amara (outside
Ingrid's subtree) gives the e2e something only ADMIN/HR can review.

**Tests:** the new QA-11 e2e scenario signs in as `remy@fernly.app` and
completes Amara's review through the real UI.

### QA-14 — platform `DATABASE_URL` points at the wrong database (P3, environment)

**Where:** sandbox environment vs. every DB-touching tool.

**Root cause:** the sandbox exports `DATABASE_URL=file:/home/z/my-project/db/custom.db`
globally. Anything that does not explicitly load the project `.env`
(which overrides it — `scripts/run-with-env.sh`'s whole purpose) silently
reads/writes the WRONG sqlite file. The QA cleanup hook hit this and reported
`main.LeaveRequest does not exist`.

**Mitigation:** the e2e hook resolves the URL with the same precedence as
`run-with-env.sh` (.env wins when present; CI's injected var wins there) and
the failure mode is documented here. Any future tooling that touches the DB
from a plain process must reuse that precedence.

### QA-15 — adversarial e2e scenarios poisoned their own re-runs (P3, test infra)

**Where:** `e2e/features/hr-qa-hardening.feature` + steps.

**Root cause:** a failed/interrupted run left APPROVED "QA …" requests behind;
the re-run then hit the client-side balance guard (submit disabled), failed at
an unrelated timeout two steps later, and the assertions' absolute numbers
assumed a specific starting balance that only held after the rest of the
suite had run.

**Fix:** a `@hr-qa` `Before` hook deletes stale QA-prefixed requests and
restores any balance they debited; balance assertions are RELATIVE (note →
dropped by N → back to noted) so they hold on a fresh seed AND mid-suite;
the request step fails loudly when the submit button is disabled instead of
clicking into the void.

### QA-16 — decide/cancel race around the PENDING precheck (P1)

**Where:** `src/server-actions/hr-leave.ts` → `decideLeaveRequest`,
`cancelLeaveRequest`.

**Root cause:** the `request.status !== "PENDING"` (or `!== "APPROVED"`)
guard ran BEFORE the write, outside the `$transaction`. Two browser tabs
(or a decide/cancel interleave) both passed it; without a status predicate
in the `WHERE` clause, both writes "won":

- **Approve / approve** — `used` was debited TWICE for one request. The
  UI's `useTransition` button-disable only blocks one tab.
- **Approve / reject** — last-writer-wins silently flipped an APPROVED
  row (with debited days) to REJECTED, leaving the balance permanently
  debited for a request that was never approved.
- **Cancel / cancel** on an APPROVED request — the second restore was a
  double refund.
- **Cancel (PENDING read) / approve** — the plain update flipped the
  just-APPROVED row to CANCELLED WITHOUT restoring the days the approval
  had just debited (permanent leak).

**Manual repro (pre-fix):** open two tabs as the manager on the same
PENDING request → click Approve in both within the same render tick →
both succeed; the balance drops by `2 × request.days`.

**Fix:** every status flip is now a guarded
`updateMany({ where: { id, status: <expected> }, data: { status: <new>, … } })`
INSIDE the transaction (or, on the no-balance-work reject / pending-cancel
paths, just inside the same flow). A `count === 0` means someone else won
the race — abort BEFORE any balance read or write, with the same friendly
"This request is no longer pending/approved — it was just decided or
cancelled elsewhere. Refresh and try again." message the UI surfaces as a
normal retryable failure. The approve path flips BEFORE the balance read
so a losing transaction never debits. The pending-cancel path's
zero-count message even tells the user to "Cancel it again to undo the
approved days" — the retry then takes the proper APPROVED restore branch.

**Tests:** 8 unit cases in `hr-leave.test.ts` — guarded WHERE on each of
the 4 paths (approve / reject / cancel-approved / cancel-pending) plus a
zero-row outcome on each that asserts (a) the result is `AUTH` with the
"no longer" message and (b) `db.leaveBalance.update` was NEVER called.

### QA-17 — reviewer scope was one level, not the chain (P2, spec violation)

**Where:** `src/server-actions/hr-reviews.ts` → `assertReviewer`.

**Root cause:** plan §6 says reviewers are "the subject's manager chain
(or **ADMIN/HR**)" and §3 names `getManagerChain()` as the resolution
mechanism. The guard called `getApproverIdsFor(subjectId)` which resolves
ONE level only (`User.managerId`). A grand-manager — the only fallback
when the immediate manager is on leave — was rejected with "Only the
employee's manager…". The seeded org chart had every grand-manager as
ADMIN, so the gap was invisible to e2e.

**Manual repro (pre-fix):** with Soren reporting to Lena who reports to
Ingrid, sign in as Ingrid and try to review Soren's SUBMITTED cycle →
rejected.

**Fix:** `assertReviewer` calls `getManagerChain(subjectId)` (lib/hierarchy.ts,
which already powers the leave decision path and excludes the subject
themself, capping at 32 hops with a cycle guard).

**Seed change:** Soren now reports to Lena (who reports to Ingrid) — the
org chart has a non-ADMIN grand-manager, the only shape in which the
plan-§6 scope is observable. Ingrid stays inside the same subtree, so
queue scoping is unchanged; Lena keeps her MEMBER role (the org chart and
RBAC are separate axes). A new DRAFT "2026 Skip-level check-in" cycle for
Soren is seeded.

**Tests:** 3 unit cases (skip-level approval succeeds, manager one level
up but OUTSIDE the chain rejected, subject themself never in own chain) +
1 e2e scenario (Soren self-submits, Ingrid — the grand-manager —
completes the review through the real UI).

### QA-18 — duplicate leave type surfaced as a generic 500 (P3)

**Where:** `src/server-actions/hr-leave.ts` → `createLeaveType`.

**Root cause:** `LeaveType.name` and `.code` are `@unique`. Creating a
duplicate threw Prisma `P2002`, which `toResult` converted into the
generic `INTERNAL` "Something went wrong. Please try again." — the admin
had no idea the name was taken (it reads like a server bug, and retrying
can never succeed). The `isUniqueConstraintError` helper in `result.ts`
existed for exactly this and was wired to nothing.

**Fix:** the `db.leaveType.create` call is wrapped in a try/catch; on a
unique-constraint violation the action throws an `AuthorizationError`
with `A leave type named "…" (or code …) already exists — names and codes
must be unique.` (`AUTH` code, surfaces as a normal toast).

**Tests:** 1 unit case (duplicate name → friendly conflict, NOT
"something went wrong").

### QA-19 — `EmployeeProfile.department` defaulted to "ENGINEERING" (P3)

**Where:** `prisma/schema.prisma` (column default),
`src/server-actions/hr-directory.ts` (self-create + admin-create
branches), `src/lib/validation.ts` (schema), `src/lib/types/index.ts`
(type union).

**Root cause:** the column `@default("ENGINEERING")`, the self-create
upsert branch, AND the admin-create upsert branch all stamped
`"ENGINEERING"` when no department was picked. Any profile saved without
an explicit department — including every member's self-created profile
after QA-10 locked self-service down to contact fields — showed up in the
shared roster as "Engineering", an HR-owned classification nobody had
asserted. The directory renders `department` via `DEPARTMENT_LABELS`,
so the fabricated value was indistinguishable from a real one.

**Manual repro (pre-fix):** sign in as a member who has never been
classified → Settings → save a phone number → open the directory → your
row says "Engineering".

**Fix:** the column default is now `""`; both create branches default to
`""`; the schema accepts `""` alongside the four real departments (`""`
means "not classified yet", rendered as "—" in the roster). The runtime
guard in `updateProfileAsAdmin` keeps rejecting unknown strings (`""` is
falsy so it skips the `VALID_DEPARTMENTS.has` check). A migration
(`20261107000000_qa3_department_default`) changes the SQL default;
existing rows keep their stored value, only future inserts change.

**Tests:** 3 schema cases (`""` accepted, unknown strings rejected, the
four real departments accepted) + 2 action cases (self-create and
admin-create branches both leave department `""` when none is supplied).

### QA-20 — ADMIN/HR could review their own cycle (P3)

**Where:** `src/server-actions/hr-reviews.ts` → `decideReview`.

**Root cause:** `assertReviewer` short-circuits `ADMIN` and `HR` (the
QA-11 fix), so a subject holding either role could write their own
manager review — stamp themselves as the reviewer and rate themselves.
The plan's model is "manager reviews, employee acknowledges"; the
employee must never sit on both sides of the table, regardless of role.

**Manual repro (pre-fix):** as the admin, create a review cycle for
yourself, submit it, then complete the manager side → it went through.

**Fix:** an explicit `review.userId === auth.userId` check before
`assertReviewer`, with "You cannot review your own cycle — it is
reviewed by your manager chain, HR, or another admin.".

**Tests:** 2 unit cases (ADMIN self-review and HR self-review both
rejected; `db.performanceReview.update` never called).

### QA-21 — `getMyLeaveData` resolved approver names that were never rendered (P3)

**Where:** `src/server-actions/hr-leave.ts` → `getMyLeaveData`.

**Root cause:** the loader resolved the pending-approver ids of MY
pending requests (`getApproverIdsFor` per request) and folded their names
into the `deciders` map… which is only ever read with `decidedById` —
always `null` while PENDING. The pending approver names were never
rendered (the UI shows "Awaiting approval" for PENDING rows, not the
approver's name). Dead `getApproverIdsFor` walks — one per pending
request — on every Leave-view load.

**Fix:** the loader now resolves only the `decidedById` set. The walk
and the `pendingApproverIds` fold are gone.

**Tests:** 1 unit case (with a mix of PENDING and APPROVED requests, the
action never calls `getApproverIdsFor`; only the `decidedById` user is
fetched).

---

## Not filed (checked and cleared)

- **Manager sees the full directory** — per plan §5 (`hr:view` =
  ADMIN/MANAGER/HR) and asserted by e2e; subtree scoping applies to the leave
  queue and review queue, not the roster.
- **HR cannot approve leave** — plan §4 scopes leave decisions to "the
  requester's manager (or an admin)" only; intentionally narrower than
  reviews.
- **Cross-year leave range debits only the start year's balance** — a
  documented simplification of the per-year balance model; capped by
  `maxConsecutiveDays`.
- **Read-check-then-write races in review/onboarding transitions** —
  single-row last-writer-wins, no balance-style invariant at risk; noted for
  a future hardening pass if concurrency matters.
- **Onboarding template instantiation sends no notifications** (leave and
  reviews do notify) — a minor UX inconsistency, not a plan violation;
  candidate for a follow-up polish ticket.
- **Checklist auto-completion is not in one transaction with the task tick** —
  a crash between the two writes leaves an all-done-but-incomplete checklist;
  self-heals on the next tick/untick. Acceptable for the demo tier.

## Regression-test inventory added by this audit

| Layer | File | Cases |
|-------|------|-------|
| Unit | `src/server-actions/__tests__/hr-leave.test.ts` | +6 (QA-1/1b) · +8 (QA-16, 4 decide + 4 cancel) · +1 (QA-18) · +1 (QA-21) |
| Unit | `src/lib/__tests__/client-error-bridge.test.ts` | +3 (QA-9) |
| Unit | `src/server-actions/__tests__/hr-directory.test.ts` | +5 (QA-10) · +2 (QA-19 action side) |
| Unit | `src/lib/__tests__/validation.test.ts` | +9 (QA-10b/11b, QA-10) · +3 (QA-19 schema side) |
| Unit | `src/server-actions/__tests__/hr-reviews.test.ts` | +1 (QA-11) · +3 (QA-17) · +2 (QA-20) |
| Unit | `src/server-actions/__tests__/hr-onboarding.test.ts` | +3 (QA-12) |
| e2e | `e2e/features/hr-qa-hardening.feature` | 2 scenarios (QA-1, QA-7) |
| e2e | `e2e/features/hr-directory.feature` | rewritten self-service scenario (QA-10) |
| e2e | `e2e/features/hr-reviews.feature` | +1 scenario (QA-11/QA-13) · +1 scenario (QA-17) |

**Round 3 totals:** +20 unit cases (8 + 1 + 1 + 5 + 3 + 2 = 20), +1 e2e
scenario, +14 e2e steps. Suite size at audit close: 1051 unit / 53 e2e.
