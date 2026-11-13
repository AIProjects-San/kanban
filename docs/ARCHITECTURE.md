# Fernly — Architecture

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) ·
Prisma 6 + PostgreSQL (Supabase) · Better Auth 1.7 (DB sessions) · Zustand · custom CSS design system

---

## 1. System overview

```
                    ┌────────────────────────────────────────────┐
   Browser ────────►│ Reverse proxy (Caddy, HTTPS)               │
                    └───────────────┬────────────────────────────┘
                                    │ HTTP (internal)
                    ┌───────────────▼────────────────────────────┐
                    │ Next.js standalone server (Node, :3000)    │
                    │                                            │
                    │  /                — single-page app shell  │
                    │  /api/auth-better/* — Better Auth (credentials) │
                    │  /api/auth/token  — JWT bearer-token minting (PR-54) │
                    │  Server Actions  — ALL data mutations      │
                    └───────────────┬────────────────────────────┘
                                    │ Prisma (pooler, IPv4)
                    ┌───────────────▼────────────────────────────┐
                    │ PostgreSQL (Supabase eu-west-1)            │
                    └────────────────────────────────────────────┘
```

**One route, many views.** The app is a single route (`/`). The server component in
`app/page.tsx` resolves the session, loads the entire dashboard payload in one round
trip, and hands it to `AppShell`, which switches between views client-side
(`store/app-store.ts` holds `ViewKey`). Navigation = state change, not route change.

**No REST/GraphQL layer.** All reads and writes go through Server Actions
(`src/server-actions/`), organised **per domain** since the 2026-10-30 split
(30+ modules): `dashboard`, `tasks`, `projects`, `members`, `events`,
`notifications`, `reminders`, `users`, `time-entries`, `messages`, `assignments`,
`workspace`, `audit`, `analytics`, `bugs`, `bulk`, `search`, `mentions`,
`auth-tokens`, `data-export`, `ics-export`, `trash`, `hr-leave`, `hr-directory`,
`hr-reviews`, `hr-onboarding`, `hr-shared` — with `data.ts` as a thin barrel
re-export so callers have one stable import path. Every client-invoked action
returns an **`ActionResult<T> = { ok: true; data: T } | { ok: false; code; error }`**
(`lib/shared/action-result.ts`) instead of throwing: production never masks action
error messages, and clients branch on `res.ok`. SSR-only loaders
(`getDashboardData`, `getUserProfile`, `getUserSettings`) keep the throwing
contract — a DB outage there belongs in the error boundary, not an empty UI.

## 2. Layering

```
app/page.tsx                — server component: session + initial payload
components/ui/          — design system + shells (app-shell, sidebar, modals…)
components/views/           — one component per ViewKey (dashboard, tasks, …)
components/auth/            — login screen
hooks/                      — use-keyboard-shortcuts, use-permissions (client RBAC)
store/app-store.ts          — Zustand: view state, modals, inbox, theme (session only)
──────────────────────────────────────────────────────────────────────────────
server-actions/             — per-domain "use server" modules (barrel: data.ts)
server-actions/auth-guard.ts— getSession / requirePermission / getSessionOrThrow
server-actions/shared.ts    — server-only helpers (logAudit, task-edit ownership)
server-actions/result.ts    — toResult(): thrown Error → ActionResult mapping
lib/                        — pure logic (rbac, config, validation, password, …)
lib/db.ts                   — Prisma singleton
lib/config-loader.ts        — workspace config with 60 s cache + bump invalidation
types/                      — client-facing DTOs
```

**Dependency rule:** views → fernly components → lib (pure) → server-actions → db.
Nothing in `lib/` imports React components except the two .tsx constant files
(`constants.tsx` holds icon-carrying accent definitions).

## 3. Authentication & session flow

Two supported credentials, both resolving to the same `AuthResult` (`userId,
role, name, email`) via `getSession()` (`server-actions/auth-guard.ts`):

