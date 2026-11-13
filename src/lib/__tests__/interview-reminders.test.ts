import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P26 (PL-03/RJ-B18) — the interview reminder engine. The pure kernel
// (which same-day interviews are due a nudge, with which variables and
// sourceKeys) plus the scheduled writer (personal notifications idempotent
// via the unique sourceKey; the opt-in email gated by the newly-written
// set — a same-day re-run queues nothing).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["candidateStage", "calendarEvent", "user", "notification", "mailOutbox"];
  const methods = ["findMany", "findUnique", "findFirst", "create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const getWorkspaceConfigMock = vi.fn();
vi.mock("@/lib/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
}));

const queueOutboxMailMock = vi.fn();
const deliverOutboxMailMock = vi.fn();
vi.mock("@/lib/server/mail-outbox", () => ({
  queueOutboxMail: (...a: unknown[]) => queueOutboxMailMock(...a),
  deliverOutboxMail: (...a: unknown[]) => deliverOutboxMailMock(...a),
}));

const logErrorSpy = vi.fn();
const logInfoSpy = vi.fn();
vi.mock("@/lib/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability")>();
  return { ...actual, logError: (...a: unknown[]) => logErrorSpy(...a), logInfo: (...a: unknown[]) => logInfoSpy(...a) };
});

import {
  dueInterviewReminders,
  runInterviewRemindersJob,
  interviewEmailHtml,
  type InterviewNudgeCandidate,
  type InterviewReminderSwitches,
} from "../interview-reminders";
import { resolveNotificationTemplate, sampleTemplateVars } from "../notification-template";

const SWITCHES_ON: InterviewReminderSwitches = { remindInterviews: true };

