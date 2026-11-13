// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-2 regression: per-recipient message direction/read state.
//
// The audit (Fernly-Launch-Readiness-Audit.docx L-P0-2) found that:
//   - direction was stored from the SENDER's POV but READ from the current
//     viewer's POV, so a sent message (direction="OUT") rendered on the
//     wrong side of the thread for the recipient.
//   - one global `read` flag was shared by both parties, so when the sender
//     marked their own copy read, the recipient's inbox badge disappeared.
//   - markThreadRead required `direction: "IN"` which never matched real
//     sent messages (they were stored as "OUT"), so recipients could never
//     clear unread state.
//
// Fix: derive direction per viewer (recipientUserId === me ? "IN" : "OUT"),
// store read state in a per-recipient MessageRead join table, and have
// markThreadRead match on `recipientUserId === me` instead of `direction: "IN"`.

const { db, getBetterSession } = vi.hoisted(() => {
  const getBetterSession = vi.fn();
  const models = [
    "auditLog", "project", "task", "teamMember", "reminder", "notification",
    "timeEntry", "calendarEvent", "message", "messageRead", "bug", "user", "userSettings",
    "projectAssignment", "workspace", "role", "permission", "rolePermission",
    "taskStatusConfig", "projectStatusConfig", "eventTypeConfig",
    "leaveRequest", "leaveType", "leavePolicy", "leaveBalance",
    "taskTagConfig", "priorityConfig", "departmentConfig",
  ];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const db: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    db[m] = {};
    for (const meth of methods) db[m][meth] = vi.fn();
  }
  (db as Record<string, unknown>).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      typeof fn === "function" ? fn(db) : Promise.resolve(fn),
  );
  return { db, getBetterSession };
});

