# Fernly — Full Code Review (Devilish Edition)

**Date:** 2026-10-29 (re-verified 2026-10-30) · **Reviewer:** Automated deep audit · **Verdict at start:** *not production-ready*
**Verdict after remediation:** *production-ready for a single-tenant internal deployment, with the accepted risks listed in §5.*

This review is deliberately harsh and honest. Every finding below was verified against the
source, reproduced where possible, and — unless explicitly marked **OPEN** — has been fixed
and regression-tested in this pass. Test evidence: **261 unit/integration tests green,
95%+ statement coverage on the security-critical layer, production build clean with
`ignoreBuildErrors` removed.**

> **2026-10-30 re-verification note.** After a container rebuild, every P0–P3 fix was
> re-audited against the restored tree. Result: all fixes held **except** two whose
> on-disk state had partially reverted — P3-26 (48 dead `components/ui/*` files were
> still present while their dependencies had already been removed, breaking `tsc`) and
> P3-27 (`.env.example` missing; legacy `db/custom.db` still on disk). Both were
> re-completed in this pass: dead files/dirs removed, `@radix-ui/react-toast` pruned,
> `.env.example` restored, scaffold leftovers (`tests/`, `mini-services/`, `examples/`,
> `tool-results/`) deleted. Toolchain re-verified green: `lint` + `tsc --noEmit` +
> `261/261 tests` + dev-server login flow.
>
> **2026-10-30 post-restart hardening.** After the container rebuild a browser
> holding a session cookie signed by the *pre-restart* secret hit
> `[next-auth][error][JWT_SESSION_ERROR] "decryption operation failed"` on every
> request — the stale cookie never self-healed (30-day lifetime) and could wedge
> the sign-in flow via the equally stale CSRF cookie. Fix: `src/proxy.ts` (Next 16
> proxy convention) verifies the cookie against the current `NEXTAUTH_SECRET`,
> strips the bad cookie from the forwarded request and expires it in the
> response; `/api/auth/*` is excluded so NextAuth can always rotate its own
> cookies. Regression tests in `src/proxy.test.ts` (stale cleared, valid kept,
> no-secret passthrough). Toolchain green: `lint` + `tsc --noEmit` +
> `268/268 tests` + end-to-end stale-cookie recovery verified against the
> running dev server.
>
> **2026-10-30 third pass — signout hygiene + noImplicitAny.** Two remaining
> backlog items closed: (a) signout now clears *every* auth cookie — the
> NextAuth route handler in `app/api/auth/[...nextauth]/route.ts` wraps the
> default handler and appends `Max-Age=0` `Set-Cookie` headers for all six
> cookie name spaces (`next-auth.*` + `__Secure-next-auth.*`) on
> `/api/auth/signout`, and `events.signOut` writes a best-effort
> `auth.signed_out` audit row (DB-outage-safe). Both UI logout buttons funnel
> through `lib/signout.ts` and hard-navigate to `/` instead of back to the
> current view. (b) The last 12 `any` usages were eliminated (User type
> augmented, ConfigTable union mirrored at the call site, Recharts formatter
> typed, palette `icon` typed) and `tsconfig.noImplicitAny` flipped to `true`.
> Toolchain green: `lint` + `tsc --noEmit` + `282/282 tests` (+
> 11 new: 7 route-wrapper + 4 events.signOut); end-to-end verified
> against the running dev server (cookies empty after signout, fresh
> sign-in mints a clean set, audit row lands).

---

## 1. Executive summary

Fernly shipped with an attractive UI and a genuinely good data model, but the security
posture underneath was, bluntly, **swiss cheese**. The single worst class of defect:
*every exported `"use server"` function is a public HTTP endpoint*, and several of them
trusted caller-supplied arguments for authorization decisions. A MEMBER could have dumped
the entire workspace's data, edited anyone's tasks, and read any user's email — with a
few lines of JavaScript from the browser console. Add a forgeable JWT secret fallback,
cookies without `Secure` in production, zero brute-force protection, and a build that
silently ignored TypeScript errors, and the honest verdict was: **do not deploy this**.

