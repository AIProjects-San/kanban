# Fernly — Security Policy & Threat Model

**Last audited:** 2026-10-29 (full audit report: `CODE_REVIEW.md`)

---

## 1. Authentication

| Control | Implementation |
|---------|----------------|
| Password storage | bcrypt, cost factor 12 (`lib/password.ts`) |
| Password policy | Length = workspace setting (`Workspace.minPasswordLength`, floor 8, cap 128) |
| Sessions | JWT, 30-day expiry, `httpOnly` + `sameSite=lax` cookies; `Secure` in production |
| Signing secret | `NEXTAUTH_SECRET` — production refuses to boot if missing/weak |
| Brute force | Sliding window: 5 failures / 15 min per email AND per source IP (first `x-forwarded-for` hop); success clears the email bucket |
| Enumeration | Unknown emails still run a bcrypt compare (constant-time behaviour); identical error surface |
| Role freshness | JWT callback re-reads the role from the DB every 5 min; deleted accounts are treated as signed out |
| Secret rotation | `src/proxy.ts` verifies the session cookie against the current `NEXTAUTH_SECRET` on every page request; an undecryptable (rotated/corrupt) cookie is stripped from the forwarded request and expired in the browser, so clients self-heal to a clean sign-in instead of logging `JWT_SESSION_ERROR` on every render. Never active on `/api/auth/*` (NextAuth must stay free to rotate its own cookies) |
| Signout cookie hygiene | `app/api/auth/[...nextauth]/route.ts` wraps the NextAuth handler and — on `/api/auth/signout` — appends `Max-Age=0` `Set-Cookie` headers for all six auth-cookie name spaces (`next-auth.session-token`, `next-auth.csrf-token`, `next-auth.callback-url` + `__Secure-` variants). NextAuth itself only expires the session-token; leaving the CSRF cookie behind wedged sign-in after a secret rotation. UI logout buttons funnel through `lib/signout.ts` and hard-navigate to `/` |
| Audit trail | `auth.signed_in` and `auth.signed_out` rows in the audit log. The sign-out entry is written by `events.signOut` (best-effort, never blocks the sign-out on a DB outage) |
| Notification routing | `Notification.recipientUserId`: private rows are visible/mutable only by their recipient; null-recipient broadcasts are visible to all and markable only by `role:manage` (flipping them affects every viewer). `markAllNotificationsRead` touches only the caller's own rows |

## 2. Authorization

Two mandatory layers, both server-side:

1. **Permission gate** — every server action calls `requirePermission(<key>)` against the
   RBAC matrix (18 permissions × 3 roles, DB-configurable, code-level floor).
2. **Row-level scoping / ownership** — identity is *always* derived from
   `getSession()`, never from action arguments:

   - `getDashboardData()` scopes projects/tasks/members to the caller's project set
     (MANAGER and MEMBER both scoped).
   - Task edits require assignment to the caller unless they hold `task:edit:any`.
   - Messages: read/unread/delete restricted to sender/recipient; mailbox queries filter
     by `recipientUserId`/`senderUserId`.
   - Reminders: personal ones visible/toggleable by owner (+admin); `ownerId: null` =
     workspace-wide.
   - Profiles & settings: self-only, or `role:manage`.
   - Self-protection: admins cannot demote/delete themselves; system roles cannot be
     deleted; roles in use cannot be removed.

**Regression tests** pin every rule above (`src/server-actions/__tests__/data.test.ts`).

## 3. Injection & input handling

- **SQL injection:** none by construction — all queries go through Prisma's
  parameterised query builder; no `$queryRaw` in application code.
- **Input validation:** zod schemas (`lib/validation.ts`) enforce shape, length caps
  (≤200 chars titles, ≤10 000 bodies), email format, and numeric bounds at every
  mutating action boundary.
- **XSS:** React auto-escapes; no `dangerouslySetInnerHTML` anywhere in `src/`.
  CSP adds `object-src 'none'` and `frame-ancestors 'none'`.

