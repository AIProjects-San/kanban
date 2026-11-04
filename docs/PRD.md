# Fernly — Product Requirements Document (PRD)

**Version:** 1.0 · **Status:** Live (single workspace deployment) · **Owner:** Workspace admin
· **Covers through:** PR-65 (role-scoped analytics, row-level task deletion, HR module,
per-user appearance)

---

## 1. Problem statement

Small teams need a lightweight, self-contained workspace to coordinate projects, tasks,
schedules and internal communication without the overhead (and cost) of enterprise
suites. Existing tools either over-serve (Jira/Asana complexity) or under-serve (Trello's
flat boards). Fernly packages the pillars a 5–30 person team actually uses daily —
projects, a Kanban board, bug tracking, a shared calendar, person-to-person messaging,
and HR operations (leave, directory, reviews, onboarding) — behind one
sign-in, with role-appropriate visibility.

## 2. Goals & non-goals

**Goals**
1. One screen per concern, navigable in a single keystroke (`G D/T/P/C/A/E/U/W`).
2. Role-based access that is enforced on the **server**, not just hidden in the UI.
3. A full audit trail — who changed what, when, per entity.
4. Workspace-configurable vocabulary (statuses, priorities, departments, roles) so the
   tool adapts to the team, not vice versa.
5. Zero-friction demo data and instant account provisioning for new hires.

**Non-goals (v1)**
- Public guest access / share links.
- File attachments.
- External integrations (Slack, email ingestion, webhooks).
- Multi-workspace tenancy (single workspace per deployment).
- Mobile apps (the layout is responsive; no native wrappers).

## 3. Users & roles

| Role | Description | Key permissions |
|------|-------------|-----------------|
| **ADMIN** | Workspace owner. | Everything: user CRUD, role matrix, workspace config, deletions, audit log, HR console. |
| **MANAGER** | Team lead (owns a reporting subtree). | Create/edit projects, invite members, edit any task in scope, approve their team's leave, HR console, audit log. Cannot delete projects/users or manage roles. |
| **MEMBER** | Individual contributor. | Create tasks, edit **own** tasks, delete tasks assigned to them, message, calendar, leave (self-service), analytics (own data only). Sees only projects they own/are assigned to/have tasks in. |
| **HR** | People Operations. | HR console (leave queue, directory, reviews, onboarding), analytics for their own data, leave self-service. No user administration or role management. |

The permission matrix is **data** (`Role`/`Permission`/`RolePermission` tables), editable
by admins at runtime, with the code-level matrix in `lib/rbac.ts` as the compile-time
floor.

## 4. Functional requirements

### 4.1 Authentication (FR-A)
- FR-A1: Email + password sign-in; Better Auth DB-backed sessions (7-day expiry,
  httpOnly cookies) — plus optional 1-hour JWT bearer tokens for programmatic
  clients (`POST /api/auth/token`), funnelling through the same permission and
  scoping rules.
- FR-A2: 5 failed attempts per email **or** IP within 15 minutes locks that vector.
- FR-A3: Self-service password change (requires current password).
- FR-A4: Sign-ins, sign-outs and token issuances are audit-logged (IP + user agent).
- FR-A5: Role changes take effect within 5 minutes without re-login; role-permission
  matrix edits apply to signed-in users within the 60 s config-cache window.

### 4.2 Dashboard (FR-D)
- FR-D1: KPI stats (project counts by status, weekly completion, ended-%).
- FR-D2: Personal reminders (private to the creator; legacy workspace-wide reminders
  visible to all).
- FR-D3: Activity notifications feed (workspace-wide).
- FR-D4: Time tracker widget.
- FR-D5: Greeting + "today" computed in the *user's* timezone for hydration consistency.

### 4.3 Projects (FR-P)
- FR-P1: CRUD with name, description, status, priority, color, due date, owner, progress.
- FR-P2: Grid card view with color coding.
- FR-P3: Explicit user↔project assignments (affects scoping).
- FR-P4: Deleting a project nulls task references (tasks survive); assignments cascade.

### 4.4 Tasks / Kanban (FR-T)
- FR-T1: Four columns: To do / In progress / In review / Done (DB-configurable).
- FR-T2: Drag & drop between columns; order preserved per column.
- FR-T3: Fields: title, description, status, priority, tag, due date, project, assignee.
- FR-T4: Assignee dropdown restricted to people allocated to the chosen project.
- FR-T5: `task:edit:own` users may only modify tasks assigned to them.
- FR-T6: Member workload stats (open/completed/workload %) recalculated on every change.
- FR-T7: Deletion is row-level: a task may be deleted by its assignee, the project
  owner, any ADMIN, or a MANAGER whose reporting chain covers the assignee or
  project owner. No one else — regardless of edit rights.

