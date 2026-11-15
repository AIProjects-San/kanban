# Audit Log

The Audit Log records every change made in the workspace — who did what, and when — so you can look back over anything after the fact.

## Who can use this

**Super Admin**, **Admin** and **Manager** — the roles with audit-viewing rights. Other roles do not see this screen in their sidebar.

## Where to find it

Sidebar → Administration → **Audit Log**.

## When to use it

- Finding out who changed something, and when — a task's status, a salary detail, a role, a workspace setting.
- Investigating unexpected or missing changes.
- Reviewing recent activity at a glance — today's actions, the last seven days, who has been active.

## Before you start

- The log fills itself in — there is nothing to switch on and nothing you need to do to record activity.
- The log is read-only: entries cannot be edited or deleted by hand.
- How far back you can see depends on two settings an admin controls in Workspace Config: how long entries are kept, and how many are shown at once (see [Workspace Config](workspace-config.md)).

## Steps

1. Open the screen — the newest actions appear at the top, grouped by day.
2. Type a word into the **Search activity…** box to filter entries by what happened, who did it or what it affected.
3. To see one person's actions, choose their name from the filter next to the search box (**Everyone** shows all).
4. To narrow by area, click a category chip: **All activity**, **Tasks**, **Projects**, **Bugs**, **Hiring**, **People & Access**, **Attendance & Roster**, **Payroll & Loans**, **Calendar**, **Messages** or **Other**.
5. Click **Refresh** to reload the latest entries.
6. Hover over an entry's time (e.g. "2 hours ago") to see its exact date and time.

## What you'll see

- Four summary cards at the top: **Recorded actions**, **Today**, **Last 7 days** and **People involved**.
- A timeline grouped under day headings — **Today**, **Yesterday**, then weekday and date — each with a count of actions.
- Each entry shows the person (avatar, name and role), a plain-language sentence describing the change, the relative time, and a small badge for the kind of thing that was changed.
- A note at the bottom stating how many of the most recent actions are being shown, and that:

   > Read receipts (opening messages, marking notifications read) are intentionally not audited.

- If nothing matches your filters:

   > No activity found

   with the hint "Actions like creating tasks, editing projects, or changing roles will appear here."
- If your role cannot view the log, a panel headed "Audit log restricted" explains:

   > Your role (Member) does not have permission to view the audit log. Only Admins and Managers can see the full history of workspace changes.

- Individual records also carry their own history: the edit window for a task, project or user includes a **History & Audit** section showing just that record's timeline.

## Common problems

**Something you expected to see is missing.**
Either it is older than the retention window — entries are removed automatically once they pass the **Audit retention (days, min 30)** setting — or it falls outside the number of entries shown, set by the **Audit log limit**. Both settings live in Workspace Config's General tab.

**You want to know who deleted or changed a specific thing.**
Search for a word from its name, or filter by the category it belongs to (e.g. **People & Access** for user and role changes), and work down the timeline.

**An entry shows a name you don't recognize.**
The name and role shown are those of the account at the time of the action; if a person's role has changed since, the entry keeps the original.

**You see "Audit log restricted".**
Your role cannot view the workspace log. Ask an Admin, or check the record's own **History & Audit** section if you can open that record.

## What happens behind the scenes

Every significant action — creating, editing, moving or deleting things, signing in, changing roles or settings — writes an entry with the person, the timestamp and a description of what changed. Entries are kept for the number of days set by the audit retention setting and then removed by automatic cleanup; the screen shows only the most recent entries, up to the display limit. Deliberately lightweight actions, like opening a message or marking a notification as read, are never recorded.

## Related flows

- [Workspace Config](workspace-config.md) — the retention and display settings.
- [Managing users](users.md) — the source of many People & Access entries.
- [Managing roles and permissions](roles.md) — role changes appear here.
- [Workspace tour](../getting-started/workspace-tour.md) — finding your way around.
