# Onboarding checklists

The Onboarding tab of the HR console tracks every new hire's onboarding checklist: what still needs doing, who owns each task, and whether the required tasks are done.

## Who can use this

HR admins and managers view the tab; HR admins create checklists and edit the workspace template. Tasks are ticked by whoever they are assigned to — the hire, their manager, a named person, or anyone holding a role such as HR.

## Where to find it

Sidebar → HR → HR Console → Onboarding tab.

## When to use it

- A new hire has joined (or is about to) and their onboarding needs tracking.
- You want to change the standard task list every future checklist starts from.
- You need to add a one-off task to someone's checklist.
- Checking progress — including required tasks that are still open.

## Before you start

- Checklists come from the workspace's default template: every new checklist — including the one created automatically when a candidate is marked joined — starts from the template's active tasks.
- Template tasks have a due day counted in working days after the checklist starts; due dates skip weekends and holidays.
- Required tasks are flagged for the completion gate; a checklist is not complete while any are open.

## Steps

1. Open Sidebar → HR → HR Console → Onboarding tab.
2. Review the "Default templates" section at the top: one list for **Onboarding (new hires)**, one for **Separation (exits)**.
3. To change the template, click **Add / edit template task**, fill in **Kind**, **Due day (working days after the checklist starts)**, **Task title**, the **Assignee** (the hire's manager, the hire themself, one named user, or everyone holding a role), and tick **Required** or **Active (instantiated)** as needed. Click **Save task**.
4. To start a checklist for a hire, click **New Checklist**.
5. In "Start onboarding", pick the **New hire**, give the **Checklist title** (e.g. "November 2026 onboarding"), and optionally set **Start date (due dates count working days from here)** — empty means the hire date on file, or today.
6. Leave "Start from the default template" ticked so manager tasks are auto-assigned, then click **Create checklist**.
7. To add a one-off task, click the plus icon on a checklist card, fill in **Task title**, **Assignee** (or "Unassigned (HR picks up)"), **Due (working days after start)** and optionally **Required task**, then click **Add task**.
8. Tick tasks as they are completed — anyone can tick from this tab; assignees also see their own tasks in their settings.

## What you'll see

- One card per hire: title, hire name, "done/total tasks", a progress bar, and a status chip — "not started", "N% in progress" or "complete".
- A warning line "N required open" while required tasks are still open.
- Each task row shows its assignee ("@Priya", "the HR role", "unassigned"), its due date ("due 14 Nov") or due day ("due day 3"), and who completed it. Overdue open tasks are highlighted.
- Template rows show "day N · <assignee> · required" chips, with active counts per group.
- Confirmation messages: "Onboarding checklist created", "Task added", "Template task saved."

## Common problems

**No checklists are showing.**
Checklists appear here only for onboarding; separation checklists live in the Offboarding tab.

**A task cannot be ticked.**
Completed checklists are closed:

> This checklist is already complete — create a follow-up checklist instead.

**Due dates look wrong.**
They are working days from the checklist's start date and skip weekends and holidays — check the start date you used, and the holiday calendar.

**The hire can't see their tasks.**
The hire sees tasks assigned to them (or to "the hire themself") in their own settings under My onboarding. Unassigned tasks are picked up by HR.

**A new hire has no checklist.**
One is created automatically when a candidate is marked joined. For hires who joined before the template was set up, create one with **New Checklist**.

## What happens behind the scenes

The default template is the single source: every new checklist — manual or automatic — is instantiated from its active tasks, with due dates walked forward over working days. Completion is derived from the task rows, not typed in: a checklist is complete when all tasks are ticked, and required tasks are additionally flagged for gates that wait on them. Each tick records who did it and when, and the changes appear immediately for the assignee in their own view.

## Related flows

- [Offboarding](offboarding.md) — the separation twin of this flow.
- [Marking a candidate joined](../recruitment/mark-joined.md) — the step that creates the automatic checklist.
- [Employee directory](directory.md) — the hire's profile and documents.
- [Reviews](reviews.md) — opening the probation review that follows onboarding.