**A. Better Auth cookie sessions (browser).** `src/lib/auth-better.ts`
serves `/api/auth-better/*`: the sign-in before-hook normalises email →
rate-limit check (email + IP buckets, 5/15 min, Redis-backed when
configured) → user lookup with soft-delete filter → credential-row sync
(`User.passwordHash` stays the single source of truth) → Better Auth's
single bcrypt compare → DB-backed opaque session (`fernly.session_token`
cookie, httpOnly, SameSite=Lax, 7-day expiry, 5-minute `session_data` cookie
cache). `getBetterSession()` resolves the cookie against the `Session`
table and downgrades unknown roles to MEMBER (deny-by-default). A
soft-deleted account is treated as signed out even mid-session (`deletedAt`
rides on the session payload). Sign-in/out after-hooks write `auth.signed_in`
/ `auth.signed_out` audit rows with IP + user agent.

**B. JWT bearer tokens (external/programmatic clients — PR-54).**
`getBetterSession()` checks `Authorization: Bearer <jwt>` **before** the
cookie path, so every server action and API route transparently accepts
either credential. `src/lib/jwt.ts` is a dependency-free HS256
implementation (Node crypto) signing with `BETTER_AUTH_SECRET`:

1. **Minting** — `POST /api/auth/token` (plain HTTP, for curl/CI clients) or
   the `issueAuthToken()` server action (browser). Both require an existing
   session (cookie or still-valid bearer — the latter enables
   refresh-before-expiry). Returns `{ token, expiresAt, expiresIn,
   tokenType: "Bearer" }` and writes an `auth.token_issued` audit row with
   IP + UA.
2. **Validation** — `verifyJwt()` checks signature (constant-time) +
   expiry + alg (rejects `alg: none`); then one indexed DB lookup confirms
   the user exists and isn't soft-deleted, and returns the **current** DB
   role/name/email (role changes take effect immediately, not on token
   expiry). An invalid/expired bearer returns null (→ 401) — it never
   silently falls through to an unrelated cookie session.
3. **Revocation** — soft-deleting a user kills their outstanding JWTs
   immediately (the DB lookup rejects). Password/role changes delete DB
   session rows but do **not** invalidate outstanding JWTs — the 1-hour
   expiry is the revocation window; clients re-mint before expiry.

Tokens are personal, never workspace API keys: bearer-authenticated requests
funnel through the same `getSession()` → `AuthResult`, so every scoping rule
(`getScopedProjectIds`, member visibility, permission gates) applies
identically.

**Secrets:** production refuses to boot with a missing/weak `BETTER_AUTH_SECRET`
(`NEXT_PHASE=phase-production-build` is exempt so builds succeed on secret-less CI).
Cookies flip to `Secure` automatically in production.

## 4. Authorization model (two layers)

- **Layer 1 — permission checks** (`requirePermission`): every action states its
  required permission from the **32-permission matrix** across four roles
  (ADMIN / MANAGER / MEMBER / HR — `lib/rbac.ts`; the full matrix is pinned
  by a unit test, so any grant change is a deliberate edit). Client components use
  `usePermissions()` to hide UI affordances — cosmetic only. Admins edit the
  DB-driven matrix at runtime; changes reach signed-in users within the 60 s
  config-cache window (with immediate bump on save).
- **Layer 2 — row-level scoping**: `getDashboardData()` computes a scoped project-id set
  (owned ∪ assigned-tasks ∪ explicit assignments) from the **server session** and pushes
  it into every query. MEMBER and MANAGER are both scoped; ADMIN is not.
  The same scope is shared by the paginated reads (`pagination.ts`) and the project
  staff reads (`assignments.ts`, `dashboard.ts::getProjectMembers`) via
  `getScopedProjectIds` — see ADR-010.
- **Task deletion (PR-61)** is row-level, not permission-level: allowed for the
  task's **assignee**, the **project owner**, any **ADMIN**, or a **MANAGER whose
  reporting chain covers** the assignee or project owner (`lib/hierarchy.ts`
  subtree check). The blanket `task:delete` RBAC grant stays ADMIN-only;
  everyone else passes through `assertTaskDeletePermission`.
