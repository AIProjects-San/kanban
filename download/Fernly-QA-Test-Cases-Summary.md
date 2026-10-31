# Fernly — QA Test Suite Catalog

**Test Plan Name:** Fernly — Full QA Test Suite
**Project:** Fernly (Kanban Project Management)
**Version:** 1.0
**Date:** 2026-10-31
**Total Test Cases:** 284 across 15 Epics
**Stack:** Next.js 16 + React 19 + TypeScript + Prisma 6 + PostgreSQL (Supabase) + NextAuth v4
**Repo:** https://github.com/AIProjects-San/kanban

---

## ADO Import Instructions

1. **Excel file:** `Fernly-QA-Test-Cases.xlsx` (this catalog, 4 sheets)
2. In Azure DevOps → Test Plans → New → **Import (Excel)** → map columns:
   - `Title` → Test Case Title
   - `Steps` → Test Steps
   - `Expected` → Expected Result
   - `Priority` → Priority (P0→Critical, P1→High, P2→Medium, P3→Low)
   - `Tags` → Tags
   - `Linked Requirement` → Linked Work Item
3. Create one Test Suite per Epic (15 suites). Use the `Epic` column to route.
4. The `Automation Status` column tracks which cases have vitest/Cucumber coverage.

---

## Summary by Epic

| Epic | Total | P0 | P1 | P2 | P3 | Automated | Manual |
|------|-------|----|----|----|----|-----------|--------|
| E1-Auth | 32 | 15 | 16 | 1 | 0 | 30 | 2 |
| E2-RBAC | 24 | 12 | 12 | 0 | 0 | 23 | 1 |
| E3-Tasks | 24 | 6 | 12 | 6 | 0 | 23 | 1 |
| E4-Projects | 14 | 5 | 7 | 2 | 0 | 14 | 0 |
| E5-Team | 23 | 6 | 12 | 5 | 0 | 23 | 0 |
| E6-Messaging | 18 | 5 | 10 | 3 | 0 | 18 | 0 |
| E7-Calendar | 9 | 2 | 4 | 3 | 0 | 8 | 1 |
| E8-Time | 8 | 1 | 4 | 3 | 0 | 8 | 0 |
| E9-Audit | 15 | 4 | 10 | 1 | 0 | 14 | 1 |
| E10-Search | 7 | 1 | 4 | 2 | 0 | 7 | 0 |
| E11-Settings | 26 | 4 | 18 | 4 | 0 | 26 | 0 |
| E12-API | 15 | 3 | 6 | 5 | 1 | 15 | 0 |
| E13-Security | 30 | 9 | 16 | 5 | 0 | 28 | 2 |
| E14-Performance | 13 | 2 | 7 | 4 | 0 | 7 | 6 |
| E15-UI | 26 | 3 | 10 | 13 | 0 | 14 | 12 |
| **TOTAL** | **284** | **78** | **148** | **57** | **1** | **260** | **24** |

---

## Coverage Matrix (Type × Priority)

| Type | P0 | P1 | P2 | P3 | Total |
|------|----|----|----|----|-------|
| Functional | 44 | 83 | 44 | 1 | 172 |
| Security | 32 | 57 | 7 | — | 96 |
| Performance | 2 | 6 | 4 | — | 12 |
| Accessibility | — | 2 | 2 | — | 4 |
| **TOTAL** | **78** | **148** | **57** | **1** | **284** |

---

## Epic Summaries

### E1: Authentication & Session Management (32 cases)
**Coverage:** Login (credentials, anti-enumeration, rate-limiting, brute-force lockout, IP spoof prevention, email trim/case), Session (7-day expiry, role/password change revocation, soft-delete invalidation, DB-outage resilience, corrupted-hash handling, secret rotation self-heal), Sign-out (cookie clearing, sign-out-all-devices), Password Reset (anti-enumeration, single-use atomicity, race-safe consumption, expiry, token invalidation on password change, HTML-escape, rate-limit, NoopMailer degraded mode, min/max length).

**Key requirements:** REQ-AUTH-001..013

---

