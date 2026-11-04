# Fernly

A focused project-management workspace for small teams: projects, a Kanban board,
bug tracking, a shared calendar, role-scoped analytics, team messaging, HR
(leave · directory · reviews · onboarding) and full workspace administration —
in one keyboard-first, single-page app.

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) ·
Prisma 6 + PostgreSQL · Better Auth 1.7 (DB sessions + JWT bearer tokens) · Zustand ·
Tailwind v4 (CSS-first) + OKLCH design tokens · zod · Recharts · dnd-kit

## Feature tour

The app is a **single route** (`/`); the sidebar switches views client-side, every
keystroke-reachable. Groups below match the sidebar.

**Overview**
- **Dashboard** (`G D`) — KPI stats, personal reminders (private to their creator),
  workspace activity notifications, time-tracker widget, timezone-correct greeting.
- **Analytics** (`G A`) — role-scoped: completion/hours trends, hours logged per
  project, 13-week activity heatmap, top contributors, on-time delivery &
  cycle-time cards. A single scope selector (next to the 7D/30D/90D range) offers
  exactly the scopes the server will accept for the signed-in user — enforced
  server-side, not just hidden in the UI (see [Roles & data scoping](#roles--data-scoping)).

**Work**
- **Projects** (`G P`) — grid of color-coded project cards with status/priority/
  progress/owner; create/edit/delete per permission. Opening a card opens a wide
  detail modal: description, progress, roster (collapsible), and the project's
  change trail (audit history).
- **Tasks** (`G T`) — Kanban board (To do / In progress / In review / Done —
  DB-configurable) with drag & drop, per-column ordering, filters (project,
  status, priority, tag), search, assignee avatars and due dates. The task modal
  shows full fields + entity history; assignee choices are limited to the chosen
  project's staff.
- **Bugs** (`G B`) — a QA-facing defect tracker with its own lifecycle
  (NEW → TRIAGED → IN_PROGRESS → RESOLVED → CLOSED, plus REOPENED), severity,
  assignee and threaded comments.

**People**
- **Team** (`G M`) — directory with availability, department, workload %; direct
  messaging with threads, an inbox drawer and unread badges. Messages are strictly
  private to the sender/recipient pair; MEMBER sees only people connected to
  their projects.
- **Calendar** (`G C`) — month grid with type-coded events (meeting, deadline,
  review, social, focus), full CRUD. Approved leave appears as virtual calendar
  events without duplicating rows.
- **Leave** (`G V`) — self-service leave for **every** role: balances by type/year,
  request form, personal history. Approvals follow the reporting chain (see HR).

**HR** (gated by `hr:view` — ADMIN, MANAGER, HR)
- **HR Console** (`G R`) — leave request queue with approve/reject, leave types &
  policies administration, employee directory, performance review cycles, and
  onboarding checklists with per-task progress.
- **Hiring** (`G I`, gated by `hiring:view`) — the recruitment pipeline
  ([plan](docs/RECRUITMENT_MODULE_PLAN.md)): a configurable stage board
  (screening → interviews → assessment → background check → documents → offer,
  fully editable per company) with candidates as cards. HR/ADMIN manage the
  pipeline (advance / skip / fail stages, add per-candidate custom stages,
  reject **with a stored reason** or withdraw), MANAGERs get an interviewer's
  read view. Candidates snapshot the template at creation, so template edits
  never rewrite history. Rejected / withdrawn / hired pools sit behind a status
  filter. Every hiring mutation lands in the audit log. Interviews
  (R2): scheduling an INTERVIEW stage creates a calendar event + the
  interviewer's personal reminder, blocks double-bookings within the hour,
  and collects a structured scorecard (1–5 rating, strengths, concerns,
  STRONG_HIRE/HIRE/NO_HIRE) — editable by the assigned interviewer or HR;
  interviewers see a "Your upcoming interviews" panel. Decisions & email
  (R3): SELECT moves a candidate to the offer-prep pool; rejecting can queue
  a courteous rejection email — the internal reason stays audit-only, the
  HR-approved personal note goes to the candidate — and every send is
  recorded in an audited outbox (SENT / SKIPPED dry-run / FAILED) viewable
  by HR. Joining formalities (R4): a configurable document-type checklist
  (request → receive → verify/reject with a note, per candidate), a
  background-check record (vendor, INITIATED → IN_REVIEW → CLEARED/FLAGGED),
  and a "request all mandatory" convenience on selected candidates.
  Offer builder (R5): per-role salary templates (fixed amounts or % of
  basic, employer contributions like KiwiSaver), generated per selected
  candidate with live CTC / net totals and an editable letter.
  E-sign & joining (R6): sending an offer mints a single-use signing link
  (7-day expiry) — the candidate opens the public `/offer/<token>` page
  without an account, reviews the letter + numbers snapshot, and signs by
  typing their full legal name (timestamp + IP recorded, record immutable
  from then on) or declines. "Mark joined" then provisions their employee
  account automatically: deterministic email `<first>.<last>@fernly.app`
  (numeric suffix on collision), roster entry, employee profile, a 5-task
  onboarding checklist, and a welcome email via the audited outbox.
  (Full payroll follows in R7–R8.)

**Administration**
- **Users** (`G U`, admin) — create (login + directory entry in one action), edit,
  soft-delete, password reset, project assignments, reporting-line (manager) edits.
- **Workspace Config** (`G W`, admin) — workspace defaults, password policy,
  capacity, audit retention, configurable vocabularies (task statuses, project
  statuses, event types, tags, priorities, departments) and the **role-permission
  matrix** (edits apply to signed-in users within the 60 s config cache window).
- **Audit Log** (`G L`) — append-only trail of every mutation (66 typed actions):
  actor, entity, timestamp, human-readable detail; filter by entity; per-entity
  history inside edit modals.

**General**
- **Settings** (`G S`) — profile, security (password change), per-user appearance
  (accent theme forest/ocean/plum/ember, dark mode — persisted server-side,
  applied pre-hydration, no cross-account leakage), notification preferences,
  privacy (export my data), API token minting.
- **Help** (`G H`) — shortcut reference.

Global: `⌘K`/`Ctrl K` command palette, `?` shortcut overlay, responsive layout,
icon-rail or full sidebar (remembered per browser), collapsible nav groups with
one group expanded at a time.

## Roles & data scoping

Four roles — **ADMIN**, **MANAGER**, **MEMBER**, **HR** — mapped to a
**28-permission matrix** that lives in the database (`Role`/`Permission`/
`RolePermission`), editable by admins at runtime, with the compile-time matrix in
[`src/lib/rbac.ts`](src/lib/rbac.ts) as the floor. Authorization is **two-layer and
server-side only**:

1. **Permission gate** — every server action states its required permission.
2. **Row-level scoping / ownership** — identity always comes from the session,
   never from arguments:

| Who | Sees |
|---|---|
| ADMIN | the whole workspace (personal items like reminders stay personal) |
| MANAGER / MEMBER | projects they own / are assigned to / have tasks in; people connected to those projects; messages 1:1 as sender/recipient |
| MEMBER analytics | only their own hours/activity — any other requested scope is forced to "self" |
| MANAGER analytics | their team (self + full reporting subtree) by default; may narrow to themselves or any individual in the subtree |
| ADMIN analytics | own data by default; may select Everyone, any manager's full team, or any individual |

**Task deletion** is row-level, not just permission-level: a task may be deleted
by its **assignee**, the **project owner**, any **ADMIN**, or a **MANAGER whose
reporting chain covers** the assignee or project owner. Everyone else — including
roles with broad edit rights — is refused.

**HR scoping:** leave approvals follow the reporting chain (`User.managerId`,
full subtree); employee profiles, reviews and onboarding are gated by `hr:*`
permissions; leave balances and requests are personal.

## Quick start

```bash
bun install                 # install dependencies
cp .env.example .env        # then fill in DATABASE_URL + BETTER_AUTH_SECRET
                            # (+ NEXT_PUBLIC_DEMO_PASSWORD for the demo accounts)
bunx prisma db push         # create the schema
bunx prisma generate        # generate the client
bun run db:seed             # demo data (13 users / 24 projects / 40 tasks
                            #  + bugs, leave, reviews, onboarding, 90 days of
                            #  time entries and audit history)
bun run dev                 # http://localhost:3000
```

Demo logins — password is `NEXT_PUBLIC_DEMO_PASSWORD` from your `.env` (the repo
contains **no credential literals**; the seed refuses to run without it):

| Email | Person | Role | Notes |
|-------|--------|------|-------|
| `demo@fernly.app` | Mira Hale | ADMIN | top of the org chart |
| `manager@fernly.app` | Ingrid Solberg | MANAGER | team: Lena, Rafael (+ Soren via Lena) |
| `member@fernly.app` | Theo Vance | MEMBER | individual contributor |
| `remy@fernly.app` | Remy Laurent | HR | People Ops — leave queue, reviews, onboarding |
| `priya@fernly.app` | Priya Nair | MANAGER | team: Marcus, Hana |
| `lena@` · `rafael@` · `yuki@` · `amara@` · `soren@` · `marcus@` · `hana@` · `diego@` (`@fernly.app`) | — | MEMBER | varied timezones/departments |

## Commands

| Command | Purpose |
|---------|---------|
| `bun run dev` | Dev server (Turbopack) on :3000 |
| `bun run build` / `bun run start` | Standalone production build / serve |
| `bun run lint` | ESLint |
| `bun run typecheck` | `tsc --noEmit` (strict — part of the gate) |
| `bun run test` | Vitest unit/integration suite (**1677 tests**) |
| `bun run test:coverage` | Coverage report + threshold gates (≥90% statements on `src/lib` + `src/server-actions`) |
| `bun run test:e2e` | Selenium + Cucumber browser suite (needs Chrome; see `e2e/README.md`) |
| `bun run test:prodsmoke` | Smoke-checks a production build (health, headers, CSP, login) |
| `bun run bundle:check` | Client JS budget gate |
| `bun run audit:check` | Dependency audit gate (prod-runtime scoped) |
| `bun run db:push` / `db:generate` / `db:seed` / `db:migrate` / `db:deploy` | Schema push / client / demo data / dev + production migrations |

CI (`.github/workflows/ci.yml`) runs the full gate on every push and PR: lint →
typecheck → coverage-gated unit tests → production build → bundle budget →
dependency audit → **e2e** on a seeded ephemeral PostgreSQL 16 with headless
Chrome (83 scenarios across 12 feature files: login & lockout, RBAC, tasks, hiring,
messaging, a11y, HR leave/directory/reviews/onboarding, QA hardening).

## Keyboard shortcuts

| Keys | Destination |
|------|-------------|
| `G D` / `G A` | Dashboard / Analytics |
| `G P` / `G T` / `G B` | Projects / Tasks / Bugs |
| `G M` / `G C` / `G V` | Team / Calendar / Leave |
| `G R` | HR Console (needs `hr:view`) |
| `G I` | Hiring pipeline (needs `hiring:view`) |
| `G U` / `G W` / `G L` | Users / Workspace Config / Audit Log (admin) |
| `G S` / `G H` | Settings / Help |
| `⌘K` / `Ctrl K` | Command palette |
| `?` | Shortcut overlay |

## API access (bearer tokens)

Programmatic clients (curl, CI, integrations) authenticate with a 1-hour JWT:

```bash
# 1 — sign in via the cookie flow, keeping the session cookie:
curl -c jar -X POST http://localhost:3000/api/auth-better/sign-in/email \
     -H 'content-type: application/json' \
     -d '{"email":"demo@fernly.app","password":"…"}'

# 2 — exchange the session for a bearer token:
curl -b jar -X POST http://localhost:3000/api/auth/token
# → { "ok": true, "token": "…", "expiresIn": 3600, "tokenType": "Bearer" }

# 3 — call any endpoint with the bearer token:
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/…
```

Tokens are personal (never workspace API keys): the same permission gates and
data scoping apply as for browser sessions. Every issuance is audit-logged
(`auth.token_issued`); soft-deleting a user kills their outstanding tokens
immediately. Details: [`docs/SECURITY.md`](docs/SECURITY.md) §1.

## Project conventions (the short version)

- **Branding** — the product name lives only in [`src/config/app.ts`](src/config/app.ts);
  every surface imports it (`APP`, `STORAGE_KEYS`, `ERROR_BRIDGE_KEY`, …).
- **Navigation** — [`src/config/navigation.ts`](src/config/navigation.ts) is the
  single source of truth for views, groups, icons and shortcuts; the sidebar,
  ⌘K palette and `G` shortcuts all derive from it.
- **Design tokens** — all colors/radii/shadows live in
  [`src/styles/tokens.css`](src/styles/tokens.css) (typed mirror:
  [`src/styles/tokens.ts`](src/styles/tokens.ts)); `globals.css` and components
  never hardcode color values. A sync test keeps the pair honest.
- **Server actions** — all mutations go through `src/server-actions/` (one module
  per domain, 30+ modules), each returning `ActionResult<T>` instead of throwing;
  every action is permission-checked, scoped and audit-logged.
- **Secrets** — `.env` is the only home; no credential literal is committed
  anywhere (tests, scripts, k6, e2e all read env vars and fail loudly when unset).
- **HTTP** — native `fetch` (one outbound call), no axios; **UI** — shadcn/ui
  pattern with local primitives, no component kit. Rationale and alternatives:
  [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Project structure

```
src/
  app/                 # single route (page.tsx = server component + session)
  components/
    views/             # one component per view (dashboard, tasks, hr-*, …)
    ui/                # design system + shells (app-shell, sidebar, modals)
    auth/              # login screen
  server-actions/      # "use server" modules per domain (barrel: data.ts)
  hooks/               # keyboard shortcuts, permissions, appearance sync
  store/app-store.ts   # Zustand: view state, modals, theme, nav groups
  lib/                 # pure logic (rbac, hierarchy, jwt, validation, …)
  styles/              # tokens.css + globals.css
prisma/                # schema (37 models) + migrations + seed
e2e/                   # Cucumber + Selenium suite (12 feature files)
scripts/               # seed, gates (bundle/audit/prod-smoke), load tests
docs/                  # the documentation set below
deploy/                # Caddy/nginx TLS configs, sandbox preview helper
```

## Testing

| Layer | Tool | Scale |
|-------|------|-------|
| Unit / integration | Vitest + jsdom (82 files) | **1484 tests**, coverage-gated |
| Browser E2E | Cucumber + Selenium | 70 scenarios / 12 feature files |
| Production smoke | `test:prodsmoke` | health, headers, CSP, credential flow |
| Load | k6 + `scripts/load-smoke.mjs` | p95 budgets incl. a 100k-row dataset (`scripts/seed-load.js`) |

Every server action's permission gate, ownership and scoping rule is pinned by
regression tests; bug fixes require a test that fails on the pre-fix code. See
[`docs/TESTING.md`](docs/TESTING.md) for the strategy and the manual test plan.

## Deployment

Single Linux host with `docker compose` (migration gate + 2 app replicas +
nginx + Redis + maintenance cron; optional bundled PostgreSQL), TLS terminated
at a reverse proxy (Caddy/nginx configs in [`deploy/`](deploy/)). Required env:
`DATABASE_URL`, `BETTER_AUTH_SECRET` (the process refuses to boot on a weak
secret). Full runbook: [`docs/DEPLOY.md`](docs/DEPLOY.md) · backups & RPO/RTO:
[`docs/BACKUP_RECOVERY.md`](docs/BACKUP_RECOVERY.md).

## Security posture (summary)

All authorization is enforced server-side; client gating is cosmetic. Every
mutation is permission-checked, ownership-checked where relevant, and
audit-logged. Login is rate-limited (5 failures / 15 min per email and IP,
Redis-backed when configured) with timing-attack mitigation and lockout.
Passwords are bcrypt (cost 12) under a workspace-configurable minimum length.
Personal data (reminders, time entries, greeting counts, leave, project staff)
is scoped to the signed-in user — for every role including admins. Production
refuses to boot without a strong `BETTER_AUTH_SECRET`. See
[`docs/SECURITY.md`](docs/SECURITY.md) for the complete threat model, PII
inventory and the honest list of accepted risks.

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements, roles, functional & non-functional criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System, layering, auth/authz flows, data model (37 models) |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | ADRs: HTTP client, UI kit, Tailwind v4, tokens, secrets, scoping, HR model, bearer tokens, … |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, controls, PII inventory, incident response |
| [`docs/TESTING.md`](docs/TESTING.md) | Test strategy + full manual test plan |
| [`docs/CODING_STANDARDS.md`](docs/CODING_STANDARDS.md) | Rules for tokens, config, server actions, tests |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Deployment runbook (docker compose, upgrades, rollback) |
| [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) | Launch-readiness review: findings, fixes, gates, load results |
| [`docs/HR_MODULE_PLAN.md`](docs/HR_MODULE_PLAN.md) | HR module plan & delivery record (leave, directory, reviews, onboarding) |
| [`docs/RECRUITMENT_MODULE_PLAN.md`](docs/RECRUITMENT_MODULE_PLAN.md) | Recruitment & joining-formalities plan: researched process, data model, milestones R1–R8 (hiring → offers → payroll) |
| [`docs/BACKUP_RECOVERY.md`](docs/BACKUP_RECOVERY.md) | RPO/RTO targets, restore procedures, drill schedule |
| [`docs/STATUS_AND_ONCALL.md`](docs/STATUS_AND_ONCALL.md) | Status page + on-call runbooks |
| [`docs/DB_REGION_DECISION.md`](docs/DB_REGION_DECISION.md) | Supabase region decision & measurement plan |
| [`docs/PRIVACY_ERASURE_TEMPLATE.md`](docs/PRIVACY_ERASURE_TEMPLATE.md) | Right-to-erasure / retention notice template |
| [`e2e/README.md`](e2e/README.md) | Browser E2E suite: scope, running, limitations |
