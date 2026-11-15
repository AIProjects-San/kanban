# Timesheet review

The timesheets review page is the queue where submitted timesheets wait for a decision: approve the hours so payroll can use them, or reject them back to the author with a reason.

## Who can use this

HR users with attendance-management rights (Super Admin, Admin, HR). Approval is four-eyes: nobody can review their own hours, not even an admin. Employees draft and submit their own timesheets from their own timesheet page.

## Where to find it

The page lives at `/admin/timesheets`. The easiest entry is Sidebar → HR → HR Console → Attendance tab → **Timesheets** button. You can also open the address directly, or reach it from the "Timesheets & shifts" header links (Timesheets / Shifts / Roster) on any timesheet or shift page.

## When to use it

- Timesheets are waiting for review before a payroll run.
- You need to check one employee's hours in detail before deciding.
- You want to see which sheets are already approved or locked by payroll.

## Before you start

- Only submitted timesheets can be decided; drafts stay with the author until they submit.
- A rejection needs a reason — it is shown to the author, and the sheet returns to them as a draft they can fix and resubmit.
- A locked timesheet has already been consumed by payroll and can no longer be changed.

## Steps

1. Open the Timesheets page from the Attendance tab's **Timesheets** button.
2. Filter by status with the chips in the header: **All**, **Draft**, **Submitted**, **Approved**, **Locked**, **Rejected**. Each chip is a link, so you can bookmark or share a filtered view.
3. Find a submitted row and review its totals: **Hours**, **Overtime**, period and line count.
4. To see the individual lines, click the employee's name — it opens that employee's full timesheet page.
5. To approve, click **Approve** on the row.
6. To reject, click **Reject**, type the reason in the "Reason for the author…" box that appears, then click **Reject** to confirm. You can back out with **Cancel**.
7. Watch for the confirmation message: "Timesheet approved — the hours are payroll-consumable." or "Timesheet rejected — it returns to the author as a draft."

## What you'll see

- A header with the sheet count, the active status filter and the reminder that "approval is four-eyes: nobody reviews their own hours."
- A table with one row per timesheet: **Employee** (a link, with their line count), **Period**, **Hours**, **Overtime** (highlighted when above zero), **Status** and the **Decision** buttons.
- Status badges: Draft, Submitted — awaiting review, Approved, Locked (consumed by payroll), Rejected — returned to draft. Rejected rows show the reason underneath; approved rows show who approved them.
- In the Decision column, a locked sheet shows "Consumed by payroll"; anything other than a submitted sheet shows a dash.
- The page header offers **Back to Fernly** (the Fernly link, top left) to return to the workspace, plus sibling links to the shift roster pages.

## Common problems

**The Approve button is missing.**
The sheet is not in Submitted status — check the status chips. A locked sheet shows "Consumed by payroll" instead.

**Approval is refused with a four-eyes message.**
It is your own timesheet:

> Four-eyes rule: you cannot review your own timesheet.

**Rejection is refused.**
A reason is mandatory:

> A rejection needs a reason for the author.

**A decision fails because the sheet changed under you.**
Someone else decided it moments before:

> That timesheet is no longer submitted — refresh and try again.

**A sheet cannot be edited or decided at all.**
A payroll run is already using it:

> Timesheet is consumed by an active payroll run — cannot edit

Wait for the run to finish, or use a payroll correction afterwards.

## What happens behind the scenes

Approving marks the hours as payroll-consumable: when a payroll run prices that employee's pay, the approved timesheet's hours (including overtime) can feed the calculation. Rejecting returns the sheet to draft status in the author's own timesheet page, keeping your reason visible to them. Locking happens automatically when a payroll run consumes a sheet — after that its numbers are history. Every decision is recorded in the audit log with your name.

## Related flows

- [Attendance](attendance.md) — the tab whose **Timesheets** button opens this page.
- [My timesheets (self-service)](../self-service/my-timesheets.md) — the employee's side: drafting, editing and submitting hours.
- [Payroll runs](../payroll/runs.md) — where approved hours are paid.
- [Shifts and the roster](../attendance/shifts.md) — the expected-hours side of the same picture.
