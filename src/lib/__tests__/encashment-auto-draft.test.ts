import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P31 (LV-J02 / LV-09's remainder) — the encashment auto-draft job. The
// scheduled writer: the workspace switch gates the whole pass, the pure
// planner (lib/leave-encashment.ts, pinned in its own suite) decides every
// draft, and this suite pins the wiring — the facts the writer gathers
// (ledger projection, not the cache), the rows it lands (ONE PENDING
// LeaveEncashment + one best-effort member notice per draft), the per-pair
// failure isolation, and the LV-B18 alarm riding the job.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "leaveType",
    "leaveBalance",
    "leaveLedgerEntry",
    "leaveEncashment",
    "employeeProfile",
    "user",
    "notification",
    "mailOutbox",
  ];
  const methods = ["findMany", "findUnique", "findFirst", "create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate", "groupBy"];
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
  runEncashmentAutoDraftJob,
  sendEncashmentAutoDraftFailureAlarm,
} from "../encashment-auto-draft";
import {
  encashmentDraftFailureEmailSubject,
  encashmentDraftFailureEmailText,
} from "../leave-email";

const AS_OF = new Date("2026-11-10T03:00:00.000Z"); // the compose loop's ~03:00 UTC pass

const ENCASHABLE_TYPE = {
  id: "lt-1",
  name: "Annual Leave",
  active: true,
  policy: { encashable: true, maxEncashableDays: 5, nonEncashableDays: 5 },
};

function primeHappyPath() {
  getWorkspaceConfigMock.mockResolvedValue({ workspace: { autoLeaveEncashment: true } });
  db.leaveType.findMany.mockResolvedValue([ENCASHABLE_TYPE]);
  db.leaveBalance.findMany.mockResolvedValue([{ userId: "u-1", leaveTypeId: "lt-1" }]);
  db.user.findMany.mockResolvedValue([{ id: "u-1", name: "Ada Lovelace", email: "ada@fernly.app" }]);
  db.employeeProfile.findMany.mockResolvedValue([{ userId: "u-1", employmentStatus: "ACTIVE" }]);
  db.leaveLedgerEntry.groupBy.mockResolvedValue([
    { userId: "u-1", leaveTypeId: "lt-1", entryType: "GRANT", _sum: { delta: 20 } },
  ]);
  db.leaveEncashment.findMany.mockResolvedValue([]); // no draft history
  db.leaveEncashment.create.mockResolvedValue({ id: "enc-1" });
  db.notification.create.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
  primeHappyPath();
});