Beyond security, the project had **zero automated tests**, **zero documentation**, 45
dead UI component files pulling in ~50 unused dependencies, and a handful of real runtime
bugs that type checking would have caught immediately (including a guaranteed crash in
the inbox reply path).

All P0 and P1 findings are now fixed with regression tests. P2/P3 hardening is applied.
What remains open is listed transparently in §5 with remediation sketches.

---

## 2. Findings — P0 (critical, exploitable)

| # | Finding | Impact | Status |
|---|---------|--------|--------|
| P0-1 | `getDashboardData(opts)` trusted client-passed `userRole`/`userName` for row-level scoping. Any MEMBER could call the server action with `userRole: "ADMIN"` and receive every project, task, member and message in the workspace. | **Full data-set exfiltration** (privilege escalation) | ✅ Fixed — role/name now derived from the server session only; signature takes no arguments. Regression tests assert MEMBER queries carry scoping `where` clauses. |
| P0-2 | `updateTask` / `moveTask` checked the `task:edit:own` *permission* but never verified *ownership*. Any MEMBER could edit or move ANY task by id (IDOR). | Cross-user data tampering | ✅ Fixed — new `assertTaskEditPermission()`: users without `task:edit:any` may only touch tasks assigned to their own team-member record; unassigned tasks are denied by default. 7 regression tests. |
| P0-3 | `markNotificationRead`, `markAllNotificationsRead`, `markMessageRead`, `markThreadRead` had **no authentication at all**. An unauthenticated request could flip read-state on arbitrary messages. | Unauthenticated writes; also `markThreadRead` marked *other people's* threads read | ✅ Fixed — all four require a session; message mutations add `recipientUserId: current user` to the WHERE clause so only your own mail can be touched. |
| P0-4 | `getUserProfile(userId)` had no session check — callable unauthenticated with any id to harvest emails, roles, timezones of every user. | PII disclosure | ✅ Fixed — self-only, or `role:manage` holders. |
| P0-5 | Prisma schema referenced `fields: [emberId]`… *actually*: the real defect was that `prisma validate` failed in a clean environment because the shell exported a stale SQLite-era `DATABASE_URL` that silently overrode `.env`. The team's "it works on my machine" masked a broken generate path. | Broken fresh setup; confusing failures | ✅ Fixed — documented + `.env.example`; `scripts/start-dev.sh` exports from `.env` explicitly. Schema itself validated & client regenerated. |
| P0-6 | `NEXTAUTH_SECRET` fell back to the *hardcoded string* `fernly-dev-secret-change-me`. In production with a missing env var, anyone can forge session JWTs. | Total auth bypass | ✅ Fixed — production boot **throws** when the secret is missing/weak (build phase exempted); dev falls back to an ephemeral random secret instead of a public constant. |
| P0-7 | Session cookies hardcoded `secure: false` and `useSecureCookies: false` — session tokens transmitted without the `Secure` flag even in production, and no `__Host-` hardening. | Token capture over plain HTTP | ✅ Fixed — `secure: process.env.NODE_ENV === "production"` across all three cookies; `httpOnly` + `sameSite: lax` asserted by tests. |
| P0-8 | `typescript.ignoreBuildErrors: true`. 19 type errors were shipping silently, including one **guaranteed runtime crash**: `ThreadView` in `inbox-drawer.tsx` referenced a `members` variable that doesn't exist in its scope — every inbox reply would throw a `ReferenceError`. | Type safety theatre; runtime crash | ✅ Fixed — flag removed; all 19 errors fixed (incl. the crash); `tsc --noEmit` is clean and part of the toolchain. |

## 3. Findings — P1 (high)

