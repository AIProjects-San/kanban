# Leave, encashment and comp-off approvals

The Requests tab of the HR console is the one place where you approve or reject every people-related request: ordinary leave, leave encashment (days sold back for pay) and compensatory-off claims (days earned for working a holiday).

## Who can use this

HR admins (Super Admin, Admin, HR) see and decide the whole workspace's requests. Managers see the same tab but only for their own team, and can only decide requests from people who report to them (directly or further down). Members do not see the HR console — they file their requests from their own Leave screen.

## Where to find it

Sidebar → HR → HR Console → Requests tab. The tab opens first when you enter the console.

## When to use it

- A leave request, encashment request or comp-off claim is waiting for a decision.
- You want to review the history of past requests (approved, rejected or cancelled).
- You need to correct someone's leave balance (HR admins only).
- You want to check everyone's leave balances for the year (Balances tab).

## Before you start

- Requests you can decide show a **Decide** button (leave) or **Approve** / **Reject** buttons (encashment and comp-off). Your own requests never show decision buttons — you cannot approve yourself.
- Managers only see their own team's requests; the header says "your team". For HR admins it says "whole workspace".
- A rejection is final for that request — the employee can file a new one if needed.

## Steps

1. Open Sidebar → HR → HR Console and stay on the Requests tab.
2. Use the filter chips — **Pending**, **Approved**, **Rejected**, **Cancelled**, **All** — each shows its count in parentheses. **Pending** is selected by default.
3. Find the row and click **Decide**.
4. Read the summary (employee, leave type, dates, working days and the reason, if given).
5. Optionally type a note in **Note (optional — shown to the requester)** — e.g. why you are rejecting.
6. Click **Approve** or **Reject**. A confirmation message appears ("Request approved" or "Request rejected") and the queue reloads.
7. For an encashment request, use the **Approve** / **Reject** buttons directly on the row — there is no extra form.
8. For a comp-off claim, use the row's **Approve** / **Reject** buttons the same way.
9. To correct a balance (HR admins only), click **Adjust a balance**, pick the **Member**, **Leave type** and **Year**, enter a signed day amount (e.g. 2 or -1.5), write the required reason and click **Write adjustment**.

## What you'll see

- A table of leave requests: **Member**, **Type** (with its colour dot and the employee's reason underneath), **Dates**, **Days**, **Status**, **Decision** (who decided and their note).
- An "Encashment requests" card below it (only when there are any): **Member**, **Type**, **Days**, **Payout run** (the payroll period the money lands on) and **Reason**, with an "N pending" counter.
- A "Comp-off claims" card (only when there are any): **Member**, **Type**, **Worked** (the dates claimed), **Days earned** and **Reason**.
- The **Adjust a balance** button on the right of the filter row (HR admins only). The form warns that adjustments are audited corrections — they never rewrite history.
- On the Balances tab: one row per leave type × employee for the chosen year, with **Opening**, **Allocated**, **Taken**, **Expired** and **Closing** columns, a year switcher, a search box, a leave-type filter and a **CSV** export button.

## Common problems

**The Decide button is missing.**
The request is not Pending (switch the filter to see its current status), or it is your own request.

**You clicked Approve but got an error.**
Someone else decided or cancelled the request moments before you:

> This request is no longer pending — it was just decided or cancelled elsewhere. Refresh and try again.

**Approval fails with an insufficient balance message.**
The employee's balance changed since they filed (for example, another request was approved first). The message reads, with the real numbers filled in:

> Insufficient balance: 5 day(s) requested, only 2 day(s) left for Annual Leave.

**A balance adjustment is refused.**
It would push the employee past the negative floor set on that leave type's policy:

> This adjustment would leave Priya at -6 day(s) — past the −5-day advance floor for Annual Leave. Reduce the correction, or raise the floor in the type's policy first.

Reduce the correction, or raise the floor on the type first (see [Leave types, policies and holidays](leave-config.md)).

**An employee is missing from the Balances tab.**
Members with no leave activity at all for the year are left out — balances appear once someone first requests leave or the yearly allocation runs.

## What happens behind the scenes

Approving a leave request consumes the days from the employee's balance on the date the approval is made, and the employee is notified. Rejecting changes nothing except the request's status. Approving an encashment converts the days into a pay adjustment on the chosen payroll run; approving a comp-off claim adds the earned days to the compensatory leave type's balance. Every decision and every balance adjustment is written to the audit log with your name, so history can always be traced.

## Related flows

- [Leave types, policies and holidays](leave-config.md) — configuring what can be requested and how balances grow.
- [Requesting leave (self-service)](../self-service/leave.md) — the employee's side of this flow.
- [Attendance](attendance.md) — approved leave automatically marks attendance "On leave".
- [Payroll runs](../payroll/runs.md) — where approved encashment money is paid out.
