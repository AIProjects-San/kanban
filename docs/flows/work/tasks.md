# Tasks

Plan work on the task board: create tasks inside projects, assign them to project members, drag them through statuses, and log the hours you spend — all tracked against each task's estimate.

## Who can use this

Everyone. Members create tasks and edit the ones assigned to them; Managers and Admins can edit any task they can see. Deleting a task is limited to Admins, the task's assignee, the project owner, or a Manager the assignee reports to.

## Where to find it

Sidebar → Work → **Tasks**. The **New Task** button also appears on the Dashboard, and you can press `N` anywhere in the workspace.

## When to use it

- Breaking a project into concrete pieces of work.
- Assigning work to a colleague and setting a due date and priority.
- Updating progress by dragging a card between columns.
- Recording the hours spent on a task against its estimate.
- Flagging a colleague in a task description with an @mention.

## Before you start

Every task belongs to a project, and its assignee must be a member of that project (see [Projects](projects.md)). If you are not associated with any project yet, you cannot create a task. Statuses are **To do**, **In progress**, **In review** and **Done**; priorities are HIGH, MEDIUM and LOW; tags are FRONTEND, BACKEND, DESIGN, QA and MARKETING.

## Steps

**Creating and assigning a task**

1. Open Sidebar → Work → **Tasks** and click **New Task** (or the + button on any column).
2. Enter a **Title** — the placeholder is "What needs to be done?".
3. Add a **Description** with details, scope or acceptance criteria.
4. Choose a **Status**, **Priority**, **Tag** and **Due date**.
5. Enter an **Estimate (hours)** — the required time for the task.
6. Select a **Project** — the list shows only projects you own or are assigned to.
7. Pick an **Assignee** from that project's team, or leave **— Unassigned —**.
8. Click **Create task**.

**Moving a task through the board**

1. Drag a card onto another column and release. (If you prefer the keyboard, open the task and change its **Status** field instead.)
2. A confirmation appears, such as "Moved to In progress". Clicking a card opens it for editing instead.

**Logging time on a task**

1. Click a task card to open it.
2. Scroll to the **Time log** section — it appears once the task exists.
3. Set the date, type the hours (for example 1.5), and optionally describe "What did you work on?".
4. Click **Log**.
5. To remove an entry, click the trash icon (**Delete time entry**) next to it.

**Mentioning a colleague**

1. While creating or editing a task, type @ followed by the person's name in the **Description** — for example "@Ada Lovelace please review".
2. Save the task. The person receives a notification that you mentioned them.

**Deleting a task**

1. Open the task.
2. Click **Delete** (only shown when your role allows it for that task).

## What you'll see

- The board header reads "N of M tasks · Drag cards between columns to update status".
- Filter chips: **All**, **My tasks**, **High priority** and **Due this week**, plus a project picker (**All projects** or a specific project, with a **Clear** link when active).
- Each card shows its tag, priority, project, assignee avatar, time spent versus estimate (for example "3.5h / 4h", in red when over), a bug count if bugs are linked, and the due date in red when overdue.
- In the task window: the **Time log** header shows "Spent Xh / Required Yh" with a progress bar; **Linked bugs** lists bugs tied to the task with a **— Link an existing bug… —** picker; **History & Audit** expands to a timeline of every change.
- Empty columns invite you: "Drop tasks here or click to add".

## Common problems

**You cannot save a new task.**

> Task must be assigned to a project — pick one first

or, when you have no projects:

> Task must be assigned to a project — you're not associated with any project yet

Ask a Manager or Admin to staff you on a project, then retry.

**The Assignee list is empty or missing someone.**

The list only offers the selected project's team. When it is empty it warns:

> Assign users to this project first (Team → project assignments), then pick an assignee.

Add the person to the project first (see [Projects](projects.md)).

**Time will not log.**

> Hours must be greater than 0 and at most 24

Enter a value above 0 and at most 24 (the field steps in quarter hours). Hours also cannot be logged for a day you are on approved leave, for example:

> You are on approved Annual Leave on 2026-01-15 — hours cannot be logged for that day.

**You cannot delete a time entry.**

> You can only delete time entries you logged.

Managers and Admins can delete anyone's entries; everyone else only their own.

**A drag was refused.**

> You can only edit tasks that are assigned to you.

Members can only move their own tasks; ask the assignee, the project owner, or a Manager to move it.

**Moving a task to another project fails.**

> You can only move tasks to projects you have access to.

Move the task via a project you can see, or ask someone with wider access.

**You want to comment on a task or block it behind another task.**

Task comments and task-to-task dependencies are not available in this release. Use the **Description** with @mentions to bring someone in, and link related defects via **Linked bugs** (see [Bugs](bugs.md)).

## What happens behind the scenes

Saving a task records its fields and updates the assignee's open/completed task counts shown on the Team view. Dragging a card saves the new status and position immediately. Each time entry is stored against the task, the project and you — nobody can log hours for someone else — and feeds the Analytics hours and the "Hours (30d)" figure on your colleague's profile. Deleting a time entry is audit-logged. An @mention in a description (full name, or an unambiguous first name) creates a notification for that person, unless they have turned mention notifications off in Settings.

## Related flows

- [Projects](projects.md) — staff a project before assigning its tasks.
- [Bugs](bugs.md) — link defects to a task and track them on the bug board.
- [Team](team.md) — see workloads and message a task's assignee.
- [Calendar](calendar.md) — put deadlines and meetings on the calendar.
- [My timesheets](../self-service/my-timesheets.md) — your logged hours in review form.