### E2: RBAC & Authorization (24 cases)
**Coverage:** Permission gates (every role × every permission boundary), DB ceiling (DB-granted permissions extend static floor; DB failure falls back to static-only), Hierarchy (subtree management, cycle detection, self-reference, ADMIN bypass, self-management), Privilege escalation (createUser/updateUser ADMIN guard, role:manage grant guard, updateProfile no-role-field, self-demotion/delete/manager-change prevention), Soft-delete targeting (soft-deleted users cannot be updated/deleted).

**Key requirements:** REQ-RBAC-001..011

---

### E3: Task Management (24 cases)
**Coverage:** Create (minimum fields, all fields, validation, scoped projectId, @mention notifications, mention scope limit), Update (title, MEMBER edit-own-only, ADMIN edit-any, project-move scoping, description-change re-fire mentions, not-found no-op), Move (Kanban DnD status change, reorder-within-same-status no-audit, invalid status rejection), Delete (owner-only, MEMBER denied), Bulk Update (atomic transaction, permission filter, 100-task cap, empty-patch rejection, non-existent assignee friendly error).

**Key requirements:** REQ-TASK-001..007

---

### E4: Project Management (14 cases)
**Coverage:** Create (valid fields, soft-deleted member not assignable), Update (name+progress, progress clamp, soft-deleted owner rejection), Delete (soft-delete preserves tasks, MEMBER denied), Restore (from trash, already-live rejected), Scoping (MEMBER dashboard scoped, unscoped task read blocked), Assignment (assign/unassign, idempotent duplicates).

**Key requirements:** REQ-PROJ-001..006

---

### E5: Team & User Management (23 cases)
**Coverage:** Create User (happy path, duplicate email, password min/max, invalid role, manager assignment), Update User (email change, duplicate email pre-check, soft-deleted manager rejection, role change bumps tokenVersion, admin password reset), Delete User (soft-delete preserves references, self-delete prevention, email reuse while soft-deleted), Restore User, Team Members (create, soft-deleted-user no auto-link, update, delete, workload recalculation, workload clamp, capacity fallback).

**Key requirements:** REQ-USER-001..004, REQ-TEAM-001..002

---

### E6: Messaging & Notifications (18 cases)
**Coverage:** Send Message (happy path, sender identity derived from session), Read State (recipient sees unread, mark read, mark thread read, non-recipient blocked, per-recipient state), Delete Message (sender, recipient, non-participant blocked), Restore Message, Notifications (mention created, opt-out toggle, actor self-exclusion, mark read, mark all read, broadcast admin-only, dashboard limit).

**Key requirements:** REQ-MSG-001..003, REQ-NOTIF-001..002

---

### E7: Calendar & Events (9 cases)
**Coverage:** Create Event (happy path, MEMBER denied), Delete Event (ADMIN, MEMBER denied), Calendar View (month grid renders), ICS Export (RFC 5545 validity, line folding at 75 octets, special-character escaping, UTC timestamps).

**Key requirements:** REQ-CAL-001..004

---

### E8: Time Tracking (8 cases)
**Coverage:** Log Time (happy path, client memberId ignored, hours > 0, hours <= 24, no TeamMember error), Time Page (paginated, filter by projectId, filter by memberId).

**Key requirements:** REQ-TIME-001..002

---

