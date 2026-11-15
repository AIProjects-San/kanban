# Employment documents

The employment documents area is the admin home for approval-gated employment changes (transfers and promotions), and the place to understand the document types and verification rules that gate a candidate's joining.

## Who can use this

HR admins (Super Admin, Admin, HR). Other roles see an "HR admin only" panel when they try to open the pages.

## Where to find it

The index page lives at `/admin/employees` (titled "Employment documents"). There is no sidebar item — reach it from an employee's transfers or promotions page via the "Employment documents" header link, or open the address directly. Document types themselves are edited from Sidebar → HR → Hiring → **Doc types** button.

## When to use it

- Finding the right employee before creating a transfer or promotion document.
- Defining which documents the workspace collects — and whether they gate joining.
- Verifying a candidate's submitted documents before marking them joined.
- Understanding why a join is blocked.

## Before you start

- Document types have a **scope**: Candidate documents are collected during joining formalities and gate the join when mandatory; Employee documents are identification types requested from existing employees and never gate a join.
- The joining gate must be switched on in Workspace Config (Sidebar → Administration → Workspace Config → General → **Joining gate**). When it is on, a candidate can only be marked joined when every mandatory document is Verified and every background check is terminal (cleared or flagged).

## Steps

1. Open `/admin/employees` to see every employee with their **Job title**, **Department** and **Grade**.
2. Use the per-row links **Transfers**, **Promotions** or **Timesheets** to open that employee's document page (see [Transfers and promotions](transfers-promotions.md)).
3. To manage document types, go to Sidebar → HR → Hiring and click **Doc types**. The "Joining document types" window opens.
4. Click **Add document type**, fill in **Label** (the **Key (auto from label)** is generated), an optional **Description**, the **Scope** ("Candidate — joining formalities (gates the join when mandatory)" or "Employee — identification documents"), and tick **Mandatory (flagged in the joining checklist)** and **Active (available to request)** as needed. Click **Save document type**.
5. Reorder types with the up and down buttons; edit or delete with the row buttons.
6. To collect and verify a candidate's documents, open the candidate in Hiring and find the "Joining formalities" section.
7. Click **Request all mandatory**, or **Request** individual types.
8. When the candidate provides a document, click **Mark received** and optionally record a file reference.
9. Click **Verify** when it checks out, or **Reject** with what is wrong — a rejected document can be re-requested with **Re-request**.
10. Check the "Joining gate" panel at the top of the section: when it turns green ("Joining gate — 2 of 3 mandatory documents verified · background check terminal") the candidate can be marked joined.

## What you'll see

- The index table: **Employee** (name and email), **Job title**, **Department**, **Grade**, and the **Transfers** / **Promotions** / **Timesheets** links. Every page in this area has a **Back to Fernly** header link and the "Employment documents" sibling link.
- In the Doc types window, each type shows its label, a **mandatory** chip when required, a scope chip (**candidate** or **employee id**), and **inactive** when switched off.
- In a candidate's joining formalities: the document checklist with each type's status (**REQUESTED**, **RECEIVED**, **VERIFIED**, **REJECTED**), the file reference, who verified it and when, plus the background-check rows.
- Employee-scope identification documents are verified from the HR Console → Directory tab → the ID-card icon on an employee's card, with **Verify** / **Reject** buttons on received rows.

## Common problems

**Marking a candidate joined is refused.**
The joining gate is on and something is outstanding. The refusal lists exactly what:

> Joining blocked — outstanding formalities: Passport: received, not yet verified; Background check (Accurate): in review.

Fix each item (verify the document, let the check finish) or switch the gate off in Workspace Config for an advisory-only flow.

**A document cannot be verified.**
Only a received document can be decided — mark it received first.

**An employee identification document cannot be requested.**
The type's scope is Candidate:

> That document type is for candidates, not employee identification.

**A rejected document needs another look.**
History is never reopened — use **Re-request**: the row resets and the candidate submits it again.

**No document types are listed.**
Add the first one from the Doc types window; existing candidates keep the history of types they were already asked for.

## What happens behind the scenes

Each document row is a small lifecycle: requested → received → verified or rejected, with the verifier and timestamp recorded. The joining gate is evaluated live from these rows plus background checks — mandatory types must all be Verified and every check must have finished (cleared or flagged) before the join can happen. Transfers and promotions created from this area keep their own dated snapshot of the employee's facts, so later renames of departments or designations never rewrite past documents.

## Related flows

- [Transfers and promotions](transfers-promotions.md) — the documents this area indexes.
- [Joining formalities](../recruitment/formalities.md) — the candidate-side checklist in detail.
- [Marking a candidate joined](../recruitment/mark-joined.md) — the step the gate protects.
- [Employee directory](directory.md) — where employee identification documents are verified.
- [Workspace configuration](../admin/workspace-config.md) — where the joining gate is switched on or off.
