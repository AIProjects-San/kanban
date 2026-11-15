# Run corrections

Four ways to fix pay: one-off adjustments queued onto a run, refunds of loss-of-pay docked on a paid slip, arrears when a paid run falls behind current structures, and withholding to hold an employee's salary over a window.

## Who can use this

**Admin** and **HR** (and **Super Admin**). See [Roles](../getting-started/roles.md).

## Where to find it

Sidebar → HR → **Payroll**. **Adjustments** and **Withholding** are toolbar buttons; **Arrears** sits on each LOCKED run row; **Reverse LWP** sits on a locked payslip that docked loss-of-pay days.

## When to use it

- A bonus, incentive or one-off deduction must land on a specific period — adjustments.
- Attendance was corrected after the run was paid — LWP correction.
- A pay rise should have applied to an already-paid period — arrears.
- Salary must be computed but not paid over a window (e.g. a pending dispute) — withholding.

## Before you start

- Adjustments only land on runs that are still OPEN or do not exist yet — paid runs never take new money.
- The workspace's **Unmarked attendance days** and **Loss-of-pay basis** policies (Sidebar → Administration → **Workspace Config** → **General**) shape what counts as loss-of-pay when runs are created.

## Steps

### Pay adjustments

1. Click **Adjustments**.
2. Pick the **Employee**, type a **Label** (e.g. "Q4 bonus") and optionally a **Catalog code (optional)**.
3. Choose the **Side** (**Earning** or **Deduction**), the **Source** (**Manual** or **Incentive**) and the **Recurrence**: **One-shot**, **Recurring** or **Overwrite a line**.
4. Under **Calc**, pick **Fixed amount**, **% of gross** or **% of net (deductions)** and enter the **Amount** or **Percent (0–100)**.
5. Set the **First period** (and **Through period (optional)** for recurring rows), add a **Note (optional)**, then click **Queue adjustment**.
6. If the run for that period already exists and is OPEN, select it and click **Apply pending adjustments** in its payslips panel. Otherwise the queued rows are consumed automatically when that run is created.
7. Watch the list under "Adapter rows (N)": each row shows **PENDING**, **CONSUMED** (with the paying period) or **SKIPPED** (with its reason).

### Loss-of-pay (LOP) corrections

1. Select a LOCKED run, then click the payslip row that shows "LOP … d".
2. Click **Reverse LWP**.
3. Read the stored facts — days docked, the LOP line amount and the per-day price — and how many days are still reversible.
4. Enter **Days to reverse** (quarter-day steps), the **Payout period** the refund should land on, and an optional **Reason (optional)**.
5. Check the preview ("Refund $345.45 (1.5 day(s) × $230.30/day) onto the 2027-01 run.") and click **Reverse days**.

### Arrears

1. On a LOCKED run row, click **Arrears**.
2. Read the re-simulation table: **Employee**, **Paid**, **Should pay** (under the employees' current active structures), **Arrears** and a **Note** per slip.
3. Set the **Payout period (N employee(s), $X)** for the positive differences.
4. Click **Arrange arrears**. The toast confirms: "Arrears arranged — 2 adjustment(s), $1,150.00 onto the 2027-01 run."

### Withholding

1. Click **Withholding**.
2. In the **New hold** form, pick the **Employee**, the **Hold from (month)**, an optional **Hold until (optional)** month, and a **Reason (optional)**.
3. Click **Hold salary**. Payslips inside the window are still computed, but marked **HELD** and not paid.
4. To pay the held money out, find the hold row (badge **HOLDING**, "held: N slip(s) · $X") and click **Release hold**.
5. Set the **Release payout month** and click **Release $X**. The row flips to **RELEASED**.

## What you'll see

- Adjustment rows read like "Dana White · Q4 bonus · $500 · earning" with "Incentive · one-shot · period 2026-12"; consumed rows add "· paid in 2026-12", recurring rows "recurring through 2027-03" or "recurring (open)". Other sources you may see in the list: Leave encashment, Arrears, LWP credit, Retention bonus, Benefit payout, Withholding release, Salary advance recovery, Loan repayment.
- The LWP modal states the provenance: "Auto-derived at run creation from attendance (absent / half-day) and unpaid or partially-paid leave — saving a different value records a manual override." vs "Manually set by HR — overrides the run-creation derivation."
- Workspace policy notes may appear under the loss-of-pay box: "Workspace policy: unmarked working days count as absent (runs created while the policy is on)." and "Proration basis: LEAVE only — attendance marks never charge loss-of-pay" (or "ATTENDANCE only — leave never charges loss-of-pay").
- Arrears rows with an existing arrangement read "already arranged"; a run with nothing owed says "No arrears owed — every slip paid at least what the current structures would pay."
- Held payslips carry the **HELD** chip and "net held until release"; after release, **RELEASED**.

## Common problems

**An adjustment will not queue.**

> That period is already locked — paid runs never take new adjustments.

> percent modes need a percent between 0 and 100

> a label or a catalog component code is required

Pick a later period, fix the percent, or add a label or code.

**Apply pending adjustments says nothing happened.**

> No pending adjustments for 2026-12.

Either nothing is queued for that period, or the rows were already consumed when the run was created.

**A reversal is refused.**

> Only a PAID slip takes LWP corrections — an open run's slips are edited directly.

> Only 0.5 day(s) are still reversible (1.5 already reversed of 2 docked).

Open-run slips are simply edited; paid slips can only be refunded within the days not yet reversed.

**Arrears refuses to arrange.**

> 2 slip(s) in this run already have arrears arranged (e.g. PS-2026-11-004) — a slip cannot be paid arrears twice.

**A hold will not create or release.**

> The 2026-12 run is already locked (paid) — a hold can only start in a month whose payslips don't exist yet.

> An active hold already covers 2026-12–open-ended — release it before holding again.

> The 2027-01 run is already locked — pick a later release month.

## What happens behind the scenes

Adjustments are queued rows that a run consumes when it is created or when you click **Apply pending adjustments** — each one lands as a payslip line, and the row's status shows which run paid it. An LWP reversal and an arrears arrangement are themselves adjustments (sources "LWP credit" and "Arrears"), so their money arrives the same way — nothing is ever written back into the paid run. Withheld payslips keep their numbers but their nets are excluded from bank exports and analytics until released; releasing writes the held nets onto the chosen run as a payout.

## Related flows

- [Monthly payroll runs](runs.md) — where adjustments land and holds take effect.
- [Salary setup](salary-setup.md) — the structures arrears re-simulates against.
- [Salary history](salary-history.md) — backdated revisions that produce arrears.
- [Withholding release and payslips](../self-service/my-payslips.md) — what the employee sees while held.
