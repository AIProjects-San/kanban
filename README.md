# Fernly

A focused project-management workspace: projects, Kanban board, calendar, analytics,
team messaging, and full workspace administration — in one keyboard-first app.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript (strict) · Prisma 6 +
PostgreSQL · NextAuth v4 (JWT) · Zustand · Tailwind v4 (CSS-first) + OKLCH design tokens

## Quick start

```bash
bun install                 # install dependencies
cp .env.example .env        # then fill in DATABASE_URL + NEXTAUTH_SECRET
                            # (+ NEXT_PUBLIC_DEMO_PASSWORD for the demo accounts)
bunx prisma db push         # create the schema
bunx prisma generate        # generate the client
bun run db:seed             # demo data (12 users / 24 projects / 40 tasks)
bun run dev                 # http://localhost:3000
```

Demo logins (password = `NEXT_PUBLIC_DEMO_PASSWORD` from your `.env` — the repo itself
contains **no credential literals**):

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
| `bun run test` | Vitest unit/integration suite (730+ tests) |
| `bun run test:coverage` | Coverage report + threshold gates |
| `bun run test:e2e` | Selenium + Cucumber browser suite (needs Chrome; see `e2e/README.md`) |
| `bun run bundle:check` | Client JS budget gate (L-P1-17) |
| `bun run audit:check` | Dependency audit gate (prod-runtime scoped) |
| `bun run db:push` / `db:generate` / `db:seed` | Schema push / client / demo data |

## Project conventions (the short version)

- **Branding** — the product name lives only in [`src/config/app.ts`](src/config/app.ts);
  every surface imports it (`APP`, `STORAGE_KEYS`, `ERROR_BRIDGE_KEY`, …).
- **Design tokens** — all colors/radii/shadows live in
  [`src/styles/tokens.css`](src/styles/tokens.css) (typed mirror:
  [`src/styles/tokens.ts`](src/styles/tokens.ts)); `globals.css` and components never
  hardcode color values. A sync test keeps the pair honest.
- **Secrets** — `.env` is the only home; no credential literal is committed anywhere
  (tests, scripts, k6, e2e all read env vars and fail loudly when unset).
- **HTTP** — native `fetch` (one outbound call), no axios; **UI** — shadcn/ui pattern
  with local primitives, no component kit. Rationale and alternatives:
  [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Documentation

| Doc | Contents |
|-----|----------|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements, roles, acceptance criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System, layering, auth/authz flows, data model |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | ADRs: axios, UI library, Tailwind v4, tokens, secrets |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, controls, incident response |
| [`docs/TESTING.md`](docs/TESTING.md) | Test strategy + full manual test plan |
| [`docs/CODING_STANDARDS.md`](docs/CODING_STANDARDS.md) | Rules for tokens, config, server actions, tests |
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
