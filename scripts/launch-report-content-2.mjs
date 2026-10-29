// ---------------------------------------------------------------------------
// Fernly Launch-Readiness Audit — content module 2/2
// Part 1 domains 10-18 + Part 2 (P0/P1/P2) + 30-day plan + go/no-go.
// ---------------------------------------------------------------------------

export const DOMAINS_B = [
  {
    num: "1.10",
    title: "Analytics & Time Tracking",
    lead: "The analytics page computes everything client-side from the loaded dataset - throughput, completion, time by project, contributors - and the CSV export works. That design is fine at demo scale and untenable as a product: computation cost and payload both grow with the whole workspace, and the time tracker trusts the client clock entirely.",
    strengths: [
      "Charts cover throughput, status mix and per-project hours; Export CSV is implemented and the FAQ matches it (verified, not another doc lie).",
      "logTime derives the member from the session (the forgeable-memberId bug is fixed) and validates 0 < hours <= 24.",
      "Workload recalc after task mutations is centralised in recalcMemberStats.",
    ],
    weaknesses: [
      "Every metric is computed in the browser from all rows; there is no server-side aggregation, so analytics cost is paid by every viewer on every load.",
      "The time tracker runs in the browser and submits client-chosen date and hours; a user can log 8h for last Tuesday retroactively with no server-side sanity (no per-day cap, no future-date rejection).",
      "workload is hardcoded as open/6 in recalcMemberStats while Workspace.workloadFullCapacity is an editable setting surfaced in the UI - the setting is cosmetic.",
      "The heatmap legend hardcodes oklch values instead of theme tokens, so it does not follow dark mode or accents.",
    ],
    fixes: [
      "Move aggregates to SQL (group by status/project/week) behind a dedicated analytics action; the client charts then consume kilobytes, not the full dataset.",
      "Server-side guard rails on logTime: reject future dates, cap per-day totals at 24h, and reconcile Stop & Log entries against server receive time within a tolerance.",
      "Read capacity from Workspace.workloadFullCapacity in recalcMemberStats (one-line fix plus a test).",
      "Derive the heatmap scale from CSS variables.",
    ],
  },
  {
    num: "1.11",
    title: "Notifications & Reminders",
    lead: "Per-user notification routing is correctly modelled and enforced (private rows are private; broadcasts are admin-curated only), and reminders distinguish personal from workspace-wide. The weaknesses are volume-shaped and lifecycle-shaped.",
    strengths: [
      "Notification.recipientUserId routing with (recipientUserId, read) index; markAllNotificationsRead touches only the caller's rows - all four paths are regression-tested.",
      "The topbar badges broadcasts with an All chip and unread counts; broadcast curation requires role:manage, since flipping a broadcast affects every viewer.",
      "Reminders partition on ownerId (null = shared), and the dashboard widget filters completed ones.",
    ],
    weaknesses: [
      "The dashboard loader caps notifications at 20 with no older-pages path - at scale users lose history silently.",
      "No delivery mechanism exists: notifEmail/notifPush and the per-type toggles in settings persist to UserSettings and are read by nothing. No email digests, no push, nothing.",
      "There is no mention entity, though MENTION is a notification type - nothing in the product creates one.",
      "No read/unread bulk management (select-all, filter unread) once lists grow.",
    ],
    fixes: [
      "Add cursor pagination to notifications and a load-older affordance in the dropdown.",
      "Once the mail service lands (1.2), wire a daily digest honouring the per-type toggles; until then remove the toggles or mark them as coming soon - cosmetic settings erode trust the same way the roles editor does.",
      "Implement @mention in task descriptions/comments as the creator of MENTION notifications (pairs with the Part 2 mention item).",
    ],
  },
  {
    num: "1.12",
    title: "User & Workspace Administration",
    lead: "The user directory is the most feature-complete surface: full CRUD with hierarchy-gated permissions, cycle prevention on manager assignment, a Reports To column, role badges, project assignment expansion, and an expandable audit history per user. Its two defects are the RBAC-editor disconnect (covered in 1.3) and ghost rows after deletion.",
    strengths: [
      "createUser mints login + team-member row in one transaction; updateUser/deleteUser are gated by requirePermissionForTarget with self-protection rules (cannot demote or unmanage yourself); manager changes run assertNoCycle and are audit-logged.",
      "getAllUsers returns managerId/managerName in a single query (no N+1); the Users view renders the reporting line per row.",
      "Workspace settings persist 12 configurable defaults (password length floor 8, capacity, limits) and honour minPasswordLength in create/update/change-password.",
    ],
    weaknesses: [
      "deleteUser leaves the TeamMember roster row alive (userId SetNull) - the team directory shows ghosts of deleted accounts; messages keep dangling sender/recipient strings.",
      "The Users view renders ~40 columns of state per row in the DOM with no pagination; at thousands of users the page degrades linearly (getAllUsers returns every row to the client).",
      "Password resets are admin-only; there is no self-service anything (see 1.2).",
      "The seeded demo accounts (demo/manager/member @fernly.app, all password fernly123) are created by the seed script, which only refuses when NODE_ENV=production - a misconfigured deployment environment silently seeds publicly-known admin credentials.",
    ],
    fixes: [
      "On deleteUser, archive the roster row (soft-delete) and null out messages' sender/recipient display fields via the remodelled relations.",
      "Paginate + server-side search the directory; render virtualised rows.",
      "Harden the seed guard: refuse unless an explicit SEED_DEMO=1 is set, independent of NODE_ENV; strip demo quick-fill buttons and the Try demo@fernly.app / fernly123 toast from the login screen behind the same flag (src/components/auth/login-screen.tsx lines 10-11, 19, 41).",
    ],
  },
  {
    num: "1.13",
    title: "UI/UX & Design System",
    lead: "The design system is a real strength: OKLCH tokens, four accent themes, dark mode, a consistent f-* utility layer, and cohesive components (Field, Section, StatCard, RoleBadge, EmptyState). The UX defects are concentrated in feedback loops (stale data, missing boundaries) rather than visual craft.",
    strengths: [
      "Token-driven theming (data-accent, .dark) applied consistently; Geist self-hosted via next/font; no external font or image fetches at runtime.",
      "Responsive shell: collapsible sidebar with backdrop on mobile, adaptive grids, mobile-visible search and inbox actions.",
      "A11y basics present: aria-labels on icon buttons, role=dialog with aria-modal, Escape closes modals, keyboard shortcuts with a cheatsheet that now matches the wiring (the earlier drift pass closed 13 items).",
    ],
    weaknesses: [
      "Feedback loop is broken end to end: mutations leave stale props (1.6), unhandled errors have no boundary (1.1), and loading has no Suspense or skeletons.",
      "Modal has no focus trap, no focus restoration, and no aria-labelledby wiring to its title - keyboard and screen-reader users can tab out of dialogs into the page behind them. (src/components/fernly/modal.tsx)",
      "Native confirm() for destructive actions and native selects throughout; both are functional but off-system.",
      "Hardcoded English with en-NZ date formatting; no i18n layer, so any second locale is a rewrite of every string.",
    ],
    fixes: [
      "Ship the W1 correctness trio (refresh, error boundaries, loading states) - this fixes more perceived quality than any visual work.",
      "Add a focus trap with restore (a 30-line hook) and wire aria-labelledby; run an axe pass in CI.",
      "Replace confirm() with a DestructiveDialog component; introduce @radix-ui style headless primitives for selects and dialogs (the design tokens already exist to style them).",
      "Extract strings now (t('...') indirection) even if only English ships at launch; retrofitting i18n later costs triple.",
    ],
  },
  {
    num: "1.14",
    title: "Command Palette, Search & Help",
    lead: "The palette is fast, grouped, filtered, and now drift-free with the sidebar (role-gated entries match, hints match wiring). Its limitation is scope: it searches commands, never data - and at 100k users, data search is the primary navigation need.",
    strengths: [
      "Groups (Navigation / Create / Theme) with per-item hints; query filtering; portal rendering with Escape and backdrop close.",
      "The recent drift pass aligned the palette, sidebar, shortcuts and help cheatsheet 1:1, with 12 regression tests pinning the contract.",
      "Help centre has categories, FAQ search, contact cards and a shortcuts modal fed by the same source as the palette.",
    ],
    weaknesses: [
      "No data search: no way to find a task by title, a project by name, or a user by email from one box.",
      "No recent-items or fuzzy ranking; plain substring match only.",
      "The palette is hidden on mobile (md+ trigger) with no equivalent; mobile users get a search icon that opens the same palette, which is a workaround, not a design.",
    ],
    fixes: [
      "Add a Search group backed by a server-side search action (Postgres ILIKE across tasks/projects/users is enough at this scale; trigram GIN indexes if needed later).",
      "Ship fuzzy matching (fzf-style scoring) and MRU ordering.",
      "Design a mobile-native search sheet; the palette pattern is fine on touch once it is full-screen.",
    ],
  },
  {
    num: "1.15",
    title: "Security Posture",
    lead: "The server-side enforcement layer is genuinely hard to fault: every action is gated, ownership uses stable ids, errors travel as typed result objects, and the historical P0/P1 holes are closed with regression tests. The remaining exposure is concentrated in session lifecycle, headers, and operational controls rather than authorization logic.",
    strengths: [
      "Eighteen permissions enforced server-side; hierarchy-aware requirePermissionForTarget for user-targeted actions; zod validation on every mutation surface; bcrypt cost 12.",
      "Typed audit actions across 10 entity types; audit writes are best-effort and never break the operation; the immutable trail is queryable per entity (EntityHistorySection).",
      "Security headers (HSTS, DENY framing, nosniff, referrer, permissions-policy) plus a conservative CSP with frame-ancestors none and object-src none; the proxy self-heals stale cookies; the signout wrapper expires all six cookie namespaces.",
      "Weak-secret boot guard in production; .env.example documented; secrets rotated with a 32-byte value.",
    ],
    weaknesses: [
      "No session revocation path (1.2) - the largest single exposure: a compromised cookie is valid up to 30 days and survives password rotation.",
      "CSP ships unsafe-inline and unsafe-eval for scripts (documented as a Next.js bootstrap constraint); no nonce-based policy, no report-uri.",
      "serverActions.allowedOrigins permanently includes preview domains (*.space-z.ai, *.fcapp.run) - fine for the preview product, but production should narrow this list.",
      "PII retention is unbounded: audit rows store names and emails forever; no GDPR-style export or erasure path for a user's data; no ToS/privacy pages exist.",
      "No dependency audit in CI (no bun audit / npm audit gate), and no scheduled secret rotation runbook beyond the proxy's self-healing.",
    ],
    fixes: [
      "Land tokenVersion revocation (1.2) and treat it as a launch gate.",
      "Move CSP to nonce-based (Next supports per-request nonces); add report-uri and monitor.",
      "Split allowedOrigins between preview and production builds via an env-driven list.",
      "Add a GDPR export (JSON of a user's rows) and a redact-on-delete path for messages/audit; publish ToS/privacy before public launch (NZ Privacy Act 2020 applies).",
      "Add a dependency-audit step to CI and a quarterly rotation calendar entry for NEXTAUTH_SECRET.",
    ],
  },
  {
    num: "1.16",
    title: "Performance & Scalability",
    lead: "At the current 12-user dataset everything is instant. The architecture's ceiling is structural, not incidental: one workspace, one payload, one instance. Each of those three ones is a separate decision, and all three have to change (or be explicitly accepted) before a 100k-user claim is honest.",
    strengths: [
      "Parallel loader (one Promise.all); Prisma singleton; query logging confined to dev; standalone output build with a working start script.",
      "Light client stack: no data-fetching library, Zustand only, Tailwind v4 with a token layer; avatars are CSS initials (zero image payload).",
    ],
    weaknesses: [
      "Unbounded queries with zero secondary indexes on the three hottest tables (1.4) - sequential scans under load.",
      "The DB lives in eu-west-1 while the product's timezone default is Pacific/Auckland; users in NZ/AU pay a cross-region round trip on every page load (the parallel batch makes it one RTT, not eight, but it is still the wrong continent for the audience).",
      "Single app instance behind Caddy; the in-memory rate limiter and 60s config cache are per-process, so horizontal scaling changes behaviour silently.",
      "No caching layer of any kind (no Redis), no CDN story (fine, since there are no static assets beyond JS chunks), and no measured budget: no Lighthouse, no bundle-size gate, no load tests at all.",
    ],
    fixes: [
      "W1 indexes + W2 pagination are prerequisites for everything else; measure before and after with EXPLAIN ANALYZE on the scoped queries.",
      "Decide the data plane: either move/co-locate the primary near the users (Sydney region) or accept the RTT explicitly. Do not launch with the DB a continent away from the audience and no measurement.",
      "Introduce Redis for limiter + config cache, then scale to 2+ instances behind a load balancer with real health checks (1.17).",
      "Add performance gates to CI: bundle budget, Lighthouse budget, and a k6 scenario at 100k-row dataset scale (the plan in Part 2 sequences this as W4's exit criterion).",
    ],
  },
  {
    num: "1.17",
    title: "Observability & Operations",
    lead: "This is the weakest dimension in the report and the one most likely to turn a bad afternoon into an outage: there is effectively no production telemetry, no health surface, no recovery plan, and no runbook.",
    strengths: [
      "Console logging is disciplined and dev-only for query noise; the audit log provides a durable record of who did what.",
      "The pre-commit hook (lint + typecheck) and CI (lint, typecheck, coverage-gated tests, production build) raise the floor on every commit.",
      "Deployment is at least reproducible: standalone output, Caddyfile, and a start script - not a snowflake machine.",
    ],
    weaknesses: [
      "/api is a Hello world placeholder (src/app/api/route.ts); there is no health or readiness endpoint for a load balancer or orchestrator to probe.",
      "No error tracking (no Sentry or equivalent), no metrics, no tracing, no alerting. The first indication of a production problem will be a user complaint.",
      "No backup/DR story: Supabase PITR not verified, no restore drill, no documented RPO/RTO, and no runbook for the known failure modes (secret rotation, DB failover, bad deploy).",
      "No Dockerfile or infrastructure-as-code; scaling is a manual SSH exercise. E2E remains disabled pending a CI database secret.",
    ],
    fixes: [
      "W1: implement /api/health (checks DB round trip and returns 503 on failure); delete the placeholder.",
      "W3: add Sentry (server + client), structured request logs with a request id, and uptime/5xx/DB-pool alerts; page the on-call on SLO breach.",
      "W3-W4: Dockerfile + compose or k8s manifests, 2+ instances behind the LB, and a written restore drill executed against a staging database before launch day.",
      "Enable the E2E job with a service-container Postgres in CI; it exists and is one secret away.",
    ],
  },
  {
    num: "1.18",
    title: "Testing, CI & Documentation",
    lead: "For a project at this stage, the test and documentation discipline is exceptional and sets the ceiling for what the team can safely change late. The gaps are coverage geography (components barely tested) and the permissive lint config.",
    strengths: [
      "322 tests / 20 files at ~95% statement and ~88% branch coverage over lib + server-actions, gated at 90/80; a dedicated security-regression suite per historical fix; proxy, signout wrapper, hierarchy and palette contracts all pinned.",
      "CI runs lint + typecheck + coverage-gated tests + production build on every push/PR; a pre-commit hook ships in-repo (enable via git config core.hooksPath .githooks).",
      "Six living documents (PRD, ARCHITECTURE, SECURITY, CODING_STANDARDS, TESTING, CODE_REVIEW) plus an E2E README; CODE_REVIEW is an honest ledger with per-pass verification notes rather than marketing.",
      "TypeScript is fully strict including noImplicitAny; the last 12 any usages were eliminated and locked by the compiler.",
    ],
    weaknesses: [
      "Component coverage is near zero by gate design: 6 test files against 40+ components; the heaviest user-facing logic (tasks board, calendar, analytics, settings forms) has no tests. The coverage gate excludes components entirely.",
      "E2E is scaffolded but disabled; nothing exercises the real browser flows in CI.",
      "ESLint runs with most valuable rules off (no-unused-vars, exhaustive-deps, etc.) - the CODE_REVIEW openly tracks this; dead code and effect bugs can land silently.",
      "A .env.template-backup file sits in the repo root (housekeeping); two unused dependencies (z-ai-web-dev-sdk, sharp) widen the install surface for no benefit.",
    ],
    fixes: [
      "Before launch: component tests for the four highest-traffic flows (board drag, task modal, user modal, inbox) and Playwright E2E replacing the Selenium scaffold; then pull components inside the coverage gate.",
      "Re-enable lint rules incrementally with an allow-list of legacy suppressions (one focused pass; do not bulk-flip).",
      "Remove the backup env file and the two unused dependencies; add bun audit to CI.",
    ],
  },
];

