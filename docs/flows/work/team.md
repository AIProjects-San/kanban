# Team and messages

Browse your colleagues' workload and profiles in the Team view, send them direct messages, and manage those conversations from the Inbox in the top bar.

## Who can use this

Every signed-in user. Anyone who can send a message can also delete their own sent or received messages. Team member records themselves are created by Admins from the Users screen, not from the Team view.

## Where to find it

- Team view: Sidebar → People → **Team** (or press `G` then `M`).
- Inbox: the **Inbox** icon in the top bar (press `I`). It shows a count badge for unread messages.

## When to use it

- Checking who is online, someone's open task count or their workload before assigning work.
- Opening a colleague's profile to see their recent tasks and logged hours.
- Sending a quick question to one colleague.
- Reading and replying to messages others sent you.

## Before you start

The Team list is scoped: Admins see everyone; others see colleagues from the projects they can access. Member profiles show task and hour statistics only for work you are allowed to see. Messages are one-to-one — there are no group channels.

## Steps

**Finding a colleague**

1. Open Sidebar → People → **Team**.
2. Type into **Search members…** (name, role or email).
3. Filter by department chips: **All**, **Engineering**, **Design**, **Marketing**, **Management**.

**Opening a profile**

1. Click **Profile** on a member card.
2. Review the **Overview** stats — **Open**, **Done** and **Hours (30d)** — and the **Current workload** bar with its hint ("At capacity — consider reassigning tasks.", "Healthy load with room for more." or "Light load — available for new work.").
3. Scroll through **Assigned tasks** and **Recent activity** (hours by project and recent entries).
4. Expand **History & Audit** for that member's change timeline.
5. Click **Send message** to write to them, or close the drawer.

**Sending a message from the Team view**

1. Click **Message** on a member card (or **Send message** in their profile).
2. Enter a **Subject** — if you leave it blank, "(no subject)" is used.
3. Type the **Message** body (required).
4. Click **Send message**.

**Using the Inbox**

1. Click the **Inbox** icon in the top bar.
2. Click a conversation to open it — opening a thread with unread messages marks it as read.
3. Read the bubbles; messages you sent are aligned and labelled "You".
4. Type your reply in the **Reply to Name…** box and click **Reply** (or press ⌘/Ctrl + Enter, as the hint "⌘+Enter to send" suggests).
5. Hover over any message and click **Delete** to remove it.
6. Use the back arrow (**Back to inbox**) to return to the list, or close the drawer.

## What you'll see

- The Team header shows "N online now · M total members" with a live indicator.
- Member cards show the avatar with an online dot, role, department, **Open tasks** and **Completed** counts, and a **Workload** bar (green under 50%, amber to 79%, red from 80%).
- The profile drawer is titled **Member profile** and shows email, department badge, online/offline status, assigned tasks (capped at six, then "+N more open tasks") and recent hours.
- The Inbox list shows each conversation's participant, subject, latest line, age ("now", "5m", "3h", "2d"), and "N messages · M unread" for longer threads; unread conversations are highlighted.
- Empty states: "No team members match your filters." on Team; "No messages yet" with "Messages from your team will appear here. Send a message from the Team page to start a conversation." in the Inbox.

## Common problems

**You cannot add a team member.**

The Team view has no add button by design. Ask an Admin to create the person from Administration → **Users** (see [Users](../admin/users.md)).

**Send fails with an empty body warning.**

> Message body is required

The subject is optional, but the message text is not. The same applies in the Inbox:

> Reply body is required

**Delete is refused.**

> You can only delete messages you sent or received.

You cannot remove other people's copies of a conversation.

**A message you deleted still shows for your colleague.**

Deleting removes the message from your view; each person controls only their own copy.

**Someone has no tasks or hours on their profile.**

Either they genuinely have none, or your role's scope hides that work. Their workload percentage only reflects work you can see.

## What happens behind the scenes

Sending a message stores it in a conversation thread addressed to that colleague; the sender is always recorded from your signed-in account, so a message can never appear to come from someone else. Opening a thread records that you have read its unread messages, which clears the top-bar badge count. Deleting a message hides it from you and records the action in the audit log — it does not erase the audit history. Nothing is emailed; messages reach the other person inside Fernly only.

## Related flows

- [Tasks](tasks.md) — the assignments and hours shown on profiles.
- [Dashboard](dashboard.md) — the Team Collaboration card and its online avatars.
- [Calendar](calendar.md) — schedule a meeting instead of a message.
- [Your account settings](../self-service/my-account.md) — notification preferences.
- [Workspace tour](../getting-started/workspace-tour.md) — the top bar and its icons.
