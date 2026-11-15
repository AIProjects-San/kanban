# Offboarding

The Offboarding tab of the HR console handles everything after an employee decides to leave (or is asked to): the separation checklist, the exit interview and the full-and-final settlement statement.

## Who can use this

HR admins only (Super Admin, Admin, HR). The Offboarding tab is hidden from everyone else.

## Where to find it

Sidebar → HR → HR Console → Offboarding tab.

## When to use it

- An employee has resigned or been given notice.
- You need to run the handover checklist (device return, access revocation and so on).
- You want to schedule and complete the exit interview.
- The employee has left and the final settlement needs generating and settling.

## Before you start

- Record the exit itself first, from the Directory tab: edit the employee and set Employment status to Exited with a **Last working day**. The full-and-final statement computes only once the exit is recorded.
- The full flow is: Directory (record exit) → Offboarding (checklist + interview + generate) → settle.
- One live exit interview per employee; a cancelled interview frees the slot for a new one.

## Steps

1. Record the exit: Directory tab → edit the employee → Employment → status **Exited**, set **Last working day**, save.
2. Open Sidebar → HR → HR Console → Offboarding tab.
3. Click **Start separation**, pick the **Employee** and click **Start separation**. This creates the separation checklist from the default template (handover, device return, access revocation, exit interview, full-and-final settlement).
4. Work the checklist: tick tasks as they complete — assignees can also tick their own from their settings.
5. For the exit interview, click **Record exit interview** (or "Record a new exit interview" after a cancellation). The interview starts as Pending.
6. Enter the **Interview date** and optionally pick the **Interviewer**, then click **Schedule** (or **Reschedule**).
7. Optionally type **Outcome notes** and click **Complete**. Use **Cancel** if the interview is called off.
8. Once the employee's status is Exited, click **Generate statement** for the full-and-final.
9. Review the computed lines (salary, encashment, recoveries, loans…), and if the amounts changed since generation, click **Refresh snapshot** first.
10. Click **Settle — freeze amounts** when everything is agreed. The amounts freeze and payslip editing locks.

## What you'll see

- One card per leaving employee: name, job title, hire date, LWD, notice weeks and the employment status badge.
- The separation checklist with its progress bar and per-task rows (assignee, due date, required flags).
- The exit interview block with its status badge — **Pending**, **Scheduled**, **Completed** or **Cancelled** — and its scheduling controls.
- The full-and-final block: a status of **Not generated**, **Unsettled** or **Settled**; lines grouped as payables and receivables with a **Net payable** total (negative means owed back); the day rate and working-day basis; and notes explaining each line.
- A warning when amounts drifted since generation: "Amounts changed since generation (snapshot $X) — settle freezes today's values."

## Common problems

**The full-and-final shows "Not generated" and no button.**
The exit has not been recorded yet — set status Exited with a last working day in the Directory tab first.

> A full-and-final statement needs an exited employee — record the exit (with a last working day) first.

**Settle is refused.**
Nothing was generated yet, or it is already settled:

> No full-and-final statement for Alex yet — generate it first.

> This statement is already settled — the frozen amounts are final.

**A second exit interview is refused.**
Only one live interview per employee:

> Alex already has a live exit interview (scheduled).

**Generate is missing.**
It appears only while the employee is Exited and the statement is unsettled; a settled statement is final.

**An employment change on the employee is refused.**
Exited employees are closed for changes:

> Alex has exited — employment changes are settled by the full-and-final, never re-opened.

## What happens behind the scenes

Starting a separation instantiates the checklist from the workspace's separation template, with due dates counted in working days and required tasks flagged for the settlement gate. The full-and-final statement is recomputed live from today's facts — salary for days worked, leave encashment, advance-leave recoveries, outstanding loans and similar lines — until you settle it, which freezes the amounts and locks payslip editing so history cannot drift afterwards. Interview scheduling notifies the chosen interviewer, and every action lands in the audit log.

## Related flows

- [Employee directory](directory.md) — recording the exit status and last working day.
- [Onboarding](onboarding.md) — the same checklist machinery for new hires, and the template editor.
- [Leave, encashment and comp-off approvals](leave-requests.md) — encashments feed the settlement lines.
- [Payroll runs](../payroll/runs.md) — how settled amounts are paid.
- [Advances and loans](../payroll/advances.md) — recoverable balances that appear as receivables.