### E9: Audit Log & Compliance (15 cases)
**Coverage:** Audit Trail (every mutation writes, IP+UA on sign-in, audit-write failure doesn't break operation), Audit View (MANAGER view, MEMBER denied, entity history open vs gated types), Retention (prune older than retention, role:manage required, 30-day clamp, 1M-row cap, cron requires CRON_SECRET, 503 when unset, constant-time compare, meta-row written before deletes).

**Key requirements:** REQ-AUDIT-001..005

---

### E10: Search & Bulk Ops (7 cases)
**Coverage:** Search (tasks by title, projects by name, members by name/email, min 2 chars, max 100 chars, MEMBER scoped to visible projects, member directory unscoped).

**Key requirements:** REQ-SRCH-001

---

### E11: Settings & Config (26 cases)
**Coverage:** Profile (update own, no role field), Settings (notifications, appearance), Change Password (happy path, wrong current, must-differ, max 1024), Workspace Settings (name update, minPasswordLength clamp, auditRetentionDays clamp, strict schema), Config Items (create, update, delete not-in-use, delete in-use rejected, strict schema), Role Management (create custom, update permissions atomically, delete with no users, delete with users rejected, system role protected, duplicate key), Privacy (GDPR export, truncated flag, own-data-only).

**Key requirements:** REQ-SET-001..007

---

### E12: API & Infrastructure (15 cases)
**Coverage:** Health (200 DB up, 503 DB down, Redis status, public hides detail, detail requires CRON_SECRET, Redis down doesn't fail healthcheck), Client Errors (accept valid, cross-origin rejected, oversized dropped, malformed JSON dropped, GET 405), Cron (valid token, 1-hour dedup), API Discovery (name+health, no stale /docs).

**Key requirements:** REQ-API-001..004

---

### E13: Security & Penetration (30 cases)
**Coverage:** SQL Injection (no raw SQL surface), XSS (no dangerouslySetInnerHTML, display name escaped in email), CSRF (Server Actions origin check, boot guard requires origins, wildcard rejected), CSP (nonce-based production, unsafe-eval dev only), Headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy), Secrets (no hardcoded, build greppable-clean, .env stripped from standalone, .gitignore), PII (login logs hash email+IP, mailer errors hash recipient, Sentry payloads scrubbed), Rate Limiting (5/15min, fail-open on Redis, configurable key prefix), Timing (anti-enumeration bcrypt burn, constant-time CRON compare), Boot Guard (weak NEXTAUTH_SECRET rejected, build-phase exemption), Instrumentation (unhandledRejection captured, uncaughtException exits, graceful-shutdown suppresses exit).

**Key requirements:** REQ-SEC-001..011

---

### E14: Performance & Load (13 cases)
**Coverage:** Dashboard (<2s with 200 projects, 10k tasks no OOM), Pagination (<500ms, malformed cursor no 500), Search (<1s with 10k tasks), Mentions (10k users no load-all), Bundle (main <200KB, lazy <250KB, framework <150KB), Load (k6 50 VUs 5min, 100k seed-load), Config Cache (10s TTL, bumpConfigCache immediate invalidation).

**Key requirements:** REQ-PERF-001..007

---

### E15: UI/UX & Accessibility (26 cases)
**Coverage:** Navigation (role-gated sidebar, keyboard shortcuts G+letter, Cmd+K palette, palette search, escape closes), Kanban (drag to column, filter bar), Modals (focus trap, escape closes, click outside), Theme (dark mode, accent color, persists across sessions), Responsive (mobile login, mobile dashboard), Error Pages (404, app error boundary, global error reports, error digest), Loading (SSR loading state), Empty States (no projects, no tasks), Accessibility (keyboard Kanban, ARIA labels, WCAG AA contrast), i18n (t() indirection).

**Key requirements:** REQ-UI-001..012

---

## Existing Automation Baseline

The project already has **749 vitest unit/integration tests** + **16 Cucumber/Selenium e2e scenarios**. The 284 cases in this catalog include:
- **260 marked "Automated"** — already covered by existing vitest/e2e tests (verified via the codebase inventory)
- **24 marked "Manual"** — require human execution (visual UI checks, load tests, timing measurements, multi-device session tests)

The catalog serves as:
1. **Traceability matrix** — every feature requirement (REQ-*) maps to test cases
2. **Regression suite** — re-run automated cases on every CI build
3. **Exploratory test guide** — manual cases document what to check by hand
4. **ADO import-ready** — Excel format maps directly to ADO Test Plans fields

---

## Test Data

| Role | Email | Password | Notes |
|------|-------|----------|-------|
| ADMIN | demo@fernly.app | fernly123 | Demo only (NEXT_PUBLIC_SEED_DEMO=1) |
| MANAGER | manager@fernly.app | fernly123 | Demo only |
| MEMBER | member@fernly.app | fernly123 | Demo only |

**Production:** Create real admin via `prisma studio` or psql with bcrypt-hashed password. Demo creds are gated to dev builds only (CI greps production bundle to verify absence).
