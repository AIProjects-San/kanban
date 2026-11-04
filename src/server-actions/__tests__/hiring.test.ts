import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Recruitment R1 — hiring action tests (docs/RECRUITMENT_MODULE_PLAN.md §5):
// template snapshot at creation, advance/skip transitions, decisions with
// reasons, the hired-candidate delete guard, and template-config gating.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["hiringStageConfig", "candidate", "candidateStage", "user", "auditLog", "notification", "calendarEvent", "reminder", "mailOutbox", "documentTypeConfig", "candidateDocument", "backgroundCheck", "offerTemplate", "offerRecord"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  (obj as Record<string, unknown>).$transaction = vi.fn(
    async (fn: unknown) =>
      typeof fn === "function" ? fn(obj) : Promise.all(fn as unknown[]),
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

// R3 — injectable mailer: the default mock simulates a successful Resend
// delivery; individual tests swap in dry-run / throwing mailers.
const createMailerMock = vi.fn();
vi.mock("@/lib/mailer", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mailer")>("@/lib/mailer");
  return { ...actual, createMailer: (...a: unknown[]) => createMailerMock(...(a as [])) };
});

const getWorkspaceConfigMock = vi.fn();
vi.mock("@/lib/config-loader", () => ({
  getWorkspaceConfig: (...a: unknown[]) => getWorkspaceConfigMock(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createCandidate,
  updateCandidate,
  deleteCandidate,
  advanceStage,
  setStageStatus,
  addCandidateStage,
  decideCandidate,
  saveStageTemplate,
  deleteStageTemplate,
  getHiringBoard,
  getHiringPermissions,
  getMailOutbox,
  getDocumentTypes,
  saveDocumentType,
  deleteDocumentType,
  getJoiningFormalities,
  requestDocument,
  receiveDocument,
  verifyDocument,
  rejectDocument,
  initiateBackgroundCheck,
  updateBackgroundCheck,
  getOfferTemplates,
  saveOfferTemplate,
  deleteOfferTemplate,
  createOfferRecord,
  updateOfferRecord,
  getOfferRecords,
  scheduleInterview,
  saveScorecard,
  getMyInterviews,
} from "../hiring";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MANAGER_AUTH = { userId: "u-mgr", role: "MANAGER" as const, name: "Ingrid", email: "ingrid@x.co" };
const MEMBER_AUTH = { userId: "u-diego", role: "MEMBER" as const, name: "Diego", email: "diego@x.co" };

function denyFor(perm: string) {
  return async (p: string) => {
    if (p === perm) {
      throw new (class extends Error { digest = "AuthorizationError"; })("denied");
    }
    return HR_AUTH;
  };
}

const TEMPLATE = [
  { id: "tpl-1", key: "screening", label: "Application Screening", stageType: "SCREENING", ownerRole: "HR", description: "", sortOrder: 10, isActive: true },
  { id: "tpl-2", key: "interview_1", label: "Interview 1 — Technical", stageType: "INTERVIEW", ownerRole: "MANAGER", description: "", sortOrder: 20, isActive: true },
  { id: "tpl-3", key: "offer", label: "Offer & Signature", stageType: "OFFER", ownerRole: "HR", description: "", sortOrder: 70, isActive: true },
  { id: "tpl-4", key: "inactive_extra", label: "Old stage", stageType: "CUSTOM", ownerRole: "HR", description: "", sortOrder: 80, isActive: false },
];

function candidateWithStages(overrides: Record<string, unknown> = {}) {
  return {
    id: "cand-1",
    fullName: "Nadia Petrova",
    email: "nadia@example.com",
    phone: "+64 21 555 0101",
    position: "Senior Frontend Engineer",
    department: "ENGINEERING",
    source: "Referral",
    resumeUrl: "",
    notes: "",
    status: "ACTIVE",
    rejectReason: "",
    decidedAt: null,
    createdById: "u-admin",
    userId: null,
    joinedAt: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    stages: [
      { id: "st-1", candidateId: "cand-1", stageKey: "screening", label: "Application Screening", stageType: "SCREENING", ownerUserId: null, status: "PASSED", scheduledAt: null, remarks: "", rating: null, strengths: "", concerns: "", recommendation: null, eventId: null, sortOrder: 10, startedAt: new Date(), completedAt: new Date() },
      { id: "st-2", candidateId: "cand-1", stageKey: "interview_1", label: "Interview 1 — Technical", stageType: "INTERVIEW", ownerUserId: "u-mgr", status: "IN_PROGRESS", scheduledAt: null, remarks: "", rating: null, strengths: "", concerns: "", recommendation: null, eventId: null, sortOrder: 20, startedAt: new Date(), completedAt: null },
      { id: "st-3", candidateId: "cand-1", stageKey: "offer", label: "Offer & Signature", stageType: "OFFER", ownerUserId: null, status: "PENDING", scheduledAt: null, remarks: "", rating: null, strengths: "", concerns: "", recommendation: null, eventId: null, sortOrder: 70, startedAt: null, completedAt: null },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.hiringStageConfig.findMany.mockImplementation(async ({ where }: { where?: { isActive?: boolean } } = {}) =>
    where?.isActive === true ? TEMPLATE.filter((t) => t.isActive) : TEMPLATE,
  );
  db.hiringStageConfig.findUnique.mockResolvedValue(null);
  db.hiringStageConfig.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "tpl-new", ...data }));
  db.hiringStageConfig.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "tpl-1", ...data }));
  db.hiringStageConfig.delete.mockResolvedValue(TEMPLATE[0]);
  db.candidate.findUnique.mockResolvedValue(null);
  db.candidate.findMany.mockResolvedValue([]);
  db.candidate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "cand-new", createdAt: new Date(), ...data }));
  db.candidate.update.mockResolvedValue({});
  db.candidate.delete.mockResolvedValue({});
  db.candidateStage.findUnique.mockResolvedValue(null);
  db.candidateStage.create.mockResolvedValue({ id: "st-new" });
  db.candidateStage.update.mockResolvedValue({});
  db.user.findMany.mockResolvedValue([{ id: "u-mgr", name: "Ingrid" }]);
  db.calendarEvent.create.mockResolvedValue({ id: "ev-1" });
  db.reminder.create.mockResolvedValue({ id: "rem-1" });
  // R3 — outbox + mailer defaults.
  db.mailOutbox.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ob-1", ...data }));
  db.mailOutbox.update.mockResolvedValue({});
  db.mailOutbox.findMany.mockResolvedValue([]);
  createMailerMock.mockReset();
  createMailerMock.mockReturnValue({ sendMail: vi.fn().mockResolvedValue({ delivered: true, messageId: "re-test-1" }) });
  getWorkspaceConfigMock.mockResolvedValue({ workspace: { name: "Fernly Workspace" } });
  // R4 — joining-formalities defaults.
  db.documentTypeConfig.findMany.mockResolvedValue([]);
  db.documentTypeConfig.findUnique.mockResolvedValue(null);
  db.documentTypeConfig.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "dt-new", ...data }));
  db.documentTypeConfig.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "dt-1", ...data }));
  db.documentTypeConfig.delete.mockResolvedValue({ id: "dt-1", label: "ID Document" });
  db.candidateDocument.findMany.mockResolvedValue([]);
  db.candidateDocument.findUnique.mockResolvedValue(null);
  db.candidateDocument.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "cd-new", ...data }));
  db.candidateDocument.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "cd-1", ...data }));
  db.backgroundCheck.findMany.mockResolvedValue([]);
  db.backgroundCheck.findUnique.mockResolvedValue(null);
  db.backgroundCheck.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "bg-new", ...data }));
  db.backgroundCheck.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "bg-1", ...data }));
  // R5 — offer builder defaults.
  db.offerTemplate.findMany.mockResolvedValue([]);
  db.offerTemplate.findUnique.mockResolvedValue(null);
  db.offerTemplate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ot-new", ...data }));
  db.offerTemplate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ot-1", ...data }));
  db.offerTemplate.delete.mockResolvedValue({ id: "ot-1", label: "Designer Band" });
  db.offerRecord.findMany.mockResolvedValue([]);
  db.offerRecord.findUnique.mockResolvedValue(null);
  db.offerRecord.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "or-new", ...data }));
  db.offerRecord.update.mockResolvedValue({});
});

