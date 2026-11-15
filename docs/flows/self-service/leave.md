# Leave

See your leave balances, request time off, cancel a request, sell days back (encashment) and claim comp-off days for weekends or holidays you worked.

## Who can use this

Every signed-in Fernly user — leave is self-service for all roles. You only ever see and manage your own requests, balances and claims.

## Where to find it

Sidebar → People → **Leave**.

## When to use it

- To check how many days you have left in each leave type.
- To request leave for a coming period.
- To cancel a request that is still pending, or approved leave you no longer need (the days come back).
- To sell encashable leave days back for money, paid on a payroll run you choose.
- To claim compensatory time off (comp-off) for a weekend or public holiday you worked.

## Before you start

- Only working days (Monday–Friday, excluding holidays) count towards most leave; the request form previews the count live as you pick dates.
- Your manager chain (or an admin) approves or rejects requests — nothing is deducted from your balance until approval.
- Leave types, their rules (notice, maximum consecutive days, documentation) and whether a type is encashable or compensatory are configured by HR. If a button described here is missing, your workspace simply does not have that kind of leave type.

## Steps

**Request leave**
1. Click **Request Leave**.
2. Pick a **Leave type** — the dropdown shows how many days you have available.
3. Set the **First day** and **Last day**.
4. Optionally add a note under **Reason (optional)** ("A short note for your approver").
5. Check the live preview line (working-day count and "N of M available").
6. Click **Submit request**.

**Cancel a pending or approved request**
1. Find the request in the **My requests** list.
2. Click **Cancel** in its row. (Cancelling an approved request restores the days to your balance.)

**Request leave encashment**
1. On a balance card whose type allows it, click **Encash**.
2. Enter the **Days** to sell (quarter-day steps, e.g. 0.25).
3. Choose the **Payout period** (the month the money should land on).
4. Optionally add a **Reason (optional)**.
5. Click **Request encashment**.

**Claim comp-off for time worked**
1. Click **Claim comp-off**.
2. Pick the compensatory **Leave type**.
3. Set **Worked from** and **Worked to** — the days you actually worked (today at the latest).
4. Describe what you did under **Reason (optional)**.
5. Click **Submit claim**.

## What you'll see

- **Balance cards** — one per leave type, showing "N used · N carried over · N entitled" and the big available number ("days left", or "days in advance" if you have gone negative). Encashable types carry an **Encash** button.
- **My requests** — a table of Type, Dates, Days, Status and Decision, with the approver's name and note. Statuses: **Pending**, **Approved**, **Rejected**, **Cancelled**. Pending and approved rows have a **Cancel** button. If you have no requests: "You haven't requested any leave yet. Approved requests appear on the team calendar automatically."
- **My encashments** (once you have any) — Type, Days, Payout run, Amount and Status, shown in capitals: PENDING, APPROVED, PAID, REJECTED. An approved encashment notes "lands on the … run".
- **My comp-off claims** (once you have any) — Type, the Worked dates, Days earned and Status (Pending / Approved / Rejected); approved claims note "days on your balance".

## Common problems

**The start date is too close.** (The message names your leave type and its notice rule — the form shows the rule under the type picker before you submit.)
> <leave type> requires at least <N> working day(s) of notice — the start date is too soon.

**The request spans too many days, or chains with your other requests of the same type.**
> <leave type> allows at most <N> consecutive days — this request spans <days>.

**The dates overlap an existing request.**
> You already have a pending or approved request overlapping those dates.

**The range contains no working days.**
> That range contains no working days (Mon–Fri, holidays excluded).

**You do not have enough days.**
> Insufficient balance: <N> day(s) requested, <M> available for <leave type>.

**Attendance already tells a different story for those dates.**
> Attendance is already marked for <date> (<status>) — those dates tell a different story. Ask HR to clear the marks before requesting leave over them.

**A cancel fails because the request was just decided elsewhere.**
> This request is no longer pending — it was just approved or decided elsewhere. Cancel it again to undo the approved days.

**An encashment is refused.**
Encashment moves in quarter-day steps; there is a per-request cap; and some days must stay in your balance:
> Only <N> day(s) are encashable — <M> day(s) must stay in the balance.

**A comp-off claim is refused.**
Claims only cover weekends and holidays, and HR must have marked you as having worked them. A refused claim names the date and the problem, for example:
> The claim can't be filed — <date> has no attendance marked — ask HR to mark you worked first.

Other per-date reasons include "is a working day — comp-off claims only cover weekends and holidays" and "shows absent attendance — the day wasn't worked".

**There are no leave types at all.**
"No leave types are configured yet — ask HR (or a workspace admin) to add them."

## What happens behind the scenes

- Your request is queued for your approvers, who are notified in the app (and by email if your workspace has leave emails switched on). Approval deducts the days; cancelling an approved request returns them.
- Approved leave automatically appears on the team calendar and marks those days "On leave" in attendance.
- Encashment approval consumes the days and pays them on the payroll run you chose; the amount is fixed at approval (a day is worth your monthly gross divided by that period's working days).
- Comp-off approval credits the earned days to your compensatory balance — a full worked weekend day earns a full day, a half-day mark earns half.

## Related flows

- [Leave requests (HR)](../hr/leave-requests.md) — the approval side of this flow.
- [My attendance](my-attendance.md) — where approved leave shows up as "On leave".
- [My payslips](my-payslips.md) — where encashment payouts and unpaid-leave deductions land.
- [Calendar](../work/calendar.md) — approved leave on the shared calendar.
