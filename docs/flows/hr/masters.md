# Employee masters: departments, designations and grades

Three admin pages hold the workspace's organizational building blocks: the department tree, the designation (job-title) list and the grade ladder with its salary bands.

## Who can use this

HR admins (Super Admin, Admin, HR) can view and edit the masters. Managers and Members cannot open these pages.

## Where to find it

Sidebar → HR → HR Console → Directory tab, then use the footer links **Departments**, **Designations** or **Grades**. The pages live at `/admin/settings/hr/departments`, `/admin/settings/hr/designations` and `/admin/settings/hr/grades`, and each page's header links to its two siblings so you can hop between them.

## When to use it

- Setting up or reorganizing the department structure (including sub-departments).
- Maintaining the list of job titles and linking each one to a grade.
- Defining the grade ladder and each grade's salary band.
- Before running transfers or promotions, so the pickers offer the right destinations.

## Before you start

- Departments form a tree: every department can sit under a parent.
- Designations link to grades; grades carry an optional salary band (minimum and maximum annual pay).
- Nothing is ever deleted while people still use it — deactivate instead.
- Workspace Config has its own smaller "Departments" tab — that is a separate list for the workspace's default-department setting, not these masters (see "Common problems" below).

## Steps

### Departments

1. Open the Directory tab footer link **Departments** (or go to `/admin/settings/hr/departments`).
2. Click **Add department**.
3. Fill in **Name**, an optional **Code (optional — payroll reporting key)** (e.g. ENG), a **Parent department** for a sub-department (or "— a root department —"), and an optional **Cost center (optional — future GL integration)**.
4. Click **Add department**. The row appears in the tree, children indented under their parents.
5. To rename or re-parent, click the pencil, adjust and click **Save changes**.
6. To hide a department from pickers without deleting it, use the power icon to deactivate it.
7. To delete, use the bin icon — only when no employees or child departments reference it.

### Designations

1. Open **Designations** from the header links or the Directory footer (`/admin/settings/hr/designations`).
2. Click **Add designation**.
3. Enter **Name** (e.g. Backend Engineer), an optional **Code**, and optionally pick a **Grade** from the ladder.
4. Click **Add designation**. Edit, deactivate or delete with the row icons, same as departments.

### Grades

1. Open **Grades** (`/admin/settings/hr/grades`).
2. Click **Add grade**.
3. Enter **Name** (e.g. L4), a **Level (ordering)** number, and optionally **Band minimum (annual, optional)** and **Band maximum (annual, optional)**.
4. Click **Add grade**. The list shows each grade's level, salary band, how many designations link to it and how many employees hold it.

## What you'll see

- Departments: a table of **Department** (tree-indented, "· under <parent>"), **Code**, **Cost center**, **Employees**, **Status** (Active / Inactive) and row actions.
- Designations: **Designation**, **Code**, **Grade**, **Employees**, **Status** and actions.
- Grades: **Level**, **Grade**, **Salary band (annual)** (e.g. "$60,000 – $90,000"), **Designations**, **Employees**, **Status** and actions.
- Every page header starts with the Fernly link back to the workspace and links to the sibling master pages.
- Renames are confirmed with messages like: "Department updated — profile labels follow the rename."
- Workspace Config's **Departments** tab is a separate list (see "Common problems" below) — editing it does not change these masters.

## Common problems

**A department cannot be deleted.**
People still sit in it, or it has children:

> 3 employee profiles still reference "Engineering" — move them first, or deactivate the department instead of deleting it.

> "Engineering" has 2 child departments — move or delete them first.

**A designation or grade cannot be deleted.**
The same guard applies — holders (and, for grades, linked designations) block the delete. Deactivate instead.

**A grade will not save.**
The band is invalid:

> The salary band's minimum cannot exceed its maximum.

**A department cannot be its own parent.**
The tree must stay a tree:

> A department cannot report into itself or its own subtree — pick a different parent.

**Names collide.**
Department names and codes must be unique, as must designation and grade names — pick another name or code.

### What about the "Departments" tab in Workspace Config?

The Workspace Config screen (Sidebar → Administration → Workspace Config → **Departments** tab) maintains a separate, simpler list: it feeds the **Default department** dropdown on the same screen's General tab, which sets the department applied to new users' team-roster entries. It is not the department tree on these masters pages, and the two do not sync — a department added or renamed in Workspace Config does not appear in the HR masters pages or HR pickers, and vice versa. For anything employee- or HR-related, maintain the tree here; treat the Workspace Config tab as a legacy roster default only.

## What happens behind the scenes

Renaming a department, designation or grade immediately updates every employee profile that references it, so the directory, reports and exports always show the new name — no one has to be re-tagged one by one. Deletion is refused rather than cascaded, which is why deactivation exists. Transfer and promotion documents keep their own snapshot of names at the time they were recorded, so past documents never change when a master is renamed later.

## Related flows

- [Employee directory](directory.md) — the tab whose footer links land here.
- [Transfers and promotions](transfers-promotions.md) — documents that move people between these masters.
- [Employment documents](employment-documents.md) — the index page for those documents.
- [Workspace configuration](../admin/workspace-config.md) — its Departments tab is a separate roster-default list, not these masters.
