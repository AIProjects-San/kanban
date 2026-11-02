# Fernly — Product Requirements Document (PRD)

**Version:** 1.0 · **Status:** Live (single workspace deployment) · **Owner:** Workspace admin

---

## 1. Problem statement

Small teams need a lightweight, self-contained workspace to coordinate projects, tasks,
schedules and internal communication without the overhead (and cost) of enterprise
suites. Existing tools either over-serve (Jira/Asana complexity) or under-serve (Trello's
flat boards). Fernly packages the four pillars a 5–30 person team actually uses daily —
projects, a Kanban board, a shared calendar, and person-to-person messaging — behind one
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
| **ADMIN** | Workspace owner. | Everything: user CRUD, role matrix, workspace config, deletions, audit log. |
| **MANAGER** | Team lead. | Create/edit projects, invite members, edit any task, calendar, audit log. Cannot delete projects/users or manage roles. |
| **MEMBER** | Individual contributor. | Create tasks, edit **own** tasks, message, calendar view, analytics. Sees only projects they own/are assigned to/have tasks in. |

The permission matrix is **data** (`Role`/`Permission`/`RolePermission` tables), editable
by admins at runtime, with the code-level matrix in `lib/rbac.ts` as the compile-time
floor.

## 4. Functional requirements

### 4.1 Authentication (FR-A)
- FR-A1: Email + password sign-in; JWT sessions (30-day expiry).
- FR-A2: 5 failed attempts per email **or** IP within 15 minutes locks that vector.
- FR-A3: Self-service password change (requires current password).
- FR-A4: Sign-ins are audit-logged.
- FR-A5: Role changes take effect within 5 minutes without re-login.

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

### 4.5 Calendar (FR-C)
- FR-C1: Month grid with events (type-coded: meeting, deadline, review, social, focus).
- FR-C2: CRUD for events with time + duration + location.

### 4.6 Analytics (FR-N)
- FR-N1: Completion trends, workload per member, project progress, time logged.
- FR-N2: Scoped to the same visibility rules as the dashboard.

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
  preferences — persisted server-side and applied before hydration.
- FR-S2: Command palette (`⌘K` / `Ctrl K`) with keyboard-first navigation.

## 5. Non-functional requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Security | All authorization server-side; every mutation permission-checked + audited; OWASP top-10 basics (CSRF, clickjacking, XSS headers, rate limiting) covered. |
| NFR-2 | Test coverage | ≥90% statements on `src/lib` + `src/server-actions` (enforced by CI gate); browser E2E suite for critical journeys. |
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
