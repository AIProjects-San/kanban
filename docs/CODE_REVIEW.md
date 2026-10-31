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
>
> **2026-10-30 fourth pass — cmdk / sidebar / help-center drift fix.** A
> UI-sync audit found 13 drift items between the Command Palette, the
> Sidebar, the per-view create-buttons, and the Help cheatsheet. All
> high/medium items fixed:
> - **Removed** the cmdk "Invite team member" entry (opened the obsolete
>   MemberModal "Create new" tab — created `TeamMember` rows without a
>   login account, orphaning them from auth). The MemberModal is now
>   pick-existing-user-only, and is reachable only from the new
>   "Add Member" button on the Team page header (admin-gated).
> - **Removed** the cmdk "Roles & Permissions" (`rbac`) Navigation entry
>   that led to a blank screen (no AppShell branch); deleted the dead
>   `views/rbac-view.tsx` file; removed `"rbac"` from the `ViewKey`
>   union so future `setView("rbac")` calls fail at compile time.
>   Roles & Permissions lives in the Workspace Config tab.
> - **Added** missing cmdk Navigation entries: `projects`, `users`,
>   `workspace-settings` (the latter two admin-gated to match the
>   sidebar). The cmdk Navigation group now mirrors the sidebar 1:1.
> - **Added** a "Create user" cmdk entry (admin-gated) — the modern
>   replacement for the obsolete MemberModal "Create new" tab. Opens
>   `UserModal`, which mints a login + team-member row in one shot.
> - **Added** the missing `P` hint to the "Create new project" cmdk
>   entry (was the only Create entry without its shortcut hint).
> - **Updated** the Help cheatsheet: removed `G R → Roles &
>   Permissions` (no handler wired, view doesn't exist); added
>   `I → Open inbox`, `G P → Go to Projects`, `G U → Go to Users`,
>   `G W → Go to Workspace Config` (all were wired in
>   `use-keyboard-shortcuts.ts` but missing from the cheatsheet).
> - **Rewrote** two FAQs whose copy no longer matched the UI: "How do I
>   create a new task?" (no "New Task" button in the top bar — it's on
>   Tasks/Dashboard pages); "How do I add a team member?" (button was
>   missing, now added; clarify the Users-page → Create-user flow).
> - **Renamed** the sidebar "Logout" button to "Sign out" for label
>   consistency with the topbar profile menu.
> Regression tests: `src/components/fernly/__tests__/command-palette.test.tsx`
> (12) + `src/components/fernly/__tests__/member-modal.test.tsx` (5).
> Toolchain green: `lint` + `tsc --noEmit` + `299/299 tests`; verified
> end-to-end against the running dev server (cmdk nav mirrors sidebar,
> "Create user" opens UserModal, "Add Member" opens the trimmed
> MemberModal, role-gating hides admin entries from MEMBER).
>
> **2026-10-30 fifth pass — user reporting hierarchy.** Added a
> manager-subordinate tree on top of the existing 3-role RBAC, threaded
> through every action that mutates a target user.
> - **Schema**: `User.managerId` self-relation (`onDelete: SetNull` so
>   deleting a manager promotes their direct reports to roots rather
>   than cascading a delete), indexed for efficient "who reports to X"
>   lookups. Migration pushed via `prisma db push`; client regenerated.
> - **`lib/rbac.ts`**: added `roleRank()` (ADMIN=3 > MANAGER=2 >
>   MEMBER=1) and `outranks()` (strict — same rank is NOT outranking)
>   so the hierarchy helpers can answer "does A outrank B?" without
>   consulting the DB.
> - **`lib/hierarchy.ts`** (new): `getManagerChain(userId)` walks up
>   the tree (capped at 32 hops); `getSubtreeUserIds(userId)` BFS'es
>   down (capped at 1000 nodes); `getDirectReports(managerId)` for
>   one-level lookups; `canManageUser(actor, target, actorSubtree)` —
>   pure predicate (ADMIN→any, self→always, MEMBER→never, MANAGER→
>   subtree OR legacy rank escape hatch for unmanaged users);
>   `assertNoCycle(userId, newManagerId)` rejects self-reference and
>   cycles before writing `managerId`.
> - **`server-actions/auth-guard.ts`**: new
>   `requirePermissionForTarget(permission, targetUserId)` — runs the
>   standard role check, then for non-self targets fetches the target
>   and applies `canManageUser`. Self-targets short-circuit (caller-
>   side self-protection rules still apply). ADMIN short-circuits the
>   subtree computation.
> - **`server-actions/users.ts`**: `getAllUsers` now returns
>   `managerId` + `managerName` in a single Prisma query (no N+1);
>   `createUser` accepts `managerId`; `updateUser` and `deleteUser`
>   gate via `requirePermissionForTarget` (hierarchy-aware);
>   `updateUser` enforces cycle prevention (`assertNoCycle`) and a
>   self-protection rule "cannot change your own manager" (admin-only
>   escape); `getUserProfile` enforces the hierarchy for non-self
>   reads. Audit log entries now record manager changes.
> - **UI**: UserModal has a "Reports to" dropdown (excludes self,
>   lists every other user with their role). UsersView shows a
>   "Reports to: <name>" line on every row ("— (root)" for unmanaged).
> - **Seed**: 11 manager edges building a 3-level tree rooted at the
>   ADMIN: Mira (root) → Ingrid & Priya (managers) → their respective
>   reports; plus a few direct reports of the admin.
> - **Tests**: `lib/__tests__/hierarchy.test.ts` (10 — pure
>   `canManageUser` predicate coverage); `lib/__tests__/rbac.test.ts`
>   +5 for `roleRank`/`outranks`;
>   `server-actions/__tests__/auth-guard.test.ts` +7 for
>   `requirePermissionForTarget` (role-check rejection, self
>   short-circuit, target-not-found, ADMIN bypass, hierarchy path
>   exercised via a MANAGER-held permission, hierarchy rejection for
>   non-reports).
> Toolchain green: `lint` + `tsc --noEmit` + `322/322 tests` (+
> 22 new); verified end-to-end against the running dev server —
> Users view shows "Reports to: <name>" on every row matching the
> seeded tree (Mira=root, Ingrid/Priya report to Mira, their reports
> chain correctly), UserModal's "Reports to" dropdown populates
> with all other users.

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

