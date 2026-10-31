# Fernly — Architecture

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) ·
Prisma 6 + PostgreSQL (Supabase) · NextAuth v4 (JWT) · Zustand · custom CSS design system

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
                    │  /api/auth/*     — NextAuth (credentials)  │
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
(`src/server-actions/`), organised **per domain** since the 2026-10-30 split:
`dashboard`, `tasks`, `projects`, `members`, `events`, `notifications`,
`reminders`, `users`, `time-entries`, `messages`, `assignments`, `workspace`,
`audit` — with `data.ts` as a thin barrel re-export so callers have one stable
import path. Every client-invoked action returns an
**`ActionResult<T> = { ok: true; data: T } | { ok: false; code; error }`**
(`lib/action-result.ts`) instead of throwing: production never masks action
error messages, and clients branch on `res.ok`. SSR-only loaders
(`getDashboardData`, `getUserProfile`, `getUserSettings`) keep the throwing
contract — a DB outage there belongs in the error boundary, not an empty UI.

## 2. Layering

```
app/page.tsx                — server component: session + initial payload
components/fernly/          — design system + shells (app-shell, sidebar, modals…)
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
types/                      — client-facing DTOs + next-auth augmentation
```

**Dependency rule:** views → fernly components → lib (pure) → server-actions → db.
Nothing in `lib/` imports React components except the two .tsx constant files
(`constants.tsx` holds icon-carrying accent definitions).

## 3. Authentication & session flow

1. `authorize()` (lib/auth.ts): normalises email → rate-limit check (email + IP buckets,
   5/15 min) → user lookup → **constant-time** bcrypt compare (dummy hash when the user
   doesn't exist) → audit sign-in → return `{id, email, name, role}`.
2. JWT callback stamps `id`, `role`, `roleCheckedAt`. Every request where
   `roleCheckedAt` is older than 5 minutes re-reads the role from the DB (demotions
   apply without re-login; deleted accounts are neutered to an empty id, which the app
   treats as signed-out).
3. `getSession()` (auth-guard) is the single server-side entry point; unknown roles are
   downgraded to `MEMBER` (deny-by-default).

**Secrets:** production refuses to boot with a missing/weak `NEXTAUTH_SECRET`
(`NEXT_PHASE=phase-production-build` is exempt so builds succeed on secret-less CI).
Cookies flip to `Secure` automatically in production.

## 4. Authorization model (two layers)

- **Layer 1 — permission checks** (`requirePermission`): every action states its
  required permission from the 18-key matrix (`lib/rbac.ts`). Client components use
  `usePermissions()` to hide UI affordances — cosmetic only.
- **Layer 2 — row-level scoping**: `getDashboardData()` computes a scoped project-id set
  (owned ∪ assigned-tasks ∪ explicit assignments) from the **server session** and pushes
  it into every query. MEMBER and MANAGER are both scoped; ADMIN is not.
- **Ownership assertions**: task edits (`task:edit:own` without `:any`), message
  deletion (sender/recipient), reminder toggling (owner/admin), profile/settings reads
  and writes (self or `role:manage`).

**Critical invariant (regression-tested):** caller-supplied arguments are never used for
authorization decisions. Identity always comes from `getSession()`.

## 5. Data model (22 models, key ones)

| Model | Purpose | Notable relations |
|-------|---------|-------------------|
| `User` / `UserSettings` | login identity + preferences | 1–1 settings; assignments cascade |
| `TeamMember` | directory entry (matches `User` by email) | tasks (SetNull), time entries |
| `Project` | workspace project | tasks (SetNull), assignments (Cascade) |
| `Task` | Kanban card with `order` per column | project/assignee (SetNull) |
| `ProjectAssignment` | explicit user↔project membership | unique (projectId, userId) |
| `Message` | threaded DMs with `senderUserId`/`recipientUserId` | privacy enforced in queries |
| `Reminder` | dashboard to-do, `ownerId` nullable (null = workspace-wide) | — |
| `Notification` | workspace activity feed | global by design |
| `AuditLog` | append-only trail (28 typed actions) | written by every mutation |
| `Workspace` + 6 config tables + `Role/Permission/RolePermission` | runtime-configurable vocabulary and RBAC | cached by config-loader |

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

- **Theme:** OKLCH design tokens in `src/styles/tokens.css` (single source of truth,
  mirrored to TS in `src/styles/tokens.ts`; imported by `globals.css`), four accent
  themes, dark mode via a
  `dark` class + per-user persistence (applied server-side pre-hydration to avoid flash).
- **State:** server data arrives as props from the server component; Zustand holds only
  view/session state (active view, open modals, inbox, palette, refresh counter).
  `bumpRefresh()` triggers a server re-render after mutations.
- **Design system:** `components/fernly/*` — no third-party UI kit. The shadcn
  scaffold was removed (49 dependencies dropped).
- **Keyboard-first:** `G <key>` view jumps, `⌘K` palette, `?` shortcuts overlay.

## 8. Testing architecture

| Layer | Tooling | Location | Gate |
|-------|---------|----------|------|
| Pure logic (rbac, config, time, rate-limit, validation, audit-meta, greeting) | Vitest | `src/lib/__tests__/` | 90% stmts / 80% branches |
| Server actions incl. security regressions (mocked Prisma/next-auth) | Vitest | `src/server-actions/__tests__/` | 90% stmts / 80% branches |
| Shared components | Vitest + Testing Library | `src/components/fernly/__tests__/` | — |
| Browser E2E (login, RBAC, board, messaging) | Cucumber + Selenium | `e2e/` | run on machines with Chrome |

See `docs/TESTING.md` for the full strategy, coverage numbers and the manual test plan.

## 9. Deployment

- `bun run build` → standalone output (`.next/standalone`) + static assets.
- `bun run start` → `NODE_ENV=production` Node process behind the TLS proxy.
- Required env: `DATABASE_URL` (PostgreSQL), `NEXTAUTH_SECRET` (32-byte random).
  The process refuses to boot without a strong secret.
- Security headers (CSP, frame-deny, nosniff, …) are emitted by `next.config.ts`;
  HSTS should be added at the proxy.
