# Fernly — Testing Guide & Manual Test Plan

## 1. Test pyramid & tooling

| Layer | Tool | Command | Scope & gate |
|-------|------|---------|--------------|
| Unit / integration | Vitest + jsdom | `bun run test` | `src/lib/**`, `src/server-actions/**`, components & views — **1727 tests** (94 files), coverage gate 90% stmts / 80% branches |
| Coverage report | Vitest + v8 | `bun run test:coverage` | HTML report in `coverage/` |
| Browser E2E | Cucumber.js + Selenium | `bun run test:e2e` | login & lockout, RBAC gating, board CRUD, messaging isolation, a11y, HR (leave/directory/reviews/onboarding), hiring pipeline + email outbox + e-sign + payroll runs/payslips + funnel analytics — **89 scenarios / 13 feature files** (see `e2e/README.md`; requires Chrome) |
| Static | ESLint + tsc | `bun run lint` / `bun run typecheck` | zero errors |
| Production | Next build | `bun run build` | must pass with full type checking |
| Production smoke | `bun run test:prodsmoke` | health, headers, CSP shape, credential flow | must pass against a built app |
| Load | k6 + `scripts/load-smoke.mjs` | see `docs/PRODUCTION_READINESS.md` §5 | p95 budgets, incl. 100k-row dataset via `scripts/seed-load.js` |

**Unit-test conventions.** Mocks only at the boundaries (`@/lib/db`,
`better-auth`, `next/cache`) via `vi.hoisted`; the module under test is always real. Security tests use
fixture personas — `ADMIN`, `MANAGER`, `MEMBER`, `HR`, `OTHER_MEMBER` — and must cover the
allow path **and** every deny path. Bug fixes require a regression test that fails on the
pre-fix code.

**What the automated suites cover:** every server action's permission gate, ownership and
scoping rules (incl. all P0/P1 security regressions, row-level task deletion and
role-scoped analytics), the RBAC matrix invariants, the rate limiter, the auth callbacks
(sign-in, throttle, JWT bearer minting/validation, soft-deleted users), zod validation,
the config loader (DB-driven + fallbacks + cache), audit metadata consistency, password
policy, the hierarchy subtree logic, the shared component library and the view layer
(sidebar accordion, project modal, analytics scope selector).

**What they do NOT cover (by design):** pixel layout, drag-and-drop physics, Recharts
rendering, keyboard-shortcut handling — these are covered by the manual plan below and
the Selenium suite where a browser is available.

---

## 2. Manual test plan

Environment: `bun run dev` + seeded database (`bun run db:seed`).
Demo accounts (password = `NEXT_PUBLIC_DEMO_PASSWORD` from `.env` — never a literal
in this repo): `demo@fernly.app` (ADMIN — Mira Hale), `manager@fernly.app`
(MANAGER — Ingrid Solberg; team: Lena, Rafael, + Soren via Lena), `member@fernly.app`
(MEMBER — Theo Vance), `remy@fernly.app` (HR — Remy Laurent), `priya@fernly.app`
(MANAGER — Priya Nair; team: Marcus, Hana), plus MEMBERs `lena@`, `rafael@`, `yuki@`,
`amara@`, `soren@`, `marcus@`, `hana@`, `diego@` (all `@fernly.app`).

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
| TASK-8 | Delete task (row-level) | Delete your own card as MEMBER; delete a foreign unassigned card as MEMBER; delete a subordinate's card as MANAGER | Own card deletes; foreign card rejected ("only the assignee, project owner, an admin, or a covering manager"); subordinate's card deletes for the covering MANAGER |
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
| ANL-1 | Charts render | Open Analytics | Completion/hours trend, hours by project, 13-week activity heatmap and metric cards render without console errors |
| ANL-2 | MEMBER scope forced | As MEMBER, open the scope dropdown next to 7D/30D/90D | Only "Just me" is offered; the server forces self whatever the client sends |
| ANL-3 | MANAGER team default | As `manager@fernly.app`, open Analytics | Default scope = own team (self + reporting subtree); dropdown offers subtree individuals only; Top contributors hides when narrowed to one person |
| ANL-4 | ADMIN everyone | As ADMIN, switch scope to Everyone, then to a manager's team, then to an individual | All three honoured; numbers change accordingly |