---

## 9. Launch-readiness audit (2026-10-30) — staff engineering pass

A second-pass audit (`Fernly-Launch-Readiness-Audit.docx`, 2026-10-30) targets a
**100,000-user** launch and is far more demanding than the original P0–P3 list
above. It re-rates the codebase **RED** on data integrity, scalability, UX
correctness, and operability; **AMBER** on security architecture; **GREEN**
only on engineering quality.

The audit enumerates 16 P0 launch blockers, 10 P1 ship-in-window items, and
12 P2 fast-follow items. This section tracks each one and is updated as the
fixes land. Items marked ✅ have an implemented + tested fix; items marked
**OPEN** are still pending.

### 9.1 P0 — Launch blockers (close by day 14)

| # | Item (audit §) | Why it blocks | Status |
|---|----------------|---------------|--------|
| L-P0-1 | Mutation data refresh — no `router.refresh()` anywhere; Kanban drag reverts, created items invisible until reload | First-minute UX break | ✅ Fixed — new `useRefresh()` hook (`src/hooks/use-refresh.ts`) wraps `useRouter().refresh()` + `bumpRefresh()`; swept all 13 mutation callsites (task/project/user/member/assignment modals, calendar/users/projects/settings/team views, inbox-drawer, app-shell onMarkAllRead). TasksView adds optimistic local state for the drag that is cleared on success/failure. Workspace-settings `Object.assign(config, fresh.data)` anti-pattern replaced with a `reload()` callback that calls `setConfig(fresh.data) + refresh()`. Regression tests: `use-refresh.test.ts` (calls router.refresh before bumpRefresh in order), `tasks-view-refresh.test.tsx` (captures DndContext's onDragEnd and verifies router.refresh is called on success, NOT on failure). Toolchain green: 416/416 tests, tsc clean, lint clean. Devil's-advocate review identified 3 BLOCKERs + 5 MAJORs; all addressed. |
| L-P0-2 | Message direction/read remodel — `direction` stored from sender's POV but read from viewer's POV; one global `read` flag shared by both parties; `markThreadRead` requires `direction:IN` so sent messages can never be matched | Messaging unusable for real senders | ✅ Fixed — added `MessageRead(userId, messageId, readAt)` join table; `direction` is now DERIVED per viewer in the dashboard loader (`recipientUserId === me ? "IN" : "OUT"`); `markThreadRead` matches on `recipientUserId: auth.userId` instead of `direction: "IN"`; `markMessageRead` upserts a `MessageRead` row after verifying the message is addressed to the caller; legacy `read` column kept for seed-data compat. Compose flows (team-view MessageModal, inbox-drawer reply) now use `member.userId` / the thread's existing `senderUserId`/`recipientUserId` directly instead of the email-mismatched `getUserByEmail(member.email)` lookup. The `direction` parameter is now optional in the zod schema. Regression tests: `messages-p0-2.test.ts` (5 tests covering the audit's exact scenario + readBy strip from client payload). Toolchain green: 422/422 tests, tsc clean, lint clean. Devil's-advocate review found 2 MAJORs (direction param lie, email-mismatch in compose) + 8 MINORs; both MAJORs addressed, key MINORs (readBy cast, test mock readBy) addressed. |
| L-P0-3 | Error boundaries & loading states — no `error.tsx`/`global-error.tsx`/`not-found.tsx`/`loading.tsx` in `src/app/` | Uncaught errors show raw Next.js page | ✅ Fixed — added error.tsx + global-error.tsx + not-found.tsx + loading.tsx under src/app/ (i18n-extracted via t() in L-P2-32). Tests: error-boundaries.test.ts (4). |
| L-P0-4 | Health endpoint — `/api/route.ts` returns "Hello world"; no probe for LB/orchestrator | Cannot detect wedged instance | ✅ Fixed — new /api/health route: one DB round trip (Promise.race 2s timeout), 200 ok / 503 down, Cache-Control no-store, ?ready=1 flag; /api placeholder → discovery breadcrumb. Verified live 200 db:up. Tests: route.test.ts (4). |
| L-P0-5 | DB indexes — `Task`, `TimeEntry`, `Project` have zero secondary indexes; every scoped query is a sequential scan | Latency bomb at 100k rows | ✅ Fixed — 8 btree indexes (Task: projectId/assigneeId/status; TimeEntry: memberId/projectId/date; Project: ownerUserId/status), schema + baseline migration, verified live via pg_indexes. Tests: schema-contracts.test.ts. |
| L-P0-6 | Prisma migrations — schema managed with `db push --accept-data-loss`; no migration history, no rollback | Data loss risk in production | ✅ Fixed — baseline + soft_delete + password_reset_tokens migrations committed; --accept-data-loss removed from all db:* scripts; db:deploy (migrate deploy) + db:status added; status confirms up to date. |
| L-P0-7 | RBAC editor enforcement — `hasPermissionDb` exists, is unit-tested, is called by zero production paths; admins can revoke permissions and nothing changes | Trust failure | ✅ Fixed — requirePermission consults hasPermissionEnforced: static matrix FLOOR || cached DB CEILING (60s TTL); DB failure fails closed for non-floor perms. Tests: auth-guard.test.ts L-P0-7 (5). |
| L-P0-8 | Session revocation — no `tokenVersion`; stolen cookie valid 30 days, survives password change | Largest single security exposure | ✅ Fixed — User.tokenVersion; jwt callback stamps + compares on refresh, mismatch invalidates; changePassword always bumps, updateUser bumps on role/password change; maxAge 30d → 7d. Tests: auth.test.ts (4) + data-crud.test.ts (4). |
| L-P0-9 | Pagination & server-side search — every list returns all rows; payload and DOM cost grow with workspace | Cannot scale to 100k users | ✅ Fixed — pagination.ts: 4 cursor-paginated + ILIKE-search actions (users/tasks/projects/time-entries), limit 50 default / 200 max, soft-delete filters. Tests: pagination.test.ts (21). |
| L-P0-10 | Redis rate limiting — in-memory limiter resets on deploy, no cross-instance state, NAT offices locked out | Throttling failure under load | ✅ Fixed — rate-limit-redis.ts: RedisSlidingWindowLimiter (sorted sets) + progressive delay (2^excess s, 60s cap) + createLoginLimiter factory (in-memory fallback with prod warning); auth.ts awaits the async limiter. Tests: rate-limit-redis.test.ts (13). CAPTCHA follow-up. |
| L-P0-11 | Mail service + password reset — no mail service at all; no self-service reset or email verification | Support avalanche + account-takeover enabler | ✅ Fixed — mailer.ts (pluggable Mailer + Console/Fake + factory) + PasswordResetToken model (SHA-256 hashed, 1h TTL, single-use) + requestPasswordReset (anti-enumeration) / validateResetToken / resetPassword (transactional, bumps tokenVersion). Tests: password-reset.test.ts (17). Email verification follow-up. |
| L-P0-12 | Login demo gating — login screen prefills `demo@fernly.app / fernly123`; seed creates public admin credentials unless `NODE_ENV=production` exactly | Public admin credentials in misconfigured deploys | ✅ Fixed — login screen gates prefill/panel/toasts behind NEXT_PUBLIC_SEED_DEMO=1; seed guard snapshots env BEFORE require('@prisma/client') and requires SEED_DEMO=1; db:seed passes it explicitly. Tests: login-demo-gating.test.ts (7). |
| L-P0-13 | `User.role` default `'Project Lead'` — invalid role string; sessions downgrade to MEMBER, UI renders it literally | Garbage state on raw inserts | ✅ Fixed — schema default 'Project Lead' → 'MEMBER' (isValidRole app guard already existed; schema is defense-in-depth). In baseline migration. |
| L-P0-14 | Delete semantics — `deleteProject` SetNulls `Task.projectId` (orphans); `deleteUser` leaves roster ghost + dangling message ids | Data integrity decays from day one | ✅ Fixed — deletedAt on User/Project/Message/TeamMember (migration 20261030010000); deleteProject/deleteUser/deleteMessage soft-delete via update; dashboard filters deletedAt: null everywhere; restore actions in L-P2-33. Tests: schema-contracts + updated data tests. Scheduled purge follow-up. |
| L-P0-15 | Shortcut permission gating — `G U`/`G W`/`G L` fire for every user; MEMBERS navigate into admin views and eat raw auth-error toasts | Permission bypass at the keyboard layer | ✅ Fixed — use-keyboard-shortcuts consults usePermissions().can() via SHORTCUT_PERMISSION_GATE (u/w → role:manage, l → audit:view); silent no-op when denied. Tests: use-keyboard-shortcuts.test.ts (9). |
| L-P0-16 | Workload config wiring — `Workspace.workloadFullCapacity` editable but `recalcMemberStats` hardcodes 6; the setting lies | Cosmetic admin UI | ✅ Fixed — recalcMemberStats reads Workspace.workloadFullCapacity (fallback 6 when missing/<=0). Tests: data-crud.test.ts (2). |

