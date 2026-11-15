# Composing and sending offers

HR builds an offer for a selected candidate, a Manager approves it, and Fernly emails the candidate a private signing link.

## Who can use this

Admins and HR compose, edit, and send offers. Approval is deliberately a second pair of eyes: a Manager (or an Admin) approves the draft — the person who composed it cannot approve their own offer. Only approved offers can be sent.

## Where to find it

Sidebar → HR → **Hiring**. Offers are managed in three places on this screen: the candidate detail modal (the **Build offer** button), the **Offers** panel (every offer record), and — for Managers and Admins — the **Offer approvals** panel with drafts waiting for approval. Admins and HR also manage role templates with the **Offers** button at the top right.

## When to use it

- A candidate has been selected and you need to prepare their offer letter and package.
- A draft needs adjusting before approval, or an approved offer is ready to send.
- You want to check an offer's state — awaiting approval, awaiting signature, signed, declined, or expired — or copy the signing link again.

## Before you start

- The candidate must be in the Selected state (the **Select** decision on the pipeline) before an offer can be created.
- Have a role template in mind: offers are generated from templates (per-role salary structures) that Admins and HR maintain via the **Offers** button.
- Sending needs the approval first — the draft cannot be sent as-is.
- If email delivery is not configured, a warning appears above the outbox:

> Email delivery is off — no mail provider is configured (set RESEND_API_KEY). Every candidate send below is recorded as skipped; copy signing links and share them manually.

## Steps

1. Open the selected candidate and click **Build offer**.
2. Under "Generate from template", pick a role template ("— Pick a role template —") and click **Generate**.
3. Adjust the **Annual components**: set each line's label, kind (Earning, Employer, Deduction, Statistical (info)), mode ($/yr, % basic, % gross), and amount; add lines with **Add component** or remove them with the trash icon.
4. Optionally enter a target under "Solve base for target CTC" and click **Solve** — Fernly works out the basic salary that hits that package.
5. Fill **Benefits (one per line)** and the **Letter text (sent with the offer; the signing page shows exactly this)**.
6. Set the **Proposed start date (feeds {{startDate}} in the letter)** and, if useful, **Internal notes (audit only)**.
7. Click **Save draft**. The live totals (Earnings, Employer, Deductions, Net / yr, CTC) update as you edit.
8. Ask a Manager to open the **Offer approvals** panel and click **Approve** on the draft.
9. Back in the offer builder, click **Send** on the approved offer.
10. Copy the signing link with **Copy** (or **Signing link** on a sent row) and give it to the candidate if the email could not be delivered.

## What you'll see

- Every offer record shows its state: **DRAFT**, **APPROVED**, **SENT**, **SIGNED**, **DECLINED**, or **EXPIRED**, with the total package (CTC).
- A draft shows "Awaiting manager approval" next to **Edit draft**.
- An approved offer shows "Approved by <manager> · <date> · proposed start <date>" and its **Send** button.
- A sent offer shows "Awaiting signature — link expires <date>" and a **Signing link** button to copy it again.
- After sending, a highlighted box titled "Signing link (single use, expires in 7 days)" shows the full link with **Copy**.
- A signed offer shows "Signed by <name> · <date and time>"; a declined one shows "Declined by the candidate".
- An expired link shows: "Signing link expired — send a fresh offer if the candidate is still interested."
- Confirmation messages: "Draft offer generated — adjust the numbers below.", "Draft offer saved.", "Offer approved — HR can now send the signing link.", and after sending, "Offer sent — the signing link is below (also emailed and recorded in the outbox)."

## Common problems

**The Send button is missing on a draft.** Drafts must be approved first — this is the refusal if it is raced:

> Manager approval is required before an offer can be sent — approve the draft first.

**The composer tried to approve their own offer.**

> The composer cannot approve their own offer — a second pair of eyes (a manager) is required before it can be sent.

**You tried to edit a sent offer.** Sent offers are immutable — the signed snapshot is the contract:

> Offer is already SENT — sent offers are immutable.

**You edited an approved offer.** The edit demotes it back to a draft and the manager must approve again — the numbers they approved are the numbers that were sent, so any change needs fresh approval.

**The offer cannot be generated.** Check the candidate's state and the template picker:

> Offers can only be created for SELECTED candidates.

> Pick a template first.

**A component line will not save.**

> Every component needs a key and a label.

**The link expired before the candidate signed.** Wait for the record to show EXPIRED, then generate a fresh offer from the template and send it — a new link is minted each time. There is no re-open of the old link.

**The candidate declined.** The record stays as a decision; if talks continue, generate a new offer. If they are out of the running entirely, the candidate decision tools on the pipeline (reactivate, reject, withdraw) still apply.

## What happens behind the scenes

Generating an offer copies the template's components and benefits and renders the letter with the candidate's name, position, workspace, and start date — that text is a snapshot the signing page shows exactly as saved. Sending marks the offer as sent, creates a single-use signing link that expires after 7 days, and emails it to the candidate through the audited outbox (also recorded there). The link stops working once it is signed or declined, and stale links flip to expired so lists never show a dead link as waiting. Every compose, edit, approval, and send is written to the audit log.

## Related flows

- [The hiring pipeline](pipeline.md) — selecting a candidate before the offer.
- [Signing an offer online](offer-signing.md) — what the candidate sees and does.
- [Marking a candidate as joined](mark-joined.md) — the step after the signature.
- [Candidate formalities](formalities.md) — documents and checks to run around offer acceptance.
