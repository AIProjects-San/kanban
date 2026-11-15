# The hiring pipeline

The Hiring view is a board where you track every job candidate from first contact through each stage of your process to the final decision.

## Who can use this

Admins, HR, and Managers can open the Hiring view. Everyone who can open it sees the board and the recruitment funnel. Adding candidates, moving them between stages, and recording decisions is done by Admins and HR — a Manager sees an interviewer view: they can open candidates, read everything, fill their scorecards, and approve offers, but the stage and decision buttons are not shown to them.

## Where to find it

Sidebar → HR → **Hiring**. The screen is headed **Hiring pipeline**. Like all workspace views, it opens inside the one workspace screen — the sidebar switches the view, and the page address does not change.

## When to use it

- A new applicant should enter your process.
- A candidate cleared a step and should move to the next stage.
- A stage should be skipped, marked failed, or a one-off stage added for one candidate.
- You are ready to decide: select the candidate for an offer, reject them, or record that they withdrew.

## Before you start

- The board's columns come from your stage template. If no stages are active yet, the board says: "No active stages in the template — add some via "Stages"." Admins and HR edit the template with the **Stages** button (top right); stage types include Screening, Interview, Assessment, Background check, Documents, Offer, and Custom.
- Every new candidate gets a private copy of the template, so later template changes never rewrite an existing candidate's history.
- Only candidates in the active pipeline appear as board cards. Decided candidates (Selected, Rejected, Withdrawn, Hired) sit behind the status filter tabs above the board.

## Steps

1. Click **Add candidate** (top right).
2. Fill in **Full name** and **Email** (both required), plus **Phone**, **Position applied for**, **Department**, **Source**, **Resume link**, and **Notes** as available.
3. Click **Add candidate**. The candidate appears in the first stage of the board, marked "in progress".
4. Click any candidate card to open the candidate detail modal.
5. To move the candidate forward, click **Pass "<stage name>"** in the Decision panel. The current stage is marked passed and the next one starts.
6. To handle a single stage differently, use **Skip** or **Mark failed** on that stage in the Stage timeline.
7. To add a one-off step, click **Add stage**, type a name under "Custom stage (this candidate only)", and click **Add**.
8. To record a decision, use the buttons in the Decision panel: **Select**, **Reject**, **Withdraw**, or **Edit** to correct details.
9. When rejecting, type a reason under "Rejection reason (required — internal, audit only)", optionally tick "Email the candidate a rejection notice" and add a "Personal note to the candidate (included in the email)", then click **Confirm rejection**.
10. To bring a decided candidate back into the pipeline, click **Reactivate candidate**.

## What you'll see

- A row of status filter tabs — **Active**, **Selected**, **Rejected**, **Withdrawn**, **Hired** — each with its count.
- The board: one column per active stage, with the owning role under the stage name and a card per active candidate (initials, name, position).
- A **Recruitment funnel** panel: pool totals (Active, Selected, Hired, Rejected, Withdrawn, Offers out), per-stage load ("Stages — in progress / passed / avg days"), and the offers summary with the accept rate (decided offers).
- A "Your upcoming interviews" strip when interviews are assigned to you.
- For Managers and Admins, an **Offer approvals** panel listing drafts awaiting approval with an **Approve** button.
- For Admins and HR, an **Offers** panel (every offer record and its state) and an **Email outbox** panel (every candidate email, with its delivery state).
- The candidate detail modal: on the left, the profile (Email, Phone, Source, Resume, Added, Notes), the Decision panel, and the Joining formalities section (documents and background checks — see [Candidate formalities](formalities.md)); on the right, the Stage timeline with each stage's status (PENDING, IN_PROGRESS, PASSED, FAILED, SKIPPED), scorecards, and per-stage actions.
- Offer state banners for selected candidates: "Offer preparation pending — build and send the offer letter, then collect the signature." and, once signed, "Offer signed — ready to mark joined (creates the account + onboarding checklist)."

## Common problems

**The same person is already in the system.** Candidate emails must be unique:

> Another candidate already uses this email.

**A stage button does nothing for a decided candidate.** Stage actions only work while the candidate is active:

> Candidate is REJECTED — the pipeline is closed.

(the status word varies — SELECTED, WITHDRAWN, and so on).

**You passed every stage and want to hire.** Passing the last stage leaves the candidate active on purpose — hiring is a separate, explicit decision. Use **Select**.

**The rejection will not save.** A reason is required:

> A rejection reason is required.

**A second rejection email the same day is refused.** At most one email per candidate per day:

> A rejection email was already sent to Priyanka Menon today — at most one per candidate per day. Uncheck "Email the candidate" to record the decision without another send, or retry tomorrow.

**You try to advance a candidate with no open stage.**

> No open stage to advance — every stage is already closed.

## What happens behind the scenes

Each candidate carries a snapshot of the stage template taken when they were added, so renaming or reordering template stages later never rewrites their history. The first stage starts automatically as the candidate's current stage. Every add, edit, stage change, and decision is written to the audit log with who did it and when. Rejection emails (and all other candidate emails) are recorded in the audited outbox first and then delivered — if no mail provider is configured, the send is recorded as skipped and nothing is silently lost; HR can copy links and share them manually.

## Related flows

- [Scheduling interviews](interviews.md) — booking interview stages and assigning interviewers.
- [Composing and sending offers](offers.md) — the offer step after selecting a candidate.
- [Candidate formalities](formalities.md) — documents and background checks before joining.
- [Marking a candidate as joined](mark-joined.md) — turning a signed candidate into an employee.
- [Roles and what they can do](../getting-started/roles.md) — who sees the Hiring view.
