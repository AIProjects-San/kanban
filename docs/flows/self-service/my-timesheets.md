# My timesheets

Draft the hours you actually worked, submit them for review, follow their approval, and fix and resubmit a sheet that was rejected.

## Who can use this

Every signed-in Fernly user. You draft and submit only your own hours — the page is tied to your account.

## Where to find it

Sidebar → People → **My Attendance**, then click the **My timesheets** link at the top right. The link opens your timesheet page (`/admin/employees/<your id>/timesheets` — your own page; the address is shown in the browser because this is a real page rather than an in-workspace view).

## When to use it

- At the end of a week or month, to record the hours you worked per day.
- To submit those hours for approval.
- To check whether a submitted sheet has been approved.
- To correct and resubmit a sheet that a reviewer rejected.

## Before you start

- One timesheet covers a period you choose (the editor pre-fills the current month). There is one sheet per period — saving the same period again rewrites its draft.
- Each line needs a work day inside the period and hours between 0 and 24 (quarter-hour steps, e.g. 7.25).
- A submitted sheet cannot be edited until a reviewer decides it; a rejected sheet reopens for editing with the reviewer's reason.

## Steps

**Start a new timesheet**
1. Open your timesheet page (see [Where to find it](#where-to-find-it)).
2. Click **New timesheet**.
3. Set the period with the **From** and **to** date fields.
4. For each line, pick the work day and type the hours.
5. Optionally add a project, a description ("What was worked on"), and tick **Billable** or **Overtime** where they apply.
6. Click **Add line** for each additional day.
7. Click **Save draft** to keep it for later, or **Save & submit** to send it straight for review.

**Submit a saved draft**
1. Find the draft row in the list (status **Draft**).
2. Click **Submit**.

**Resubmit after a rejection**
1. Find the rejected row — the reviewer's reason is shown under the status.
2. Click **Edit**.
3. Correct the lines (the sheet becomes a draft again as soon as you save).
4. Click **Save & submit**.

## What you'll see

The list shows one row per timesheet with its Period, Hours (total), Overtime hours, Status and Actions. Statuses read exactly: **Draft**, **Submitted — awaiting review**, **Approved**, **Rejected — returned to draft**, and **Locked (consumed by payroll)**. Approved rows show who approved them; rejected rows show the reason.

- Rows in **Draft** or **Rejected — returned to draft** offer **Edit** and **Submit**.
- A submitted row shows "Awaiting review" instead of buttons.
- A locked row shows "Consumed by payroll" — its hours have already been paid out and can no longer change.

The editor footer keeps a live "Draft total: … h" as you type. If you have no sheets yet: "No timesheets yet — start one with “New timesheet”."

## Common problems

**A line is refused when saving.**
> Each line's hours must be between 0 and 24.

or

> Each line's work day must fall inside the timesheet's period.

Check the day and hours on the highlighted line.

**The period is refused.**
> The period start must not be after the period end.

Swap the **From** and **to** dates.

**You cannot edit a sheet.**
> That timesheet is awaiting review and cannot be edited. Reject it first to return it to draft.

A submitted sheet waits for its reviewer — ask them to reject it with a reason if it needs fixing, which returns it to you.

**A locked sheet refuses everything.**
> That timesheet is locked — a payroll run already consumed it.

Its hours were already paid; a correction now has to go through HR or payroll.

**You submit an empty sheet.**
> Add at least one line before submitting.

**Your submission is refused because the state changed.**
> That timesheet is no longer in its recorded state — refresh and try again.

Someone (for example HR) acted on the sheet at the same moment — reload the page and submit again.

## What happens behind the scenes

- Saving replaces the whole draft for that period in one go and recalculates the total hours.
- Submitting places the sheet in the review queue. A reviewer who is never you (the four-eyes rule) approves or rejects it; a rejection always carries a reason back to you.
- Approved hours become available to payroll. When a payroll run uses the sheet it is locked — the paid record — and further edits are refused.

## Related flows

- [My attendance](my-attendance.md) — the screen where the **My timesheets** link lives.
- [Timesheet review (HR)](../hr/timesheet-review.md) — the approval side of this flow.
- [My payslips](my-payslips.md) — where approved (and overtime) hours can be paid.
- [Payroll runs (HR)](../payroll/runs.md) — how a run consumes timesheets.
