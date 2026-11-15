# Performance reviews

The Reviews tab of the HR console runs the performance review cycle: open a cycle for an employee, let them write their self-assessment, then review and rate it.

## Who can use this

HR admins and managers. Managers can open cycles only for their own reports and review only their team's cycles; HR admins (Super Admin, Admin, HR) can open and review cycles for anyone. Employees participate from their own My reviews screen.

## Where to find it

Sidebar → HR → HR Console → Reviews tab.

## When to use it

- Starting a review cycle (annual, mid-year, or probation).
- A submitted self-assessment is waiting for the manager's decision.
- Checking the status of cycles across the team or workspace.
- Confirming a probationer — a completed probation review is required before their status can become Active.

## Before you start

- A cycle moves through four statuses: **Draft** → **Submitted** → **Reviewed** → **Acknowledged**.
- Draft means the employee is still writing; only after they submit can the manager review it.
- A manager cannot review their own cycle — HR or another manager does it.

## Steps

1. Open Sidebar → HR → HR Console → Reviews tab.
2. Filter the list with the chips: **All**, **Draft**, **Submitted**, **Reviewed**, **Acknowledged**.
3. Click **New Cycle**.
4. In "Open a review cycle", choose the **Employee**.
5. Enter the **Cycle title** (e.g. "2026 Mid-year review").
6. Choose the **Review type**: Standard review or Probation review. For probation, a note explains that a completed probation review is required before a probationing employee can be confirmed as active.
7. Set **Period start** and **Period end**, then click **Open cycle**. The cycle appears as Draft and the employee is notified to write their self-assessment.
8. When the employee has submitted, the row shows a **Review** button — click it.
9. Read the self-assessment text and self rating.
10. Write your **Manager comment (shown to the employee)** — strengths, growth areas, next steps. It is required.
11. Choose a **Rating (1-5)** — from "Needs improvement" to "Outstanding".
12. Click **Complete review**. The cycle becomes Reviewed and waits for the employee to acknowledge it.

## What you'll see

- A table with **Employee**, **Cycle** (with a **Probation** tag on probation reviews), **Period**, **Status** and **Ratings** (e.g. "self 4/5 · mgr 4/5").
- The **Review** button only on Submitted rows.
- The decision form shows the employee's self-assessment verbatim, or "No self-assessment text." when they skipped it.
- The rating options with their labels: 1 Needs improvement, 2 Developing, 3 Meets expectations, 4 Exceeds expectations, 5 Outstanding.
- Confirmation messages: "Review cycle opened", "Review completed".

## Common problems

**No Review button on a submitted cycle.**
It may be someone else's report, or your own cycle — you cannot review yourself:

> You cannot review your own cycle — it is reviewed by your manager chain, HR, or another admin.

**A cycle cannot be reviewed.**
Only submitted cycles can be decided; check the status chip:

> Only a submitted cycle can be reviewed — this one is acknowledged.

**Complete review is disabled.**
The manager comment is required — write at least a sentence before clicking.

**A manager cannot open a cycle for someone.**
Managers are limited to their own reports:

> You can only open review cycles for your own reports.

**A probationer cannot be confirmed in the Directory.**
The probation review must be completed first — open a Probation review cycle here, complete it, then change the status in the directory.

## What happens behind the scenes

Opening a cycle creates a draft record and tells the employee to write their self-assessment; submitting locks their answers and notifies their manager. Completing the review stores your comment and rating, and the employee is asked to acknowledge the result — acknowledgement closes the loop. For probation reviews, completing the cycle is the gate that unlocks confirming the employee as Active in the directory. Everything is recorded in the audit log.

## Related flows

- [Employee directory](directory.md) — where employment status changes depend on probation reviews.
- [My reviews (self-service)](../self-service/my-reviews.md) — the employee's side: writing, submitting, acknowledging.
- [Onboarding](onboarding.md) — the new-hire flow that often precedes a probation review.
- [Transfers and promotions](transfers-promotions.md) — what often follows a good review.