- **Analytics scoping (PR-63)**: `server-actions/analytics.ts` resolves the
  requested scope server-side — MEMBER/HR are forced to *self*; MANAGER may pick
  self or any individual in their reporting subtree (default: whole team);
  ADMIN may pick self, *Everyone*, any manager's full team, or any individual.
  The response carries the scope options the user is allowed to pick, so the
  dropdown never offers a scope the server would reject.
- **HR scoping (ADR-009)**: leave approvals follow the reporting chain
  (`User.managerId`, full subtree — a manager approves anyone below them);
  leave balances/requests are personal; employee profiles, reviews and
  onboarding are gated by `hr:*` permissions.
- **Recruitment & payroll scoping** (docs/RECRUITMENT_MODULE_PLAN.md): the
  hiring board is `hiring:view` (ADMIN/HR/MANAGER — interviewers), every
  pipeline mutation is `hiring:manage` (ADMIN/HR), templates are
  `hiring:config`, and the entire payroll family (structures, runs,
  payslips) is `payroll:manage` (ADMIN/HR only — MANAGERs never see salary
  data). The public offer-signing route `/offer/<token>` is authorized by
  the 256-bit single-use token itself, not a session; the typed signature
  requires the candidate's exact legal name.
- **Personal-data scoping (PR-51–54):** reminders are owner-only (the legacy
  `ownerId: null` rows are no longer surfaced); dashboard time entries are filtered to
  **members the viewer can see** (`getVisibleMemberIds` — the same rule governs
  `getTimeEntriesPage`, where the caller's `memberId` filter is intersected with the
  visible set rather than overwriting the scope); dashboard greeting counts are
  personal (own tasks, own reminders-due-today), not workspace-wide.
- **Ownership assertions**: task edits (`task:edit:own` without `:any`), message
  deletion (sender/recipient), reminder toggling (owner/admin), profile/settings reads
  and writes (self or `role:manage`).

**Critical invariant (regression-tested):** caller-supplied arguments are never used for
authorization decisions. Identity always comes from `getSession()`. Caller-supplied
**filters** (e.g. `memberId` on `getTimeEntriesPage`) are intersected with the server-
derived scope — never allowed to replace it.

## 5. Data model (49 models, key ones)

| Model | Purpose | Notable relations |
|-------|---------|-------------------|
| `User` / `UserSettings` | login identity + preferences; `managerId` self-relation carries the reporting chain | 1–1 settings; assignments cascade |
| `TeamMember` | directory entry (1–1 with `User` by stable `userId`) | tasks (SetNull), time entries |
| `Project` | workspace project (`ownerUserId` is authoritative; `ownerName` display-only) | tasks (SetNull), assignments (Cascade) |
| `Task` | Kanban card with `order` per column | project/assignee (SetNull) |
| `ProjectAssignment` | explicit user↔project membership | unique (projectId, userId) |
| `Message` / `MessageRead` | threaded DMs with `senderUserId`/`recipientUserId` | privacy enforced in queries |
| `Reminder` | dashboard to-do — personal (`ownerId` = creator); legacy null-owner rows retained in DB but not surfaced (PR-52) | — |
| `Notification` | per-user routing; null-recipient rows are intentional workspace-wide broadcasts | — |
| `Bug` / `BugComment` | QA defect tracker with its own lifecycle (NEW → … → REOPENED) | — |
| `LeaveType` / `LeavePolicy` / `LeaveRequest` / `LeaveBalance` | HR leave: types, per-year policies, chain-approved requests, balances | approved leave renders as virtual calendar events |
| `EmployeeProfile` | HR directory: structured employee records beyond the roster | 1–1-ish with `User` |
| `PerformanceReview` | review cycles with stages and reviewer assignments | — |
| `OnboardingChecklist` / `OnboardingTask` | per-new-hire checklists with task-level progress | — |
| `HiringStageConfig` / `Candidate` / `CandidateStage` | recruitment pipeline: workspace stage template, candidates (snapshotted timelines at creation) | CandidateStage cascades with Candidate |
| `MailOutbox` / `CandidateDocument` / `BackgroundCheck` | audited candidate emails, per-candidate document checklist, BGV records | outbox retains history (SetNull) |
| `OfferTemplate` / `OfferRecord` | per-role salary bands + per-candidate offers (DRAFT → SENT → SIGNED/DECLINED with the single-use signing token + typed signature) | offers cascade with Candidate |
| `SalaryStructure` / `PayrollRun` / `Payslip` | payroll: per-employee annual structures, monthly runs (OPEN → LOCKED), payslips with LOP + YTD | payslips cascade with the run; unique (runId, userId) |
| `AuditLog` | append-only trail (101 typed actions) | written by every mutation |
| `Workspace` + 7 config tables + `Role/Permission/RolePermission` | runtime-configurable vocabulary and RBAC | cached by config-loader |

