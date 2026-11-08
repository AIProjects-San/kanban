import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F2.1 — offboarding & full-and-final action tests
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2).
//
// Rule matrix: RBAC (hr:admin only), the exit-interview lifecycle (one live
// per employee, schedule/complete/cancel transitions, in-app notification),
// FnF generate (EXITED + LWD gates, unsettled snapshot) and settle (freezes
// LIVE amounts, audits them, refuses re-settle).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "employeeProfile", "exitInterview", "fullAndFinalStatement",
    "onboardingChecklist", "onboardingTask", "leaveType", "leaveBalance",
    "leaveLedgerEntry", "leaveRequest", "salaryStructure", "payrollRun",
    "payslip", "holidayCalendarEntry", "auditLog", "notification",
  ];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
    "groupBy",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.resolve(fn),
  );
  return obj;
});

vi.mock("@/lib/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

// PR-56 — partial mock so the best-effort notification catch block can be
// asserted without console spam.
const logErrorSpy = vi.fn();
vi.mock("@/lib/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability")>();
  return { ...actual, logError: (...args: unknown[]) => logErrorSpy(args) };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  getOffboardingOverview,
  createExitInterview,
  scheduleExitInterview,
  completeExitInterview,
  cancelExitInterview,
  generateFullAndFinal,
  settleFullAndFinal,
} from "../hr-offboarding";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

const EXITED_PROFILE = {
  userId: "u-soren",
  jobTitle: "QA Engineer",
  department: "ENGINEERING",
  employmentStatus: "EXITED",
  hireDate: new Date("2024-02-05T00:00:00.000Z"),
  lastWorkingDay: new Date("2026-11-07T00:00:00.000Z"),
  noticePeriodWeeks: 4,
};

const INTERVIEW = {
  id: "ei-1",
  userId: "u-soren",
  status: "PENDING",
  scheduledAt: null,
  interviewerId: null,
  notes: "",
  completedAt: null,
  createdById: "u-hr",
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};

function denyAll() {
  requirePermissionMock.mockImplementation(async () => {
    throw new (class extends Error { digest = "AuthorizationError"; })("denied");
  });
}

/** Default world: Soren is EXITED with LWD, an active structure paying
 * 5,200/month, one OPEN run holding his 4,980.75-net payslip, and an
 * Annual balance of +4 days / Advance Annual −2 (paid types). */
