# Statutory tax setup (tax years, rules and component mapping)

The super-admin pages that hold the IRD rate tables every New Zealand payslip is calculated from, and the mapping that decides which salary components count as taxable pay.

## Who can use this

**Super Admin** only. The statutory admin area is deliberately closed to Admins and HR — they run payroll but can never rewrite the tax tables. Anyone else who opens these pages sees a "Super admin only" panel and a **Back to Fernly** link.

## Where to find it

Separate admin pages with their own web addresses — they are not in the workspace sidebar. Open the address directly (each page is linked from the area's header once you are in this section):

- Tax years & slabs: `/settings/tax/slabs`
- Statutory rules: `/settings/tax/rules`
- Component mapping: `/settings/tax/component-mapping`

The header labels are **Tax years & slabs**, **Statutory rules**, **Component mapping**, **Employee tax profiles** and **Trial balance**, with a **Back to Fernly** link on the left.

## When to use it

- When IRD changes a rate — new PAYE brackets from a budget, a new ACC earners' levy, a KiwiSaver rate change.
- To check what the current rates are, or to test a salary against them with the simulator.
- When you add a custom salary component and need to say whether it is taxable and which wage base it feeds.
- To close off (archive) an old rate set, or delete one that was never used.

## Before you start

- Know which change you are making and its effective date — effective dating is the whole design here.
- A tax year referenced by locked payroll runs becomes read-only: locked payslips keep the rates they were calculated with. You will be told to create a new version instead:
  > This tax year is referenced by 3 locked payroll runs — locked payslips must keep their rate tables. Create a new version (Statutory rules) instead.
- Only edit rates you have verified against IRD publications; every payslip depends on them.

## Steps

Viewing or directly editing a tax year's rates:

1. Open `/settings/tax/slabs`. Each tax year is a card; the current one is badged "current".
2. Click **Edit slabs** on the year you want to change (only possible when no locked run references it).
3. Edit the rows in the **PAYE (M / ME)**, **Secondary flat rates** and **ESCT tiers** tables — Code, Lower (annual $), Upper (annual $), Rate %, ACC incl. and Order. **Add row** adds a tier; the bin icon removes one (the six secondary codes SB, S, SH, ST, SA and ND cannot be removed).
4. Adjust the single-value rules below the tables: **ACC earners' levy** (Rate %, Max earnings $, Max levy $), **Student loan** (Rate %, Annual threshold $), **KiwiSaver** (Default employee %, Employer %, Allowed employee rates) and **IETC (ME code)** (Amount $, From $, Abates from $, Gone at $, Abate %).
5. Optionally note where the rates came from in **Notes**.
6. Click **Save tax year**, or **Cancel** to discard.

Creating a new version of one rule category (the safe way to change rates):

1. Open `/settings/tax/rules`. Categories: PAYE income-tax slabs, Secondary flat rates, ACC earners' levy, IETC (ME code), KiwiSaver, ESCT tiers, Student loan.
2. Click **New version** on the category you are changing.
3. Set **Effective from** and adjust the pre-filled **New version label** if you like.
4. Edit that category's values only — every other category is cloned unchanged.
5. Click **Create version effective <date>**.

Simulating a payslip against a saved set:

1. On the tax years page, open **Simulate a payslip against "<year>"**.
2. Enter **Gross $**, pick a **Frequency** and **Tax code**, and tick **Student loan (SL)** if it applies (for STC, also the **IR23 certificate rate %** and **ACC treatment**).
3. Click **Simulate** and read the income tax, ACC earners' levy and total statutory deduction.

Mapping a salary component:

1. Open `/settings/tax/component-mapping`.
2. For the component's row, tick or untick **Tax applicable**.
3. Choose a **Statutory category** (Taxable earning, Non-taxable (exempt income), Pre-tax deduction, Post-tax deduction, Employer contribution, or Statistical (never money)).
4. Choose a **Wage base**: "GROSS — taxable gross (PAYE / ACC / SL / KiwiSaver base)" or "NONE — excluded from every statutory wage base".
5. Click **Save** on that row. Save each changed row separately.

## What you'll see

- On the tax years page: each year's label, effective window ("Effective <from> → <to>"), a "current" badge, and an "N locked runs reference this" badge when it is pinned by history.
- On the rules page: read-only summaries of today's values per category, and a **Version history** table (Tax year, Window, Locked runs, Actions) with **Archive** always available and **Delete** only for unreferenced sets (otherwise it reads "Archive-only").
- On the mapping page: rows marked "system" are the seeded catalog and read-only; a "Taxable ↔ category / base contradiction" warning appears when your choices disagree; a banner counts rows with unsaved changes.

## Common problems

**"Edit slabs" does nothing but shows an error.** The year is pinned by locked runs — create a new version on the Statutory rules page instead (see the message under "Before you start").

**The slab tables will not save.** The tables are validated as a whole:
> The PAYE table must start at $0 (the first tier's lower bound).
> PAYE tiers must be contiguous — tier 1's upper bound (15600) must equal tier 2's lower bound (15700).
> The top PAYE tier must be open-ended (no upper bound).
> The secondary table must keep the six IRD codes — missing: SH.

**A new version will not create.** Dates must be after the source set's start, inside its window, and not collide with another set; labels must be unique:
> A tax year labelled "NZ FY2026-27 (1 Apr 2026 – 31 Mar 2027)" already exists.

**Archive fails.** You cannot archive the only set covering today:
> Archiving this tax year would leave no rate set covering today — create a new version first (Statutory rules → New version).

**A mapping row cannot be changed.** Seeded system rows are read-only:
> The row "basic" is system-generated — its tax mapping is read-only.

## What happens behind the scenes

Rate sets are effective-dated: payslips are calculated with the set whose window covers their pay date, and locked payslips keep a frozen snapshot of the rates used. Creating a version clones the current set with only your category changed and closes the old set's window at the effective date — history is never rewritten. The simulator runs the saved set through the same calculation engine payroll uses. Component mapping feeds the same engine: it decides which components build the taxable gross that PAYE, ACC, student loan and KiwiSaver are calculated on.

## Related flows

- [Employee tax profiles](employee-tax-profiles.md) — per-employee declarations layered on top of these tables.
- [IRD payday filings](filings.md) — the rate tables' numbers end up on these filed lines.
- [Payroll runs](../payroll/runs.md) — where the rates are applied.
- [Trial balance](../accounting/trial-balance.md) — the ledger side of payroll.