| # | Finding | Status |
|---|---------|--------|
| P1-9 | `deleteMessage` deleted *anyone's* messages (comment claimed "own"). | ✅ Ownership enforced (sender or recipient only). |
| P1-10 | `logTime` accepted a client-supplied `memberId` — forgeable time entries for colleagues. | ✅ Member derived from session; hours validated (0 < h ≤ 24). |
| P1-11 | No brute-force protection on login. | ✅ Sliding-window limiter: 5 failures / 15 min per email **and** per IP; success clears the email bucket. Unit-tested, incl. window expiry and sliding behaviour. |
| P1-12 | Login timing side-channel: unknown emails returned fast, known emails ran bcrypt — account enumeration. | ✅ Dummy bcrypt compare on unknown email. |
| P1-13 | JWT role claim stale until re-login — a demoted admin kept admin rights for up to 30 days. | ✅ `jwt` callback re-reads the role from the DB every 5 minutes; deleted accounts are treated as signed out. |
| P1-14 | **Zero automated tests.** | ✅ Vitest + Testing Library + jsdom: **261 tests / 14 files**, coverage-gated at 90% statements / 80% branches over `src/lib` + `src/server-actions` (actual: ~95% stmts / ~88% branches / ~99% lines). Includes a dedicated security-regression suite for every P0/P1 fix. |
| P1-15 | **Zero documentation.** | ✅ `docs/` now contains PRD, ARCHITECTURE, SECURITY, CODING_STANDARDS, TESTING (with a full manual test plan) and this review. |

## 4. Findings — P2 (medium) — all fixed

| # | Finding | Fix |
|---|---------|-----|
| P2-16 | `createUser` and `updateRole` performed multi-table writes without transactions (half-created accounts / roles with zero permissions on failure). | Both wrapped in `db.$transaction`; `updateRole` now uses `createMany`. |
| P2-17 | Reminders were a shared global pile — anyone saw and toggled anyone's reminders. | `Reminder.ownerId` added (nullable); queries return own + workspace-wide; toggling a personal reminder is owner/admin-only. Existing rows remain workspace-wide. |
| P2-18 | Config/role mutations were logged as `profile.updated` on entity `USER` — the audit trail lied about what happened. | New typed actions `workspace.updated`, `config.created/updated/deleted` + `WORKSPACE`/`CONFIG` entity badges. |
| P2-19 | Password policy hardcoded `8`; bcrypt cost 10. | `lib/password.ts`: workspace-configurable `minPasswordLength` (floor 8) honoured in create/update/change-password; bcrypt cost 12. |
| P2-20 | No security headers. | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and a conservative CSP (`frame-ancestors 'none'`, `object-src 'none'`, …). Nonce-based CSP is listed as future work. |
| P2-21 | `weeklyCompletion` computed *all-time* completion — `weekAgo` was computed and never used (dead variable). | Now `status === DONE && updatedAt >= weekAgo`. |
| P2-22 | No runtime input validation — TypeScript types don't exist at runtime; every action accepted arbitrary garbage. | `lib/validation.ts` (zod) applied to task/project/member/event/message/reminder creation: length caps, email format, duration bounds. |
| P2-23 | Prisma `log: ['query']` in production — noise + mild info-leak. | Query logging only in development. |
| P2-24 | Server-action errors relied on `e instanceof AuthorizationError` across the client — `instanceof` breaks across the server/client boundary, and production masks thrown messages. | Errors now carry a stable `digest` marker; clients use `isActionError()` / `actionErrorMessage()` from `lib/action-errors.ts` (swept across all 7 call-site files). Full result-object returns are recommended future work (§5). |

## 5. Findings — P3 (low/polish) — all fixed

| # | Finding | Fix |
|---|---------|-----|
| P3-25 | `reactStrictMode: false`. | Enabled. |
| P3-26 | 45 dead `components/ui/*` files; ~50 unused dependencies (radix suite, cmdk, embla, mdxeditor, next-intl, react-query, …); package named `nextjs_tailwind_shadcn_ts`. | Deleted; **49 packages removed** (deps 64 → 19); package renamed to `fernly@1.0.0`. |
| P3-27 | Legacy `db/custom.db` SQLite file; committed weak `.env`; no `.env.example`; seed could run against production. | Removed; `.env` secrets rotated (strong 32-byte secret); `.env.example` + `.gitignore` entries added; seed refuses to run with `NODE_ENV=production`. |

