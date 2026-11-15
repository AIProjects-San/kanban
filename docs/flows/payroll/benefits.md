# Benefits

Flexible benefits are yearly elections capped by each employee's salary structure: they accrue a little at every payroll run lock, and the accrued balance is claimed as pay through an adjustment.

## Who can use this

**Admin** and **HR** (and **Super Admin**). Employees never see this console. See [Roles](../getting-started/roles.md).

## Where to find it

Sidebar → HR → **Payroll**, then the **Benefits** toolbar button. The modal is called **Flexible benefits**.

## When to use it

- At the start of a year, to record each employee's benefit elections (e.g. health insurance).
- When an employee changes or cancels an election.
- When an employee incurs an expense and wants to claim it from the accrued balance.

## Before you start

- The employee needs an active salary structure — the **Flexible-benefit cap ($/year, 0 = no cap)** on it is the ceiling for elections (see [Salary setup](salary-setup.md)).
- A component code (e.g. `HEALTH`) identifies each election; reuse the same code to re-elect and change the amount.
- Elections accrue only when runs lock — an OPEN run has not accrued yet.

## Steps

### Elect a benefit

1. Click **Benefits**.
2. Pick the **Employee**, type the **Component code** (e.g. `HEALTH`) and a **Label** (e.g. "Health insurance").
3. Enter the **Annual amount** (e.g. 1200).
4. Click **Elect benefit**. The toast confirms: "Benefit election saved — it accrues at each run lock (÷12, paid-days-scaled)."

### Change or cancel an election

1. Find the row under "{year} elections (N)".
2. To change the amount, elect the same component code again with the new annual amount — the re-election replaces the old one.
3. To cancel, click **Cancel** on the row. The toast reads "Election cancelled — the accrued balance stays claimable."

### Claim from the accrued balance

1. On a row with a balance, click **Claim**.
2. Enter the **Amount** (up to the accrued balance), the **Payout period** the claim should be paid on, and an optional **Note (optional)**.
3. Click **Claim**. The toast confirms: "Claim queued — $400 onto the 2027-01 run."

## What you'll see

- Each election row shows the status badge (**ACTIVE** green, **CANCELLED** grey), "name · label · $1,200/year · cap $2,000" and "accrued balance $350.00"; cancelled rows add "cancelled (balance stays claimable)".
- The claim form states the accrued amount it is drawing from, and refuses amounts above it.
- The Payroll console's analytics include a **Benefit claims** card and a "Benefit claims ($ / month)" chart — claims only appear there once their paying run is locked.
- An empty year reads "No elections for 2027 yet."

## Common problems

**An election will not save.**

> The elected annual amount must be positive.

> The workspace caps this employee's benefits at $2,000/year — the new election would total $2,400.

Lower the amount, or raise the structure's **Flexible-benefit cap ($/year, 0 = no cap)** — see [Salary setup](salary-setup.md). The comparison counts the new total, not just this election.

**Electing fails before the form even checks.**

> No active salary structure for this employee — the benefit cap cannot be read.

The employee needs an active structure first.

**A claim will not submit.**

> The claim amount must be positive.

> The 2027-01 run is already locked — pick a later payout period.

Claims pay through adjustments, so the payout month must still be payable.

**The accrued balance is lower than expected.**
Accrual happens at run lock and is scaled by the payslip's paid days — a joiner, a leaver or loss-of-pay in the month accrues less than a full annual ÷ 12 slice.

**A cancelled election still shows a balance.**
That is deliberate — the accrued money stays claimable; only future accrual stops.

## What happens behind the scenes

Every active election accrues when a payroll run locks: the annual amount is divided by 12 and scaled by the slip's paid days, the same window discipline as earnings. A claim writes a payout adjustment queued on the chosen period, so the money reaches the employee through that run like any other adjustment (see [Run corrections](run-corrections.md)). Cancelling stops accrual but never removes the balance.

## Related flows

- [Salary setup](salary-setup.md) — where the benefit cap lives.
- [Monthly payroll runs](runs.md) — the locks that accrue balances.
- [Run corrections](run-corrections.md) — how claim money travels to a payslip.
- [Offboarding](../hr/offboarding.md) — exit statements that account for benefits.