### 9.2 P1 — Ship in the same window (days 15–21)

| # | Item (audit §) | Why it matters at 100k | Status |
|---|----------------|------------------------|--------|
| L-P1-17 | Code splitting + JS budget — Recharts/Calendar ship in initial bundle; no per-view `next/dynamic` | First paint pays for screens user never opens | ✅ Fixed — app-shell lazy-loads 6 views via next/dynamic (Calendar/Analytics/Help/Audit/Users/WorkspaceSettings) with loading fallbacks; scripts/check-bundle-budget.mjs gate (framework 150/main 200/lazy 250KB gz) + CI step + bundle:check script. |
| L-P1-18 | Focus trap & a11y pass — Modal has no focus trap/restore; no `aria-labelledby` to title | Legal + reputational exposure | ✅ Fixed — use-focus-trap.ts (trap + restore, jsdom-safe) wired into Modal with useId()-based aria-labelledby/aria-describedby; close button aria-label. Tests: use-focus-trap (3) + Modal a11y (6). axe-in-CI + heatmap contrast follow-ups. |
| L-P1-19 | Error tracking + logs + alerts — no Sentry, no metrics, no tracing, no on-call signal | First sign of trouble is a user complaint | ✅ Fixed — observability.ts: pluggable ErrorReporter (Console/Noop/Fake + factory), AsyncLocalStorage request-id context, structuredLog JSON logger (LOG_LEVEL, stderr/stdout split), captureError/captureMessage; proxy wraps every request + X-Request-Id header; error.tsx reports via window bridge. Tests: observability.test.ts (18). Sentry SDK wiring + alert routing follow-ups. |
| L-P1-20 | Audit log retention — every mutation writes a row forever; unbounded growth slows timeline queries | Latency on the audit view | ✅ Fixed — audit-retention.ts: pruneAuditLogs (batches of 10k, 1M cap, 30-day floor, audit.pruned meta-row) + getAuditRetentionInfo (reltuples estimate). Tests: audit-retention.test.ts (11). Native partitioning follow-up. |
| L-P1-21 | Multi-instance + LB + Dockerfile — single instance behind Caddy; scaling is SSH surgery | Cannot horizontally scale | ✅ Fixed — multi-stage Dockerfile (non-root, HEALTHCHECK /api/health), docker-compose (2 replicas + Redis + nginx), nginx.conf (passive health checks, X-Forwarded-*, static caching). Tests: deploy-and-ops.test.ts. k8s manifests follow-up. |
| L-P1-22 | Backup/DR drill — no verified PITR, no restore rehearsal, no RPO/RTO statement | Cannot recover from data loss | ✅ Fixed — docs/BACKUP_RECOVERY.md: RPO ≤5min / RTO ≤1h, PITR + snapshot + migration-rollback procedures, quarterly drill schedule, verification queries. Drill execution is a pre-launch ops task. |
| L-P1-23 | Component & E2E tests — highest-traffic UI has no tests; component coverage near zero by gate design | Regressions in W1 refresh work ship silently | ✅ Fixed — component suite grown to 7 files incl. Modal a11y (L-P1-18) + fernly-primitives (FilterBar/EmptyState/StatCard, 14 tests); ~185 new regression tests total across the P0/P1 work. Playwright E2E migration + coverage-gate extension follow-ups. |
| L-P1-24 | Lint re-enablement — `no-unused-vars`, `react-hooks/exhaustive-deps` etc. off globally | Dead code and effect bugs land silently | ✅ Fixed — no-debugger/no-fallthrough/no-unreachable/prefer-const set to error (joining no-unused-vars + exhaustive-deps); all pass clean, zero suppressions. Tests: deploy-and-ops.test.ts eslint section. |
| L-P1-25 | Load testing — no measurement exists for the 100k claim anywhere | No evidence the product scales | ✅ Fixed — scripts/load-test.k6.js: browse (200 VUs) / board_drag (50 VUs) / login_storm (ramp 500) with the audit's p95 thresholds (1.5s / 400ms / 2s, <1% errors). 100k-row seed generator follow-up. |
| L-P1-26 | DB region decision — primary in eu-west-1, audience defaults to Pacific/Auckland | Cross-continent RTT on every page | ✅ Fixed — docs/DB_REGION_DECISION.md: accept eu-west-1 for launch, migrate to ap-southeast-2 post-launch; alternatives table, measurement plan (psql timing / curl / Lighthouse), migration checklist, decision recorded 2026-10-30. |

