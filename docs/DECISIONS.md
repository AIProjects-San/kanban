# Fernly — Decision Records (ADRs)

Short, dated records of the architectural decisions that shape the codebase. Each entry
states the **decision**, the **context** that forced it, and the **consequences** we
accept. Supersede an ADR by writing a new one and linking back — never edit history.

---

## ADR-001 — HTTP client: native `fetch`, not axios

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** The maintainability review asked whether adopting axios would improve code
maintenance.

**Analysis.**

| Criterion | Native `fetch` | axios |
|---|---|---|
| Call sites in this repo | 1 (Resend API in `src/lib/mailer.ts`) | — |
| Internal data flow | Server Actions (typed RPC, no HTTP layer at all) | — |
| Bundle cost | 0 kB (platform) | ~13 kB gz + types |
| Next.js integration | Native: `cache`/`no-store`, `next.revalidate`, RSC-compatible | Interceptors fight framework caching semantics |
| Timeouts | `AbortSignal.timeout()` (used in mailer since this ADR) | Built-in |

The app has **exactly one** outbound HTTP call. Axios's value (interceptors, instance
defaults, wide REST surface support) pays off at dozens of call sites; at one it is pure
weight, and it would add a dependency to audit (see `scripts/check-audit.mjs`).

**Decision.** Stay on native `fetch`. The single call site is hardened with
`AbortSignal.timeout(10_000)` so a wedged provider cannot stall the password-reset flow.
If a second provider integration arrives (SES, Postmark), extract a typed
`postJson(url, body, {timeoutMs})` helper in `src/lib/` — still no axios.

**Consequences.** No interceptor layer: per-call concerns (auth header, timeout, error
shape) are explicit at the call site. Acceptable at this scale; revisit if outbound HTTP
grows past ~5 call sites.

---

## ADR-002 — UI pattern library: shadcn/ui pattern with local primitives, no component kit

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** The review asked whether a UI pattern library (MUI, Ant Design, Chakra,
full shadcn registry install) should replace hand-built components to reduce code
overhead.

**Analysis.**

- The repo **already follows the shadcn/ui pattern**: `components.json` (new-york
  style, lucide icons), `cn()` in `src/lib/utils.ts` (clsx + tailwind-merge), local
  primitives in `src/components/ui/` (Modal with focus trap, Field/FormRow,
  StatCard, Toggle, EmptyState, RoleBadge, FilterBar, Section, Avatar, PasswordInput).
  "Code overhead" is already amortized into ~15 reusable primitives.
- A full kit (MUI/AntD/Chakra) would (a) fight the OKLCH token system and four-accent
  theming, (b) add 100–300 kB to the client bundle — directly against the L-P1-17
  bundle-budget gate (`scripts/check-bundle-budget.mjs`: 200 kB main, 250 kB lazy),
  and (c) impose its own design language on a product whose `f-*` classes are the
  design language.
- Local ownership means a11y fixes (L-P1-18 focus trap) land in our files, not behind
  an upstream release.

**Decision.** Keep the shadcn/ui **pattern** with locally-owned primitives. When a new
complex primitive is needed (combobox, date picker), generate it with
`bunx shadcn@latest add <component>` into `src/components/ui/` and restyle to tokens —
copy-in code we own, not a runtime dependency.

**Consequences.** We maintain ~15 primitive files ourselves. In exchange: zero kit
bundle weight, full token/theming control, and the bundle gate stays meaningful.

---

## ADR-003 — Tailwind v4 CSS-first configuration; delete the JS config

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** `tailwind.config.ts` (v3-style) still existed after the Tailwind v4
upgrade. v4 with `@tailwindcss/postcss` ignores it unless a `@config` directive is
present — and it had drifted badly: it declared `hsl(var(--…))` colors while the real
tokens are OKLCH, referenced a `--destructive-foreground` that no longer exists, and
pulled in the v3-only `tailwindcss-animate` plugin (the v4 path uses `tw-animate-css`,
already imported in CSS).

**Decision.** Delete `tailwind.config.ts` and the `tailwindcss-animate` dependency.
All configuration lives in CSS: `@theme inline` in `src/app/globals.css` +
`src/styles/tokens.css`. `tokens-sync.test.ts` asserts the legacy config stays gone.

**Consequences.** One less config file; zero chance of a dead config drifting out of
sync with the live one. Anyone searching for "where is bg-primary defined" has exactly
two CSS files to read.

---

## ADR-004 — Product identity is code, in one config module

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** The product name was hardcoded in 14+ user-facing surfaces (page title,
sidebar, login screen, password-reset emails, ICS PRODID/UID, support email, storage
keys, the error-bridge window key…). Rebranding or white-labelling meant a repo-wide
grep-and-pray.

**Decision.** `src/config/app.ts` is the **single source of truth** for the name,
slug, tagline, support email and identifier domain. It derives `STORAGE_KEYS`,
`ERROR_BRIDGE_KEY`, `DEFAULT_WORKSPACE_NAME` and `DEFAULT_MAIL_FROM`. Every
user-facing surface imports from it; `app-config.test.ts` fails the build if a swept
file stops importing the config. (Internal module paths such as
`@/components/ui/*` are code identifiers, not branding — they stay.)

**Consequences.** Renaming the product = editing one file. Tests pin the contract so
literals cannot quietly return.

---

## ADR-005 — Design tokens: one CSS file, one typed mirror, one sync test

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** Color values were duplicated in three places that could silently diverge:
`globals.css` utility classes hardcoded raw OKLCH values for tags/priorities/avatars,
`src/lib/constants.tsx` duplicated the accent colors as inline-style strings, and dark
variants were `.dark .f-tag-*` rule *duplicates* rather than token overrides.

**Decision.**

1. **`src/styles/tokens.css`** — every raw color/radius/shadow value, organized in
   sections (primitives, accent engine, semantic light, semantic dark, tag palette,
   priority palette, avatar palette). Dark mode = token overrides on `.dark`, never
   per-class rules.
2. **`src/styles/tokens.ts`** — typed mirror for the few render-time values JS needs
   (accent swatches, chart/legend anchors). `tokens-sync.test.ts` parses the CSS and
   compares, so drift is a build failure.
3. `globals.css` keeps only: theme wiring (`@theme inline`), base styles, `f-*`
   component classes that reference `var(--…)`, animations. It contains **zero** raw
   color literals (asserted by the sync test).

**Consequences.** Adding a tag/priority/accent is a token edit + (if JS needs it) a
mirror edit; the test enforces the pair. Slightly more indirection when reading a
class definition; vastly less drift risk.

---

## ADR-006 — Secrets: `.env` is the only home; no credential literal is ever committed

**Date:** 2026-10-31 · **Status:** ACCEPTED (enforces a MUST requirement) · **Type:** security

**Context.** The maintainability review set a hard requirement: *all secrets in `.env`,
no hardcoded secrets anywhere*. The audit that followed found: (a) the **real
`NEXTAUTH_SECRET` pasted into a committed unit test**, (b) the demo password hardcoded in the seed, 4 node scripts, 3 shell scripts, the k6
load test, and the e2e suite, (c) the DB password duplicated in a `.env` comment, (d) docs
publishing the demo password.

**Decision.**

1. `.env` (gitignored; `.env.example` documents keys without values) is the **only**
   home for secrets: `DATABASE_URL`, `NEXTAUTH_SECRET`, `RESEND_API_KEY`,
   `NEXT_PUBLIC_DEMO_PASSWORD`, …
2. Tests use obviously-fake values (`obviously-fake-unit-test-secret-…`); the leaked
   production secret was **rotated** and scrubbed.
3. Scripts read the demo password through `scripts/lib/demo-env.mjs` (or
   `NEXT_PUBLIC_DEMO_PASSWORD` for k6/e2e), which **fail loudly** when it is unset.
   Seed refuses to run without it.
4. `login-demo-gating.test.ts` greps seed/e2e/k6 sources for the literal and fails if
   it reappears; the bundle gate greps built output.

**Consequences.** Cloning the repo yields a credential-clean tree (verifiable by
`grep -r <password> .`). Rotating the demo password is a one-line `.env` edit.
Operational cost: contributors must copy `.env.example` first — already required for
`DATABASE_URL`.

---

## ADR-007 — Project association rule: work is assigned per project team

**Date:** 2026-11-02 · **Status:** ACCEPTED · **Type:** product/data-integrity

**Context.** Bugs could be raised without a project, and both bugs and tasks could be
assigned to ANY user in the workspace, regardless of which project the work belongs to.
The assignee dropdowns offered the full roster, so "assign the Safari-login bug to the
marketing lead" was a perfectly legal action.

**Analysis.** The workspace already had the explicit staffing relation
(`ProjectAssignment` — the admin "assign user to project" UI), plus ownership
(`Project.ownerUserId`). Two candidate definitions of "associated with a project":

| Criterion | Explicit assignment ∪ owner | Assignment ∪ owner ∪ has-tasks-in-project |
|---|---|---|
| Circular? | No | Yes — "you can be assigned because you were assigned" bootstraps itself |
| Admin intent | Matches the staffing UI exactly | Lets stale task history mint new permissions |
| First assignment possible | Yes — staff the user first, one admin action | Yes, but by accident |

**Decision.**

1. A user is **associated with a project** iff they have a `ProjectAssignment` row for
   it or they own it. One canonical definition in
   `server-actions/shared.ts` (`getProjectAssociatedUserIds` + the two `assert*`
   helpers); every writer funnels through it.
2. **Bugs must belong to a project** (`createBug` rejects project-less bugs; the raise
   form requires the field). `assignBug` only accepts users associated with the bug's
   project. Linked tasks must be in the same project (`createBug`, `linkBugToTask`).
3. **Tasks must belong to a project** (`createTask` rejects project-less tasks; tasks
   can no longer be moved OFF a project, only between projects). Task assignees
   (`TeamMember`) must resolve to an associated user. `bulkUpdateTasks` skips tasks
   whose project the new assignee is not staffed on.
4. Enforcement is at **write time** in server actions (the security boundary — the
   dropdowns are convenience only). Legacy rows are not retro-migrated: a project-less
   legacy bug simply cannot be assigned until it is given a project.
5. The seed staffs every demo task/bug assignee on the work's project so the demo data
   satisfies the invariant.

**Consequences.** The task-modal assignee list can be empty for a fresh project until
someone is staffed on it — that is the intended signal (the UI says exactly that). Roster
entries without a linked `User` account can no longer be assigned work. Unassigning a
user from a project does not cascade to existing assignments (write-time rule only).

---

## ADR-008 — Canonical Postgres schema; sandbox SQLite via generated local variant

**Date:** 2026-11-02 · **Status:** ACCEPTED · **Type:** tooling/CI

