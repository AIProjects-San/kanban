# Employee directory

The Directory tab of the HR console is the workspace's employee list: open anyone's card, keep their HR profile fields up to date, record employment changes, manage their identification documents and rate their skills.

## Who can use this

Anyone who can see the HR console (Super Admin, Admin, HR, Manager) can browse the directory. Only HR admins (Super Admin, Admin, HR) get the edit, promote-or-transfer, documents and skill buttons.

## Where to find it

Sidebar → HR → HR Console → Directory tab.

## When to use it

- Looking up a colleague's title, department, manager, location or skills.
- Keeping job data current: title, department, grade, employment type, branch, hire date.
- Recording a promotion or transfer with an effective date and optional salary raise.
- Requesting, receiving and verifying an employee's identification documents.
- Rating an employee's skills, or exporting the whole roster to CSV.

## Before you start

- Employees own their contact details (phone, location, emergency contact, free-text skills) from their own settings; everything else here is HR-owned.
- The Promote or transfer, identification documents and skill map buttons are icon buttons on each card, visible only to HR admins.
- The footer row above the list links to the Departments, Designations and Grades master pages.

## Steps

1. Open Sidebar → HR → HR Console → Directory tab.
2. Search with the box ("Search name, title, skill, location…") or narrow with the filter chips: **All departments**, **All types**, **All grades**, **All branches**. Clear everything with **Clear filters**.
3. To export the roster, click **Export CSV**.
4. To edit someone, click the pencil icon on their card. The "Edit <name>'s profile" form opens.
5. Update the fields you need — **Job title**, **Department**, **Grade**, **Employment type**, **Branch**, **Phone**, **Birthday**, **Location**, emergency contact, **Skills (comma-separated)** and **HR notes (HR/admin only)**.
6. Under Employment, change **Status**, **Notice period (weeks)**, **Probation ends**, **Last working day**, or set a **Leave approver (overrides the reporting manager)**. A changed status is checked first; if it is refused the save stops with the reason.
7. Click **Save profile**.
8. To record a promotion or transfer, click the arrow icon on the card — the "Promote or transfer <name>" form opens (see [Transfers and promotions](transfers-promotions.md) for the full flow).
9. To manage identification documents, click the ID-card icon — a panel opens where you can request a type, and verify or reject what the employee submitted.
10. To rate skills, click the award icon — pick a skill, a **Rating (1–5)** and an optional note, then click **Rate**.

## What you'll see

- One card per employee: avatar, name, employee number, job title, employment status badge (with probation end date when set), department, grade, type, branch, manager, location, skills and top rated skills.
- A count line "N of M people" that always reflects your current filters.
- The edit form's Employment block shows a probation hint when confirming a probationer: "Confirmation requires the probation review to be completed first — it will be refused while the cycle is outstanding."
- The documents panel lists each document with its status — **Requested**, **Received**, **Verified** or **Rejected** — and buttons **Submit**, **Verify** and **Reject** depending on its state.
- The skill map shows each skill as "N/5 · <proficiency>" (Learning, Developing, Solid, Advanced, Expert) with who assessed it and when.
- The footer row: "Grouping axes are masters now:" with **Departments**, **Designations**, **Grades** links to the admin master pages.

## Common problems

**No edit buttons on the cards.**
You are signed in as a Manager — managers can browse but not change HR data.

**Saving the profile fails with a status error.**
Employment moves are guarded. For example, confirming a probationer before their probation review:

> Probation review outstanding — Alex cannot be confirmed until their probation review is completed (open a probation review cycle from the Reviews tab, then have the manager complete it).

Recording an exit without a last working day is refused with:

> A last working day is required to record an exit.

**A leave approver cannot be set.**
The approver must be another member:

> An employee cannot be their own leave approver — pick another member or clear the override.

**A document cannot be verified.**
Only a received document can be decided:

> Only a RECEIVED document can be verified.

**A skill cannot be rated.**
The skill must still be active in the workspace's skill list; if it was retired, pick another one.

## What happens behind the scenes

Profile edits write straight to the employee's HR record; a status change goes through a guarded transition first, so illegal moves (like un-exiting someone) never happen. Promotion and transfer records are kept as dated history entries, and a salary raise on a promotion revises the salary structure on the same effective date. Document verification and skill ratings are audited with your name, and rejected documents can be re-requested — history is never silently reopened.

## Related flows

- [Transfers and promotions](transfers-promotions.md) — the dedicated documents behind the arrow button.
- [Employee masters: departments, designations, grades](masters.md) — the pages linked from the footer.
- [Reviews](reviews.md) — the probation gate referenced when confirming an employee.
- [Offboarding](offboarding.md) — recording exits and final settlements.
- [My account (self-service)](../self-service/my-account.md) — the fields employees maintain themselves.
