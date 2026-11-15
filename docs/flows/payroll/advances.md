# Salary advances

A salary advance pays money to an employee ahead of payday and recovers it automatically through payroll in equal per-paycheck deductions.

## Who can use this

**Admin** and **HR** (and **Super Admin**). See [Roles](../getting-started/roles.md).

## Where to find it

Sidebar → HR → **Payroll**, then the **Advances** toolbar button.

## When to use it

- An employee asks for part of their salary early — e.g. relocation or emergency costs.
- You want the recovery spread over a fixed number of paychecks instead of one hit.

## Before you start

- Decide the amount and how many paychecks recover it (1–24).
- The recovery starts from a period you name in `YYYY-MM` form — that run (or a later one) must still be payable; paid runs never take new deductions.
- An open advance's outstanding is treated as money owed back at exit.

## Steps

### Issue an advance

1. Click **Advances**.
2. In the issue form, pick an **Employee** ("Pick an employee…").
3. Enter the **Amount ($)**.
4. Enter **Installments (1–24)** — how many paychecks recover the advance.
5. Enter the **First recovery period (YYYY-MM)** — the first payroll run that deducts.
6. Optionally type a **Reason (optional)**, e.g. "relocation — deducted over 4 paychecks".
7. Click **Issue advance**. The toast confirms: "Advance issued — 4 recovery installments from 2027-01."

### Watch the recovery

1. Keep the modal open (or reopen it): each advance row shows the **Open** or **Recovered** status chip.
2. Read the line: "$1,200.00 · 4 installments from 2027-01 · issued by Remy Laurent · relocation".
3. The right side tracks the money: "$600.00 outstanding" flips to "recovered", with "2 of 4 installments repaid" underneath.
4. As each covering run locks, its deduction lands on the payslip and the outstanding falls.

## What you'll see

- The modal's description: "Issue an advance — the recovery rides the payroll adapter as per-paycheck deductions, and the outstanding is a full-and-final receivable".
- Each recovery installment appears on the paying payslip as a deduction line; the Adjustments register (see [Run corrections](run-corrections.md)) lists the rows with the source "Salary advance recovery".
- An empty list reads "No advances issued yet."
- The issue form's period field expects the `YYYY-MM` pattern; the button stays disabled until an employee is picked.

## Common problems

**The advance will not issue.**

> The installment plan could not be built from that amount.

Check the amount and installments — the amount must split into positive installments.

**The outstanding is not falling after a run was paid.**
The recovery only books when the run covering the period locks. Check that the run's period matches the installment period and that the run is LOCKED — see [Monthly payroll runs](runs.md).

**An employee left with an advance outstanding.**
Open advances become a receivable on the employee's exit statement — see [Offboarding](../hr/offboarding.md). Recovery through payroll stops with their last payslip.

**You need the money back sooner.**
There is no early-repay button for advances (unlike company loans). Record the recovery as a one-off deduction adjustment on an open run — see [Run corrections](run-corrections.md) — and let the remaining scheduled installments land as they come.

## What happens behind the scenes

Issuing an advance writes the advance record and one queued deduction row per installment, spread over consecutive periods from the first recovery period. Each payroll run consumes the rows whose period it covers and books them as payslip deduction lines; the outstanding is the advance minus what paid runs have returned. When the last installment is consumed the advance flips to **Recovered**.

## Related flows

- [Monthly payroll runs](runs.md) — the locks that book each installment.
- [Run corrections](run-corrections.md) — the adjustment rows behind recovery, and manual alternatives.
- [Company loans](loans.md) — the approval-gated cousin for larger, interest-bearing amounts.
- [Offboarding](../hr/offboarding.md) — where an open outstanding is collected.