function interview(overrides: Partial<InterviewNudgeCandidate>): InterviewNudgeCandidate {
  return {
    stageId: "st-1",
    interviewerUserId: "u-1",
    interviewerName: "Ingrid Solberg",
    candidateName: "Rafael Costa",
    position: "Senior Frontend Engineer",
    stageLabel: "Technical screen",
    timeLabel: "14:00",
    eventDay: "2026-11-10",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The pure kernel
// ---------------------------------------------------------------------------

describe("P26 — dueInterviewReminders (the pure rule)", () => {
  it("fires one nudge per same-day interview, with the deterministic sourceKey and vars", () => {
    const nudges = dueInterviewReminders({
      asOf: "2026-11-10",
      interviews: [interview({})],
      switches: SWITCHES_ON,
    });
    expect(nudges).toHaveLength(1);
    expect(nudges[0].sourceKey).toBe("INTERVIEW_REMINDER:st-1:2026-11-10");
    expect(nudges[0].interviewerUserId).toBe("u-1");
    expect(nudges[0].vars).toEqual({
      interviewerName: "Ingrid Solberg",
      candidateName: "Rafael Costa",
      position: "Senior Frontend Engineer",
      stageLabel: "Technical screen",
      timeLabel: "14:00",
      date: "2026-11-10",
    });
  });

  it("only the picked day matches — yesterday's and tomorrow's interviews never nudge", () => {
    const nudges = dueInterviewReminders({
      asOf: "2026-11-10",
      interviews: [interview({ eventDay: "2026-11-09" }), interview({ eventDay: "2026-11-11", stageId: "st-2" })],
      switches: SWITCHES_ON,
    });
    expect(nudges).toHaveLength(0);
  });

  it("the switch off → not a single row (the workspace gate)", () => {
    const nudges = dueInterviewReminders({
      asOf: "2026-11-10",
      interviews: [interview({})],
      switches: { remindInterviews: false },
    });
    expect(nudges).toHaveLength(0);
  });

  it("an interview without a live interviewer is skipped (nobody to send to)", () => {
    const nudges = dueInterviewReminders({
      asOf: "2026-11-10",
      interviews: [interview({ interviewerUserId: null })],
      switches: SWITCHES_ON,
    });
    expect(nudges).toHaveLength(0);
  });

  it("two same-day interviews get two nudges; the same stage+day always re-derives the SAME key (a same-day reschedule never double-nudges)", () => {
    const first = dueInterviewReminders({
      asOf: "2026-11-10",
      interviews: [interview({}), interview({ stageId: "st-2", timeLabel: "16:30" })],
      switches: SWITCHES_ON,
    });
    expect(first.map((n) => n.sourceKey)).toEqual([
      "INTERVIEW_REMINDER:st-1:2026-11-10",
      "INTERVIEW_REMINDER:st-2:2026-11-10",
    ]);
    // A reschedule WITHIN the day (new time, same stage, same day)…
    const after = dueInterviewReminders({
      asOf: "2026-11-10",
      interviews: [interview({ timeLabel: "17:00" })],
      switches: SWITCHES_ON,
    });
    // …re-derives the identical key, so the unique index swallows it.
    expect(after[0].sourceKey).toBe(first[0].sourceKey);
  });

  it("a reschedule to ANOTHER day nudges on the new day (a new key — the new day needs its own nudge)", () => {
    const nudges = dueInterviewReminders({
      asOf: "2026-11-12",
      interviews: [interview({ eventDay: "2026-11-12" })],
      switches: SWITCHES_ON,
    });
    expect(nudges[0].sourceKey).toBe("INTERVIEW_REMINDER:st-1:2026-11-12");
  });
});

// ---------------------------------------------------------------------------
// The scheduled writer
// ---------------------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10);

const CONFIG_BASE = {
  workspace: {
    remindInterviews: true,
    emailInterviewReminders: false,
  },
  notificationTemplates: [],
};

type StageRow = {
  id: string;
  label: string;
  scheduledAt: Date | null;
  eventId: string | null;
  ownerUserId: string | null;
  candidate: { fullName: string; position: string };
};

function stage(overrides: Partial<StageRow>): StageRow {
  return {
    id: "st-1",
    label: "Technical screen",
    scheduledAt: new Date(`${TODAY}T14:00:00Z`),
    eventId: "ev-1",
    ownerUserId: "u-1",
    candidate: { fullName: "Rafael Costa", position: "Senior Frontend Engineer" },
    ...overrides,
  };
}

function seedStages(
  stages: StageRow[],
  opts: {
    events?: Array<{ id: string; date: Date; time: string }>;
    users?: Array<{ id: string; name: string; email: string }>;
    existingNotifications?: Array<{ sourceKey: string }>;
  } = {},
) {
  const eventIds = stages.map((s) => s.eventId).filter((id): id is string => id !== null);
  db.candidateStage.findMany.mockResolvedValue(stages);
  db.calendarEvent.findMany.mockResolvedValue(
    opts.events ?? (eventIds.length ? [{ id: "ev-1", date: new Date(`${TODAY}T00:00:00Z`), time: "14:00" }] : []),
  );
  db.user.findMany.mockResolvedValue(opts.users ?? [{ id: "u-1", name: "Ingrid Solberg", email: "ingrid@x.co" }]);
  db.notification.findMany.mockResolvedValue(opts.existingNotifications ?? []);
  db.notification.create.mockResolvedValue({ id: "n-1" });
  db.mailOutbox.findUnique.mockResolvedValue({ toAddress: "ingrid@x.co", subject: "s", body: "b" });
  queueOutboxMailMock.mockImplementation(async () => ({ id: "mo-1" }));
  deliverOutboxMailMock.mockResolvedValue({ status: "SENT", providerMessageId: "", error: "" });
}

describe("P26 — runInterviewRemindersJob (the scheduled writer)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceConfigMock.mockResolvedValue({ ...CONFIG_BASE });
    seedStages([]);
  });

  it("writes ONE personal notification per due nudge, rendered through the registry defaults", async () => {
    seedStages([stage({})]);
    const report = await runInterviewRemindersJob();

    expect(report.interviewsConsidered).toBe(1);
    expect(report.dueInterviews).toBe(1);
    expect(report.notificationsWritten).toBe(1);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
    const data = db.notification.create.mock.calls[0][0].data;
    expect(data.recipientUserId).toBe("u-1"); // personal, never a broadcast
    expect(data.type).toBe("INFO");
    expect(data.sourceKey).toBe(`INTERVIEW_REMINDER:st-1:${TODAY}`);
    expect(data.title).toBe("Interview today: Rafael Costa");
    expect(data.message).toBe("Technical screen with Rafael Costa at 14:00 — Senior Frontend Engineer.");
  });

  it("asks only for OPEN stages on ACTIVE candidates with an interviewer (the eligibility is in the query)", async () => {
    seedStages([stage({})]);
    await runInterviewRemindersJob();
    const where = db.candidateStage.findMany.mock.calls[0][0].where;
    expect(where.stageType).toBe("INTERVIEW");
    expect(where.scheduledAt).toEqual({ not: null });
    expect(where.status).toEqual({ in: ["PENDING", "IN_PROGRESS"] });
    expect(where.ownerUserId).toEqual({ not: null });
    expect(where.candidate).toEqual({ status: "ACTIVE" });
  });

  it("the picked event day wins over the instant (an event on tomorrow's day is not nudged today)", async () => {
    // The instant is TODAY 23:30Z, but the HR user picked TOMORROW's day
    // (F-R18: the picked day is the display truth) — no nudge today.
    seedStages([stage({ scheduledAt: new Date(`${TODAY}T23:30:00Z`) })], {
      events: [{ id: "ev-1", date: tomorrowMidnight(), time: "09:00" }],
    });
    const report = await runInterviewRemindersJob();
    expect(report.dueInterviews).toBe(0);
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("a same-day re-run writes nothing (the sourceKey pre-check)", async () => {
    seedStages([stage({})], { existingNotifications: [{ sourceKey: `INTERVIEW_REMINDER:st-1:${TODAY}` }] });
    const report = await runInterviewRemindersJob();
    expect(report.dueInterviews).toBe(1); // the nudge IS due…
    expect(report.notificationsWritten).toBe(0); // …but the row already exists
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("a unique-index race on create is skipped, not a failed pass", async () => {
    seedStages([stage({})]);
    db.notification.create.mockRejectedValue(new Error("UNIQUE constraint failed: Notification.sourceKey"));
    const report = await runInterviewRemindersJob();
    expect(report.notificationsWritten).toBe(0);
    expect(logErrorSpy).toHaveBeenCalled();
  });

  it("nothing due → no writes, an honest empty report", async () => {
    const report = await runInterviewRemindersJob();
    expect(report.interviewsConsidered).toBe(0);
    expect(report.dueInterviews).toBe(0);
    expect(report.notificationsWritten).toBe(0);
    expect(report.emailsQueued).toBe(0);
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(queueOutboxMailMock).not.toHaveBeenCalled();
  });

  it("the switch off → an early no-op pass (the stages are never even read)", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      workspace: { ...CONFIG_BASE.workspace, remindInterviews: false },
    });
    const report = await runInterviewRemindersJob();
    expect(report.dueInterviews).toBe(0);
    expect(db.candidateStage.findMany).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("a deleted interviewer is filtered — no notification can be written", async () => {
    seedStages([stage({})], { users: [] }); // the live-user query returns nobody
    const report = await runInterviewRemindersJob();
    expect(report.interviewsConsidered).toBe(1);
    expect(report.dueInterviews).toBe(0);
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("a legacy stage without an event falls back to the instant's UTC day and time", async () => {
    seedStages([stage({ eventId: null, scheduledAt: new Date(`${TODAY}T09:30:00Z`) })], { events: [] });
    const report = await runInterviewRemindersJob();
    expect(report.dueInterviews).toBe(1);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
    const data = db.notification.create.mock.calls[0][0].data;
    expect(data.message).toBe("Technical screen with Rafael Costa at 09:30 — Senior Frontend Engineer.");
  });

  it("email OFF (the default): no outbox rows even when nudges fire", async () => {
    seedStages([stage({})]);
    const report = await runInterviewRemindersJob();
    expect(report.notificationsWritten).toBe(1);
    expect(report.emailsQueued).toBe(0);
    expect(queueOutboxMailMock).not.toHaveBeenCalled();
  });

  it("email ON: one outbox row per newly written nudge, to the interviewer's address", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      workspace: { ...CONFIG_BASE.workspace, emailInterviewReminders: true },
    });
    seedStages([stage({}), stage({ id: "st-2", eventId: "ev-2", label: "Onsite loop" })], {
      events: [
        { id: "ev-1", date: new Date(`${TODAY}T00:00:00Z`), time: "14:00" },
        { id: "ev-2", date: new Date(`${TODAY}T00:00:00Z`), time: "16:30" },
      ],
    });
    const report = await runInterviewRemindersJob();
    expect(report.notificationsWritten).toBe(2);
    expect(report.emailsQueued).toBe(2);
    expect(queueOutboxMailMock).toHaveBeenCalledTimes(2);
    const arg = queueOutboxMailMock.mock.calls[0][1] as { kind: string; toAddress: string; subject: string; text: string; sentById: string };
    expect(arg.kind).toBe("INTERVIEW_REMINDER");
    expect(arg.toAddress).toBe("ingrid@x.co"); // the interviewer, never the candidate
    expect(arg.subject).toBe("Interview today"); // preview-safe — no candidate name
    expect(arg.text).toContain("Hi Ingrid Solberg,");
    expect(arg.text).toContain("Rafael Costa");
    expect(arg.sentById).toBe("cron:interview-reminders");
    expect(deliverOutboxMailMock).toHaveBeenCalledTimes(2);
  });

  it("email ON, re-run: nothing is queued — the in-app write gates the email", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      workspace: { ...CONFIG_BASE.workspace, emailInterviewReminders: true },
    });
    seedStages([stage({})], { existingNotifications: [{ sourceKey: `INTERVIEW_REMINDER:st-1:${TODAY}` }] });
    const report = await runInterviewRemindersJob();
    expect(report.notificationsWritten).toBe(0);
    expect(report.emailsQueued).toBe(0);
    expect(queueOutboxMailMock).not.toHaveBeenCalled();
  });

  it("an interviewer with no email on file: the notification stands, no outbox row", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      workspace: { ...CONFIG_BASE.workspace, emailInterviewReminders: true },
    });
    seedStages([stage({})], { users: [{ id: "u-1", name: "Ingrid Solberg", email: "" }] });
    const report = await runInterviewRemindersJob();
    expect(report.notificationsWritten).toBe(1);
    expect(report.emailsQueued).toBe(0);
    expect(queueOutboxMailMock).not.toHaveBeenCalled();
  });

  it("a delivery failure never fails the pass (best-effort, logged)", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      workspace: { ...CONFIG_BASE.workspace, emailInterviewReminders: true },
    });
    seedStages([stage({})]);
    deliverOutboxMailMock.mockRejectedValue(new Error("provider down"));
    const report = await runInterviewRemindersJob();
    expect(report.notificationsWritten).toBe(1);
    expect(report.emailsQueued).toBe(1);
    expect(logErrorSpy).toHaveBeenCalled();
  });

  it("a customized template row flows into the nudge (the P24 registry rides)", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      notificationTemplates: [
        {
          eventKey: "INTERVIEW_TODAY",
          subjectTemplate: "Your {{stageLabel}} today",
          bodyTemplate: "Team — {{candidateName}} at {{timeLabel}}.",
          titleTemplate: "[{{position}}] {{candidateName}}",
          messageTemplate: "{{stageLabel}} at {{timeLabel}} with {{candidateName}}.",
        },
      ],
    });
    seedStages([stage({})]);
    await runInterviewRemindersJob();
    const data = db.notification.create.mock.calls[0][0].data;
    expect(data.title).toBe("[Senior Frontend Engineer] Rafael Costa");
    expect(data.message).toBe("Technical screen at 14:00 with Rafael Costa.");
  });
});