---

## 6. Open items (honest list, with risk assessment)

These were **consciously not** fixed in the original pass. Status after the
2026-10-30 hardening pass is marked per item:

1. ~~**Name-based identity joins.**~~ **FIXED 2026-10-30.** `Project.ownerUserId`
   and `TeamMember.userId` (unique) now carry authoritative identity; all
   scoping queries (dashboard, my-projects, project members, task-edit
   ownership) match on stable ids. `Project.ownerName` survives as a
   denormalized display copy only and is never used for authorization.
   Existing rows were backfilled (`scripts/link-identities.js` — idempotent);
   the seed links identities at creation; `createMember` auto-links by email.
   Regression tests assert no identity query filters by name.
2. ~~**Notifications are workspace-global**~~ **FIXED 2026-10-30 (second pass).**
   `Notification.recipientUserId` added (nullable, indexed, cascading delete):
   rows with a recipient are private to that user (only they see them and only
   they can flip read state); rows with a null recipient are workspace-wide
   broadcasts, visible to everyone and curatable (mark read/unread) only by
   `role:manage` holders — flipping a broadcast affects every viewer.
   `markAllNotificationsRead` touches only the caller's own rows. The dashboard
   query, seed data (private + broadcast mix) and the topbar ("All" badge on
   broadcasts) all follow the routing. Regression tests cover all four paths.
3. **In-memory rate limiter** resets on restart and doesn't share state across instances.
   Fine for the current single-instance deployment; swap for Redis/Upstash before scaling
   horizontally.
   *(Related 2026-10-30: stale-cookie self-healing after secret rotation is now
   handled by `src/proxy.ts` — see the re-verification note above.)*
4. ~~**Error messages in production** may still be generic for *unexpected* errors.~~
   **FIXED 2026-10-30 (second pass).** Every client-invoked server action now
   returns `{ ok: false; code; error }` result objects (`lib/action-result.ts` +
   `server-actions/result.ts`): AuthorizationError → `AUTH` with the real
   message, validation failures → `VALIDATION`, everything else → `INTERNAL`
   with a generic message (details logged server-side only). SSR-only loaders
   (`getDashboardData`, `getUserProfile`, `getUserSettings`) intentionally keep
   throwing — a DB outage during SSR belongs in the error boundary. All
   call sites branch on `res.ok`; `lib/action-errors.ts` remains only as the
   internal classification helper.
5. **ESLint is permissive** — many valuable rules (`no-unused-vars`, `react-hooks/exhaustive-deps`,
   …) are switched off globally. Re-enable incrementally with an allow-list of legacy
   suppressions; do not bulk-flip without a dedicated pass.
6. ~~**No CI pipeline** exists yet.~~ **FIXED 2026-10-30.** `.github/workflows/ci.yml`
   runs lint + typecheck + coverage-gated tests + production build on every
   push/PR (E2E job scaffolded, disabled until a CI database secret exists).
   A `.githooks/pre-commit` hook (lint + typecheck) ships with the repo —
   enable with `git config core.hooksPath .githooks`. HSTS added to the app's
   security headers.
7. ~~**`tsconfig` has `noImplicitAny: false`.**~~ **FIXED 2026-10-30 (third pass).**
   Every `any` in the source tree was either redundant (the `User` type
   augmentation was incomplete, so `auth.ts` leaned on `as any` for
   `id`/`role`) or a workaround for a dynamic API (`table as any` for the
   six config tables; `formatter={(v: any) => …}` for Recharts). All
   twelve were eliminated: `next-auth.d.ts` now augments `User` too; the
   config-table call sites use a literal `ConfigTable` union; the Recharts
   formatter takes `number | string`; the command palette's `icon: any`
   became `React.ComponentType<{ size?: number }>`. `noImplicitAny: true`
   flipped on, `tsc --noEmit` clean.

