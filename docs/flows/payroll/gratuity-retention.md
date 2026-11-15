# Gratuity rules and retention bonuses

Two long-service money tools: the gratuity rule prices the long-service payout line on exit statements, and retention bonuses pay a chosen amount over monthly installments to keep a key person.

## Who can use this

**Admin** and **HR** (and **Super Admin**). See [Roles](../getting-started/roles.md).

## Where to find it

Sidebar → HR → **Payroll**, then the **Gratuity rule** and **Retention bonus** toolbar buttons.

## When to use it

- **Gratuity rule** — configure (once, and after any policy change) how long-service payouts are priced for departing employees.
- **Retention bonus** — commit a bonus to an employee, paid monthly over up to a year.

## Before you start

- The gratuity rule only prices future exit statements — it never changes payslips or past statements.
- A retention bonus's first payout period must still be payable — you cannot queue money onto a period that is already locked.
- The employee is notified in-app and by email when a retention bonus is created.

## Steps

### Gratuity rule

1. Click **Gratuity rule**.
2. Tick **Enabled** — "Price gratuity into full-and-final statements".
3. Set **Earnings averaging (months)** (1–12) — the exit statement averages the employee's earnings over this many months.
4. Edit the slabs under "Slabs — completed years → months of average earnings per year": each row is "from year **to** year **×** fraction **mo/yr**". Leave the "to" year empty for an open-ended band. Use **Slab** to add a row and the bin icon to remove one.
5. Check the live preview — "At a $10,000 average: 3 yr → $X · 5 yr → $Y · 10 yr → $Z" — and the amber disclaimer (below).
6. Click **Save rule**. The toast confirms: "Gratuity rule saved — prices future full-and-final statements." (or "…disabled" when unticked).

### Retention bonus

1. Click **Retention bonus**.
2. Pick the **Employee** and enter the **Total amount**.
3. Enter **Installments (monthly)** — 1 to 12.
4. Set the **First period** the first installment pays on.
5. Optionally type a **Note (optional)**, e.g. "Key contributor retention".
6. Check the split preview — "$1,000 on the 2027-01 run." for one installment, or "4 installments: $250.00/month × 3 + a final $250.00 — 2027-01 through 2027-04." (the last installment absorbs rounding).
7. Click **Create retention bonus**. The toast confirms: "Retention bonus queued — 4 installments from 2027-01; the employee was notified."

## What you'll see

- The gratuity editor's default slabs: 1–2 years pays nothing, 3–4 years 0.25 months per year, 5+ years 0.5 months per year — adjust to your policy.
- An empty slab table states: "No slabs — an enabled rule pays nothing (every year uncovered)."
- The gratuity disclaimer, shown before the save button:

> Gratuity here follows the rule this workspace configured — a contractual estimate, not a statutory Payment of Gratuity computation. Validate the final amount with counsel before paying.

- Retention bonus installments appear on the paying payslips as an earning labelled "Retention bonus — {name}", and as rows in the Adjustments register with the source "Retention bonus" (see [Run corrections](run-corrections.md)).
- The Payroll console's **Incentives given** analytics card counts incentive rows across paid runs.

## Common problems

**The gratuity rule will not save.**

> The earnings averaging window must be 1–12 months.

> Every slab needs a starting year between 0 and 80.

> A slab's last year must be an integer greater than its first year (or empty for open-ended).

> A slab's fraction must be between 0 and 12 months of earnings per year.

> Slabs must not overlap — sort them by starting year and leave gaps open.

Sort the slabs by starting year, remove overlaps, and leave the last band open-ended if it should run to any length of service.

**A slab field is incomplete.**

> Fill every slab field (leave “to” empty for open-ended bands).

**A retention bonus will not create.**

> The bonus total must be positive.

> Installments run from 1 to 12 (monthly payments).

> The total is too small to split over that many installments.

> The 2026-12 run is already locked — pick a later first period.

**The gratuity line on an exit statement is $0.00.**
Either the employee has under one completed year of service (the rule pays nothing), or no earnings basis existed for the averaging window — the statement says which.

## What happens behind the scenes

The gratuity rule is configuration only: when an employee's exit statement is prepared, Fernly walks the completed service years through the slabs and prices "months of average earnings per year of service" from the averaged earnings. A retention bonus writes one queued earning per installment (the last absorbing the rounding remainder) and notifies the employee; each installment then reaches the payslip through the same adjustment consumption as every other queued payment, flipping to paid with its run.

## Related flows

- [Offboarding](../hr/offboarding.md) — the exit statements the gratuity line prices.
- [Run corrections](run-corrections.md) — the adjustment register behind bonus installments.
- [Monthly payroll runs](runs.md) — the runs that pay each installment.
- [Benefits](benefits.md) — the other structure-capped employee money.
