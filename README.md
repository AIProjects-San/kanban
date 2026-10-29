# Fernly

A focused project-management workspace: projects, Kanban board, calendar, analytics,
team messaging, and full workspace administration — in one keyboard-first app.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript (strict) · Prisma 6 +
PostgreSQL · NextAuth v4 (JWT) · Zustand · custom OKLCH design system

## Quick start

```bash
bun install                 # install dependencies
cp .env.example .env        # then fill in DATABASE_URL + NEXTAUTH_SECRET
bunx prisma db push         # create the schema
bunx prisma generate        # generate the client
bun run db:seed             # demo data (12 users / 24 projects / 40 tasks)
bun run dev                 # http://localhost:3000
```

Demo logins (password `fernly123`):

| Email | Role |
|-------|------|
| `demo@fernly.app` | ADMIN — everything |
| `manager@fernly.app` | MANAGER — projects, invites, any task |
| `member@fernly.app` | MEMBER — own tasks, scoped views |

## Commands

| Command | Purpose |
|---------|---------|
| `bun run dev` | Dev server (Turbopack) on :3000 |
| `bun run build` / `bun run start` | Standalone production build / serve |
| `bun run lint` | ESLint |
| `bun run typecheck` | `tsc --noEmit` (strict — part of the gate) |
| `bun run test` | Vitest unit/integration suite (261 tests) |
| `bun run test:coverage` | Coverage report + threshold gates |
| `bun run test:e2e` | Selenium + Cucumber browser suite (needs Chrome; see `e2e/README.md`) |
| `bun run db:push` / `db:generate` / `db:seed` | Schema push / client / demo data |

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements, roles, acceptance criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System, layering, auth/authz flows, data model |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, controls, incident response |
| [`docs/TESTING.md`](docs/TESTING.md) | Test strategy + full manual test plan |
| [`docs/CODING_STANDARDS.md`](docs/CODING_STANDARDS.md) | Rules for server actions, components, tests |
| [`docs/CODE_REVIEW.md`](docs/CODE_REVIEW.md) | The full audit: findings, fixes, open risks |

## Keyboard shortcuts

`G D/T/P/C/A/E` — jump to Dashboard / Tasks / Projects / Calendar / Analytics / Team ·
`G U` Users (admin) · `G W` Workspace settings (admin) · `⌘K` command palette ·
`?` shortcut overlay

## Security posture (summary)

All authorization is enforced server-side; client gating is cosmetic. Every mutation is
permission-checked, ownership-checked where relevant, and audit-logged. Login is
rate-limited (5 failures / 15 min per email and IP) with timing-attack mitigation.
Production refuses to boot without a strong `NEXTAUTH_SECRET`. See
[`docs/SECURITY.md`](docs/SECURITY.md) for the complete model and the honest list of
accepted risks.