function seededFnFWorld() {
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "u-soren"
      ? { id: "u-soren", name: "Soren Lindqvist", deletedAt: null, managerId: "u-ingrid" }
      : where.id === "u-hr"
        ? { id: "u-hr", name: "Remy Laurent", deletedAt: null, managerId: null }
        : null,
  );
  db.user.findMany.mockResolvedValue([
    { id: "u-soren", name: "Soren Lindqvist", role: "MEMBER" },
    { id: "u-hr", name: "Remy Laurent", role: "HR" },
  ]);
  db.employeeProfile.findMany.mockImplementation(
    async ({ where }: { where?: { employmentStatus?: string; userId?: { in: string[] } } }) => {
      if (where?.employmentStatus === "EXITED") return [EXITED_PROFILE];
      return [EXITED_PROFILE]; // the userId-in read
    },
  );
  db.employeeProfile.findUnique.mockImplementation(
    async ({ where }: { where: { userId: string } }) =>
      where.userId === "u-soren" ? EXITED_PROFILE : null,
  );
  db.onboardingChecklist.findMany.mockResolvedValue([]);
  db.exitInterview.findMany.mockResolvedValue([]);
  db.fullAndFinalStatement.findMany.mockResolvedValue([]);
  db.fullAndFinalStatement.findUnique.mockResolvedValue(null);
  db.salaryStructure.findFirst.mockResolvedValue({
    components: JSON.stringify([
      { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 60_000 },
      { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 2_400 },
    ]),
  });
  db.payrollRun.findMany.mockResolvedValue([
    { period: "2026-11", status: "OPEN", workingDays: 21, payslips: [{ net: 4_980.75 }] },
  ]);
  db.payrollRun.findUnique.mockResolvedValue({ period: "2026-11", workingDays: 21 });
  db.leaveType.findMany.mockResolvedValue([
    { id: "lt-annual", name: "Annual", paid: true, active: true, policy: { annualDays: 20 } },
    { id: "lt-advance", name: "Advance Annual", paid: true, active: true, policy: null },
    { id: "lt-unpaid", name: "Unpaid", paid: false, active: true, policy: null },
  ]);
  db.leaveBalance.findMany.mockResolvedValue([
    { leaveTypeId: "lt-annual", entitled: 20, carriedOver: 0, used: 16 },
    { leaveTypeId: "lt-advance", entitled: 22, carriedOver: 0, used: 24 },
    { leaveTypeId: "lt-unpaid", entitled: 0, carriedOver: 0, used: 0 },
  ]);
  db.leaveLedgerEntry.groupBy.mockResolvedValue([
    { leaveTypeId: "lt-annual", entryType: "GRANT", _sum: { delta: 20 } },
    { leaveTypeId: "lt-annual", entryType: "CONSUME", _sum: { delta: -16 } },
    { leaveTypeId: "lt-advance", entryType: "GRANT", _sum: { delta: 22 } },
    { leaveTypeId: "lt-advance", entryType: "CONSUME", _sum: { delta: -24 } },
    { leaveTypeId: "lt-unpaid", entryType: "GRANT", _sum: { delta: 3 } },
  ]);
  db.holidayCalendarEntry.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  seededFnFWorld();
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("RBAC", () => {
  it("every action demands hr:admin (a MEMBER is refused everywhere)", async () => {
    denyAll();
    const results = await Promise.all([
      getOffboardingOverview(),
      createExitInterview({ userId: "u-soren" }),
      scheduleExitInterview({ interviewId: "ei-1", scheduledAt: "2026-11-05" }),
      completeExitInterview({ interviewId: "ei-1" }),
      cancelExitInterview({ interviewId: "ei-1" }),
      generateFullAndFinal({ userId: "u-soren" }),
      settleFullAndFinal({ userId: "u-soren" }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Exit interview lifecycle (EM-15)
// ---------------------------------------------------------------------------

describe("createExitInterview", () => {
  it("records a PENDING interview and audits it", async () => {
    db.exitInterview.findFirst.mockResolvedValue(null);
    db.exitInterview.create.mockResolvedValue(INTERVIEW);
    const res = await createExitInterview({ userId: "u-soren" });
    expect(res.ok).toBe(true);
    expect(db.exitInterview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "u-soren", status: "PENDING", createdById: "u-hr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.exit_interview_recorded", entityId: "ei-1" }),
    );
  });

  it("refuses a second LIVE interview (one per employee; CANCELLED frees the slot)", async () => {
    db.exitInterview.findFirst.mockResolvedValue({ id: "ei-0", status: "SCHEDULED" });
    const res = await createExitInterview({ userId: "u-soren" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("live exit interview");
    expect(db.exitInterview.create).not.toHaveBeenCalled();
  });

  it("refuses a deleted/unknown user", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await createExitInterview({ userId: "u-ghost" });
    expect(res.ok).toBe(false);
  });
});

describe("scheduleExitInterview", () => {
  it("moves PENDING → SCHEDULED, notifies the employee in-app, audits", async () => {
    db.exitInterview.findUnique.mockResolvedValue(INTERVIEW);
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "u-soren"
        ? { id: "u-soren", name: "Soren Lindqvist", deletedAt: null, managerId: "u-ingrid" }
        : where.id === "u-hr"
          ? { id: "u-hr", name: "Remy Laurent", deletedAt: null, managerId: null }
          : { id: where.id, name: "Ingrid Solberg", deletedAt: null, managerId: null },
    );
    const res = await scheduleExitInterview({
      interviewId: "ei-1",
      scheduledAt: "2026-11-05",
      interviewerId: "u-ingrid",
    });
    expect(res.ok).toBe(true);
    expect(db.exitInterview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ei-1" },
        data: expect.objectContaining({
          status: "SCHEDULED",
          scheduledAt: new Date("2026-11-05T00:00:00.000Z"),
          interviewerId: "u-ingrid",
        }),
      }),
    );
    expect(db.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipientUserId: "u-soren",
          title: "Exit interview scheduled",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.exit_interview_scheduled" }),
    );
  });

  it("rescheduling a SCHEDULED interview updates the date", async () => {
    db.exitInterview.findUnique.mockResolvedValue({ ...INTERVIEW, status: "SCHEDULED", scheduledAt: new Date("2026-11-05T00:00:00.000Z") });
    const res = await scheduleExitInterview({ interviewId: "ei-1", scheduledAt: "2026-11-06" });
    expect(res.ok).toBe(true);
    expect(db.exitInterview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scheduledAt: new Date("2026-11-06T00:00:00.000Z") }) }),
    );
  });

  it("refuses to schedule a COMPLETED/CANCELLED interview", async () => {
    for (const status of ["COMPLETED", "CANCELLED"]) {
      db.exitInterview.findUnique.mockResolvedValue({ ...INTERVIEW, status });
      const res = await scheduleExitInterview({ interviewId: "ei-1", scheduledAt: "2026-11-05" });
      expect(res.ok).toBe(false);
    }
    expect(db.exitInterview.update).not.toHaveBeenCalled();
  });

  it("refuses an unknown interviewer", async () => {
    db.exitInterview.findUnique.mockResolvedValue(INTERVIEW);
    db.user.findUnique.mockResolvedValue(null);
    const res = await scheduleExitInterview({ interviewId: "ei-1", scheduledAt: "2026-11-05", interviewerId: "u-ghost" });
    expect(res.ok).toBe(false);
  });
});