const INTERVIEW_STAGE = {
  id: "st-2", candidateId: "cand-1", stageKey: "interview_1", label: "Interview 1 — Technical",
  stageType: "INTERVIEW", ownerUserId: "u-mgr", status: "IN_PROGRESS",
  scheduledAt: null, remarks: "", rating: null, strengths: "", concerns: "",
  recommendation: null, eventId: null, sortOrder: 20, startedAt: null, completedAt: null,
  candidate: { id: "cand-1", fullName: "Nadia Petrova", position: "SWE", status: "ACTIVE" },
};

describe("createCandidate", () => {
  it("requires hiring:manage (a MEMBER is rejected)", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:manage"));
    const res = await createCandidate({ fullName: "X Y", email: "x@y.co" });
    expect(res.ok).toBe(false);
    expect(db.candidate.create).not.toHaveBeenCalled();
  });

  it("snapshots ACTIVE template stages: first IN_PROGRESS, rest PENDING; inactive rows excluded", async () => {
    const res = await createCandidate({
      fullName: "Nadia Petrova", email: "nadia@example.com", phone: "+64 21", position: "SWE",
      department: "ENGINEERING", source: "Referral", resumeUrl: "", notes: "",
    });
    expect(res.ok).toBe(true);
    const createArg = db.candidate.create.mock.calls[0][0] as {
      data: { createdById: string; stages: { create: unknown[] } };
    };
    expect(createArg.data.createdById).toBe("u-hr");
    const stages = createArg.data.stages.create as Array<{ stageKey: string; status: string; label: string }>;
    expect(stages.map((s) => s.stageKey)).toEqual(["screening", "interview_1", "offer"]);
    expect(stages[0].status).toBe("IN_PROGRESS");
    expect(stages.slice(1).every((s) => s.status === "PENDING")).toBe(true);
    // Snapshot contract: labels are copies of the template's CURRENT labels.
    expect(stages[1].label).toBe("Interview 1 — Technical");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.candidate_created" }));
  });

  it("rejects an invalid email at validation", async () => {
    const res = await createCandidate({ fullName: "X", email: "not-an-email" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });
});

describe("getHiringBoard", () => {
  it("requires hiring:view", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:view"));
    const res = await getHiringBoard();
    expect(res.ok).toBe(false);
  });

  it("serializes candidates with stages sorted by sortOrder and owner names resolved", async () => {
    db.candidate.findMany.mockResolvedValue([candidateWithStages()]);
    const res = await getHiringBoard();
    expect(res.ok).toBe(true);
    if (res.ok) {
      const cand = res.data.candidates[0];
      expect(cand.stages.map((s) => s.stageKey)).toEqual(["screening", "interview_1", "offer"]);
      expect(cand.stages[1].ownerName).toBe("Ingrid");
      expect(cand.stages[0].status).toBe("PASSED");
    }
  });
});