### 2.8 HR (HR) — leave / directory / reviews / onboarding

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| HR-1 | Leave request | As MEMBER, request leave from your balance | Balance debits on approval; request appears in approver's queue |
| HR-2 | Chain approval | As `manager@fernly.app` (Ingrid), approve Lena's request; then try Rafael's (also Ingrid's report) — and try Priya's team member (Marcus) | Lena/Rafael approve-able; Marcus is **not** in Ingrid's subtree → rejected |
| HR-3 | HR console gating | Open `G R` as MEMBER | No HR group in sidebar; console unavailable |
| HR-4 | Calendar surfacing | Approve a leave request covering next week | Leave appears on the calendar as a virtual event |
| HR-5 | Directory & reviews | As HR (`remy@`), browse directory, run a review cycle stage, check onboarding progress | All views gated to `hr:*` holders; onboarding checklist progress persists |

### 2.9 Team & messaging (MSG)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| MSG-1 | Directory | Open Team | MEMBER sees only members connected to their projects + self; ADMIN sees all |
| MSG-2 | Send message | Team → Message a member; subject + body | Toast confirmation; thread appears in your inbox (sent) |
| MSG-3 | Recipient inbox | Sign in as recipient → open inbox | Thread shows with unread badge; opening marks read |
| MSG-4 | Privacy | Sign in as a third member | The thread from MSG-2 is invisible in their inbox |
| MSG-5 | Reply | Reply from the thread view | Message joins the same thread (no crash — regression for the `members` bug) |
| MSG-6 | Delete message | Delete a message you sent | Removed; a third party attempting deletion via console is rejected |
| MSG-7 | Mark-thread-read scope | As third party, call `markThreadRead` on someone's thread via console | No rows change (WHERE recipientUserId guards) |

### 2.10 Users administration (USR) — ADMIN only

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

### 2.11 Workspace settings (WS) — ADMIN only

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| WS-1 | General settings | Change workspace name, defaults | Persist across reload; audit shows `workspace.updated` |
| WS-2 | Security tab | Raise minimum password length to 12 | USR-3 message reflects 12 |
| WS-3 | Domain enums | Add a custom task status (e.g. BLOCKED); reload Tasks | New status available in modal select |
| WS-4 | Delete config item | Remove the custom status | Disappears after cache invalidation |
| WS-5 | Role matrix | Edit MANAGER description + toggle a permission | Label updates; a signed-in MANAGER sees the change apply within the 60 s cache window (no re-login) |
| WS-6 | System role guard | Attempt to delete the ADMIN role | Rejected: system role |
| WS-7 | In-use role guard | Create a role, assign nothing, delete → then assign a user and retry | Empty role deletes; in-use role refuses with user count |

### 2.12 Audit log (AUD)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| AUD-1 | Coverage | Perform one of each mutation | Each appears with correct action name, entity badge, actor, timestamp |
| AUD-2 | Filters | Filter by Tasks / Projects / People / Calendar / Messages / Other | Correct entity subsets; WORKSPACE & CONFIG changes land in "Other" |
| AUD-3 | Entity history | Open a task's edit modal → expand history | Last ≤ 50 entries for that task only |
| AUD-4 | Access control | MEMBER calls `getAuditLogs` in console | Rejected (audit:view required) |

### 2.13 Hiring pipeline (HIRE) — Recruitment R1 (docs/RECRUITMENT_MODULE_PLAN.md)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| HIRE-1 | Board renders (HR) | Sign in as `remy@fernly.app` → Hiring (`G I`) | Columns for every seeded active stage; candidate cards sit at their current stage; counts per column |
| HIRE-2 | MEMBER gated | Sign in as `member@fernly.app` | No "Hiring" nav item at all (HR group hidden); `G I` does nothing |
| HIRE-3 | MANAGER view-only | Sign in as `manager@fernly.app` → Hiring | Board visible with "interviewer view" hint; no Add-candidate / Stages controls |
| HIRE-4 | Add candidate | HR → Add candidate → fill the form | Card appears in the first column; detail shows the full template timeline; audit entry "hiring.candidate_created" |
| HIRE-5 | Advance stage | Open a candidate → "Pass <stage>" | Current stage PASSED with date; next stage IN_PROGRESS; card moves column |
| HIRE-6 | Skip / fail stage | Skip an upcoming stage; mark another failed | Stage SKIPPED/FAILED; card reflects the next open stage; audit entries written |
| HIRE-7 | Reject needs a reason | Reject with an empty reason, then with one | Empty reason blocked; with a reason the card leaves the board, appears under the Rejected filter with the reason shown |
| HIRE-8 | Withdraw / reactivate | Withdraw a candidate, then reactivate | Status flips; reactivated candidate returns to the board at its last stage |
| HIRE-9 | Template edit is non-destructive | Stages editor → rename a stage → open an existing candidate | Template renamed; the existing candidate's timeline keeps the OLD snapshotted label |
| HIRE-10 | Config gating | As MANAGER open Hiring | "Stages" editor button hidden (no `hiring:config`) |

| HIRE-11 | Schedule interview | HR → open a candidate at an INTERVIEW stage → Schedule → pick date + interviewer | Calendar shows "Interview: <name> — <stage>"; the interviewer's dashboard reminder appears; the stage shows the scheduled chip |
| HIRE-12 | Double-booking refused | Schedule the same interviewer twice within the same hour | Second attempt refused with a naming conflict message; no second calendar event |
| HIRE-13 | Scorecard (interviewer) | Sign in as the assigned interviewer (manager@fernly.app) → Hiring → open the candidate → Fill scorecard | Rating 1–5, strengths, concerns, recommendation save and render read-only; HR sees them too |
| HIRE-14 | My interviews panel | Sign in as manager@fernly.app → Hiring | "Your upcoming interviews" panel lists assigned stages with dates; hidden when empty |
| HIRE-15 | Rejection toast tells the mail truth (P0-6/D-05) | HR → open an ACTIVE candidate → Reject → reason → "Email the candidate" ON → Confirm | Toast mirrors the outbox row: SENT → success "sent and recorded in the outbox"; no provider → warning "NOT delivered … Recorded as skipped"; provider error → error "FAILED to send — see the outbox". Without the toggle: plain "Candidate rejected." — never a delivery claim |
| HIRE-16 | Duplicate email blocked per day (P0-6/D-18) | HR → reject+email a candidate; reactivate; reject+email again the same day | Second send BLOCKED with "A rejection email was already sent to <name> today … Uncheck 'Email the candidate' …"; the candidate stays ACTIVE (no half-applied decision); unchecking the toggle and confirming succeeds |
| HIRE-17 | Mail-config warning banners (P0-6) | (no `RESEND_API_KEY`) HR → Hiring; ADMIN → Workspace Config → General | Amber banner above the outbox: "Email delivery is off — … (set RESEND_API_KEY)"; same guidance in the settings General tab; both disappear once a provider is configured |
| HIRE-18 | Member-interviewer self-service (P0-5/D-04) | HR → open a candidate at an INTERVIEW stage → Schedule → pick a MEMBER (e.g. Theo Vance) as interviewer → Confirm; sign in as that member | The member's sidebar shows "My Interviews" (People group) and NEVER "Hiring"; the view lists the assigned stage with candidate name, stage label and slot; the empty state explains the assignment rule when nothing is assigned |
| HIRE-19 | Member scorecard (P0-5/D-04) | As the assigned MEMBER interviewer → My Interviews → Fill scorecard (rating, recommendation, strengths, concerns, remarks) → Save | Scorecard saves server-side (only the assigned interviewer or HR/admin may write it — a non-assigned member is refused with "Only the assigned interviewer…"); the saved card renders read-only in the member's list; HR sees it on the candidate timeline too |
| HIRE-20 | Member stays off the board (P0-5/D-04) | As the assigned MEMBER interviewer try to reach hiring surfaces (nav, G I, /hiring data) | The Hiring leaf and G I shortcut do nothing for MEMBER (no hiring:view); getHiringBoard/outbox/offers all refuse; the member only ever sees their own assignments |

### 2.14 Personalisation & UX (UX)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| UX-1 | Accent themes | Switch forest/ocean/plum/ember | Applied instantly, persisted **per account** (survives reload, re-login and another browser — PR-65) |
| UX-2 | Dark mode | Toggle in topbar | Persists per account; no flash on reload (applied pre-hydration) |
| UX-3 | Notification prefs | Toggle the six switches | Persisted server-side |
| UX-4 | Command palette | `⌘K`/`Ctrl K` | Opens; search jumps to views/actions |
| UX-5 | Shortcuts | `G D/A/P/T/B/M/C/V` (+ `G R/U/W/L/S/H` where permitted) and `?` overlay | Each navigates / opens overlay |
| UX-6 | Profile drawer | Edit name/bio/avatar color | Saved; reflected in topbar |
| UX-7 | Responsive | Narrow to mobile width | Login and dashboard remain usable (see mobile screenshots) |
| UX-8 | Sidebar accordion | Expand a nav group, then another | Only one group open at a time; the previous collapses; reloading keeps the current view's group expanded; the icon-rail toggle is remembered |
| UX-9 | Project detail modal | Open a project card | Wide modal; Members + History collapsed by default, expandable; roster shows staffing count |

### 2.15 Regression pack (run after any security-touching change)

AUTH-5, AUTH-10, RBAC-6, RBAC-7, TASK-8/10, ANL-2/3/4, HR-2/3, MSG-4/6/7, USR-8,
AUD-4 — these mirror the automated security suite; they exist as manual steps for
environments without the test runner.

---

## 3. Coverage snapshot (2026-11-04, PR-65)

```
Gated layers (src/lib + src/server-actions):
  100.0% statements (3397/3397) · 91.6% branches (2419/2641)
  src/lib:             100% stmts · 93.0% branches
  src/server-actions:  100% stmts · 91.2% branches
Highlights at 100%: rbac, rate-limit, audit-meta, auth-guard, users,
reminders, events, notifications, validation, pii, time
```

Gates (90/80/85/90) enforced in `vitest.config.ts` — `bun run test:coverage` fails the
build if any gate regresses.
