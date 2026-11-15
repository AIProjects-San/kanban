# Marking a candidate as joined

When a selected candidate with a signed offer starts work, one button — **Mark joined** — turns them into an employee: account, profile, salary, and onboarding checklist are created in a single step.

## Who can use this

Admins and HR click the button. One follow-up needs an Admin: setting the new hire's starter password on the Users screen.

## Where to find it

Sidebar → HR → **Hiring**, open the candidate, and find **Mark joined** in the Decision panel (next to **Build offer**). The button only appears for candidates in the Selected state, and it stays disabled until their offer is signed.

## When to use it

- On (or just before) the new hire's first day, once their offer is signed and you are ready to create their employee record.
- Not before: the candidate must be Selected, with a SIGNED offer on file.

## Before you start

- Check the joining formalities section of the candidate's modal. If the joining gate is on (Workspace Config, on by default), **Mark joined** is refused while anything is outstanding.
- Confirm the signed offer carries salary components — the salary structure is copied from it. An offer without components joins the person with no salary structure, and you will need to fix payroll manually.
- Decide who relays the sign-in details: the welcome email may not be delivered (see below), so plan to hand over the printed day-one handout.

## Steps

1. Open the Hiring view and click the selected candidate.
2. Read the joining gate banner ("Joining gate — <summary>") and clear anything it lists — see [Candidate formalities](formalities.md).
3. Click **Mark joined**.
4. Read the confirmation message — it names the account that was created, for example "Priyanka Menon joined — account priyanka.menon@<your domain> created with an onboarding checklist. Welcome email sent."
5. Review the day-one handout that opens automatically (titled "Day-one handout — <name>"), and click **Print / save PDF** to get a paper copy.
6. Give the new hire their sign-in email (shown on the handout) — and see the password section below, because they cannot set one themselves.
7. Check the payroll line: either "Salary structure copied from the signed offer — payroll-ready." or, if the offer had no components, "No salary structure — the signed offer had no components. Fix payroll manually." — in which case set up their salary now.

## What you'll see

- The candidate's state becomes **HIRED**, with the note "Employee account created · joined <date>." and "Their onboarding checklist is live under HR → Onboarding."
- The day-one handout: the workspace name, the new account email ("Signed in as: <email>"), the sign-in address, the payroll verdict, a "Set your password" section, the "Your first two weeks" checklist with each task's due day, and the **Print / save PDF** button.
- If the welcome email could not be delivered, a warning toast tells you honestly:

> Priyanka Menon joined — account priyanka.menon@<domain> created with an onboarding checklist. BUT the welcome email was NOT delivered (no mail provider configured) — print the day-one handout and give the hire their sign-in email; they set a password via "Forgot password?".

- The handout then carries an extra warning: "The welcome email was **not delivered** (no mail provider configured) — this sheet is the joiner's only copy of their sign-in instructions. Hand it to <first name> on day one."

## Common problems

**The button is greyed out.** The candidate has no signed offer yet. If you try to force it another way, the refusal is:

> The candidate must sign their offer before joining (no SIGNED offer found).

**Joining was refused by the gate.** The message starts:

> Joining blocked — outstanding formalities: Passport: received, not yet verified; Background check (HireRight): in review.

The list names every outstanding item — "not requested yet", "requested, not yet received", "received, not yet verified", "rejected" for documents, "initiated" or "in review" for background checks. Clear them, then retry.

**The candidate is not in the Selected state.**

> Only selected candidates can be marked as joined.

**You are marking the same person again.**

> Priyanka Menon already joined (account exists).

**The new hire cannot sign in.** This is the known quirk — see below.

## What happens behind the scenes

One click does all of the following, in one step:

1. **Their account is created** with an email built from their name: first name dot last name at your workspace's hiring email domain — priyanka.menon@<domain>. If that address is already taken, a number is appended (priyanka.menon2@<domain>). The account gets a random one-time password that is never emailed and never shown to anyone.
2. **Their employee record is created**: the next employee number, job title and department from their candidate record (linked to your department and designation lists), a team roster entry, and — when the signed offer carries salary components — an active salary structure copied from the offer. If the offer had no components, nothing is copied and the warnings in the steps above appear; set up their salary manually.
3. **Their onboarding checklist starts** from your workspace template, with tasks due on working days counted from the join date. It is visible under HR → Onboarding and in the new hire's own onboarding view.
4. **A welcome email is queued** to the new address, subject "Welcome to <workspace>, <first>!", telling them their account email and: 'To set your password, open the app and use "Forgot password?" with that email.'
5. **Everything is written to the audit log** — who marked the join, the account created, the checklist, the salary verdict.

**The known quirk — the password.** The welcome email (and the printed handout) tell the new hire to use "Forgot password?" on the sign-in screen — but the sign-in screen has no "Forgot password?" feature; it only has the email and password boxes and a **Sign in** button. So that instruction does not work today. The real mechanism is:

- An admin opens the Users screen (Sidebar → Administration → **Users**), edits the new hire's row, and types a starter password under **Reset password (optional)** ("Leave blank to keep the current password. Enter a new one to reset.").
- The admin shares that password with the new hire through a channel they trust.
- The new hire signs in with their account email and that password, then changes it in Settings after their first sign-in.

Treat the email's "Forgot password?" wording as a known mismatch, and rely on the admin-set starter password instead.

## Related flows

- [Candidate formalities](formalities.md) — clearing the joining gate before this step.
- [Composing and sending offers](offers.md) — the signed offer this all starts from.
- [Users](../admin/users.md) — where the admin sets the starter password.
- [Onboarding](../hr/onboarding.md) — the checklist the new hire now works through.
- [Salary setup](../payroll/salary-setup.md) — the manual fix when the offer carried no components.
