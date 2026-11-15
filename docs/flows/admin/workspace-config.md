# Workspace Config

Workspace Config is the admin control panel for the workspace's name and defaults, its pick-lists (statuses, event types, tags, priorities, departments), its roles and the wording of its notifications.

## Who can use this

Workspace admins — **Admin** and **Super Admin**. Other roles do not see this screen in their sidebar.

## Where to find it

Sidebar → Administration → **Workspace Config**. The tabs across the top are **General**, **Task Statuses**, **Project Statuses**, **Event Types**, **Tags**, **Priorities**, **Departments**, **Roles & Permissions** and **Notifications**.

## When to use it

- Rename the workspace or change the defaults applied to new people.
- Adjust the joining rules for new hires, or how long the audit log is kept.
- Add, rename or tidy the pick-lists used by tasks, projects, the calendar, tags, priorities and departments.
- Customize what Fernly writes in its notifications.

## Before you start

- Changes apply to the whole workspace as soon as they are saved — there is no draft mode.
- Each tab saves separately: finish one tab (click its save or create button) before moving to the next.
- Some pick-list entries cannot be deleted while records still use them — move those records first.

## Steps

### General

1. Adjust the fields you want to change.
2. Click **Save settings** (bottom right).

The main fields:

- **Workspace name** — the workspace's display name.
- **Default timezone**, **Default role for new users**, **Default department**, **Default avatar color**, **Default job title** — starting values used for new people.
- **Min password length** — the minimum length for every password set in the workspace (never below 8).
- **Workload full capacity (open tasks = 100%)** — how many open tasks count as a completely full workload.
- **Audit log limit** — how many of the most recent actions the Audit Log screen shows at once.
- **Audit retention (days, min 30)** — how long audit entries are kept before automatic cleanup removes them; the smallest accepted value is 30 days and the largest is 3650 (about ten years).
- **Retirement age (years, blank = off)** — used only for a display projection in the employee directory; leave blank to switch it off.
- **Joining gate** — when ticked:

   > A candidate can only be marked joined when every mandatory document is VERIFIED and every background check is terminal (cleared or flagged). Turn off for the advisory-only flow.

- The remaining fields set attendance and payroll behaviour: **Attendance day start (HH:MM)** and **Attendance day end (HH:MM)**, **Unmarked attendance days** (Ignore / Count as absent), **Payslip rounding**, **Fiscal year starts**, **Loss-of-pay basis**, **Pay attendance overtime into payroll**, **Show leave balances on payslips**, **Email payslips when a run locks**, **Email leave notifications**, **Auto-draft leave encashment**, the reminder switches (**Birthday reminders**, **Work-anniversary reminders**, **Upcoming-holiday reminders**, **Holiday reminder — days ahead**, **Email engagement reminders**, **Interview reminders**, **Email interview reminders**). Most email switches are off by default — in-app notifications stay on regardless.

### Task Statuses, Project Statuses, Event Types, Tags, Priorities

These five tabs share one list editor:

1. Click **Add item**.
2. Fill in the **New item** form (the fields differ per tab — see below).
3. Click **Create**.

To change an entry, click **Edit** on its row, change the fields and click **Save**. To remove one, click **Delete** and confirm.

- **Task Statuses** — fields: **Key**, **Label**, **Accent class**, **Sort order**. These become the columns of the task board.
- **Project Statuses** — fields: **Key**, **Label**, **Badge class**, **Dot class**, **Sort order**.
- **Event Types** — fields: **Key**, **Label**, **Dot class**, **BG class**, **Sort order** — the colour categories of calendar events.
- **Tags** — fields: **Key**, **Label**, **Color (oklch)**, **Sort order**.
- **Priorities** — fields: **Key**, **Label**, **Color (oklch)**, **Sort order**.

### Departments

The same simple list editor, with **Key**, **Label** and **Sort order**. This pick-list feeds the **Default department** setting on the General tab and the department carried on team records. It works together with the HR module's richer Departments master: when someone joins, Fernly automatically makes sure a matching department exists there, where HR can then add details like a code, a parent department or a cost centre — see [HR masters](../hr/masters.md).

### Roles & Permissions

Create custom roles and tick which permissions each role has. The steps are on their own page: [Managing roles and permissions](roles.md).

### Notifications

1. Open the card for the event you want to change — e.g. "Leave request awaiting approval", "Birthday digest" or "Interview today (interviewer nudge)".
2. Edit **In-app title**, **Email subject**, **In-app message** or **Email body (plain text — the Outbox audit copy)**.
3. Check the live **Preview (sample values)** under the fields.
4. Click **Save**. To return an event to its built-in wording, click **Reset**.

Each card shows a badge — "System default" or "Customized" — and chips listing the placeholders the event provides, such as `{{requesterName}}`. As the tab's footer explains:

> Placeholders use {{name}} — the chips above each field list what the event provides, and saving refuses an unknown name so a typo can never blank a field.

Email versions of these notifications only send when the matching email switch on the General tab is on; in-app notifications are always sent.

## What you'll see

- A row of nine tabs; the open tab's content below it.
- List tabs show "N items" and an **Add item** button; each row shows its label, a colour swatch where relevant, its key, then **Edit** and **Delete**.
- A yellow banner at the top of the General tab when no mail provider is configured. It starts "No mail provider configured." and means offer, welcome and rejection emails are recorded as skipped rather than delivered — whoever runs your Fernly server needs to switch mail delivery on.
- Pop-up confirmations after each save: "Workspace settings updated", "Created", "Updated", "Deleted".

## Common problems

**A list entry cannot be deleted.**

   > Cannot delete — 3 tasks still use "IN_PROGRESS". Reassign them first.

Move the affected records to another status, tag or priority first (the message names what and how many). The same applies to departments still used by members, and to project statuses and event types in use.

**The General tab will not save.**
Check **Audit retention (days, min 30)** and the other number fields are within their stated ranges, then click **Save settings** again.

**A status, tag or colour change is not visible yet.**
Refresh the workspace or reopen the screen you expected to see it in — pick-list changes reach open screens on their next load.

**Notification emails are not arriving.**
Customizing a template only changes the wording. Emails also require the matching switch on the General tab (e.g. **Email leave notifications**) and a configured mail provider — see the yellow banner.

## What happens behind the scenes

Every change made in Workspace Config is recorded in the audit log. Before a pick-list entry is deleted, Fernly checks that no tasks, projects, events or members still use it, so records are never left pointing at a missing value. The audit retention setting drives an automatic cleanup that removes audit entries older than the window, while the separate audit log limit only controls how many entries are displayed. Joining-gate and payroll settings take effect for actions from that point on — records already created keep what they were given.

## Related flows

- [Managing roles and permissions](roles.md) — the Roles & Permissions tab in depth.
- [Managing users](users.md) — the defaults set here are used when creating people.
- [Audit Log](audit-log.md) — the retention and display settings in action.
- [HR masters](../hr/masters.md) — the HR side of departments.
- [Marking a candidate as joined](../recruitment/mark-joined.md) — where the joining gate bites.
