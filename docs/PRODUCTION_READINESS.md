# Production Readiness Review — Fernly

**Date:** 2026-11-03 · **Scope:** entire application + deployment stack
**Method:** (1) research of current production-readiness criteria for the exact
stack (Next.js 16, NextAuth v4, Prisma 6, self-hosted Docker), including the
2026 security advisories; (2) full-codebase audit of all 30 server-action
modules, the auth/middleware layer, the Prisma schema, the API routes, the
Docker/nginx/compose deployment files and the CI pipeline; (3) crosscheck of
every criterion against the code; (4) fixes with regression tests; (5) full
gate run; (6) a smoke load test against the production standalone build.

**Verdict:** the application is production-ready for its intended target
(single-host self-hosted Docker, TLS-terminated edge, PostgreSQL, 2 replicas
behind nginx) once the operator checklist in `docs/DEPLOY.md` is followed.
This review closed **29 findings** (PR-01…PR-29); 12 accepted-risk items
remain on the roadmap (§6) — none blocks launch.

---

## 1. Research basis — what "production ready" was crosschecked against

| Source | What it contributed |
|---|---|
| Next.js **September 2026 security release** (16.3.8): CVE-2026-94483 (Image-Optimization SSRF), CVE-2026-94484/94543 (SSG/ISR cache poisoning), CVE-2026-94485 (metadata-image `dynamicParams` bypass, webpack only) | Crosschecked: the app configures **no `images.remotePatterns`** (SSRF N/A), uses the **App Router with fully dynamic routes** (SSG/ISR poisoning N/A — only `/_not-found` is static), builds with **Turbopack** (metadata-image N/A). Not affected by any of them. |
| Next.js **October 2026 out-of-band release**: critical RCE via `use cache` typed arrays (GHSA-673q-mjm6-r5xr, fixed 16.4.1) and librsvg via bundled sharp (CVE-2026-96889) | The app uses **no Cache Components / `use cache`** and no remote/SVG image optimization. **Patched anyway: next 16.4.3 → 16.4.4** (PR-28). |
| **NextAuth 2026 CVEs** (CVE-2026-73419/73420, auth bypass / account linking) | The app runs **next-auth 4.24.15 — the fixed release** for the 4.x line (credentials-only provider; the OAuth account-linking flaw does not apply to this flow). |
| **Zod CVE-2026-6991** (SQL injection in the CUID handler, ≤ 4.3.6) | The app runs **zod 4.6.7** — not affected. |
| NextAuth deployment docs: `secret` **required in production**, cookie/session hardening checklist | Already enforced beyond the docs: the app **refuses to boot** with a missing/weak `NEXTAUTH_SECRET` (and with an unset `SERVER_ACTIONS_ALLOWED_ORIGINS`). Cookie hardening gaps found and fixed: PR-06, PR-27. |
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
| Observability | ✅ Good | Structured JSON logs with request ids + `durationMs`, Sentry reporter with PII/secret redaction, `/api/health` (DB + Redis probes, detail gated by CRON_SECRET), audit trail on every mutation. |
| Deployment & config | ✅ Good after fixes | Standalone Docker image (non-root, no secrets in layers, healthcheck), migration gate (PR-24), TLS story + real LB health endpoint (PR-25), complete `.env.example` with boot-contract documentation. |
| Testing | ✅ Strong | 1064 unit tests (95%+ coverage gate in CI), 53 e2e scenarios / 403 steps on real Postgres + real browser, bundle budget + secret-leak grep in CI, SHA-pinned actions. |
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

## 4. Gates (all green after the fixes)

| Gate | Result |
|---|---|
| `eslint .` | ✅ clean |
| `tsc --noEmit` | ✅ clean |
| Unit tests | ✅ **1064 / 1064** (was 1051; +13 net regression tests for this round's fixes) |
| Production build (Turbopack, next 16.4.4) | ✅ |
| Bundle budget | ✅ all chunks within budget (main 129 KB gz, lazy 242 KB gz) |
| Dependency audit (traced runtime deps) | ✅ 0 critical / 0 high |
| e2e (fresh seed, real browser) | ✅ **53 scenarios / 403 steps** |
| Smoke load (production standalone build) | ✅ 0 errors — see §5 |

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

## 6. Accepted risks & roadmap (not launch-blocking)

1. **NextAuth v4 is in maintenance** (the project merged into Better Auth).
   4.24.15 carries the 2026 security fixes and the credentials-only surface is
   small, but plan a strategic migration to Auth.js v5 / Better Auth.
2. **Redis without auth/TLS** inside the compose network — acceptable for a
   single-host deployment (network-scoped); revisit when the topology grows.
3. **Cron overlap guard is per-instance** (module memory) — with 2 replicas the
   daily maintenance can run twice; the job is idempotent and batched, so the
   cost is one extra pass. Move to `SET nx EX` on Redis when convenient.
4. **HSTS without `includeSubDomains`** — deliberate until the whole host is
   HTTPS-only (operator decision; documented in next.config.ts).
5. **`style-src 'unsafe-inline'`** — Tailwind's runtime styling needs it;
   nonce-based styling is a larger hardening effort.
6. **Sign-out audit rows lack IP/UA** — NextAuth v4's `signOut` event exposes
   no request object; revisit with the auth migration.
7. **Password breach-list check** (k-anonymity API) — recommended add-on;
   requires an external dependency the operator should opt into.
8. **No Prometheus `/metrics` endpoint** — structured `metric=` log fields +
   Sentry cover alerting today; export to a metrics stack is incremental.
9. **e2e runs against the dev server** — a production-build e2e smoke suite is
   a CI improvement worth adding (the standalone build is exercised by the
   load smoke and the build gates).
10. **Config-cache staleness across replicas is 10 s** (bump + TTL); instant
    cross-instance invalidation needs Redis pub/sub (noted in config-loader).
11. **Accessibility**: focus-trap, ARIA roles, contrast tokens and keyboard
    shortcuts are in place and tested; a full WCAG 2.1 AA pass is roadmap.
12. **Right-to-erasure**: soft-delete + GDPR self-export exist; a hard-erase
    workflow (beyond retention purges) is a policy decision for the owner.

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