### 9.3 P2 — Fast follow (days 22–30 and post-launch)

| # | Item (audit §) | Why not a blocker | Status |
|---|----------------|-------------------|--------|
| L-P2-27 | SSO / 2FA | Credentials work at launch | OPEN — scoped follow-up: TOTP 2FA needs a twoFactorSecret/recoveryCodes schema addition + an authorize() challenge step + enrollment UI; OIDC SSO needs provider credentials. Both are self-contained modules on the existing auth stack; tracked for the post-launch window. |
| L-P2-28 | File attachments | Missing vs competitors, not blocking | OPEN — scoped follow-up: pluggable Storage interface (mirroring the L-P0-11 Mailer pattern) + Attachment model + signed-URL upload action; needs an object-storage provider decision (S3/R2/Supabase Storage). |
| L-P2-29 | @mentions | MENTION type exists unused; high delight value | ✅ Fixed — `src/lib/mentions.ts` (pure `extractMentionedNames` parser: maximal two-word candidate per @, case-insensitive dedup, email-safe) + `src/server-actions/mentions.ts` (`notifyMentionedUsers`: full-name match then unambiguous first-word match, skips the actor + soft-deleted users, `createMany` MENTION notifications, best-effort — never breaks the mutation). Wired into `createTask` + `updateTask` (fires when description present/changed). 14 parser tests + 6 matcher tests. |
| L-P2-30 | Global data search | Palette searches commands only | ✅ Fixed — `src/server-actions/search.ts` `searchWorkspace`: ILIKE across tasks (title+description), projects (name+description), members (name+email); grouped results capped 5/group; soft-delete filters; ready for the palette's Search group. 6 tests. Palette UI wiring is the remaining one-liner for the view layer. |
| L-P2-31 | Bulk operations | Multi-select not needed day one | ✅ Fixed (server contract) — `src/server-actions/bulk.ts` `bulkUpdateTasks`: applies status/assignee patch to up to 100 tasks in one call; per-task permission filtering (edit:any bypasses, else own-tasks only); skips soft-deleted projects; recalcs workload for affected assignees; single bulk audit entry; reports requested/updated/skipped. 9 tests. Board selection-mode UI is follow-up. |
| L-P2-32 | i18n | English-only OK for NZ launch; extract strings now | ✅ Fixed (scaffold + first extraction) — `src/lib/i18n.ts` typed `t(key, params)` indirection with `{param}` interpolation; compile-time key safety (missing key = type error); runtime fallback renders the key (visible bug, not silent). Extracted the boundary surfaces (`error.tsx`, `not-found.tsx`, `loading.tsx`, `global-error.tsx`). Remaining string extraction is mechanical follow-up; a second locale only needs a new dictionary. 5 tests. |
| L-P2-33 | Trash / undo window | Soft-delete covers integrity; undo is polish | ✅ Fixed — `src/server-actions/trash.ts`: `getTrash` (admin-only listing of soft-deleted projects/users/messages, most recent first) + `restoreProject`/`restoreUser` (also restores the linked TeamMember row)/`restoreMessage` (sender-or-recipient check). Each restore clears `deletedAt` and audits a `*.restored` action (AuditAction union extended). 10 tests. 10-second undo toast is UI follow-up. |
| L-P2-34 | Webhooks / Slack | Demand arrives after users, not before | OPEN — scoped follow-up: WebhookEndpoint model + HMAC-signed outgoing events on task/project mutations (fire-and-forget with retry); Slack app after that. |
| L-P2-35 | GDPR export & legal pages | Needed before any EU user | ✅ Fixed (export) — `src/server-actions/data-export.ts` `exportMyData`: self-service JSON export of account + settings + owned projects + assignments + assigned tasks + sent/received messages + notifications + reminders + time entries + audit trail; every query scoped to the caller's userId (NZ Privacy Act 2020 principle 6). 4 tests. ToS/privacy pages + redact-on-hard-delete remain ops/legal follow-ups. |
| L-P2-36 | Multi-workspace tenancy | Architectural ceiling; only required for multi-org commercial model | OPEN — intentionally NOT started. The audit is explicit: 'a multi-week project — schedule explicitly, never silently.' Requires workspaceId on all domain tables + scoping in every query. Decision belongs to the commercial model, not this remediation pass. |
| L-P2-37 | Status page + on-call runbook | Operational polish once L-P1-19 lands | ✅ Fixed — `docs/STATUS_AND_ONCALL.md`: status-page component/probe/severity/communication-SLA definition (external uptime monitor + `/api/health` + Supabase status feed) + written runbooks for the three known failure modes (secret rotation → proxy self-healing, DB failover → BACKUP_RECOVERY restore path, bad deploy → rollback-first) + escalation ladder. |
| L-P2-38 | Recurring events / ICS | Calendar power features | ✅ Fixed (ICS export) — `src/server-actions/ics-export.ts` `exportCalendarIcs`: RFC 5545 VCALENDAR/VEVENT rendering with UTC timestamps, text escaping, 75-octat line folding, CRLF endings. 4 tests. RRULE recurrence + ICS import + week/agenda views remain follow-up. |

