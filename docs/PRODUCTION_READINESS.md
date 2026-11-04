# Production Readiness Review — Fernly

**Date:** 2026-11-03 · **Scope:** entire application + deployment stack
**Method:** (1) research of current production-readiness criteria for the exact
stack (Next.js 16, Better Auth, Prisma 6, self-hosted Docker), including the
2026 security advisories; (2) full-codebase audit of all 30 server-action
modules, the auth/middleware layer, the Prisma schema, the API routes, the
Docker/nginx/compose deployment files and the CI pipeline; (3) crosscheck of
every criterion against the code; (4) fixes with regression tests; (5) full
gate run; (6) a smoke load test against the production standalone build.

**Verdict:** the application is production-ready for its intended target
(single-host self-hosted Docker, TLS-terminated edge, PostgreSQL, 2 replicas
behind nginx) once the operator checklist in `docs/DEPLOY.md` is followed.
Round 1 closed **29 findings** (PR-01…PR-29); round 2 closed **10 of the
12 remaining roadmap items** (PR-30…PR-39) and its continuation closed the
rest of the engineering backlog (PR-40…PR-46, §3c) — what remains (§6) is
execution and owner sign-off, none of it code.

---

## 1. Research basis — what "production ready" was crosschecked against

| Source | What it contributed |
|---|---|
| Next.js **September 2026 security release** (16.3.8): CVE-2026-94483 (Image-Optimization SSRF), CVE-2026-94484/94543 (SSG/ISR cache poisoning), CVE-2026-94485 (metadata-image `dynamicParams` bypass, webpack only) | Crosschecked: the app configures **no `images.remotePatterns`** (SSRF N/A), uses the **App Router with fully dynamic routes** (SSG/ISR poisoning N/A — only `/_not-found` is static), builds with **Turbopack** (metadata-image N/A). Not affected by any of them. |
| Next.js **October 2026 out-of-band release**: critical RCE via `use cache` typed arrays (GHSA-673q-mjm6-r5xr, fixed 16.4.1) and librsvg via bundled sharp (CVE-2026-96889) | The app uses **no Cache Components / `use cache`** and no remote/SVG image optimization. **Patched anyway: next 16.4.3 → 16.4.4** (PR-28). |
| **NextAuth 2026 CVEs** (CVE-2026-73419/73420, auth bypass / account linking) | **Resolved structurally (PR-48/PR-49): the app migrated off NextAuth entirely** — Better Auth 1.7 is the only auth stack (credentials-only, DB-backed sessions); the `next-auth` dependency is removed from the tree. |
| **Zod CVE-2026-6991** (SQL injection in the CUID handler, ≤ 4.3.6) | The app runs **zod 4.6.7** — not affected. |
| Auth deployment docs: `secret` **required in production**, cookie/session hardening checklist | Already enforced beyond the docs: the app **refuses to boot** with a missing/weak `BETTER_AUTH_SECRET` (and with an unset `SERVER_ACTIONS_ALLOWED_ORIGINS`). Cookie hardening gaps found and fixed: PR-06, PR-27. |
| Prisma production guidance (client singleton, migration discipline, provider-appropriate pooling) | Client is a `globalThis` singleton; migrations are adopted (no `--accept-data-loss`), every migration has a `down.sql`. Deployment gap found and fixed: the shipped image had **no way to run migrations** (PR-24). |
| Generic production-readiness checklists (security, observability, CI/CD, data, deployment) — gorrion-io checklist, SRE PRR practice | Used as the crosscheck matrix in §2. |
| `bun pm audit` (traced to the standalone runtime deps) | 0 critical / 0 high advisories in shipping dependencies (moderate/low findings are dev-toolchain or non-shipping; informational). |

---

## 2. Dimension scorecard (crosscheck)

