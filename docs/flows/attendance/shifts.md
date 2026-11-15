# Shifts and the roster

Fernly keeps the hours people are *expected* to work (shifts and the roster) separate from the hours they actually worked (attendance and timesheets) — this guide covers defining your shifts and planning who works which shift on which day.

## Who can use this

Staff with attendance-management rights: **Admin**, **HR** and **Super Admin**. Employees cannot open these pages — they see the resulting attendance days in their own screen (Sidebar → People → **My Attendance**).

## Where to find it

These are separate admin pages, not workspace sidebar screens:

- Shift master — open `/admin/shifts` directly.
- Roster grid — open `/admin/shifts/roster`, or click **Roster** in the HR Console (Sidebar → HR → **HR Console** → **Attendance** tab).
- One day's roster — click a date or its **Open** button in the grid; the address is `/admin/shifts/roster/<date>`, e.g. `/admin/shifts/roster/2026-11-10`.

Every page in this area has a **Fernly** back link at the top left (it returns you to the workspace) and header links to **Timesheets**, **Shifts** and **Roster**, so you can switch pages without typing addresses.

## When to use it

- Set up the shifts your workplace runs (e.g. "Early birds" 07:00–15:30) once, then reuse them every week.
- Plan who works which shift on which day for the coming week or month.
- Move a roster slot to another day, or hand it to a colleague.
- Record that a rostered slot was actually worked, or reset that correction.
- At the end of a day, flag everyone who was rostered but has no attendance mark.

## Before you start

- You need at least one shift marked **Active** before you can roster anyone — the assign list only offers active shifts.
- An employee can hold only one shift per day; a second slot on the same day is refused.
- The roster records expectations only — it never changes pay or attendance by itself.
- Times are 24-hour HH:mm (e.g. 09:00, 17:30).

## Steps

### Define a shift (the shift master)

1. Open `/admin/shifts`.
2. Click **New shift**.
3. Enter the **Name** (e.g. "Early birds").
4. Enter **Start (HH:mm)** and **End (HH:mm)**.
5. Enter **Unpaid break (min)** (0–240).
6. Leave **Active (rosterable)** ticked, or untick it to retire the shift.
7. Click **Save shift**.
8. To change a shift later, click **Edit** on its row and save again.

### Plan the week or month (the roster grid)

1. Open `/admin/shifts/roster` (it defaults to the current Mon–Sun week).
2. Use **Back** and **Next** to step week by week, or **This week** to return to today.
3. Click **Month view** to widen the grid to the whole month (and **Week view** to come back).
4. Drag a slot's chip onto another day to move it.
5. Click a date or its **Open** button to edit that day.

### Assign and manage one day (the day roster)

1. From the grid, click **Open** on the day (or the date itself).
2. Under "Assign a shift", pick an **Employee** and a **Shift**.
3. Click **Assign**.
4. To hand the slot to a colleague, click **Swap**, pick "Swap with…", then **Confirm swap**.
5. To record a worked slot, click **Complete**; to undo a status correction, click **Reset**.
6. To take a slot off the day entirely, click **Remove**.
7. At the end of the day, click **Mark absences** to flag no-shows.
8. Click **Back to the grid** when you are done.

## What you'll see

**The shift master** is a table with columns **Name**, **Times**, **Break**, **Expected**, **Slots**, **State** and **Actions**. Times show as "09:00 – 17:00" with an **overnight** tag when the end crosses midnight; Expected is the paid hours (the span minus the unpaid break); Slots counts the roster slots currently using the shift; State is **Active** or **Retired**.

**The roster grid** shows one row per day (weekends shaded), each carrying chips in the form "Employee · Shift" with a coloured status dot: **Scheduled**, **Completed**, **Absent (no attendance)** or **Swapped**. Empty days show "No slots". The header summarises the window, e.g. "2026-11-09 → 2026-11-15 · 14 slots across 7 days · 3 active shifts — drag a chip to another day."

**The day roster** is headed "Roster · {date}" with the day's slot and scheduled counts, then a table with columns **Employee**, **Shift**, **Status**, **Note** and **Actions**. Hovering a chip in the grid shows its status and note.

Confirmations appear as brief toasts, e.g. "Shift created.", "Slot assigned.", "Slot swapped.", "Slot removed.", "Ana's Early birds slot moved to 2026-11-12." and, after absence detection, "Absence detection run — every assigned-but-unmarked slot flipped ABSENT."

## Common problems

**The same shift name is used twice.** Rename one of them:
> A shift named "Early birds" already exists.

**The employee already has a slot that day.** Remove or swap the existing slot first:
> Ana is already rostered on 2026-11-10 — one shift per employee per day (cancel or swap the existing slot first).

**Start and end are the same time.** Overnight is fine (e.g. 22:00 → 06:00) but identical times are not:
> The start and end times cannot be the same.

**The unpaid break does not fit the shift.**
> The unpaid break cannot be longer than the shift's span.
> The unpaid break must be between 0 and 240 minutes.

**A time is not in HH:mm form.**
> The start time must be a valid HH:mm clock time.

**A chip was dropped on its own day.**
> That slot is already on that day.

**Swap refused.** Only slots still marked Scheduled can be swapped:
> Only a SCHEDULED slot can be swapped.

**A status button changed nothing.** The slot already carried that status:
> That slot already carries the requested status.

**The Save shift button stays disabled.** The **Name** is empty — a shift needs a name before it can be saved.

## What happens behind the scenes

- Expected hours are calculated for you: the time span, plus a full extra day when the shift crosses midnight, minus the unpaid break.
- Overnight is never typed in — it is derived from the times, and the slot links both calendar days it spans.
- One-shift-per-employee-per-day is enforced when the change is saved, so double-booking cannot slip through.
- Editing a shift updates future roster slots; slots already on the roster keep the times they were rostered with.
- **Mark absences** only runs when you click it: every Scheduled slot whose employee has no attendance mark for that day flips to Absent (no attendance) with the note "Absent — no attendance mark on the rostered day". Completed and Swapped slots stay untouched.
- Every change is written to the workspace audit log.

## Related flows

- [HR Console attendance](../hr/attendance.md) — marking the actual days the roster plans for.
- [Timesheet review](../hr/timesheet-review.md) — actual hours from submitted timesheets.
- [Punch log and attendance exceptions](biometric-punches.md) — clock-in/out events and the queue they feed.
- [My Attendance](../self-service/my-attendance.md) — what employees see of their own marked days.
