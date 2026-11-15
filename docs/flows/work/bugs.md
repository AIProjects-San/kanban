# Bugs

Report defects on the bug board and move them through a fixed lifecycle — from **New** to **Triaged**, **In Progress**, **In Review**, **Resolved** and **Closed**, with **Reopened** for regressions.

## Who can use this

Everyone can raise bugs and edit or comment on bugs they reported or are assigned to. Managers can edit and reassign any bug; Admins can additionally delete bugs. Assigning a bug to someone is limited to Managers and Admins.

## Where to find it

Sidebar → Work → **Bugs**. You can also press `G` then `B` from anywhere in the workspace.

## When to use it

- When something is broken and needs a structured report with reproduction steps.
- To triage incoming reports, assign them to a developer, and follow them to resolution.
- To discuss a defect with its reporter or assignee.
- To link a defect to the task it was found in.

## Before you start

Every bug belongs to a project, and only users staffed on that project can be assignees. The lifecycle is strict: each status only allows certain next steps (for example, a **Closed** bug can only be **Reopened**), whether you drag the card or use the buttons in the detail window.

## Steps

**Reporting a bug**

1. Open Sidebar → Work → **Bugs** and click **New Bug**.
2. Enter a **Title** (required) and a **Description** — "What's the bug? When does it happen?".
3. Fill in **Steps to Reproduce**, **Expected Behavior** and **Actual Behavior**.
4. Choose a **Severity** (Critical, Major, Minor or Trivial) and a **Priority** (P0 — Urgent, P1 — High, P2 — Medium, P3 — Low).
5. Select the **Project** the bug belongs to.
6. Optionally pick a **Linked Task** from the same project.
7. Note the **Environment** (for example "Production / Chrome 120 / macOS").
8. Click **Raise Bug**.

**Assigning a bug (Managers and Admins)**

1. Click a bug card to open its detail window.
2. Next to "Assigned to", click **Assign**.
3. Search the project team by name or email and click the person.
4. Click **Unassign** to clear the assignee.

**Resolving and closing a bug**

1. Open the bug — dragging its card on the board works too, but the buttons below are the keyboard-friendly route.
2. In the **Lifecycle** section, click a button such as **→ In Progress** or **→ Resolved**.
3. When moving to **Resolved**, choose a resolution when prompted — Fixed, Won't Fix, Duplicate, Cannot Reproduce or Works as Intended — and optionally add a comment.
4. A **Resolved** bug can later be **Reopened** (if it regresses) or **Closed**.

**Commenting and linking**

1. Open the bug and type in the **Add a comment…** box, then click **Post**.
2. To change the linked task, click **Link** (or **Change**) next to "Linked task" and choose a task from the same project.

**Deleting a bug (Admins)**

1. Open the bug and click **Delete Bug**.
2. Confirm when prompted.

## What you'll see

- Seven board columns — **New**, **Triaged**, **In Progress**, **In Review**, **Resolved**, **Closed**, **Reopened** — arranged side by side with a count on each; the board scrolls horizontally.
- Filters: **All**, **Assigned to me**, **Unassigned** and **Critical + Major**, plus **All severities** / **All priorities** dropdowns and a **Search bugs or linked tasks…** box.
- Each card shows severity, priority, project, the linked task, resolution (when set), assignee and creation date.
- The detail window shows badges, Reporter, Assigned to, Project, Linked task, Environment and Created, then the **Lifecycle** buttons, **Description**, **Reproduction** (steps, expected, actual), **Comments** and the **Bug History & Audit Trail**.
- Empty states: "No bugs yet" — with "Raise your first bug to get started." or "Bugs raised by your team will appear here." — and "No comments yet. Start the discussion."

## Common problems

**A drag bounced back to its original column.**

The move broke the lifecycle rules. The message names the allowed targets, for example:

> Cannot drag from Closed to Triaged. Allowed: Reopened.

Check the **Lifecycle** section in the bug's detail window — it only offers legal next steps.

**You cannot edit or move a bug.**

> You can only edit bugs you reported or are assigned to.

Managers and Admins can edit any bug; otherwise you must be the reporter or assignee.

**Assignment fails.**

> Assign this bug to a project first — assignees must be associated with the bug's project.

The bug must belong to a project, and the assignee must be on that project's team — the panel only lists eligible people and notes "Only users assigned to this project can be bug assignees."

**Linking a task fails.**

> The task belongs to a different project.

A bug can only link to a task in the same project. Move or re-create one of them so they match.

**Deleting is refused.**

Only Admins see **Delete Bug**. Everyone else should move the bug to **Closed** with an appropriate resolution instead.

## What happens behind the scenes

Raising, assigning, commenting, linking and every lifecycle change is saved with an audit entry, which builds the **Bug History & Audit Trail**. Moving to **Resolved** records the resolution and a timestamp; **Reopened** clears them so the bug is active again; **Triaged** and **Closed** also record their first-occurrence timestamps. Comments are stored against the bug and shown to everyone who opens it — no notifications are sent for comments. Deleting a bug removes it permanently from the board. A bug linked to a task shows a bug count on that task's board card (see [Tasks](tasks.md)).

## Related flows

- [Tasks](tasks.md) — the work items bugs are linked to, with their own time tracking.
- [Projects](projects.md) — projects, their members and who can be an assignee.
- [Team](team.md) — message the reporter or assignee to discuss a defect.
- [Dashboard](dashboard.md) — workspace overview including bug-linked tasks.