Cascade policy: deleting a **Project** keeps its tasks (SetNull projectId) but removes
assignments; deleting a **User** cascades assignments; deleting a **TeamMember** keeps
tasks unassigned.

## 6. Configuration pipeline

`getWorkspaceConfig()` reads all nine config sources in parallel, falls back to
code defaults when tables are empty, and caches for 60 s. Mutations call
`bumpConfigCache()` (immediate) and `revalidatePath("/")` (next read sees fresh data).
`hasPermissionDb()` evaluates the DB-driven matrix; the compile-time matrix in
`lib/rbac.ts` remains the floor for `requirePermission` (defence in depth).

## 7. Front-end architecture

- **Navigation** — `src/config/navigation.ts` is the single source of truth:
  six groups (Overview, Work, People, HR, Administration, General), one
  component per view, RBAC-gated leaves. The sidebar renders it as collapsible
  **accordion groups with one group open at a time** (opening a group collapses
  the previous; the group holding the current view auto-expands on load), plus
  a persisted icon-rail density toggle. The ⌘K palette and `G`-prefix shortcuts
  derive from the same module — no hand-synced copies (PR-58/PR-62 regression
  tests pin the drift).
- **Theme:** OKLCH design tokens in `src/styles/tokens.css` (single source of truth,
  mirrored to TS in `src/styles/tokens.ts`; imported by `globals.css`), four accent
  themes, dark mode via a
  `dark` class + per-user persistence — appearance is stored **server-side on the
  user's account** (accent, dark mode) and applied before hydration, so it follows
  the account across browsers with no cross-account leakage (PR-65).
- **State:** server data arrives as props from the server component; Zustand holds only
  view/session state (active view, open modals, nav-group collapse, inbox, palette,
  refresh counter). `bumpRefresh()` triggers a server re-render after mutations.
- **Design system:** `components/ui/*` — no third-party UI kit. The shadcn
  scaffold was removed (49 dependencies dropped).
- **Keyboard-first:** `G <key>` view jumps, `⌘K` palette, `?` shortcuts overlay.

## 8. Testing architecture

| Layer | Tooling | Location | Gate |
|-------|---------|----------|------|
| Pure logic (rbac, config, time, rate-limit, validation, audit-meta, greeting, hierarchy, jwt) | Vitest | `src/lib/__tests__/` | 90% stmts / 80% branches |
| Server actions incl. security regressions (mocked Prisma/Better Auth session) | Vitest | `src/server-actions/__tests__/` | 90% stmts / 80% branches |
| Views + shared components | Vitest + Testing Library | `src/components/**/__tests__/` | — |
| Browser E2E (login, RBAC, board, messaging, a11y, HR) | Cucumber + Selenium | `e2e/` | 64 scenarios — CI job with Chrome + seeded Postgres 16 |

See `docs/TESTING.md` for the full strategy, coverage numbers and the manual test plan.

## 9. Deployment

- `bun run build` → standalone output (`.next/standalone`) + static assets.
- `bun run start` → `NODE_ENV=production` Node process behind the TLS proxy.
- Required env: `DATABASE_URL` (PostgreSQL), `BETTER_AUTH_SECRET` (32-byte random).
  The process refuses to boot without a strong secret.
- Security headers (CSP, frame-deny, nosniff, …) are emitted by `next.config.ts`;
  HSTS should be added at the proxy.