// Tomorrow's UTC midnight (the picked-day truth helper for the test above).
function tomorrowMidnight(): Date {
  const t = new Date();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) + 86_400_000);
}

// ---------------------------------------------------------------------------
// The registry event + the email HTML wrap
// ---------------------------------------------------------------------------

describe("P26 — the INTERVIEW_TODAY registry event", () => {
  it("renders its default through the registry with its own sample variables", () => {
    const vars = sampleTemplateVars("INTERVIEW_TODAY");
    const tpl = resolveNotificationTemplate([], "INTERVIEW_TODAY");
    expect(tpl.subject).toBe("Interview today");
    expect(tpl.title.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "")).toContain("Rafael Costa");
    expect(tpl.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "")).toContain("You have an interview today at 14:00.");
    expect(tpl.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "")).toContain("Hi Ingrid Solberg,");
  });
});

describe("P26 — interviewEmailHtml (the nudge wrap)", () => {
  it("escapes HTML per line and joins with <br />", () => {
    const html = interviewEmailHtml("Hi <b>Ingrid</b>,\n\nInterview at 14:00.");
    expect(html).toContain("Hi &lt;b&gt;Ingrid&lt;/b&gt;,<br /><br />Interview at 14:00.");
    expect(html).toContain("font-family: Arial");
  });
});