describe("advanceStage", () => {
  it("passes the current stage and starts the next one", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await advanceStage({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    expect(db.candidateStage.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "st-2" }, data: expect.objectContaining({ status: "PASSED" }) }),
    );
    expect(db.candidateStage.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "st-3" }, data: expect.objectContaining({ status: "IN_PROGRESS" }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.stage_advanced" }));
  });

  it("passes the LAST stage without starting anything (decision stays manual)", async () => {
    const cand = candidateWithStages();
    cand.stages = cand.stages.map((s) =>
      s.id === "st-1" ? s : { ...s, status: s.id === "st-2" ? "PASSED" : "IN_PROGRESS" },
    );
    db.candidate.findUnique.mockResolvedValue(cand);
    const res = await advanceStage({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    expect(db.candidateStage.update).toHaveBeenCalledTimes(1);
  });

  it("refuses to advance a non-ACTIVE candidate", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "REJECTED" }));
    const res = await advanceStage({ candidateId: "cand-1" });
    expect(res.ok).toBe(false);
    expect(db.candidateStage.update).not.toHaveBeenCalled();
  });

  it("refuses when every stage is already closed", async () => {
    const cand = candidateWithStages();
    cand.stages = cand.stages.map((s) => ({ ...s, status: "PASSED" }));
    db.candidate.findUnique.mockResolvedValue(cand);
    const res = await advanceStage({ candidateId: "cand-1" });
    expect(res.ok).toBe(false);
  });
});

describe("setStageStatus", () => {
  it("marks a stage SKIPPED with completedAt and keeps prior remarks", async () => {
    db.candidateStage.findUnique.mockResolvedValue({
      id: "st-3", candidateId: "cand-1", stageKey: "offer", label: "Offer & Signature",
      stageType: "OFFER", ownerUserId: null, status: "PENDING", remarks: "prior note",
      candidate: { id: "cand-1", fullName: "Nadia Petrova", status: "ACTIVE" },
    });
    const res = await setStageStatus({ stageId: "st-3", status: "SKIPPED", remarks: "" });
    expect(res.ok).toBe(true);
    expect(db.candidateStage.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "st-3" }, data: expect.objectContaining({ status: "SKIPPED", remarks: "prior note" }) }),
    );
  });

  it("refuses a status change on a closed candidate", async () => {
    db.candidateStage.findUnique.mockResolvedValue({
      id: "st-3", candidate: { id: "cand-1", fullName: "Nadia", status: "WITHDRAWN" },
    });
    const res = await setStageStatus({ stageId: "st-3", status: "FAILED", remarks: "" });
    expect(res.ok).toBe(false);
    expect(db.candidateStage.update).not.toHaveBeenCalled();
  });
});

describe("addCandidateStage", () => {
  it("inserts a custom stage before the anchor and shifts later stages", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await addCandidateStage({
      candidateId: "cand-1", label: "Second technical loop", stageType: "INTERVIEW", beforeStageId: "st-3",
    });
    expect(res.ok).toBe(true);
    // The offer stage (sortOrder 70, at/after the anchor) shifts up by one.
    expect(db.candidateStage.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "st-3" }, data: { sortOrder: 71 } }),
    );
    const created = db.candidateStage.create.mock.calls[0][0] as { data: { stageKey: string; sortOrder: number } };
    expect(created.data.stageKey).toMatch(/^custom:/);
    expect(created.data.sortOrder).toBe(70);
  });

  it("appends at the end when no anchor is given", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await addCandidateStage({ candidateId: "cand-1", label: "Extra check", stageType: "CUSTOM" });
    expect(res.ok).toBe(true);
    const created = db.candidateStage.create.mock.calls[0][0] as { data: { sortOrder: number } };
    expect(created.data.sortOrder).toBe(71);
  });
});

describe("decideCandidate", () => {
  it("rejects without a reason (the reason is audit-only; the email carries HR remarks)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "   " });
    expect(res.ok).toBe(false);
    expect(db.candidate.update).not.toHaveBeenCalled();
  });

  it("rejects with a reason: status, reason and decider recorded", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "Depth below bar" });
    expect(res.ok).toBe(true);
    expect(db.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-1" },
        data: expect.objectContaining({ status: "REJECTED", rejectReason: "Depth below bar", decidedById: "u-hr" }),
      }),
    );
  });

  it("withdraws without requiring a reason", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({ candidateId: "cand-1", decision: "WITHDRAW", reason: "" });
    expect(res.ok).toBe(true);
    expect(db.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "WITHDRAWN" }) }),
    );
  });

  it("reactivates only REJECTED/WITHDRAWN candidates", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "ACTIVE" }));
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REACTIVATE", reason: "" });
    expect(res.ok).toBe(false);
    expect(db.candidate.update).not.toHaveBeenCalled();
  });

  it("cannot decide twice (already REJECTED)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "REJECTED" }));
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "x" });
    expect(res.ok).toBe(false);
  });
});

describe("deleteCandidate", () => {
  it("refuses to delete a candidate that already joined (userId set)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ userId: "u-new-hire" }));
    const res = await deleteCandidate({ id: "cand-1" });
    expect(res.ok).toBe(false);
    expect(db.candidate.delete).not.toHaveBeenCalled();
  });

  it("deletes a pipeline-only candidate and audits it", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await deleteCandidate({ id: "cand-1" });
    expect(res.ok).toBe(true);
    expect(db.candidate.delete).toHaveBeenCalledWith({ where: { id: "cand-1" } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.candidate_deleted" }));
  });
});

