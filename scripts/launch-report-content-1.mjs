// ---------------------------------------------------------------------------
// Fernly Launch-Readiness Audit — content module 1/2
// Meta + Executive Summary + Scope + Part 1 domains 1-9.
// All facts verified against the codebase on 2026-10-30. No fabricated metrics.
// ---------------------------------------------------------------------------

export const META = {
  title: "Fernly Launch Readiness Audit",
  subtitle: "Engineering audit for a 100,000-user launch",
  englishLabel: "STAFF ENGINEERING AUDIT",
  metaLines: [
    "Prepared by: Staff Full-Stack Engineering",
    "Subject: Fernly v1.0.0 - Next.js 16 App Router, Prisma 6, NextAuth v4, PostgreSQL (Supabase)",
    "Date: 30 October 2026",
    "Classification: Internal - Launch Planning",
  ],
  footerLeft: "Fernly Engineering",
  footerRight: "October 2026",
  headerText: "Fernly Launch-Readiness Audit",
};

export const EXEC = {
  verdictLead:
    "Verdict: Fernly is NOT launch-ready for 100,000 users today. The codebase is unusually well-engineered for its stage - the security architecture, test discipline, and documentation are genuinely strong - but it currently serves a single shared workspace with unbounded queries, has two correctness bugs that break core UX (mutations never refresh the screen; the message read/unread model is wrong for recipients), and ships several features that look functional but are not wired to enforcement. A conditional GO is achievable by month end if and only if the sixteen P0 items in Part 2 close by day 14.",
  ragIntro:
    "The table below summarises readiness across six dimensions. Green means fit for the stated load after routine work; amber means material gaps that are cheap to close; red means the dimension as built cannot serve the stated load without rework.",
  ragTable: {
    headers: ["Dimension", "Rating", "One-line justification"],
    widths: [22, 12, 66],
    rows: [
      ["Security architecture", "AMBER", "Server-side permission gates, stable-id identity, audit trail and 322 regression tests are strong; but no session revocation, per-instance rate limiter, CSP with unsafe-inline, and no mail/reset flow."],
      ["Data integrity", "RED", "Deletes orphan rows by design (SetNull everywhere), Message/Reminder carry no foreign keys, schema is managed with db push --accept-data-loss (no migrations), Task/TimeEntry/Project have zero indexes."],
      ["Scalability", "RED", "Single shared workspace for all users, every list query unbounded (7 of 8 loader queries have no take), no pagination anywhere, single app instance, in-memory limiter and config cache."],
      ["UX correctness", "RED", "No router.refresh anywhere - every mutation leaves stale props (Kanban drag reverts); no error.tsx/global-error; recipients never see unread badges for real messages."],
      ["Engineering quality", "GREEN", "Strict TypeScript (noImplicitAny on), 322 tests at ~95% statement coverage on the core, CI, pre-commit hook, six documentation files, disciplined action-result pattern."],
      ["Operability", "RED", "No health endpoint (placeholder returns Hello world), no error tracking, no metrics, no backup/DR runbook, no load testing, deployment is one Caddyfile and a start script."],
    ],
  },
  blockersIntro:
    "The five findings below individually justify a no-go if left unfixed. Each is expanded, with file-level evidence, in Part 1.",
  blockers: [
    "1. Mutations never refresh the UI. There is not a single router.refresh() call in the codebase; bumpRefresh() only remounts views with the same stale server props. A dragged Kanban card snaps back to its original column; created items are invisible until a full page reload. (src/store/app-store.ts, src/components/views/tasks-view.tsx lines 75-106)",
    "2. The messaging data model is wrong for recipients. Message.direction is stored from the sender's perspective but read from the current user's perspective, and one row with a global read flag is shared by both parties. Real messages sent through the UI (direction OUT, read true) never appear as unread for recipients, render on the wrong side of the thread, and markThreadRead can never match them (it requires direction IN). Only seeded demo rows work. (src/server-actions/messages.ts, src/components/fernly/inbox-drawer.tsx)",
    "3. Unbounded single-workspace queries with no indexes. getDashboardData runs 8 parallel findMany calls, 7 of them with no take; tasks each embed a full project and assignee object. Task, TimeEntry and Project tables have zero secondary indexes, so every scoped query is a sequential scan. In one shared workspace at 100k users this is a payload and latency bomb. (src/server-actions/dashboard.ts, prisma/schema.prisma)",
    "4. No error boundaries. src/app contains only page.tsx, layout.tsx and the api directory - no error.tsx, global-error.tsx, not-found.tsx or loading.tsx. Any uncaught render error shows the raw Next.js error page; the deliberate throwing contract of getDashboardData has no boundary to catch it. (src/app/)",
    "5. The roles editor is write-only theater. Workspace Config lets admins toggle permissions per role and persists RolePermission rows, but every server action enforces via the static matrix in lib/rbac.ts. The DB-driven check hasPermissionDb exists, is unit-tested, and is called by zero production code paths. Admins can 'revoke' a permission and nothing changes. (src/lib/config-loader.ts lines 340-348, src/server-actions/auth-guard.ts)",
  ],
};