// ---------------------------------------------------------------------------
// PART 2 — pre-launch remediation tables
// ---------------------------------------------------------------------------

export const PART2 = {
  intro:
    "This part answers the second question directly: what has to be fixed or added before launch. P0 items are launch blockers - the product is dishonest or broken without them. P1 items should ship in the same window; each is a scale or trust risk that turns into an incident under load. P2 items are fast-follow: genuinely valuable, safe to land within 30 days or just after, and explicitly not blockers.",
  p0: {
    label: "P0 - Launch blockers (close by day 14)",
    headers: ["#", "Item", "Why it blocks launch", "Concrete fix"],
    widths: [5, 24, 34, 37],
    rows: [
      ["1", "Mutation data refresh", "Every create/edit/delete leaves stale props; Kanban drag reverts; created items invisible until reload. The product feels broken in the first minute.", "Call router.refresh() after every action resolves (or useTransition-wrapped actions); add optimistic local state for board drags. Touches tasks-view, app-store, all modals."],
      ["2", "Message direction/read remodel", "Recipients never see unread badges for real messages; threads render on the wrong side; markThreadRead never matches. Messaging is unusable outside seeded data.", "Per-party mailbox rows on send (sent row + inbox row) with per-recipient read state; migrate direction to derived-at-read. messages.ts + inbox-drawer.tsx + one migration."],
      ["3", "Error boundaries & loading states", "Uncaught errors show the raw Next.js error page; SSR blocks with no streaming; the loader's deliberate throwing contract has no catcher.", "Add error.tsx + global-error.tsx + not-found.tsx; loading.tsx with skeletons for the shell. src/app/ only - no component changes."],
      ["4", "Health endpoint", "No probe for the load balancer; orchestrators cannot tell a healthy instance from a wedged one; the placeholder returns Hello world.", "Implement /api/health: one DB round trip, 503 on failure, plus readiness variant. Replace src/app/api/route.ts."],
      ["5", "DB indexes", "Task/TimeEntry/Project have zero secondary indexes; every scoped query is a sequential scan. At 100k rows the board query alone can exceed seconds.", "One migration: Task(projectId, assignee, status), TimeEntry(memberId, projectId, date), Project(ownerUserId, status). Verify with EXPLAIN ANALYZE."],
      ["6", "Prisma migrations", "Schema is managed with db push --accept-data-loss; no version history, no rollback, and the flag can destroy production data.", "Generate a baseline migration, commit it, switch scripts to migrate deploy; remove --accept-data-loss from anything reachable in prod."],
      ["7", "RBAC editor enforcement", "The roles editor writes RolePermission rows that no enforcement path reads; admins can revoke permissions and nothing changes. This is a trust failure, not just a bug.", "Route requirePermission through cached hasPermissionDb (60s TTL) keeping the static matrix as floor; or remove the editor. Either state is shippable - the current one is not."],
      ["8", "Session revocation", "Stolen cookies stay valid 30 days and survive password change; no force-logout exists. The single largest security exposure.", "Add User.tokenVersion; bump on password/role change; reject stale versions in the jwt callback. Also shorten maxAge to 7 days as defence in depth."],
      ["9", "Pagination & server-side search", "Every list returns all rows (users, tasks, projects, time entries); payload and DOM cost grow linearly with the workspace.", "Cursor pagination + search on the four list surfaces; keep the dashboard loader for aggregates only. Pairs with item 5."],
      ["10", "Redis rate limiting", "In-memory limiter resets on deploy and does not share state; NAT offices get locked out collectively.", "Redis-backed limiter with the same 5/15min semantics; progressive delay + CAPTCHA after repeated failures."],
      ["11", "Mail service + password reset", "No self-service reset or verification at all; at 100k users this is an unbounded support queue and an account-takeover enabler for shared inboxes.", "Transactional provider (Resend/SES), time-boxed single-use reset tokens, email verification, and reset-required flow on first login."],
      ["12", "Login demo gating", "The login screen prefills demo@fernly.app / fernly123 and tells users to try it; the seed creates public admin credentials unless NODE_ENV is exactly production.", "Gate quick-fill buttons + prefill + hint behind SEED_DEMO=1; make seed refuse without an explicit flag independent of NODE_ENV. login-screen.tsx + seed.js."],
      ["13", "User.role default fix", "Schema default is 'Project Lead' - an invalid role that sessions downgrade to MEMBER while the UI renders it literally.", "Default to 'MEMBER' in schema.prisma; add app-level guard on the three canonical values. One migration line."],
      ["14", "Delete semantics", "Deleting a project orphans its tasks; deleting a user leaves roster ghosts and dangling message ids. Data integrity decays from day one.", "Soft-delete (deletedAt) for projects/users/messages with a scheduled purge; deleteProject warns and offers task move/delete. One migration + three actions."],
      ["15", "Shortcut permission gating", "G U / G W / G L fire for every user; MEMBERS navigate into admin views and eat raw auth error toasts.", "Gate the G-prefix map with the same hasPermission calls the sidebar uses (use-keyboard-shortcuts.ts)."],
      ["16", "Workload config wiring", "Workspace.workloadFullCapacity is editable and displayed but recalcMemberStats hardcodes 6 - the setting lies.", "Read the setting in recalcMemberStats (+ test). One-line change."],
    ],
  },
  p1: {
    label: "P1 - Ship in the same window (days 15-21)",
    headers: ["#", "Item", "Why it matters at 100k users", "Concrete fix"],
    widths: [5, 24, 34, 37],
    rows: [
      ["17", "Code splitting + JS budget", "Recharts and every view ship in the initial bundle; first paint pays for screens the user never opens.", "next/dynamic for Analytics/Calendar; bundle budget gate in CI (target under 200KB gz initial route JS)."],
      ["18", "Focus trap & a11y pass", "Modals lack focus trap/restore; screen-reader users can tab into the page behind dialogs. Legal and reputational exposure.", "30-line focus-trap hook + aria-labelledby; axe scan in CI; fix the heatmap contrast path."],
      ["19", "Error tracking + logs + alerts", "First sign of trouble is currently a user complaint. No metrics, no tracing, no on-call signal.", "Sentry (server+client), request-id structured logs, uptime/5xx/DB-pool alerts wired to on-call."],
      ["20", "Audit log retention", "Every mutation writes a row forever; unbounded growth slows the very queries the timeline depends on.", "Partition by month, 180-day hot window, archive to object storage; prune job in the scheduler."],
      ["21", "Multi-instance + LB + Dockerfile", "Single instance behind Caddy; scaling is SSH surgery.", "Dockerfile + compose/k8s, 2+ instances behind the LB probing /api/health; Redis from item 10 shared."],
      ["22", "Backup/DR drill", "No verified PITR, no restore rehearsal, no RPO/RTO statement.", "Enable Supabase PITR; execute a timed restore against staging; publish RPO/RTO in SECURITY.md."],
      ["23", "Component & E2E tests", "Highest-traffic UI has no tests; regressions in the W1 refresh work would ship silently.", "Component tests for board/modal/inbox flows; Playwright E2E on login + board + messaging; pull components into coverage gate."],
      ["24", "Lint re-enablement", "no-unused-vars and exhaustive-deps are off; dead code and effect bugs land silently.", "Focused pass with an allow-list of legacy suppressions; block new suppressions in review."],
      ["25", "Load testing", "No measurement exists for the 100k claim anywhere in the pipeline.", "k6 scenarios at 100k-row dataset: browse, board drag, login storm; p95 budgets as W4 exit criteria."],
      ["26", "DB region decision", "Primary sits in eu-west-1 while the audience defaults to Pacific/Auckland; every page pays a cross-continent RTT.", "Move/co-locate near users (Sydney) or accept explicitly with measurements on record. Pair with item 5 re-run."],
    ],
  },
  p2: {
    label: "P2 - Fast follow (days 22-30 and post-launch)",
    headers: ["#", "Item", "Why it is not a blocker", "Concrete fix"],
    widths: [5, 24, 34, 37],
    rows: [
      ["27", "SSO / 2FA", "Credentials work at launch; enterprises need SSO before renewal, not before first use.", "Google/Microsoft OIDC alongside credentials; TOTP 2FA with recovery codes."],
      ["28", "File attachments", "Missing feature vs competitors, but not blocking internal launch.", "Object storage + signed URLs; size/type caps; virus scan hook."],
      ["29", "@mentions", "MENTION notification type exists unused; not blocking, high delight value.", "Parse @name in descriptions/comments; emit MENTION notifications to recipients."],
      ["30", "Global data search", "Palette searches commands only; needed once data volume grows.", "Search group in the palette backed by a server-side ILIKE action (trigram GIN if needed)."],
      ["31", "Bulk operations", "Nobody needs multi-select on day one at this scale of team.", "Selection mode on the board + bulk status/assignee/archive."],
      ["32", "i18n", "English-only launch is fine for NZ; retrofit later costs triple if strings are not extracted.", "Extract to t('...') now; ship a second locale post-launch."],
      ["33", "Trash / undo window", "Soft-delete (item 14) covers integrity; user-facing undo is polish.", "10s undo toast on deletes; trash view with restore."],
      ["34", "Webhooks / Slack", "Integration demand arrives after users, not before.", "Outgoing webhooks on task/project events; Slack app post-launch."],
      ["35", "GDPR export & legal pages", "Needed before any EU user; NZ Privacy Act readiness is cheaper now.", "JSON export per user; ToS/privacy pages; redact-on-delete path."],
      ["36", "Multi-workspace tenancy", "The architectural ceiling (Part 1.1). Only required if the commercial model demands multiple orgs.", "workspaceId on all domain tables + scoping in every query; a multi-week project - schedule explicitly, never silently."],
      ["37", "Status page + on-call runbook", "Operational polish once item 19 lands.", "Public status page; written runbooks for secret rotation, DB failover, bad deploy."],
      ["38", "Recurring events / ICS", "Calendar power features.", "RRULE subset + ICS import/export; week/agenda views."],
    ],
  },
};

