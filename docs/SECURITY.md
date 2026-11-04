# Fernly — Security Policy & Threat Model

**Last audited:** 2026-11-03 (PR-51–54 data-scoping audit + JWT bearer-token auth),
re-verified through PR-65 (row-level task deletion, role-scoped analytics,
per-user appearance). Launch-readiness review: `PRODUCTION_READINESS.md`.

---

## 1. Authentication

| Control | Implementation |
|---------|----------------|
| Password storage | bcrypt, cost factor 12 (`lib/password.ts`) |
| Password policy | Length = workspace setting (`Workspace.minPasswordLength`, floor 8, cap 128) |
| Sessions | Better Auth DB-backed opaque tokens (`Session` table), 7-day expiry, `fernly.*` cookies: `httpOnly` + `sameSite=lax`, `__Secure-` prefixed + `Secure` in production. Password change / role change / soft-delete delete the user's session rows immediately |
| Signing secret | `BETTER_AUTH_SECRET` — production refuses to boot if missing/weak |
| Brute force | Sliding window: 5 failures / 15 min per email AND per source IP (`x-real-ip`, then the LAST `x-forwarded-for` hop — the trusted proxy's); success clears both buckets |
| Bearer tokens (API access — PR-54) | HS256 JWTs (`lib/jwt.ts`, dependency-free Node crypto) signed with `BETTER_AUTH_SECRET`, **1-hour expiry**, constant-time signature comparison, `alg: none` rejected. Minted via `POST /api/auth/token` (plain HTTP for curl/CI) or `issueAuthToken()` (server action), both requiring an existing session; every issuance writes an `auth.token_issued` audit row with IP + UA. Validation (`getBetterSession`) verifies signature + expiry, then does one indexed DB lookup so a **soft-deleted user's tokens are immediately inert**; the DB's current role/name/email are authoritative (role changes apply on the next request). An invalid/expired bearer returns 401 — never a silent fallback to an unrelated cookie session. Revocation window for password/role changes = the 1h expiry (clients re-mint); a Redis-backed JTI blocklist is the documented future enhancement if immediate revocation is ever required |
| Enumeration | Unknown emails still run a bcrypt compare (constant-time behaviour); identical error surface |
| Role freshness | 5-minute session cookie cache; role changes propagate on cache expiry; soft-deleted accounts are treated as signed out (deletedAt rides on the session payload) |
| Secret rotation | Better Auth signs the opaque session cookie with `BETTER_AUTH_SECRET`; an unknown/tampered token fails silent (signed out, no log spam). Rotating the secret + clearing the `Session` table invalidates every session at once |
| Signout cookie hygiene | Better Auth expires its own cookies on sign-out. The proxy additionally expires obsolete `next-auth.*` leftovers from before the PR-49 migration on first sight. UI logout buttons funnel through `appSignOut()` and hard-navigate to `/` |
| Audit trail | `auth.signed_in` and `auth.signed_out` rows in the audit log, written by the Better Auth after-hooks with IP + user agent from the request (best-effort, never blocks the flow on a DB outage) |
| Notification routing | `Notification.recipientUserId`: private rows are visible/mutable only by their recipient; null-recipient broadcasts are visible to all and markable only by `role:manage` (flipping them affects every viewer). `markAllNotificationsRead` touches only the caller's own rows |

## 2. Authorization

Two mandatory layers, both server-side:

1. **Permission gate** — every server action calls `requirePermission(<key>)` against the
   RBAC matrix (18 permissions × 3 roles, DB-configurable, code-level floor).
2. **Row-level scoping / ownership** — identity is *always* derived from
   `getSession()`, never from action arguments:

   - `getDashboardData()` scopes projects/tasks/members to the caller's project set
     (MANAGER and MEMBER both scoped).
   - **Personal-data scoping (PR-51–54, regression-tested per role):**
     - Reminders are **owner-only** — every signed-in user sees exactly their own
       (`ownerId = me`), including admins. Legacy null-owner rows are retained in the
       DB for back-compat but never surfaced.
     - Dashboard **time entries** are filtered to members the viewer can see
       (`getVisibleMemberIds` in `shared.ts`: members of their projects + self).
     - `getTimeEntriesPage` applies the same member-visibility rule; the caller's
       `memberId` filter is **intersected** with the visible set (out-of-scope member
       → empty page, not that member's entries).
     - `getProjectAssignments` / `getProjectAssignableUsers` gate on the caller's
       project scope (`getScopedProjectIds`) — a scoped user passing an arbitrary
       projectId gets `[]`, never that project's staff roster with emails.
     - Dashboard greeting counts are personal (own open tasks, own reminders due
       today), even for admins who see workspace-wide board data.
   - Task edits require assignment to the caller unless they hold `task:edit:any`.
   - Task **deletion** (PR-61) is row-level: only the assignee, the project
     owner, an ADMIN, or a MANAGER whose reporting chain (`lib/hierarchy.ts`
     full subtree) covers the assignee/project owner may delete. The blanket
     `task:delete` grant stays ADMIN-only; all other paths go through
     `assertTaskDeletePermission`.
   - **Analytics (PR-63):** the requested scope is resolved server-side —
     MEMBER/HR are forced to *self*; MANAGER is limited to their reporting
     subtree; ADMIN may pick Everyone / any manager's team / any individual.
     The scope menu is derived from what the server authorizes, and an
     out-of-scope request is narrowed (or rejected), never honoured.
   - **HR (ADR-009):** leave approvals follow the reporting chain; leave
     balances and requests are personal; employee profiles, reviews and
     onboarding require `hr:*` permissions.
   - Messages: read/unread/delete restricted to sender/recipient; mailbox queries filter
     by `recipientUserId`/`senderUserId`.
   - Reminders: toggle allowed for the owner (+admin); null-owner legacy rows
     toggleable but never rendered.
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

- Better Auth enforces an origin check on its endpoints (`trustedOrigins`, in
  `src/lib/auth-better.ts` — mirrored from the Server Actions allow-list; no
  double-submit token to keep in sync).
- Server Actions are origin-checked by Next.js 16; `experimental.serverActions.
  allowedOrigins` lists only the known preview hosts + localhost.

## 6. Audit logging

Every mutating action writes an immutable `AuditLog` row (66 typed actions, entity id +
label, human-readable detail). Audit failures are caught and logged — they never break
the underlying operation. Sign-ins, sign-outs, token issuances, password changes, role
changes, user CRUD, config changes and all entity CRUD are covered. `audit:view`
(ADMIN, MANAGER) gates the workspace-wide log; per-entity history is available to anyone
who can already see the entity (transparency for collaborators).

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
- `DATABASE_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `REDIS_URL`, `CRON_SECRET`,
  `SENTRY_DSN` — runtime-injected only. The Dockerfile refuses a stray `.env` in the
  build context/output (X-06).
- The dev fallback auth secret is a per-process random value (never a public
  constant); production refuses to boot on a missing/weak `BETTER_AUTH_SECRET`.
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

1. Notifications are workspace-global broadcasts by design (single-team workspace;
   null-recipient rows are intentional).
2. Rate limiting shares a real Redis client when `REDIS_URL` is set (deep-dive
   F-12 closed: `src/lib/redis-client.ts` lazily constructs the process-wide
   ioredis client; docker-compose ships Redis and both limiters use it). If
   Redis errors mid-flight the limiters **fail open** (logins stay possible,
   throttling degrades, warning rate-limited to 1/30s) — bcrypt cost 12 still
   meters online attacks. Without `REDIS_URL` the limiter is per-instance
   in-memory: acceptable single-instance, a known multi-instance gap.
3. Unexpected server-action errors surface generically in production (only
   Authorization/Validation errors carry a digest marker).
4. `getUserByEmail` + the search member directory let any signed-in user resolve
   id/name/email/avatarColor for a known email (deep-dive F-17/F-18) — required
   for message routing in a single-workspace product; revisit with L-P2-36
   tenancy.
5. CSP ships with `unsafe-inline`/`unsafe-eval` and `connect-src https:`
   (deep-dive F-13); a nonce-based policy is the next hardening step.
6. Config-table class/color strings are admin-authored and render into
   classNames/inline styles (deep-dive F-16) — admin-only surface, cosmetic blast
   radius.
7. Bearer tokens are not instantly revocable on password/role change (the 1-hour
   expiry is the revocation window; soft-delete IS immediate). A Redis-backed
   JTI blocklist is the documented future enhancement.

## 10. Incident response

1. Revoke sessions: rotate `BETTER_AUTH_SECRET` AND clear the `Session` table
   (invalidates every session) and redeploy.
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

---

## 12. PII Inventory (P2 — production-readiness re-audit)

The application stores the following personal data. "Encryption at rest"
relies on Supabase's PostgreSQL disk encryption + TLS in transit;
passwords and reset tokens are additionally hashed at the application
layer. No field is application-level encrypted beyond hashing.

| Field | Model | Sensitivity | Protection |
|---|---|---|---|
| `email` | User, TeamMember | High (login identifier) | bcrypt-hashed password gates access; logs redacted via `hashPii()`; Sentry payloads scrubbed via `redactSecrets()` |
| `passwordHash` | User | Critical | bcrypt cost-12 — never logged, never returned by any server action |
| `name` | User, TeamMember | Medium (display) | Visible to signed-in users via roster; not logged |
| `bio` | User | Medium (user-entered) | Visible to signed-in users via profile |
| `avatarColor` | User | Low (UI preference) | — |
| `timezone` | User | Low (UI preference) | — |
| `tokenVersion` | User | Critical (session revocation) | Integer; bumped on password/role change + sign-out-all-devices |
| `deletedAt` | User, Project, TeamMember, Message | — (soft-delete marker) | Filters read paths; soft-deleted users cannot authenticate |
| `ipAddress` | AuditLog | Medium (forensics) | Captured on `auth.signed_in`; stored as-is (hash at read time if exporting) |
| `userAgent` | AuditLog | Low (forensics) | Captured on `auth.signed_in`; truncated to 500 chars |
| `subject` / `body` | Message | Medium (user content) | Visible to sender + recipient only; soft-deletable |
| `description` | Task, TimeEntry | Medium (user content) | Scoped to the caller's visible projects |
| `detail` | AuditLog | Low (action summary) | Human-readable sentence; never contains secrets (mailer drops bodies) |
| `tokenHash` | PasswordResetToken | Critical (single-use) | SHA-256 hash stored; raw token never persisted; 1h TTL; single-use |

**Data subject rights (NZ Privacy Act 2020 / GDPR):**
- **Access:** `exportMyData()` server action (Settings → Privacy →
  "Download my data") returns every row referencing the caller's userId.
- **Rectification:** Settings → Profile (name, bio, avatar, timezone) +
  Settings → Security (password).
- **Erasure:** Soft-delete via admin (`deleteUser`) hides the user from
  all read paths + invalidates their session. Hard-erase is a follow-up
  (audit retention expires the audit trail after `auditRetentionDays`).
- **Portability:** `exportMyData()` returns JSON.
