# Transfers and promotions

Transfer and promotion documents are the approval-gated way to change an employee's job facts: a transfer moves them across department, title, reporting line or location; a promotion raises their designation (and optionally grade).

## Who can use this

HR admins (Super Admin, Admin, HR). Creating, approving, cancelling and making effective all sit behind the HR-admin gate — and approving needs a different pair of eyes than the one who drafted the document.

## Where to find it

Two pages per employee: `/admin/employees/<employee id>/transfers` and `/admin/employees/<employee id>/promotions`. Start from the index at `/admin/employees` and click **Transfers** or **Promotions** on the employee's row; from either page, the pill link at the top (e.g. **Promotions**) hops to its sibling. Every page header has a **Back to Fernly** link and an "Employment documents" link.

## When to use it

- An employee is moving to another team, manager, title or location (transfer).
- An employee is being promoted to a new designation, optionally with a grade change.
- You need a record of the change with an effective date, an approval trail and a reason.

## Before you start

- Documents move through statuses: **Draft** → **Pending approval** → **Approved** → **Effective** (or **Cancelled**).
- The effective date must be in the future when the document is submitted.
- An approved document applies its facts only when it is made effective — on or after its effective date.
- A promotion must name a new designation; a transfer must change at least one fact.

### How these relate to salary changes

These documents change job facts, not pay. A linked salary revision is composed separately on the employee's salary history page, and the two can share an effective date without interacting — the promotion records the link for provenance only. For a quick raise alongside a change, the Directory tab's promote-or-transfer form offers **Salary raise (%)** (see [Employee directory](directory.md)).

## Steps

1. Open `/admin/employees` and click **Transfers** or **Promotions** for the employee.
2. Review the current facts shown at the top (department, job title / designation, grade, manager, location).
3. Click **New transfer** or **New promotion**.
4. Set the **Effective date** — tomorrow is pre-filled and it must be in the future.
5. For a transfer, fill in only what moves: **Department** (from the master list), **Job title**, **Reporting manager** (or "(none — clear the reporting line)"), **Location**, and an optional **Reason**. Click **Draft transfer**.
6. For a promotion, pick the **New designation** (required — from the designations master, or free text if the workspace has none), optionally the **Grade** and a **Reason**. Click **Draft promotion**.
7. Click **Submit** on the draft row — the document now waits for approval.
8. Have a different HR admin click **Approve**. The row shows "Applies <date>" until the date arrives.
9. On or after the effective date, click **Make effective** — the facts are applied to the employee.
10. To abandon a document, click **Cancel**, optionally give a reason, and confirm with **Cancel transfer** / **Cancel promotion**. This cannot be undone.

## What you'll see

- The employee's name and email, and their current facts as cards the next document starts from.
- A table per document: **Effective** date, **Change** (one line per axis, e.g. "Department: Engineering → Design" or "Title: Backend Engineer → Senior Backend Engineer"), **Status**, **Recorded by** (who created it, when, and who approved it) and the action buttons.
- Promotion rows may show a read-only "Linked salary revision" line — provenance only, never acted on here.
- Confirmations: "Transfer drafted — submit it for approval when ready.", "Transfer approved — it applies on its effective date.", "Transfer is now effective — the facts have been applied."

## Common problems

**Submit is refused.**
The effective date must still be in the future at submission:

> The effective date must be in the future when submitting — 2026-06-01 is not after 2026-06-15.

**Approve is refused.**
You drafted it, or it is your own document:

> You drafted this document — it needs a different pair of eyes to approve it.

> You cannot approve your own transfer or promotion.

**Make effective is disabled.**
The effective date has not arrived yet — hover the button to see "The effective date (2026-07-01) has not arrived yet".

**Drafting is refused with "Nothing changes".**
Pick at least one destination that differs from the current facts:

> Nothing changes — pick at least one destination that differs from the current facts.

**A promotion is refused.**
The designation must actually be new:

> Alex already holds that designation — a promotion must name a new one.

**An exited employee's documents are refused.**
Exits are settled by the full-and-final, never re-opened.

## What happens behind the scenes

Each document snapshots the employee's facts before and after, so the change list is history that never drifts when masters are renamed later. Drafting records nothing on the profile; approval only marks the document; the facts actually move when the document is made effective on or after its date. Approvals enforce four-eyes — the drafter cannot approve their own document — and every step is written to the audit log with the actor and the reason.

## Related flows

- [Employment documents](employment-documents.md) — the index page and the document-type rules.
- [Employee directory](directory.md) — the quick in-console change, including the salary raise option.
- [Employee masters: departments, designations, grades](masters.md) — the destinations these documents move people between.
- [Salary history](../payroll/salary-history.md) — composing the salary revision that often accompanies a promotion.
