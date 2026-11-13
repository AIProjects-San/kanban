import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P25 (PL-02/EM-23/EM-J01–03) — the engagement reminder engine. The pure
// kernel (which digests are due, with which variables and sourceKeys) plus
// the scheduled writer (broadcast notifications idempotent via the unique
// sourceKey; the opt-in email digest with the day-window dedup).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["employeeProfile", "user", "holidayCalendarEntry", "notification", "mailOutbox"];
  const methods = ["findMany", "findUnique", "findFirst", "create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate"];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

const getWorkspaceConfigMock = vi.fn();
vi.mock("@/lib/infra/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
}));

const queueOutboxMailMock = vi.fn();
const deliverOutboxMailMock = vi.fn();
vi.mock("@/lib/email/mail-outbox", () => ({
  queueOutboxMail: (...a: unknown[]) => queueOutboxMailMock(...a),
  deliverOutboxMail: (...a: unknown[]) => deliverOutboxMailMock(...a),
}));

const logErrorSpy = vi.fn();
const logInfoSpy = vi.fn();
vi.mock("@/lib/infra/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/observability")>();
  return { ...actual, logError: (...a: unknown[]) => logErrorSpy(...a), logInfo: (...a: unknown[]) => logInfoSpy(...a) };
});

import {
  dueEngagementReminders,
  runEmployeeRemindersJob,
  engagementEmailHtml,
  type EngagementEmployee,
  type EngagementHoliday,
  type EngagementSwitches,
} from "@/lib/hr/employee-reminders";
import { resolveNotificationTemplate, renderTemplate } from "@/lib/email/notification-template";

const SWITCHES_ON: EngagementSwitches = {
  remindBirthdays: true,
  remindAnniversaries: true,
  remindHolidays: true,
  holidayReminderDaysAhead: 7,
};

function employee(overrides: Partial<EngagementEmployee>): EngagementEmployee {
  return {
    userId: "u-1",
    name: "Theo Vance",
    birthDate: null,
    hireDate: null,
    employmentStatus: "ACTIVE",
    ...overrides,
  };
}

function holiday(date: string, label: string): EngagementHoliday {
  return { date, label };
}

// ---------------------------------------------------------------------------
// The pure kernel
// ---------------------------------------------------------------------------