describe("stage template config", () => {
  it("saveStageTemplate requires hiring:config (a MANAGER is rejected)", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:config"));
    const res = await saveStageTemplate({
      key: "new_stage", label: "New", stageType: "CUSTOM", ownerRole: "HR", description: "", sortOrder: 15, isActive: true,
    });
    expect(res.ok).toBe(false);
  });

  it("createTemplate: key uniqueness violation surfaces as a friendly error", async () => {
    const unique = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    db.hiringStageConfig.create.mockRejectedValueOnce(unique);
    const res = await saveStageTemplate({
      key: "screening", label: "Dup", stageType: "SCREENING", ownerRole: "HR", description: "", sortOrder: 15, isActive: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already used");
  });

  it("updateCandidate surfaces an email uniqueness conflict", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const unique = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    db.candidate.update.mockRejectedValueOnce(unique);
    const res = await updateCandidate({
      id: "cand-1", fullName: "Nadia Petrova", email: "other@example.com", phone: "", position: "", department: "", source: "", resumeUrl: "", notes: "",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("email");
  });

  it("deleteStageTemplate keeps candidate snapshots (only the template row dies)", async () => {
    db.hiringStageConfig.findUnique.mockResolvedValue(TEMPLATE[0]);
    const res = await deleteStageTemplate({ id: "tpl-1" });
    expect(res.ok).toBe(true);
    expect(db.hiringStageConfig.delete).toHaveBeenCalledWith({ where: { id: "tpl-1" } });
    expect(db.candidateStage.update).not.toHaveBeenCalled();
  });
});

describe("getHiringPermissions", () => {
  it("HR can manage and configure; MANAGER is view-only", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const hrRes = await getHiringPermissions();
    expect(hrRes.ok).toBe(true);
    if (hrRes.ok) expect(hrRes.data).toEqual({ canManage: true, canConfig: true });

    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    const mgrRes = await getHiringPermissions();
    expect(mgrRes.ok).toBe(true);
    if (mgrRes.ok) expect(mgrRes.data).toEqual({ canManage: false, canConfig: false });
  });
});


// ---------------------------------------------------------------------------
// R2 — interview scheduling + scorecards.
// ---------------------------------------------------------------------------

describe("scheduleInterview", () => {
  it("requires hiring:manage (the interviewer alone cannot schedule)", async () => {
    requirePermissionMock.mockImplementation(async (p: string) => {
      if (p === "hiring:manage") {
        throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      }
      return MANAGER_AUTH;
    });
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: new Date().toISOString() });
    expect(res.ok).toBe(false);
    expect(db.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("refuses to schedule a non-INTERVIEW stage", async () => {
    db.candidateStage.findUnique.mockResolvedValue({
      ...INTERVIEW_STAGE, stageType: "SCREENING",
    });
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: new Date().toISOString() });
    expect(res.ok).toBe(false);
    expect(db.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("refuses when the interviewer already has an interview in the same hour window", async () => {
    db.candidateStage.findUnique.mockResolvedValue(INTERVIEW_STAGE);
    db.candidateStage.findMany.mockResolvedValue([
      { label: "Interview 1 — Technical", candidate: { fullName: "Sam Whitaker" } },
    ]);
    const res = await scheduleInterview({
      stageId: "st-2", scheduledAt: new Date().toISOString(), interviewerId: "u-mgr",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Scheduling conflict");
    expect(db.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("schedules: calendar event + interviewer reminder + scheduledAt/owner/eventId recorded", async () => {
    db.candidateStage.findUnique.mockResolvedValue(INTERVIEW_STAGE);
    db.candidateStage.findMany.mockResolvedValue([]);
    const when = new Date("2026-11-10T09:30:00.000Z").toISOString();
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: when, interviewerId: "u-mgr" });
    expect(res.ok).toBe(true);
    expect(db.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: "Interview: Nadia Petrova — Interview 1 — Technical", type: "MEETING" }),
      }),
    );
    expect(db.reminder.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerId: "u-mgr" }) }),
    );
    expect(db.candidateStage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "st-2" },
        data: expect.objectContaining({ eventId: "ev-1", ownerUserId: "u-mgr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.interview_scheduled" }));
  });

  it("refuses without an interviewer (no owner on the stage and none picked)", async () => {
    db.candidateStage.findUnique.mockResolvedValue({ ...INTERVIEW_STAGE, ownerUserId: null });
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: new Date().toISOString() });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("interviewer");
  });
});

describe("saveScorecard", () => {
  it("the assigned interviewer may fill their own scorecard", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.candidateStage.findUnique.mockResolvedValue(INTERVIEW_STAGE);
    const res = await saveScorecard({
      stageId: "st-2", rating: 4, strengths: "Great depth", concerns: "Little backend",
      recommendation: "HIRE", remarks: "Recommended",
    });
    expect(res.ok).toBe(true);
    expect(db.candidateStage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "st-2" },
        data: expect.objectContaining({ rating: 4, strengths: "Great depth", recommendation: "HIRE" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.scorecard_saved" }));
  });

  it("a MEMBER who is not the owner is refused", async () => {
    requirePermissionMock.mockImplementation(async (p: string) => {
      if (p === "hiring:manage") {
        throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      }
      return MEMBER_AUTH;
    });
    db.candidateStage.findUnique.mockResolvedValue(INTERVIEW_STAGE);
    const res = await saveScorecard({ stageId: "st-2", rating: 5 });
    expect(res.ok).toBe(false);
    expect(db.candidateStage.update).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range rating at validation", async () => {
    db.candidateStage.findUnique.mockResolvedValue(INTERVIEW_STAGE);
    const res = await saveScorecard({ stageId: "st-2", rating: 9 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });

  it("refuses scorecards on a closed candidate", async () => {
    db.candidateStage.findUnique.mockResolvedValue({
      ...INTERVIEW_STAGE,
      candidate: { id: "cand-1", fullName: "Nadia Petrova", position: "SWE", status: "REJECTED" },
    });
    const res = await saveScorecard({ stageId: "st-2", rating: 4 });
    expect(res.ok).toBe(false);
  });
});

describe("getMyInterviews", () => {
  it("scopes strictly to the caller's own open INTERVIEW stages on ACTIVE candidates", async () => {
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    db.candidateStage.findMany.mockResolvedValue([
      {
        id: "st-2", stageLabel: undefined, label: "Interview 1 — Technical", candidateId: "cand-1",
        status: "IN_PROGRESS", scheduledAt: new Date("2026-11-10T09:30:00Z"), rating: null,
        recommendation: null,
        candidate: { id: "cand-1", fullName: "Nadia Petrova", position: "SWE", status: "ACTIVE" },
      },
    ]);
    const res = await getMyInterviews();
    expect(res.ok).toBe(true);
    expect(db.candidateStage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerUserId: "u-mgr",
          stageType: "INTERVIEW",
          status: { in: ["PENDING", "IN_PROGRESS"] },
          candidate: { status: "ACTIVE" },
        }),
      }),
    );
    if (res.ok) {
      expect(res.data[0].candidateName).toBe("Nadia Petrova");
      expect(res.data[0].stageLabel).toBe("Interview 1 — Technical");
    }
  });
});