| Dimension | Status | Notes |
|---|---|---|
| Authentication & session management | ✅ Strong | JWT sessions, 7-day cap, `tokenVersion` revocation ≤5 min, soft-delete invalidation, timing-equalized unknown-email path (cost-12 dummy hash), 5/15 min per-email **and** per-IP throttle (Redis-backed, fail-open), prod boot-fail on weak secret, `__Secure-` cookie prefix (PR-27). |
| Authorization (RBAC + hierarchy) | ✅ Strong after fixes | Static-floor ∪ DB-ceiling permission model, deny-by-default, hierarchy-aware target guards, single-source project scoping. Gaps fixed: PR-02, PR-03, PR-04, PR-23. |
| Input validation | ✅ Strong | zod schemas on every mutation (strict mode), server-derived identity everywhere, enum-validated lifecycle transitions. |
| Security headers / CSP | ✅ Strong after fixes | Nonce-based CSP without `unsafe-inline`/`unsafe-eval` in prod, HSTS, XFO DENY, nosniff, Permissions-Policy. Fixed: `connect-src` exfil hole + decorative nonce (PR-06). |
| Rate limiting | ✅ Strong after fixes | Login, password-reset, and now client-error ingestion (PR-13); Redis-backed with in-memory fallback; per-IP buckets reset on success (PR-11). |
| Data integrity & transactions | ✅ Strong after fixes | 9 multi-write flows wrapped in `$transaction` (PR-15); guarded status flips in the leave module (QA rounds); FK cascades reviewed. |
| Query hygiene / performance | ✅ Good after fixes | Every dashboard query take-capped; 15+ additional caps (PR-21); 6 hot-path indexes added (PR-16); 2 true N+1s eliminated (PR-19, PR-20); smoke load: 0 errors under both profiles (§5). |
| Data retention & hygiene | ✅ Good after fixes | Audit retention (180 d, batched, cron) + new daily purges: expired reset tokens, read notifications >90 d, stale message-read state (PR-17). |
| Error handling & resilience | ✅ Strong | Route + global error boundaries with client bridge, INTERNAL masking (no stack leakage), fail-open limiter, NoopMailer fail-safe, graceful shutdown handlers. |
| Observability | ✅ Good | Structured JSON logs with request ids + `durationMs`, Sentry reporter with PII/secret redaction, `/api/health` (DB + Redis probes, detail gated by CRON_SECRET), audit trail on every mutation, **Prometheus `/api/metrics` (PR-32)**. |
| Deployment & config | ✅ Good after fixes | Standalone Docker image (non-root, no secrets in layers, healthcheck), migration gate (PR-24), TLS story + real LB health endpoint (PR-25), complete `.env.example` with boot-contract documentation, **optional Redis AUTH (PR-33)**. |
| Testing | ✅ Strong | 1143 unit tests (95%+ coverage gate in CI), 57 e2e scenarios / 425 steps on a fresh seed + real browser (incl. a WCAG axe-core smoke gate — PR-39), **production-build smoke suite** (PR-37), bundle budget + secret-leak grep in CI, SHA-pinned actions. |
| Backup / recovery | ✅ Documented | `docs/BACKUP_RECOVERY.md` (pg_dump + PITR + restore drill procedure). |

---

## 3. Findings fixed this round (PR-01 … PR-29)

Severity: **P1** = would break/betray production, **P2** = meaningful risk/cost,
**P3** = hygiene. Every fix landed with regression tests where testable.

### P1 — launch blockers

| ID | Area | Finding → Fix |
|---|---|---|
| **PR-01** | Deploy/security | The sandbox `Caddyfile`'s `XTransformPort` handler proxied to `localhost:{query.XTransformPort}` — an attacker-chosen port: an open SSRF-style proxy into every loopback service if ever exposed publicly. → Moved to `deploy/sandbox-preview/` with a loud warning header; production edge is `nginx.conf` or the new `deploy/Caddyfile.production` (automatic HTTPS, no port transform). |
| **PR-02** | Authz / functional | `restoreUser` routed through `requirePermissionForTarget`, whose target lookup filters `deletedAt: null` — a user **in the trash always failed the lookup**, so the Trash → restore-user feature could never restore anyone (the old unit test passed only because its mock intercepted both lookups). → Inline hierarchy-aware guard that deliberately does not filter soft-deleted targets (admins manage everyone; managers their subtree), plus the two writes moved into one transaction. 4 new tests incl. MANAGER-in-subtree / out-of-subtree regressions. |
| **PR-15** | Data integrity | 9 multi-write operations ran without a transaction (a crash mid-way left half-applied state): `changeBugStatus` (bug+comment), `updateProfile`/`updateUser` (user+roster sync), `createRole` (role+permissions, also an N+1 write loop), `updateRole` (role.update outside the permission tx), `updateLeaveType` (type+policy), `setTaskDone` + `createChecklist` (onboarding), `restoreUser` (PR-02). → All wrapped; `createRole` now uses one `createMany`. |
| **PR-24** | Deploy | The runner image ships **only the standalone output** — no `prisma/` folder, no Prisma CLI — so DEPLOY.md's documented `docker compose exec fernly-1 bunx prisma migrate deploy` could never work. → New `migrator` Docker stage + one-shot `migrate` compose service with a retry loop; app containers now `depends_on: migrate: service_completed_successfully` (a failed migration fails the deploy loudly). DEPLOY.md corrected (incl. the `prisma studio` seed-admin instructions, which had the same problem). |

