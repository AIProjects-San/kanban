# Salary history

The salary timeline shows every salary revision an employee has ever had, with the effective dates that decide which salary each payroll run pays from.

## Who can use this

**Super Admin only.**

Payroll admins cannot currently access this page — P2 backlog.

Admins and HR keep full control of salary structures and runs from the Payroll console (see [Salary setup](salary-setup.md) and [Monthly payroll runs](runs.md)); only this timeline page is out of their reach.

## Where to find it

A real web address: `/employees/<id>/salary-history` (one page per employee). Super admins reach it from the employee tax profiles page — open `/employees`, find the employee, click **Salary history** in their row. The page header offers **Back to Fernly** plus the sibling links (**Tax years & slabs**, **Statutory rules**, **Component mapping**, **Employee tax profiles**, **Trial balance**).

## When to use it

- Recording a pay revision with the date it takes effect.
- Checking what salary was in force at any past date (for queries, audits or disputes).
- Backdating a revision after a rise was agreed late.

## Before you start

- The employee needs an open salary assignment — the page states when they do not: "This employee has no open salary assignment — create a salary structure and run the assignment backfill first."
- A revision's effective date must fall after the current assignment's start.
- Past dates need the explicit backdate confirmation; locked periods are never rewritten.

## Steps

### Record a salary revision

1. Open the employee's salary history page.
2. Click **New revision**.
3. Set **Effective from** — it must be after the current assignment's start, which the form states: "Must be after 2026-04-01 (the current assignment's start)."
4. Enter the new **Base (annual, NZD)** and **Variable (annual, NZD)**.
5. Pick the **Reason**: **Revision**, **Promotion** or **Transfer**.
6. If the effective date is in the past, tick the confirmation that reads:

   > The effective date is in the past — tick to confirm a retroactive revision. Already-locked periods are never rewritten; the gap is surfaced as detected arrears.

7. Click **Save revision**.

### Read the timeline

1. Each row shows **Effective from**, **Until** ("— current —" for the open one), **Base (annual)**, **Variable (annual)**, the **Reason** chip (Hire, Revision, Promotion, Transfer), **Recorded by** and the **Status** — **in force** or **closed**.
2. Below, the **Transfers & promotions** section lists the employee's dated employment changes (with links to the **Transfers** and **Promotions** pages) so salary and role changes read as one chronology.

## What you'll see

- The page's one-line explanation: "a payroll run pays from the assignment in force at its window start, so a revision re-prices future windows without rewriting paid history."
- A backdated revision that changes pay warns, for 8 seconds:

> Revision saved — 2 locked period(s) detected in arrears (net $1,150.00). Posting the adjustment is a later step.

- An ordinary revision confirms: "Salary revision saved — the previous assignment was closed and the new one is in force."
- A note under the form: "On submit the current assignment is closed at the effective date and the new one opens — one atomic transaction. A changed base re-prices the salary structure through a cloned row; paid history stays untouched."

## Common problems

**Sign-in is refused with "Super admin only".**
Only the Super Admin role can open this page — the access panel says so and offers a **Back to Fernly** link. Ask your Super Admin to record the revision, or make the change from the Payroll console instead (see [Salary setup](salary-setup.md)).

**The revision will not save.**

> The new effective date must be after the current assignment's start (2026-04-01).

> That effective date is in the past — tick “backdate” to confirm a retroactive revision.

> An assignment already begins on that date for this employee.

**The base will not re-price.**

> This structure has no fixed basic component to re-price — edit the structure directly instead.

Open the structure in the Payroll console and edit its components there.

**Arrears were detected — what now?**
The revision is saved; the gap between the old and new pay for the locked periods is listed but not paid. Post it through the Arrears tool on the affected run — see [Run corrections](run-corrections.md).

## What happens behind the scenes

Saving a revision closes the current assignment on the eve of the new effective date and opens the new one in the same step — pay changes never edit an existing structure row, so every past run keeps the salary it was paid with. When the annual base changes, the structure is cloned with its basic component re-priced and the old row retired (kept as history). Future runs then pay from the new numbers, and any locked periods between the old and new effective dates surface as detected arrears rather than being silently rewritten.

## Related flows

- [Salary setup](salary-setup.md) — the structures behind the timeline.
- [Run corrections](run-corrections.md) — arranging the arrears a backdate detects.
- [Transfers and promotions](../hr/transfers-promotions.md) — the employment changes listed alongside.
- [Employee tax profiles](../statutory/employee-tax-profiles.md) — the index page this timeline opens from.
