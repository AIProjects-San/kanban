# Company loans

Approval-gated, amortized staff loans: you draft a loan for an employee, a second person approves it, activation writes the installment schedule, and payroll deducts one installment per period as each run locks — until the loan closes or is repaid early.

## Who can use this

**Admin** and **HR** (and **Super Admin**). See [Roles](../getting-started/roles.md).

## Where to find it

Loans live on admin pages with their own web addresses — the console itself only references them:

- **From the Payroll console** (Sidebar → HR → **Payroll**): the **Retry loans** button on a LOCKED run re-runs that run's loan settlement, and loan repayments appear as "Loan repayment" rows in the Adjustments register.
- **The loans overview**: open `/admin/payroll/loans` (header link **Loans** in the payday-filing admin pages). Every active loan, the installment due in a chosen period, and the loan type catalog.
- **An employee's loans**: open `/admin/employees/<id>/loans` (linked from a loan's detail page as "All loans — {name}"). The list of that employee's loans, the create form and the lifecycle actions; each row's **Schedule** link drills into the loan detail page `/admin/employees/<id>/loans/<loanId>`.

## When to use it

- Setting up the workspace's loan types (Housing, Vehicle, Emergency…).
- An employee requests a loan and it needs drafting, approval and activation.
- Reviewing what a period's payroll will deduct, or what a run already deducted.
- Closing a loan early or settling it against exit dues.

## Before you start

- Create at least one active loan type first — the overview page's empty state tells you: "No active loans. Draft one from an employee's loans page."
- The approver must be someone other than the loan's creator and the employee it belongs to.
- The start date must be today or in the future; the loan can be activated on or after it.

## Steps

### Create a loan type (once per scheme)

1. On `/admin/payroll/loans`, click **New loan type**.
2. Enter the **Name** (e.g. "Housing"), the **Annual interest rate (fraction — 0.05 = 5% p.a., 0 = interest-free)**, and optional **Max amount (NZ$)** and **Max term (months)** caps.
3. Leave **Active (selectable for new loans)** ticked and click **Create type**.

### Draft and approve a loan

1. On the employee's loans page, click **New loan**.
2. Pick the **Loan type** — the dropdown shows its rate and caps.
3. Enter the **Principal (NZ$)** and **Term (months)** (1–360).
4. Set the **Start date (first installment due +1 month)** and a **Reason**.
5. Click **Draft loan** (toast: "Loan drafted"). The row appears with status **Draft**.
6. Click **Submit** — the status becomes **Pending approval**.
7. Have a different person click **Approve** (or **Reject**). Approval moves it to **Approved**.
8. On or after the start date, click **Activate** — "Loan activated — schedule written".
9. A mistaken **Draft**, **Pending approval** or **Approved** loan can still be scrapped: click **Cancel**, optionally type a reason, and confirm with **Cancel loan** (**Keep it** backs out).

### Track the repayment schedule

1. Open the loan's detail page (the **Schedule** or **Detail** link).
2. Read the **Amortization schedule** — one row per installment with its due date, the principal/interest split, the total, its status (**scheduled**, **paid**, **skipped**, **written off**) and the paying payslip.
3. The **Repayment history** below lists every repayment event with its source: **Payroll deduction**, **Manual / early** or **Final settlement**.

### Settle or close a loan

1. On the loan detail page, click **Repay early** (active loans with an outstanding balance).
2. Read what will be paid: the outstanding principal plus remaining installments closed out.
3. Enter the **Interest adjustment (NZ$ — the waived future interest)** if you are waiving future interest.
4. Pick the **Source**: **Manual / direct payment** or **Final settlement — deduct from FnF dues**.
5. Add a **Note** and click **Repay $X** — "Loan repaid in full". The loan flips to **Closed (repaid)**.
6. If a run's automatic settlement failed, use **Retry loans** on that run row in the Payroll console.

## What you'll see

- The overview's **Active loans** table: Employee, Type, Principal, Outstanding, the installment **Due in {period}** (e.g. "#4 · $431.25 (2027-01-15)"), and the **Detail** link — "N loans · sorted by outstanding".
- The **Loan type catalog**: name, interest rate ("interest-free" or "5.00% p.a."), caps, and an **active** / **inactive** badge. Note: "The rate a loan snapshots at creation; the caps apply to new loans only."
- Status badges on loans: **Draft**, **Pending approval**, **Approved**, **Active**, **Closed (repaid)**, **Rejected**, **Cancelled**.
- The detail page header: "{rate}% p.a. (reducing balance) · {N} months · started {date} · $X outstanding of $Y".
- On locked runs in the console, the loan settlement retry confirms with "2026-12 loan settlement re-run — 2 installments booked, 1 loan closed." or "No loan settlement pending for 2026-12 — nothing consumed by this run."

## Common problems

**A loan cannot be approved.**

> Four-eyes rule: you cannot approve a loan you created.

> Four-eyes rule: the employee a loan belongs to cannot approve it.

Ask another payroll administrator to approve it.

**Activation is refused.**

> The loan starts 2027-03-01 — it can be activated on or after that date.

**The principal or term is refused.**

> The principal exceeds this loan type's maximum of $10,000.00.

> The term must be 1–360 months.

Edit the loan type's caps if the loan is legitimate, or adjust the request.

**Early repayment is refused.**

> 2 installments were already deducted by a payroll run but not settled yet — settle the run's loans first, then repay the remainder.

Click **Retry loans** on that run in the Payroll console, then repay the remainder.

**A schedule row is still "scheduled" although the run paid.**
The row flips **paid** when the consuming run's settlement completes — use **Retry loans** on that run (see [Monthly payroll runs](runs.md)).

## What happens behind the scenes

Activation writes the amortization schedule (reducing balance) and queues one deduction per installment for payroll. Each payroll run that covers a due date consumes the installment into the payslip; when the run locks, its settlement books the repayment, flips the schedule row **paid** and walks the outstanding balance down — closing the loan at zero. Early repayment records one repayment, closes the loan, and skips every future deduction with a visible reason so no run double-charges.

## Related flows

- [Monthly payroll runs](runs.md) — the locks that deduct and settle installments.
- [Run corrections](run-corrections.md) — the adjustment register where repayments appear.
- [Advances](advances.md) — the lighter, approval-free alternative.
- [Offboarding](../hr/offboarding.md) — final settlement against exit dues.