## 4. Transport & headers

| Header | Value |
|--------|-------|
| `Content-Security-Policy` | `default-src 'self'`; scripts/styles allow inline (Next.js bootstrap); `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`; `object-src 'none'` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera/microphone/geolocation/payment denied |

**Known limitation:** CSP currently requires `'unsafe-inline'`/`'unsafe-eval'` for
Next.js's bootstrap/HMR. A nonce-based policy is the next hardening step. HSTS should be
terminated at the reverse proxy (Caddy).

## 5. CSRF

- NextAuth's built-in CSRF token covers the credentials flow (`next-auth.csrf-token`,
  double-submit cookie).
- Server Actions are origin-checked by Next.js 16; `experimental.serverActions.
  allowedOrigins` lists only the known preview hosts + localhost.

## 6. Audit logging

Every mutating action writes an immutable `AuditLog` row (28 typed actions, entity id +
label, human-readable detail). Audit failures are caught and logged — they never break
the underlying operation. Sign-ins, password changes, role changes, user CRUD, config
changes and all entity CRUD are covered. `audit:view` (ADMIN, MANAGER) gates the
workspace-wide log; per-entity history is available to anyone who can already see the
entity (transparency for collaborators).

## 7. Secrets management

**Policy (MUST — ADR-006): `.env` is the only home for secrets.** No credential,
key, or password literal may be committed anywhere — source, tests, scripts, feature
files, Dockerfiles, or docs. This is enforced socially by review and mechanically by:

- `login-demo-gating.test.ts` greps the seed/e2e/k6 sources for the demo password and
  fails if the literal reappears;
- the CI bundle gate greps built client chunks for the demo password (X-05);
- the CI secrets gate refuses a stray `.env` in the standalone build output (X-06).

Current inventory and handling:

- `.env` is git-ignored **and untracked** (deep-dive F-02: it was accidentally
  committed in the initial commit — removed from the index, but history retains it;
  see the incident log below). `.env.example` documents every variable with
  placeholders, never values.
- `DATABASE_URL`, `NEXTAUTH_SECRET`, `RESEND_API_KEY`, `REDIS_URL`, `CRON_SECRET`,
  `SENTRY_DSN` — runtime-injected only. The Dockerfile refuses a stray `.env` in the
  build context/output (X-06).
- The dev fallback auth secret is a per-process random value (never a public
  constant); production refuses to boot on a missing/weak `NEXTAUTH_SECRET`.
- The demo password lives **only** in `NEXT_PUBLIC_DEMO_PASSWORD` (`.env`). The
  seed, node scripts, k6 load test, and the e2e suite read it from the environment
  through `scripts/lib/demo-env.mjs` / `__ENV` / the e2e loader — each fails loudly
  when it is unset. Rotating the demo password is a one-line `.env` edit.
- Password-reset mail requires `RESEND_API_KEY` in production. Without it mail
  is **dropped, never logged** (deep-dive F-04) — single-use reset tokens must
  never appear in server logs.
- Unit tests use obviously-fake fixtures (`obviously-fake-unit-test-secret-…`),
  never real values.

### Incident log

