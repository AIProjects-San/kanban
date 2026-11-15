# Punch log and attendance exceptions

The punch log lists every clock-in/out event recorded for your devices, and the exceptions queue collects the ones that need a human decision — punches that could not be matched to an employee, duplicates and one-sided days.

> **Infrastructure ready, adapter not configured. Use CSV import until hardware is connected.**

## Who can use this

Staff with attendance-management rights: **Admin**, **HR** and **Super Admin**. Employees never see these screens.

## Where to find it

These are separate admin pages with no sidebar entry — open the address directly:

- Punch log — `/admin/attendance/punches`
- Exceptions queue — `/admin/attendance/exceptions`

Once inside, the header links **Devices**, **Mappings**, **Punch log** and **Exceptions** switch between the biometric pages, and the **Fernly** back link at the top left returns you to the workspace.

## When to use it

- Bringing punches in from a device's export file — the recommended route until hardware sync is live.
- Turning imported punches into attendance days (the reconcile pass).
- Assigning a punch that could not be matched to an employee, or dismissing one that should not count.
- Reviewing duplicates and one-sided days (an IN with no OUT, or an OUT with no IN).

## Before you start

- At least one device must be registered, and the CSV import lands on the device chosen in the log's **Device** filter.
- Punches only become attendance after you run reconcile — importing alone changes nothing.
- Mapping device users to employees in advance (see [Biometric devices](biometric-devices.md)) avoids most exceptions.
- Each CSV upload is limited to 5000 rows; larger exports must be split.

## Steps

### Import punches from CSV

1. Open `/admin/attendance/punches`.
2. In the filter bar, set **Device** to the device the punches came from — the import lands on it.
3. Click **Import CSV**.
4. Click **Insert template** to see the expected layout, then paste your own CSV over it.
5. Click **Import punches**.

The file needs a header row and one row per punch:

```csv
deviceUserId,punchedAt,direction,verifyMethod
1001,2026-11-10 09:00,IN,FINGERPRINT
1001,2026-11-10 17:30,OUT,
```

- `punchedAt` accepts a timezone-tagged timestamp (2026-11-10T09:00:00+13:00), a device epoch number, or a plain "yyyy-MM-dd HH:mm" read as New Zealand local time.
- `direction` is IN, OUT or UNKNOWN (an empty cell counts as UNKNOWN).
- Column names are not case-sensitive, extra columns are ignored, and text fields may be quoted.
- Re-sending the same punch (same device user and instant) is skipped as a duplicate, not an error.

### Run reconcile

1. Click **Reconcile**.
2. Pick the **Device**.
3. Set **From (NZ day)** and **To (NZ day)**.
4. Click **Run reconcile**.
5. Read the on-screen report — it counts processed, matched, attended, unmatched and duplicate punches, records created and updated, and any missing-IN or missing-OUT days.

### Match an unmatched punch

1. Open `/admin/attendance/exceptions`.
2. Under "Unmatched punches — no device-user mapping", pick the person from the "This punch belongs to…" list.
3. Click **Match**.
4. Run reconcile again — the attendance day is derived on the next pass.

### Ignore a punch

1. In the same section, find the punch that should not count.
2. Click **Ignore**.

### Browse the log

1. Use the **Device**, **Status**, **From (NZ day)** and **To (NZ day)** filters.
2. Click **Apply** (or **Clear** to reset them).
3. Use **Previous** and **Next** to move through the pages (50 punches per page).

## What you'll see

**The punch log** is a table with columns **When (NZ)**, **Device**, **Device user**, **Employee**, **Dir.**, **Verify**, **Status** and **Record**. Each status shows as a badge: **Pending**, **Matched**, **Attended**, **Unmatched**, **Duplicate** or **Ignored**. The Record column reads "linked" once the punch has become part of an employee's attendance day.

**The exceptions queue** is four counted sections, and the page notes that the last 30 days of records are scanned:

- "Unmatched punches — no device-user mapping" — each row shows the day, time, direction, device and device user, with the employee picker plus **Match** and **Ignore** buttons.
- "Missing OUT punches — an IN with no OUT" — with the hint to correct the mark in the attendance grid.
- "Missing IN punches — an OUT with no IN" — the same hint.
- "Duplicate punches — re-deliveries + double-taps" — collapsed automatically; they derive no attendance of their own.

Empty sections say so plainly, e.g. "Nothing waiting — every punch maps to an employee."

Confirmations appear as toasts: "Imported 96 punch(es) — 4 duplicate skip(s).", "Reconcile pass complete.", "Punch matched — the attendance record derives on the next reconcile pass." and "Punch ignored — it stays as evidence but derives no attendance."

## Common problems

**No device chosen, or nothing pasted.** Set the Device filter first, and paste the CSV before importing:
> Pick a device filter first (the CSV imports onto it).
> Paste the punch CSV first.

**A required column is missing from the header.**
> Row 1: the header is missing the "deviceuserid" column.
> Row 1: the header is missing the "punchedat" column.

**A timestamp cannot be read.**
> Row 3: punchedAt "10/11/2026" is not a valid timestamp (zoned ISO, epoch, or "yyyy-MM-dd HH:mm" NZ local).

**A direction is not recognised.**
> Row 3: direction "INOUT" is not IN, OUT or UNKNOWN.

**A device user is missing or too long.**
> Row 3: deviceUserId is required (1–64 characters).

**Too many rows in one file.** Split the export and upload the parts:
> The CSV has 5001 rows — the limit is 5000 per upload.

**The reconcile window is backwards.**
> The reconcile window start must not be after its end.

**Match clicked without choosing an employee.**
> Pick the employee this punch belongs to.

**A punch is already part of attendance.** Fully processed punches can no longer be re-matched or ignored:
> This punch has already been reconciled into attendance — it can no longer be re-matched.
> This punch has already been reconciled into attendance — it cannot be ignored.

**A day shows only IN or only OUT.** Correct the mark in the HR Console attendance grid — the queue only points it out.

## What happens behind the scenes

- CSV punches land in the same punch log as device-delivered punches and are treated identically.
- Reconcile resolves each device user through the mappings table; unmapped punches become Unmatched and wait in the exceptions queue.
- For each employee and day, the earliest punch counts as the IN and the latest as the OUT; extra punches in between are collapsed as duplicates.
- A matched punch becomes part of the employee's attendance for that day on the next reconcile pass.
- A day HR already marked manually always outranks the engine — the punches are linked but the mark is left alone.
- Weekends and full holidays get no automatic attendance mark: the punches are kept as evidence and the day is left to HR.
- An ignored punch stays as evidence but never creates attendance.
- Running the same reconcile window twice changes nothing the second time.
- Every import, reconcile, match and ignore is written to the workspace audit log.

## Related flows

- [Biometric devices and device user mappings](biometric-devices.md) — registering devices and linking device users.
- [HR Console attendance](../hr/attendance.md) — the attendance grid the exceptions point to.
- [My Attendance](../self-service/my-attendance.md) — what employees see of their own days.
- [Shifts and the roster](shifts.md) — planning expected hours alongside actual punches.