describe("P25 — dueEngagementReminders (the pure rule)", () => {
  it("fires the birthday digest on the month-day match, listing everyone celebrating", () => {
    const events = dueEngagementReminders({
      asOf: "2026-06-14",
      employees: [
        employee({ userId: "u-1", name: "Theo Vance", birthDate: "1992-06-14" }),
        employee({ userId: "u-2", name: "Hana Park", birthDate: "1995-01-26" }),
        employee({ userId: "u-3", name: "Marcus Bell", birthDate: null }),
      ],
      holidays: [],
      switches: SWITCHES_ON,
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventKey).toBe("EMPLOYEE_BIRTHDAY");
    expect(events[0].sourceKey).toBe("ENGAGEMENT:BIRTHDAY:2026-06-14");
    expect(events[0].vars.names).toBe("Theo Vance");
    expect(events[0].vars.count).toBe("1");
    expect(events[0].vars.date).toBe("2026-06-14");
  });

  it("two celebrants compose 'A and B'; EXITED employees never celebrate", () => {
    const events = dueEngagementReminders({
      asOf: "2026-11-28",
      employees: [
        employee({ userId: "u-r", name: "Rafael Costa", birthDate: "1989-11-28" }),
        employee({ userId: "u-h", name: "Hana Park", birthDate: "1995-11-28" }),
        employee({ userId: "u-x", name: "Exited Person", birthDate: "1990-11-28", employmentStatus: "EXITED" }),
      ],
      holidays: [],
      switches: SWITCHES_ON,
    });
    expect(events).toHaveLength(1);
    expect(events[0].vars.names).toBe("Rafael Costa and Hana Park");
    expect(events[0].vars.count).toBe("2");
  });

  it("a Feb-29 birthday fires on Mar 1 in a non-leap year and Feb 29 in a leap year", () => {
    const leap = dueEngagementReminders({
      asOf: "2028-02-29",
      employees: [employee({ birthDate: "1996-02-29" })],
      holidays: [],
      switches: SWITCHES_ON,
    });
    expect(leap).toHaveLength(1);
    const nonLeap = dueEngagementReminders({
      asOf: "2027-03-01",
      employees: [employee({ birthDate: "1996-02-29" })],
      holidays: [],
      switches: SWITCHES_ON,
    });
    expect(nonLeap).toHaveLength(1);
    // And never on Feb 28 of a non-leap year.
    const feb28 = dueEngagementReminders({
      asOf: "2027-02-28",
      employees: [employee({ birthDate: "1996-02-29" })],
      holidays: [],
      switches: SWITCHES_ON,
    });
    expect(feb28).toHaveLength(0);
  });

  it("anniversaries carry whole years; the hire day itself (0 years) is not one", () => {
    const events = dueEngagementReminders({
      asOf: "2026-03-04",
      employees: [
        employee({ userId: "u-i", name: "Ingrid Solberg", hireDate: "2023-03-04" }),
        employee({ userId: "u-new", name: "New Hire", hireDate: "2026-03-04" }),
        employee({ userId: "u-none", name: "No Hire Date", hireDate: null }),
      ],
      holidays: [],
      switches: SWITCHES_ON,
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventKey).toBe("EMPLOYEE_ANNIVERSARY");
    expect(events[0].sourceKey).toBe("ENGAGEMENT:ANNIVERSARY:2026-03-04");
    expect(events[0].vars.names).toBe("Ingrid Solberg (3 years)");
    expect(events[0].vars.count).toBe("1");
  });

  it("the holiday digest fires exactly N days ahead — not N±1 — and keys by the holiday's date", () => {
    const holidays = [holiday("2026-12-25", "Christmas Day"), holiday("2026-12-26", "Boxing Day")];
    const on = dueEngagementReminders({
      asOf: "2026-12-18", employees: [], holidays, switches: SWITCHES_ON,
    });
    expect(on).toHaveLength(1);
    expect(on[0].eventKey).toBe("HOLIDAY_UPCOMING");
    expect(on[0].sourceKey).toBe("ENGAGEMENT:HOLIDAY:2026-12-25");
    expect(on[0].vars.holidayName).toBe("Christmas Day");
    expect(on[0].vars.holidayDate).toBe("2026-12-25");
    expect(on[0].vars.daysAhead).toBe("7");

    for (const asOf of ["2026-12-17", "2026-12-20", "2026-12-26"]) {
      expect(dueEngagementReminders({ asOf, employees: [], holidays, switches: SWITCHES_ON })).toHaveLength(0);
    }
  });

  it("the daysAhead knob is clamped (0/negative → 7, >30 → 30)", () => {
    const events = dueEngagementReminders({
      asOf: "2026-11-10",
      employees: [],
      holidays: [holiday("2026-11-17", "Auckland Anniversary")],
      switches: { ...SWITCHES_ON, holidayReminderDaysAhead: 0 },
    });
    expect(events).toHaveLength(1); // 0 clamps to 7 → 7 days ahead matches
    const far = dueEngagementReminders({
      asOf: "2026-11-10",
      employees: [],
      holidays: [holiday("2026-12-10", "Too Far")],
      switches: { ...SWITCHES_ON, holidayReminderDaysAhead: 99 },
    });
    expect(far).toHaveLength(1); // 99 clamps to 30 → 30 days ahead matches
  });

  it("each switch gates its own digest; an empty day writes nothing at all", () => {
    const employees = [employee({ birthDate: "1992-06-14" })];
    const none = dueEngagementReminders({
      asOf: "2026-06-14", employees, holidays: [],
      switches: { ...SWITCHES_ON, remindBirthdays: false },
    });
    expect(none).toHaveLength(0);
    expect(dueEngagementReminders({
      asOf: "2026-01-01", employees, holidays: [], switches: SWITCHES_ON,
    })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The scheduled writer
// ---------------------------------------------------------------------------

const CONFIG_BASE = {
  workspace: {
    remindBirthdays: true,
    remindAnniversaries: true,
    remindHolidays: true,
    holidayReminderDaysAhead: 7,
    emailEngagementReminders: false,
  },
  notificationTemplates: [],
};

function seedJobMocks(opts: {
  employees?: Array<{ userId: string; name: string; birthDate: Date | null; hireDate: Date | null; employmentStatus: string }>;
  users?: Array<{ id: string; name: string } | { id: string; name: string; email: string }>;
  holidays?: Array<{ date: Date; label: string }>;
  existingNotifications?: Array<{ sourceKey: string }>;
  outboxToday?: Array<{ kind: string }>;
}) {
  db.employeeProfile.findMany.mockResolvedValue(opts.employees ?? []);
  db.user.findMany.mockImplementation((({ where }: { where?: { deletedAt?: unknown; NOT?: { email?: string } } }) => {
    const all = (opts.users ?? []).map((u) => ({ email: "x@y.co", ...u }));
    if (where?.NOT) return Promise.resolve(all.filter((u) => u.email !== ""));
    return Promise.resolve(all);
  }) as never);
  db.holidayCalendarEntry.findMany.mockResolvedValue(opts.holidays ?? []);
  db.notification.findMany.mockResolvedValue(opts.existingNotifications ?? []);
  db.mailOutbox.findMany.mockResolvedValue(opts.outboxToday ?? []);
  db.notification.create.mockResolvedValue({ id: "n-1" });
  queueOutboxMailMock.mockImplementation(async () => ({ id: "mo-1" }));
  deliverOutboxMailMock.mockResolvedValue({ status: "SENT", providerMessageId: "", error: "" });
}

describe("P25 — runEmployeeRemindersJob (the scheduled writer)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceConfigMock.mockResolvedValue({ ...CONFIG_BASE });
    seedJobMocks({});
  });

  it("writes ONE broadcast notification per due digest, rendered through the registry defaults", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedJobMocks({
      employees: [{ userId: "u-1", name: "Theo Vance", birthDate: new Date("1992-06-14T00:00:00Z"), hireDate: null, employmentStatus: "ACTIVE" }],
      users: [{ id: "u-1", name: "Theo Vance" }],
    });
    // Force the birthday to be due: the kernel compares month-day, so use
    // the actual today string only when it matches — instead, monkey-patch
    // nothing: give the employee a birthday ON today (any year).
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", birthDate: new Date(`${today}T00:00:00Z`), hireDate: null, employmentStatus: "ACTIVE" },
    ]);

    const report = await runEmployeeRemindersJob();
    expect(report.birthdays).toBe(1);
    expect(report.broadcastsWritten).toBe(1);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
    const data = db.notification.create.mock.calls[0][0].data;
    expect(data.recipientUserId).toBeNull(); // the workspace-wide broadcast
    expect(data.type).toBe("INFO");
    expect(data.sourceKey).toBe(`ENGAGEMENT:BIRTHDAY:${today}`);
    // Rendered through the registry default templates.
    const tpl = resolveNotificationTemplate([], "EMPLOYEE_BIRTHDAY");
    expect(data.title).toBe(tpl.title);
    expect(data.message).toBe("Theo Vance");
  });

  it("a same-day re-run writes nothing (the sourceKey pre-check)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", birthDate: new Date(`${today}T00:00:00Z`), hireDate: null, employmentStatus: "ACTIVE" },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-1", name: "Theo Vance" }]);
    db.notification.findMany.mockResolvedValue([{ sourceKey: `ENGAGEMENT:BIRTHDAY:${today}` }]);

    const report = await runEmployeeRemindersJob();
    expect(report.birthdays).toBe(1); // the digest IS due…
    expect(report.broadcastsWritten).toBe(0); // …but the row already exists
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("a unique-index race on create is skipped, not a failed pass", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", birthDate: new Date(`${today}T00:00:00Z`), hireDate: null, employmentStatus: "ACTIVE" },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-1", name: "Theo Vance" }]);
    db.notification.create.mockRejectedValue(new Error("UNIQUE constraint failed: Notification.sourceKey"));

    const report = await runEmployeeRemindersJob();
    expect(report.broadcastsWritten).toBe(0);
    expect(logErrorSpy).toHaveBeenCalled();
  });

  it("nothing due → no writes, an honest empty report", async () => {
    const report = await runEmployeeRemindersJob();
    expect(report.broadcastsWritten).toBe(0);
    expect(report.emailsQueued).toBe(0);
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(queueOutboxMailMock).not.toHaveBeenCalled();
  });

  it("email OFF (the default): no outbox rows even when digests fire", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", birthDate: new Date(`${today}T00:00:00Z`), hireDate: null, employmentStatus: "ACTIVE" },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-1", name: "Theo Vance" }]);
    const report = await runEmployeeRemindersJob();
    expect(report.broadcastsWritten).toBe(1);
    expect(report.emailsQueued).toBe(0);
    expect(queueOutboxMailMock).not.toHaveBeenCalled();
  });

  it("email ON: one outbox row per live member with an address, per due digest", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      workspace: { ...CONFIG_BASE.workspace, emailEngagementReminders: true },
    });
    const today = new Date().toISOString().slice(0, 10);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", birthDate: new Date(`${today}T00:00:00Z`), hireDate: null, employmentStatus: "ACTIVE" },
    ]);
    db.user.findMany.mockImplementation((({ where }: { where?: { deletedAt?: unknown; NOT?: { email?: string } } }) => {
      const all = [
        { id: "u-1", name: "Theo Vance", email: "theo@x.co" },
        { id: "u-2", name: "Mira Hale", email: "mira@x.co" },
      ];
      if (where?.NOT) return Promise.resolve(all);
      return Promise.resolve(all.map((u) => ({ id: u.id, name: u.name })));
    }) as never);
    db.mailOutbox.findUnique.mockResolvedValue({ toAddress: "x@y.co", subject: "s", body: "b" });

    const report = await runEmployeeRemindersJob();
    expect(report.emailsQueued).toBe(2); // one per member
    expect(queueOutboxMailMock).toHaveBeenCalledTimes(2);
    const arg = queueOutboxMailMock.mock.calls[0][1] as { kind: string; subject: string; text: string };
    expect(arg.kind).toBe("EMPLOYEE_BIRTHDAY");
    expect(arg.subject).toBe("Birthdays today");
    expect(arg.text).toContain("Theo Vance");
    // Delivery attempted per row (best-effort).
    expect(deliverOutboxMailMock).toHaveBeenCalledTimes(2);
  });

  it("email ON, re-run: a kind that already emailed today is skipped whole", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      workspace: { ...CONFIG_BASE.workspace, emailEngagementReminders: true },
    });
    const today = new Date().toISOString().slice(0, 10);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", birthDate: new Date(`${today}T00:00:00Z`), hireDate: null, employmentStatus: "ACTIVE" },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-1", name: "Theo Vance", email: "theo@x.co" },
    ]);
    db.mailOutbox.findMany.mockResolvedValue([{ kind: "EMPLOYEE_BIRTHDAY" }]);

    const report = await runEmployeeRemindersJob();
    expect(report.emailKindsSkipped).toBe(1);
    expect(report.emailsQueued).toBe(0);
    expect(queueOutboxMailMock).not.toHaveBeenCalled();
  });

  it("a delivery failure never fails the pass (best-effort, logged)", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      workspace: { ...CONFIG_BASE.workspace, emailEngagementReminders: true },
    });
    const today = new Date().toISOString().slice(0, 10);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", birthDate: new Date(`${today}T00:00:00Z`), hireDate: null, employmentStatus: "ACTIVE" },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-1", name: "Theo Vance", email: "theo@x.co" }]);
    db.mailOutbox.findUnique.mockResolvedValue({ toAddress: "theo@x.co", subject: "s", body: "b" });
    deliverOutboxMailMock.mockRejectedValue(new Error("provider exploded"));

    const report = await runEmployeeRemindersJob();
    expect(report.broadcastsWritten).toBe(1);
    expect(report.emailsQueued).toBe(1);
    expect(logErrorSpy).toHaveBeenCalled();
  });

  it("a customized template row flows into the digest (the P24 registry rides)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    getWorkspaceConfigMock.mockResolvedValue({
      ...CONFIG_BASE,
      notificationTemplates: [{
        eventKey: "EMPLOYEE_BIRTHDAY",
        subjectTemplate: "Cake day!",
        bodyTemplate: "Cake for {{names}} ({{count}}).",
        titleTemplate: "CAKE",
        messageTemplate: "{{names}} get cake",
      }],
    });
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", birthDate: new Date(`${today}T00:00:00Z`), hireDate: null, employmentStatus: "ACTIVE" },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-1", name: "Theo Vance" }]);

    await runEmployeeRemindersJob();
    const data = db.notification.create.mock.calls[0][0].data;
    expect(data.title).toBe("CAKE");
    expect(data.message).toBe("Theo Vance get cake");
  });

  it("the holiday digest keys by the holiday date and renders its variables", async () => {
    // A holiday exactly 7 days from today.
    const in7 = new Date();
    in7.setUTCHours(0, 0, 0, 0);
    in7.setUTCDate(in7.getUTCDate() + 7);
    db.holidayCalendarEntry.findMany.mockResolvedValue([{ date: in7, label: "Regional Day" }]);

    const report = await runEmployeeRemindersJob();
    expect(report.holidays).toBe(1);
    expect(report.broadcastsWritten).toBe(1);
    const data = db.notification.create.mock.calls[0][0].data;
    expect(data.sourceKey).toBe(`ENGAGEMENT:HOLIDAY:${in7.toISOString().slice(0, 10)}`);
    expect(data.title).toBe("Upcoming holiday: Regional Day");
    expect(data.message).toContain("7 day(s) away");
  });
});

