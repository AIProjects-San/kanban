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
`AUTH_MIGRATION_PLAN.md` §9; tests pin the crypto (12), the session resolution (8)
and the route (7).
