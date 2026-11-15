# Managing roles and permissions

The Roles & Permissions tab of Workspace Config is where admins create custom roles and fine-tune exactly what each role is allowed to do.

## Who can use this

Workspace admins — **Admin** and **Super Admin** (the same people who can open Workspace Config).

## Where to find it

Sidebar → Administration → **Workspace Config**, then the **Roles & Permissions** tab.

## When to use it

- You need a role that sits between the standard ones — e.g. someone who may review work but not delete anything.
- A role should gain or lose one specific capability.
- An unused custom role should be tidied away.

## Before you start

- Read [Roles and what they can do](../getting-started/roles.md) first — it explains the five standard roles in plain terms. This page covers only the admin actions.
- Roles that ship with Fernly are system roles: their cards are marked "system" and they cannot be deleted.
- Changing a role's permissions changes them for everyone who has that role, so review who is affected before you untick anything.

## Steps

### Creating a custom role

1. Click **Add role**.
2. Fill in **Key (e.g. REVIEWER)** — a short name for the list. It is saved in capitals, with spaces turned into underscores (typing "Senior Reviewer" gives "SENIOR_REVIEWER").
3. Fill in **Label (e.g. Reviewer)** — the display name people see.
4. Optionally fill in **Description** (e.g. "Can review tasks but not delete them").
5. Tick the capabilities the role should have — they are grouped by area, with a short explanation under each.
6. Click **Create role**.

### Editing which permissions a role has

1. Find the role's card in the list.
2. Click **Edit permissions**.
3. Tick a capability to grant it, or untick to remove it — each tick is saved immediately, with a "Permissions updated" pop-up.
4. Click **Close** when you are done.

### Deleting a custom role

1. Click **Delete** on the role's card.
2. Confirm when asked.

## What you'll see

- A count line above the list: how many roles and permissions exist, plus the note "System roles can't be deleted".
- One card per role: its name on a badge, the "system" mark for built-in roles, the description, how many permissions it has ("N perms"), and the **Edit permissions** link.
- When a role is open for editing, its permissions appear as a checklist grouped by area — ticked means allowed.
- Pop-up confirmations: "Role created", "Permissions updated", "Role deleted".

## Common problems

**"Key and label are required"**
Both the short name and the display name must be filled in before the role can be created.

**A role cannot be created because the name is taken.**

   > Role "REVIEWER" already exists.

Pick a different key or label.

**A role cannot be deleted while people still have it.**

   > Cannot delete role "Reviewer" — 2 user(s) still have it. Reassign them first.

Change those people to another role in the Users screen first (see [Managing users](users.md)).

**"System roles cannot be deleted."**
The built-in roles are permanent. If one no longer fits, change its permissions instead of trying to delete it.

**You created a role but cannot pick it when creating a user.**
The **Role** dropdown in the create/edit user form offers the three standard choices (Admin, Manager, Member). Custom roles still show in this tab's list; to change what a group of people can do, editing the permissions of a standard role is the dependable route.

## What happens behind the scenes

Each tick or untick replaces the role's full set of permissions in one go, so a role can never end up half-configured. People who are already signed in pick up the new permissions the next time they open a screen — no need for them to sign out. The power to manage roles itself is reserved: only an Admin can hand it to another role. Deleting a role is refused while anyone still holds it, and every change to a role is recorded in the audit log.

## Related flows

- [Roles and what they can do](../getting-started/roles.md) — the plain-language explainer.
- [Managing users](users.md) — assigning roles to people.
- [Workspace Config](workspace-config.md) — the screen this tab lives in.
- [Audit Log](audit-log.md) — where role changes are recorded.
