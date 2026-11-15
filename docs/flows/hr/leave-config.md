# Leave types, policies and holidays

The Types & Policies and Holidays tabs of the HR console define what leave your workspace offers, how entitlement is granted, and which days are removed from working-day counting.

## Who can use this

HR admins only (Super Admin, Admin, HR). Managers can view the HR console but do not see these two tabs.

## Where to find it

Sidebar → HR → HR Console → Types & Policies tab (leave types, policy sets, leave periods) and the neighbouring Holidays tab (the holiday calendar).

## When to use it

- Setting up leave for a new workspace: creating types such as Annual, Sick or Parental leave.
- Changing how many days a year a type grants, how it accrues, or whether days can be carried over.
- Giving different groups of employees different allocation packages (policy sets).
- Switching the workspace from a calendar leave year to a custom window, e.g. April to March (leave periods).
- Recording public holidays and company off days.

## Before you start

- Deactivating a type hides it from request forms; existing requests and balances are kept.
- Leave periods are forward-looking: the first custom window must start in a year the leave engine has not yet granted into.
- Holidays only affect working-day counting from now on — existing requests and payroll runs keep the counts they were created with.

## Steps

### Leave types

1. Open the Types & Policies tab and click **New Type**.
2. Fill in **Name**, **Code (UPPER_CASE)** and **Color**.
3. Tick **Paid** and **Requires docs** as needed. For a paid type you can set **Salary fraction (0–1)** (e.g. 0.5 = half paid while on leave).
4. Tick **Optional leave** (holiday/weekend applications that don't consume balance) or **Compensatory** (days arrive via worked-holiday claims) if the type needs it.
5. Set the policy numbers: **Days / year**, **Max carry-over**, **Min notice (days)**, **Max consecutive (days)**.
6. Choose an **Allocation strategy** — Manual (grant on first use), Annual lump sum, Earned (accrues) or After N months of service — and fill in the extra fields it reveals.
7. Optionally allow advance (negative) leave with a floor, set carry-over expiry, or make holidays consume leave days.
8. For encashable types, tick **Encashable** under it and set **Max / request (days)** and **Floor stays (days)**.
9. Click **Create type**.
10. To change an existing type later, click **Edit** on its card; to hide it, click **Deactivate**.

### Policy sets

1. In the Policy sets section, click **New set**.
2. Enter **Name** and an optional **Description**, then add one allocation row per leave type with **Add type** and the annual day counts.
3. Click **Create set**.
4. To hand the package to employees, click **Assign…** on the set, choose the **Target window**, tick the employees (or **Select all**) and click **Assign to N employee(s)**.
5. Existing assignments appear under "Live assignments" as **granted** or **pending window**; a pending one can still be removed with the bin button.

### Leave periods

1. In the Leave periods section, fill in **Name**, **Starts** and **Ends** (e.g. FY 2028/29, Apr → Mar).
2. Click **Add period**. Rows show as **upcoming**, **active** or **closed**.
3. Remove a future window with its **Delete** button. Active or closed windows are never deletable.

### Holidays

1. Switch to the Holidays tab and pick the year with the arrows.
2. Click **Add holiday**.
3. Set **Date**, **Label** (e.g. Waitangi Day), **Kind** (Public holiday or Weekly off / company off day) and, if it counts as half a working day, tick **Half day (counts 0.5 working days)**.
4. Click **Add holiday**. Edit with the pencil, delete with the bin.

## What you'll see

- One card per leave type showing its colour, code and chips (paid / % pay / unpaid, docs, optional, comp-off, advance, strategy), with the four headline numbers: days / year, carry over, notice and max run.
- The Leave periods section, empty by default: "No named periods — allocations ride the implicit calendar year (Jan 1 → Dec 31)."
- The Policy sets section listing each set's allocations (e.g. "Annual Leave 20d · Sick Leave 10d"), assignment count and its live assignments.
- The Holidays tab listing entries as "Mon 25 Dec 2026" with their kind and half-day flag; without entries, working days are simply Monday–Friday.

## Common problems

**A type cannot be created.**
Names and codes must be unique:

> A leave type named "Parental" (or code PARENTAL) already exists — names and codes must be unique.

**A leave period is refused.**
New windows must start in the future and in a year the engine has not granted into yet:

> A new leave period must start in the future (after 2026-06-01) — a window that already started would race the daily allocation pass.

> The 2027 allocation bucket already has engine grants — named periods are forward-looking. Create the first custom window for a start year the calendar-year engine has not yet granted into.

**A period cannot be deleted.**
Its year already has leave history:

> "FY 2026/27"'s allocation bucket (2026) has 14 ledger row(s) — a window with history is never deleted. Only future windows can be removed.

**A policy set's allocations cannot be edited.**
Once any of its assignments has granted days, the numbers are frozen (history is immutable). Create a successor set and assign it to the next window instead.

**A holiday cannot be added.**
Each date may appear once:

> 2026-12-25 is already a holiday — one entry per date. Edit the existing entry instead.

## What happens behind the scenes

Leave balances live on an append-only ledger: the policy engine adds entitlement rows (manual, lump sum, accrued or after-service), approvals consume rows, and expiries remove lapsed carry-over. A policy set simply overrides the per-type annual allocation for the employees it is assigned to, for one window; a mid-window joiner is pro-rated from their hire date. Holiday entries are excluded from working-day counting when leave requests and payroll runs are created — each one stores its own count at that moment, so later calendar edits never rewrite history.

## Related flows

- [Leave, encashment and comp-off approvals](leave-requests.md) — deciding the requests these rules govern.
- [Requesting leave (self-service)](../self-service/leave.md) — what employees see of these rules.
- [Attendance](attendance.md) — holidays are shaded in the attendance grid.
- [Workspace configuration](../admin/workspace-config.md) — workspace-wide switches that sit alongside these rules.
