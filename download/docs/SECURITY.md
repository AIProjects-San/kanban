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

- Secrets live only in environment variables; `.env` is git-ignored and a
  `.env.example` documents the required variables.
- The dev fallback secret is a per-process random value (never a public constant).
- Database credentials rotate via Supabase; no secrets in the client bundle.

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
3. Rate limiting is in-process (single-instance assumption) — move to Redis before
   scaling out.
4. Unexpected server-action errors surface generically in production (only
   Authorization/Validation errors carry a digest marker).

## 10. Incident response

1. Revoke sessions: rotate `NEXTAUTH_SECRET` (invalidates all JWTs) and redeploy.
2. Forensics: query `AuditLog` by actor/entity/timeframe; entries are append-only.
3. Compromised account: admin resets the user's password (invalidates future logins);
   consider a `forceSignOut` flag as future work.
4. Report vulnerabilities privately to the workspace admin; do not open public issues
   for security defects.