describe("R2 edge branches", () => {
  it("refuses an invalid schedule date string", async () => {
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: "not-a-date" });
    expect(res.ok).toBe(false);
    expect(db.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("refuses scheduling on a stage whose candidate is closed", async () => {
    db.candidateStage.findUnique.mockResolvedValue({
      ...INTERVIEW_STAGE,
      candidate: { id: "cand-1", fullName: "Nadia Petrova", position: "SWE", status: "HIRED" },
    });
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: new Date().toISOString() });
    expect(res.ok).toBe(false);
    expect(db.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("a reschedule audits as hiring.interview_rescheduled", async () => {
    db.candidateStage.findUnique.mockResolvedValue({
      ...INTERVIEW_STAGE, scheduledAt: new Date("2026-11-05T09:30:00Z"), eventId: "ev-old",
    });
    db.candidateStage.findMany.mockResolvedValue([]);
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: new Date("2026-11-10T09:30:00Z").toISOString() });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.interview_rescheduled" }));
  });
});

// ---------------------------------------------------------------------------
// R3 — SELECT decision + rejection-email outbox (docs/RECRUITMENT_MODULE_PLAN.md §5).
// ---------------------------------------------------------------------------

describe("R3 — SELECT decision", () => {
  it("selects an ACTIVE candidate: status SELECTED + decider recorded + audit", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({ candidateId: "cand-1", decision: "SELECT", reason: "" });
    expect(res.ok).toBe(true);
    expect(db.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-1" },
        data: expect.objectContaining({ status: "SELECTED", decidedById: "u-hr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "hiring.decided",
      detail: expect.stringContaining("selected"),
    }));
  });

  it("refuses to select a non-ACTIVE candidate", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "REJECTED" }));
    const res = await decideCandidate({ candidateId: "cand-1", decision: "SELECT", reason: "" });
    expect(res.ok).toBe(false);
    expect(db.candidate.update).not.toHaveBeenCalled();
  });

  it("reactivates a SELECTED candidate (undo a misclick)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REACTIVATE", reason: "" });
    expect(res.ok).toBe(true);
    expect(db.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE", decidedAt: null, decidedById: null }),
      }),
    );
  });
});

describe("R3 — rejection email outbox", () => {
  it("REJECT with sendEmail: queues QUEUED, sends, resolves SENT + provider id", async () => {
    const sendMail = vi.fn().mockResolvedValue({ delivered: true, messageId: "re-xyz-9" });
    createMailerMock.mockReturnValue({ sendMail });
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({
      candidateId: "cand-1", decision: "REJECT", reason: "Internal: depth below bar",
      sendEmail: true, emailRemarks: "We encourage you to apply again next quarter.",
    });
    expect(res.ok).toBe(true);
    // The row is created QUEUED before the send attempt (audit-first).
    expect(db.mailOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: "REJECTION", candidateId: "cand-1", toAddress: "nadia@example.com",
        status: "QUEUED", sentById: "u-hr",
      }),
    }));
    expect(sendMail).toHaveBeenCalledTimes(1);
    const sent = sendMail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(sent.to).toBe("nadia@example.com");
    expect(sent.subject).toContain("Senior Frontend Engineer");
    // Content contract: the INTERNAL reason never lands in the email; the
    // HR-approved remarks do.
    expect(sent.text).toContain("We encourage you to apply again next quarter.");
    expect(sent.text).not.toContain("depth below bar");
    // Resolved to SENT with the provider message id.
    expect(db.mailOutbox.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ob-1" },
      data: expect.objectContaining({ status: "SENT", providerMessageId: "re-xyz-9" }),
    }));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.email_queued" }));
  });

  it("records SKIPPED when the provider layer did not really deliver (dev dry-run)", async () => {
    const sendMail = vi.fn().mockResolvedValue({ delivered: false, messageId: null });
    createMailerMock.mockReturnValue({ sendMail });
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "x", sendEmail: true });
    expect(res.ok).toBe(true);
    expect(db.mailOutbox.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SKIPPED", providerMessageId: "" }),
    }));
  });

  it("records FAILED on a provider outage — the rejection decision itself still succeeds", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("Resend API error 422: quota exceeded"));
    createMailerMock.mockReturnValue({ sendMail });
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "x", sendEmail: true });
    expect(res.ok).toBe(true); // best-effort: the decision stands, the outbox carries the failure
    expect(db.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }),
    );
    expect(db.mailOutbox.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", error: expect.stringContaining("quota exceeded") }),
    }));
  });

  it("skips the outbox entirely when the email is not opted in", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "x" });
    expect(res.ok).toBe(true);
    expect(db.mailOutbox.create).not.toHaveBeenCalled();
    expect(createMailerMock).not.toHaveBeenCalled();
  });

  it("WITHDRAW never sends an email even with the flags set", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({
      candidateId: "cand-1", decision: "WITHDRAW", reason: "", sendEmail: true, emailRemarks: "hi",
    });
    expect(res.ok).toBe(true);
    expect(db.mailOutbox.create).not.toHaveBeenCalled();
  });
});

