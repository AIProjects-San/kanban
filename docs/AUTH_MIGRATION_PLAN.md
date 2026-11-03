# Auth Migration Plan — NextAuth v4 → Better Auth

> **PR-43 (production-readiness round 2 continuation).** Roadmap §6.1 asked
> for a *plan* for the strategic migration off NextAuth v4. This document is
> that plan: a precise inventory of what we run today, the options, a
> recommendation, and a phased execution plan with a port map for every piece
> of custom auth logic. **No code changes yet** — the migration itself is a
> dedicated project (est. 3–5 engineer-days plus a soak period).

## 1. Why migrate at all

- **next-auth 4.24.x is in maintenance mode.** Bug fixes and security patches
  land, but new features and framework integrations target the v5 line.
- **v5 (Auth.js) has been in beta for an extended period** (years, as of
  2026) with no stable release date — building new work on a permanent beta
  is its own risk.
- **The ecosystem has consolidated around Better Auth** (self-hosted,
  MIT-licensed, actively developed, batteries-included: credentials, 2FA,
  passkeys, magic links, organizations) with a first-class Prisma adapter.
  Community guidance through 2025–2026 trends toward it for new and migrated
  projects (e.g. the StarterPick 2026 comparison: Better Auth on features,
  NextAuth only on ecosystem maturity).
- Our surface is **credentials-only** (no OAuth providers) — the smallest
  possible migration surface. The cost of migrating is bounded; the cost of
  staying on a fading library compounds.

## 2. Current auth surface (inventory — verified against the code)

