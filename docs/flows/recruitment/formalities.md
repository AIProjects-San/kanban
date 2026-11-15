# Candidate formalities

Collect and verify the documents and background checks a candidate needs before they can join — the joining formalities checklist inside the candidate detail modal.

## Who can use this

Admins and HR. The document and check lists live in the candidate detail modal, which only they can act on. Admins and HR also maintain the checklist template itself.

## Where to find it

Sidebar → HR → **Hiring**, open a candidate, and find the **Joining formalities** section on the left of the detail modal. The template of document types is edited with the **Doc types** button at the top right of the Hiring view.

## When to use it

- A candidate is progressing and you need to request documents (ID, qualifications, references, and so on).
- Documents have arrived and need to be verified — or rejected with a reason.
- A background check should be initiated and its result recorded.
- You want to see whether anything is still outstanding before the join date.

## Before you start

- Decide which document types are mandatory. In the **Doc types** editor ("Joining document types" — "The checklist HR collects from every joining candidate"), each type has a "Mandatory (flagged in the joining checklist)" setting and a scope (candidate or employee identification); only candidate-scope mandatory types can block joining.
- If your workspace has the joining gate on, every mandatory document must be VERIFIED and every background check finished before the candidate can be marked joined. Admins control this in Workspace Config with the "Joining gate" setting ("A candidate can only be marked joined when every mandatory document is VERIFIED and every background check is terminal (cleared or flagged). Turn off for the advisory-only flow.").
- The panel shows the gate's live verdict before it bites, so nothing is a surprise at the join.

## Steps

1. Open the candidate and scroll to **Joining formalities**.
2. To request one document, click **Request** on its row; to request everything at once, click **Request all mandatory**.
3. When the candidate provides a document, click **Mark received**, optionally enter a "File reference (URL or name — optional)", and confirm.
4. Check the document, then click **Verify** if it is good.
5. If it is not acceptable, click **Reject**, describe it under "What is wrong? (sent with the re-request)", and confirm — then **Re-request** when needed.
6. For background checks, click **Initiate**, fill "Vendor (who runs the check)" (for example "HireRight") and optional "Notes", then click **Initiate check**.
7. As the vendor reports back, set the check's state: **In review** while it is running, then **Cleared** or **Flagged** as the outcome, optionally adding a "Report reference (optional)".

## What you'll see

- Document rows show the type label, a "required" chip while a mandatory one is not yet requested, and the document's state: **REQUESTED**, **RECEIVED**, **VERIFIED**, or **REJECTED**. Verified rows show "verified by <name> · <date>"; rejected rows show the note you typed.
- A background check row shows the vendor, its state — **INITIATED**, **IN REVIEW**, **CLEARED**, or **FLAGGED** — who initiated it and when, plus the report reference and notes.
- If no check exists yet: "No background check yet — initiate one around offer acceptance (T-14)."
- The joining gate banner, when the gate is on: "Joining gate — <summary>", for example "Joining gate — 2 of 3 mandatory documents verified · background check pending (1)", with a bullet list of exactly what is outstanding when it is not yet allowed.
- Confirmations as you work: "Document requested.", "3 mandatory documents requested.", "Document marked received.", "Document verified.", "Document rejected.", "Background check initiated.", "Background check cleared."

## Common problems

**A document cannot be verified or rejected straight after requesting it.** Only a received document can move on:

> Only a RECEIVED document can be verified.

> Only a RECEIVED document can be rejected.

**A document already moved on.**

> Document is already VERIFIED.

**The rejection note was left empty.**

> A rejection note is required.

**The background check form is missing the vendor.**

> A vendor is required.

**A document type cannot be requested.**

> Unknown or inactive document type.

Fix it in the **Doc types** editor — the type may have been deactivated or removed (existing candidates keep their history either way).

**You are unsure what still blocks the join.** Read the gate banner's bullets — each names the item and its state, e.g. "Passport: received, not yet verified" or "Background check (HireRight): in review".

## What happens behind the scenes

Documents follow a strict request → received → verified path; only VERIFIED satisfies the joining gate, so requested, received, and rejected all count as outstanding. Each document row keeps the label it was requested with, so renaming a type later never rewrites history. Background checks have two terminal states — CLEARED and FLAGGED — and either finishes the gate's requirement; a flagged check is surfaced but does not itself block, leaving the join decision to your judgement. Every request, verification, rejection, and check update is written to the audit log.

## Related flows

- [Marking a candidate as joined](mark-joined.md) — where the gate is enforced.
- [The hiring pipeline](pipeline.md) — where candidates live.
- [Composing and sending offers](offers.md) — offers usually overlap with formalities.
- [Workspace Config](../admin/workspace-config.md) — turning the joining gate on or off.