### P2 — meaningful risk / cost

| ID | Area | Finding → Fix |
|---|---|---|
| **PR-03** | Authz | `getUserSettings(userId)` required only *a* session — any user could read any other user's settings (IDOR). → Ownership enforced; the update path already had it. |
| **PR-04** | Authz | `loadWorkspaceConfig()` had **no auth check** — anonymous callers received the workspace config + full role/permission matrix. → Session gate (`settings:edit` — granted to every role); the login screen never calls it. |
| **PR-05** | Perf/DoS | ICS calendar export queried the **entire** CalendarEvent table. → `take: 1000` + `truncated` flag. |
| **PR-06** | Security | Both CSPs allowed `connect-src 'self' https:` — the bare `https:` scheme-source permits exfiltration to any HTTPS host. → Production is strictly `'self'` (dev keeps `ws:` for HMR). Also: the CSP nonce was set only on the *response*, so Next.js never applied it to its bootstrap scripts (it was decorative) — the nonce + CSP are now propagated on the forwarded request headers per the Next.js middleware pattern. |
| **PR-11** | Security/UX | Successful sign-in reset the per-**email** throttle but not the per-**IP** bucket — a shared-NAT office stayed locked out after one user's typos. → Both buckets reset on success (tested with a simulated NAT). |
| **PR-13** | Security | `/api/client-errors` (unauthenticated by design, accepts Origin-less probes) had no rate limit — a scripted client could flood the error tracker with 8 KB payloads. → Per-IP budget (20/5 min, Redis-backed, fail-open) with a proper 429 + `Retry-After`; 4 new route tests. |
| **PR-16** | Perf | Six hot query paths had no index: `CalendarEvent.date` (dashboard window + ICS), `Reminder.ownerId` (dashboard), `Notification[recipientUserId, createdAt]` (feed ordering), `Message.createdAt` (inbox ordering), `AuditLog[entityType, entityId]` (entity history), `PasswordResetToken.expiresAt` (purges). → Schema + provider-neutral migration `20261108000000_pr16_hot_indexes` (+ `down.sql`). |
| **PR-17** | Data hygiene | Only the audit log had a retention story; `PasswordResetToken` rows were never deleted (expired tokens accumulate forever), read notifications and orphaned message-read state too. → The daily cron endpoint is now a full maintenance pass: audit retention + purge of expired/used reset tokens (24 h grace), read notifications >90 d, and message-read rows of messages soft-deleted >90 d. Unread notifications and message bodies are deliberately never purged (owner data). |
| **PR-18** | Product | Three admin-editable workspace settings (`auditLogLimit`, `entityHistoryLimit`, `dashboardNotifLimit`) were ignored — readers hardcoded 300/50/20. → All three honored via a tolerant, clamped reader (`getWorkspaceLimit`). |
| **PR-19** | Perf | `getMyLeaveData` ran a genuine query N+1: 3 queries **per leave type** (incl. a write on a read path) on every Leave-view load. → One batched read + `createMany` materialization for missing rows only. |
| **PR-20** | Perf | `recalcMemberStats` fetched **every task row** of a member and counted in JS — on every task mutation, once per distinct assignee in bulk ops. → Two indexed `COUNT` queries. |
| **PR-21** | Perf/DoS | 15+ read paths had no `take` (admin lists, HR queues/directory, onboarding, assignment rosters, per-thread/per-task lists, scoping pre-queries). → Sensible hard caps everywhere (100–1000 by surface). |
| **PR-23** | Authz | Soft-deleted users could still be staffed onto projects (`assignUserToProject`) and resolved as message recipients. → `deletedAt: null` filters on both; soft-deleted projects also rejected for staffing. |
| **PR-25** | Deploy | nginx's `/health` returned a static `ok` even with **every** app replica down (external monitors were lied to), 443 was mapped with no TLS listener, and `/_next/static` sent duplicate `Cache-Control` headers. → New `/upstream-health` (real app+DB+Redis probe) for external monitors; documented TLS options (production Caddyfile with automatic HTTPS, nginx TLS example config, or external LB); header dedup. |
| **PR-27** | Security | Production cookies used the classic `next-auth.*` names despite `Secure` flags — no `__Secure-` prefix. → All three cookies carry `__Secure-` in production (dev/sandbox unchanged); proxy + signout wrapper already handle both variants. Tests pin both modes. |
| **PR-28** | Deps | next 16.4.3 → **16.4.4** (current patch train, past the October 2026 critical RCE fixes); verified zod 4.6.7 and next-auth 4.24.15 are the patched releases for their 2026 CVEs. |