export const SCOPE = {
  lead:
    "This audit was performed as a full read of the working tree at commit state 2026-10-30 (post the reporting-hierarchy pass), not a spot check. The method and evidence conventions are stated below so every claim can be re-verified.",
  methodPoints: [
    "Line-by-line static read of all 40+ components under src/components, all 15 server-action modules, all 13 lib modules, the proxy, the auth route wrapper, prisma/schema.prisma, next.config.ts, package.json, and the CI workflow.",
    "Runtime verification against the live dev server: real sign-in, sign-out cookie clearing, command palette, member modal, users view hierarchy rendering, and the Kanban drag path.",
    "Review of the 322-test suite (20 files) and its coverage gates (90% statements / 80% branches over lib + server-actions), plus the disabled E2E scaffold.",
    "Dependency and infrastructure inspection: unused dependencies, prisma/ contents, .githooks, .github/workflows/ci.yml, Caddyfile, and the standalone build scripts.",
  ],
  outOfScope: [
    "Commercial plan, pricing, and marketing.",
    "Legal entity, tax, and data-processing agreements.",
    "Third-party SaaS billing integration.",
    "Any rewrite of the demo dataset (seed data quality is treated as a launch-gating item, not an audit subject).",
  ],
  convention:
    "Evidence convention: every weakness in Part 1 cites the file (and line where useful) that exhibits it; every correction names the concrete change. Quantitative statements are either measured from the code (query counts, permission counts, test counts) or clearly labelled as order-of-magnitude estimates. No metrics are invented.",
};

// ---------------------------------------------------------------------------
// PART 1 — domains 1-9
// Each domain: lead (verdict paragraph), strengths[], weaknesses[],
// fixes[] (each fix starts with the target file).
// ---------------------------------------------------------------------------