describe("P25 — engagementEmailHtml (the digest wrap)", () => {
  it("escapes and bolds the digest headers", () => {
    const html = engagementEmailHtml("Birthdays today (2026-06-14):\n\nTheo <b>Vance</b>\n\n— Fernly HR");
    expect(html).toContain("<strong>Birthdays today (2026-06-14):</strong>");
    expect(html).toContain("Theo &lt;b&gt;Vance&lt;/b&gt;");
    expect(html).toContain("<br />");
  });
});

// ---------------------------------------------------------------------------
// The registry growth — the three engagement events carry declared-only
// placeholders and render-able defaults (the P24 sanity suite generalizes;
// this pins the P25 additions explicitly).
// ---------------------------------------------------------------------------

describe("P25 — the engagement registry events", () => {
  it("renders each engagement default with its own sample variables", () => {
    const samples: Record<string, Record<string, string>> = {
      EMPLOYEE_BIRTHDAY: { names: "Rafael Costa, Hana Park", count: "2", date: "2026-11-10" },
      EMPLOYEE_ANNIVERSARY: { names: "Ingrid Solberg (3 years)", count: "1", date: "2026-11-10" },
      HOLIDAY_UPCOMING: { holidayName: "Christmas Day", holidayDate: "2026-12-25", daysAhead: "7", date: "2026-12-18" },
    };
    for (const [key, vars] of Object.entries(samples)) {
      const tpl = resolveNotificationTemplate(undefined, key);
      expect(renderTemplate(tpl.title, vars).length).toBeGreaterThan(0);
      expect(renderTemplate(tpl.message, vars)).not.toContain("{{");
      expect(renderTemplate(tpl.body, vars)).not.toContain("{{");
    }
  });
});
