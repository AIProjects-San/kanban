# Scheduling interviews

HR books a candidate's interview stages, assigns an interviewer, and the interviewer records their feedback in a scorecard — in the hiring pipeline or from their own My Interviews view.

## Who can use this

Admins and HR do the scheduling. The interviewer can be anyone in the workspace directory — including people with the Member role. The assigned interviewer (or an Admin/HR user) fills the scorecard; everyone else cannot.

## Where to find it

Sidebar → HR → **Hiring**, then open a candidate and find an interview stage in the Stage timeline. Interviewers see their own assignments under Sidebar → People → **My Interviews**.

## When to use it

- A candidate has reached an interview stage of your pipeline and a time must be set.
- A booked interview needs a new time (rescheduling).
- Feedback from a completed interview should be recorded.

## Before you start

- Interviews can only be booked on stages whose type is Interview — the stage template (the **Stages** button on the Hiring view) controls the types. Screening, Assessment, Background check, Documents, Offer, and Custom stages cannot be scheduled.
- The candidate must still be in the active pipeline; decided candidates cannot be scheduled.
- Pick the interviewer when scheduling, or the stage's current owner is used.

## Steps

1. Open the Hiring view and click the candidate's card.
2. In the Stage timeline, find the interview stage and click **Schedule** (or **Reschedule** if a time is already set).
3. Set **Date & time**.
4. Choose an **Interviewer** from the dropdown, or leave "— Keep current owner —" to keep the stage's existing owner.
5. Click **Schedule interview**.
6. After the interview, click **Fill scorecard** on the stage (or, as the assigned interviewer, open My Interviews and click **Fill scorecard** there).
7. Set **Rating (1–5)** and **Recommendation** (Strong hire, Hire, or No hire).
8. Write **Strengths**, **Concerns**, and **Remarks (shown on the stage)**.
9. Click **Save scorecard**.
10. To change feedback later, click **Edit scorecard** and save again.

## What you'll see

- The booked stage shows a chip with the date and time, and the interviewer's name appears on the stage line.
- The interview appears on the shared Calendar as a 60-minute meeting titled "Interview: <candidate> — <stage>", and the interviewer gets a personal reminder.
- The candidate is emailed an invitation with the stage, date and time, duration, and interviewer — subject line "Interview invitation — <position> at <workspace>".
- A saved scorecard shows on the stage as "Rating: 4/5", the recommendation badge (Strong hire, Hire, or No hire), and the strengths and concerns text.
- In My Interviews, each row shows the candidate, position, stage, and time, with a **Fill scorecard** or **Edit scorecard** button; empty view: "No interviews assigned to you."

## Common problems

**The date box was left empty.**

> Pick a date and time.

**No interviewer was chosen and the stage has no owner.**

> Pick an interviewer before scheduling.

**The interviewer already has an interview around that time.** The system refuses double-bookings within the same hour:

> Scheduling conflict: Priyanka Menon has "Interview 2 — Culture" within the same hour for this interviewer.

**You tried to schedule a non-interview stage.**

> Interviews can only be scheduled on INTERVIEW stages.

**Someone who is not the interviewer tried to fill the scorecard.**

> Only the assigned interviewer or an HR/admin can fill this scorecard.

**The interview time no longer suits the candidate.** Ask them to reply to the invitation email, then reschedule — the old calendar event and reminder are cleaned up and a fresh invitation with the new time is emailed.

## What happens behind the scenes

Scheduling writes one calendar event and one reminder for the interviewer, and records the time on the candidate's stage. Rescheduling replaces the previous event and reminder rather than leaving duplicates, and re-sends the invitation email on purpose so the candidate always has the latest time in writing. Every email is recorded in the audited outbox; if no mail provider is configured it is recorded as skipped and nothing is sent silently. Scorecard saves are limited to the assigned interviewer or Admin/HR, and each save is written to the audit log.

## Related flows

- [The hiring pipeline](pipeline.md) — the board the candidate lives on.
- [My Interviews](../self-service/my-interviews.md) — the interviewer's own view and scorecards.
- [Calendar](../work/calendar.md) — where the booked interview appears.
- [Composing and sending offers](offers.md) — the step after interviews go well.