export const DOMAINS_A = [
  {
    num: "1.1",
    title: "Architecture & Data Flow",
    lead: "Fernly is a single-route SPA: one server component (src/app/page.tsx) loads the entire workspace into props and a client shell swaps views via Zustand. This is coherent and fast to build, but it couples every view to one monolithic payload and makes per-view caching, streaming, or pagination impossible without rework.",
    strengths: [
      "Single loader (getDashboardData) keeps one round trip per page render; the 8 main queries run in one Promise.all, so server time is roughly one DB RTT for the batch.",
      "Session-derived scoping only - the loader never trusts client arguments (the original P0-1 class of bug is closed and regression-tested).",
      "Server actions are split into 13 domain modules with a non-use-server barrel, keeping the server-action surface explicit.",
    ],
    weaknesses: [
      "One workspace for everyone. The Workspace table exists (single 'default' row) but no domain table carries a workspaceId, so there is no tenancy boundary of any kind. 100k users means one giant org, not 200-500 person teams.",
      "The initial payload is the whole workspace: all projects, all tasks (each embedding its project and assignee objects), all members, all time entries, all events, and all of the user's messages - only notifications are capped (take 20).",
      "All views and heavy libraries (Recharts, @dnd-kit) are statically imported in AppShell; there is no per-view code splitting, so the initial JS bundle ships every screen to every user.",
      "force-dynamic with no Suspense boundaries: nothing streams, so a slow first query blocks the entire document.",
    ],
    fixes: [
      "Adopt a data-refresh contract now (W1): every mutation path calls router.refresh() after its action resolves, or views switch to useTransition-wrapped actions. This is the single highest-leverage UX fix in the codebase.",
      "Introduce pagination and server-side search for every list (users, tasks, projects, time entries) with cursor pagination in Prisma; keep the dashboard loader for aggregates only (counts and top-N), not full rows.",
      "Lazy-load AnalyticsView (Recharts) and CalendarView via next/dynamic; measure and set a JS budget (suggested first target: under 200KB gzipped initial route JS).",
      "Decide the tenancy answer explicitly. Either add workspaceId to all domain tables with row scoping (weeks of work), or cap org size in the commercial model and say so. Do not launch 100k users into one shared workspace on the current model.",
    ],
  },
  {
    num: "1.2",
    title: "Authentication & Session Management",
    lead: "The credential auth core is solid - brute-force throttling, timing mitigation, a boot-time secret guard, secure cookies, and self-healing stale cookies via the proxy. What is missing at 100k users is account lifecycle: no self-service reset, no email verification, and no way to invalidate a stolen session.",
    strengths: [
      "Sliding-window login limiter (5 per 15 min per email AND per IP) with per-email reset on success; unit-tested including window expiry.",
      "Unknown emails burn a dummy bcrypt compare; the signing secret refuses weak values in production and falls back to an ephemeral random in dev.",
      "Cookie hygiene is genuinely good: httpOnly + lax + secure-in-prod, the proxy strips undecryptable session cookies before render, and the wrapped signout route expires all six auth-cookie namespaces with an auth.signed_out audit row.",
      "The JWT callback re-reads the role from the DB every 5 minutes, so demotions and deletions take effect without waiting 30 days.",
    ],
    weaknesses: [
      "No session revocation. Tokens are valid for 30 days; changePassword does not rotate or version the token, so a stolen cookie survives a password change. There is no force-logout, no session list, no tokenVersion field.",
      "No mail service exists at all, so there is no self-service password reset, no email verification, and the notifEmail preferences in settings are cosmetic. At 100k users this is a support-ticket avalanche.",
      "The timing mitigation uses a cost-10 dummy hash while real hashes are cost 12, so unknown-email responses are measurably faster than wrong-password responses; the enumeration signal is reduced, not removed. (src/lib/auth.ts line 123 vs src/lib/password.ts)",
      "The limiter is per-process in memory: it resets on deploy and does not share state across instances, and the per-IP bucket will lock out whole offices behind corporate NATs.",
      "bcryptjs is pure JavaScript: a cost-12 compare blocks the Node event loop for roughly a quarter second per attempt. Under a credential-stuffing burst this serialises the whole server.",
    ],
    fixes: [
      "Add User.tokenVersion (int, default 0); increment it on password change and role change; reject tokens with a stale version in the jwt callback. This is a half-day change that closes the revocation gap.",
      "Stand up a transactional mail provider, then ship self-service reset (time-boxed, single-use tokens) and email verification. Gate email-required features on verified status.",
      "Move the dummy bcrypt hash to cost 12 to match production hashing, or better: move all compares to a worker thread / native bcrypt so the event loop never blocks.",
      "Replace the in-memory limiter with Redis (or Upstash) with the same semantics, and add progressive delay plus a CAPTCHA after repeated failures.",
    ],
  },
  {
    num: "1.3",
    title: "Authorization: RBAC + Reporting Hierarchy",
    lead: "The authorization model is the strongest part of the codebase: 18 permissions across 3 roles, enforced server-side on every action, with a manager-subordinate tree (managerId) and cycle prevention layered on top, all covered by dedicated regression tests. Its one systemic flaw is that the admin-editable half is not connected to the enforced half.",
    strengths: [
      "Every mutating action calls requirePermission / requirePermissionForTarget; ownership rules are enforced with stable ids, never names (the historical P0 class is closed and tested).",
      "The hierarchy layer (lib/hierarchy.ts) is well-bounded: 32-hop manager chains, 1000-node subtrees, assertNoCycle rejects self-reference and cycles before write, and a legacy escape hatch covers pre-hierarchy users.",
      "Task edit rights combine task:edit:any with a task:edit:own ownership check resolved through TeamMember.userId; message and notification mutations are scoped to the recipient.",
      "322 tests cover the pure predicates, the guard integration paths, and the historical security regressions.",
    ],
    weaknesses: [
      "DB-backed RBAC is dead config. The roles editor writes RolePermission rows, but hasPermissionDb (config-loader lines 340-348) is never called by a server action; enforcement reads the static ROLE_PERMISSIONS matrix. Edits silently do nothing.",
      "The permission matrix in UsersView and the roles editor in Workspace Config can therefore disagree with reality, which is worse than not having the feature - it trains admins to distrust the UI.",
      "Keyboard shortcuts bypass the permission layer: the G-prefix map includes u, w and l for every user, so a MEMBER pressing G U navigates to the users view, fires getAllUsers, and gets a raw auth error toast. Same for G W and G L. (src/hooks/use-keyboard-shortcuts.ts lines 65-77)",
      "requirePermissionForTarget currently only matters for role:manage (ADMIN-only), so the hierarchy layer is exercised in production by almost no call path; it is infrastructure ahead of its use.",
    ],
    fixes: [
      "Wire enforcement to the DB (or delete the editor). Recommended: requirePermission resolves through a cached hasPermissionDb (60s TTL, same cache the config loader already has), with the static matrix kept as the compile-time floor. Ship this or remove the roles editor - do not ship the disconnect.",
      "Gate the G-prefix shortcut map by the same hasPermission calls the sidebar uses; unmapped keys should no-op.",
      "Add an E2E case per role asserting the visible nav equals the permitted nav, so future drift fails CI.",
    ],
  },
  {
    num: "1.4",
    title: "Data Model & Integrity (Prisma)",
    lead: "The schema is readable and the identity links introduced in earlier passes (ownerUserId, TeamMember.userId, recipientUserId routing) are the right shape. But the model has no defensive depth: deletes orphan rows, three tables have zero indexes, two tables fake their relations with strings, and there is no migration history at all.",
    strengths: [
      "Stable-id identity links are consistently authoritative; ownerName is documented as display-only.",
      "ProjectAssignment carries a compound unique plus indexes on both sides; Message has indexes on threadId/direction/sender/recipient; Notification indexes (recipientUserId, read).",
      "Per-user notification routing (null recipient = broadcast) is modelled explicitly and enforced in queries.",
    ],
    weaknesses: [
      "Task, TimeEntry and Project have no secondary indexes at all. Every scoped query on them is a sequential scan; at six-figure row counts this alone caps the ceiling of the whole product. (prisma/schema.prisma)",
      "Message.senderUserId/recipientUserId are plain strings with default '' - no relation, no FK, no cascade; deleting a user leaves dangling ids. Reminder.ownerId is the same. CalendarEvent has no owner relation whatsoever, so any user sees every event.",
      "Deletes orphan by design: deleteProject SetNulls Task.projectId (tasks linger with no project), deleteUser leaves the TeamMember roster row alive as a ghost, and time entries outlive their projects.",
      "User.role defaults to 'Project Lead', which is not ADMIN/MANAGER/MEMBER; isValidRole rejects it and the session downgrades to MEMBER, so any raw-inserted user carries a garbage role string that RoleBadge renders literally.",
      "Schema is managed with prisma db push --accept-data-loss; prisma/ contains no migrations directory. There is no schema version history, no rollback, and the flag invites data loss on the production database.",
      "TeamMember.role means job title while User.role means RBAC role - one word, two meanings, and a documented source of confusion.",
    ],
    fixes: [
      "Add indexes in W1: Task(projectId), Task(assigneeId), Task(status), TimeEntry(memberId), TimeEntry(projectId), TimeEntry(date), Project(ownerUserId), Project(status). This is one migration and the highest performance ROI in the report.",
      "Convert Message and Reminder to real relations with onDelete rules; give CalendarEvent an ownerUserId relation.",
      "Adopt prisma migrate: generate the baseline migration from the current schema, commit it, and change db:push in package.json to migrate deploy. Delete --accept-data-loss from anything that can touch production.",
      "Change User.role default to 'MEMBER' in schema.prisma; add a CHECK constraint or app-level guard so only the three canonical values persist.",
      "Rework delete semantics: soft-delete (deletedAt) for projects, users and messages, with a scheduled purge; or at minimum warn and cascade explicitly (deleteProject should offer to move or delete its tasks rather than silently detaching them).",
    ],
  },
  {
    num: "1.5",
    title: "Dashboard & Data Loader",
    lead: "getDashboardData is well-scoped for role visibility and parallelises its queries, but it is an all-rows loader: it exists to feed every screen, so its cost grows linearly with workspace size and it is the primary reason the current architecture cannot reach the stated load.",
    strengths: [
      "Scoping is correct and tested: MEMBER/MANAGER see only their project graph (owned, task-assigned, or explicitly assigned), with members limited to that graph; ADMIN sees all.",
      "8 findMany calls in one Promise.all - the render cost is about one RTT to the DB, not eight.",
      "Reminders and notifications are correctly partitioned (personal + broadcast); time entries are filtered to visible members only.",
    ],
    weaknesses: [
      "7 of the 8 queries are unbounded; tasks embed full project and assignee objects per row, multiplying payload size; time entries return the entire table for admins.",
      "stats.weeklyCompletion uses updatedAt, so reordering a card done months ago counts as completed this week - the headline metric drifts upward whenever boards are tidied.",
      "The loader is shared by every view, so opening the calendar costs the same as opening analytics; there is no per-view query surface to optimise independently.",
    ],
    fixes: [
      "Split the monolith: dashboard keeps aggregates (counts, top-N projects, recent activity); each view gets its own paginated loader. This pairs with the pagination fix in 1.1.",
      "Track a completedAt timestamp set on the DONE transition and compute weekly completion from it.",
      "Stop embedding project/assignee on every task row; return ids and let the client join against the (much smaller) projects/members lists it already has.",
    ],
  },
  {
    num: "1.6",
    title: "Tasks & Kanban",
    lead: "The board itself is competently built with @dnd-kit and persisted ordering, and the task modal correctly restricts assignees to the chosen project's members. The fatal defect is that no mutation is ever reflected on screen, so the board feels broken the moment a user drags a card or creates a task.",
    strengths: [
      "moveTask persists status and order atomically; task-edit ownership is enforced server-side (task:edit:any vs task:edit:own through TeamMember.userId).",
      "getProjectMembers restricts the assignee dropdown to people actually on the project, closing the assign-anyone hole.",
      "Filter chips (all/mine/high/due-week) are computed client-side without extra queries.",
    ],
    weaknesses: [
      "onDragEnd awaits moveTask, shows a toast, and updates nothing else; the card renders from the same stale props and jumps back. The same is true for create/edit/delete everywhere - there is no router.refresh() in the entire codebase. (tasks-view.tsx lines 75-106; grep for useRouter returns nothing)",
      "No virtualisation: a project with thousands of tasks renders every card; no windowing on columns.",
      "No optimistic updates: even after wiring refresh, a server round trip of hundreds of milliseconds (cross-region to eu-west-1) makes drags feel laggy without them.",
      "No undo for destructive actions; delete uses the native confirm() dialog, which is visually and behaviourally inconsistent with the design system.",
    ],
    fixes: [
      "W1: after any action resolves, call router.refresh() (or switch to useTransition + server actions so React re-renders from the new RSC payload). Then layer optimistic local state for drags: update the local array immediately, reconcile on response, roll back with an error toast on failure.",
      "Virtualise columns beyond ~100 cards (react-virtuoso or @dnd-kit virtualized lists).",
      "Replace confirm() with an in-system destructive dialog component; add a 10-second undo toast for deletes once soft-delete lands.",
    ],
  },
  {
    num: "1.7",
    title: "Projects & Assignments",
    lead: "Project CRUD and the explicit assignment relation are solid, with ownership resolved server-side from member ids. The gaps are lifecycle-shaped: deletion silently orphans tasks, progress is a hand-typed number, and the owner display copy drifts when people rename.",
    strengths: [
      "createProject/updateProject resolve ownerUserId server-side from the selected member; client-supplied names are never trusted.",
      "ProjectAssignment has a compound unique and both-side indexes; the assignment modal is admin-gated and audit-logged.",
      "Update diffs feed the audit trail (name, status, owner, due date, progress).",
    ],
    weaknesses: [
      "deleteProject performs no task handling: Task.projectId SetNulls, so every task in the project survives as an orphan on the board with no project. Same for time entries. There is no warning in the UI about task count.",
      "Progress is a manual number nobody is obliged to reconcile with task completion; it is displayed as a headline KPI next to computed ones.",
      "ownerName is denormalised for display but updateUser does not rewrite it on rename, so cards show stale names.",
      "No project archive state: ENDED is a status, but nothing behaves differently (no filtering, no read-only mode).",
    ],
    fixes: [
      "Gate deleteProject behind a dialog that states the consequences and offers bulk actions (delete tasks / move to another project); implement via soft-delete once 1.4's lifecycle fix lands.",
      "Derive progress from task completion by default, with a manual override flag surfaced in the UI.",
      "Sync ownerName in the same transaction as the user rename (or drop the column and join at read time).",
    ],
  },
  {
    num: "1.8",
    title: "Team, Messaging & Inbox",
    lead: "The team directory and profile drawer are genuinely good (per-member task lists, 30-day time breakdown, workload bars). The messaging model, however, is structurally wrong: direction and read state are single-row globals shared by sender and recipient, so the product's inbox semantics only work for seeded demo rows.",
    strengths: [
      "Profile drawer aggregates assigned tasks, recent time entries and per-project hour breakdown with correct keys (the earlier duplicate-key bug is fixed and regression-tested).",
      "Reply routing resolves the recipient's userId via getUserByEmail so messages are scoped to real accounts; deleteMessage enforces sender-or-recipient ownership.",
      "MessageModal blocks empty bodies; subjects fall back to (no subject).",
    ],
    weaknesses: [
      "direction is written from the sender's perspective at creation (clients pass OUT) but read from the current user's perspective everywhere. A message I receive was stored as OUT and read=true, so: my unread badge skips it (filter is direction IN && !read), it renders on the outgoing side of the thread (isOutgoing = direction === OUT), and markThreadRead - which requires direction IN - can never match it. (messages.ts line 44; inbox-drawer.tsx lines 39, 46, 185, 195, 248, 304)",
      "read is one global flag on the shared row: if the sender's copy is marked read (or vice versa) the other party's state changes too.",
      "recipientUserId defaults to '' (not null) for unknown recipients, so those messages are unaddressable by any user yet still load in the sender's list.",
      "There is no way to start a conversation from the team page without the modal round trip to look up the recipient user id.",
    ],
    fixes: [
      "Remodel messaging (W2, P0): either per-party mailbox rows (send writes a sent row to the sender's list and an inbox row to the recipient's, like email) or drop the stored direction entirely and derive it per viewer as recipientUserId === me ? IN : OUT, with read state moved to a per-recipient join table (MessageRead). The per-party-rows option is the simpler migration here.",
      "Make recipientUserId nullable and reject sends to addresses with no user account in the UI (show which teammates are addressable).",
      "Add a Message action to member cards (alongside Profile) that opens the drawer on that thread directly.",
    ],
  },
  {
    num: "1.9",
    title: "Calendar & Events",
    lead: "The month grid is clean, with day cells, a selected-day list and a legend. But events are a flat global table with no ownership, no scoping and no invitation model, which at 100k users means everyone sees everyone's events forever.",
    strengths: [
      "Grouping by day and the event-type colour legend are implemented; the calendar view reads from the shared loader without extra queries.",
      "Event creation validates through zod schemas shared with the rest of the domain.",
    ],
    weaknesses: [
      "CalendarEvent has no owner, no participants, and no project link; every user sees every event. The event:create permission exists but any event is world-visible once created.",
      "No week/day/agenda views; month only.",
      "No recurring events; no drag-to-move; no ICS import/export, so the calendar cannot round-trip with anything users already have.",
    ],
    fixes: [
      "Add ownerUserId plus a participants relation (or project linkage) and scope the calendar query like tasks are scoped; default new events to private.",
      "Ship week and agenda views (cheap once the data is scoped); add ICS export at minimum.",
      "Defer recurrence and drag-to-move to post-launch; they are polish, not blockers.",
    ],
  },
];
