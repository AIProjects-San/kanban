# Fernly — Testing Guide & Manual Test Plan

## 1. Test pyramid & tooling

| Layer | Tool | Command | Scope & gate |
|-------|------|---------|--------------|
| Unit / integration | Vitest + jsdom | `bun run test` | `src/lib/**`, `src/server-actions/**`, shared components — **271 tests**, coverage gate 90% stmts / 80% branches |
| Coverage report | Vitest + v8 | `bun run test:coverage` | HTML report in `coverage/` |
| Browser E2E | Cucumber.js + Selenium | `bun run test:e2e` | login, brute-force lockout, RBAC UI gating, board CRUD, messaging isolation (see `e2e/README.md`; requires Chrome) |
| Static | ESLint + tsc | `bun run lint` / `bun run typecheck` | zero errors |
| Production | Next build | `bun run build` | must pass with full type checking |

**Unit-test conventions.** Mocks only at the boundaries (`@/lib/db`, `next-auth`,
`next/cache`) via `vi.hoisted`; the module under test is always real. Security tests use
four fixture personas — `ADMIN`, `MANAGER`, `MEMBER`, `OTHER_MEMBER` — and must cover the
allow path **and** every deny path. Bug fixes require a regression test that fails on the
pre-fix code.

**What the automated suites cover:** every server action's permission gate, ownership and
scoping rules (incl. all P0/P1 security regressions), the RBAC matrix invariants, the
rate limiter, the auth callbacks (sign-in, throttle, JWT role refresh, deleted users),
zod validation, the config loader (DB-driven + fallbacks + cache), audit metadata
consistency, password policy, and the shared component library.

**What they do NOT cover (by design):** pixel layout, drag-and-drop physics, Recharts
rendering, keyboard-shortcut handling — these are covered by the manual plan below and
the Selenium suite where a browser is available.

---

## 2. Manual test plan

Environment: `bun run dev` + seeded database (`bun run db:seed`).
Demo accounts (password = `NEXT_PUBLIC_DEMO_PASSWORD` from `.env` — never a literal
in this repo): `demo@fernly.app` (ADMIN), `manager@fernly.app`
(MANAGER), `member@fernly.app` (MEMBER), plus `maya@`, `lena@`, `oliver@`, `priya@`,
`jack@`, `aria@`, `elena@`, `marcus@`, `nina@` (MEMBERs).

Execute each group per persona. ✅ = pass criterion.

### 2.1 Authentication (AUTH)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| AUTH-1 | Valid login | Sign in as `demo@fernly.app` / `NEXT_PUBLIC_DEMO_PASSWORD` (`.env`) | Dashboard renders; sidebar shows all items incl. Users, Audit, Workspace Settings |
| AUTH-2 | Wrong password | `demo@fernly.app` / `wrong` | Stays on login; no app shell; no user enumeration hint |
| AUTH-3 | Unknown email | `ghost@fernly.app` / `whatever` | Same failure appearance and (roughly) same delay as AUTH-2 |
| AUTH-4 | Empty fields | Submit with blank email/password | No request loop; form stays |
| AUTH-5 | Brute-force lockout | 5 wrong passwords as `member@fernly.app`, then the CORRECT password | 6th attempt rejected (throttle); works again after 15 min or server restart |
| AUTH-6 | Session persistence | Reload the page | Still signed in; theme/accent preserved |
| AUTH-7 | Sign out & back | Sign out (avatar menu), revisit `/` | Login screen; previous session cookie invalid |
| AUTH-8 | Password change | Settings → Security → change password (wrong current → then correct) | Wrong current rejected with message; correct change succeeds; new password works after re-login |
| AUTH-9 | Password policy | Try setting a password shorter than the workspace minimum (Workspace Settings → set minimum 12 first) | Rejected with "at least 12 characters" |
| AUTH-10 | Role demotion freshness | As ADMIN demote a signed-in MANAGER to MEMBER; within ~5 min that user reloads | Admin-only UI disappears for them without re-login |

