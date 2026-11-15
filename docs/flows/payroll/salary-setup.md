# Salary setup

How Fernly knows what to pay: the component catalog defines your workspace's pay vocabulary, each employee's salary structure holds their annual components, and effective dates decide which structure a payroll run pays from.

## Who can use this

**Admin** and **HR** (and **Super Admin**). See [Roles](../getting-started/roles.md).

## Where to find it

Sidebar → HR → **Payroll**. The toolbar at the top of the console has the **Component catalog** and **Salary structure** buttons, and the run form has **Bulk assign**. The **Salary structures** panel at the bottom lists every structure.

## When to use it

- Once, to define the components your workspace pays (basic salary, allowances, deductions).
- When an employee joins, moves to a new package, or gets a pay change.
- When many employees move to the same package at once.

## Before you start

- Structures store annual amounts; monthly payslips divide them by 12 (or by the windows in a year for other cadences).
- Every structure keeps its own copy of each component — editing the catalog later never rewrites a saved structure or payslip.
- New hires who signed an offer in Fernly can copy their structure from it in one click.

## Steps

### Component catalog

1. Click **Component catalog**.
2. Click **+ Add component definition**.
3. Fill in **Code** (lowercase, e.g. `basic`), **Label** (e.g. "Basic Salary"), **Kind** — **Earning**, **Employer**, **Deduction** or **Statistical (info)** — and **Mode**: **$/yr**, **% basic**, **% gross** or **% net** (deductions only).
4. Enter the **Suggested $/yr** amount or **Percent**, and a **Sort** order for the picker.
5. Leave **Scales with payment days (uncheck = flat / window-exempt)** ticked unless the line pays flat regardless of paid days and loss-of-pay; leave **Active (offered in the picker)** ticked.
6. Click **Add component**.
7. To change a row later, click **Edit**; to remove a typo, click the bin icon and confirm with **Delete** (or **Keep**). Retiring is the reversible alternative to deleting.

### Salary structures

1. Click **Salary structure** (or click a row in the **Salary structures** panel to revise it).
2. Pick an **Employee** and the **Effective from** date.
3. Choose the **Pay cadence (P10)** the structure pays on.
4. Edit the **Annual components**: type a label, pick the kind and mode, and enter the amount. Use **Add blank component**, or pick from **Add from catalog…** to prefill a curated definition.
5. For earnings, leave **day-scaled** ticked so the line is docked by loss-of-pay and the employment window; untick for flat lines.
6. Check the totals — **Annual earnings**, **Employer / yr**, **Annual CTC**, **Monthly gross**. To hit a target package, use **Solve base for target CTC** and click **Solve**.
7. Optionally set the **Flexible-benefit cap ($/year, 0 = no cap)**, tick **Workspace default package — new structures prefill from this one**, or add **Opening YTD balances (annual, earned before Fernly)** for mid-fiscal-year joiners.
8. Click **Save structure** (or **Save revision** when editing). For a new joiner with a signed offer you can instead click **Copy from signed offer**.

### Structure assignments (effective dating)

1. Runs pay from the structure in force at the period's start — saving a structure with a later effective date retires the previous one (kept in the panel as **HISTORY**; only one per employee stays **ACTIVE**).
2. The dated assignment timeline — which window each structure covers — is maintained on the Salary history page; see [Salary history](salary-history.md) for revisions and backdating.
3. A pay revision with a past effective date never rewrites locked runs — the gap surfaces as arrears (see [Run corrections](run-corrections.md)).

### Bulk assign

1. Click **Bulk assign** in the run form.
2. Pick **Copy components from (an active structure)** — its components and cadence become the template.
3. Set **Cadence**, **Effective from** and optional **Notes (audit only)**.
4. Tick employees in the list (**Select all** / **Clear**); rows note when this "replaces monthly structure".
5. Click **Assign to N employee(s)**.

## What you'll see

- The catalog list shows each code, label, kind, suggested amount ("$60,000/yr", "8% gross"), a **window-exempt** chip where relevant, and active rows in normal text with retired ones struck through.
- The structures panel shows the **ACTIVE** / **HISTORY** badge, the **DEFAULT PKG** chip on the default package, "N components · effective {date} · from signed offer", the annual CTC and the monthly gross.
- In the structure editor, percent lines show their resolved annual amount beside the row; a percent-of-net line shows "at payroll". If a catalog component's validity window does not cover the effective date you see: "Outside the catalog window at 2026-12-01: travel — starts 2027-01-01. Saving will be refused until the effective date or the component changes."
- Bulk assignment confirms with "Bulk assignment done — 4 replaced, 2 first structure(s)."

## Common problems

**A catalog row will not save.**

> A code and a label are required.

> Code "basic" is already in the catalog — one component per code. Edit the existing row instead.

**A structure will not save.**

> A structure needs at least one component.

> Priya Shah already has a structure effective 2026-12-01 — revise it or pick another effective date.

> Component "travel" is not in its catalog window (2027-01-01 → —) at the structure's effective date 2026-12-01.

Move the effective date past the window, or remove the component.

**Copy from signed offer fails.**

> No signed offer found for this employee.

The hire must have signed an offer in Fernly first — see [Offer signing](../recruitment/offer-signing.md).

**Bulk assignment did nothing.**

> Bulk assignment created no structures — 2 failure(s): Priya Shah (…); Sam Ngata (…).

The toast names each employee and the reason — fix those (usually a same-day structure clash) and run it again.

## What happens behind the scenes

Each employee keeps one active structure per cadence; saving a new one retires the old, which stays as history so paid periods stay addressable by date. Payroll runs read the assignment in force at the window start (falling back to the active structure for employees whose timeline was never materialised). Opening YTD rows seed the fiscal-year totals shown on payslips, and the default package simply prefills new editors — it is a template pointer, not pay state.

## Related flows

- [Monthly payroll runs](runs.md) — how structures become payslips.
- [Salary history](salary-history.md) — the dated assignment timeline and revisions.
- [Run corrections](run-corrections.md) — arrears when an effective date lands late.
- [Benefits](benefits.md) — the flexible-benefit cap set on a structure.
- [Offers](../recruitment/offers.md) — where signed-off packages originate.