describe("getMailOutbox", () => {
  it("requires hiring:manage (a MANAGER is denied)", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:manage"));
    const res = await getMailOutbox();
    expect(res.ok).toBe(false);
    expect(db.mailOutbox.findMany).not.toHaveBeenCalled();
  });

  it("returns rows with sender + candidate names serialized to ISO strings", async () => {
    db.mailOutbox.findMany.mockResolvedValue([
      {
        id: "ob-2", kind: "REJECTION", candidateId: "cand-1",
        candidate: { fullName: "Nadia Petrova" },
        toAddress: "nadia@example.com", subject: "Update on your application — SWE at Fernly Workspace",
        body: "Hi Nadia,", status: "SENT", sentById: "u-hr",
        sentAt: new Date("2026-11-12T01:02:03Z"), providerMessageId: "re-1", error: "",
        createdAt: new Date("2026-11-12T01:02:03Z"),
      },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-hr", name: "Remy" }]);
    const res = await getMailOutbox();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        id: "ob-2", candidateName: "Nadia Petrova", sentBy: "Remy",
        status: "SENT", sentAt: "2026-11-12T01:02:03.000Z",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// R4 — joining formalities: document checklist + background checks
// ---------------------------------------------------------------------------

const DOC_TYPE = { id: "dt-1", key: "id_proof", label: "ID Document", description: "", isMandatory: true, sortOrder: 10, isActive: true };

function docRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cd-1", candidateId: "cand-1", docTypeKey: "id_proof", label: "ID Document",
    status: "REQUESTED", fileRef: "", remarks: "",
    requestedAt: new Date("2026-11-10T00:00:00Z"), receivedAt: null,
    verifiedById: "", verifiedAt: null,
    candidate: { fullName: "Nadia Petrova" },
    ...overrides,
  };
}

describe("R4 — document-type template config", () => {
  it("saveDocumentType requires hiring:config (HR lacks it in this mock)", async () => {
    requirePermissionMock.mockImplementation(async (p: string) => {
      if (p === "hiring:config") throw new (class extends Error { digest = "AuthorizationError"; })("denied");
      return HR_AUTH;
    });
    const res = await saveDocumentType({ key: "x", label: "X" });
    expect(res.ok).toBe(false);
    expect(db.documentTypeConfig.create).not.toHaveBeenCalled();
  });

  it("creates a type and audits doc_type_saved", async () => {
    const res = await saveDocumentType({ key: "id_proof", label: "ID Document", isMandatory: true, sortOrder: 10, isActive: true, description: "" });
    expect(res.ok).toBe(true);
    expect(db.documentTypeConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ key: "id_proof", isMandatory: true }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.doc_type_saved" }));
  });

  it("rejects an invalid key (uppercase letters) at validation", async () => {
    const res = await saveDocumentType({ key: "Bad Key", label: "X" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });

  it("deleteDocumentType removes the type and audits", async () => {
    const res = await deleteDocumentType({ id: "dt-1" });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.doc_type_deleted" }));
  });

  it("getDocumentTypes requires only hiring:view (MANAGER may read the template)", async () => {
    db.documentTypeConfig.findMany.mockResolvedValue([DOC_TYPE]);
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    const res = await getDocumentTypes();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data[0]).toMatchObject({ key: "id_proof", isMandatory: true });
  });
});

describe("R4 — document checklist lifecycle", () => {
  it("requestDocument creates a REQUESTED row with the label snapshot", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    db.documentTypeConfig.findUnique.mockResolvedValue(DOC_TYPE);
    const res = await requestDocument({ candidateId: "cand-1", docTypeKey: "id_proof" });
    expect(res.ok).toBe(true);
    expect(db.candidateDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          candidateId: "cand-1", docTypeKey: "id_proof", label: "ID Document", status: "REQUESTED",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.document_requested" }));
  });

  it("re-request resets a REJECTED row back to REQUESTED (idempotent upsert)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    db.documentTypeConfig.findUnique.mockResolvedValue(DOC_TYPE);
    db.candidateDocument.findUnique.mockResolvedValue(docRow({ status: "REJECTED", remarks: "bad scan" }));
    const res = await requestDocument({ candidateId: "cand-1", docTypeKey: "id_proof" });
    expect(res.ok).toBe(true);
    expect(db.candidateDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cd-1" },
        data: expect.objectContaining({ status: "REQUESTED", fileRef: "", verifiedById: "" }),
      }),
    );
  });

  it("refuses an unknown or inactive document type", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    db.documentTypeConfig.findUnique.mockResolvedValue({ ...DOC_TYPE, isActive: false });
    const res = await requestDocument({ candidateId: "cand-1", docTypeKey: "id_proof" });
    expect(res.ok).toBe(false);
    expect(db.candidateDocument.create).not.toHaveBeenCalled();
  });

  it("receiveDocument marks REQUESTED → RECEIVED with the file reference", async () => {
    db.candidateDocument.findUnique.mockResolvedValue(docRow());
    const res = await receiveDocument({ documentId: "cd-1", fileRef: "passport.pdf" });
    expect(res.ok).toBe(true);
    expect(db.candidateDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RECEIVED", fileRef: "passport.pdf", receivedAt: expect.any(Date) }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.document_received" }));
  });

  it("refuses to receive an already VERIFIED document", async () => {
    db.candidateDocument.findUnique.mockResolvedValue(docRow({ status: "VERIFIED" }));
    const res = await receiveDocument({ documentId: "cd-1", fileRef: "x.pdf" });
    expect(res.ok).toBe(false);
    expect(db.candidateDocument.update).not.toHaveBeenCalled();
  });

  it("verifyDocument records the verifier on a RECEIVED row", async () => {
    db.candidateDocument.findUnique.mockResolvedValue(docRow({ status: "RECEIVED" }));
    const res = await verifyDocument({ documentId: "cd-1", remarks: "matches the passport" });
    expect(res.ok).toBe(true);
    expect(db.candidateDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "VERIFIED", verifiedById: "u-hr", verifiedAt: expect.any(Date) }),
      }),
    );
  });

  it("refuses to verify a REQUESTED (not yet received) document", async () => {
    db.candidateDocument.findUnique.mockResolvedValue(docRow({ status: "REQUESTED" }));
    const res = await verifyDocument({ documentId: "cd-1" });
    expect(res.ok).toBe(false);
  });

  it("rejectDocument requires a note and stores it", async () => {
    db.candidateDocument.findUnique.mockResolvedValue(docRow({ status: "RECEIVED" }));
    const res = await rejectDocument({ documentId: "cd-1", remarks: "Wrong person's ID" });
    expect(res.ok).toBe(true);
    expect(db.candidateDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED", remarks: "Wrong person's ID" }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.document_rejected" }));
  });

  it("rejectDocument without a note fails validation", async () => {
    const res = await rejectDocument({ documentId: "cd-1", remarks: "  " });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });
});