describe("completeExitInterview / cancelExitInterview", () => {
  it("completes a SCHEDULED interview with notes", async () => {
    db.exitInterview.findUnique.mockResolvedValue({ ...INTERVIEW, status: "SCHEDULED" });
    const res = await completeExitInterview({ interviewId: "ei-1", notes: "Would recommend clearer release process." });
    expect(res.ok).toBe(true);
    expect(db.exitInterview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED", notes: "Would recommend clearer release process." }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.exit_interview_completed" }),
    );
  });

  it("cancels a PENDING interview (terminal, history kept)", async () => {
    db.exitInterview.findUnique.mockResolvedValue(INTERVIEW);
    const res = await cancelExitInterview({ interviewId: "ei-1" });
    expect(res.ok).toBe(true);
    expect(db.exitInterview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });

  it("refuses to complete or cancel a terminal interview", async () => {
    for (const status of ["COMPLETED", "CANCELLED"]) {
      db.exitInterview.findUnique.mockResolvedValue({ ...INTERVIEW, status });
      const done = await completeExitInterview({ interviewId: "ei-1" });
      const cancelled = await cancelExitInterview({ interviewId: "ei-1" });
      expect(done.ok).toBe(false);
      expect(cancelled.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Full-and-final statement (EM-16 lite)
// ---------------------------------------------------------------------------

describe("generateFullAndFinal", () => {
  it("requires an EXITED employee", async () => {
    db.employeeProfile.findUnique.mockResolvedValue({ ...EXITED_PROFILE, employmentStatus: "ACTIVE" });
    const res = await generateFullAndFinal({ userId: "u-soren" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("exited");
    expect(db.fullAndFinalStatement.create).not.toHaveBeenCalled();
  });

  it("creates the UNSETTLED row with the live snapshot and audits", async () => {
    db.fullAndFinalStatement.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "fnf-1", status: "UNSETTLED", ...data,
      }),
    );
    const res = await generateFullAndFinal({ userId: "u-soren" });
    expect(res.ok).toBe(true);
    const createArg = db.fullAndFinalStatement.create.mock.calls[0][0] as {
      data: { userId: string; status: string; lines: string; payableTotal: number; receivableTotal: number; netPayable: number };
    };
    expect(createArg.data.userId).toBe("u-soren");
    expect(createArg.data.status).toBe("UNSETTLED");
    // Payables: salary 4,980.75 + encashment 4 × 247.62 = 990.48 → 5,971.23.
    expect(createArg.data.payableTotal).toBe(5_971.23);
    // Receivable: advance leave 2 × 247.62 = 495.24.
    expect(createArg.data.receivableTotal).toBe(495.24);
    expect(createArg.data.netPayable).toBe(5_475.99);
    const lines = JSON.parse(createArg.data.lines) as Array<{ kind: string; label: string; amount: number }>;
    expect(lines.map((l) => l.kind).sort()).toEqual(["ADVANCE_LEAVE", "ENCASHMENT", "SALARY"]);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.fnf_generated", entityId: "fnf-1" }),
    );
  });

  it("refreshes an existing UNSETTLED row (regeneration) and refuses a SETTLED one", async () => {
    db.fullAndFinalStatement.findUnique.mockResolvedValue({ id: "fnf-1", status: "UNSETTLED", userId: "u-soren" });
    db.fullAndFinalStatement.update.mockResolvedValue({ id: "fnf-1", status: "UNSETTLED" });
    const refresh = await generateFullAndFinal({ userId: "u-soren" });
    expect(refresh.ok).toBe(true);
    expect(db.fullAndFinalStatement.update).toHaveBeenCalled();
    expect(db.fullAndFinalStatement.create).not.toHaveBeenCalled();

    db.fullAndFinalStatement.findUnique.mockResolvedValue({ id: "fnf-1", status: "SETTLED", userId: "u-soren" });
    const refuse = await generateFullAndFinal({ userId: "u-soren" });
    expect(refuse.ok).toBe(false);
    if (!refuse.ok) expect(refuse.error).toContain("already settled");
  });
});

describe("settleFullAndFinal", () => {
  it("requires a generated statement first", async () => {
    db.fullAndFinalStatement.findUnique.mockResolvedValue(null);
    const res = await settleFullAndFinal({ userId: "u-soren" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("generate");
  });

  it("freezes the LIVE amounts into the SETTLED row and audits them", async () => {
    db.fullAndFinalStatement.findUnique.mockResolvedValue({
      id: "fnf-1", status: "UNSETTLED", userId: "u-soren",
      // A stale generation snapshot — settlement must freeze LIVE values.
      payableTotal: 1, receivableTotal: 0, netPayable: 1,
      lines: "[]", createdAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    // The hoisted $transaction mock passes the whole db object as tx, so
    // tx.fullAndFinalStatement.update routes to the same spy.
    db.fullAndFinalStatement.update.mockResolvedValue({ id: "fnf-1", status: "SETTLED" });
    const res = await settleFullAndFinal({ userId: "u-soren" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.status).toBe("SETTLED");
      expect(res.data.netPayable).toBe(5_475.99);
    }
    const updateArg = db.fullAndFinalStatement.update.mock.calls[0][0] as {
      data: { status: string; payableTotal: number; receivableTotal: number; netPayable: number; settledById: string };
    };
    expect(updateArg.data.status).toBe("SETTLED");
    expect(updateArg.data.payableTotal).toBe(5_971.23);
    expect(updateArg.data.receivableTotal).toBe(495.24);
    expect(updateArg.data.netPayable).toBe(5_475.99);
    expect(updateArg.data.settledById).toBe("u-hr");
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.fnf_settled",
        detail: expect.stringContaining("net $5475.99"),
      }),
    );
  });

  it("refuses a second settlement (the frozen amounts are final)", async () => {
    db.fullAndFinalStatement.findUnique.mockResolvedValue({ id: "fnf-1", status: "SETTLED", userId: "u-soren" });
    const res = await settleFullAndFinal({ userId: "u-soren" });
    expect(res.ok).toBe(false);
    expect(db.fullAndFinalStatement.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Overview read
// ---------------------------------------------------------------------------

describe("getOffboardingOverview", () => {
  it("surfaces the EXITED case with the live computation and picker lists", async () => {
    const res = await getOffboardingOverview();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.cases).toHaveLength(1);
    const c = res.data.cases[0];
    expect(c.userId).toBe("u-soren");
    expect(c.employmentStatus).toBe("EXITED");
    expect(c.lastWorkingDay).toBe("2026-11-07");
    expect(c.fnf.status).toBe("NONE");
    if (c.fnf.status === "NONE" && c.fnf.computed) {
      expect(c.fnf.computed.payableTotal).toBe(5_971.23);
      expect(c.fnf.computed.notes.some((n) => n.includes("Unpaid"))).toBe(true);
    }
    expect(res.data.members.length).toBeGreaterThan(0);
    expect(res.data.interviewers.length).toBeGreaterThan(0);
  });

  it("renders a SETTLED row from the frozen snapshot, not live data", async () => {
    db.fullAndFinalStatement.findMany.mockResolvedValue([
      {
        id: "fnf-1", userId: "u-soren", status: "SETTLED",
        lastWorkingDay: new Date("2026-11-07T00:00:00.000Z"),
        asOf: new Date("2026-11-08T00:00:00.000Z"),
        lines: JSON.stringify([{ kind: "SALARY", label: "Unprocessed salary — 2026-11 run (net)", days: null, rate: null, amount: 100 }]),
        payableTotal: 100, receivableTotal: 0, netPayable: 100,
        generatedById: "u-hr", settledById: "u-hr", settledAt: new Date("2026-11-08T00:00:00.000Z"),
        createdAt: new Date("2026-11-07T00:00:00.000Z"), updatedAt: new Date("2026-11-08T00:00:00.000Z"),
      },
    ]);
    db.fullAndFinalStatement.findUnique.mockResolvedValue(null);
    const res = await getOffboardingOverview();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.data.cases[0];
    if (c.fnf.status === "SETTLED") {
      expect(c.fnf.frozen.netPayable).toBe(100);
      expect(c.fnf.frozen.lines).toHaveLength(1);
      expect(c.fnf.settledBy).toBe("Remy Laurent");
    } else {
      expect.unreachable("expected a SETTLED fnf state");
    }
    // A settled case is not offered in the separation prep picker.
    expect(res.data.members.find((m) => m.userId === "u-soren")).toBeUndefined();
  });
});
