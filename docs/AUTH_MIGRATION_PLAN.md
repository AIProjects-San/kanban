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

### Phase 0 — Spike (½ day, throwaway branch)
Install `better-auth` against a scratch database; port the credentials flow
end-to-end (email/password + bcrypt compare only). Validate: login, logout,
session fetch, `__Secure-` cookie behaviour behind the HTTPS proxy, and the
Prisma adapter against **both** the PostgreSQL and the SQLite sandbox schema
variants (ADR-008 — the adapter must accept the local datasource or the
sandbox preview breaks).

### Phase 1 — Schema + parallel stack (1–2 days)
- Prisma migration adding Better Auth's `session`/`account`/`verification`
  tables alongside the existing `User` (map, don't duplicate, the user row).
- `src/lib/auth-better.ts` with the full port map (§6).
- Route handlers under `/api/auth-better/[...all]` — v4 keeps serving
  `/api/auth/*` so production is untouched.
- The proxy cookie guard gains a second accepted cookie name (flag-gated).

### Phase 2 — Parity + test port (1–2 days)
- Port every `auth.test.ts` case: throttle budgets, dummy-bcrypt timing,
  soft-deleted-user rejection, tokenVersion revocation semantics (becomes:
  session invalidation on password change via `databaseHooks.user.update`),
  sign-in/sign-out audit rows incl. IP/UA (the ALS bridge installs the same
  way — it lives in our route wrapper, not in NextAuth).
- Extend e2e: a parallel login suite against the flag-on path.
- Security gates: the prod-smoke login checks run twice (both stacks).

### Phase 3 — Cutover + cleanup (1 day + 1 soak week)
- Flip the flag per-deployment (staging → production), keep v4 code for one
  release as instant rollback; sessions are 7-day JWTs, so a rollback window
  of 7 days covers every issued cookie.
- After the soak: delete the v4 stack, the `signout.ts` workaround, the
  module augmentation, and `next-auth` from package.json; update
  `PRODUCTION_READINESS.md` §6.1, DEPLOY.md, `.env.example`
  (`NEXTAUTH_SECRET` → `BETTER_AUTH_SECRET`; keep the same value — rotating
  it invalidates sessions, which is acceptable at cutover).

## 6. Port map (custom logic → Better Auth home)

| Today (NextAuth v4) | Tomorrow (Better Auth) |
|---|---|
| `authorize()` throttle (email/IP budgets) | `emailAndPassword.signIn.before` hook (same budget store: Redis when `REDIS_URL`, in-memory otherwise) |
| Dummy-bcrypt timing equaliser | same hook (logic is ours, not the framework's) |
| HIBP breach check on password SET | `emailAndPassword.password.*` / `databaseHooks.user.update` — unchanged semantics (fail-open) |
| `tokenVersion` JWT invalidation | DB-backed sessions: delete the user's sessions on password/role change (`databaseHooks`) — invalidation becomes immediate, not on-next-request; the 5-minute role refresh becomes a session `expiresAt` of ≤5 min or an explicit refetch |
| `events.signIn` audit row | `databaseHooks.session.create` or the sign-in hook |
| `events.signOut` + ALS IP/UA | `signOut` hook — the ALS bridge (`auth-request-context.ts`) is framework-agnostic and stays as-is |
| `__Secure-` cookie config | `advanced.useSecureCookies` + cookie prefixes in the Better Auth config |
| Proxy `getToken()` stale-cookie guard | decode the Better Auth session cookie (signed JWT or DB lookup) — same strip-and-expire recovery |
| `pages.signIn: "/"` | `advanced.redirectCallbacks` / client config |
| Custom `signout.ts` wrapper | delete — the v4 keepalive races it works around do not exist |

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

*Plan version: PR-43. Re-verify the library landscape (release cadence, v5
status) at execution time — this plan was written 2026-11-03.*