describe("R4 — background checks", () => {
  it("initiateBackgroundCheck creates an INITIATED record with the initiator", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await initiateBackgroundCheck({ candidateId: "cand-1", vendor: "VerifyRight", notes: "T-14" });
    expect(res.ok).toBe(true);
    expect(db.backgroundCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        // status defaults to INITIATED at the DB level (schema @default).
        data: expect.objectContaining({ candidateId: "cand-1", vendor: "VerifyRight", initiatedById: "u-hr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.bg_check_initiated" }));
  });

  it("initiateBackgroundCheck requires a vendor", async () => {
    const res = await initiateBackgroundCheck({ candidateId: "cand-1", vendor: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });

  it("updateBackgroundCheck to IN_REVIEW keeps completedAt null", async () => {
    db.backgroundCheck.findUnique.mockResolvedValue({
      id: "bg-1", candidateId: "cand-1", vendor: "VerifyRight", status: "INITIATED",
      reportRef: "", notes: "", initiatedById: "u-hr",
      initiatedAt: new Date(), completedAt: null,
      candidate: { fullName: "Nadia Petrova" },
    });
    const res = await updateBackgroundCheck({ id: "bg-1", status: "IN_REVIEW" });
    expect(res.ok).toBe(true);
    expect(db.backgroundCheck.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "IN_REVIEW", completedAt: null }) }),
    );
  });

  it("updateBackgroundCheck to CLEARED stamps completedAt", async () => {
    db.backgroundCheck.findUnique.mockResolvedValue({
      id: "bg-1", candidateId: "cand-1", vendor: "VerifyRight", status: "IN_REVIEW",
      reportRef: "", notes: "", initiatedById: "u-hr",
      initiatedAt: new Date(), completedAt: null,
      candidate: { fullName: "Nadia Petrova" },
    });
    const res = await updateBackgroundCheck({ id: "bg-1", status: "CLEARED", reportRef: "VR-2026-114" });
    expect(res.ok).toBe(true);
    expect(db.backgroundCheck.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CLEARED", reportRef: "VR-2026-114", completedAt: expect.any(Date) }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.bg_check_updated" }));
  });

  it("refuses an unknown background check", async () => {
    db.backgroundCheck.findUnique.mockResolvedValue(null);
    const res = await updateBackgroundCheck({ id: "bg-404", status: "CLEARED" });
    expect(res.ok).toBe(false);
  });
});