vi.mock("@/lib/auth/auth-better", () => ({
  // The Better Auth session seam (PR-49 default stack). revokeUserSessions
  // is stubbed so password-change flows that call the revocation bridge
  // never touch a real instance.
  getBetterSession,
  revokeUserSessions: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/infra/db", () => ({ db }));

import { sendMessage, markMessageRead, markThreadRead } from "@/server-actions/messages";
import { getDashboardData } from "@/server-actions/dashboard";

const SENDER = { userId: "u-sender", role: "ADMIN", name: "Sender", email: "s@x" };
const RECIPIENT = { userId: "u-recipient", role: "ADMIN", name: "Recipient", email: "r@x" };

function signInAs(user: typeof SENDER | null) {
  getBetterSession.mockResolvedValue(
    user
      ? { userId: user.userId, role: user.role, name: user.name, email: user.email }
      : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(null);
  db.auditLog.create.mockResolvedValue({});
  db.task.aggregate.mockResolvedValue({ _max: { order: 0 } });
  db.task.findMany.mockResolvedValue([]);
  // Dashboard loader defaults — return empty arrays for every query so the
  // tests can focus on the message-specific behaviour.
  db.project.findMany.mockResolvedValue([]);
  db.teamMember.findMany.mockResolvedValue([]);
  db.reminder.findMany.mockResolvedValue([]);
  db.notification.findMany.mockResolvedValue([]);
  db.timeEntry.findMany.mockResolvedValue([]);
  db.calendarEvent.findMany.mockResolvedValue([]);
  db.projectAssignment.findMany.mockResolvedValue([]);
  for (const table of [
    "taskStatusConfig", "projectStatusConfig", "eventTypeConfig",
    "taskTagConfig", "priorityConfig", "departmentConfig",
    "role", "permission", "rolePermission",
  ]) {
    db[table].findMany.mockResolvedValue([]);
  }
});

describe("L-P0-2: per-recipient message direction & read state", () => {
  it("sendMessage stores direction='OUT' regardless of input direction (write path)", async () => {
    signInAs(SENDER);
    db.message.create.mockResolvedValue({});
    await sendMessage({
      direction: "IN", // ignored — caller can't forge direction
      senderName: SENDER.name,
      recipientName: RECIPIENT.name,
      recipientUserId: RECIPIENT.userId,
      subject: "hi",
      body: "yo",
    });
    expect(db.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: "OUT",
          senderUserId: SENDER.userId,
          recipientUserId: RECIPIENT.userId,
          read: false,
        }),
      }),
    );
  });

  it("dashboard loader derives direction='IN' for the recipient and 'OUT' for the sender", async () => {
    // One message: sender=SENDER, recipient=RECIPIENT.
    const msgRow = {
      id: "m-1",
      direction: "OUT", // stored value — should be IGNORED by the loader
      threadId: "th-1",
      memberId: null,
      senderUserId: SENDER.userId,
      recipientUserId: RECIPIENT.userId,
      senderName: SENDER.name,
      senderAvatarColor: "forest",
      senderRole: "",
      recipientName: RECIPIENT.name,
      subject: "hi",
      body: "yo",
      read: false,
      createdAt: new Date(),
      readBy: [],
    };
    db.message.findMany.mockResolvedValue([msgRow]);

    // Sender view: direction should be "OUT", read should be true (own copy).
    signInAs(SENDER);
    const senderView = await getDashboardData();
    expect(senderView.messages[0].direction).toBe("OUT");
    expect(senderView.messages[0].read).toBe(true);

    // Recipient view: direction should be "IN", read should be false (no
    // MessageRead row yet, legacy `read` is also false).
    signInAs(RECIPIENT);
    const recipientView = await getDashboardData();
    expect(recipientView.messages[0].direction).toBe("IN");
    expect(recipientView.messages[0].read).toBe(false);
  });

  it("recipient marks a thread read; sender's view is unaffected (the L-P0-2 contract)", async () => {
    // Two messages in the thread, both addressed to RECIPIENT.
    const msgRows = [
      {
        id: "m-1", direction: "OUT", threadId: "th-1", memberId: null,
        senderUserId: SENDER.userId, recipientUserId: RECIPIENT.userId,
        senderName: SENDER.name, senderAvatarColor: "forest", senderRole: "",
        recipientName: RECIPIENT.name, subject: "hi", body: "yo",
        read: false, createdAt: new Date(), readBy: [],
      },
      {
        id: "m-2", direction: "OUT", threadId: "th-1", memberId: null,
        senderUserId: SENDER.userId, recipientUserId: RECIPIENT.userId,
        senderName: SENDER.name, senderAvatarColor: "forest", senderRole: "",
        recipientName: RECIPIENT.name, subject: "Re: hi", body: "yo back",
        read: false, createdAt: new Date(), readBy: [],
      },
    ];

    // Recipient marks the thread read.
    signInAs(RECIPIENT);
    db.message.findMany.mockResolvedValue(msgRows.map((m) => ({ id: m.id })));
    db.messageRead.createMany.mockResolvedValue({ count: 2 });
    await markThreadRead("th-1");
    expect(db.messageRead.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { userId: RECIPIENT.userId, messageId: "m-1" },
          { userId: RECIPIENT.userId, messageId: "m-2" },
        ],
        // NOTE: skipDuplicates was removed (unsupported on SQLite); the
        // readBy-none pre-filter already guarantees the rows are new.
      }),
    );

    // After the recipient's markThreadRead, the SENDER's view is unaffected:
    // the sender's own copy is implicitly read (they wrote it), and no
    // MessageRead row was created for the sender. The legacy `read` column
    // is unchanged.
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });

  it("markMessageRead silently no-ops when called by someone other than the recipient", async () => {
    // Message addressed to RECIPIENT, but SENDER tries to mark it read.
    signInAs(SENDER);
    db.message.findUnique.mockResolvedValue({
      id: "m-1",
      recipientUserId: RECIPIENT.userId,
    });
    await markMessageRead("m-1");
    expect(db.messageRead.upsert).not.toHaveBeenCalled();
  });

  it("strips the readBy relation from the client payload (no internal leak)", async () => {
    // The loader must NOT ship readBy to the client — it's an implementation
    // detail. Verify the field is absent from the returned messages.
    const msgRow = {
      id: "m-1",
      direction: "OUT",
      threadId: "th-1",
      memberId: null,
      senderUserId: SENDER.userId,
      recipientUserId: RECIPIENT.userId,
      senderName: SENDER.name,
      senderAvatarColor: "forest",
      senderRole: "",
      recipientName: RECIPIENT.name,
      subject: "hi",
      body: "yo",
      read: false,
      createdAt: new Date(),
      readBy: [{ id: "mr-1", userId: RECIPIENT.userId, messageId: "m-1", readAt: new Date() }],
    };
    db.message.findMany.mockResolvedValue([msgRow]);

    signInAs(RECIPIENT);
    const view = await getDashboardData();
    expect(view.messages[0]).not.toHaveProperty("readBy");
    // The recipient has a MessageRead row, so the derived `read` is true.
    expect(view.messages[0].read).toBe(true);
  });
});