describe("P31 — runEncashmentAutoDraftJob (the scheduled writer)", () => {
  it("the switch OFF (the default) → an early no-op pass, nothing read", async () => {
    getWorkspaceConfigMock.mockResolvedValue({ workspace: { autoLeaveEncashment: false } });
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report).toEqual({
      asOf: "2026-11-10",
      year: 2026,
      pairsConsidered: 0,
      draftsWritten: 0,
      notificationsWritten: 0,
      failures: 0,
      failuresDetail: [],
    });
    expect(db.leaveType.findMany).not.toHaveBeenCalled();
  });

  it("no encashable types → an honest empty pass (no balance reads)", async () => {
    db.leaveType.findMany.mockResolvedValue([
      { id: "lt-2", name: "Sick Leave", active: true, policy: { encashable: false } },
    ]);
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.pairsConsidered).toBe(0);
    expect(db.leaveBalance.findMany).not.toHaveBeenCalled();
  });

  it("drafts the over-floor days from the LEDGER projection — PENDING, next-month payout, cron provenance", async () => {
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report).toMatchObject({ pairsConsidered: 1, draftsWritten: 1, notificationsWritten: 1, failures: 0 });
    expect(db.leaveEncashment.create).toHaveBeenCalledWith({
      data: {
        userId: "u-1",
        leaveTypeId: "lt-1",
        year: 2026,
        days: 5, // 20 available − 5 floor, capped at 5
        status: "PENDING",
        payoutPeriod: "2026-12", // the month AFTER the pass day
        reason: expect.stringContaining("Auto-drafted"),
        createdById: "cron:leave-encashment",
      },
    });
  });

  it("the member notice rides the draft, idempotent by the row's own id", async () => {
    await runEncashmentAutoDraftJob(AS_OF);
    expect(db.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientUserId: "u-1",
        type: "INFO",
        sourceKey: "ENCASHMENT_AUTO_DRAFT:enc-1",
        title: "Leave encashment drafted for review",
        message: expect.stringContaining("5 day(s) of Annual Leave"),
      }),
    });
  });

  it("a PENDING draft in the history blocks the pair — a re-run plans nothing (the idempotency)", async () => {
    db.leaveEncashment.findMany.mockResolvedValue([{ userId: "u-1", leaveTypeId: "lt-1", status: "PENDING" }]);
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.draftsWritten).toBe(0);
    expect(db.leaveEncashment.create).not.toHaveBeenCalled();
  });

  it("an APPROVED (unpaid) draft blocks too — the live pair is waiting on payroll", async () => {
    db.leaveEncashment.findMany.mockResolvedValue([{ userId: "u-1", leaveTypeId: "lt-1", status: "APPROVED" }]);
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.draftsWritten).toBe(0);
  });

  it("a PAID history does NOT block — the knobs bound the repeat exposure", async () => {
    db.leaveEncashment.findMany.mockResolvedValue([{ userId: "u-1", leaveTypeId: "lt-1", status: "PAID" }]);
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.draftsWritten).toBe(1);
  });

  it("a REJECTED history blocks the year — HR's no is not re-litigated daily", async () => {
    db.leaveEncashment.findMany.mockResolvedValue([{ userId: "u-1", leaveTypeId: "lt-1", status: "REJECTED" }]);
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.draftsWritten).toBe(0);
  });

  it("a deleted member never drafts (live users only)", async () => {
    db.user.findMany.mockResolvedValue([]); // the deletedAt filter removed them
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.pairsConsidered).toBe(0);
    expect(report.draftsWritten).toBe(0);
  });

  it("an EXITED employee never drafts — the residual balance is FnF's business", async () => {
    db.employeeProfile.findMany.mockResolvedValue([{ userId: "u-1", employmentStatus: "EXITED" }]);
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.pairsConsidered).toBe(0);
    expect(report.draftsWritten).toBe(0);
  });

  it("the projection nets consumption — 20 granted minus 5 consumed drafts the 10-cap floor", async () => {
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { userId: "u-1", leaveTypeId: "lt-1", entryType: "GRANT", _sum: { delta: 20 } },
      { userId: "u-1", leaveTypeId: "lt-1", entryType: "CONSUME", _sum: { delta: -5 } },
    ]);
    await runEncashmentAutoDraftJob(AS_OF);
    // available 15 → over-floor 10 → capped at 5 → days 5.
    expect(db.leaveEncashment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ days: 5 }),
    });
  });

  it("a pair with no ledger rows (a zero cache row) plans nothing", async () => {
    db.leaveLedgerEntry.groupBy.mockResolvedValue([]);
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.draftsWritten).toBe(0);
    expect(db.leaveEncashment.create).not.toHaveBeenCalled();
  });

  it("a draft write failure is recorded per-pair and never fails the pass", async () => {
    db.leaveEncashment.create.mockRejectedValue(new Error("insert blocked"));
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report.failures).toBe(1);
    expect(report.failuresDetail).toEqual([
      { userId: "u-1", leaveTypeId: "lt-1", leaveTypeName: "Annual Leave", reason: "insert blocked" },
    ]);
    expect(report.draftsWritten).toBe(0);
    expect(logErrorSpy).toHaveBeenCalled();
  });

  it("a member-notice failure never fails the pass — the draft stands", async () => {
    db.notification.create.mockRejectedValue(new Error("notify down"));
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report).toMatchObject({ draftsWritten: 1, notificationsWritten: 0, failures: 0 });
    expect(logErrorSpy).toHaveBeenCalled();
  });

  it("two pairs draft independently — one failing pair leaves the other intact", async () => {
    db.leaveBalance.findMany.mockResolvedValue([
      { userId: "u-1", leaveTypeId: "lt-1" },
      { userId: "u-2", leaveTypeId: "lt-1" },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: "u-1", name: "Ada Lovelace", email: "ada@fernly.app" },
      { id: "u-2", name: "Grace Hopper", email: "grace@fernly.app" },
    ]);
    db.employeeProfile.findMany.mockResolvedValue([
      { userId: "u-1", employmentStatus: "ACTIVE" },
      { userId: "u-2", employmentStatus: "ACTIVE" },
    ]);
    db.leaveLedgerEntry.groupBy.mockResolvedValue([
      { userId: "u-1", leaveTypeId: "lt-1", entryType: "GRANT", _sum: { delta: 20 } },
      { userId: "u-2", leaveTypeId: "lt-1", entryType: "GRANT", _sum: { delta: 20 } },
    ]);
    db.leaveEncashment.create
      .mockRejectedValueOnce(new Error("first pair fails"))
      .mockResolvedValueOnce({ id: "enc-2" });
    const report = await runEncashmentAutoDraftJob(AS_OF);
    expect(report).toMatchObject({ pairsConsidered: 2, draftsWritten: 1, failures: 1 });
    expect(report.failuresDetail[0].userId).toBe("u-1");
  });
});

