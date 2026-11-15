# Biometric devices and device user mappings

The biometric screens let you register your clock-in devices and link each device's internal user numbers to your employees, so recorded punches can be turned into attendance.

> **Infrastructure ready, adapter not configured. Use CSV import until hardware is connected.**

## Who can use this

Staff with attendance-management rights: **Admin**, **HR** and **Super Admin**. Employees never see these screens.

## Where to find it

These are separate admin pages with no sidebar entry — open the address directly:

- Devices — `/admin/settings/biometric/devices`
- Mappings — `/admin/settings/biometric/mappings`

Once inside either page, the header links **Devices**, **Mappings**, **Punch log** and **Exceptions** switch between the four biometric pages, and the **Fernly** back link at the top left returns you to the workspace.

## When to use it

- Preparing your device list ahead of the hardware arriving — the screens can be filled in now; live device sync starts once hardware is connected.
- Recording each physical device's name, vendor, protocol and where it sits.
- Linking a device's user numbers to employees, one at a time or in bulk from a CSV.
- Adding a mapping whenever a new employee is enrolled on a device, so their punches resolve to them.

## Before you start

- You need at least one registered device before you can add mappings.
- The device user id is the number the device assigns to each person (e.g. 1001) — you will find it on the device or in its export.
- One mapping per device user per device, and an employee can only be mapped once per device.
- A push token is only needed for devices that will deliver punches automatically; leave it empty for CSV-only devices.

## Steps

### Register a device

1. Open `/admin/settings/biometric/devices`.
2. Click **Register device**.
3. Enter the **Name** (e.g. "Front door scanner").
4. Choose the **Vendor**: ZKTECO, SUPREMA, HIKVISION or OTHER.
5. Choose the **Protocol**: ADMS_PUSH, TCP_POLL, SDK or CSV_IMPORT.
6. Optionally enter **Serial (optional)** and **Location (optional)**.
7. Optionally paste a **Push token (16+ chars)**.
8. Set **Unpaid break (min)** (0–480) — the break deducted when this device's punches are turned into attendance.
9. Click **Register**.

### Manage a device

1. Use the icon buttons at the end of a device's row.
2. **Test connection** (circular arrows) checks the device is reachable and configured.
3. **Deactivate** / **Reactivate** (power) retires or restores a device without losing its history.
4. **Edit** (pencil) changes the name, serial, location, push token, break or active state, then click **Save changes**.
5. **Delete** (bin) removes the device for good.

### Map a device user to an employee

1. Open `/admin/settings/biometric/mappings`.
2. Under "Add a mapping", pick the **Device**.
3. Enter the **Device user id** (e.g. 1001).
4. Pick the **Employee**.
5. Click **Add mapping**.
6. To remove one later, click the bin icon at the end of its row.

### Import mappings in bulk

1. On the mappings page, click **Import CSV**.
2. Pick the **Import onto device**.
3. Click **Insert template** to load the expected layout, then edit it or paste your own CSV over it.
4. Click **Import mappings**.

The CSV needs a header row and one row per device user:

```csv
deviceUserId,employeeEmail
1001,alice@fernly.example
```

An `employeeId` column works instead of `employeeEmail`. Unknown employees reject the whole import — fix and re-upload. Rows that are already mapped are skipped, never doubled.

## What you'll see

**The devices table** has columns **Device**, **Vendor / protocol**, **Serial**, **Last sync**, **Punches**, **Mappings**, **Status** and **Actions**. Last sync reads "never" until the first punch import; Status is **Active** or **Inactive** with a "token set" or "no token" note and the device's break minutes.

**The mappings table** has columns **Device**, **Device user id**, **Employee**, **Since** and **Actions**. The "All devices" filter at the top narrows it to a single device.

Confirmations appear as toasts: "Device registered.", "Device updated.", `"Front door scanner" deleted.`, "Mapping saved.", "Mapping removed." and, after an import, `Imported 12 mapping(s) — 3 already mapped.`

## Common problems

**Delete refused.** Punch history is retained as evidence, and mappings must go first:
> "Front door scanner" has 128 punch(es) — punch history is retained. Deactivate the device instead.
> "Front door scanner" still has 3 employee mapping(s) — remove them first.

**The same serial is registered twice.**
> A device with serial "ABC123" is already registered.

**The push token is too short.**
> The push token must be at least 16 characters. (pushToken)

**The mapping already exists.**
> Device user 1001 or Ana Nguyen is already mapped on this device.

**Test connection says not available.** Polling-style protocols are not live yet — import that device's punches from CSV meanwhile:
> The ZKTECO TCP_POLL adapter arrives with the vendor integration — meanwhile, import this device's punches from CSV.

**A field was missed in the add form.**
> Pick a device, a device user id and an employee.

**Import clicked without a device or without a CSV.**
> Pick a device to import onto.
> Paste the CSV first.

**CSV problems.** The header row decides the format:
> Row 1: the header is missing the "deviceuserid" column.
> Row 1: the header needs an employeeEmail or an employeeId column.
> Row 3: an employeeEmail or employeeId is required.
> Row 3: "alice at fernly" is not a valid email.
> The CSV is empty.
> The CSV has 5001 rows — the limit is 5000 per upload.

**An employee is not found (the whole import is rejected).** Fix the address and re-upload — the same applies to an id column:
> No active employee with email alice@fernly.example.

## What happens behind the scenes

- Registering a device only records its details — the punches themselves arrive through the CSV import on the punch log page until live sync is switched on.
- The push token is stored write-only: it is never shown again, and the device row only says "token set".
- Deletion is refused while punches or mappings exist, because punch history is payroll evidence — deactivate instead.
- The mapping table is the lookup the reconcile pass uses: a punch whose device user has no mapping lands in the exceptions queue for a human decision.
- Every change is written to the workspace audit log.

## Related flows

- [Punch log and attendance exceptions](biometric-punches.md) — importing punches and clearing the queue.
- [HR Console attendance](../hr/attendance.md) — the attendance days punches turn into.
- [Shifts and the roster](shifts.md) — planning expected hours.
- [Audit log](../admin/audit-log.md) — the record of every change.