| Concern | Implementation | Notes |
|---|---|---|
| Library | `next-auth@4.24.15` | Credentials provider only |
| Session | JWT strategy, 7-day maxAge | Shortened from 30d (L-P0-8 defence in depth) |
| Config | `src/lib/auth.ts` (369 lines) | Providers, callbacks, events, cookie overrides |
| Sign-in logic | `authorize()` in auth.ts | Custom: brute-force throttle (email + IP budgets), timing-attack dummy bcrypt, soft-deleted-user filter, HIBP breach check hook (PR-35), role + tokenVersion stamping |
| Session revocation | `tokenVersion` in JWT callback | Password change / role change bumps version → next request invalidates; role re-read from DB every 5 min |
| Audit | `events.signIn`/`events.signOut` rows | Sign-out IP/UA via the AsyncLocalStorage bridge `src/lib/auth-request-context.ts` (PR-34) — NextAuth v4's signOut event exposes no request |
| Cookies | `__Secure-` prefixed in prod, classic names in dev | Mirrored in `src/proxy.ts` + `src/lib/auth-cookies.ts` |
| Edge guard | `src/proxy.ts` — `getToken()` per request | Strips stale/corrupt session cookies (secret-rotation self-healing) + nonce CSP |
| Sign-out | `src/lib/signout.ts` custom wrapper | Works around v4 client keepalive races; expires CSRF + callback cookies |
| Route | `src/app/api/auth/[...nextauth]/route.ts` | 68 lines: cookie-expiry wrapper + the ALS request-context install |
| Server consumers | `getServerSession` ×3 (`auth-guard.ts`, `page.tsx`, proxy), `usePermissions` hook | |
| Client consumers | `next-auth/react` ×6 files (providers, login-screen, use-permissions, bugs-view, signout) | |
| Types | `src/types/next-auth.d.ts` module augmentation | Session.user: id, role, roleCheckedAt |
| Env | `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | Fail-fast in production (Round 1) |
| Tests | `auth.test.ts` (throttle, tokenVersion, events), `proxy.test.ts` (cookie guard + CSP), `signout.test.ts`, `auth-request-context.test.ts`, e2e login/logout scenarios | ~60 unit + e2e scenarios — the migration's safety net |

## 3. Options considered

| | **A. Stay on v4.24.x** | **B. Auth.js v5** | **C. Better Auth** |
|---|---|---|---|
| Maintenance | Security fixes only | Perpetual beta | Active development |
| Credentials + JWT sessions | ✓ | ✓ | ✓ (session via DB or JWT; DB-backed is the default) |
| Prisma adapter | n/a | ✓ | ✓ (`better-auth/adapters/prisma`) |
| Custom authorize logic (throttle, dummy-bcrypt) | current | re-implement in provider hooks | re-implement as hooks (`before`/`databaseHooks`) |
| 2FA / passkeys / magic links | build manually | build manually | built-in plugins |
| Migration risk | none now, rising later | beta churn | schema additions (session/account/verification tables) |
| Ecosystem | largest | large | growing fast |

## 4. Recommendation

**Migrate to Better Auth (option C), in four phases behind a feature flag, keeping NextAuth v4 running until parity is proven.** If the team prefers the
smallest possible diff and no new tables, option B is the fallback — but it
re-anchors us to a beta line, which is the failure mode we are trying to
escape.

## 5. Phased plan

### Phase 0 — Spike (½ day, throwaway branch) — ✅ DONE 2026-11-03

Executed as `scripts/spike-better-auth/` (spike.schema.prisma + spike.mjs +
run-spike.sh; scratch SQLite DB + scratch Prisma client, both gitignored).
Every check passed against **better-auth@1.7.15**:

- ✅ credentials sign-in → session cookie (`fernly.session_token`,
  httpOnly, SameSite=Lax, Path=/, Max-Age=7d) → get-session → sign-out
  revokes DB rows + expires the cookie — all through the REAL HTTP handler.
- ✅ `hooks.before` / `hooks.after` fire on `/sign-in/email` with the
  request, body and path available; `databaseHooks.session.create.after`
  fires on session mint.
- ✅ Unknown email burns a bcrypt cost-12 compare (timing-equalizer parity
  with the v4 dummy hash — Better Auth calls our own `password.hash`).
- ✅ Soft-deleted users rejected by the before-hook gate;
  `session.create.before` is a second, DB-level guard.
- ✅ SQLite validated end-to-end (sandbox). **PostgreSQL**: the adapter
  `provider` is a config string only; the real Postgres run is covered by
  the CI e2e job (Postgres 16 service container) in Phase 2. The sandbox
  has no Postgres binary.

Findings that adjust the Phase 1 port map (validated, not assumed):

| # | Finding |
|---|---|
| F1 | A bare `PrismaClient` fails init — the explicit `prismaAdapter(prisma, { provider: "sqlite" \| "postgresql" })` wrapper is required. The provider is picked from the effective `DATABASE_URL` (same ADR-008 rule as the rest of the app). |
| F2 | **`advanced.database.validateSchema: false` is required** for our brownfield `User`: the runtime schema check throws `SchemaMismatchError` on required app-only columns Better Auth never writes (`passwordHash`). Our own migrations + CI cover the auth tables instead. |
| F3 | **1.7 stores credentials on the `Account` table** (`providerId: "credential"`, `accountId: userId`, `password`), not on `User`. The port adds a one-way sync bridge (§6, updated): the sign-in before-hook upserts the credential row from the current `User.passwordHash` before Better Auth's own verify — one bcrypt compare total, and `User.passwordHash` stays the single source of truth during the parallel period. |
| F4 | Hooks must throw `APIError` (from `better-auth/api`) to control status codes — a plain `Error` becomes 500 `SERVER_ERROR`. |
| F5 | The after-hook reads the endpoint result from `ctx.context.returned`; an `APIError` there exposes the numeric code as `.statusCode` (its `.status` is the string code, e.g. `"UNAUTHORIZED"`). |
| F6 | Hooks receive `ctx.request` directly — the sign-out audit row gets IP/UA without the ALS bridge (which stays for the v4 stack only). |

### Phase 1 — Schema + parallel stack (1–2 days)
- Prisma migration adding Better Auth's `session`/`account`/`verification`
  tables alongside the existing `User` (map, don't duplicate, the user row).
- `src/lib/auth-better.ts` with the full port map (§6).
- Route handlers under `/api/auth-better/[...all]` — v4 keeps serving
  `/api/auth/*` so production is untouched.
- The proxy cookie guard gains a second accepted cookie name (flag-gated).

### Phase 2 — Parity + test port (1–2 days) — ✅ DONE 2026-11-03
- ✅ `src/lib/__tests__/auth-better.test.ts` — 20 cases ported 1:1 from
  `auth.test.ts` against the real HTTP handler (spike harness): throttle
  budgets (incl. the shared-budget contract with v4 authorize), dummy-bcrypt
  timing, soft-deleted rejection, wrong-password/no-audit, email
  normalization, DB-outage 401, PR-11 dual-budget reset, cookie posture
  (fernly.session_token httpOnly/Lax/7d), get-session payload,
  sign-out revocation + IP/UA audit rows, best-effort audit failure,
  revocation semantics (flag-gated deleteMany) and the weak-secret boot
  refusal. 4 flag-on proxy cases in `src/proxy.test.ts`.
- ✅ e2e: `e2e/features/auth-better.feature` (@auth-better, run via
  `bun run test:e2e:better` after starting the app with
  NEXT_PUBLIC_AUTH_STACK=better) — 5 scenarios / 30 steps through the real
  UI incl. the fernly cookie assertion and sidebar sign-out. The main suite
  (`bun run test:e2e`) excludes the tag and stays green: 62 scenarios /
  455 steps. CI runs BOTH passes; the better pass on the Postgres 16
  service container is the real PostgreSQL validation of the table set
  (spike §5).
- ✅ Security gates: prod-smoke login checks now run against BOTH stacks
  (17/17 against the standalone production build, incl. better-stack
  401-rejection, login, get-session and sign-out cookie expiry).
- ✅ Gates: typecheck/eslint clean, 1189/1189 unit tests, bundle budget OK
  with better-auth in the tree.

### Phase 3 — Cutover + cleanup (1 day + 1 soak week) — ✅ COMPLETE 2026-11-03 (PR-48/PR-49)
- ✅ **Staging cutover executed**: the sandbox preview runs the Better Auth
  stack, verified through the real UI — stale v4 cookies cleanly retired by
  the proxy, sign-in mints the fernly session, the dashboard renders,
  sidebar sign-out returns to the login screen.
- ✅ **Repo-default flip (PR-49)** — `NEXT_PUBLIC_AUTH_STACK` defaulted to
  **better** in `src/lib/auth-stack.ts`; unit parity held through the flip
  (1190/1190). **Soak waived by owner sign-off** — this workspace is a dev
  environment with no active users, so the ≥1-week parallel soak had no
  surface to observe.
- ✅ **Post-soak cleanup (PR-49, same day)** — the v4 stack is deleted:
  `src/lib/auth.ts`, `signout.ts`, `auth-cookies.ts`, `auth-stack.ts`,
  `types/next-auth.d.ts`, `/api/auth/[...nextauth]` (route + tests), the
  v4 proxy guard branch, the v4-only unit suites, and `next-auth` from
  package.json (lockfile regenerated). `NEXTAUTH_SECRET` →
  `BETTER_AUTH_SECRET` (no fallback; same value expected) and
  `NEXTAUTH_URL` → `APP_URL`/`BETTER_AUTH_URL`. The ALS audit bridge is
  gone (Better Auth hooks receive the request directly); its
  `extractClientIp` helper survives as `lib/client-ip.ts`. The two e2e
  passes merged into one (login.feature gained the fernly-cookie and
  sign-out scenarios; `test:e2e:better` removed; CI runs a single pass);
  prod-smoke's credential checks now target `/api/auth-better/*`
  exclusively; docs updated (DEPLOY §1.2/§3a, PRODUCTION_READINESS,
  SECURITY, ARCHITECTURE, README, STATUS_AND_ONCALL, .env.example).

## 6. Port map (custom logic → Better Auth home — updated by the Phase 0 spike)

| Today (NextAuth v4) | Tomorrow (Better Auth 1.7) |
|---|---|
| `authorize()` throttle (email/IP budgets) | `hooks.before` on `/sign-in/email` (same budget store: Redis when `REDIS_URL`, in-memory otherwise); failures hit both buckets in `hooks.after` (reads `ctx.context.returned.statusCode`, spike F5) |
| Dummy-bcrypt timing equaliser | built-in — Better Auth burns our own `password.hash` (bcrypt cost 12) when the user/credential row is missing; the before-hook does the same for soft-deleted users (spike-verified ≥150 ms) |
| Credential storage on `User.passwordHash` | stays on `User.passwordHash` (single source of truth); the before-hook upserts the 1.7 `Account` credential row (`providerId: "credential"`, `password: User.passwordHash`) right before Better Auth's verify — exactly one bcrypt compare per attempt (spike F3) |
| Soft-deleted-user sign-in rejection | `hooks.before` lookup gate (`deletedAt` filter) + `databaseHooks.session.create.before` as the DB-level backstop |
| HIBP breach check on password SET | unchanged — the check lives in the app's password-change/reset actions (`lib/breach-check.ts`), which the framework swap never touches (fail-open semantics preserved) |
| `tokenVersion` JWT invalidation | DB-backed sessions: password change / role change / soft-delete flows call `deleteUserSessions(userId)` (flag-gated helper); invalidation becomes immediate instead of on-next-request. The 5-minute role refresh becomes `session.cookieCache: { maxAge: 300 }` |
| `events.signIn` audit row | `hooks.after` on `/sign-in/email` (success branch) — writes `auth.signed_in` with IP/UA from `ctx.request` |
| `events.signOut` + ALS IP/UA | `hooks.after` on `/sign-out` — IP/UA from `ctx.request` directly; the ALS bridge (`auth-request-context.ts`) remains for the v4 stack only |
| `__Secure-` cookie config | `advanced.useSecureCookies` + `advanced.cookiePrefix: "fernly"` (dev: `fernly.session_token`, prod: `__Secure-fernly.session_token` — spike-verified attributes) |
| Proxy `getToken()` stale-cookie guard | flag-gated: on the better stack the proxy skips the v4 JWE check (DB-backed opaque tokens fail silent — no log spam, no wedge); v4 guard unchanged for rollback |
| `pages.signIn: "/"` | the app shell keeps rendering the login screen when unauthenticated — no framework redirect config needed |
| Custom `signout.ts` wrapper | delete at cleanup — the v4 keepalive races it works around do not exist (`authClient.signOut()` + hard navigation) |

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Prisma adapter vs SQLite sandbox variant breaks preview | Phase 0 explicitly validates both datasources |
| Audit-trail regression (sign-in/out rows are compliance-relevant) | Parity tests ported 1:1 before cutover; audit rows are the acceptance criterion |
| Session format change logs everyone out | Accept at cutover (one-time, communicated); do it in a low-traffic window |
| Rollback needed after cutover | Keep the v4 stack + flag for one release; 7-day JWT maxAge bounds the exposure |
| Throttle/bcrypt subtleties lost | The ported unit tests are the contract — no behavioural drift permitted |

## 8. Decision checklist (owner sign-off before starting)

1. Confirm the recommendation (Better Auth) or pick the v5 fallback.
2. Allocate the 3–5 engineer-days + soak week.
3. Pick the cutover window (low traffic; users will be signed out once).
4. Confirm the audit-row parity requirement with whoever owns compliance.

---

*Plan version: PR-49 (migration complete). Re-verify the library landscape
(release cadence, v5 status) before any future auth work — the migration
described here executed 2026-11-03.*