8. **Signout must clear *every* auth cookie.** **FIXED 2026-10-30 (third pass).**
   NextAuth's built-in `/api/auth/signout` only expires the session-token
   cookie, leaving the CSRF and callback-url cookies behind. After a
   `NEXTAUTH_SECRET` rotation the surviving CSRF cookie (signed with the
   old secret, `httpOnly` so JS can't reach it) wedged the next sign-in
   attempt. The route handler in `app/api/auth/[...nextauth]/route.ts`
   now wraps NextAuth and — on POST/GET `/api/auth/signout` — appends
   `Max-Age=0` `Set-Cookie` headers for all six cookie name spaces
   (`next-auth.*` and `__Secure-next-auth.*`). A new
   `events.signOut` callback in `src/lib/auth.ts` writes an
   `auth.signed_out` audit entry (best-effort, DB-outage-safe). Both UI
   logout buttons (sidebar + topbar profile menu) funnel through
   `lib/signout.ts`, which calls `signOut({ callbackUrl: "/", redirect:
   false })` then hard-navigates to `/` — replacing the prior inline
   calls that bounced the user back to the page they were on. Regression
   tests: `app/api/auth/__tests__/signout.test.ts` (7) +
   `lib/__tests__/auth.test.ts` `events.signOut` block (4). End-to-end
   verified against the live dev server: cookies after signout are
   empty, fresh sign-in mints a clean set, audit row lands.

   **Follow-up fix (CLIENT_FETCH_ERROR).** The first cut of
   `fernlySignOut` used `signOut({ redirect: false })` and then
   `window.location.replace("/")`. That raced against NextAuth's own
   post-signout `__NEXTAUTH._getSession()` call (which fires
   `GET /api/auth/session` to refresh the local cache): our hard
   navigation aborted the in-flight fetch, and `fetchData`'s catch
   block logged `[next-auth][error][CLIENT_FETCH_ERROR] … undefined {}`
   on every logout. Switched to `signOut({ redirect: true })` so
   NextAuth performs the navigation itself and skips the `_getSession`
   call entirely — no in-flight fetch to abort, no console noise.
   Verified with a headless browser: both logout paths (sidebar +
   topbar) leave the console clean and the cookie jar empty.

## 7. Maintainability & reuse assessment

**Good:** consistent component extraction under `components/fernly/` (Field, Toggle,
StatCard, Section, EntityHistorySection, …) replacing repeated inline copies; a single
`lib/config` for status/label maps; typed audit actions; zod schemas; `cn()` utility.

**Was bad, now fixed:** 45-file dead shadcn directory (deleted); duplicated bcrypt/
validation logic (now in `lib/password.ts` / `lib/validation.ts`); server actions mixing
concerns (still a 1,700-line `data.ts` — see §8).

**Deliberate library choices that paid off:** zod (validation), bcryptjs (pure-JS, no
native build), @dnd-kit, recharts, sonner, zustand — all appropriate and now actually used.
`uuid`, `date-fns`, `framer-motion`, `next-intl` etc. were installed but never imported —
removed.

## 8. Recommended next iterations (priority order)

1. ~~CI pipeline (lint + typecheck + test + build) and pre-commit hook.~~ **Done 2026-10-30.**
2. ~~Stable-id identity columns + migration (removes name-collision ambiguity).~~ **Done 2026-10-30.**
3. ~~Result-object returns for all server actions (production-grade error UX).~~
   **Done 2026-10-30 (second pass)** — see §6.4.
4. ~~Split `server-actions/data.ts` by domain (`tasks.ts`, `projects.ts`, `users.ts`, …)~~
   **Done 2026-10-30 (second pass)** — 13 per-domain modules; `data.ts` is a
   barrel re-export (without `"use server"` — Turbopack strips re-exports from
   action modules, and a plain barrel keeps the server references intact).
   Server-only helpers moved to `shared.ts` / `result.ts`.
5. Nonce-based CSP (HSTS done at the app layer 2026-10-30; the reverse-proxy
   (Caddy) layer can also add it when TLS terminates there).
6. Redis-backed rate limiting. ~~Per-user notification routing~~ **Done 2026-10-30** (see §6.2).
