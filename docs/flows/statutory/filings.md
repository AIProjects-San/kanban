# IRD payday filings (EI, ED and the filing profile)

Fernly builds the IRD files for your paydays — Employment Information (EI), Employee Details (ED) and amendments — and you download them and upload them to myIR yourself.

## Who can use this

Payroll administrators: **Super Admin**, **Admin** and **HR**. Anyone else who opens one of these pages sees a "Payroll admin only" panel and a **Back to Fernly** link.

## Where to find it

These are separate admin pages with their own web addresses, not sidebar items:

- EI filings list: `/admin/payroll/filings`
- One run's filing panel: `/admin/payroll/runs/<run id>/filing`
- Employee Details filings: `/admin/payroll/employee-details`
- Filing profile: `/admin/payroll/settings`

Entry points that do exist in the app:

- The Payroll console (Sidebar → HR → **Payroll**) shows a small badge on each run, e.g. "EI FILED" or "EI GENERATED", with the due date in its tooltip — click it to open that run's filing panel. A locked run with no filing yet shows "EI filing…".
- The filing panel and the Employee details page show a **Set the employer IRD number and payroll contact** / **Configure it** link to the filing profile when it is not set up.

Open any of these addresses directly; once you are in the area, the header links (**EI filings**, **Employee details**, **Loans**, **Filing profile**) and **Back to Fernly** get you around.

## When to use it

- After locking (marking paid) a payroll run — generate its EI file within 2 working days of the payday.
- When someone joins or leaves — notify IRD with an ED file *before* the first (or last) EI that includes them.
- When IRD accepts or rejects a file, or when a filed return needs correcting (an EIA2 amendment).
- Once, before your first real filing — to set up the employer filing profile.

## Before you start

- **The employer filing profile must be configured first.** Until it is, the generate buttons stay disabled and the pages warn:
  > The employer filing profile is not configured. Set the employer IRD number and payroll contact before generating any IRD file.
- **Replace demo IRD numbers before filing for real.** The demo workspace ships employee IRD numbers that pass the checksum but were never issued by IRD. The employee's tax profile flags each one with a "demo data" tag:
  > Outside IRD's issued range (10,000,000–200,000,000) — the number passes the check digit, but IRD has never issued it. It files with a myIR warning, not an error. Replace it with the employee's real IRD number before the first real filing.
- Fernly never uploads to myIR for you. Download the file, then upload it in myIR ("File or upload a return" or express file transfer) within 2 working days of the payday.
- The run must be locked before its EI file can be generated.

## Steps

Filing a payday's Employment Information:

1. In the Payroll console, lock the run (mark it paid) for that payday.
2. Click the run's **EI filing…** or **EI <status>** badge to open its filing panel.
3. Click **Generate EI file**. The file is built only if its reconciliation checks pass.
4. Click **Download EI file** and save the CSV.
5. Upload the file in myIR within 2 working days of the payday.
6. Back on the panel, optionally type the myIR reference into **myIR reference (optional)** and click **Mark as uploaded to myIR**.
7. When myIR confirms, click **Mark accepted**; if myIR rejects it, click **Mark rejected**, paste the error report, and click **Record rejection**, then regenerate.

Correcting an already-filed return (amendment):

1. Open the run's filing panel (the filing must be FILED, ACCEPTED, AMENDED or REJECTED).
2. Click **Amend (EIA2)**.
3. For each employee needing a correction, type the corrected dollars in **gross**, **paye**, **SL** or **KS ee** (blank keeps the filed value), or tick **delete line**.
4. Click **Generate EIA2 amendment (N)**.
5. Download the amendment with its **EIA2 file** button and upload it to myIR.

Notifying IRD about a joiner or leaver (ED):

1. Open `/admin/payroll/employee-details` and pick the **Employment month**.
2. Tick the employees to notify (all pending ones are pre-selected).
3. Click **Generate ED file (N)**, download it with **ED file**, and upload it to myIR.
4. Click **Mark uploaded**, then **Mark accepted** when myIR confirms.

Setting up the filing profile:

1. Open `/admin/payroll/settings`.
2. Fill in **Employer IRD number**, **Employer name (as registered with IRD)**, **PAYE intermediary IRD number** (leave blank if none), **Payroll contact name**, **Payroll contact work phone**, **Payroll contact email** and **Payroll package identifier**. The **IR form version** is fixed at 0001.
3. Click **Save filing profile**.

## What you'll see

- The EI list ("Employment Information filings") has a **Refresh overdue flags** button, filter tabs (**All**, **Draft**, **Generated**, **Filed**, **Accepted**, **Rejected**, **Amended**, **Overdue**) and a table of Payday, Period(s), Cycle, Due, Status, Lines, Gross, PAYE and Days overdue.
- The filing panel shows the payday, the "IRD due (payday + 2 working days)" date, a countdown ("N working days remaining", "due today", or "N working days OVERDUE"), filing totals (gross, PAYE, student loan, KiwiSaver, ESCT), and a "Ledger reconciliation — the filed return vs the books" table where each check shows pass or FAIL.
- Filing statuses, as displayed: GENERATED, FILED, ACCEPTED, REJECTED, AMENDED.
- The Employee details page lists pending notifications (NEW or DEPARTING, with the employment start/end date) and the notification history.
- Downloaded files are named like `EI-<IRD>-<paydate>.csv`, `ED-<IRD>-<date>-NEW.csv` and `EIA2-<IRD>-<paydate>.csv`.

## Common problems

**"Generate EI file" is disabled.** The run is not locked, the filing profile is not configured, or this payday was already filed (a filed return is never regenerated — amend instead). A run on a pay frequency that has no confirmed IRD pay cycle code also blocks generation (supported: weekly, fortnightly, monthly, twice-monthly, daily).

**Generation is refused with a run or payslip error.** Real messages include:
> The run for <period> is still OPEN — lock it (mark it paid) before generating its Employment Information file.
> Payslip <slip no> has no tax code applied — the IR330 declaration is missing, so the return cannot be filed.
> The Employment Information file would disagree with the payroll records or the general ledger — refusing to generate. N check(s) failed: …

**The profile will not save.** IRD numbers are checksum-validated; contact fields have length limits; commas are never allowed:
> "123456789" is not a valid employer IRD number (9 digits, mod-11 check, inside IRD's issued range) — enter the employer's real IRD number.
> Commas are never allowed in IRD file fields — remove them from the contact name / package identifier.

**An amendment will not generate.** Only a filing that was uploaded to myIR can be amended, and it needs at least one correction:
> An amendment corrects a filing that was uploaded to myIR — this one is still GENERATED. Regenerate it instead.

**A filing shows as overdue.** Click **Refresh overdue flags** to re-check every filing against its 2-working-day deadline; the button reports "N filing(s) newly flagged overdue." or "No new overdue filings.".

## What happens behind the scenes

Each EI file is generated in the IRD's expected CSV format, with the employer details from your filing profile in the header and one line per employee. Before writing anything, Fernly compares the file's totals against the payslips and the general ledger and refuses to generate on any mismatch. Marking a file uploaded, accepted or rejected records who did it and when, so the audit trail matches what happened in myIR. Amendments are written as pairs of lines (the values as originally filed, then the corrected values) so IRD can see exactly what changed. Nothing is ever uploaded automatically.

## Related flows

- [Payroll runs](../payroll/runs.md) — locking a run is what makes it filable.
- [Employee tax profiles](employee-tax-profiles.md) — the IRD numbers and tax codes on every filed line.
- [Tax setup](tax-setup.md) — the rate tables behind the deducted amounts.
- [Loans](../payroll/loans.md) — the other payroll-filing-area page.