// ---------------------------------------------------------------------------
// 30-day plan
// ---------------------------------------------------------------------------

export const PLAN = {
  lead:
    "Sequencing rationale: correctness first, then integrity, then scale, then verification. Week 1 exists because the two UX-breaking bugs (items 1 and 2) plus boundaries and indexes change what every later item is tested against - landing them late would re-litigate every code review. The plan assumes one staff full-stack engineer full-time plus one staff backend engineer from week 2; if it is one engineer end to end, treat day-30 as day-45 and cut P1 items 24 and 26 to post-launch.",
  headers: ["Week", "Days", "Focus", "Deliverables (item numbers from Part 2)", "Exit criteria"],
  widths: [8, 10, 18, 38, 26],
  rows: [
    ["W1", "1-7", "Correctness", "Items 1, 3, 4, 12, 13, 15, 16; indexes (5) drafted; tokenVersion design agreed", "Board drag and create/delete reflect on screen without reload; /api/health returns DB-checked 200; demo login gated; CI green at every commit"],
    ["W2", "8-14", "Integrity & auth", "Items 2, 5, 6, 7, 8, 14; baseline migration committed; seed hardening", "Message remodel verified end to end for both parties; EXPLAIN ANALYZE shows index usage on scoped queries; revocation test: changing password invalidates the old cookie; roles editor either enforced or removed"],
    ["W3", "15-21", "Scale & hardening", "Items 9, 10, 11, 17, 18, 19, 21 (compose), 22 drilled", "Redis limiter active on 2 instances; reset email round trip works; bundle budget enforced in CI; Sentry captures a seeded error; restore drill timed and written up"],
    ["W4", "22-30", "Verification & go/no-go", "Items 23, 25, 26 decision recorded; load tests; a11y pass; runbook", "k6 at 100k-row dataset meets p95 budgets (page under 1.5s, board drag under 400ms server); axe clean; go/no-go review held with this checklist"],
  ],
};

