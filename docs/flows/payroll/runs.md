# Monthly payroll runs

A payroll run is one pay period for the whole workspace: it creates a payslip for every active salary structure, you correct the slips while the run is OPEN, then you lock the run to mark it paid — after which nothing about it can change.

## Who can use this

**Admin** and **HR** (and **Super Admin**). Payroll is hidden from Managers and Members — see [Roles](../getting-started/roles.md).

## Where to find it

Sidebar → HR → **Payroll**. The console opens on the runs list with the newest run selected.

## When to use it

- Once per pay period, to generate the payslips and pay the period.
- During the period, to fix individual payslips before payment.
- After payment, to export the salary register or bank file, file with IRD, or retry the run's loan settlement.

## Before you start

- At least one employee needs an active salary structure — see [Salary setup](salary-setup.md).
- Check the workspace's payroll policies in Sidebar → Administration → **Workspace Config** → **General**: **Unmarked attendance days**, **Payslip rounding** and **Loss-of-pay basis** apply to runs created while they are set, so check them first.
- Know the pay date: it cannot fall before the period ends, and no more than 7 days after it.

## Steps

### Create a run

1. In the **New run** form, pick a **Cadence** — the dropdown reads **Monthly — calendar month (the default)**, **Bimonthly — twice a month — 1st–15th / 16th–end**, **Weekly — ISO week, Monday–Sunday**, **Fortnightly — two ISO weeks**, **Daily — single day**, **Quarterly — calendar quarter** or **Annual — calendar year**.
2. Enter an **Anchor date (any day in the window)** — any date inside the period you want to pay.
3. Check the live preview under the form: "Window December 2026 · key 2026-12 · snapshots the active monthly structures (annual ÷ windows)."
4. Set the **Pay date (payday)** — it defaults to the window's end and drives the IRD filing deadline.
5. Optionally open **Filter employees (all)** and tick only the people to include.
6. Click **Create run**. A toast confirms, e.g. "Run for 2026-12 created — 5 payslips from the active monthly structures."

### Correct payslips while the run is OPEN

1. Click a run row to load its payslips panel ("December 2026 payslips").
2. Click a payslip row to open it.
3. Edit the lines under **Earnings (monthly)** and **Deductions (monthly)** — use **Add earning** / **Add deduction** for new lines.
4. Set **Loss-of-pay days (pro-rated: gross × days ÷ working days — halves allowed)** if the period has unpaid days.
5. Optionally type a **Note (shown on the printed slip)**.
6. Click **Save payslip**. New Zealand statutory lines (PAYE, KiwiSaver, student loan) recompute automatically on save.
7. Back in the panel, click **Apply pending adjustments** to pull in any adjustments queued for the period.

### Lock (pay) the run

1. On the run row, click **Lock**.
2. Read the inline confirmation "Mark paid & lock?" and click **Lock 2026-12**.
3. The toast "Run locked — the period is paid and immutable." confirms; the badge flips from OPEN to LOCKED.

### After locking

- Click **Register CSV** for the salary register (one row per paid slip, plus a totals row; file `salary-register-2026-12.csv`).
- Click **Bank CSV** for the bank remittance (one payment row per disbursed net; withheld nets stay out and the bank-account column is left blank for your bank to fill).
- Click **Retry loans** to re-run the run's loan settlement if the automatic attempt failed after locking.
- Click the **EI** badge to open the run's IRD filing page — see [IRD filings](../statutory/filings.md).

## What you'll see

- A header line: "N runs · N active structures · signed in as {your name}".
- An amber scope note above the form, starting "Pre-statutory payroll." — it lists regimes Fernly does not compute (PF, ESI, professional tax, TDS, Form 16, investment declarations). NZ statutory lines are still computed automatically on payslips and the EI file is generated from the run's filing page.
- Each run row: the period label (plus a cadence chip for non-monthly runs), "N payslips · gross $X · net $Y", who locked it, and its status badge **OPEN** (amber) or **LOCKED** (green).
- An **EI** badge on locked runs — "EI DRAFT", "EI FILED", "EI AMENDED", "EI ACCEPTED" or "EI REJECTED" — linking to the run's filing page; hover shows the due date. A locked run with no filing yet shows **EI filing…**.
- The payslips panel: slip number, employee, **HELD** / **RELEASED** chips, "gross · deductions · LOP", YTD net and net pay; **Reverse LWP** appears on locked slips that docked loss-of-pay (see [Run corrections](run-corrections.md)).
- The **Analytics** panel: six cards (**Outgoing salary**, **Active salary structures**, **Benefit claims**, two cards for tax-exemption proofs and declarations that Fernly marks as declined, **Incentives given**) and four charts (outgoing salary per month, benefit claims per month, salary by department, salary by job title). It only counts LOCKED runs — until then it says "no locked runs yet — analytics appear once a run is paid".
- Locked payslips open read-only with "The run is locked — this slip is the paid, immutable record.", print formats **Classic** / **Compact** / **Detailed** and a **Print / save PDF** button.

## Common problems

**The run will not create — "A run for 2026-12 already exists."**
One run per period window. Open the existing run instead.

**"No active monthly salary structures — create at least one before running monthly payroll."**
Create or bulk-assign structures first — see [Salary setup](salary-setup.md).

**The pay date is refused.**

> The pay date (2026-12-05) cannot be before the period ends (2026-12-31) — the payday is the day the payment is made.

> The pay date (2027-01-15) is more than 7 days after the period ends (2026-12-31) — check for a typo.

**A payslip will not save on a locked run.**

> The 2026-12 run is locked — payslips are immutable once paid.

Corrections after payment go through [Run corrections](run-corrections.md).

**Two people edited the same payslip.**

> Payslip PS-2026-12-001 was saved by someone else while you were editing. Reopen it to see their changes, then re-apply your edit.

**Loss-of-pay or deductions are refused.**

> Loss-of-pay days (25) can't exceed the 22 working days of 2026-12.

> Total deductions (5,500.00) exceed gross pay (5,000.00) — net pay can't be negative. Reduce loss-of-pay days or deduction lines.

**Some payslips failed at run creation.**
A toast lists each failed slip and its reason: "Fix the cause, then add the payslip(s) to the OPEN run." A second toast may warn that slips were created without statutory lines — "Fix the tax profile, then re-save the payslip to compute them."

**The loan retry says nothing happened.**

> No loan settlement pending for 2026-12 — nothing consumed by this run.

A successful retry reads "2026-12 loan settlement re-run — 2 installments booked, 1 loan closed." — see [Company loans](loans.md).

## What happens behind the scenes

Creating a run snapshots every active salary structure of the matching cadence into payslips (annual amounts ÷ the windows in a year), derives loss-of-pay from attendance and unpaid leave, and prices NZ statutory lines from each employee's tax profile. Locking freezes every payslip, queues payslip emails (if enabled in Workspace Config), posts the run to the general ledger (see [Trial balance](../accounting/trial-balance.md)), consumes scheduled loan repayments into the payslips, flips consumed leave encashments to paid, and accrues flexible-benefit balances. The ledger posting and loan settlement run after the lock commits — a failure never un-pays the run, which is what **Retry loans** is for.

## Related flows

- [Salary setup](salary-setup.md) — the structures a run pays from.
- [Run corrections](run-corrections.md) — adjustments, loss-of-pay reversals, arrears and withholding.
- [IRD filings](../statutory/filings.md) — the EI badge and payday filing.
- [Company loans](loans.md) — repayments consumed by locked runs.
- [Your payslips (self-service)](../self-service/my-payslips.md) — what employees see once a run is locked.
