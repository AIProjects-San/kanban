# Projects

Set up the projects that organise your team's tasks, control who works on each one, and track progress from the Projects view and the project detail window.

## Who can use this

Everyone can view projects they have access to. Admins and Managers can create and edit projects; Admins (and Super Admins) can delete them. Managers and Admins can add or remove project members from the detail window.

## Where to find it

Sidebar → Work → **Projects**. Project cards also appear on the Dashboard under **Current Projects**.

## When to use it

- Starting a new piece of work that will contain multiple tasks.
- Changing a project's status, priority, owner or due date.
- Staffing a project — deciding whose names appear as assignable task owners.
- Reviewing progress, membership and change history for one project.

## Before you start

Members and Managers only see projects they own, are staffed on, or have tasks in — Admins see all projects. Task assignees can only be chosen from a project's members, so staff the project before assigning work (see [Tasks](tasks.md)).

## Steps

**Creating a project**

1. Open Sidebar → Work → **Projects**.
2. Click **New Project**.
3. Fill in **Project name** (required) and **Description**.
4. Choose a **Status**: **Running**, **Pending**, **Paused** or **Ended**.
5. Choose a **Priority** (HIGH, MEDIUM or LOW) and a **Due date**.
6. Pick an **Owner** from the team roster, or leave **— Unassigned —**.
7. Select a **Color** for the project's avatar.
8. Click **Create project**.

**Editing a project**

1. Find the project card and click the pencil icon (**Edit**) on it.
2. Change any field — the window is titled **Edit project**.
3. Click **Save changes**.

**Opening the project detail window**

1. Click a project card anywhere in the Projects view (or on the Dashboard).
2. Read the status, priority, due date, description and progress bar ("X% complete", "N/M tasks done").
3. Click **Edit details** to make changes.
4. Expand **Members** to see the roster: the owner is marked **Owner**, and the header shows the head count.
5. Expand **History & Audit** for a timeline of every change to the project.

**Staffing a project (Managers and Admins)**

1. Open the project detail window and expand **Members**.
2. Pick a colleague from the **Choose member…** list.
3. Click **Add**.
4. To remove someone, click the X button next to their row (the owner cannot be removed this way — change the owner in **Edit details** instead).

**Deleting a project (Admins)**

1. Click the trash icon (**Delete**) on the project card.
2. Confirm when prompted.

## What you'll see

- The Projects header summarises your visible projects: "N projects · N running · N ended".
- Filter chips across the top (**All**, **Running**, **Pending**, **Paused**, **Ended**) each show a count, next to the **Search projects…** box.
- Each card shows the project's two-letter avatar, owner, status badge, description, progress bar, priority tag and due date. Overdue projects are highlighted in red.
- Empty states: "No projects yet" with "Create your first project to get started." (or "Ask an admin or manager to create one." if you cannot create projects), and "No projects match your filters." with "Try adjusting your search or filters."

## Common problems

**You cannot see a project you expected.**

Your role scopes the list to projects you own or are staffed on. Ask a Manager or Admin to add you via the project detail window's **Members** section.

**Saving fails with an owner error.**

> Selected owner is not a team member.

Pick an owner from the dropdown list rather than typing a name; the person may have been removed from the team roster.

**The delete confirmation mentions tasks.**

Deleting asks:

> Delete project "Name"? This will also delete all tasks in it. This cannot be undone.

Take it at face value: the project and its tasks disappear from every board. Only Admins see the delete button.

**Members list shows "No members assigned to this project yet."**

Expand the section and use **Add** — if every colleague is already on the project, the list shows "Every team member is already assigned to this project."

## What happens behind the scenes

Creating or editing a project saves its details and records an audit entry listing exactly which fields changed — visible later in the project's **History & Audit**. Adding or removing a member changes who can be picked as a task assignee for that project and who sees the project in their scoped views. Deleting a project hides it and its tasks from the workspace, but an audit record of the deletion is kept. Nobody is sent a notification for project changes, though the affected people will notice the project appearing or disappearing from their own views.

## Related flows

- [Tasks](tasks.md) — create tasks inside a project and assign them to its members.
- [Bugs](bugs.md) — bugs are also filed against a project.
- [Dashboard](dashboard.md) — running projects and progress at a glance.
- [Roles and what they can do](../getting-started/roles.md) — who can create, edit and delete.