// ---------------------------------------------------------------------------
// Go/no-go
// ---------------------------------------------------------------------------

export const GONOGO = {
  intro:
    "Every line below must be true on the day the gates open. The list is deliberately short enough to check in one meeting; each item maps to a Part 2 number so ownership is unambiguous.",
  headers: ["Check", "Criterion", "Maps to"],
  widths: [8, 72, 20],
  rows: [
    ["1", "All sixteen P0 items closed, tested, and verified on staging - no exceptions, no partial credit", "1-16"],
    ["2", "Mutation freshness: creating, editing, dragging and deleting reflect immediately without a manual reload (manual test script attached to CI)", "1"],
    ["3", "Messaging round trip: send from A to B; B sees an unread badge, opens the thread, marks read; A's view unaffected", "2"],
    ["4", "Load test at 100k-row dataset: page p95 under 1.5s, board move p95 under 400ms server time, login storm 500 rps for 5 min without 5xx", "25"],
    ["5", "Security review pass: tokenVersion revocation proven by test; CSP report clean for 24h on staging; dependency audit zero known CVEs", "8, 15"],
    ["6", "Restore drill executed and timed against staging with RPO/RTO written into SECURITY.md", "22"],
    ["7", "Accessibility: axe clean on the five primary flows; focus trap verified by keyboard-only walkthrough", "18"],
    ["8", "E2E suite (login, board, messaging) green in CI on every PR", "23"],
    ["9", "No cosmetic controls shipped: roles editor and notification toggles either work or are absent", "7, 11"],
    ["10", "Observability live: Sentry fed, alerts firing to a tested channel, dashboards for uptime/5xx/DB pool", "19"],
    ["11", "Demo credentials impossible in production build (verified by building and inspecting the bundle)", "12"],
    ["12", "Audit retention job running with a demonstrated prune", "20"],
  ],
  verdict:
    "Final verdict: CONDITIONAL GO. The launch date holds if and only if items 1-16 close by day 14 and the W4 exit criteria are met at the review. If any P0 remains open at day 14, slip the date - do not ship around it: every one of the sixteen either breaks core UX in the first minute of use, misrepresents the product's behaviour to its administrators, or removes the recovery options an incident will need. With one engineer instead of two, the honest date is day 45 with items 24 and 26 moved post-launch. The codebase has earned the right to be launched - the discipline in its tests, its security layer, and its documentation is real; what it needs now is the same discipline applied to the sixteen things that currently are not what they appear to be.",
};
