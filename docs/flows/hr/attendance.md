# Attendance records

The Attendance tab of the HR console is a month grid where HR keeps one attendance record per person per day: reviewing what has been marked, correcting mistakes, and marking days that are missing.

## Who can use this

HR users with attendance-management rights (Super Admin, Admin, HR). Employees never mark their own attendance here — they only view their own record from their My Attendance screen.

## Where to find it

Sidebar → HR → HR Console → Attendance tab.

## When to use it

- Regularly, to mark who was present, absent, on half day or working from home.
- To fix a wrongly marked day, or remove a record that should not exist.
- To review a month before payroll, since absent days can reduce pay.
- To export the month's attendance sheet as a CSV file.

## Before you start

- One record per person per day — if a record exists, the grid cell opens it for editing; if not, it starts a new one.
- "On leave" cells are derived automatically from approved leave. They are read-only unless you overwrite them with an explicit mark, which always wins.
- Weekends and calendar holidays are shaded and cannot be marked — they never charge loss of pay.
- In and out times are optional; when you enter them, Fernly shows a live preview of the late/early facts based on the workspace's reference day.

## Steps

1. Open Sidebar → HR → HR Console → Attendance tab.
2. Pick the month with the arrows, the month picker or the **Today** button.
3. Click any empty cell to mark that person's day, or click **Mark a day** in the header and choose the **Member** and **Date** in the dialog.
4. Choose the **Status**: Present, Absent, Half day or WFH.
5. Optionally enter **In (optional)** and **Out (optional)** times and a **Note (optional)** (e.g. "Left early — dental appointment").
6. Click **Mark day**. The cell fills with the status letter.
7. To correct an existing record, click its cell, adjust the fields and click **Save changes**.
8. To remove a record entirely, open it and click **Remove record**.
9. To export the month, click **Sheet CSV**.
10. To review submitted timesheets or the shift roster, use the **Timesheets** and **Roster** buttons in the header (they open separate admin pages).

## What you'll see

- A legend of the five statuses with their one-letter grid codes: Present (P), Absent (A), Half day (H), WFH (W), On leave (L).
- One row per member, one column per day of the month, with weekend and holiday columns shaded.
- Hovering a cell shows its details: person, date, status, in/out times, any derived timing facts and the note.
- A **Timesheets** button ("Review submitted timesheets (actual hours)") and a **Roster** button ("The shift roster (expected hours)") linking to the admin pages at /admin/timesheets and /admin/shifts/roster.
- Confirmation messages such as "Priya marked PRESENT on 2026-06-03" or "Attendance updated — Priya, 2026-06-03".

## Common problems

**A cell cannot be marked.**
It is a weekend or a holiday:

> 2026-06-06 is a Saturday — attendance is not marked on non-working days (they never charge loss-of-pay either).

**Saving says a record already exists.**
Click the existing cell and edit it instead of creating a second one:

> Priya already has an attendance record for 2026-06-03 — one record per person per day. Edit the existing record instead.

**A record cannot be moved to another person.**
Delete it and mark the correct member instead:

> An attendance record cannot move between people — delete it and mark the other member instead.

**An "On leave" day is wrong.**
Check the leave request itself on the Requests tab — the cell mirrors approved leave. Overwriting it here replaces the derived mark with your explicit one.

**A day is missing but payroll already ran.**
Corrections apply going forward; an already-locked payroll run keeps the attendance it was priced from. Use a payroll correction for past months.

## What happens behind the scenes

Each mark is stored as a single record per person per day, owned by HR. Approved leave automatically appears as "On leave" without anyone marking it, and an explicit HR mark overrides that derivation. Absent and half-day statuses feed loss-of-pay calculations when payroll runs are created, depending on the workspace's unmarked-day setting; biometric punches and timesheets are separate surfaces that HR reconciles with this grid. Every mark, edit and removal is written to the audit log.

## Related flows

- [Leave, encashment and comp-off approvals](leave-requests.md) — approvals that create the derived "On leave" cells.
- [Timesheet review](timesheet-review.md) — the submitted-hours queue reachable from this tab.
- [Leave types, policies and holidays](leave-config.md) — the holiday calendar that shades the grid.
- [My attendance (self-service)](../self-service/my-attendance.md) — what employees see of their own record.
- [Payroll runs](../payroll/runs.md) — where attendance outcomes affect pay.