### 2.2 RBAC & scoping (RBAC)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| RBAC-1 | Sidebar by role | Compare sidebars: ADMIN / MANAGER / MEMBER | MEMBER: no Users, no Audit, no Workspace Settings. MANAGER: no Users, no Workspace Settings, but Audit visible |
| RBAC-2 | MEMBER project button | Projects view as MEMBER | No "Add Project" button |
| RBAC-3 | MANAGER project button | Projects view as MANAGER | "Add Project" visible; project delete absent |
| RBAC-4 | Scoping | As `member@fernly.app`, count projects/tasks; sign in as ADMIN and compare | MEMBER sees strictly fewer projects/tasks (own + assigned only) |
| RBAC-5 | Task edit gating (UI) | As MEMBER open someone else's task modal | Edit affordances unavailable (or save rejected with permission message) |
| RBAC-6 | Task edit gating (API) | As MEMBER, browser console: call `updateTask` on a foreign task id | Server rejects: "You can only edit tasks that are assigned to you" |
| RBAC-7 | Privilege escalation attempt | As MEMBER, call `getDashboardData()` from console | Returns only scoped data — never the full workspace |
| RBAC-8 | Permission matrix editing | Workspace Settings → Permissions; toggle a MEMBER permission; test as MEMBER | Change applies after cache bump (≤ 60 s + revalidate) |
| RBAC-9 | Self-demotion guard | Users page: try to change your own role away from ADMIN | Rejected with "Ask another admin" |
| RBAC-10 | Self-delete guard | Users page: try to delete your own account | Rejected |

### 2.3 Dashboard (DASH)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| DASH-1 | Stats accuracy | Compare KPI cards with seeded data | Total/Running/Pending/Paused/Ended match; weekly completion counts only tasks completed in the last 7 days |
| DASH-2 | Reminders personal | Create a reminder as MEMBER; sign in as MANAGER | Reminder invisible to MANAGER; visible to its creator |
| DASH-3 | Reminders workspace-wide | Legacy seeded reminders (ownerless) | Visible to everyone |
| DASH-4 | Reminder toggle ownership | As MANAGER attempt to toggle MEMBER's personal reminder (via console) | Rejected |
| DASH-5 | Notifications feed | Mark one/all read | Unread badge decrements; list persists across reload |
| DASH-6 | Timezone greeting | Set timezone to Pacific/Auckland vs Europe/London around midnight UTC | Greeting and "today" date match the selected zone |

### 2.4 Tasks / Kanban (TASK)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| TASK-1 | Create task | New Task → title only → save | Card appears in "To do" |
| TASK-2 | Validation | Try to save an empty/whitespace title | Blocked client-side; server also rejects (belt & braces) |
| TASK-3 | Full-field create | All fields + project + assignee | Card shows correct tag/priority chips; assignee avatar appears |
| TASK-4 | Assignee restriction | Choose a project, open assignee dropdown | Only people allocated to that project are listed |
| TASK-5 | Drag & drop | Move a card To do → In progress → Done | Column placement persists after reload; order within column preserved |
| TASK-6 | Edit task | Change title/status/priority/due date/assignee | Changes persist; entity history (expand in edit modal) lists the changed fields |
| TASK-7 | Reassign recalc | Move a task to another assignee | Both members' workload stats update (open/completed/workload) |
| TASK-8 | Delete task | Delete a card (ADMIN or permitted role) | Card disappears; audit entry written |
| TASK-9 | Filters & search | Filter by project, status, priority; search title | Combined filters apply correctly; MEMBER's project filter only lists scoped projects |
| TASK-10 | Own-task edit rule | As MEMBER drag your own card; then attempt a foreign card via console | Own card moves; foreign card rejected |

### 2.5 Projects (PROJ)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| PROJ-1 | Create (MANAGER) | Add project with color/owner/due date | Card appears with correct badge + progress |
| PROJ-2 | Edit | Change status Running → Paused | Badge updates; audit entry |
| PROJ-3 | Delete (ADMIN) | Delete a project that has tasks | Tasks survive unassigned (project cleared); assignments removed |
| PROJ-4 | Assignments modal | Users → assign a user to 2 projects; check their scoped view | Their project list grows accordingly |
| PROJ-5 | Progress + due date | Set progress 80% and a past due date | Progress bar and overdue styling render |

### 2.6 Calendar (CAL)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| CAL-1 | Month navigation | ‹ › through months | Grid and events shift; today highlighted |
| CAL-2 | Create event | Add a Meeting with time/duration/location | Dot-coded event appears on the right day |
| CAL-3 | Event types | Create one of each type | Legend colors match chips |
| CAL-4 | Delete event | Delete an event | Removed from grid; audit entry |

### 2.7 Analytics (ANL)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| ANL-1 | Charts render | Open Analytics | Completion trend, workload, progress and time charts render without console errors |
| ANL-2 | Scoped data | Compare as MEMBER vs ADMIN | MEMBER's charts derive only from scoped data |