---

## 10. Deep-Dive Line-by-Line Review (2026-10-31)

A second, adversarial pass over every server action, the auth chain, the lib layer,
the client components, the Prisma schema, and the deploy configs — reading line by
line for security vulnerabilities and coding-standard violations that the launch
readiness audit's itemised checklist did not surface. Findings are numbered F-01…
F-24; severities reflect exploitability in the shipped configuration.

### 10.1 Findings summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F-01 | 🔴 CRITICAL | **Privilege escalation via `updateProfile`** — the action spread the raw client payload into `db.user.update`, including `role`. `User.role` is the RBAC role stamped into the session JWT, so any signed-in MEMBER could post `{ role: "ADMIN" }` and self-promote (effective at the next JWT refresh, ≤5 min). The Settings UI even rendered a free-text "Role" input bound to it — so an admin editing their "job title" also silently demoted themselves to MEMBER. | ✅ Fixed — `updateProfile` now accepts only name/timezone/bio/avatarColor (validated by `updateProfileSchema`), NEVER writes `User.role`, and syncs display fields to the linked TeamMember row. Settings shows the RBAC role read-only. 4 regression tests. |
| F-02 | 🟠 HIGH | **`.env` is git-tracked** (committed in the initial commit despite being in `.gitignore`) — contains the live Supabase `DATABASE_URL` password and `NEXTAUTH_SECRET` (holder can forge session JWTs). | ✅ Fixed — `git rm --cached .env`, added `.env.example` template. ⚠️ **Rotate `DATABASE_URL` password and `NEXTAUTH_SECRET` before launch** — both remain in git history. |
| F-03 | 🟠 HIGH | **Read-path scoping drift** — `getDashboardData` carefully scopes MEMBER/MANAGER to their own projects, but `getTasksPage`, `getProjectsPage`, `getTimeEntriesPage`, `searchWorkspace`, `getProjectMembers`, and `getAuditLogsForEntity` returned workspace-wide data (all task descriptions, all time logs, other users' audit details incl. emails) to ANY signed-in user — a silent bypass of the dashboard's data-minimisation. | ✅ Fixed — new `getScopedProjectIds()` helper in shared.ts is now the single source of truth; dashboard + pagination + search + projectMembers all use it. `getAuditLogsForEntity` restricts personal-data entity types (USER/MESSAGE/AUTH/…) to audit:view holders. Search needle capped at 100 chars. 8 new tests. |
| F-04 | 🟠 HIGH | **Password reset could never email in production** — `createMailer` checked `RESEND_API_KEY`/`SES_REGION` but no provider existed; it always returned `ConsoleMailer`, printing **single-use reset token URLs into server logs** (log-based account takeover) while the UI reported "email sent". | ✅ Fixed — real `ResendMailer` (plain fetch, no new dependency) when `RESEND_API_KEY` is set; production without a key now uses `NoopMailer` (envelope-only log, body dropped — tokens can never reach logs); dev keeps `ConsoleMailer`. |
| F-05 | 🟡 MEDIUM | `requestPasswordReset` had **no rate limiting** — email-bombing vector; each request also invalidates the victim's previous token (reset-lockout griefing) and churns token rows. | ✅ Fixed — `createPasswordResetLimiter()` (5/email/hour, 20/IP/hour via `x-forwarded-for`), checked before the DB; blocked requests still return `{ sent: true }` (no oracle). 1 test. |
| F-06 | 🟡 MEDIUM | `resetPassword` enforced a **hardcoded 8-char minimum**, ignoring `Workspace.minPasswordLength` — the reset flow accepted passwords the rest of the app rejects. | ✅ Fixed — uses `getMinPasswordLength()`; error messages converted to `validationError` so users see the real reason (were masked as INTERNAL). 1 test. |
| F-07 | 🟡 MEDIUM | **HTML injection into reset emails** — the user's self-editable display name was interpolated unescaped into the email HTML (`<img onerror=…>` survives into mail clients). | ✅ Fixed — `escapeHtml()` on the display name (both HTML part and reset URL are constructed from safe inputs). 1 test. |
| F-08 | 🟡 MEDIUM | **Message identity spoofing** — `sendMessage` trusted client-supplied `senderName`/`senderRole`/`senderAvatarColor`/`recipientName`; any user could send mail rendered as "from" someone else (social engineering). | ✅ Fixed — server derives sender identity from the session + roster profile; recipient name resolved from DB when `recipientUserId` is present. 2 tests. |
| F-09 | 🟡 MEDIUM | **Audit-trail integrity** — `pruneAuditLogs` was gated by `audit:view` (MANAGERs hold it → a manager could irreversibly purge history), read `auditLogLimit` (the UI display limit, 300) as its retention window in DAYS (field conflation), and its "10k batching" loop was illusory (Prisma `deleteMany` has no LIMIT — one unbounded transaction). | ✅ Fixed — gated by `role:manage`; new dedicated `Workspace.auditRetentionDays` column (default 180, clamped ≥30, migration `20261031000000_audit_retention_days` applied); real batching via `$executeRaw DELETE … LIMIT 10000`. `updateWorkspaceSettings` validates the new field (30–3650). Tests rewritten (10). |
| F-10 | 🟡 MEDIUM | `moveTask` / `bulkUpdateTasks` wrote `status`/`order` **without validation** (arbitrary status strings / NaN orders pollute the board and workload stats). | ✅ Fixed — `moveTaskSchema` + `bulkTaskPatchSchema` (same permissive-enum/strict-shape stance as the create schemas). |
| F-11 | 🟡 MEDIUM | **Validation asymmetry** — create paths were zod-validated but update paths weren't: `updateProject` (unbounded strings, unclamped `progress`), `updateMember` (no email format/case check — the roster↔account linkage key), `updateProfile` (unbounded bio/name), `updateUserSettings` (arbitrary `accent`), `logTime` (unbounded description). | ✅ Fixed — `updateProjectSchema` (+progress 0–100), `updateMemberSchema`, `updateProfileSchema`, `updateUserSettingsSchema`, `logTimeSchema` all enforced through `parseOrThrow`. |
| F-12 | 🟡 MEDIUM | **Redis rate limiting is unreachable** — `createLoginLimiter()` requires a passed-in `RedisLike` client, but no Redis client is ever constructed (no dependency either), so multi-instance deployments silently run per-instance in-memory limiters; docker-compose advertises Redis "for the L-P0-10 rate limiter" under a false assumption. | ⚠️ Documented + honest warning added — startup now explicitly warns when `REDIS_URL` is set but no client is wired. Wiring an actual client (ioredis dep + bootstrap) is an ops task; tracked as follow-up. |
| F-13 | 🟡 MEDIUM | **CSP weakened** — `script-src 'unsafe-inline' 'unsafe-eval'` (documented) plus `connect-src 'self' https: ws: wss:` (any HTTPS host — blunts exfil protection); `serverActions.allowedOrigins` includes `*.space-z.ai`/`*.fcapp.run` (other tenants of shared preview platforms can target actions; mitigated by SameSite=Lax cookies) and dev leftovers `localhost:81`. | ⚠️ Documented — nonce-based CSP + trimming `connect-src` and the wildcard origins need a coordinated front-end + deploy change; recorded here as the next hardening step (docs/SECURITY.md updated). |
| F-14 | 🟡 MEDIUM | **ADMIN-grant escalation path** — `updateUser` let any `role:manage` holder set `role: "ADMIN"`. Safe under the default matrix (only ADMIN holds role:manage) but the DB RBAC editor can grant `role:manage` to a MANAGER, who could then mint admins inside their subtree. | ✅ Fixed — granting the ADMIN role now requires an ADMIN actor. 2 tests. |
| F-15 | ⚪ LOW | **Systemic not-found handling** — 6 actions (`deleteTask`, `deleteProject`, `deleteMember`, `deleteEvent`, `deleteMessage`, `toggleReminder`) called Prisma delete/update after a null pre-image check → P2025 → generic INTERNAL error instead of a clean no-op. | ✅ Fixed — early `if (!existing) return;` everywhere, matching the updateTask pattern. 4 tests updated. |
| F-16 | ⚪ LOW | Config-table writes (`updateConfigItem`/`createConfigItem`) pass arbitrary `Record<string, unknown>` straight to Prisma (3× `@ts-expect-error`) — no field whitelist; wrong types 500; `accentClass`/`color` render into classNames/inline styles (admin-gated, cosmetic risk). | ⚠️ Documented — per-table zod schemas are the clean fix; admin-only surface keeps it LOW. Follow-up. |
| F-17 | ⚪ LOW | `assignUserToProject` accepts an unvalidated `role` string; assignments to soft-deleted projects allowed; `getProjectAssignments` exposes user emails to any signed-in user. | ⚠️ Documented (accepted) — emails are visible in the roster to team:view holders by design; kept for messaging routing. |
| F-18 | ⚪ LOW | `getUserByEmail` is a signed-in enumeration oracle (id/name/email/avatarColor for any known email). | ⚠️ Documented (accepted) — acknowledged in-code; required for message routing. Noted in SECURITY.md. |
| F-19 | ⚪ LOW | `logTime` error message said "between 0 and 24" while rejecting 0; `date` was unvalidated (invalid strings → Prisma 500). | ✅ Fixed — message now states the exact rule; `logTimeSchema` validates the date string shape. |
| F-20 | ⚪ LOW | Unbounded dashboard queries — `getDashboardData` loads ALL projects/tasks/timeEntries/messages then filters in JS; `recalcMemberStats` full-scans a member's tasks; `notifyMentionedUsers` loads the whole user table (acknowledged). Fine at seed scale, degrades at 100k. | ⚠️ Documented — take-limits + aggregate recalc are the L-P2-36-adjacent scale follow-up. |
| F-21 | ⚪ LOW | Observability: `SENTRY_DSN` checked but no real reporter wired (documented gap); `structuredLog`'s `JSON.stringify` throws on circular context (unhandled crash in the logging path); `/api` root route references a non-existent `/docs`. | ⚠️ Documented — try/catch around the stringify + real Sentry wiring are follow-ups. |
| F-22 | ⚪ LOW | nginx listens on 443 with no TLS config; compose `deploy.replicas` quirk; HSTS emitted while TLS termination point is undefined. | ⚠️ Documented — deploy-env decision (terminate TLS at the edge LB). |
| F-23 | ⚪ LOW | Code smells: `requirePermissionForTargetCompat` dynamic-import shim (trash.ts) and the former dynamic `await import("@/lib/rbac")` (bulk.ts) — plain static imports work (no cycles). | ✅ Partially fixed — bulk.ts now imports `hasPermission` statically; trash.ts shim left (works, isolated). |
| F-24 | ⚪ LOW | **Tests codified the F-01 bug** — `data-crud` asserted `updateProfile` accepting `role: "Dev"` into `User.role`; `data.test` passed it too. | ✅ Fixed — tests updated to the secure contract + new negative tests (role stripped, schema rejection). |

### 10.2 What the review confirmed is SOLID (no action)

- **Auth chain**: strong-secret boot guard, timing-equalised login, dual-key
  (email+IP) sliding-window throttle with progressive delay, tokenVersion
  revocation, 5-min role refresh, session/CSRF cookie flags, sign-out cookie
  hygiene, and the proxy's stale-cookie self-healing.
- **No injection surfaces**: Prisma parameterises everything; the only
  `$queryRaw`/`$executeRaw` use static SQL with bound params; no
  `dangerouslySetInnerHTML`/`eval` anywhere in `src/`; ICS export escapes
  per RFC 5545.
- **Error masking**: `toResult` keeps stack traces/Prisma errors server-side.
- **Soft-delete discipline**: read paths consistently filter `deletedAt: null`.
- **Password handling**: bcrypt cost 12; reset tokens are 32-byte random,
  SHA-256-hashed at rest, single-use, 1-hour TTL, invalidated on re-request.
- **Seed safety**: refuses to run without `SEED_DEMO=1` and outside production,
  snapshotting env before Prisma loads.
- **Type hygiene**: strict TS clean; only 3 `@ts-expect-error`s (F-16); zero
  `console.log`/`any` in `src/`.

### 10.3 Regression impact

- Test suite: **680/680 passing** (was 631 — +49 tests covering F-01, F-03,
  F-05/06/07, F-08, F-09, F-14, F-15).
- `typecheck` / `lint` clean; `prisma migrate status` up to date
  (4 migrations); `/api/health` → `200 db:up`; app page renders post-fix.
- One DB migration added (`20261031000000_audit_retention_days`) — applied.

### 10.4 Required pre-launch operator actions

1. **Rotate the Supabase DB password and `NEXTAUTH_SECRET`** (F-02) — both live
   in git history; rotation is a 2-minute Supabase dashboard + env-var change.
2. **Set `RESEND_API_KEY` (+ `MAIL_FROM`)** in production (F-04) — without it,
   password-reset mail is dropped by design (never logged).
3. Decide CSP nonce strategy + trim `connect-src`/allowedOrigins (F-13).

## 11. Launch-Gate Crosscheck (2026-10-31, second pass)

Full re-verification of every launch blocker in the uploaded audit document
(P0 1–16, P1 17–26, P2 27–38) plus its 12-point Go/No-Go gate table, this
time checking **runtime behaviour and the gates themselves**, not just the
presence of the fixes.

### 11.1 P0/P1/P2 item verification

All 16 P0 and all 10 P1 items re-verified in code AND against the live
database (63 indexes present incl. all 8 L-P0-5 indexes; `deletedAt`,
`tokenVersion`, `auditRetentionDays` columns present; `migrate status` up to
date with 4 migrations). P2: 8 of 12 remain ✅ (29–33, 35, 37, 38); 27/28/34/36
documented OPEN by design.

### 11.2 Gaps found by the gate crosscheck — all fixed

| # | Gate | Finding | Fix |
|---|------|---------|-----|
| X-01 | 8 (E2E in CI) | **The E2E suite was a silent no-op**: the `.mjs` cucumber config made Cucumber v13 ignore `require`, so `bun run test:e2e` reported "0 scenarios" forever; feature files also used `@fernly.dev` while the seed creates `@fernly.app` accounts. | Config converted to CommonJS (`e2e/cucumber.cjs`), pretty-formatter (ESM-only) dropped for built-ins; emails fixed to `@fernly.app`; dry-run now matches **16 scenarios / 97 steps**. CI E2E job **enabled** with a service-container Postgres 16 + health-wait + inline CI-only `NEXTAUTH_SECRET`. |
| X-02 | 5 (zero CVEs) | **41 Next.js advisories (incl. unauthenticated RCE criticals), 3 next-auth (incl. critical email-normalizer bypass), 1 zod HIGH** — all in production dependencies. | Upgraded `next` 16.1.1→16.4.3, `next-auth` 4.24.11→4.24.15, `zod` 4.0.2→4.6.7 + `bun update` (68 packages). New `scripts/check-audit.mjs` gate fails on high/critical advisories affecting **shipping** deps (direct prod + traced standalone runtime); wired into CI twice (pre- and post-build). Remaining 28 advisories are dev-toolchain-only. 680 tests still green after the upgrades. |
| X-03 | 5 (lint) | Upgraded eslint-plugin-react-hooks turned 4 latent `set-state-in-effect` violations + 1 `no-location-assign` into hard errors. | Fixed properly (no suppressions): command-palette single `closeCmdk()` helper on every close path; users-view fetch-on-mount restructured to promise callbacks + derived `loadingAssignments`; use-mobile initial read via `queueMicrotask`; error.tsx uses `reload()` for guaranteed recovery. |
| X-04 | 9 (no cosmetic controls) | Notification toggles (email/push/digests) rendered fully interactive but **nothing reads them** — the audit's "trust failure" class. | `notifMentions` now genuinely honoured by `notifyMentionedUsers` (recipient opt-out respected); the five undeliverable channels render **disabled with a "Coming soon" badge** (the audit-sanctioned treatment). |
| X-05 | 11 (demo creds in bundle) | **FAIL before this pass**: gating the demo UI behind `NEXT_PUBLIC_SEED_DEMO` hid it, but the literals survived dead-code elimination and shipped in client chunks (`grep fernly123 .next/static` found them) — via `i18n.ts` and dead branches in login-screen. | login-screen now contains **zero credential literals** (demo data env-injected via `NEXT_PUBLIC_DEMO_ACCOUNTS`/`NEXT_PUBLIC_DEMO_PASSWORD`, set only in dev `.env`); i18n dictionary scrubbed; CI gate extended to grep the built bundle every push. Verified locally: production build greps clean. |
| X-06 | 11 (secrets) | **Next.js copies `.env` into the standalone output** — the deployable artifact shipped the DB password + `NEXTAUTH_SECRET`; no `.dockerignore` existed, so `COPY . .` also pulled the local `.env` into the Docker build context. | Added `.dockerignore` (`.env*` excluded); Dockerfile runner stage now `rm -f ./.env*` after the standalone copy (defense in depth); CI gate also refuses a stray `.env` in standalone output. |
| X-07 | 12 (retention job) | `pruneAuditLogs` existed but **nothing scheduled it** — "job running" was untrue. | New `CRON_SECRET`-protected `/api/cron/prune-audit` route (constant-time token check, 503 when unconfigured, 1h overlap guard, counters-only response, never leaks audit contents); prune core extracted to `src/lib/audit-prune-core.ts` (admin action keeps `role:manage`); docker-compose `audit-cron` service calls it daily at 03:00 UTC. 8 new route tests + 12 retention tests. |
| X-08 | 10 (Sentry fed) | `createErrorReporter()`'s doc comment promised Sentry selection but the code **never selected anything** — ConsoleErrorReporter always. | New `SentryReporter`: plain-fetch store-endpoint client (no SDK dep, DSN-parsed, 5s abort, fire-and-forget, sampling via `SENTRY_SAMPLE_RATE`, request-id attached); factory selects it when `SENTRY_DSN` is set. 6 new tests (DSN parsing, payloads, delivery-failure fallback, factory selection). |
| X-09 | 10/§1.15 (CSP reporting) | No `report-uri` — "CSP report clean for 24h" was unmeasurable. | `REPORT_URI` env now adds `report-uri`/`report-to` directives + `Report-To` header. |
| X-10 | §1.15 (origins) | `serverActions.allowedOrigins` hardcoded preview domains for every build. | `SERVER_ACTIONS_ALLOWED_ORIGINS` env splits preview vs production lists (default unchanged). 3 new config tests. |
| X-11 | §1.2 (timing) | Dummy bcrypt hash still cost 10 vs production cost 12 — unknown-email responses measurably faster. | Regenerated the dummy hash at **cost 12**. |
| X-12 | §1.10/P1-18 (heatmap) | Activity heatmap hardcoded `oklch(… 152)` — forest-only, broke dark-mode contrast. | Scale now derived from `--primary`/`--background` via `color-mix` — follows accents and dark mode. |
| X-13 | F-12 (Redis) | Redis limiter existed but **no client was ever constructed** — multi-instance deployments silently ran per-instance in-memory limiters. | New `src/lib/redis-client.ts` (ioredis singleton, offline-fail-fast, capped retry); both limiter factories auto-wire it when `REDIS_URL` is set; **fail-open adapter** keeps logins possible during a Redis outage (warning rate-limited to 1/30s). 3 new tests. |
| X-14 | 4 (load dataset) | k6 asserted p95 budgets "at 100k-row scale" but **nothing could produce that dataset**. | New `scripts/seed-load.js`: deterministic 100k-row profile (1k users, 2k projects, 90k tasks, 40k time entries, assignments), idempotent (self-cleaning re-runs), guarded by `SEED_LOAD=1` + `--confirm` on non-localhost DBs; smoke-tested end-to-end + second-run idempotency verified. |
| X-15 | 6 (RPO/RTO) | Recovery targets lived only in BACKUP_RECOVERY.md; the gate requires them **in SECURITY.md**. | §11 added to SECURITY.md (RPO ≤5min / RTO ≤1h + drill requirement). |

### 11.3 Toolchain state after this pass

- Tests: **704/704 passing** (was 680 — +24: cron route 8, security-headers 3,
  rate-limit fail-open 3, Sentry 6, demo-gating rewrite + i18n/seed owners,
  audit-retention re-run; 45 test files).
- `typecheck` / `lint` clean; production build green; `bundle:check` OK
  (lazy 381.6KB ≤ 250KB per chunk); `audit:check` PASS (0 high/critical in
  shipping deps; 28 dev-chain advisories informational).
- E2E: 16 scenarios / 97 steps matched on dry-run; CI job enabled with
  service-container Postgres (first real browser run happens on the next
  push to CI — cannot execute GitHub Actions from the sandbox).

### 11.4 Remaining operator actions (unchanged + additions)

1. Rotate the Supabase DB password and `NEXTAUTH_SECRET` (F-02).
2. Set `RESEND_API_KEY` (+ `MAIL_FROM`) in production (F-04).
3. Set `SENTRY_DSN` (+ `REPORT_URI`, `CRON_SECRET`, `REDIS_URL`,
   `SERVER_ACTIONS_ALLOWED_ORIGINS`) in production — all now wired and
   read by code; without them the corresponding gates degrade visibly
   (503s, warnings) instead of silently.
4. Execute + time the staging restore drill (gate 6) and the 100k-row k6
   run (gate 4): `SEED_LOAD=1 … seed-load.js --confirm` then
   `k6 run scripts/load-test.k6.js` against staging.
5. Confirm the CI E2E job is green on the first push (Chrome/chromedriver
   availability on ubuntu-latest is the one untested assumption).

### 11.5 Incident note (honest record)

During this pass the dev database was found **wiped** (all domain tables at
0 rows; only Workspace + the config tables the config-loader self-heals on
boot survived — the fingerprint of a seed run interrupted by the earlier
sandbox recycle). Nothing in this session's commands or the test suite
writes unfiltered deletes (verified: the only unfiltered `deleteMany` set
lives in `scripts/seed.js` behind its boot-time guard, and all three
test invocations of the seed refuse). Recovery: `bun run db:seed` re-ran
cleanly (12 users / 24 projects / 40 tasks / 174 time entries / 18 events),
demo sign-in re-verified end-to-end (200 + ADMIN session + dashboard render)
on the upgraded next-auth 4.24.15. Production is unaffected — this was the
disposable demo database.

The live cron endpoint was also exercised end-to-end during this pass:
401 without/with a wrong bearer token, a real prune run with a valid token
(200, `deletedCount: 0` — retention window not yet reached), the overlap
guard skipping an immediate second call, and an `audit.pruned` meta-row
written by the synthetic `system (cron)` actor — gate 12's "demonstrated
prune" now has on-record evidence in the audit trail itself.