describe("R4 — getJoiningFormalities", () => {
  it("requires hiring:manage (a MANAGER read-only user is denied)", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:manage"));
    const res = await getJoiningFormalities("cand-1");
    expect(res.ok).toBe(false);
    expect(db.candidateDocument.findMany).not.toHaveBeenCalled();
  });

  it("returns the checklist bundle with verifier + initiator names serialized", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    db.documentTypeConfig.findMany.mockResolvedValue([DOC_TYPE]);
    db.candidateDocument.findMany.mockResolvedValue([
      {
        id: "cd-1", candidateId: "cand-1", docTypeKey: "id_proof", label: "ID Document",
        status: "VERIFIED", fileRef: "passport.pdf", remarks: "",
        requestedAt: new Date("2026-11-10T00:00:00Z"), receivedAt: new Date("2026-11-11T00:00:00Z"),
        verifiedById: "u-hr", verifiedAt: new Date("2026-11-12T00:00:00Z"),
      },
    ]);
    db.backgroundCheck.findMany.mockResolvedValue([
      {
        id: "bg-1", candidateId: "cand-1", vendor: "VerifyRight", status: "IN_REVIEW",
        reportRef: "", notes: "", initiatedById: "u-hr",
        initiatedAt: new Date("2026-11-08T00:00:00Z"), completedAt: null,
      },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-hr", name: "Remy" }]);
    const res = await getJoiningFormalities("cand-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.docTypes).toHaveLength(1);
      expect(res.data.documents[0]).toMatchObject({
        status: "VERIFIED", verifiedBy: "Remy", verifiedAt: "2026-11-12T00:00:00.000Z",
      });
      expect(res.data.bgChecks[0]).toMatchObject({ vendor: "VerifyRight", initiatedBy: "Remy" });
    }
  });

  it("refuses an unknown candidate", async () => {
    db.candidate.findUnique.mockResolvedValue(null);
    const res = await getJoiningFormalities("cand-404");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R5 — offer builder: templates + per-candidate offers
// ---------------------------------------------------------------------------

const OFFER_TEMPLATE_ROW = {
  id: "ot-1", key: "designer", label: "Designer Band", description: "",
  components: JSON.stringify([
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68000 },
    { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
  ]),
  benefits: JSON.stringify(["4 weeks annual leave"]),
  letterTemplate: "Hi {{candidateName}} — CTC {{annualCtc}} at {{workspaceName}}.",
  isActive: true, sortOrder: 10,
};

describe("R5 — offer templates", () => {
  it("getOfferTemplates requires hiring:manage (a MANAGER read-only user is denied)", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:manage"));
    const res = await getOfferTemplates();
    expect(res.ok).toBe(false);
    expect(db.offerTemplate.findMany).not.toHaveBeenCalled();
  });

  it("saveOfferTemplate stringifies components + benefits and audits", async () => {
    const res = await saveOfferTemplate({
      key: "designer", label: "Designer Band",
      components: [{ key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68000 }],
      benefits: ["4 weeks annual leave"], letterTemplate: "Hi", isActive: true, sortOrder: 10,
    });
    expect(res.ok).toBe(true);
    expect(db.offerTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          components: expect.stringContaining('"basic"'),
          benefits: expect.stringContaining("annual leave"),
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.offer_template_saved" }));
  });

  it("rejects a component with an invalid kind at validation", async () => {
    const res = await saveOfferTemplate({
      key: "x", label: "X",
      components: [{ key: "basic", label: "B", kind: "MAGIC" as never, mode: "FIXED", amount: 1 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION");
  });

  it("deleteOfferTemplate removes and audits", async () => {
    db.offerTemplate.delete.mockResolvedValue({ id: "ot-1", label: "Designer Band" });
    const res = await deleteOfferTemplate({ id: "ot-1" });
    expect(res.ok).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.offer_template_deleted" }));
  });
});

describe("R5 — createOfferRecord", () => {
  it("generates a DRAFT offer for a SELECTED candidate with the letter rendered", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerTemplate.findUnique.mockResolvedValue(OFFER_TEMPLATE_ROW);
    const res = await createOfferRecord({ candidateId: "cand-1", templateId: "ot-1" });
    expect(res.ok).toBe(true);
    const createArg = db.offerRecord.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data).toMatchObject({
      candidateId: "cand-1", templateId: "ot-1", templateLabel: "Designer Band", status: "DRAFT",
    });
    // Letter placeholders resolved: name + CTC (68,000 + 3% = 70,040).
    expect(createArg.data.letterText).toBe("Hi Nadia Petrova — CTC $70,040 at Fernly Workspace.");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.offer_created" }));
  });

  it("refuses offers for non-SELECTED candidates (the decision gates the offer)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "ACTIVE" }));
    db.offerTemplate.findUnique.mockResolvedValue(OFFER_TEMPLATE_ROW);
    const res = await createOfferRecord({ candidateId: "cand-1", templateId: "ot-1" });
    expect(res.ok).toBe(false);
    expect(db.offerRecord.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown or inactive template", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerTemplate.findUnique.mockResolvedValue({ ...OFFER_TEMPLATE_ROW, isActive: false });
    const res = await createOfferRecord({ candidateId: "cand-1", templateId: "ot-1" });
    expect(res.ok).toBe(false);
  });
});

describe("R5 — updateOfferRecord + getOfferRecords", () => {
  const OFFER_ROW = {
    id: "or-1", candidateId: "cand-1", templateId: "ot-1", templateLabel: "Designer Band",
    components: OFFER_TEMPLATE_ROW.components, benefits: OFFER_TEMPLATE_ROW.benefits,
    letterText: "Hi", status: "DRAFT", notes: "",
    createdById: "u-hr", createdAt: new Date(), updatedAt: new Date(),
    candidate: { fullName: "Nadia Petrova", position: "Product Designer" },
  };

  it("updates a DRAFT offer's negotiated components + letter", async () => {
    db.offerRecord.findUnique.mockResolvedValue(OFFER_ROW);
    const components = [
      { key: "basic", label: "Basic Salary", kind: "EARNING" as const, mode: "FIXED" as const, amount: 72_000 },
    ];
    const res = await updateOfferRecord({ id: "or-1", components, benefits: [], letterText: "negotiated", notes: "bumped" });
    expect(res.ok).toBe(true);
    expect(db.offerRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "or-1" },
        data: expect.objectContaining({ components: JSON.stringify(components), notes: "bumped" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.offer_updated" }));
  });

  it("refuses to edit a SENT offer — sent offers are immutable", async () => {
    db.offerRecord.findUnique.mockResolvedValue({ ...OFFER_ROW, status: "SENT" });
    const res = await updateOfferRecord({
      id: "or-1",
      components: [{ key: "basic", label: "B", kind: "EARNING", mode: "FIXED", amount: 1 }],
      benefits: [],
    });
    expect(res.ok).toBe(false);
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });

  it("getOfferRecords returns serialized rows with the creator name", async () => {
    db.offerRecord.findMany.mockResolvedValue([OFFER_ROW]);
    db.user.findMany.mockResolvedValue([{ id: "u-hr", name: "Remy" }]);
    const res = await getOfferRecords();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]).toMatchObject({
        id: "or-1", candidateName: "Nadia Petrova", templateLabel: "Designer Band",
        createdBy: "Remy", status: "DRAFT",
      });
      expect(res.data[0].components[0]).toMatchObject({ key: "basic", amount: 68_000 });
    }
  });
});
