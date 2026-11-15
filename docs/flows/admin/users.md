# Managing users

The Users screen is where workspace admins create login accounts, set passwords, change roles and remove people — nobody can sign up on their own.

## Who can use this

Workspace admins — **Admin** and **Super Admin**. Managers, HR and Members do not see this screen in their sidebar.

## Where to find it

Sidebar → Administration → **Users**.

## When to use it

- A new colleague needs to sign in — accounts are created here, and Fernly has no sign-up page.
- Someone forgot their password and needs a new one (there is no self-service password reset).
- A person's role, reporting line or details change.
- Someone leaves and their access must be removed.
- A new hire's account was created automatically when HR marked them as joined, and needs its first usable password (see [Marking a candidate as joined](../recruitment/mark-joined.md)).

## Before you start

- Have the person's details ready: name, email address, role, and who they report to.
- You will set the starting password yourself in the form. No invite email is sent — you must pass the password to the person yourself, securely.
- Deleting is blocked for your own account: ask another admin to remove you.

## Steps

### Creating a user account

1. Click **Create user** (top right).
2. Fill in **Full name**.
3. Fill in **Email (login)** — this is the address the person signs in with.
4. Choose a **Role**: **Admin — full access**, **Manager — create & edit**, or **Member — own tasks only**.
5. Optionally choose **Reports to** (their manager) — leave **— No manager (root) —** for top-level people.
6. Optionally adjust **Timezone**, **Department**, **Job title**, **Bio** and **Avatar color**.
7. In the **Login credentials** box, type a password (placeholder: "At least 8 characters"), or click the generate button next to the field (tooltip: "Generate a strong password") and copy the suggested one from the pop-up.
8. Click **Create user**.

### Setting or resetting someone's password

1. Click the edit (pencil) button on the person's row.
2. In the **Reset password (optional)** box, type the new password (or generate one).
3. Leave the box blank to keep their current password.
4. Click **Save changes**.

### Changing a role or other details

1. Click the edit (pencil) button on the person's row.
2. Change **Role**, **Reports to** or any other field.
3. Click **Save changes**.

### Removing a user

1. Click the delete (bin) button on the person's row.
2. Read the confirmation carefully and confirm. It reads, for example:

   > Delete user "Jane Smith"? This will also remove all their project assignments. This cannot be undone.

## What you'll see

- The heading **User Management** with a count line, the filter chips **All** / **Admin** / **Manager** / **Member**, and a **Search users…** box.
- Each row shows the person's name (yours marked "(you)"), role badge, email, "Joined" date, and **Reports to:** line.
- A button showing how many **projects** the person is on — click it to expand the list — plus **Assign** (to add them to projects).
- A collapsible **Permission matrix** at the bottom comparing what Admin, Manager and Member can do.
- After creating a user, the pop-up confirms:

   > User created

   with the line "<name> can now sign in with <email>". After saving an edit: "User updated". After removing: "User deleted".
- When editing an existing user, the form ends with a **History & Audit** section — expand it to see that person's recorded changes.

## Common problems

**"A user with email <email> already exists."**
Every account needs a unique email address. Check for typos, or edit the existing account instead of creating a new one.

**"Password must be at least 8 characters"**
The minimum follows the workspace's **Min password length** setting (never below 8). Use the generate button to get a valid one.

**"You cannot delete your own account"**
Ask another admin to remove your account. The delete button is also greyed out on your own row.

**"You cannot change your own role. Ask another admin to do it."**
Self-demotions are blocked on purpose — have another admin make the change.

**A new hire marked joined cannot sign in.**
Accounts created through the hiring pipeline get a random password that nobody knows. Open the user here and set a proper one with **Reset password (optional)**.

**The person cannot see certain projects.**
Use the **Assign** button on their row to add them to the projects they should see.

## What happens behind the scenes

Creating a user makes the login account and their team directory entry in one step, so they can be assigned tasks immediately — but no email is ever sent, so you must hand over the password yourself. Resetting a password or changing a role signs the person out of Fernly everywhere, and they simply sign in again with the new details. Deleting a user removes their access and hides them from lists; their project assignments go with them, but their past messages and records stay intact, and the confirmation warns it cannot be undone. Every create, edit and delete is recorded in the audit log. Hire accounts created automatically use an address generated from the person's name and the workspace's hiring email domain (fernly.app by default).

## Related flows

- [Signing in to Fernly](../getting-started/sign-in.md) — what the person does with the account you created.
- [Roles and what they can do](../getting-started/roles.md) — choosing the right role.
- [Marking a candidate as joined](../recruitment/mark-joined.md) — how new hire accounts are created automatically.
- [Workspace Config](workspace-config.md) — the **Min password length** and default settings for new people.
- [Audit Log](audit-log.md) — where these changes are recorded.
