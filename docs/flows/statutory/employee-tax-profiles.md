# Employee tax profiles

The per-employee IRD declarations — IRD number, tax code, student loan, KiwiSaver and employment status — behind every statutory deduction and every line on an IRD filing.

## Who can use this

**Super Admin** only. These pages sit in the statutory admin area; anyone else sees a "Super admin only" panel and a **Back to Fernly** link.

## Where to find it

Two real URL pages, not sidebar items:

- The list: `/employees`
- One employee's editor: `/employees/<employee id>/tax-profile`

Open the list address directly (it is linked from the statutory area's header, labelled **Employee tax profiles**, once you are in that section). On the list, each row's **Open** link goes to that employee's tax profile; the same page also links to **Transfers**, **Promotions** and **Salary history**.

## When to use it

- When an employee joins — record their IRD number, IR330 tax code and KiwiSaver status before their first pay.
- When an employee hands you a new IR330 (changed tax code), an IR23 tailored tax code certificate, or a KiwiSaver election change.
- When employment ends and IRD needs the departure details.
- Before your first real IRD filing — to replace the demo IRD numbers (see below).

## Before you start

- Have the employee's signed IR330 declaration (tax code and student loan status), and their IR23 certificate if they use a tailored code.
- Know that an empty profile is fine to start: the system defaults to tax code M with no student loan until you save a real declaration, and the editor tells you "no tax profile on file yet — this save creates it".
- **Demo data warning:** demo-workspace employee IRD numbers pass the checksum but sit outside the range IRD has ever issued. The editor flags them with a "demo data" tag:
  > Outside IRD's issued range (10,000,000–200,000,000) — the number passes the check digit, but IRD has never issued it. It files with a myIR warning, not an error. Replace it with the employee's real IRD number before the first real filing.

## Steps

1. Open `/employees` and find the employee (columns: Employee, Role, Tax code, Employment, Profile — "on file" or "not set up").
2. Click **Open** on their row.
3. Read the **Auto-enrolment preview (KiwiSaver)** at the top — it shows the resolved KiwiSaver status and, if the 28-day rule applies, the computed auto-enrol date.
4. In **Section A — Tax code**: choose the **Tax code (IR330)**, type the **IRD number**, set **Tax code effective from**, and tick **Student loan — deduct via the SL suffix** if they have a loan. For code STC, also fill the **IR23 tailored tax code certificate** group (Tailored rate %, ACC treatment, Special SL rate %, Certificate expiry).
5. In **Section B — KiwiSaver**: choose the **Status**, the **Employee rate** (leave "No election — default <N>% applies" to use the default), the **Employer rate**, and optionally an **ESCT rate override (optional)**.
6. In **Section C — Employment / casual status**: choose the **Employment type** (Permanent, Casual, Temporary, Casual agricultural), and set the **Employment start date** and **Employment end date (if known)**. For Casual, tick **Holiday pay is paid with wages** when that applies.
7. Add anything worth keeping in **Notes** (certificate details, declaration dates, exemptions).
8. Click **Save tax profile** (top or bottom of the page).

## What you'll see

- Tax code options as worded in the dropdown: "M — main job", "ME — main job, no student loan (IETC applies)", "SB — secondary, bottom band", "S — secondary", "SH — secondary, high", "ST — secondary, top", "SA — secondary, all", "ND — no declaration (45%)", "STC — tailored tax code (IR23 certificate)", plus special codes CAE, NSW and EDW.
- KiwiSaver statuses: ENROLLED, NOT ENROLLED, OPT OUT, SAVINGS SUSPENSION, NOT ELIGIBLE — each with its plain-language explanation in the dropdown.
- The employee rate list marks the default rate "(default)" and 3% as "(temporary — pre-existing elections only)".
- Live guardrail messages as you edit, e.g. "Fails the mod-11 check digit — recheck the digits." under the IRD number, or the STC block "STC requires a tailored rate from the IR23 certificate — no default exists."
- A "Ready to save" note when the form is valid; the save is blocked while STC has no certificate rate or the IRD number fails its check digit.
- On saving, a confirmation "Tax profile saved for <name>", plus any warnings as toasts.

## Common problems

**The IRD number will not save.** It must have a correct check digit:
> "4909186" is not a valid IRD number — it needs 8–9 digits with a correct mod-11 check digit.

**The KiwiSaver employee rate is refused.** Only the allowed elections can be chosen:
> KiwiSaver employee rate must be one of 3%, 3.5%, 4%, 6%, 8%, 10% (3% remains legal only for pre-existing elections).

**A warning appears after saving a casual employee.** Casual employees are only exempt from KiwiSaver auto-enrolment when holiday pay is paid with wages:
> Casual exemption requires holiday pay to be paid with wages. If holiday pay is paid on leave, consider TEMPORARY or PERMANENT.

**An IR23 certificate warning.** Expired certificates are flagged on save:
> The IR23 certificate expired on 2026-11-01 — obtain a renewed certificate and update the rate.

**The employee has no profile and payslips already ran.** Until a profile exists the system assumes tax code M with no student loan; save the real declaration and, if needed, correct the affected payslips before the run is filed.

## What happens behind the scenes

The saved profile is what the payroll engine reads for every payslip: the tax code selects the rate table, the student loan flag adds the SL deduction, and the KiwiSaver status and rates drive both the employee and employer contributions. The auto-enrolment preview uses the same rules the engine applies — for example a temporary employee is auto-enrolled after 28 days, and converting them to permanent records the required audit entry. These details also flow onto the IRD filings: the IRD number, tax code and employment dates on an Employment Information line, and the joiner/leaver notifications, all come from here.

## Related flows

- [Tax setup](tax-setup.md) — the rate tables these declarations are applied against.
- [IRD payday filings](filings.md) — where this data lands on IRD files.
- [Payroll runs](../payroll/runs.md) — the calculations it feeds.
- [Salary history](../payroll/salary-history.md) — the other per-employee payroll record.
