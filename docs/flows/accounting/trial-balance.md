# Trial balance

The general-ledger report that proves your books balance: one row per account with its opening balance, the period's debits and credits, and its closing balance.

## Who can use this

**Super Admin** only. The trial balance sits in the statutory admin area; anyone else sees a "Super admin only" panel and a **Back to Fernly** link.

## Where to find it

A real URL page, not a sidebar item: `/accounting/trial-balance`. Open the address directly — it is linked from the statutory area's header (labelled **Trial balance**) once you are in that section, alongside **Tax years & slabs**, **Statutory rules**, **Component mapping** and **Employee tax profiles**.

## When to use it

- To check that total debits equal total credits for a period.
- To review account balances before closing a period.
- To close an accounting period once you are confident it needs no further postings.
- To export a period's balances as a CSV for your accountant.

## Before you start

- Payroll must have run: the balances come from journal entries that are posted automatically when payroll runs are locked (marked paid). An empty period shows dashes in the money columns.
- Decide deliberately before closing — a closed period refuses every future posting, and corrections afterwards must be reversal entries in an open period.
- Have an open period available if you still expect postings; closing your only current period makes further payroll posting impossible until a new period exists.

## Steps

Viewing a period:

1. Open `/accounting/trial-balance`. The open period covering today is selected by default; otherwise the latest period.
2. Pick another period from the period selector at the top right (options read like "2026-12 · 14 entries", with "· closed" appended to closed ones).
3. Read the banner above the table: "In balance — total debits $X vs total credits $Y ; opening balances net to zero." or "OUT OF BALANCE — …".

Exporting the report:

1. Select the period you want.
2. Click **CSV**. A file named like `trial-balance-2026-12-01.csv` downloads with the same rows and totals.

Closing a period:

1. Select the period you intend to close (the **Close period** button only appears for an open one).
2. Check the balance banner says "In balance".
3. Click **Close period**.
4. Confirm the result — the period is now marked closed in the selector, and the button disappears.

## What you'll see

- A table with columns: Code, Account, Type (Asset, Liability, Equity, Income or Expense), Opening, Debits, Credits, Closing, ending in a **TOTALS** row.
- Opening comes from all earlier periods; Debits and Credits are this period's movements; Closing is opening plus debits minus credits. Accounts with nothing in a column show a dash.
- The green or red balance banner (see above).
- **Close period** for open periods; nothing of the sort for closed ones — a closed period is read-only history.

## Common problems

**The banner says OUT OF BALANCE.** Total debits and credits disagree. This should not happen from payroll alone, since every posted entry is checked for balance before it is written — investigate recent postings before closing, and do not close the period until it is resolved.

**Close period fails.** The only expected refusal is double-closing:
> That accounting period is already closed.

**A payroll run cannot be posted after you closed its period.** Closing is exactly that: future postings into the period are refused, and the correction path is a reversal entry in an open period:
> Period closed — future postings are refused; corrections must be reversal entries in an open period.

**Numbers you expected are missing.** Only posted entries count as ledger money — entries that are still drafts never appear, and a reversed original plus its reversal net to zero (both stay visible).

**The page shows "not found".** There are no accounting periods set up yet, or the selected period id is invalid.

## What happens behind the scenes

When a payroll run is locked, Fernly automatically posts one balanced journal entry to the general ledger for it — salaries expense debited, and the statutory liabilities (PAYE, student loan, KiwiSaver, ESCT) plus a net pay clearing account credited. The trial balance aggregates those entries per account. Closing a period marks it closed; from then on the books refuse any new posting into it. Corrections are done by reversal: a new entry in an open period that mirrors the original's debits and credits line by line, with the original marked REVERSED but left visible — history is never edited or deleted. There is no reverse button on this page itself; the report and the period close are what it offers.

## Related flows

- [Payroll runs](../payroll/runs.md) — locking a run is what posts the entries shown here.
- [IRD payday filings](../statutory/filings.md) — the filings whose totals must reconcile with these books.
- [Tax setup](../statutory/tax-setup.md) — the rates behind the posted liabilities.
- [Audit log](../admin/audit-log.md) — who closed a period and when.