### 4.5 Calendar (FR-C)
- FR-C1: Month grid with events (type-coded: meeting, deadline, review, social, focus);
  approved leave appears as virtual events without duplicating rows.
- FR-C2: CRUD for events with time + duration + location.

### 4.6 Analytics (FR-N)
- FR-N1: Completion trends, hours by project, 13-week activity heatmap, top
  contributors, on-time delivery & cycle-time cards.
- FR-N2: Role-scoped, enforced server-side: MEMBER/HR see only their own data;
  MANAGER defaults to their reporting subtree (self + full team) and may narrow to
  individuals within it; ADMIN defaults to own data and may select Everyone, any
  manager's full team, or any individual. The scope selector only offers options
  the server will accept; single-person scopes hide the Top-contributors panel.

### 4.7 Team & messaging (FR-M)
- FR-M1: Team directory with availability, department, workload.
- FR-M2: Direct messages with threads; inbox drawer + unread badge.
- FR-M3: Messages are strictly private to sender/recipient pairs.
- FR-M4: MEMBER sees only members connected to their projects (plus themselves).

### 4.8 Administration (FR-U)
- FR-U1: User management: create (login + directory entry in one click), edit, delete,
  password reset, project assignments.
- FR-U2: Self-protection: admins cannot demote or delete themselves.
- FR-U3: Workspace settings: defaults (timezone, role, department), password policy,
  capacity, audit limits.
- FR-U4: Configurable domain enums: task statuses, project statuses, event types, tags,
  priorities, departments — with instant cache invalidation on change.
- FR-U5: Role matrix editor (system roles cannot be deleted; roles in use cannot be
  removed).
- FR-U6: Audit log with entity filters and per-entity history (last 50, expandable in
  any edit modal).

### 4.9 Personalisation (FR-S)
- FR-S1: Per-user accent theme (forest/ocean/plum/ember), dark mode, notification
  preferences — persisted server-side per account (no cross-device/cross-account
  leakage) and applied before hydration.
- FR-S2: Command palette (`⌘K` / `Ctrl K`) with keyboard-first navigation.

### 4.10 Bug tracking (FR-B)
- FR-B1: Defect tracker with its own lifecycle: NEW → TRIAGED → IN_PROGRESS →
  RESOLVED → CLOSED, plus REOPENED.
- FR-B2: Severity, assignee, threaded comments; `bug:create` for all roles,
  `bug:edit:any`/`bug:assign` for MANAGER+.

### 4.11 HR module (FR-H) — see docs/HR_MODULE_PLAN.md
- FR-H1 **Leave**: self-service requests for every role with balances per type/year;
  approvals follow the reporting chain (full subtree); configurable leave types &
  policies (`hr:admin`); approved leave surfaces as virtual calendar events.
- FR-H2 **Employee directory**: structured profiles (job title, department, contact
  data, start date) beyond the team roster.
- FR-H3 **Performance reviews**: review cycles with stages, reviewer assignments and
  notes (`review:manage`).
- FR-H4 **Onboarding**: per-new-hire checklists with task-level progress
  (`onboarding:manage`); the seed ships one in progress, one nearly complete.

## 5. Non-functional requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Security | All authorization server-side; every mutation permission-checked + audited; OWASP top-10 basics (CSRF, clickjacking, XSS headers, rate limiting) covered. |
| NFR-2 | Test coverage | ≥90% statements on `src/lib` + `src/server-actions` (enforced by CI gate); browser E2E suite (64 scenarios) for critical journeys incl. HR and accessibility. |
| NFR-3 | Performance | Dashboard: single round trip for all workspace data; config cached 60 s; no client-side waterfalls on first paint. |
| NFR-4 | Accessibility | Semantic roles, focus rings, aria labels on icon buttons; keyboard shortcuts for every view. |
| NFR-5 | Auditability | Every mutating action writes an immutable audit entry; audit writes never break the underlying operation. |
| NFR-6 | Deployability | Single Node process + PostgreSQL; standalone build; secrets via environment only. |

## 6. Acceptance criteria (release gate)

1. `bun run lint && bun run typecheck && bun run test && bun run build` all green.
2. Security suite passes (P0 regressions covered by dedicated tests).
3. Manual test plan (see `TESTING.md`) executed for ADMIN, MANAGER and MEMBER personas.
4. Seeded demo workspace loads in < 3 s on first paint after sign-in.

## 7. Out-of-scope risks & dependencies

- Supabase PostgreSQL pooler (IPv4) is the only supported DB topology.
- Rate limiting is per-process (single-instance assumption).
- No email delivery — notifications are in-app only.