### 2.8 Team & messaging (MSG)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| MSG-1 | Directory | Open Team | MEMBER sees only members connected to their projects + self; ADMIN sees all |
| MSG-2 | Send message | Team → Message a member; subject + body | Toast confirmation; thread appears in your inbox (sent) |
| MSG-3 | Recipient inbox | Sign in as recipient → open inbox | Thread shows with unread badge; opening marks read |
| MSG-4 | Privacy | Sign in as a third member | The thread from MSG-2 is invisible in their inbox |
| MSG-5 | Reply | Reply from the thread view | Message joins the same thread (no crash — regression for the `members` bug) |
| MSG-6 | Delete message | Delete a message you sent | Removed; a third party attempting deletion via console is rejected |
| MSG-7 | Mark-thread-read scope | As third party, call `markThreadRead` on someone's thread via console | No rows change (WHERE recipientUserId guards) |

### 2.9 Users administration (USR) — ADMIN only

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| USR-1 | Create user | Users → New User (name, email, strong password, role, timezone, department, job title) | Login created AND directory entry appears (single action) |
| USR-2 | Duplicate email | Create the same email twice | Rejected: "already exists" |
| USR-3 | Password policy | Try a below-minimum password | Rejected with the workspace minimum in the message |
| USR-4 | Edit user | Change name/role/avatar; sync to Team page | Directory reflects changes |
| USR-5 | Reset password | Reset a user's password; sign in with it | Works; audit shows "password" among changes |
| USR-6 | Delete user | Delete a non-admin user | Account + assignments gone; their tasks become unassigned |
| USR-7 | Assignment modal | Toggle project memberships | Changes reflected in the user's scoped view immediately |
| USR-8 | Access control | Open `/` as MANAGER, try `G U` / call `getAllUsers` in console | Users view unavailable; console call rejected |

### 2.10 Workspace settings (WS) — ADMIN only

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| WS-1 | General settings | Change workspace name, defaults | Persist across reload; audit shows `workspace.updated` |
| WS-2 | Security tab | Raise minimum password length to 12 | USR-3 message reflects 12 |
| WS-3 | Domain enums | Add a custom task status (e.g. BLOCKED); reload Tasks | New status available in modal select |
| WS-4 | Delete config item | Remove the custom status | Disappears after cache invalidation |
| WS-5 | Role matrix | Edit MANAGER description + toggle a permission | Label updates; permission change effective ≤ 60 s |
| WS-6 | System role guard | Attempt to delete the ADMIN role | Rejected: system role |
| WS-7 | In-use role guard | Create a role, assign nothing, delete → then assign a user and retry | Empty role deletes; in-use role refuses with user count |

### 2.11 Audit log (AUD)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| AUD-1 | Coverage | Perform one of each mutation | Each appears with correct action name, entity badge, actor, timestamp |
| AUD-2 | Filters | Filter by Tasks / Projects / People / Calendar / Messages / Other | Correct entity subsets; WORKSPACE & CONFIG changes land in "Other" |
| AUD-3 | Entity history | Open a task's edit modal → expand history | Last ≤ 50 entries for that task only |
| AUD-4 | Access control | MEMBER calls `getAuditLogs` in console | Rejected (audit:view required) |

### 2.12 Personalisation & UX (UX)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| UX-1 | Accent themes | Switch forest/ocean/plum/ember | Applied instantly, persisted per-user (survives reload & re-login) |
| UX-2 | Dark mode | Toggle in topbar | Persists; no flash on reload (applied pre-hydration) |
| UX-3 | Notification prefs | Toggle the six switches | Persisted server-side |
| UX-4 | Command palette | `⌘K`/`Ctrl K` | Opens; search jumps to views/actions |
| UX-5 | Shortcuts | `G D/T/P/C/A/E` and `?` overlay | Each navigates / opens overlay |
| UX-6 | Profile drawer | Edit name/bio/avatar color | Saved; reflected in topbar |
| UX-7 | Responsive | Narrow to mobile width | Login and dashboard remain usable (see mobile screenshots) |

### 2.7 Regression pack (run after any security-touching change)

AUTH-5, AUTH-10, RBAC-6, RBAC-7, DASH-2/3/4, TASK-10, MSG-4/6/7, USR-8, AUD-4 — these
mirror the automated security suite; they exist as manual steps for environments without
the test runner.

---

## 3. Coverage snapshot (2026-10-29)

```
All files (src/lib + src/server-actions):  95.7% statements · 87.9% branches
                                           98.5% functions  · 99.4% lines
data.ts        94.8% stmts / 100% lines      auth.ts        94.6% stmts
config-loader  100%                           rbac/rate-limit/config/audit-meta 100%
```

Gates (90/80/85/90) enforced in `vitest.config.ts` — `bun run test:coverage` fails the
build if any gate regresses.
