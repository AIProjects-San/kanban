# Roles and what they can do

Fernly gives each person one of five roles. Your role decides which screens you see and what you are allowed to change. This page explains the roles in general terms — you do not need to remember all of it; your sidebar only ever shows what you can actually use.

## Who can use this

Everyone. This is background knowledge for all Fernly users — no action needed.

## Where to find it

Your role is shown under your name in the account menu at the top right of the workspace, and in the **Settings** screen (Sidebar → General → **Settings**) next to **Role**. Admins can see everyone's roles in the Users screen (Sidebar → Administration → **Users**).

## When to use it

- When you wonder why a colleague sees screens you do not (or the other way round).
- When you need to find out who to ask for something — e.g. "who can approve my leave?" or "who runs payroll?".
- When an admin is deciding what role a new account should get.

## Before you start

- Roles are assigned by workspace admins when your account is created, and can be changed later in the Users screen.
- The five roles, from most to least access: **Super Admin**, **Admin**, **Manager**, **Member**, **HR**. (HR sits between Member and Manager in scope, but in a different area — people operations instead of projects.)

## Steps

1. To check your own role, click your name at the top right — the role appears under your name in the menu.
2. For the fuller picture, open Sidebar → General → **Settings** and read the **Role** field (it is read-only — "Roles are managed by workspace admins").
3. To find out who holds which role, ask an admin to check Sidebar → Administration → **Users** (or simply ask who runs HR or payroll in your workplace).

## What you'll see

**What each role can do:**

- **Super Admin** — the workplace owner's master account. Sees and does everything, including the parts nobody else can touch: tax rate tables and statutory rules, per-employee tax profiles, salary history, and the accounting trial balance.
- **Admin** — runs the workspace day to day. Everything except the statutory/tax tables: manages users and workspace settings, runs payroll and loans, full HR console, hiring. If your workplace has no Super Admin handy, the Admin is usually the person to ask.
- **HR** — the people operations role. Full HR console (leave, attendance, employee directory, reviews, onboarding, offboarding), hiring pipeline including offers, payroll, loans and employee documents. HR has no powers over projects and tasks.
- **Manager** — runs delivery. Creates and manages projects, tasks and bugs, sees the HR console, participates in hiring (including interviewing) and **approves job offers**. Cannot run payroll or manage users.
- **Member** — the standard contributor. Works on their own tasks and bugs, sees the team and calendar, and uses every self-service screen: leave requests, payslips, timesheets, attendance, interview scorecards, own profile and documents.

**Self-service is the same for everyone.** Whatever your role, you can always see and manage your own data — request leave, check your payslips, draft your timesheet, submit your documents. No special permission is needed for your own things.

**The sidebar adapts to your role:** a Member sees only Overview, Work and the self-service items under People plus Settings and Help; an HR user additionally sees the HR group (HR Console, Hiring, Payroll); admins see the Administration group (Users, Workspace Config, Audit Log). Opening a screen you lack the role for shows a plain "access restricted" panel naming your current role, with a **Back to Fernly** link — nothing breaks.

## Common problems

**A colleague has a screen you don't.**
Almost always a role difference. Check your role in the account menu (top right), and ask your admin if you think you need more access.

**You can see a list but not change it.**
Some screens mix read and write access — e.g. Managers can view the HR console but only HR/Admins can change leave types. The buttons you cannot use are either hidden or explained when you try.

**You need something done that your role doesn't allow.**
Find the right role from the list above and ask that person — e.g. password changes (admin), salary structure changes (Admin/HR), tax tables (Super Admin).

## What happens behind the scenes

Every action in Fernly double-checks your role on the server, not just in the sidebar — even if a link reached you by mistake, the server refuses the change and the attempt is recorded in the audit log. Roles are a property of your account, and admins can change them at any time from the Users screen; changes apply the next time you open a screen.

## Related flows

- [Workspace tour](workspace-tour.md) — the screens themselves.
- [Managing users](../admin/users.md) — how admins assign and change roles.
- [Managing roles and permissions](../admin/roles.md) — how admins can fine-tune what each role may do.