| Date | Incident | Remediation |
|------|----------|-------------|
| 2026-10-30 (F-02) | `.env` committed in the initial commit (DB password + auth secret in git history). | Removed from index; `.gitignore` hardened. **Action: rotate both before launch** — the DB password rotation is still pending ops action. |
| 2026-10-31 (M-5) | The **real `NEXTAUTH_SECRET` was pasted as a fixture in a committed unit test** (`auth.test.ts`), leaking the live signing secret into history. | Fixture replaced with an obviously-fake value; **live secret rotated the same day** (new `openssl rand -base64 32` in `.env`; the proxy's self-healing cookie guard made the rotation transparent to signed-in clients). Demo-password literals scrubbed repo-wide (seed, 4 node scripts, 3 shell scripts, k6, 10 feature files, docs) and pinned by tests. |

## 8. Threat model (abridged STRIDE)

| Threat | Vector | Mitigation |
|--------|--------|------------|
| Spoofing | Forged JWT | Strong secret enforced at boot; httpOnly cookies |
| Spoofing | Credential stuffing | Per-email + per-IP throttling; bcrypt cost 12 |
| Tampering | Direct server-action calls with foreign ids | Ownership assertions (§2) |
| Tampering | Privilege claim via action arguments | Session-derived identity (regression-tested) |
| Repudiation | "I never did that" | Immutable audit trail on every mutation |
| Information disclosure | Cross-tenant rows | Scoped queries; per-user mailboxes; reminder ownership |
| DoS | Login flood | Rate limiter with bounded memory (10 000 keys) |
| Elevation | Role self-modification | Self-demotion guard; system-role protection |

## 9. Accepted risks & roadmap

1. Name-based joins (`ownerName`, email-matched members) — two users with identical
   names can appear in each other's scope. Fix: stable-id columns (planned migration).
2. Notifications are workspace-global (design decision for a single-team workspace).
3. Rate limiting shares a real Redis client when `REDIS_URL` is set (deep-dive
   F-12 closed: `src/lib/redis-client.ts` lazily constructs the process-wide
   ioredis client; docker-compose ships Redis and both limiters use it). If
   Redis errors mid-flight the limiters **fail open** (logins stay possible,
   throttling degrades, warning rate-limited to 1/30s) — bcrypt cost 12 still
   meters online attacks. Without `REDIS_URL` the limiter is per-instance
   in-memory: acceptable single-instance, a known multi-instance gap.
4. Unexpected server-action errors surface generically in production (only
   Authorization/Validation errors carry a digest marker).
5. `getUserByEmail` + the search member directory let any signed-in user resolve
   id/name/email/avatarColor for a known email (deep-dive F-17/F-18) — required
   for message routing in a single-workspace product; revisit with L-P2-36
   tenancy.
6. CSP ships with `unsafe-inline`/`unsafe-eval` and `connect-src https:`
   (deep-dive F-13); a nonce-based policy is the next hardening step.
7. Config-table class/color strings are admin-authored and render into
   classNames/inline styles (deep-dive F-16) — admin-only surface, cosmetic blast
   radius.

## 10. Incident response

1. Revoke sessions: rotate `NEXTAUTH_SECRET` (invalidates all JWTs) and redeploy.
2. Forensics: query `AuditLog` by actor/entity/timeframe; entries are append-only.
3. Compromised account: admin resets the user's password (invalidates future logins);
   consider a `forceSignOut` flag as future work.
4. Report vulnerabilities privately to the workspace admin; do not open public issues
   for security defects.

## 11. Backup & recovery (RPO/RTO)

Launch gate 6 (audit §Go/No-Go) requires the recovery targets to be on
record **here**, not only in the ops runbook. Full procedures, the timed
restore drill and the quarterly schedule live in
[BACKUP_RECOVERY.md](./BACKUP_RECOVERY.md); the commitments are:

| Target | Commitment | Basis |
|--------|------------|-------|
| **RPO** (max acceptable data loss) | ≤ 5 minutes | Supabase PITR archives WAL segments every 5 min (Pro tier). Worst case: 5 min of writes lost. |
| **RTO** (max acceptable downtime) | ≤ 1 hour | Restore + WAL replay < 30 min at current dataset size + verification + DNS cutover. |

- The **restore drill must be executed and timed against staging before
  launch** (gate 6 is not closed by this document — it is closed by the
  drill's recorded timings in BACKUP_RECOVERY.md).
- Schema-level rollback safety is separate from data recovery: Prisma
  migrations are committed and reversible (`prisma migrate resolve` +
  the documented down-path in BACKUP_RECOVERY.md §migration-rollback).