### P3 — hygiene

| ID | Area | Finding → Fix |
|---|---|---|
| **PR-12** | Security | `/api/health?detail=1` compared the bearer token with `===` ("constant-time-ish") while the cron route did it properly. → XOR-loop constant-time compare. |
| **PR-14** | Docs | `password.ts`'s header claimed charset rules that never existed. → Comment corrected: the policy is deliberately **length-only** (NIST SP 800-63B style); breach-list checking documented as roadmap. |
| **PR-22** | Observability | Six empty `catch {}` blocks (HR notification best-effort paths, client-info extraction, balance materialization races) failed silently. → All log the failure while preserving best-effort semantics. |
| **PR-26** | Polish | No `metadataBase` (relative metadata URLs) and no explicit `viewport`/`themeColor`. → Both added, driven by `APP_URL`/`NEXTAUTH_URL` with safe fallback. |
| **PR-29** | Perf validation | No load numbers existed for the production build. → `scripts/load-smoke.mjs` (Bun, no k6 dependency) + results in §5. |

### Also fixed en route

- `.env.example` created (DEPLOY.md referenced it; it didn't exist) with the full variable matrix and the **boot contract** (what refuses to boot / stays disabled when unset).
- docker-compose: optional bundled PostgreSQL (`--profile local-db`), `volatile-lru` Redis policy (was `allkeys-lru`, which could evict limiter state while sparing nothing of value), `--scale` guidance (plain compose ignores `deploy.replicas`).
- DEPLOY.md: rewritten migration/TLS/health/seed-admin sections; post-deploy checklist updated.

---

## 3b. Round 2 — roadmap closure (PR-30 … PR-39)

The 12 accepted-risk items from round 1 (§6) were re-reviewed; **10 are now
closed**, each with the failing-test→fix→gate discipline of round 1.

| ID | Was (roadmap §6) | Now |
|---|---|---|
| **PR-30** | §6.3 — cron overlap guard was per-instance; 2 replicas = the daily maintenance could run twice. | `SET NX PX` lock in Redis shared by every instance (`src/lib/maintenance-lock.ts`); the key's TTL *is* the min-interval, so a crashed runner self-heals at expiry. Fails open to the old in-memory guard when Redis is down (a skipped maintenance would be strictly worse). The cron response now reports `lockBackend`, and `recordMaintenanceRun()` stamps `fernly_maintenance_last_run` for the metrics endpoint. |
| **PR-31** | §6.10 — config-cache staleness across replicas was ≤10 s (TTL only). | Instant cross-instance invalidation: `bumpConfigCache()` publishes on a Redis pub/sub channel; each instance's dedicated subscriber connection clears its local cache. The 10 s TTL stays as the backstop (pub/sub is delivery-not-guaranteed). No-op without REDIS_URL. |
| **PR-32** | §6.8 — no Prometheus `/metrics` endpoint. | `/api/metrics` in the standard text format: app/DB/Redis up-ness, process uptime + RSS/heap, event-loop lag, maintenance freshness. Gated by the same CRON_SECRET bearer (503 when unset, 401 wrong token); scrape config documented in DEPLOY.md §5. Request counters deliberately stay in the structured logs — per-instance in-memory counters are wrong under multi-replica scraping. |
| **PR-33** | §6.2 — Redis without auth inside the compose network. | Opt-in `REDIS_PASSWORD`: compose runs redis-server with `--requirepass` and the app's default REDIS_URL embeds the password slot (`redis://:<pw>@redis:6379`). ioredis's URL parser was verified (test-pinned) to treat the empty slot as no-AUTH, so the default behaviour is unchanged. Healthcheck authenticates when a password is set. |
| **PR-34** | §6.6 — sign-out audit rows lacked IP/UA (NextAuth v4's signOut event exposes no request). | AsyncLocalStorage request-context bridge: the route handler wraps every NextAuth request with `{ip, userAgent}`; the signOut event reads it when writing `auth.signed_out`. Race-free under concurrent sign-outs (ALS isolation is test-pinned). The trusted-proxy IP extraction moved to one shared helper used by both sign-in and sign-out. |
| **PR-35** | §6.7 — password breach-list check was a recommended add-on. | Opt-in HIBP k-anonymity check (`PASSWORD_BREACH_CHECK=1` or `HIBP_API_KEY`): only a 5-char SHA-1 prefix ever leaves the server; padded + keyed request; 3 s abort; **fail-open** on any error (a third-party outage must never lock users out of setting passwords). Wired into all four password-SET flows (self change, admin create, admin reset, self reset); login is deliberately unchecked. |
| **PR-36** | §6.4 — HSTS without includeSubDomains (operator decision, undocumented knob). | `HSTS_INCLUDE_SUBDOMAINS=1` / `HSTS_PRELOAD=1` env knobs (preload implies includeSubDomains); documented as irreversible commitments in `.env.example` + DEPLOY.md. Composition test-pinned in deploy-and-ops. |
| **PR-37** | §6.9 — e2e only ever ran against the dev server; the prod build had no functional suite. | `bun run test:prodsmoke` (`scripts/prod-smoke.mjs`): boots the REAL standalone build on a scratch port and verifies boot, login SSR, security headers (HSTS/XFO/nonce-CSP), bad-credential rejection, full credential login, the authenticated shell, and the health/metrics auth gates — 10 checks, green. |
| **PR-38** | §6.12 — right-to-erasure had soft-delete + export but no hard-erase workflow. | `eraseUser()` (admin-only, never yourself, **trash-first two-step safety**): one transaction writes the `user.erased` audit row (inside the tx — no misleading row on failure, no lost evidence on success), deletes the TeamMember roster row (the remaining PII surface), anonymises the erased person's display names on shared messages, and deletes the account row (schema cascades clean up settings/notifications/read-state/reset-tokens/assignments; SetNull promotes reports and clears project ownership). Audit + business records retained by design and documented for the privacy notice. |
| **PR-39** | §6.11 — accessibility in place but no automated WCAG gate. | axe-core smoke gate in the e2e suite (4 scenarios: login, dashboard, tasks, team — WCAG 2.0/2.1 A+AA, zero serious/critical). **Real findings fixed**: unassociated login-form labels (critical), `--muted-foreground` below AA on light surfaces (token darkened 0.55→0.46, ≈6.5:1), avatar palette below AA for white initials (all five fills darkened, 6.8–8.4:1), `text-muted-foreground/70` ≈3.3:1 usages replaced, calendar out-of-month `opacity-40` cells, `nested-interactive` ×41 — dnd-kit task/bug cards restructured: card keeps pointer-drag, a grip handle carries keyboard-drag, the title is now a real button (keyboard users could drag but not OPEN cards before). |

**Also en route:** e2e-serve.sh now auto-detects the sandbox Chrome binary
(the pinned path rotted on every sandbox recycle); `scripts/a11y-audit.cjs`
deep-dive scanner kept for triage; a fresh second-pass hygiene sweep found
no console.log/debug, no `as any`, no TODO/FIXME markers, no
dangerouslySetInnerHTML, no eval in production code.

---

## 3c. Round 2 continuation (PR-40 … PR-46)

The 5 items left on the §6 roadmap after §3b were re-reviewed; the 4 that
were engineering work are closed, plus 2 findings this pass surfaced on its
own. Same failing-test→fix→gate discipline.

| ID | Was (roadmap §6) | Now |
|---|---|---|
| **PR-40** | §6.2 — `style-src 'unsafe-inline'`. | **Gone.** Empirically the production SSR HTML needs no inline styles at all: Next.js links compiled stylesheets (zero `<style>` elements) and dynamic styling is CSSOM (never blocked). Production now ships `style-src 'self'`; dev keeps `'unsafe-inline'` for Tailwind v4's runtime injection. Enablers: the login brand-panel pattern became `.f-decor-dots`; the Avatar size prop became a 9-value TS union backed by `.f-av-*` classes; progress-bar widths map onto a pre-generated `.f-w-0…100` grid (`barWidthClass()`); donut transition → `.f-donut-ring`; global-error converted to utility classes. prod-smoke now asserts the CSP shape AND scans both login + authenticated HTML for zero `<style>`/`style=` (the authed scan caught 29 real violations on its first run). |
| **PR-41** | §6.3 — axe gate covered 4 surfaces. | **All 9 primary surfaces gated** (login, dashboard, tasks, team, bugs, calendar, analytics, audit log, settings). The new scans found real violations — all fixed: badge text tones `-500/-600 → -700` (amber was 2.9:1) in `lib/config.ts` + `ENTITY_BADGE`; audit `/60` alpha → full token; analytics delta colors; Toggle gained `label` (role=switch had no accessible name); `Field` now associates label↔control via `useId`/`htmlFor` (app-wide fix); settings "sign out all devices" referenced an **undefined** `--destructive-foreground` token. Known follow-up: `--warning` (≈2.5:1) and `--success` (≈3.5:1) tokens fail AA as small-text colors — darkening them shifts every themed surface, needs a dedicated pass. |
| **PR-42** | §6.4 — erasure policy sign-off (owner decision). | The **deliverable half shipped**: `docs/PRIVACY_ERASURE_TEMPLATE.md` — fill-in notice documenting exactly what `eraseUser` erases vs retains and why, the retention table (180d audit default/30d floor, 90d notifications/read-state, 24h token grace), and the owner's open decisions. A doc-drift tripwire pins the notice's numbers to the shipped constants. Sign-off itself remains the owner's (§6). |
| **PR-43** | §6.1 — plan the NextAuth v4 strategic migration. | **Plan shipped** (`docs/AUTH_MIGRATION_PLAN.md`, retired to git history after the migration completed) — verified inventory of the auth surface, options analysis (landscape re-checked against 2026 sources), Better Auth recommendation behind a feature flag with v4 as rollback, 4-phase plan, port map for every custom mechanism (throttle, dummy-bcrypt, tokenVersion, ALS audit bridge, `__Secure-` cookies, proxy guard). |
| **PR-48** | §6.1 — execute the planned auth migration. | **Executed**: Phase 0 spike (all checks green on better-auth@1.7.15) → Phase 1 parallel stack behind `NEXT_PUBLIC_AUTH_STACK` → Phase 2 parity suite (unit + e2e + prod-smoke on BOTH stacks) → Phase 3 cutover. |
| **PR-44** | §6.5 — breach-check enablement (operator decision). | **Closed as a decision record**: the mechanism (PR-35) and the egress decision documentation (DEPLOY.md §1.2, `.env.example`) both shipped; enabling `PASSWORD_BREACH_CHECK=1`/`HIBP_API_KEY` is purely an operator egress call — no further engineering exists. |
| **PR-45** | *(new finding)* — `.env.example` was never committed. | A `.env*` gitignore glob silently kept the boot-contract file out of the repo through rounds 1–2; fresh clones failed the PR-24 test and the sandbox recycle deleted the only copy. Reconstructed from the code's full env inventory; `.gitignore` negates the glob; the test now pins that the file is git-tracked. |
| **PR-46** | *(new finding)* — `restore-preview.sh` damaged the tree. | The script copied a stale Oct-29 snapshot over the tree and hand-inlined a weeks-old `/api/health` (breaking the build twice on 2026-11-03 with 9 phantom TS2554 errors). Now heals tracked files from git HEAD — which also auto-repairs the platform sync's occasional file reversion. |
| **PR-49** | §6.1 — complete the auth migration: flip + v4 removal. | **Done**: repo default flipped to the Better Auth stack (soak waived by owner sign-off — dev workspace, no active users), then the full cleanup — v4 stack deleted (`lib/auth.ts`, `signout.ts`, `auth-cookies.ts`, `auth-stack.ts`, `next-auth.d.ts`, `/api/auth/[...nextauth]`, the v4 proxy guard branch, the ALS bridge — `extractClientIp` survives in `lib/client-ip.ts`), `next-auth` removed from package.json, `NEXTAUTH_SECRET` → `BETTER_AUTH_SECRET` + `NEXTAUTH_URL` → `APP_URL`/`BETTER_AUTH_URL`, single e2e suite (login.feature gains the fernly-cookie + sign-out scenarios), prod-smoke credential checks retargeted, docs updated (DEPLOY §3a, SECURITY, ARCHITECTURE, .env.example). |

---

## 4. Gates (all green after the round-2 continuation fixes)

| Gate | Result |
|---|---|
| `eslint .` | ✅ clean |
| `tsc --noEmit` | ✅ clean |
| Unit tests | ✅ **1165 / 1165** (was 1143; +22 net regression tests across §3c) |
| Production build (Turbopack, next 16.4.4) | ✅ |
| Bundle budget | ✅ all chunks within budget |
| Dependency audit (traced runtime deps) | ✅ 0 critical / 0 high shipping |
| e2e (fresh seed, real browser) | ✅ **62 scenarios** (was 57; +5 a11y surfaces) / 455 steps |
| Production-build smoke (PR-37) | ✅ **13/13** checks (was 10; +3 CSP-style-src assertions) |
| axe WCAG smoke (PR-39/PR-41) | ✅ 0 serious/critical on **all 9** primary surfaces |

---

## 5. Smoke load results (production standalone build, 2-core sandbox)

Two 60-second profiles from `scripts/load-smoke.mjs` against `bun .next/standalone/server.js`:

| Profile | Scenario | n | rps | p50 | p95 | p99 | errors |
|---|---|---|---|---|---|---|---|
| **Normal traffic** (35 browse, 5 probe, 2 login VUs) | browse `GET /` | 3267 | 53.1 | 31 ms | 545 ms | 1.26 s | 0 |
| | health probe | 145 | 2.4 | 31 ms | 374 ms | 435 ms | 0 |
| | full credential login (CSRF + bcrypt-12 + DB + session) | 59 | 1.0 | 425 ms | 704 ms | 1.25 s | 0 |
| **Login storm** (35 browse, 5 probe, 8 login VUs) | overall | 1564 | 25.2 | — | — | — | **0 (0.00 %)** |

Reading: the framework path is cheap (sub-50 ms p95 for the heaviest SSR page
when CPU is free); the login path is dominated by the **deliberate** bcrypt
cost-12 (~400 ms on this vCPU), and 8 concurrent logins saturate the 2 sandbox
cores — everything degrades proportionally but **nothing collapses and no
request errors**. The login storm also exercised the per-IP throttle from a
single address: PR-11's success-reset kept 167 real logins flowing with zero
lockouts. Production hardware (more cores) shifts the whole curve; the k6
scenarios in `scripts/load-test.k6.js` remain the reference for capacity
planning on real hosts.

---

## 6. Remaining roadmap (after the round 2 continuation)

The engineering backlog is empty — every §6 item now either shipped or
reduced to a decision that belongs to the owner, not the codebase.

1. **Auth migration execution** — **Phases 0–2 SHIPPED (PR-48) + staging
   cutover done; production flip is the remaining operator action.** The
   plan (docs/AUTH_MIGRATION_PLAN.md, since retired to git history) executed: spike validated
   better-auth@1.7.15 end-to-end (6 findings recorded), the parallel stack
   at `/api/auth-better/*` carries every custom mechanism (throttle with
   shared budgets, cost-12 dummy bcrypt, soft-delete gates, revocation via
   session-row deletes, IP/UA audit rows, fernly.* cookies), the full
   parity test port landed (1189/1189 unit incl. 20 better-stack cases,
   e2e 62 v4 scenarios + 5 flag-on scenarios on Postgres 16 in CI,
   prod-smoke 17/17 against both stacks), and the sandbox preview now runs
   `NEXT_PUBLIC_AUTH_STACK=better` (staging cutover verified through the
   real UI). Remaining: flip production per the runbook
   (`docs/DEPLOY.md` §3a — rebuild with the flag, one-time sign-out for
   every user, instant rollback via flag removal), soak ≥1 week, then the
   post-soak cleanup deletes the v4 stack.
2. **Full WCAG 2.1 AA audit** — the axe gate now covers all 9 primary
   surfaces at A+AA (serious/critical, PR-41). Remaining: moderate/minor
   findings, screen-reader walkthroughs, focus management on every flow
   (`scripts/a11y-audit.cjs` is the triage tool), plus one known follow-up:
   the `--warning` (≈2.5:1) and `--success` (≈3.5:1) tokens fail AA as
   small-text colors — darkening them shifts every themed surface and needs
   a dedicated pass with dark-mode verification.
3. **Privacy notice sign-off** — the template shipped
   (`docs/PRIVACY_ERASURE_TEMPLATE.md`, PR-42). The owner fills the 【…】
   placeholders, decides trash/business-record retention, and publishes.
4. **Breach-check enablement** — closed as an operator decision record
   (PR-44): flip `PASSWORD_BREACH_CHECK=1` or set `HIBP_API_KEY` when the
   egress call is made (DEPLOY.md §1.2).

---

## 7. Operator launch checklist (short form)

1. Provision per `docs/DEPLOY.md` (host, DNS, ports 80/443).
2. `.env` from `.env.example` — set the five required values; understand the
   boot contract (missing secret / origins refuse to boot; missing
   `CRON_SECRET` disables maintenance visibly; missing `RESEND_API_KEY`
   drops password-reset mail).
3. `docker compose build && docker compose up -d --scale fernly-1=2`
   (add `--profile local-db` for the bundled PostgreSQL).
4. Terminate TLS (Caddy production file / nginx TLS example / cloud LB).
5. Run the §7 post-deploy checklist in DEPLOY.md (login, member login,
   reset email, audit row, `/upstream-health`, logs clean).

---

## 8. Post-review addendum (2026-11-04 — through PR-65)

This review's scope closed at PR-55. The following changes shipped afterwards
under the same gate discipline (lint · typecheck · coverage-gated unit tests ·
build · bundle budget · dependency audit · e2e), each as a separate reviewed
commit on `main`:

| PR | Change |
|----|--------|
| PR-56 / PR-57 | Coverage hardening: closed remaining gaps in `src/lib` + `src/server-actions`; cleared the last uncovered defensive statements |
| PR-58 / PR-62 | Grouped collapsible sidebar (single source of truth in `src/config/navigation.ts`), then accordion behaviour — one group open at a time, current view's group auto-expands |
| PR-59 / PR-60 | Project detail modal (roster + change trail, collapsed by default), widened to `max-w-5xl` with a collapsible Members section |
| PR-61 (ADR-012) | Row-level task deletion: assignee / project owner / ADMIN / covering MANAGER (full reporting subtree) |
| PR-63 (ADR-013) | Role-scoped Analytics: scope resolved + enforced server-side; the scope menu is derived from what the server authorizes |
| PR-64 | Role-permission matrix saves reflect for signed-in users within the config-cache window |
| PR-65 | Per-user appearance (accent, dark mode) persisted server-side per account — no cross-account leakage |

Current suite size at PR-65: **1484 unit/integration tests** (82 files),
**64 e2e scenarios** across 11 feature files (a11y + the HR module joined the
suite after this review's 62/455 numbers). The live documentation set is
`README.md` + `docs/` (PRD, ARCHITECTURE, SECURITY, TESTING, CODING_STANDARDS,
DECISIONS, DEPLOY, this file, HR_MODULE_PLAN, BACKUP_RECOVERY, STATUS_AND_ONCALL,
DB_REGION_DECISION, PRIVACY_ERASURE_TEMPLATE) + `e2e/README.md`; the completed
auth-migration plan, the original code-review ledger, the closed HR QA-findings
log and the one-off generator/debug scripts were retired in the 2026-11-04
documentation cleanup (preserved in git history).