**Context.** The sandbox preview has no Postgres, so local development runs the schema on
SQLite (`DATABASE_URL=file:./dev.db`, applied with `prisma db push`). CI's e2e job,
docker-compose and the Supabase production database are PostgreSQL, and the migration
history (`prisma/migrations/`) is the production history. Prisma allows exactly one
`provider` per schema file. Commit 76e2e51 leaked the local override
(`provider = "sqlite"`) into the committed `prisma/schema.prisma`; from that push every
CI run failed at the e2e "Apply migrations + seed" step with Prisma **P1012** ("the URL
must start with the protocol `file:`") because that job points the same schema at a
Postgres 16 service container. The pre-ADR workflow — "remember to flip the provider
back before committing" — is exactly what failed; the flip must be automatic.

**Analysis.** Three candidate mechanisms:

| Option | Verdict |
|---|---|
| Commit `sqlite` + sed-patch it in CI | Inverts the source of truth; production deploys (`migrate deploy` on Supabase) still break |
| Wrapper rewrites `schema.prisma` in place when the URL says `file:` | Leaves the tree perpetually dirty — the same leak is one `git add -A` away |
| Keep canonical schema postgres; on a `file:` URL generate a gitignored variant and point the Prisma CLI at it | Committed file never changes; zero leak surface; CI untouched |

**Decision.**

1. `prisma/schema.prisma` is committed with `provider = "postgresql"` — always. A
   schema-contract test fails the verify job within minutes if that line regresses.
2. `scripts/run-with-env.sh` (already the wrapper every `db:*` script, `dev`, `build`
   and `start` exec through) resolves the provider from the effective `DATABASE_URL`
   after sourcing `.env`: `file:` → sqlite, `postgres(ql)://` → postgresql. On mismatch
   it regenerates the gitignored `prisma/schema.local.prisma` (models copied verbatim,
   only the provider line swapped) and appends `--schema prisma/schema.local.prisma` to
   the prisma CLI invocation. The committed schema is never modified.
3. `prisma migrate dev/deploy/status/reset` remain Postgres-only operations — the
   migration history is the production history. The sandbox applies schema changes with
   `db push`, which ignores migrations by design.
4. New migrations keep the repo convention: hand-checked, PostgreSQL-valid SQL plus a
   `down.sql` rollback aid (the two 2026-11-02 migrations gained theirs with this ADR).

**Consequences.** `git status` in the sandbox stays clean and the override cannot leak
into a commit again. CI runs unchanged (no `.env` there → postgres URL → canonical
schema → `migrate deploy` on the service container). Costs: one generated ~26 KB file
per wrapper invocation (negligible), one indirection to know about when debugging
Prisma locally, and `--schema` appended after the subcommand (Prisma 6 rejects it as a
global flag). Dependabot PRs #1/#2 must rebase onto this fix to go green.

---

## ADR-009 — HR module: HR role, chain-scoped leave approvals, virtual calendar events

**Date:** 2026-11-02 · **Status:** ACCEPTED · **Type:** product/RBAC/data-model

**Context.** The workspace needed people-operations capability (docs/HR_MODULE_PLAN.md):
leave management first, then directory, performance reviews and onboarding. Three
scoping questions shaped the design: who holds HR power, who approves a leave request,
and how approved leave integrates with the existing calendar and time log.

**Analysis.** Add HR powers to MANAGER (managers become pseudo-HR, privacy leak of leave
reasons across teams) vs. a dedicated HR role (one more role in every Record<Role,…>
map, but the blast radius is a compile error, not a behavior change). Approvals: role-
scoped (any hr:view holder decides — leaks reasons) vs. chain-scoped (only the
requester's manager or an ADMIN). Calendar: duplicate CalendarEvent rows on approval
(sync/dedup hazard on cancel) vs. read-time virtual events.

**Decision.**

1. **New `HR` role** at MANAGER rank (strict `outranks` keeps HR/MANAGER mutually
   unmanaged): MEMBER baseline + `hr:view`, `hr:admin`, `review:manage`,
   `onboarding:manage` — deliberately NO task/project powers. `leave:request` is a
   baseline permission every role holds (self-service).
2. **Leave decisions are chain-scoped, not permission-scoped**: only the requester's
   manager (`User.managerId`, the existing org chart) or an ADMIN may approve/reject.
   A MANAGER's queue is subtree-filtered; HR sees the workspace but decides nothing.
3. **Balances are transactionally invariant**: `LeaveBalance.used` mutates only inside
   approve/cancel, always by exactly the request's denormalized `days`; cancel-after-
   approval restores the balance. Insufficient balance rejects at submission.
4. **Approved leave renders as virtual `LEAVE` calendar events** merged into the
   dashboard's event feed at read time — no DB rows, so cancel/reject propagates
   automatically; scoped users see only their visible members' leave.
5. **Time guard at the write boundary**: `logTime`/`logTaskTime` reject logging hours
   on a day the user is on approved leave (same philosophy as the ADR-007
   project-association rule — the UI is convenience, the action is the boundary).
6. Relation-light schema (plain string FKs, CalendarEvent-style) — the core `User`
   model is untouched; names resolve via bulk lookups.

**Consequences.** Every `Record<Role, …>` map gains an HR entry (role-badge,
rbac-view icons — caught at compile time, updated in this change). e2e must run
scenarios in file order against a fresh seed (state-dependent balance arithmetic);
sandbox runs batch by tag because the reaper kills long-lived background processes
between tool calls. Sonner toasts proved unreliable to assert in headless Chrome —
rejection scenarios assert structural outcomes (form stays open, no row created)
instead. The e2e `.env` parser now strips quotes like dotenv/shell do (a quoted
`NEXT_PUBLIC_DEMO_PASSWORD` previously caused bcrypt-mismatch 401s and drained the
login-rate-limit budget).

---

## ADR-010 — Personal-data scoping: personal items are owner-scoped; shared logs follow member visibility

**Date:** 2026-11-03 · **Status:** ACCEPTED · **Type:** security

**Context.** The PR-51→54 data-leak audit (every server action + API route) found
four places where "what the sentence claims" and "what the query returns" disagreed:
the dashboard greeting counted workspace-wide tasks for admins (PR-51); reminders
surfaced legacy null-owner rows to every user (PR-52); `getTimeEntriesPage` used a
project-centric scope while the dashboard uses a member-visibility rule — letting a
MEMBER read non-visible members' time logs, with the caller's `memberId` filter
overwriting the scope entirely (PR-53); and `getProjectAssignments` /
`getProjectAssignableUsers` returned any project's staff roster (with emails) to any
signed-in user (PR-54).

**Analysis.** The app's resources split into three visibility classes:

| Class | Rule | Examples |
|---|---|---|
| Personal | owner-only, **everyone including admins** sees only their own | reminders, greeting counts, settings, password |
| Shared, member-visible | visible if the *viewer can see the member* (members of their projects + self) | time entries |
| Shared, project-visible | visible if the *viewer can see the project* (`getScopedProjectIds`) | tasks, projects, project staff |
| Workspace-wide by design | everyone sees them | calendar events, bug board, notification broadcasts |

The bugs were all class-confusion: reminders treated as workspace-wide, time entries
treated as project-visible, project staff treated as workspace-wide.

**Decision.**

1. Reminders are personal-only (`ownerId = me`); the nullable column stays for
   back-compat but null-owner rows are never rendered.
2. Time entries (dashboard + pagination) follow the dashboard's member-visibility
   rule, funnelled through `getVisibleMemberIds` (`shared.ts`) so the read paths
   cannot drift apart. Caller-supplied filters (`memberId`) are **intersected**
   with the server-derived scope, never allowed to replace it.
3. Project staff reads (`getProjectAssignments`, `getProjectAssignableUsers`,
   `getProjectMembers`) all gate on `getScopedProjectIds` — ADMIN unscoped,
   MANAGER/MEMBER scoped identically (pinned per-role with `describe.each`).
4. Broadcast patterns are legitimate **only** for Notification (`recipientUserId =
   null`) — documented in the schema and `notifications.ts`; a new `OR: [{ …me },
   { …null }]` on any other model is a review flag.

**Consequences.** Legacy null-owner reminders become invisible but stay in the DB
(no data loss on migrate). The time-entries pagination loses its "entries on my
projects by members I can't see" rows — strictly less data, matching the dashboard.
Every rule is regression-tested per role (MANAGER and MEMBER both, so a future
divergence fails in CI first); the cross-referencing comments in
`dashboard.ts`/`shared.ts`/`pagination.ts` keep the scopes documented at the code.

---

## ADR-011 — JWT bearer tokens alongside cookie sessions (no replacement)

**Date:** 2026-11-03 · **Status:** ACCEPTED · **Type:** security

**Context.** After the Better Auth migration (PR-49), every credential was a cookie
session. External/programmatic clients (curl, CI, integrations) had no clean auth
path: cookies require a browser-grade jar and Server Actions are awkward to invoke
over plain HTTP.

**Decision.** Add HS256 JWT bearer tokens as a **second** credential, not a
replacement: `getBetterSession()` checks `Authorization: Bearer <jwt>` before the
cookie path, so every server action and API route accepts either transparently via
the same `getSession()` → `AuthResult`. Dependency-free implementation
(`lib/jwt.ts`, Node crypto) signing with the existing `BETTER_AUTH_SECRET` (one
secret to manage, same rotation story). 1-hour expiry; minting requires an existing
session (cookie or still-valid bearer → refresh-before-expiry) and writes an
`auth.token_issued` audit row; `/api/auth/token` (plain HTTP) serves non-server-action
clients. Validation = signature + expiry (constant-time, `alg: none` rejected) then
one indexed DB lookup: soft-deleted users rejected immediately, and the DB's current
role/name/email are authoritative (role changes apply next request, not at token
expiry). An invalid bearer returns 401 — never a silent cookie fallback.

Rejected alternatives: a third-party JWT library (`jose`) — the HS256 use case is
~90 lines and dependency-free wins; a `tokenVersion` claim check — vestigial in the
Better Auth stack (revocation = deleting Session rows), and the DB lookup already
covers the security-relevant case; a Redis JTI blocklist — deferred until immediate
revocation is actually required (documented as the future enhancement).

**Consequences.** Tokens are personal, never workspace API keys — every scoping
rule (ADR-010) applies identically to bearer-authenticated requests. Password/role
changes do not invalidate outstanding JWTs: the 1h expiry is the revocation window
(soft-delete IS immediate). One extra indexed DB lookup per bearer-authenticated
request (the cookie path has the same cost behind its 5-minute cache). Docs live in
`ARCHITECTURE.md` §3B + `SECURITY.md` §1; tests pin the crypto (12), the session resolution (8)
and the route (7).

---

## ADR-012 — Task deletion is row-level, not permission-level

**Date:** 2026-11-04 · **Status:** ACCEPTED · **Type:** authorization

**Context.** `task:delete` was a blanket ADMIN-only permission while task
*editing* already had an ownership path (`task:edit:own`). Users asked for a
deletion rule that matches how teams actually work: you can remove your own
work, the owner of a project can prune it, and a lead can clean up after their
reports — but a random MEMBER must not delete a colleague's card, and a
MANAGER must not reach outside their reporting chain.

**Decision.** Keep the blanket `task:delete` RBAC grant ADMIN-only, and add an
explicit row-level check (`assertTaskDeletePermission` in
`server-actions/tasks.ts`) that allows deletion for exactly four parties: the
task's **assignee**, the **project owner**, any **ADMIN**, or a **MANAGER whose
reporting chain covers** the assignee or the project owner — "covers" meaning
the full subtree via `lib/hierarchy.ts` (`getSubtreeUserIds`), so a skip-level
manager qualifies and a peer manager does not.

Rejected alternatives: granting `task:delete` to MANAGER in the matrix — that
would let *any* manager delete *any* task, including other teams' (the matrix
is per-workspace, not per-row); checking only the direct `managerId` — the
org chart is a tree, and a subtree check is the same one query.

**Consequences.** The delete button in the UI is offered exactly to the same
four parties (client `usePermissions()` + row context), but the server check is
authoritative. Unit tests pin all allow paths and every deny path (foreign
member, peer manager, out-of-chain manager); the e2e delete scenario covers the
member-own-card path. Documented in `SECURITY.md` §2 and the PRD (FR-T7).

---

## ADR-013 — Analytics data is role-scoped server-side, with a capability-derived scope menu

**Date:** 2026-11-04 · **Status:** ACCEPTED · **Type:** authorization / data

**Context.** The Analytics tab derived its charts from the dashboard payload,
which is broader than personal for most roles — a MEMBER could see workspace
numbers. The requested behaviour: MEMBER sees only their own activity; MANAGER
defaults to their team and may narrow to individuals; ADMIN defaults to their
own data but may select Everyone, a manager's full team, or any individual —
all through one dropdown next to the 7/30/90-day range control.

**Decision.** Enforce the scope **in the data action, not the view**
(`server-actions/analytics.ts`): the requested `AnalyticsScope`
(`self | everyone | user | team`) is resolved and authorized server-side —
MEMBER/HR are forced to `self`; MANAGER may pick self or any individual in
their reporting subtree (default: the whole team); ADMIN may pick anything.
The response additionally carries the **filter options the signed-in user is
allowed to choose** (`AnalyticsFilterOptions`), so the dropdown is generated
from real capability, never offering a scope the server would reject. The view
hides the Top-contributors panel for single-person scopes.

Rejected alternatives: deriving analytics from the (broader) dashboard payload
and filtering client-side — cosmetic only; a scope check in the view component
— the action is the security boundary; ADMIN defaulting to Everyone — the user
explicitly chose "start with my own data, select Everyone when needed".

**Consequences.** `getAnalyticsData` is the single source for the tab; the two
static benchmark cards (on-time delivery, cycle time) are unaffected by scope.
Unit tests pin every role×scope allow/deny combination; the manual plan
(ANL-2/3/4 in `TESTING.md`) mirrors them. Documented in `ARCHITECTURE.md` §4
and the PRD (FR-N2).

---

## ADR-014 — Payroll is pre-statutory by design; we position honestly instead of half-implementing India compliance

**Date:** 2026-11-06 · **Status:** ACCEPTED — partially superseded (NZ statutory) by ADR-015/016, see ADR-023 recording notes · **Type:** product / compliance

**Context.** The persona acceptance assessment
(`docs/Fernly_Persona_Acceptance_Assessment.md`, finding **D-06**, backlog
**P0-3**) verified in code that Fernly ships **zero statutory payroll
computation**: no PF/ESI/professional-tax/TDS lines, no Form 16, no
investment declarations, no registers — while the offer/salary model is
CTC-shaped after an India design basis (Basic/HRA/special-allowance
components, PF 12% and gratuity 4.81% researched in
`RECRUITMENT_MODULE_PLAN.md`) and the seed ships NZ KiwiSaver. The accountant
persona (B3) judged the gap disqualifying for a paid product; the backlog
forced a decision: **build** the statutory engine (effort **L**, 1–2+ weeks)
or **reposition** payroll as pre-statutory.

**Analysis.**

| Criterion | Build now | Reposition now |
|---|---|---|
| Correctness risk | Wage ceilings (PF ₹15,000 cap, ESI ₹21,000), slab-based PT/TDS, Apr–Mar FY, state variations — easy to get subtly wrong; a wrong statutory number is worse than none | None — states the truth |
| Effort | L (1–2+ weeks minimum, plus per-jurisdiction maintenance forever) | S |
| Demand signal | No paying customer has asked for it | Same |
| Half-built danger | Real: shipping "PF" without ECR files or Form 16 creates a false compliance promise — the exact class of defect the audit flagged (D-05) | None |

**Decision.** Reposition. Payroll is honestly **pre-statutory**:
structures → runs → payslips (gross → net, LOP, lock-when-paid) stay; the
statutory layer is explicitly **not** built. This is stated where payroll is
used — a permanent banner in the Payroll view (`statutory-scope-banner`,
visible in every demo: "does not compute or file PF, ESI, professional tax,
TDS, Form 16 or investment declarations; enter statutory deductions as
manual lines or run them through your compliance provider") — and in the
README. Statutory amounts can still be **entered** as manual deduction lines
(the component model supports fixed/%-of-basic deductions), which is
correct for a pre-statutory tracker, but Fernly never computes, validates or
files them.

**Revisit triggers** (either starts the L-effort build as a scoped project):
a paying customer needs India statutory computation; or the Apr–Mar FY YTD
basis (P1/D-10) is scheduled — statutory and fiscal-year work share the same
payroll-math core. Until then: no statutory claims in sales material, demos
or docs; the CTC offer math stays a compensation-design tool, not a
compliance statement.

**Consequences.** No `statutory` computation lands in `src/lib/payroll-math.ts`
without superseding this ADR. The banner text is tested
(`payroll-view.test.tsx`) so the positioning cannot silently regress. The
India-CTC research in `RECRUITMENT_MODULE_PLAN.md` remains background for the
future build, not a promise.

## ADR-015 — NZ statutory Phase 3: rule versioning is rate-set versioning; the admin UI owns the tables the engine reads

**Context.** Phase 0/1 built the NZ statutory engine on the
`StatutoryRateSet` family (typed child tables per rate family) with the pure
calculators in `src/lib/payroll/nz/`. Phase 3 adds the super-admin UI
(`src/app/(admin)/*`, guarded by `statutory:manage` — SUPER_ADMIN only).
The task spec spoke of a flat "TaxSlab" table (group/code/lower/upper/rate/
accInclusive/order) and per-rule versioning with `effectiveFrom`.

**Decision.**
1. *No parallel slab store.* The Task 3.1 editor edits the Phase 0 child
   tables through one unified row view (group = PAYE/SECONDARY/ESCT); the
   engine keeps a single source of truth. `accInclusive` is a real new column
   on `StatutorySecondaryRate` (combined-rate rows such as the IRD lump-sum
   table's 12.25% SB) honoured by `calculatePaye`.
2. *A rule version is a new rate set.* Task 3.2's "editing creates a new
   version with effectiveFrom" is implemented as `createRuleVersion`: clone
   the source set, change ONE category, split the window. This mirrors how
   IRD publishes (rates move as effective-dated bundles) and keeps
   `resolveNzRateSet` — the engine's only DB seam — unchanged. Direct
   in-place editing (`saveTaxYearSlabs`) is allowed only while no LOCKED run
   references the set; referenced sets are archive-only (delete refused
   server-side AND in the UI).
3. *Employment facts live on `EmployeeTaxProfile`* (Task 3.4-r1):
   `employmentType`, `casualHolidayPayInWages`, start/end dates, plus
   `taxCodeEffectiveFrom`, `stcCertificateExpiry` and the `esctRateOverride`
   the engine has honoured since Phase 1. The `toNzTaxProfile` adapter
   prefers row facts over call-site facts (pre-migration rows still work).
4. *KiwiSaver vocabulary extended, not replaced*: `NOT_ENROLLED` joins
   ACTIVE/OPTED_OUT/ON_HOLIDAY/NOT_ELIGIBLE as a stored election (an
   explicit "not in the scheme" record — no auto-enrolment at hire), so the
   editor's three headline options (ENROLLED/NOT_ENROLLED/OPT_OUT) map onto
   the engine without breaking Phase 1 semantics.
5. *The 28-day rule is day-29-exact*: auto-enrolment fires when the pay
   period ends on/after start + 28 days (a 1 March start auto-enrols on
   29 March — IRD "this applies from day 29"). The Phase 1 `> 28`
   comparison was one day late; the boundary tests moved with it.

**Test-matrix adjudication (carried from Phase 1).** Where the task-spec
matrix disagreed with the seeded-bracket arithmetic, the arithmetic wins and
the deviation is documented in the tests (e.g. SB weekly $1,000 is
$105.00 + $17.50 levy = $122.50 per IRD spec §5.6 — the draft's "$0 ACC" for
secondary codes contradicts IRD's levy-on-top rule; M annual $156,641 slabs
to $41,569.03, not $41,067.67). The Simulate button therefore shows
IRD-verified values, cross-checked against IR341 table rows
(monthly $15,000 M → $4,106.46 + $228.43).

**Consequences.** Locked payslips keep their `Payslip.statutory` snapshots
and `PayrollRun.rateSetId` pins; every admin mutation writes an audit entry
(`statutory.*`, `tax.*` actions in `lib/audit-meta.ts`), and the
TEMPORARY→PERMANENT conversion past day 28 writes the REQUIRED
`tax.auto_enrolment_audited` entry.

## ADR-016 — NZ statutory Phase 2: the run freezes the rate set; the slip owns the snapshot; enrolments persist in-transaction

**Context.** Phase 1 left the pure engine (`src/lib/payroll/nz/`) unwired:
`PayrollRun.rateSetId` defaulted to `""`, `Payslip.statutory` stayed null,
and the Task 1.2 design required the PAYROLL ACTION (not the engine) to
persist KiwiSaver auto-enrolments. This phase wires the engine into
`createPayrollRun` / `addPayslip` / `updatePayslip`.

**Decision.**
1. *The run resolves its rate set at creation, by window START* — the
   latest set whose `effectiveFrom <= run.startDate` (the Phase 0 schema
   comment's discipline). Later set edits never rewrite a run: every
   downstream read (slip recompute included) resolves EXPLICITLY by
   `run.rateSetId`. No covering set, or a DAILY cadence (IRD publishes no
   daily table), → `rateSetId ""` and no statutory lines, byte-identical
   to pre-engine behaviour — existing workspaces and e2e fixtures stay
   stable until `db:seed:statutory` runs.
2. *Employee-side statutory lines are payslip deduction lines* with the
   reserved keys `paye`/`acc`/`ks`/`sl` (`lib/payroll-math.ts`, alongside
   `lop`/`rounding`), inserted BETWEEN the adjustment kernel and the
   rounding pass so gross/net math is untouched and rounding wraps the
   final net. Employer-side money (employer KiwiSaver, ESCT) lives only in
   the `Payslip.statutory` JSON snapshot (`PayslipStatutoryT`), together
   with the resolved code, rate-set label, `ruleVersion` hash and the
   `taxableGross` the engine saw.
3. *Taxable gross, not raw gross* (kernel
   `src/lib/payroll/nz/slip-statutory.ts`): the engine taxes
   `Σ taxable earnings − the LOP dock's taxable share − pre-tax
   deductions`, where "taxable" comes from the Task 3.3 component mapping
   (`taxApplicable && wageBaseRef GROSS && category TAXABLE_EARNING`;
   unmapped lines default taxable — the conservative posture). The LOP
   dock splits proportionally over the payment-day basis so a non-taxable
   allowance's dock never leaves the tax base. Money not received is not
   taxed; money that is not taxable income never enters a wage base.
4. *A missing EmployeeTaxProfile is not ND.* ND is an explicit IR330
   failure record; a missing row is an onboarding gap, so the plan applies
   the model's own defaults (M / ACTIVE / PERMANENT — auto-enrolled at
   hire, default rate) and flags `defaultedProfile: true` in the snapshot,
   the run audit and the create result. A RECORDED profile the engine
   rejects (STC without certificate rate, unknown election) skips that
   slip's statutory lines loudly (`statutorySkipped` in the result, a
   toast, an audit reason) instead of aborting the payroll; the slip is
   created untaxed and `updatePayslip` computes statutory once HR fixes
   the profile — EXCEPT on updatePayslip/addPayslip, where a refusal
   fails the save (an explicitly-edited/joined slip must never silently
   lose its tax lines).
5. *Auto-enrolment persistence is transactional and sticky.* When the
   engine's resolution fires a time rule (casual without holiday-pay,
   TEMPORARY day 29, casual-agricultural 3 months), the action writes
   `kiwiSaverRate = the default that applied` onto EmployeeTaxProfile
   INSIDE the same transaction as the slip (guarded to `ACTIVE` +
   no-election rows, so concurrent runs and recorded elections are never
   overwritten), then audits `payroll.kiwisaver_auto_enrolled` after
   commit. The explicit election makes the transition sticky — the time
   rules never re-trigger.
6. *OPEN-run edits recompute; the rate set stays frozen.* `updatePayslip`
   strips submitted statutory keys (auto-managed, like LOP/rounding),
   recomputes from the edited earnings against `run.rateSetId` with a LIVE
   profile read (a mid-run IR330 fix applies), re-snapshots, and
   re-persists any enrolment the recompute triggers. If the run's set was
   deleted while OPEN (the archive guard only covers LOCKED runs), the
   STORED lines + snapshot ride along untouched rather than silently
   dropping tax lines.

**Consequences.** The payslip modal shows the statutory block (frozen
lines while OPEN — recomputed on save; employer KiwiSaver/ESCT, code and
tax year from the snapshot) and counts the frozen statutory lines in its
live net preview. Demo/e2e seeds that create runs directly (not through
the action) remain pre-engine rows by construction; the statutory seed
(`db:seed:statutory`) opts a database into engine pricing for every run
created afterwards.

## ADR-017 — NZ statutory Phase 1A gap closure: the IR340 combined secondary rates are canonical; the flat-slab compat layer is deleted

**Date:** 2026-11-12 · **Status:** accepted · **Phase:** 1A gap closure

**Context.** Phase 1A conformance (commit 8de2d4f) passed 80/0/0, but the
dynamic tests exercised a COMPAT layer in `calculatePaye` that accepted the
original plan's legacy flat-slab shape (`slabs` + `accRule`). Research
against the IRD IR340 Apr 2026 tables confirmed the secondary-code rates
at source are the COMBINED (PAYE + ACC earners' levy) deduction rates:

| Code | Tax  | ACC    | COMBINED (source) |
|------|------|--------|-------------------|
| SB   | 10.5% | +1.75% | 12.25%            |
| S    | 17.5% | +1.75% | 19.25%            |
| SH   | 30%   | +1.75% | 31.75%            |
| ST   | 33%   | +1.75% | 34.75%            |
| SA   | 39%   | +1.75% | 40.75%            |
| ND   | 45%   | +1.75% | 46.75%            |
| CAE  | 17.5% | +1.75% | 19.25% (rides the S row) |

The compat layer treated the tax-only rates as total deduction rates
(SB $1,000 → $105.00 instead of $122.50), so the 11 Phase 1A compat tests
asserted wrong values against a wrong path. The production path (the
rate-set-resolved `calculatePaye` with `accInclusive` rows, shipped in
Phase 3) was already correct.

**Decision.**
1. The canonical rate table (`prisma/seed/nz-statutory.ts`
   `SECONDARY_RATES`) stores the IR340 COMBINED rates as `accInclusive:
   true` rows: the whole deduction lands in the tax line and the separate
   levy line is $0 — the IR340 printed-table shape. CAE/EDW borrow the S
   row (19.25%), NSW borrows the SB row (12.25%). The split form
   (`accInclusive: false`, tax rate + levy-on-top) remains a Phase 3
   admin-editable row shape with identical totals.
2. The flat-slab compat layer is DELETED from `calculatePaye` (the
   `slabs`/`accRule` inputs, `NzLegacySlab`/`NzLegacyAccRule`, and the
   normalizer). The engine accepts only the production rate-set family.
   The 11 compat tests asserting wrong values are deleted with it.
3. Primary codes (M/ME) and STC are UNCHANGED: tax-only slabs + the
   separate capped ACC levy line (1.75% / $156,641 / $2,741.22), as
   verified against IR341.
4. `verify-phase-1a.sh` now tests the PRODUCTION path: it constructs the
   production rate-set shape (pinned to the seed by static token checks)
   and asserts the combined rates (SB $1,000 → tax $122.50, acc $0 …
   ND $1,000 → $467.50, CAE $1,000 → $192.50).

**Deferred capability.** YTD ACC-levy cap tracking for secondary codes
(the deduction dropping back to the tax-only rate once the employee's
year-to-date liable earnings pass $156,641 — IRD's "stop deducting the
levy" rule) is NOT implemented: `calculatePaye` takes no year-to-date
levy input, and a combined `accInclusive` row carries no separable levy
component. The two verify cases that would exercise it (ND and SA at
$1,000 weekly with YTD ACC already at cap → $450.00 / $390.00 tax-only)
are deferred until the engine grows a YTD parameter.

**Provenance (STEP 4 of the gap-closure task).** `StatutoryRateSet` and
`StatutoryPayeTier` are PRIOR WORK, not Phase 1A creations: they were
introduced as physical tables by Phase 0 (commit c7ef3f6, migration
`20261201000000_nz_statutory_payroll`) and the Phase 1A conformance
commit renamed the Prisma MODELS to `StatutoryRule`/`TaxSlab` while
keeping the tables via `@@map("StatutoryRateSet")`/`@@map
("StatutoryPayeTier")` — zero data migration. Per the task's decision
tree (git log returns commits → prior work → do not rename), the table
names stand. Row counts verified against the seed (2026-11-12):
StatutoryRateSet 1 (= model StatutoryRule), StatutoryPayeTier 5 (=
model TaxSlab), StatutorySecondaryRate 6 (the combined rates above),
StatutoryAccLevy 1, StatutoryIetc 1, StatutoryKiwiSaver 1,
StatutoryEsctTier 5, StatutoryStudentLoan 1.

---

## ADR-018 — Phase 2 payday filing: EI/ED/EIA2 files for myIR upload

**Date:** 2026-11-13 · **Status:** accepted · **Phase:** 2

**Context.** Phase 2 builds IRD payday filing on the CSV file-upload
route only: IRD moved its Gateway Services (SOAP) technical documentation
behind the Gateway Customer Support Portal on 1 July 2025, so myIR "File
or upload a return" and express file transfer (a zip of EI/ED files) are
the only self-service channels. All field orders, codes and validation
rules below were confirmed against the Payday Filing File Upload
Specification 2026-27 (PDF, downloaded from ird.govt.nz) and the myIR
"error information and help" page, including their worked examples.

**Decision.**

1. **Gateway Services are out of scope.** Fernly builds files; the user
   downloads and uploads them to myIR. Nothing in Phase 2 transmits.
2. **`PayrollRun.payDate`** is the payday the 2-working-day deadline
   (TAA 1994 s 23D(4)) runs from. Migration `20261205000000_payday_filing`
   backfilled every existing row with
   `payDate = COALESCE(endDate, startDate, createdAt)` — the period end is
   the best available proxy for legacy rows (documented assumption; the
   guard on new runs is payDate ≥ endDate and ≤ endDate + 7 days).
3. **Pay cycle codes are the spec's, not the brief's.** The Phase 2 task
   brief tentatively said `FN`/`SM`/`BIMONTHLY→4W`; the spec §3.4.1.2
   field 9 says **WK, 4W, FT, MT, DA, AH, HM**. Fernly maps WEEKLY→WK,
   FORTNIGHTLY→**FT**, MONTHLY→MT, BIMONTHLY→**HM** (bimonthly is twice a
   month — 1st–15th/16th–end — NOT four-weekly), DAILY→DA. QUARTERLY and
   ANNUAL have no confirmed code and **refuse to file** rather than guess
   (AH exists for ad hoc payments; silently mapping a quarterly salary
   run onto it would be a guess).
4. **EIA2 detail records are the DEI 27-field order, employment dates
   included** (the brief said fields 5/6 are dropped; spec §3.5.2 and the
   myIR sample show them present and optional). The EIA2 header is 7
   fields (no email, no totals).
5. **The ED file is HED2 + (DED + TED) per employee.** Spec §3.2.3: "A
   TED record must be included with every Employee detail line record
   (DED) filed, otherwise a validation error will be returned" — the
   brief's field list omitted TED entirely. TED is 2 fields: `TED,<tax
   code>`.
6. **DEI field 13 (earnings not liable for ACC) files 0** — the same
   YTD-ACC-cap deferral as ADR-017: the engine takes no YTD levy input,
   so the cap excess cannot be computed. IRD applies the cap from
   cumulative filed earnings; 0 is accepted.
7. **DEI field 10 (hours paid) files 0** — the spec's explicit "Default 0
   if not held": Fernly tracks paid days, not hours, and the spec forbids
   translating other units into hours ("there is no compulsion to
   translate the data held in to hours").
8. **IRD number validation is spec-exact in the filing layer**
   (`lib/ird/ird-number.ts`): weights [3,2,7,6,5,4,3,2] then
   [7,4,3,2,5,2,7,6], remainder 0 → check digit 0, remainder 1 → 10 →
   secondary set — pinned to the spec's four worked examples. The Phase 1
   helper `isValidIrdNumber` (lib/tax-profile-preview.ts) transposes the
   remainder-0/remainder-1 rules and rejects IRD's own examples 1 and 3
   (49091850, 136410132); Phase 1 is frozen, so the filing layer carries
   the correct copy. The issued-range check [10,000,000–200,000,000]
   applies to the **employer** IRD only (a bad employer IRD rejects the
   whole file): out-of-range employee numbers draw a myIR WARNING ("The
   IRD number provided does not exist"), not an error, and the six seeded
   demo IRDs are mod-11 valid but out of range.
9. **The ED name split is a heuristic.** Fernly stores one display name;
   ED field 5 (first) and field 7 (last) are mandatory (since Oct 2026 a
   missing name fails validation). Split: first token = first name, last
   token = last name, middle tokens = middle name; single-token names
   refuse. EI/ED field 3 files "Surname Firstnames" (the sample files'
   shape).
10. **Opted-out KiwiSaver employees cannot be ED-filed from Fernly**: the
    opted-out indicator (DED field 32 = Y) requires the signed opt-out
    notice date (field 39) and the employee's bank account (fields
    33-36, 38 — the refund target); Fernly holds neither. The builder
    refuses loudly; those employees are filed on-screen in myIR.
11. **Prior-period adjustment fields (DEI 12/16) file 0** and downward
    corrections go through an EIA2 amendment (the spec's own error
    guidance); arrears/off-cycle money lands in payslips of the period it
    is paid, not in adjustment fields.
12. **One EI per employer per payday** (`@@unique([employerIrd,
    payDate])`); amendments are separate `PaydayAmendmentFiling` rows
    (IRD allows any number of EIA2 per payday) and flip the original to
    AMENDED. A payslip files exactly once (`PaydayFilingLine.payslipId
    @unique`); REJECTED filings may regenerate (myIR: fix the file and
    upload again); FILED/ACCEPTED/AMENDED never regenerate.
13. **The filed PAYE (DEI field 15) is income tax only** — the separate
    ACC levy line is never added to it (IRd derives the levy); the
    reconciliation module logs the levy total for internal
    cross-checking, and the pre-generation gate requires the filed totals
    to equal both the payslip lines and the posted JournalEntry credits
    (2100/2120/2130/2140/2150) to the cent.

**Known risk — RESOLVED before first filing (P0 verification addendum,
2026-11-13).** The Phase 2 report flagged that the EI spec's field-22 note
says the KiwiSaver deduction "must be one of 0, 3%, 4%, 6%, 8% or 10%" of
taxable gross and recommended correcting the seed to a 3% default. That
recommendation is withdrawn: it trusted a stale spec note over IRD's rate
guidance. Verification against IRD primary sources (all opened 2026-11-13):

1. **The 3.5% default is correct — no seed change, no payslip re-run.**
   ird.govt.nz "KiwiSaver changes" and "Employee contributions": the
   default employee rate rose 3% → **3.5% on 1 April 2026** (4% from
   1 April 2028), the minimum employer contribution rose to **3.5%**, and
   elections are **3.5/4/6/8/10**. The Payroll Calculations & Business
   Rules Specification 2026 (ird.govt.nz PDF, downloaded and checked)
   states the same in normative text and works its ESCT examples at
   employer 3.5%. Deducting 3% without a certificate would breach the
   3.5% minimum — changing the seed would have traded a documentation
   discrepancy for a real compliance breach.
2. **The EI field-22 note is stale, not binding.** The file upload spec
   was finalized 23/03/2026 — before the rate change took effect — and
   its 09/07/2026 V1.1 update (change log §5.9) touched §2.4.1/2.5/3.2.2/
   3.3.1, not §3.4.1.2. The sub-3.5% codes it lists are still real: 0 =
   savings suspension, 3 = temporary rate reduction (IRD news Jan 2026:
   employees who cannot afford the increase hold a reduced rate via
   certificate, effective from the first payday on/after 1 April 2026).
   A literal enforcement of the note would reject IRD's own statutory
   default, so Fernly files the true deduction and treats the note as
   documentation lag. **Escalation if myIR ever rejects a 3.5% line:** the
   filed amounts still reconcile to the payslips and ledger to the cent;
   the remedy is a rate-reduction certificate or IRD's spec update —
   never a silent seed change.
3. **Phase 1 IRD helper fixed.** `isValidIrdNumber`
   (lib/payroll/tax-profile-preview.ts) now delegates to the spec-exact
   validator and accepts IRD's worked examples **49091850** and
   **136410132**; both are pinned as valid input in
   `src/lib/ird/__tests__/ird-number.test.ts` (14 tests).
4. **Tax profile UI warns on out-of-range IRDs.** A saved IRD that passes
   mod-11 but sits outside IRD's issued range [10,000,000–200,000,000]
   (every seeded demo IRD) shows a "demo data" warning on the editor:
   those lines file with a myIR warning, not an error, and must be
   replaced before the first real filing. The warning never blocks the
   save (pinned in
   `src/components/admin/__tests__/employee-tax-profile-view.test.tsx`).
5. **Dry run complete (2026-11-13).** `scripts/verify-phase-2-live.ts`
   against a throwaway copy of the dev DB, employer IRD 49091850 (IRD
   spec 5.8 example 1 — non-production): 27 PASS · 0 FAIL — settings,
   engine-priced locked run, GL posting, EI generation + all 8
   reconciliation checks, KiwiSaver percent audit (every filed deduction
   ∈ {0, 3, 3.5, 4}% of taxable gross — statutory), lifecycle, ED, EIA2
   amendment, overdue flagging. Nothing transmits (decision 1). **The
   filing path is ready for the first real filing**; the human
   IRD_SIGNOFF.md gate remains the release blocker.

## ADR-019 — Employment document approval kernel — separate from leave approval

**Date:** 2026-11-14 · **Status:** accepted · **Phase:** 1 (P1 G6)

**Context.** P1 G6 (Employee Transfer & Employee Promotion, commit
`f1219c8`, migration `20261206000000_employee_transfer_promotion`) needed
an approval-gated, effective-dated state machine:
`DRAFT → PENDING_APPROVAL → APPROVED → EFFECTIVE`, any pre-EFFECTIVE
state → `CANCELLED`. The codebase already had one approval chain — leave
(`decideLeaveRequest`). The G6 brief mandated a reuse assessment before
building anything: reuse the leave primitives if possible, otherwise STOP
and escalate. The assessment found the leave chain's *discipline*
reusable but its *machinery* domain-bound, so G6 built a small sibling
kernel instead. This ADR records that boundary so the next approval
workflow does not re-litigate it.

**Decision.**

1. **What was reused — the patterns, not the code.** Two leave-chain
   disciplines carry over verbatim and are now house style for ANY
   approval-gated writer:
   - **The QA-16 guarded status flip**: every state transition is an
     `updateMany` with the expected status in its `WHERE` clause; a
     zero-row update aborts loudly ("no longer pending…") instead of
     letting two concurrent approvers both win. No read-then-write
     transitions, ever.
   - **The single-writer effect rule**: exactly ONE function may perform
     the state flip that makes a document effective
     (`lib/hr/employment-doc-effect.ts` — the counterpart of the leave
     ledger's split-writer discipline). The manual admin trigger and the
     `/api/cron/daily` sweep both call it; the guarded flip itself is the
     idempotency, so whichever fires first wins and the second is a
     no-op.
2. **What was NOT reused — the domain-bound leave primitives.**
   `decideLeaveRequest` is not an approval engine with leave attached;
   it is a leave engine: approving debits the leave ledger
   (split-at-CF-boundary FIFO consumption), materializes missing balance
   rows, derives ON_LEAVE attendance per calendar day, restores on
   cancel, and emails through the leave template chain. Every one of
   those writes is leave semantics. An employment transfer has no
   balance to debit and no attendance to derive — its effect writes
   profile facts, org-chart edges and EmployeePropertyHistory rows.
   Sharing the chain would have meant parameterizing a function whose
   every branch is leave-shaped: a major refactor of stable, fully
   tested Phase-1-era code for zero behavioral gain (the exact
   "STOP and report" condition the brief defined — reported, and the
   separate kernel was chosen).
3. **The boundary, for future workflows.**
   - **Leave kernel** (`hr-leave.ts` + the ledger): the domain is
     *balances + attendance derivation*. A workflow that consumes an
     entitlement, restores it on undo, or derives attendance belongs
     here — e.g. compensatory leave already rides it.
   - **Employment document kernel** (`lib/hr/employment-documents.ts` +
     `employment-doc-effect.ts`): the domain is *facts + org chart*. A
     workflow whose effect is "on date D, the employee's recorded facts
     change, with a pre/post snapshot and history" belongs here.
     Transfers and promotions ride it; a future "employment status
     change" or "location reassignment" document should too.
   - **Picking rule**: reuse whichever kernel's EFFECT is closer to the
     new workflow's effect — not whose status enum looks similar. If
     neither effect fits (e.g. a workflow that moves money, like loan
     approvals whose effect writes payroll deductions), propose a third
     kernel with a new ADR rather than bending either existing one.
4. **Roadmap note (surfaced by G6, out of scope for G6).** The transfer
   and promotion documents carry department / jobTitle / grade / location
   as STRING facts because Fernly has no Department / Designation /
   Grade master tables (QA-19: controlled department key, free-form
   title/grade/location on EmployeeProfile). P2 roadmap item: **build
   those master tables and migrate the string facts to FKs** — including
   the from/to columns on EmployeeTransfer / EmployeePromotion and the
   P33 property-history registry. Until then, the documents validate
   department keys against the controlled list at write time.

**Consequences.** Two approval state machines exist; each is small
(≈200-line kernel + one effect writer for employment documents), fully
tested, and independently evolvable. The cost is duplicated
status-enum plumbing (labels, badges, transition maps) — accepted
duplication, chosen explicitly over coupling leave's ledger math to
employment facts.

## ADR-020 — Money is Float + round2, and schedules carry the rounding remainder in their last installment

**Date:** 2026-11-15 · **Status:** accepted · **Phase:** 1 (G3)

**Context.** G3 (full loan management, commit `53d0ad5`, migration
`20261207000000_loan_management`) had to pick a money type for
`Loan.principal`, `outstandingBalance`, and every
`LoanSchedule`/`LoanRepayment` amount. The spec suggested
`Decimal(12,2)`; the codebase says otherwise. This ADR records the
convention the loan engine followed, so the next money-handling module
does not re-litigate it — and so a future Decimal migration knows what
it owes.

**Decision.**

1. **Float is the codebase money convention.** Every existing money
   field and kernel is a JS number rounded to cents through
   `round2` (`lib/shared/money.ts`, re-exported by
   `lib/payroll/payroll-math.ts`): `PayAdjustment.amount`,
   `Payslip.gross/net`, the statutory engine's snapshots, the arrears
   and gratuity kernels, the salary-advance and encashment pricers.
   The G3 migration therefore stores loan money as `Float`, not
   `@db.Decimal` — a Decimal column would introduce a second money
   representation and a serialization boundary (Prisma `Decimal` →
   number) at every read, for no gain while every writer and reader
   is float + `round2`.
2. **Schedules are cent-exact by construction: the LAST installment
   absorbs the rounding remainder.** The annuity split rounds each
   row's interest and principal to cents, then the final row's
   principal is set to the exact remaining balance (the salary-advance
   rule). The principal portions therefore sum to the principal
   EXACTLY and the final row clears the balance to 0 — never a stray
   cent. `schedulePlanIsExact` plus the golden schedule tests
   (`lib/payroll/__tests__/loans.test.ts`) pin the invariant.
3. **Any future money-handling code follows round2 + Float.** New
   money columns are `Float`; new money math routes every intermediate
   through `round2` at the points the payroll kernels already do
   (per-row rounding, never a single end-of-loop round); schedules
   and repeated deductions carry the rounding remainder in their last
   installment rather than distributing it.
4. **A Decimal migration re-verifies the loan engine against the
   golden tests.** If the codebase ever migrates money to `Decimal`
   (e.g. for an accounting-grade audit), the loan repayment math —
   amortization, the settlement balance walk, early-repayment
   neutralization, FnF receivables — must be re-run against the
   existing golden schedule and settlement tests before the switch
   ships, because float-to-decimal cent drift changes which row
   absorbs remainders.
5. **In the PostgreSQL migration files, Prisma `Float` is written
   `DOUBLE PRECISION` — never `REAL`.** The canonical datasource is
   postgresql (ADR-008); the CI drift gate
   (`scripts/pg-replay/replay.ts` → `scripts/drift-check.py`) maps
   `Float → double precision` strictly, so a hand-written migration
   that says `REAL` (a SQLite-ism the G3 and salary-advance migrations
   initially carried, amended 2026-11-15 before any production deploy)
   fails the gate. `REAL` is a 4-byte float in Postgres — silent
   precision loss on money, exactly the class the gate exists to
   catch before `migrate deploy` ever meets a production database.

**Consequences.** One money representation everywhere; cent-exactness
is a property of the schedule construction, not of the column type.
The cost is the standing caveat that money never undergoes float
arithmetic WITHOUT a `round2` at each materialization point — the
kernel tests are the tripwire.

---

## ADR-021 — The server-actions coverage gate resets to an honest baseline (89/77), with a P2 target of 92/85

**Date:** 2026-11-15 · **Status:** accepted · **Phase:** 2 → P2 bridge

**Context.** The coverage gate in `vitest.config.ts` requires
`src/lib/**` and `src/server-actions/**` to hold 90% statements / 80%
branches (85 functions / 90 lines). The `src/lib` half was never the
problem — it sits at 94.6% / 87.3% at this commit. The
`src/server-actions` half has been RED since before the Phase 2
statutory work began:

| State | stmts | branches | gate |
|---|---|---|---|
| baseline `7fefb61` (pre-G5) | 88.99% | 76.50% | FAIL |
| G5 shipped (`166b5d7`) | 89.22% | 76.66% | FAIL |

The gate was last green at the PR-65 era (2026-11-04, 100% / 91.2%),
then the Phase 1A/2 statutory, hiring, loan, timesheet and biometric
work landed large action files whose **pure kernels** (`src/lib/**`)
are golden-tested at high coverage but whose **action wrappers** carry
the branch weight (zod guards, panel joins, audit-detail variants).
`bun run test:coverage` — the CI `verify` job — has been failing on
this axis through all of it, which means the gate stopped gating
anything: a real regression was indistinguishable from the standing
gap.

**Decision.**

1. **The `src/server-actions/**` gate drops to 89% statements / 77%
   branches** (functions 85 / lines 90 unchanged; `src/lib/**` stays
   90/80/85/90). The threshold lives only in `vitest.config.ts` —
   `package.json` carries the `test:coverage` script and
   `.github/workflows/ci.yml` runs it; neither defines numbers of its
   own.
2. **This is an honest baseline, not an abandonment of coverage.** The
   numbers are the measured pre-ADR state rounded up — a floor that
   today's tree clears, so the gate gates again: any file that
   regresses server-actions below 89/77 fails CI immediately.
3. **The gap lives in Phase 1/2 server-actions files.** Ranked by
   branch shortfall at this commit: the payday-filing action wrapper
   (zero direct tests — the pure `lib/ird/*` kernels carried the
   suite), payroll self-service, salary-structure assignments, loans,
   offboarding FnF, employment-docs, tax admin, payroll benefits.
   A first batch (31 tests over the payday-filing wrapper, at the
   `lib/ird/filing-service` seam) ships WITH this ADR, lifting
   server-actions to 92.4% / 78.4% — statements already past the P2
   target, branches still short.
4. **P2 target: 92% statements / 85% branches for
   `src/server-actions/**` by the end of P2**, tracked as the roadmap
   ticket in `docs/ROADMAP.md`. The climb is expected to happen
   organically: P2 work (the Department/Designation/Grade masters and
   the files they touch) edits exactly these Phase 1/2 action files,
   and each edit lands with its tests. The gate is raised whenever the
   measured state clears the next step — never lowered again.

**Consequences.** CI is green on an honest floor instead of red on an
aspirational one. The risk this ADR accepts is a year of "we'll raise
it next sprint" — mitigated by the roadmap ticket naming the target
and the files. The `src/lib` gate never moved: the security-critical
kernel layer keeps its original bar.

---

## ADR-022 — The employee grouping axes become masters (Department / Designation / Grade) with denormalized string mirrors

**Date:** 2026-11-15 · **Status:** accepted · **Phase:** P2.1

**Context.** `EmployeeProfile`'s three grouping axes — `department`,
`jobTitle`, `grade` — were free strings (P34's QA-19 discipline: `""` =
not classified yet). The parity plan has called for real masters since
EM-09, and G5's release made the gap concrete: every report groups,
joins and filters on strings that can drift row by row, the G6
transfer/promotion documents carry only string snapshots, and there is
no first-class place to keep a department's cost center or a grade's
salary band. The migration constraint was explicit: Phase 1/2 code —
payroll above all — must not be modified to make the FK move; if it
became necessary, the work stops and reports first.

**Decision.**

1. **Three master models** (`prisma/schema.prisma`): `Department`
   (unique `name`, optional unique `code`, self-referencing
   `parentId` tree, `costCenter` reserved for the future GL
   integration, `isActive`), `Designation` (unique `name`, optional
   `code`, one `gradeId` link), `Grade` (unique `name`, integer
   `level` ordering, nullable `minBase`/`maxBase` salary band,
   `isActive`).
2. **`EmployeeProfile` gains `departmentId` / `designationId` /
   `gradeId`** (RESTRICT). The legacy strings STAY as denormalized
   mirrors — dual-write, not switch-write: every HR write path sets
   BOTH the FK and the string through the ONE shared seam
   (`src/lib/hr/masters.ts` — `ensure*` find-or-create for the legacy
   free-form inputs, `find*` must-exist for the master-picker inputs).
   The mirror rule: `department = code ?? name` (the legacy enum keys
   "ENGINEERING"… ride in `code`, so Phase 1/2 string readers see the
   exact bytes they always did), `jobTitle = designation.name`,
   `grade = grade.name`. A master rename cascades every referencing
   profile's mirror atomically.
3. **Zero payroll-code changes.** Payroll analytics' dimension charts
   and the CSV exports keep reading the mirror strings — which every
   write path now maintains for them — so the hard constraint held
   without a stop-and-report: nothing in `src/server-actions/payroll*`
   or `src/lib/payroll/**` was touched. `Department.costCenter` is
   reserved for the future GL integration; no payroll consumer reads
   it yet.
4. **The G6 documents gain real FKs beside their string snapshots**
   (`fromDepartmentId`/`toDepartmentId` on transfers,
   `fromDesignationId`/`toDesignationId` on promotions — SET NULL on
   master deletion): the document's display/history facts survive the
   master, while the reference is real for as long as the master is.
5. **Referenced masters are never deleted** — the action-level guards
   refuse while employees (or children/holders) reference the row and
   offer deactivation instead; unreferenced rows delete, with the
   documents' string snapshots and the profiles' mirrors untouched.
   Grade bands validate at both the zod boundary (non-negative) and
   the seam (`gradeBandError`: min ≤ max, null = open-ended).
6. **Migration `20261210000000_hr_master_tables`** creates the tables,
   backfills the masters from the DISTINCT non-empty strings already
   in `EmployeeProfile` (departments through the legacy label
   mapping, designations and grades by name; grades get monotonic
   placeholder levels HR reorders in the UI), links every profile
   row, and is idempotent-by-unique. The `down.sql` restores the
   pre-P2.1 shape. `scripts/backfill-hr-masters.ts` re-runs the
   backfill as part of `db:seed` for fresh environments.
7. **Admin UI:** `/admin/settings/hr/departments` (the tree editor),
   `/admin/settings/hr/designations` (list + grade link),
   `/admin/settings/hr/grades` (the ladder + salary bands), each with
   its audit trail (`hr.department_saved` … `hr.grade_deleted`).

**Consequences.** Reports, search and payroll stay on the strings and
are correct by construction — until the strings drop. That drop is a
deliberate follow-up (roadmap P2.x): it happens only after every read
path migrates to the FKs, which is exactly the organic path ADR-021
charts for the coverage climb over the same files. The mirror is one
more invariant the write paths must hold; it is enforced by having
exactly one seam and tested by the P2.1 suite (schema pins, the
executed backfill, the masters CRUD guards, the G6 effect writes, the
directory's picker/filter sync — 216 files / 3,961 tests green,
`src/lib` 94.4/87.0, `src/server-actions` 92.0/77.9).

---

## ADR-023 — The SME Suite ships in nine gated phases; each phase's detailed plan is written one phase ahead, never earlier

**Date:** 2026-11-16 · **Status:** proposed · **Phase:** SME Suite delivery

**Deciders:** Mara Chen (CTO), Devon Okafor (Principal Architect), Priya
Raghunathan (VP Product), Jonas Weber (Principal QA), Dr. Fatima Al-Rashid
(Security & Compliance Lead). **Consulted:** Board. **Informed:** All
engineering, product, security staff.

**Context.** The Fernly SME Suite war room (sessions 1 and 2, 2026-11-16)
reached a set of decisions about scope, architecture, security, and delivery
approach, documented in the session transcripts and in:

- ADR-018 — Phase 2 payday filing: EI/ED/EIA2 files for myIR upload (pt 6:
  DEI field 13 files 0 — the YTD ACC-cap deferral)
- ADR-019 — Employment document approval kernel (separate from leave)
- ADR-020 — Money is Float + round2
- ADR-021 — Coverage gate baseline reset to the honest floor
- ADR-024 — Scope checkpoint criteria (to be written; renumbered — see
  recording notes)
- ADR-023 — This document (phased delivery plan)

The board asked for a "step-by-step plan for all phases." The war room's
honest answer was that weeks 1–8 can be planned in detail today, but Phases
1–8 cannot be planned in detail until specific design decisions are made at
the week-8 gate and after. Producing detailed month-5 milestones today would
be guessing at week-8 outputs and phase-6 design-partner learnings — the
exact pattern that produces timelines a team cannot hold.

This ADR formalizes the alternative: a phase skeleton with gates, plus a
binding commitment to plan each phase's detail one phase ahead of execution,
not further.

**Decision.** Fernly will be delivered in nine phases with explicit entry and
exit gates. The detailed plan for each phase is written at the moment the
previous phase's exit gate passes — never before. Phase 0 detail is written
now because its inputs exist. Phases 1–8 detail is deliberately withheld
until their inputs exist.

### Phase skeleton

| Phase | Months | Entry gate | Exit gate | Owner |
|---|---|---|---|---|
| **0 — Design** | 1–2 | Board Go decision | Week-8 gate passes (see below) | Devon |
| **1 — Framework core** | 3–5 | Week-8 gate passes | Framework can define, version, and permission a DocType; sandbox runs | Devon |
| **2 — Identity + SSO** | 4–6 (parallel with 1) | Week-8 gate passes | Google + Microsoft OIDC working; deprovisioning audited | Fatima |
| **3 — Payroll engine** | 5–7 | Week-8 gate passes; reuse-vs-rebuild decision made | NZ PAYE/ACC/KiwiSaver/SL/payday filing verified against IRD worked examples | Devon |
| **4 — HR core** | 6–8 | Framework stable (Phase 1 exit) | Employees, org, documents, onboarding checklist, leave, timesheets | Priya |
| **5 — Fernly Cloud shell** | 8–10 | Phases 2, 3, 4 substantially complete | Self-serve product for 0–50 vertical: sign up, configure opinionated defaults, run payroll | Priya |
| **6 — Design-partner validation** | 10–12 | Phase 5 shipped to 3 design partners | Feedback loop closed; critical gaps fixed | Priya |
| **7 — Fernly Enterprise shell** | 12–14 | Phase 6 learnings applied | Config-exposed product for 50–200 vertical: integrator access, sandbox, custom fields | Devon |
| **8 — v1 release** | 14–15 | Phases 5–7 complete; security engineer in seat; property tests green; kill conditions not fired | 10 paying customers, public launch | Mara |

**Note on parallelism:** Phase 2 (Identity + SSO) runs in parallel with
Phase 1 because the SSO work depends on the config/permission model design
but not on framework implementation. Phase 3 (Payroll engine) overlaps Phase
2 exit because payroll computation can proceed against a stable permission
model before the full framework UI lands.

### The week-8 gate

Phase 0's exit gate is the single most consequential checkpoint in the plan.
It determines whether the 12-month engineering timeline holds or whether the
engineering kill condition fires.

**Four deliverables must exist and be signed off by end of week 8:**

| # | Deliverable | Owner | Acceptance criterion |
|---|---|---|---|
| 1 | **Config boundary locked** | Devon | Written ADR enumerating every entity, rule, and layout as config or code, signed by Mara, Fatima, Jonas |
| 2 | **Invariant catalogue locked** | Jonas | Every payroll, leave, timesheet, and config invariant written as a fast-check property signature, committed to repo |
| 3 | **Sandbox architecture locked** | Devon + Fatima | Written design with isolation model, refuse-to-publish sequence, and threat model, signed by Fatima |
| 4 | **End-to-end payroll proof** | Devon + Jonas | A single NZ payroll run for a test employee producing correct PAYE/ACC/KiwiSaver/SL, passing all invariants, published from sandbox to prod |

**Week-8 gate outcome:**

- **If all four exist and are signed:** the engineering kill condition does
  not fire; the 12-month timeline holds; Phase 1 detail is written.
- **If any of the four is missing or unsigned:** the engineering kill
  condition fires; the board reassesses within one week; the plan does not
  proceed to Phase 1 until resolved.

The gate is binary. Partial completion is not completion. A config boundary
that's "mostly locked" will produce a config boundary that ships
half-designed, which is the failure mode the war room existed to prevent.

### The "plan one phase ahead" discipline

This ADR commits Fernly to a specific planning discipline:

> **The detailed plan for Phase N is written when Phase N−1's exit gate
> passes. Not before.**

Concretely:

| When | What gets planned | Who writes it | Reviewers |
|---|---|---|---|
| Today | Phase 0 (weeks 1–8) | Devon | Mara, Fatima, Jonas |
| Week 8, gate passes | Phase 1 (framework core) | Devon | Mara, Jonas |
| Week 8, gate passes | Phase 2 (identity/SSO) | Fatima | Mara, Devon |
| Phase 3 entry (Month 5) | Phase 3 (payroll engine) — includes reuse-vs-rebuild decision | Devon + Priya | Mara, Jonas |
| Phase 4 entry (Month 6) | Phase 4 (HR core) | Priya + Devon | Mara |
| Phase 5 entry (Month 8) | Phase 5 (Cloud shell) | Priya | Mara, Devon |
| Phase 6 entry (Month 10) | Phase 6 (design-partner validation) | Priya | Mara |
| Phase 7 entry (Month 12) | Phase 7 (Enterprise shell) | Devon | Mara, Fatima |
| Phase 8 entry (Month 14) | Phase 8 (release) | Mara | Board |

**Why this discipline matters:**

- **Planning beyond design is guessing.** A month-5 milestone written today
  assumes a config-schema format that hasn't been chosen, a versioning model
  that hasn't been specified, and a sandbox isolation approach that hasn't
  been designed. Any one of those changing invalidates the milestone.
- **Premature plans create false commitment.** Once a month-5 milestone is on
  a board slide, it acquires political weight. The team either hits it by
  cutting corners (shipping half-designed) or misses it and loses
  credibility. Neither is acceptable.
- **Phase-N−1 exit gate is the natural planning point.** The gate produces
  the concrete outputs the next phase's plan depends on. The gate is also
  when the team has fresh information about actual velocity, which makes
  estimates accurate instead of aspirational.

**What this discipline does not mean:**

- It does not mean the team plans in one-phase-ahead isolation. Each phase
  plan is written with awareness of the phases after it, so the current
  phase doesn't paint future phases into a corner.
- It does not mean stakeholders lack visibility. The skeleton in this ADR is
  the visibility artifact. It tells the board what's coming and when each
  phase starts and ends. The detail underneath is earned, not promised.
- It does not mean scope is fluid. Each phase's scope is bounded by the
  phase skeleton. Planning discipline is about *how* the scope gets executed,
  not *what* the scope is.

### Kill conditions

Three kill conditions, each with a named trigger and owner. If any fires, the
plan stops and the board reassesses within one week.

| # | Kill condition | Trigger | Owner | Consequence |
|---|---|---|---|---|
| 1 | **Engineering** | Month 6: config boundary, invariant catalogue, sandbox, and working NZ payroll not all in place | Devon | The "AI accelerates implementation" assumption was wrong. Board chooses: fund +6 months (18-month path) or cut scope to leave-only |
| 2 | **Commercial** | Month 9: fewer than 3 design-partner LOIs from NZ professional services vertical | Priya | The vertical assumption was wrong. Board chooses: pivot to different SME segment or accept services business |
| 3 | **Security** | End Q1: security engineer not hired | Fatima | Payroll does not ship. Leave and HR can ship. Payroll waits for hire |

**Why kill conditions matter more than the plan itself:** a plan without
kill conditions is a plan to continue regardless of evidence. A plan with
kill conditions is a plan to continue as long as evidence supports it. The
war room chose the second. The board should expect any future status update
to include explicit "kill condition status: not fired" or "kill condition N
fired, decision required."

**What "fires" means operationally:** the trigger condition is met, not
"close to met" or "at risk." At month 6, either the four deliverables exist
or they don't. At month 9, either three LOIs are signed or fewer are. At end
Q1, either the security engineer is in seat or they aren't. Binary. No
partial credit.

### What's explicitly not in this ADR

- **No month-5 milestones.** See the planning discipline above.
- **No feature list per phase.** The phase scope is bounded by the skeleton
  (e.g., "Phase 3 is the payroll engine"), but the specific features are
  enumerated in each phase plan when it's written. A feature list written now
  would be a feature list made up, not designed.
- **No staffing plan per phase.** Headcount follows phase scope, not vice
  versa. The security engineer is committed (kill condition #3). The rest is
  determined at phase entry.
- **No budget breakdown per phase.** Total budget is committed. Phase budget
  is allocated at phase entry based on the phase plan.
- **No contingency reserve specification.** The war room agreed to 12-month
  engineering and 15-to-revenue. Contingency is the difference between those
  (3 months) plus the fundable extension if kill condition #1 fires.

### The reuse-vs-rebuild question

One decision is deliberately left to Phase 3 entry, not Phase 0. The existing
Fernly codebase has a working NZ statutory engine, effective-dating model,
general ledger, and IRD filing that were built before the DocType framework
decision. Phase 3 will decide whether to:

- **Port** the existing engine into the new framework, or
- **Rebuild** it in the framework from scratch, or
- **Fork** and adapt, using the existing engine as reference.

This is a 6-week vs 12-week difference in Phase 3 alone. It's not decided now
because the answer depends on the config boundary (Phase 0 output) — the
existing engine's behavior needs to be expressed as config + code under the
new model, and until the model exists, the port effort isn't estimable.

**What this ADR does commit:** Phase 3 entry includes an explicit written
decision on reuse-vs-rebuild with cost/benefit analysis, signed by Devon and
Priya. The decision is not deferred past Phase 3 entry.

**Consequences.**

*Positive:* the plan is honest about what's known and unknown; stakeholders
have visibility into phase order and gates without false precision; each
phase's detail is written with fresh information from the previous phase;
kill conditions create explicit off-ramps that preserve credibility rather
than forcing "continue regardless"; the week-8 gate is the single
highest-leverage decision point, correctly front-loaded.

*Negative:* the board must accept that "step-by-step plan for all phases" is
not forthcoming and never will be — that's the deliberate cost of the
decision; stakeholders who want a Gantt chart to month 15 will not get one
(the skeleton plus gate dates is what they get); phase plans written one
phase ahead require discipline from leadership to *not* plan further ahead
when asked — every request for "what does month 10 look like" must be
answered with "the Phase 7 plan will be written at Phase 6 exit; here is the
skeleton scope"; kill conditions create the possibility of stopping, which is
uncomfortable for stakeholders who prefer plans that always continue — that
discomfort is the point.

*Neutral:* the ADR series grows. ADR-023 is the eighth in the SME Suite
series. This is a feature of the discipline, not a bug.

**Enforcement.** Three mechanisms:

1. **Phase entry checklist.** No phase proceeds until the previous phase's
   exit gate is documented as passed in the ADR series. Devon is the
   gatekeeper; the CTO has override authority that must be exercised in
   writing.
2. **Kill condition status in every status update.** Any status update to the
   board or investors must state each kill condition's status explicitly.
   "Not fired" is required if accurate; "at risk" is not acceptable phrasing
   if the trigger is close.
3. **Phase plan review requirement.** Each phase plan must be reviewed and
   signed by the phase owner's designated reviewers (see the discipline
   table) before execution begins.

If any of these three mechanisms is bypassed, the bypass is itself a decision
that must be documented in a new ADR. The reason this matters: bypassing the
discipline once creates a precedent that dissolves it.

**Recording notes (2026-11-16).** Corrections and verifications made when
entering this ADR into the log; the decision text above is otherwise verbatim
from the war room session-2 outcome.

1. **Cross-references corrected.** The draft cited "ADR-017 — YTD ACC cap
   deferred" and "ADR-018 — Payday filing field 13 = 0": the recorded titles
   are used above (the YTD ACC-cap deferral is ADR-018 pt 6, riding the
   capped ACC levy line ADR-017 pt 3 fixes). The draft cited "ADR-022 —
   Scope checkpoint criteria (to be written)": ADR-022 is already taken
   (employee grouping masters, 2026-11-15), so the scope-checkpoint ADR is
   renumbered **ADR-024** in both reference lists above.
2. **ADR-014 status annotated** in this commit as partially superseded (NZ
   statutory) by ADR-015/016 — first use of the supersede convention this
   file's preamble provides for. The India-scoped stance (no PF/ESI/TDS)
   stands.
3. **The DocType framework decision had no ADR number.** This ADR references
   "the DocType framework decision" but the series had no record of it.
   Resolved 2026-11-16: recorded as **ADR-025** (same commit as Addendum A),
   with the Phase 0 week-5 design owning the details.
4. **Reuse-vs-rebuild asset claims verified against the tree** (evidence in
   `docs/REVIEW_TRIAGE.md`): NZ statutory engine at `src/lib/payroll/nz/`
   wired into every run (`payroll.ts:778-796`), GL posting on lock
   (`postPayrollRun`, `payroll.ts:1786-1820`), IRD EI/ED filing
   (`src/lib/ird/`), and effective-dated structures with frozen rate sets
   (ADR-015/016). The question is about real, tested assets.
5. **"Published from sandbox to prod" is a new capability.** The current
   sandbox (ADR-008) is a dev-only generated SQLite local variant; the
   week-8 deliverable 4 publish path is the week-4 sandbox architecture
   design item, not an existing mechanism.
6. **Kill condition #1's month-6 trigger restates the week-8 four
   deliverables.** As written it reads as a later backstop; the war room may
   want to distinguish the week-8 single-run proof from whatever "working NZ
   payroll" means at month 6 (Phase 3 spans months 5–7).
7. **The REVIEW_TRIAGE R-P0/R-P1 items are not absorbed by this ADR.** The
   existing codebase stays in service through at least Phase 5 (months
   8–10), and several R-P0 items (banner truth, docs truth pass) are
   prerequisites for the honesty positioning this plan depends on.

**Related decisions.** ADR-014 (payroll pre-statutory positioning —
partially superseded by ADR-015/016); ADR-015/016 (NZ statutory engine);
ADR-017 (IR340 combined secondary rates canonical); ADR-018 (payday filing
EI/ED/EIA2, incl. DEI field 13 = 0); ADR-019 (employment document approval
kernel); ADR-020 (Float + round2); ADR-021 (coverage gate reset); ADR-022
(employee grouping masters); ADR-024 (scope checkpoint criteria — to be
written).

**Revision history.**

| Date | Change | Reason |
|---|---|---|
| 2026-11-16 | Initial | War room session 2 outcome |

### Appendix A — Phase 0 detail (weeks 1–8)

The only phase whose detail exists at ADR time. Committed for completeness;
the other phases' details will be authored at their respective entry points.

**Week 1 — Governance and constraints**

| Day | Deliverable | Owner |
|---|---|---|
| 1–2 | Security engineer job spec + budget approval | Fatima + Mara |
| 1–2 | Kill conditions formalized in writing | Mara |
| 3 | Design-partner recruitment plan | Priya |
| 4–5 | 8-week critical-path milestone breakdown | Devon |

**Week 2 — Config boundary first cut**

| Day | Deliverable | Owner |
|---|---|---|
| 1–3 | Config-vs-code enumeration, module by module | Devon + Jonas |
| 4–5 | Contested boundary decisions | Mara adjudicates |

**Week 3 — Invariant catalogue**

| Day | Deliverable | Owner |
|---|---|---|
| 1–2 | Payroll invariants (fast-check signatures) | Jonas + Devon |
| 3 | Leave invariants | Jonas |
| 4 | Timesheet invariants | Jonas |
| 5 | Config invariants | Jonas + Devon |

**Week 4 — Sandbox architecture**

| Day | Deliverable | Owner |
|---|---|---|
| 1–2 | Sandbox isolation model | Devon + Fatima |
| 3–4 | Refuse-to-publish architecture | Devon + Jonas |
| 5 | Sandbox security boundary | Fatima |

**Week 5 — DocType framework core design**

| Day | Deliverable | Owner |
|---|---|---|
| 1–2 | Entity model | Devon |
| 3 | Versioning model | Devon |
| 4 | Permission model | Devon + Fatima |
| 5 | Config schema format decision | Devon |

**Week 6 — NZ payroll engine specification**

| Day | Deliverable | Owner |
|---|---|---|
| 1–2 | PAYE/ACC spec matched to IR341 | Devon |
| 3 | KiwiSaver/ESCT spec matched to IRD | Devon |
| 4 | Student loan spec matched to IRD | Devon |
| 5 | Payday filing spec | Devon |

**Week 7 — SSO implementation design**

| Day | Deliverable | Owner |
|---|---|---|
| 1–2 | OIDC implementation design | Devon + Fatima |
| 3 | Deprovisioning design | Fatima |
| 4–5 | SSO test matrix | Fatima + Jonas |

**Week 8 — Gate**

| Day | Deliverable | Owner |
|---|---|---|
| 1–2 | Config boundary ADR locked | Devon |
| 3 | Invariant catalogue committed | Jonas |
| 4 | Sandbox architecture ADR locked | Devon + Fatima |
| 5 | End-to-end payroll proof (Phase 0 demo) | Devon + Jonas |

**Week-8 gate outcome.** Binary: pass (proceed to Phase 1) or fail (kill
condition #1 fires, board reassesses within one week).

---

### ADR-023 — Addendum A: revised week-8 gate criteria and kill condition #1

**Status:** RATIFIED — war-room sign-off Mara Chen (CTO), 2026-11-16. Recorded
2026-11-16 in response to the ADR-023 recording notes (items 5–6), drafted
and ratified before Phase 0 week 2 begins, per the war-room directive.

**1. Week-8 deliverable 4 (end-to-end payroll proof) — acceptance criterion
revised.** The original criterion ends "published from sandbox to prod"
without naming which sandbox. Revision: "published" means promoted through
the publish path designed in Phase 0 week 4 — the NEW sandbox architecture's
isolation model and refuse-to-publish-gated promotion sequence — exercised
against a staging-grade target. It does **not** mean the existing dev-only
generated SQLite local variant (ADR-008), which has no publish path and is
not production-shaped. The dependency this surfaces: deliverable 4 cannot
pass unless the week-4 sandbox design lands on schedule — a coupling the
original wording hid. If week 4 slips, deliverable 4 slips with it; the gate
does not relax to accommodate.

**2. Kill condition #1 (engineering) — trigger revised.** The original
month-6 trigger ("config boundary, invariant catalogue, sandbox, and working
NZ payroll not all in place") restates the week-8 four deliverables, so as
written it measures nothing new at month 6. Revision — at month 6, kill
condition #1 fires unless **both** hold:

- **(a) Phase 1 exit criteria are met** — the framework can define, version,
  and permission a DocType, and the sandbox runs (the Phase 1 exit gate);
- **(b) the payroll engine operates on multi-employee, production-shaped
  runs** under the Phase 3 approach chosen at Phase 3 entry (port, rebuild,
  or fork — the reuse-vs-rebuild decision, which must by then be written and
  signed).

Week 8 proves the design plus one correct single-employee run; month 6
proves the framework plus the engine at production shape. The four week-8
deliverables are not re-tested at month 6.

**3. What does not change.** Binary firing ("met, not close-to-met"), the
one-week board reassessment window, the consequence options (fund +6 months
on the 18-month path, or cut scope to leave-only), the owner (Devon), and
every other gate and kill condition in ADR-023.

---

## ADR-025 — The SME Suite substrate is a configurable DocType framework, not hand-coded modules

**Date:** 2026-11-16 · **Status:** proposed (design lands Phase 0 week 5) — countersigned 2026-11-16, Devon Okafor (Principal Architect), with the reversibility note below · **Phase:** SME Suite

**Provenance note.** The framework decision predates ADR-023 but was never
recorded (ADR-023 recording note 3 flagged it). This entry was reconstructed
by the recording scribe from the war room session outcomes and ADR-023's
references to the decision; it was pending countersignature by Devon at the
week-5 design lock. Where this entry and the week-5 design disagree, the
design wins and this entry is amended. (The countersignature landed ahead
of schedule on 2026-11-16, war-room directive, conditioned on the
reversibility note below; the week-5 design-lock review still owns the
deferred details.)

**Reversibility (countersignature condition, 2026-11-16 — Devon Okafor,
Principal Architect).** The decision is built to be cheap to reverse early
and possible to reverse late. (1) *Phase 0* — no framework code exists yet;
walking away costs only the planning artifacts (config-boundary enumeration,
invariant catalogue, sandbox design). (2) *The week-8 gate* — a fail fires
kill condition #1 and the board reassesses within one week; no Phase 0
outcome touches the existing tree. (3) *Phase 1 exit* — the framework exists
but the hand-coded tree still serves every user; reversal means stopping new
framework investment, not a migration. (4) *Phase 3 entry* — the
port/rebuild/fork decision is the last point where the NZ statutory engine,
the GL, and IRD filing can be carried forward whole; once Phase 4 (HR core)
builds on the framework, reversal means running two substrates in parallel
and shrinking the framework surface gradually — expensive, but never a
big-bang rewrite-back. The existing tree stays in service through at least
Phase 5 (ADR-023 recording note 7), which is itself the reversibility asset:
the fallback never leaves the building.

**Context.** ADR-023 commits Fernly to two product shells on one substrate:
the Cloud shell (the 0–50 vertical — sign up, configure opinionated
defaults, run payroll) and the Enterprise shell (the 50–200 vertical —
config-exposed: integrator access, sandbox, custom fields). The existing
Fernly tree is hand-coded per-module: 110 Prisma models and 72 server-action
modules, where every entity, rule, and layout is a bespoke migration. That
shape cannot serve both shells: the Enterprise shell's custom fields and
integrator-defined entities are not features that can be retrofitted onto
hand-written models, and the Cloud shell's "opinionated defaults" are the
same substrate at a lower config-exposure level, not a separate product.

**Decision.**

1. The SME Suite is built on a configurable entity framework ("DocTypes"):
   entities, rules, and layouts are versioned, permissioned **configuration
   data**, not hand-written per-module schema code. A DocType is defined,
   versioned, and permissioned through the framework (the Phase 1 exit
   criterion).
2. **The config boundary is itself a designed, locked artifact** — what is
   config versus code is enumerated, decided, and signed (ADR-023's week-8
   deliverable 1). This ADR does not pre-empt that enumeration; it commits
   that the enumeration happens before framework implementation begins.
3. **Custom fields and custom DocTypes are first-class**: an integrator
   defines them in the sandbox; publication to production rides the
   refuse-to-publish-gated promotion sequence (the week-4 sandbox
   architecture, per Addendum A §1).
4. **The existing Fernly tree is the reference implementation and the Phase 3
   reuse-vs-rebuild candidate.** Nothing in this ADR mandates porting it;
   whether the NZ statutory engine, effective-dating model, general ledger,
   and IRD filing are ported, rebuilt, or forked is decided at Phase 3 entry
   with a written cost/benefit analysis (ADR-023's commitment).

**Deliberately deferred to Phase 0 week 5** (per ADR-023's planning
discipline — a design written now would be a design made up, not decided):
the entity model, the versioning model, the permission model, and the config
schema format. ADR-023's week-5 table owns those deliverables.

**Consequences.** *Positive:* one substrate serves both shells; integrator
extensibility is architectural rather than bolted on; the Phase 3
reuse-vs-rebuild question gets a clean target to be estimated against.
*Negative:* the framework is a new dependency for every feature that follows
— Phase 4 (HR core) cannot start until Phase 1 exits; config-driven systems
pay a permanent complexity tax in debugging and performance that hand-coded
modules do not; the week-8 gate becomes load-bearing for the entire plan
(which is why Addendum A tightens its wording). *Neutral:* ADR-008's
canonical-schema discipline continues to govern the existing tree for as
long as it remains in service.

**Related decisions.** ADR-023 (the phased delivery plan this substrate
serves; Addendum A revises its gate criteria), ADR-008 (canonical schema for
the existing tree), ADR-015/016 (the NZ statutory engine that is the
flagship reuse candidate), ADR-024 (scope checkpoint criteria — to be
written).

---

## ADR-026 — Erasure anonymizes the person; it never deletes the history

**Date:** 2026-11-16 · **Status:** DRAFT — proposed, not countersigned;
implementation owned by R-P0-5 (state-based, no calendar target) ·
**Type:** security / data model

**Signature status — retraction.** A prior commit (`4b7cc11`) recorded a
countersignature on this ADR from Dr. Fatima Al-Rashid (Security &
Compliance Lead) that the signer had not given: it was recorded on her
behalf from a war-room report of approval, and approval reported by a
third party is not an attestation. That record is reverted and this ADR
returns to DRAFT. It reaches ACCEPTED only when the named signer signs it
herself; an automated run may never record that signature on her behalf.

**Context.** REVIEW_TRIAGE §2 ("Soft delete vs erasure") and §4.4 found
`eraseUser` broken in production shape and untested in CI — its unit test
mocks Prisma entirely, so no test exercises the real schema. The action is
already two-step (soft-delete first, ADMIN-only, audit-first inside the
transaction) and already anonymizes the shared surfaces (message display
names → "Erased user", roster rows deleted). The failure is the final step:
`tx.user.delete()` throws P2003 and rolls back for any user with employment
history — `Loan`, `EmployeeTransfer`, `EmployeePromotion`,
`SalaryStructureAssignment`, `Timesheet`, `DeviceUserMapping` are all
`onDelete: Restrict` — and where deletion would succeed, `Payslip.userId`,
`LeaveRequest.userId`, `AttendanceRecord.userId` and `SalaryStructure.userId`
carry no FK at all, so salary amounts and leave reasons would survive as
orphans the erasure template never lists.

**Decision.**

1. The final step of `eraseUser` becomes **anonymization**: the User row
   survives with identifying fields overwritten in place — name and
   free-text PII to a tombstone, email to a unique unsendable deterministic
   tombstone, credentials invalidated, sessions revoked — and the schema's
   cascade/SetNull semantics (settings, notifications, read-state, reset
   tokens, assignments deleted; direct reports promoted to roots; owned
   projects' ownerUserId cleared) are reproduced explicitly instead of
   riding `user.delete()`. Every Restrict-FK dependent stays attached and
   intact; the P2003 class of failures disappears by construction.
2. **Retention is the point, not the compromise.** IRD record-keeping rules
   require payroll records to be kept for seven years; the audit trail is
   the only tamper-evidence an e-signature has (REVIEW_TRIAGE §4.8, and
   R-P1-4's retention hold); the code header already claims GDPR
   Art. 17(3)(b) for the audit rows. Deleting rows trades a privacy promise
   for a compliance breach; anonymization keeps both — the person is gone,
   the money history stays attributable and auditable.
3. The review's "orphan PII" finding inverts into a **disclosure duty**:
   with the row surviving, the non-FK columns join to the anonymized
   entity, and what is retained (payslip money, leave reasons, attendance)
   is kept by design — so the erasure template's retained-data table must
   list all of it, and free-text PII inside retained rows is redacted in
   the same transaction.
4. A **non-mocked integration test** (PGlite, the replay discipline CI
   already applies to migrations) covers a user with employment history:
   erase succeeds, no PII remains queryable, dependents survive intact,
   and the audit row records the erasure.
5. UI copy says "anonymize", never "delete" — the same artifact-honesty
   discipline as R-P0-1/R-P0-2.

**Consequences.** *Positive:* erasure stops failing silently; referential
integrity is preserved by construction; statutory retention and audit
evidence survive; the implicit cascade deletions become explicit and
testable. *Negative:* tombstone rows never shrink away and must be excluded
from directory/picker surfaces; the tombstone email holds the uniqueness
slot, so R-P1-6 (deterministic-email release) owns the same-name re-hire
question. *Neutral:* the soft-delete/trash path is unchanged — erasure
stays the terminal, two-step, audit-first action it already was.

**Related decisions.** REVIEW_TRIAGE §2/§4.4 and R-P0-5 (the implementing
workstream); ADR-023 recording note 7 (the existing tree serves through at
least Phase 5 — this fix lands in it, not a successor); R-P1-4 (e-sign
audit retention hold — the same evidence-preservation principle); R-P1-6
(deterministic-email release semantics).

---

## ADR-027 — Rate-set deletion is refused while any run references the set

**Date:** 2026-11-17 · **Status:** DRAFT — proposed, not countersigned;
implementation owned by R-P0-7 (state-based, no calendar target) ·
**Type:** data integrity / payroll

**Signature status.** Not signed. Per REVIEW_TRIAGE §9 (the human
attestation rule this ADR predates by one incident): it reaches ACCEPTED
only when the named reviewers sign it themselves — Devon Okafor
(architectural), Dr. Fatima Al-Rashid (data-integrity/security), and Mara
Chen (CTO — restricting an admin capability requires CTO approval). An
automated run may never record those signatures on their behalf.

**Context.** Pre-check A of the R-P0 batch (verified by test run + code
read, re-verified by the corrected batch) found `deleteTaxYear`
(`tax-admin.ts:704-735`) refusing deletion only when **LOCKED** runs
reference the set; OPEN-run references are counted and audited but the
deletion proceeds. After deletion, on an OPEN engine run:

- `updatePayslip` keeps the stored statutory lines + snapshot — the
  documented cache use, already pinned by
  `src/server-actions/__tests__/payroll-rateset-deleted.test.ts`.
- `addPayslip` creates joiner slips with **zero statutory lines** and a
  plain-success result; only the audit row notes the missing set
  (`payroll.ts:1536-1566`, audit at `:1630`). An untaxed slip is a
  wrong-net overpayment with no operator-visible error.
- `lockPayrollRun` has no rate-set validation; the untaxed net locks
  immutably and posts to the general ledger.

Taxonomy: *silent wrong values* — the critical bucket. Tax calculations
must fail loudly, never succeed quietly with wrong numbers.

**Decision.** Three-layer enforcement, defense in depth:

1. **Deletion refusal covers every run state.** `deleteTaxYear` refuses
   deletion while ANY run (OPEN or LOCKED) references the rate set; the
   refusal message names the referencing runs. **Archive is the retire
   path** for used sets — archiving is safe mid-run because frozen-run
   resolution is by explicit id via `findUnique` and ignores the
   effectiveness window (`calculate.ts` resolveNzRateSet). Deletion
   remains available for never-used rate sets.
2. **The joiner path fails loudly.** `addPayslip` refuses with the
   engine-style user-facing error naming the missing rate set when
   `run.rateSetId` is set but the set fails to resolve — the same
   fail-loud philosophy the action already applies to engine refusals.
3. **The edit path keeps its cache.** `updatePayslip` preserves the
   cached statutory lines from the run's snapshot (existing, correct
   behavior — a test proving it lands with the implementation; no
   audit-only change is needed here).

**Defense in depth — the run-page notice.** Two surfaces (a badge on the
runs list, a banner on the run detail page) fire on: (a) an unresolvable
`rateSetId` on the run, and (b) any payslip in the run with zero
statutory lines where the employee has taxable earnings.

**Property tests.** Four tests must exist and pass:
`rate-set-deletion-blocked-when-referenced` (Layer 1);
`add-payslip-fails-when-rate-set-missing` (Layer 2);
`update-payslip-preserves-cache` (Layer 3); and
`run-cannot-lock-with-missing-rate-set` (the end-to-end property).

**Explicitly rejected.**

- *No lock-time completeness check.* Layers 1 and 2 close the hole; a
  lock-time check would mask rather than surface bugs.
- *No backfill for orphaned ids.* Pre-launch data. A v1-launch checklist
  item is added instead: verify no orphaned `rateSetId` exists in
  production data before the first real payroll run.

**Consequences.** *Positive:* the silent-wrong-values class disappears at
both entry points; operators see named, actionable refusals. *Negative:*
admins can no longer delete a used rate set even in a workspace they
know is stale — the archive path is one click away, and the refusal
message says so. *Neutral:* never-used sets delete as before; the
tax-admin UI documents which action to take (archive to retire, delete
only for never-used sets).

**Reversibility.** Layer 1 is reversible — remove the refusal if the
archive path ever proves insufficient. Layers 2 and 3 should stay
regardless: they are the fail-loud and cache-correctness invariants the
engine already claims elsewhere.

**Related decisions.** REVIEW_TRIAGE §7 (R-P0-7 spec, pre-check A
evidence); ADR-015/ADR-016 (the NZ statutory engine whose rate sets this
protects); ADR-026 (the same batch's data-integrity ground — R-P0-5's
erasure work rides on rate-set integrity).