describe("P31 — sendEncashmentAutoDraftFailureAlarm (the LV-B18 rail)", () => {
  it("queues ONE LEAVE_JOB_FAILURE outbox row per ADMIN+HR recipient and delivers best-effort", async () => {
    db.user.findMany.mockResolvedValue([{ email: "hr@fernly.app" }, { email: "admin@fernly.app" }]);
    queueOutboxMailMock.mockImplementation((_tx: unknown, input: { toAddress: string }) =>
      Promise.resolve({ id: `out-${input.toAddress}` }),
    );
    db.mailOutbox.findUnique.mockImplementation((_args: { where: { id: string } }) =>
      Promise.resolve({ toAddress: "hr@fernly.app", subject: "s", body: "b" }),
    );
    deliverOutboxMailMock.mockResolvedValue({ status: "SENT" });

    await sendEncashmentAutoDraftFailureAlarm({
      asOf: "2026-11-10",
      year: 2026,
      pairsConsidered: 1,
      draftsWritten: 0,
      notificationsWritten: 0,
      failures: 1,
      failuresDetail: [{ userId: "u-1", leaveTypeId: "lt-1", leaveTypeName: "Annual Leave", reason: "insert blocked" }],
    });

    expect(queueOutboxMailMock).toHaveBeenCalledTimes(2);
    const first = queueOutboxMailMock.mock.calls[0][1];
    expect(first.kind).toBe("LEAVE_JOB_FAILURE");
    expect(first.toAddress).toBe("hr@fernly.app");
    expect(first.subject).toBe("Automatic leave encashment drafts failed");
    expect(first.text).toContain("Annual Leave (draft phase): insert blocked");
    expect(first.sentById).toBe("cron:leave-encashment");
    expect(deliverOutboxMailMock).toHaveBeenCalled();
  });

  it("a delivery failure never throws into the caller", async () => {
    db.user.findMany.mockResolvedValue([{ email: "hr@fernly.app" }]);
    queueOutboxMailMock.mockResolvedValue({ id: "out-1" });
    db.mailOutbox.findUnique.mockResolvedValue({ toAddress: "hr@fernly.app", subject: "s", body: "b" });
    deliverOutboxMailMock.mockRejectedValue(new Error("smtp down"));
    await expect(
      sendEncashmentAutoDraftFailureAlarm({
        asOf: "2026-11-10",
        year: 2026,
        pairsConsidered: 1,
        draftsWritten: 0,
        notificationsWritten: 0,
        failures: 1,
        failuresDetail: [{ userId: "u-1", leaveTypeId: "lt-1", leaveTypeName: "Annual Leave", reason: "x" }],
      }),
    ).resolves.toBeUndefined();
    expect(logErrorSpy).toHaveBeenCalled();
  });
});

describe("P31 — encashmentDraftFailureEmailSubject / Text (the alarm copy)", () => {
  it("the subject names the module, no counters leak into previews", () => {
    expect(encashmentDraftFailureEmailSubject()).toBe("Automatic leave encashment drafts failed");
  });

  it("the text lists up to ten per-pair reasons, then the truncation line", () => {
    const failures = Array.from({ length: 12 }, (_, i) => ({
      leaveTypeName: "Annual Leave",
      reason: `reason ${i}`,
    }));
    const text = encashmentDraftFailureEmailText("2026-11-10", failures);
    expect(text).toContain("The daily encashment auto-draft pass (2026-11-10) recorded 12 failure(s)");
    expect(text).toContain("Annual Leave (draft phase): reason 0");
    expect(text).toContain("reason 9");
    expect(text).not.toContain("reason 10"); // only the first ten
    expect(text).toContain("and 2 more");
    expect(text).toContain("The next daily pass re-plans every pair idempotently");
  });

  it("no truncation line when every failure fits", () => {
    const text = encashmentDraftFailureEmailText("2026-11-10", [
      { leaveTypeName: "Annual Leave", reason: "just one" },
    ]);
    expect(text).toContain("recorded 1 failure(s)");
    expect(text).not.toContain("more (see the Outbox");
  });
});
