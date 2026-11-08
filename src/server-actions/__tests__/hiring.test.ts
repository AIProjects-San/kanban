import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Recruitment R1 — hiring action tests (docs/RECRUITMENT_MODULE_PLAN.md §5):
// template snapshot at creation, advance/skip transitions, decisions with
// reasons, the hired-candidate delete guard, and template-config gating.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["hiringStageConfig", "candidate", "candidateStage", "user", "auditLog", "notification", "calendarEvent", "reminder", "mailOutbox", "documentTypeConfig", "candidateDocument", "backgroundCheck", "offerTemplate", "offerRecord", "teamMember", "employeeProfile", "onboardingChecklist", "onboardingTask", "salaryStructure", "salaryComponent", "onboardingTemplateTask"];
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
const getSessionOrThrowMock = vi.fn();
const checkPermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  getSessionOrThrow: (...a: unknown[]) => getSessionOrThrowMock(...a),
  // F-R13 — the DB-aware probe saveScorecard/getHiringPermissions consult.
  // Default mock mirrors the static floor: ADMIN/HR hold every hiring perm.
  checkPermission: (...a: unknown[]) => checkPermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", async () => {
  // F2.10 — sendOutboxMail / readOnboardingTemplate / instantiateChecklist
  // run for real (over the mocked db + injectable mailer), exactly like the
  // code under test uses them; only logAudit is a spy.
  const actual = await vi.importActual<typeof import("@/server-actions/shared")>("@/server-actions/shared");
  return {
    logAudit: (...a: unknown[]) => logAuditMock(...a),
    sendOutboxMail: actual.sendOutboxMail,
    readOnboardingTemplate: actual.readOnboardingTemplate,
    instantiateChecklist: actual.instantiateChecklist,
  };
});

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

// R6 — password hashing for the auto-created hire account (deterministic
// test value; the real hashPassword is covered by lib/password tests).
vi.mock("@/lib/password", async () => {
  const actual = await vi.importActual<typeof import("@/lib/password")>("@/lib/password");
  return { ...actual, hashPassword: vi.fn(async () => "hashed-test") };
});

// R6 — the signing page captures the client IP behind the reverse proxy.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
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
  getHiringFunnel,
  sendOffer,
  getOfferByToken,
  signOffer,
  declineOffer,
  markJoined,
  approveOffer,
  getOffersAwaitingApproval,
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
  // P0-5 — the session-scoped actions (getMyInterviews / saveScorecard)
  // authenticate via getSessionOrThrow; default to the HR identity, with
  // individual tests swapping in the MEMBER-interviewer fixture.
  getSessionOrThrowMock.mockResolvedValue(HR_AUTH);
  // F-R13 — checkPermission defaults to the static floor (ADMIN/HR hold the
  // hiring perms; MANAGER/MEMBER don't); tests can override per-case.
  // F2.10 — hiring:approve is the exception: ADMIN/MANAGER hold it, HR (the
  // composer's role) deliberately does not.
  checkPermissionMock.mockImplementation(
    async (role: string, perm: string) =>
      perm === "hiring:approve" ? role === "ADMIN" || role === "MANAGER" : role === "ADMIN" || role === "HR",
  );
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
  // R3 — outbox + mailer defaults. findFirst null = no duplicate send
  // today (the D-18 guard's happy path; individual tests override it).
  db.mailOutbox.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ob-1", ...data }));
  db.mailOutbox.update.mockResolvedValue({});
  db.mailOutbox.findMany.mockResolvedValue([]);
  db.mailOutbox.findFirst.mockResolvedValue(null);
  createMailerMock.mockReset();
  createMailerMock.mockReturnValue({ sendMail: vi.fn().mockResolvedValue({ delivered: true, messageId: "re-test-1" }) });
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
  // R6 — joined-hire provisioning models.
  db.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "u-new", ...data }));
  db.teamMember.create.mockResolvedValue({ id: "tm-new" });
  db.employeeProfile.create.mockResolvedValue({ id: "ep-new" });
  db.onboardingChecklist.create.mockImplementation(async ({ data }: { data: { tasks?: { create?: Record<string, unknown>[] } } & Record<string, unknown> }) => ({
    id: "oc-new", completedAt: null, createdAt: new Date(), updatedAt: new Date(), kind: "ONBOARDING",
    ...data,
    tasks: (data.tasks?.create ?? []).map((t, i) => ({ id: `ot-${i}`, checklistId: "oc-new", assigneeId: null, done: false, doneAt: null, doneById: null, notes: "", order: i, createdAt: new Date(), updatedAt: new Date(), ...t })),
  }));
  // F2.10 — offer lapse (updateMany), salary-structure copy + catalog, and
  // the onboarding-template source (empty table → constant fallback).
  db.offerRecord.updateMany.mockResolvedValue({ count: 0 });
  db.salaryStructure.updateMany.mockResolvedValue({ count: 0 });
  db.salaryStructure.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ss-new", ...data }));
  db.salaryComponent.findMany.mockResolvedValue([]);
  db.salaryComponent.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sc-new", ...data }));
  db.onboardingTemplateTask.findMany.mockResolvedValue([]);
  // F-R6 — the reschedule cleanup path.
  db.reminder.deleteMany.mockResolvedValue({ count: 0 });
  db.calendarEvent.delete.mockResolvedValue({ id: "ev-old" });
  getWorkspaceConfigMock.mockResolvedValue({
    workspace: { name: "Fernly Workspace", hiringEmailDomain: "fernly.app", defaultDepartment: "ENGINEERING", joiningGateEnabled: false },
  });
});

const INTERVIEW_STAGE = {
  id: "st-2", candidateId: "cand-1", stageKey: "interview_1", label: "Interview 1 — Technical",
  stageType: "INTERVIEW", ownerUserId: "u-mgr", status: "IN_PROGRESS",
  scheduledAt: null, remarks: "", rating: null, strengths: "", concerns: "",
  recommendation: null, eventId: null, sortOrder: 20, startedAt: null, completedAt: null,
  candidate: { id: "cand-1", fullName: "Nadia Petrova", email: "nadia@example.com", position: "SWE", status: "ACTIVE" },
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
  it("HR can manage and configure; MANAGER is view-only — except offer approval (F2.10)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const hrRes = await getHiringPermissions();
    expect(hrRes.ok).toBe(true);
    // F2.10 — HR composes but does NOT approve (four-eyes; MANAGER approves).
    if (hrRes.ok) expect(hrRes.data).toEqual({ canManage: true, canConfig: true, canApprove: false, mailConfigured: false });

    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    const mgrRes = await getHiringPermissions();
    expect(mgrRes.ok).toBe(true);
    if (mgrRes.ok) expect(mgrRes.data).toEqual({ canManage: false, canConfig: false, canApprove: true, mailConfigured: false });
  });

  // F2.10 — the DB-aware probe reflects DB grants for hiring:approve too.
  it("canApprove follows the DB ceiling, not just the static floor", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    checkPermissionMock.mockImplementation(async (role: string, perm: string) =>
      perm === "hiring:approve" ? role === "MANAGER" : role === "HR",
    );
    const res = await getHiringPermissions();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.canApprove).toBe(false);
  });

  // P0-6 (D-05/D-18) — the probe feeds the hiring view's first-run warning,
  // so the mailConfigured flag must mirror the mailer factory's env truth.
  it("reports mailConfigured true when RESEND_API_KEY is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    try {
      const res = await getHiringPermissions();
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.mailConfigured).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
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
    getSessionOrThrowMock.mockResolvedValue(MANAGER_AUTH);
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
    getSessionOrThrowMock.mockResolvedValue(MEMBER_AUTH);
    db.candidateStage.findUnique.mockResolvedValue(INTERVIEW_STAGE);
    const res = await saveScorecard({ stageId: "st-2", rating: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("assigned interviewer");
    expect(db.candidateStage.update).not.toHaveBeenCalled();
  });

  it("F-R13 — a DB-granted hiring:manage authorizes a non-owner (the static floor alone would not)", async () => {
    // The RBAC inconsistency the deep read found: saveScorecard consulted
    // the raw static hasPermission(), so a MEMBER whose role gained
    // hiring:manage through the DB permission editor was still refused.
    // checkPermission must honor the DB ceiling.
    getSessionOrThrowMock.mockResolvedValue(MEMBER_AUTH);
    db.candidateStage.findUnique.mockResolvedValue(INTERVIEW_STAGE);
    checkPermissionMock.mockResolvedValue(false); // static floor: MEMBER has nothing
    const refused = await saveScorecard({ stageId: "st-2", rating: 5 });
    expect(refused.ok).toBe(false);
    expect(db.candidateStage.update).not.toHaveBeenCalled();

    checkPermissionMock.mockResolvedValue(true); // DB ceiling grants hiring:manage
    const allowed = await saveScorecard({ stageId: "st-2", rating: 5 });
    expect(allowed.ok).toBe(true);
    expect(checkPermissionMock).toHaveBeenCalledWith("MEMBER", "hiring:manage");
    expect(db.candidateStage.update).toHaveBeenCalled();
  });

  it("P0-5 (D-04) — a MEMBER who IS the assigned interviewer saves their own scorecard without hiring:view", async () => {
    // The persona-audit defect: HR assigns a plain member as interviewer,
    // but the old requirePermission("hiring:view") gate rejected them before
    // the isOwner exception could apply — dead code for exactly the user the
    // exception was written for. Now session-scoped: the MEMBER-interviewer
    // reaches the isOwner check and passes.
    getSessionOrThrowMock.mockResolvedValue(MEMBER_AUTH);
    db.candidateStage.findUnique.mockResolvedValue({ ...INTERVIEW_STAGE, ownerUserId: "u-diego" });
    const res = await saveScorecard({
      stageId: "st-2", rating: 5, strengths: "Sharp systems thinking",
      concerns: "None observed", recommendation: "STRONG_HIRE", remarks: "Would hire again",
    });
    expect(res.ok).toBe(true);
    expect(db.candidateStage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "st-2" },
        data: expect.objectContaining({ rating: 5, recommendation: "STRONG_HIRE" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hiring.scorecard_saved", actor: expect.objectContaining({ userId: "u-diego" }) }),
    );
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
    getSessionOrThrowMock.mockResolvedValue(MANAGER_AUTH);
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

  it("P0-5 (D-04) — a MEMBER (no hiring:view) still gets their own assignments — the WHERE is the whole policy", async () => {
    // The old gate (requirePermission("hiring:view")) rejected member
    // interviewers before the self-scoping WHERE could run; now any signed-in
    // user's own rows come back and nothing else.
    getSessionOrThrowMock.mockResolvedValue(MEMBER_AUTH);
    db.candidateStage.findMany.mockResolvedValue([
      {
        id: "st-9", label: "Interview 2 — HR & Culture", candidateId: "cand-7",
        status: "PENDING", scheduledAt: null, rating: null, recommendation: null,
        candidate: { id: "cand-7", fullName: "Tomas Eriksen", position: "QA Engineer", status: "ACTIVE" },
      },
    ]);
    const res = await getMyInterviews();
    expect(res.ok).toBe(true);
    expect(requirePermissionMock).not.toHaveBeenCalled();
    expect(db.candidateStage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerUserId: "u-diego" }) }),
    );
    if (res.ok) expect(res.data[0].candidateName).toBe("Tomas Eriksen");
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
    if (res.ok) expect(res.data.mailStatus).toBe("SENT");
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
    if (res.ok) expect(res.data.mailStatus).toBe("SKIPPED");
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
    if (res.ok) expect(res.data.mailStatus).toBe("FAILED");
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
    if (res.ok) expect(res.data.mailStatus).toBeNull();
    expect(db.mailOutbox.create).not.toHaveBeenCalled();
    expect(createMailerMock).not.toHaveBeenCalled();
  });

  it("WITHDRAW never sends an email even with the flags set", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({
      candidateId: "cand-1", decision: "WITHDRAW", reason: "", sendEmail: true, emailRemarks: "hi",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.mailStatus).toBeNull();
    expect(db.mailOutbox.create).not.toHaveBeenCalled();
    // The D-18 guard is REJECT-scoped — WITHDRAW must never trip it.
    expect(db.mailOutbox.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D-18 (P0-6) — duplicate-email guard: one outbox send per candidate + kind
// + UTC day, BLOCKING semantics (the decision itself is refused before any
// state mutation, so a blocked duplicate never half-applies).
// ---------------------------------------------------------------------------

describe("D-18 — duplicate rejection email guard", () => {
  it("blocks a second REJECTION email to the same candidate on the same UTC day — nothing is mutated", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    db.mailOutbox.findFirst.mockResolvedValue({ id: "ob-dup" }); // earlier send today
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "x", sendEmail: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("already sent");
      expect(res.error).toContain("Nadia Petrova");
      expect(res.error).toContain("Uncheck");
    }
    // Blocking semantics: the guard runs BEFORE the candidate update, so the
    // decision is not half-applied and no outbox row/mailer call happens.
    expect(db.candidate.update).not.toHaveBeenCalled();
    expect(db.mailOutbox.create).not.toHaveBeenCalled();
    expect(createMailerMock).not.toHaveBeenCalled();
  });

  it("scopes the guard to the same UTC day — the where clause is bounded by its start", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "x", sendEmail: true });
    expect(res.ok).toBe(true);
    const where = db.mailOutbox.findFirst.mock.calls[0][0]?.where as {
      candidateId: string; kind: string; createdAt: { gte: Date };
    };
    expect(where.candidateId).toBe("cand-1");
    expect(where.kind).toBe("REJECTION");
    const gte = where.createdAt.gte;
    const now = new Date();
    expect(gte.getUTCHours()).toBe(0);
    expect(gte.getUTCMinutes()).toBe(0);
    expect(gte.getUTCSeconds()).toBe(0);
    expect(gte.getUTCFullYear()).toBe(now.getUTCFullYear());
    expect(gte.getUTCMonth()).toBe(now.getUTCMonth());
    expect(gte.getUTCDate()).toBe(now.getUTCDate());
  });

  it("yesterday's send does not block today's (guard window is one day)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    // findFirst returning null stands for "no row at/after start of today".
    db.mailOutbox.findFirst.mockResolvedValue(null);
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "x", sendEmail: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.mailStatus).toBe("SENT");
  });

  it("an opted-out rejection never consults the guard", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    db.mailOutbox.findFirst.mockResolvedValue({ id: "ob-dup" }); // would block
    const res = await decideCandidate({ candidateId: "cand-1", decision: "REJECT", reason: "x", sendEmail: false });
    expect(res.ok).toBe(true);
    expect(db.mailOutbox.findFirst).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// R6 — e-sign + auto employee creation (docs/RECRUITMENT_MODULE_PLAN.md §5).
// sendOffer → tokenized link via the audited outbox; getOfferByToken /
// signOffer / declineOffer are the PUBLIC token-gated actions; markJoined
// provisions the employee account + onboarding checklist.
// ---------------------------------------------------------------------------

// F2.10 — the sendable state is APPROVED (the manager four-eyes step sits
// between compose and send); approvedById/approvedAt carry the trail.
const R6_OFFER = {
  id: "or-1", candidateId: "cand-1", templateId: "ot-1", templateLabel: "Designer Band",
  components: JSON.stringify([
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68_000 },
    { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
  ]),
  benefits: JSON.stringify(["4 weeks annual leave"]),
  letterText: "Hi Nadia — CTC $70,040.", status: "APPROVED", notes: "",
  createdById: "u-hr", approvedById: "u-mgr", approvedAt: new Date("2026-11-14T09:00:00Z"),
  startDate: null, token: null, tokenExpiresAt: null,
  signedAt: null, signedName: "", signedIp: "",
  createdAt: new Date(), updatedAt: new Date(),
  candidate: { id: "cand-1", fullName: "Nadia Petrova", email: "nadia@example.com", position: "Product Designer", status: "SELECTED" },
};

describe("R6 — sendOffer", () => {
  it("requires hiring:manage", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:manage"));
    const res = await sendOffer({ offerId: "or-1" });
    expect(res.ok).toBe(false);
  });

  it("mints a single-use token + 7-day expiry, marks SENT, and records the OFFER outbox email", async () => {
    db.offerRecord.findUnique.mockResolvedValue(R6_OFFER);
    const res = await sendOffer({ offerId: "or-1" });
    expect(res.ok).toBe(true);

    const updateArg = db.offerRecord.update.mock.calls[0][0] as {
      where: { id: string };
      data: { status: string; token: string; tokenExpiresAt: Date };
    };
    expect(updateArg.where.id).toBe("or-1");
    expect(updateArg.data.status).toBe("SENT");
    expect(updateArg.data.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const days = (updateArg.data.tokenExpiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    // The outbox row carries the candidate email + kind OFFER.
    const outboxArg = db.mailOutbox.create.mock.calls[0][0] as { data: { kind: string; toAddress: string; status: string } };
    expect(outboxArg.data.kind).toBe("OFFER");
    expect(outboxArg.data.toAddress).toBe("nadia@example.com");
    expect(outboxArg.data.status).toBe("QUEUED");
    // Default mailer delivers → the row resolves SENT with the provider id.
    const resolveArg = db.mailOutbox.update.mock.calls[0][0] as { data: { status: string; providerMessageId: string } };
    expect(resolveArg.data.status).toBe("SENT");
    expect(resolveArg.data.providerMessageId).toBe("re-test-1");
    // The returned token addresses the offer.
    if (res.ok) expect(res.data.token).toBe(updateArg.data.token);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.offer_sent" }));
  });

  it("a provider outage records FAILED but never fails the send itself", async () => {
    db.offerRecord.findUnique.mockResolvedValue(R6_OFFER);
    createMailerMock.mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error("Resend unreachable")),
    });
    const res = await sendOffer({ offerId: "or-1" });
    expect(res.ok).toBe(true);
    const resolveArg = db.mailOutbox.update.mock.calls[0][0] as { data: { status: string; error: string } };
    expect(resolveArg.data.status).toBe("FAILED");
    expect(resolveArg.data.error).toContain("Resend unreachable");
  });

  it("refuses to send a DRAFT offer — manager approval is required first (F2.10)", async () => {
    db.offerRecord.findUnique.mockResolvedValue({ ...R6_OFFER, status: "DRAFT" });
    const res = await sendOffer({ offerId: "or-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Manager approval is required");
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });

  it("refuses to send a non-APPROVED offer (immutable once sent)", async () => {
    db.offerRecord.findUnique.mockResolvedValue({ ...R6_OFFER, status: "SENT", token: "tok-existing" });
    const res = await sendOffer({ offerId: "or-1" });
    expect(res.ok).toBe(false);
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });

  it("refuses to send when the candidate is no longer SELECTED", async () => {
    db.offerRecord.findUnique.mockResolvedValue({
      ...R6_OFFER,
      candidate: { ...R6_OFFER.candidate, status: "ACTIVE" },
    });
    const res = await sendOffer({ offerId: "or-1" });
    expect(res.ok).toBe(false);
  });
});

describe("R6 — getOfferByToken (public)", () => {
  it("returns state OPEN + letter + resolved components + totals for a live SENT token", async () => {
    db.offerRecord.findUnique.mockResolvedValue({
      ...R6_OFFER,
      status: "SENT",
      token: "tok-live",
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
      candidate: { fullName: "Nadia Petrova", position: "Product Designer" },
    });
    const res = await getOfferByToken("tok-live");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.state).toBe("OPEN");
      expect(res.data.candidateName).toBe("Nadia Petrova");
      expect(res.data.totals.ctc).toBe(70_040);
      expect(res.data.totals.net).toBe(68_000);
      const kiwi = res.data.components.find((c) => c.key === "kiwisaver");
      expect(kiwi?.resolved).toBe(2_040);
    }
  });

  it.each([
    ["SIGNED", "SIGNED"],
    ["DECLINED", "DECLINED"],
  ])("a consumed %s token returns its recorded state (reloading shows the outcome, not a dead end)", async (status, state) => {
    db.offerRecord.findUnique.mockResolvedValue({
      ...R6_OFFER, status, token: `tok-${status.toLowerCase()}`,
      signedAt: status === "SIGNED" ? new Date("2026-11-14T10:30:00Z") : null,
      signedName: status === "SIGNED" ? "Nadia Petrova" : "",
    });
    const res = await getOfferByToken(`tok-${status.toLowerCase()}`);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.state).toBe(state);
      if (status === "SIGNED") {
        expect(res.data.signedName).toBe("Nadia Petrova");
        expect(res.data.signedAt).toBe("2026-11-14T10:30:00.000Z");
      }
    }
  });

  it("refuses an expired SENT token", async () => {
    db.offerRecord.findUnique.mockResolvedValue({
      ...R6_OFFER, status: "SENT", token: "tok-old",
      tokenExpiresAt: new Date(Date.now() - 1_000),
    });
    const res = await getOfferByToken("tok-old");
    expect(res.ok).toBe(false);
  });

  it("an expired-but-SIGNED token still shows the signed outcome (immutable once signed)", async () => {
    db.offerRecord.findUnique.mockResolvedValue({
      ...R6_OFFER, status: "SIGNED", token: "tok-signed-old",
      tokenExpiresAt: new Date(Date.now() - 86_400_000),
      signedAt: new Date(), signedName: "Nadia Petrova",
    });
    const res = await getOfferByToken("tok-signed-old");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.state).toBe("SIGNED");
  });

  it("refuses an unknown token without leaking anything", async () => {
    db.offerRecord.findUnique.mockResolvedValue(null);
    const res = await getOfferByToken("nope");
    expect(res.ok).toBe(false);
  });

  it("refuses a token whose offer was never sent", async () => {
    db.offerRecord.findUnique.mockResolvedValue({ ...R6_OFFER, status: "DRAFT", token: "tok-draft" });
    const res = await getOfferByToken("tok-draft");
    expect(res.ok).toBe(false);
  });
});

describe("R6 — signOffer (public)", () => {
  const SENT_OFFER = {
    ...R6_OFFER, status: "SENT", token: "tok-live",
    tokenExpiresAt: new Date(Date.now() + 86_400_000),
    candidate: { id: "cand-1", fullName: "Nadia Petrova" },
  };

  it("rejects a name that does not match the candidate (the ceremony)", async () => {
    db.offerRecord.findUnique.mockResolvedValue(SENT_OFFER);
    const res = await signOffer({ token: "tok-live", signedName: "Someone Else" });
    expect(res.ok).toBe(false);
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });

  it("records SIGNED + signedName + signedIp (case-insensitive name match)", async () => {
    db.offerRecord.findUnique.mockResolvedValue(SENT_OFFER);
    const res = await signOffer({ token: "tok-live", signedName: "nadia petrova" });
    expect(res.ok).toBe(true);
    const updateArg = db.offerRecord.update.mock.calls[0][0] as {
      data: { status: string; signedName: string; signedIp: string; signedAt: Date };
    };
    expect(updateArg.data.status).toBe("SIGNED");
    expect(updateArg.data.signedName).toBe("nadia petrova");
    // The client IP comes from the first x-forwarded-for hop.
    expect(updateArg.data.signedIp).toBe("203.0.113.9");
    expect(updateArg.data.signedAt).toBeInstanceOf(Date);
    // The audit actor is the candidate, not a session user.
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "hiring.offer_signed",
      actor: expect.objectContaining({ role: "CANDIDATE" }),
    }));
  });

  it("refuses an expired or already-consumed token", async () => {
    db.offerRecord.findUnique.mockResolvedValueOnce({
      ...SENT_OFFER, tokenExpiresAt: new Date(Date.now() - 1_000),
    }).mockResolvedValueOnce({ ...SENT_OFFER, status: "SIGNED" });
    const expired = await signOffer({ token: "tok-live", signedName: "Nadia Petrova" });
    expect(expired.ok).toBe(false);
    const consumed = await signOffer({ token: "tok-live", signedName: "Nadia Petrova" });
    expect(consumed.ok).toBe(false);
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });
});

describe("R6 — declineOffer (public)", () => {
  it("marks a SENT offer DECLINED with an audit entry", async () => {
    db.offerRecord.findUnique.mockResolvedValue({
      ...R6_OFFER, status: "SENT", token: "tok-live",
      candidate: { id: "cand-1", fullName: "Nadia Petrova" },
    });
    const res = await declineOffer({ token: "tok-live" });
    expect(res.ok).toBe(true);
    expect(db.offerRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "or-1" }, data: { status: "DECLINED" } }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.offer_declined" }));
  });

  it("refuses anything that is not SENT", async () => {
    db.offerRecord.findUnique.mockResolvedValue({ ...R6_OFFER, status: "DRAFT" });
    const res = await declineOffer({ token: "tok-draft" });
    expect(res.ok).toBe(false);
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });
});

describe("R6 — markJoined", () => {
  const SELECTED_WITH_SIGNER = () => candidateWithStages({ status: "SELECTED" });

  it("requires hiring:manage", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:manage"));
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(false);
  });

  it("refuses candidates without a SIGNED offer (signature gates joining)", async () => {
    db.candidate.findUnique.mockResolvedValue(SELECTED_WITH_SIGNER());
    db.offerRecord.findFirst.mockResolvedValue(null);
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(false);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("refuses non-SELECTED candidates and already-joined duplicates", async () => {
    db.candidate.findUnique.mockResolvedValueOnce(candidateWithStages({ status: "ACTIVE" }));
    db.offerRecord.findFirst.mockResolvedValue({ id: "or-signed", status: "SIGNED" });
    const active = await markJoined({ candidateId: "cand-1" });
    expect(active.ok).toBe(false);

    db.candidate.findUnique.mockResolvedValueOnce(
      candidateWithStages({ status: "HIRED", userId: "u-existing" }),
    );
    const dup = await markJoined({ candidateId: "cand-1" });
    expect(dup.ok).toBe(false);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("provisions account + roster + profile + salary structure + onboarding checklist, flips the candidate to HIRED, and queues the welcome email", async () => {
    db.candidate.findUnique.mockResolvedValue(SELECTED_WITH_SIGNER());
    db.offerRecord.findFirst.mockResolvedValue({
      id: "or-signed", status: "SIGNED", signedAt: new Date(), templateLabel: "Designer Band",
      components: JSON.stringify([
        { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68_000 },
        { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
      ]),
    });
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.email).toBe("nadia.petrova@fernly.app");
      expect(res.data.userId).toBe("u-new");
      // D-03 (P0-4) — the workspace name rides along for the day-one handout.
      expect(res.data.workspaceName).toBe("Fernly Workspace");
      // F2.10 (F-R7) — the joiner is payroll-ready: the signed offer's
      // components became an ACTIVE salary structure.
      expect(res.data.payrollReady).toBe(true);
      // F2.10 (F-R8) — the instantiated template tasks ride along (the
      // day-one handout prints these instead of a client copy).
      expect(res.data.checklistTasks).toHaveLength(5);
    }

    // 1 — the User account: deterministic email, MEMBER role, hashed password.
    const userArg = db.user.create.mock.calls[0][0] as { data: { email: string; name: string; role: string; passwordHash: string } };
    expect(userArg.data.email).toBe("nadia.petrova@fernly.app");
    expect(userArg.data.name).toBe("Nadia Petrova");
    expect(userArg.data.role).toBe("MEMBER");
    expect(userArg.data.passwordHash).toBe("hashed-test");
    // 2 — roster entry + employee profile carry the department/position.
    expect(db.teamMember.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "u-new", email: "nadia.petrova@fernly.app", department: "ENGINEERING" }),
    }));
    expect(db.employeeProfile.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "u-new", jobTitle: "Senior Frontend Engineer" }),
    }));
    // 3 — the standard 5-task onboarding checklist (F2.10: instantiated from
    // the ONE template source — constant fallback when the table is empty).
    const checklistArg = db.onboardingChecklist.create.mock.calls[0][0] as {
      data: { newHireId: string; tasks: { create: unknown[] } };
    };
    expect(checklistArg.data.newHireId).toBe("u-new");
    expect(checklistArg.data.tasks.create).toHaveLength(5);
    // 4 — F2.10 (F-R7): the salary structure copy — the offer's components
    // verbatim (amounts never rewritten), notes naming the source.
    expect(db.salaryStructure.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-new",
          isActive: true,
          notes: "Copied from the signed offer (Designer Band) on joining.",
        }),
      }),
    );
    const structureArg = db.salaryStructure.create.mock.calls[0][0] as { data: { components: string } };
    expect(JSON.parse(structureArg.data.components)).toEqual([
      { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68_000 },
      { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
    ]);
    // 5 — candidate → HIRED with the link back to the account.
    expect(db.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-1" },
        data: expect.objectContaining({ status: "HIRED", userId: "u-new" }),
      }),
    );
    // 6 — WELCOME email via the outbox (delivered by the default mock).
    const outboxArg = db.mailOutbox.create.mock.calls[0][0] as { data: { kind: string; toAddress: string } };
    expect(outboxArg.data.kind).toBe("WELCOME");
    expect(outboxArg.data.toAddress).toBe("nadia.petrova@fernly.app");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.candidate_joined" }));
  });

  it("normalizes awkward legal names to <first>.<last>@", async () => {
    db.candidate.findUnique.mockResolvedValue(
      candidateWithStages({ status: "SELECTED", fullName: "Jean-Luc O'Brien" }),
    );
    db.offerRecord.findFirst.mockResolvedValue({ id: "or-signed", status: "SIGNED" });
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.email).toBe("jean.luc@fernly.app");
  });

  it("collisions get the numeric suffix (nadia.petrova2@…)", async () => {
    db.candidate.findUnique.mockResolvedValue(SELECTED_WITH_SIGNER());
    db.offerRecord.findFirst.mockResolvedValue({ id: "or-signed", status: "SIGNED" });
    // First probe: base taken. Second probe (suffixed): free.
    db.user.findUnique
      .mockResolvedValueOnce({ id: "u-existing" })
      .mockResolvedValueOnce(null);
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.email).toBe("nadia.petrova2@fernly.app");
  });
});

// ---------------------------------------------------------------------------
// R8 — funnel analytics (docs/RECRUITMENT_MODULE_PLAN.md §5): pool totals,
// stage load + velocity, and the offer accept rate.
// ---------------------------------------------------------------------------

describe("R8 — getHiringFunnel", () => {
  it("requires hiring:view (MEMBER denied)", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:view"));
    const res = await getHiringFunnel();
    expect(res.ok).toBe(false);
  });

  it("aggregates pool totals, stage load/velocity, and the offer funnel", async () => {
    const day = 86_400_000;
    const now = Date.now();
    db.candidate.findMany.mockResolvedValue([
      { status: "ACTIVE" }, { status: "ACTIVE" },
      { status: "SELECTED" }, { status: "HIRED" },
      { status: "REJECTED" }, { status: "WITHDRAWN" },
    ]);
    db.candidateStage.findMany.mockResolvedValue([
      // Screening: 1 in progress (started 2 days ago), 3 passed (2d, 4d, 6d).
      { stageKey: "screening", label: "Screening", status: "IN_PROGRESS", startedAt: new Date(now - 2 * day), completedAt: null },
      { stageKey: "screening", label: "Screening", status: "PASSED", startedAt: new Date(now - 6 * day), completedAt: new Date(now - 4 * day) },
      { stageKey: "screening", label: "Screening", status: "PASSED", startedAt: new Date(now - 4 * day), completedAt: new Date(now - 2 * day) },
      { stageKey: "screening", label: "Screening", status: "PASSED", startedAt: new Date(now - 8 * day), completedAt: new Date(now - 2 * day) },
      // Interview: 1 in progress, none passed — avg over the live instance.
      { stageKey: "interview_1", label: "Interview 1", status: "IN_PROGRESS", startedAt: new Date(now - 3 * day), completedAt: null },
      // Skipped stages count for neither load nor velocity.
      { stageKey: "offer", label: "Offer", status: "SKIPPED", startedAt: null, completedAt: null },
      { stageKey: "offer", label: "Offer", status: "PENDING", startedAt: null, completedAt: null },
    ]);
    db.offerRecord.findMany.mockResolvedValue([
      { status: "SENT" }, { status: "SIGNED" }, { status: "SIGNED" }, { status: "DECLINED" }, { status: "DRAFT" },
    ]);

    const res = await getHiringFunnel();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.totals).toEqual({
        total: 6, active: 2, selected: 1, hired: 1, rejected: 1, withdrawn: 1,
      });

      const screening = res.data.stages.find((s) => s.stageKey === "screening");
      expect(screening).toMatchObject({ inStage: 1, passed: 3 });
      // Avg: PASSED durations (2, 2, 6) + live (2) = 3.0d.
      expect(screening?.avgDays).toBe(3);

      const interview = res.data.stages.find((s) => s.stageKey === "interview_1");
      expect(interview).toMatchObject({ inStage: 1, passed: 0, avgDays: 3 });

      // Offer funnel: 2 signed / 3 decided = 67%; awaiting 1; draft ignored.
      // F2.10: expired counts lapsed links (none here).
      expect(res.data.offers).toEqual({ total: 5, awaiting: 1, signed: 2, declined: 1, expired: 0, acceptRate: 67 });
    }
  });

  it("accept rate is null until an offer is decided (no NaN)", async () => {
    db.candidate.findMany.mockResolvedValue([]);
    db.candidateStage.findMany.mockResolvedValue([]);
    db.offerRecord.findMany.mockResolvedValue([{ status: "SENT" }, { status: "DRAFT" }]);
    const res = await getHiringFunnel();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.offers.acceptRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F2.10 — joining hardening: the offer approval step (R11/D-20), expiry
// semantics (F-R5), the joining gate (F-R9/E5), payroll-ready joining
// (F-R7), the unified onboarding template (F-R8), and the interview-invite
// email + reschedule cleanup (F-R10/F-R6).
// ---------------------------------------------------------------------------

describe("F2.10 — approveOffer (the manager four-eyes step)", () => {
  const DRAFT_OFFER = () => ({
    ...R6_OFFER, status: "DRAFT" as const, approvedById: "", approvedAt: null,
  });

  it("requires hiring:approve — HR (the composer's role) is refused", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:approve"));
    const res = await approveOffer({ offerId: "or-1" });
    expect(res.ok).toBe(false);
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });

  it("flips DRAFT → APPROVED with approvedById/approvedAt and audits", async () => {
    db.offerRecord.findUnique.mockResolvedValue(DRAFT_OFFER());
    requirePermissionMock.mockResolvedValue(MANAGER_AUTH);
    const res = await approveOffer({ offerId: "or-1" });
    expect(res.ok).toBe(true);
    expect(db.offerRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "or-1" },
        data: expect.objectContaining({ status: "APPROVED", approvedById: "u-mgr" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.offer_approved" }));
  });

  it("refuses the composer approving their own offer (four-eyes)", async () => {
    db.offerRecord.findUnique.mockResolvedValue(DRAFT_OFFER());
    requirePermissionMock.mockResolvedValue(HR_AUTH); // u-hr composed it
    const res = await approveOffer({ offerId: "or-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("cannot approve their own offer");
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });

  it("refuses non-DRAFT offers and non-SELECTED candidates", async () => {
    db.offerRecord.findUnique.mockResolvedValueOnce({ ...R6_OFFER, status: "APPROVED" });
    const approved = await approveOffer({ offerId: "or-1" });
    expect(approved.ok).toBe(false);

    db.offerRecord.findUnique.mockResolvedValueOnce({
      ...DRAFT_OFFER(),
      candidate: { ...R6_OFFER.candidate, status: "ACTIVE" },
    });
    const movedOn = await approveOffer({ offerId: "or-1" });
    expect(movedOn.ok).toBe(false);
    if (!movedOn.ok) expect(movedOn.error).toContain("SELECTED");
  });
});

describe("F2.10 — offer expiry semantics (F-R5)", () => {
  it("editing an APPROVED offer demotes it back to DRAFT (re-approval required)", async () => {
    db.offerRecord.findUnique.mockResolvedValue({ ...R6_OFFER, status: "APPROVED" });
    const res = await updateOfferRecord({
      id: "or-1",
      components: [{ key: "basic", label: "B", kind: "EARNING", mode: "FIXED", amount: 70_000 }],
      benefits: [],
      letterText: "bumped",
    });
    expect(res.ok).toBe(true);
    expect(db.offerRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT", approvedById: "", approvedAt: null }),
      }),
    );
    const auditArg = logAuditMock.mock.calls.find((c) => c[0].action === "hiring.offer_updated")?.[0];
    expect(auditArg?.detail).toContain("demoted it back to DRAFT");
  });

  it("declineOffer now honors the expiry check (symmetric with signOffer)", async () => {
    db.offerRecord.findUnique.mockResolvedValue({
      ...R6_OFFER, status: "SENT", token: "tok-stale",
      tokenExpiresAt: new Date(Date.now() - 1_000),
      candidate: { id: "cand-1", fullName: "Nadia Petrova" },
    });
    const res = await declineOffer({ token: "tok-stale" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("expired");
    expect(db.offerRecord.update).not.toHaveBeenCalled();
  });

  it("getOfferByToken refuses a lapsed EXPIRED token with the honest message", async () => {
    db.offerRecord.findUnique.mockResolvedValue({ ...R6_OFFER, status: "EXPIRED", token: "tok-expired" });
    const res = await getOfferByToken("tok-expired");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("expired");
  });

  it("hiring reads lazily lapse stale SENT links to EXPIRED (F2.4-style materialization)", async () => {
    db.offerRecord.updateMany.mockResolvedValue({ count: 2 });
    db.offerRecord.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
    const res = await getOfferRecords();
    expect(res.ok).toBe(true);
    expect(db.offerRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "SENT", tokenExpiresAt: { lt: expect.any(Date) } }),
        data: { status: "EXPIRED" },
      }),
    );
    // One audit line for the batch (never per-row spam).
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.offers_lapsed" }));
  });

  it("the funnel counts awaiting over LIVE links only — stale links become expired", async () => {
    db.candidate.findMany.mockResolvedValue([]);
    db.candidateStage.findMany.mockResolvedValue([]);
    db.offerRecord.findMany.mockResolvedValue([
      { status: "SENT", tokenExpiresAt: new Date(Date.now() + 86_400_000) },
      { status: "SENT", tokenExpiresAt: new Date(Date.now() - 86_400_000) },
      { status: "EXPIRED", tokenExpiresAt: new Date(Date.now() - 86_400_000) },
      { status: "SIGNED", tokenExpiresAt: null },
    ]);
    const res = await getHiringFunnel();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.offers.awaiting).toBe(1);
      expect(res.data.offers.expired).toBe(2);
    }
  });
});

describe("F2.10 — the joining gate (F-R9/E5)", () => {
  const SIGNED_OFFER = () => ({
    id: "or-signed", status: "SIGNED", signedAt: new Date(), templateLabel: "Designer Band",
    components: JSON.stringify([{ key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68_000 }]),
  });
  const MANDATORY_TYPES = [
    { key: "id_proof", label: "ID Document", isMandatory: true, isActive: true, sortOrder: 10, id: "dt-1", description: "" },
    { key: "bank_details", label: "Bank Details", isMandatory: true, isActive: true, sortOrder: 20, id: "dt-2", description: "" },
  ];

  it("refuses joining while a mandatory document is un-VERIFIED, listing the blockers", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      workspace: { name: "Fernly Workspace", hiringEmailDomain: "fernly.app", defaultDepartment: "ENGINEERING", joiningGateEnabled: true },
    });
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerRecord.findFirst.mockResolvedValue(SIGNED_OFFER());
    db.documentTypeConfig.findMany.mockResolvedValue(MANDATORY_TYPES);
    db.candidateDocument.findMany.mockResolvedValue([
      { docTypeKey: "id_proof", status: "RECEIVED" },
    ]);
    db.backgroundCheck.findMany.mockResolvedValue([
      { vendor: "VerifyRight", status: "IN_REVIEW" },
    ]);
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Joining blocked");
      expect(res.error).toContain("ID Document: received, not yet verified");
      expect(res.error).toContain("Bank Details: not requested yet");
      expect(res.error).toContain("Background check (VerifyRight): in review");
    }
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("allows joining once every mandatory doc is VERIFIED and the BGV is terminal (FLAGGED counts as decided)", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      workspace: { name: "Fernly Workspace", hiringEmailDomain: "fernly.app", defaultDepartment: "ENGINEERING", joiningGateEnabled: true },
    });
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerRecord.findFirst.mockResolvedValue(SIGNED_OFFER());
    db.documentTypeConfig.findMany.mockResolvedValue(MANDATORY_TYPES);
    db.candidateDocument.findMany.mockResolvedValue([
      { docTypeKey: "id_proof", status: "VERIFIED" },
      { docTypeKey: "bank_details", status: "VERIFIED" },
    ]);
    db.backgroundCheck.findMany.mockResolvedValue([{ vendor: "VerifyRight", status: "FLAGGED" }]);
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    expect(db.user.create).toHaveBeenCalled();
  });

  it("the gate is configurable — a disabled gate joins despite outstanding formalities", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      workspace: { name: "Fernly Workspace", hiringEmailDomain: "fernly.app", defaultDepartment: "ENGINEERING", joiningGateEnabled: false },
    });
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerRecord.findFirst.mockResolvedValue(SIGNED_OFFER());
    db.documentTypeConfig.findMany.mockResolvedValue(MANDATORY_TYPES);
    db.candidateDocument.findMany.mockResolvedValue([]);
    db.backgroundCheck.findMany.mockResolvedValue([]);
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
  });

  it("getJoiningFormalities returns the same verdict the gate enforces", async () => {
    getWorkspaceConfigMock.mockResolvedValue({
      workspace: { name: "Fernly Workspace", hiringEmailDomain: "fernly.app", defaultDepartment: "ENGINEERING", joiningGateEnabled: true },
    });
    db.candidate.findUnique.mockResolvedValue(candidateWithStages());
    db.documentTypeConfig.findMany.mockResolvedValue(MANDATORY_TYPES);
    db.candidateDocument.findMany.mockResolvedValue([{ docTypeKey: "id_proof", status: "VERIFIED", requestedAt: new Date(), receivedAt: null, verifiedById: "", verifiedAt: null }]);
    db.backgroundCheck.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
    const res = await getJoiningFormalities("cand-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.gate.enabled).toBe(true);
      expect(res.data.gate.allowed).toBe(false);
      expect(res.data.gate.blockers).toEqual(["Bank Details: not requested yet"]);
    }
  });
});

describe("F2.10 — payroll-ready joining (F-R7)", () => {
  it("maps the offer's components through the catalog (canonical labels, offer amounts) and auto-registers unseen codes", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerRecord.findFirst.mockResolvedValue({
      id: "or-signed", status: "SIGNED", signedAt: new Date(), templateLabel: "Designer Band",
      components: JSON.stringify([
        { key: "basic", label: "Basic (negotiated)", kind: "EARNING", mode: "FIXED", amount: 70_000 },
        { key: "new_code", label: "Relocation", kind: "EARNING", mode: "FIXED", amount: 2_000 },
      ]),
    });
    db.salaryComponent.findMany.mockResolvedValue([
      { code: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED" },
    ]);
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.payrollReady).toBe(true);
    // The unseen code auto-registers (catalog converges on everything in use).
    expect(db.salaryComponent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ code: "new_code", label: "Relocation", defaultAmount: 2_000, sortOrder: 1000 }),
      }),
    );
    // Catalog-known codes canonicalize the label; the AMOUNT stays the offer's.
    const structureArg = db.salaryStructure.create.mock.calls[0][0] as { data: { components: string } };
    const mapped = JSON.parse(structureArg.data.components);
    expect(mapped[0]).toMatchObject({ key: "basic", label: "Basic Salary", amount: 70_000 });
    expect(mapped[1]).toMatchObject({ key: "new_code", label: "Relocation", amount: 2_000 });
  });

  it("a signed offer with NO components joins but reports payrollReady: false (visibly unpaid)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerRecord.findFirst.mockResolvedValue({ id: "or-signed", status: "SIGNED", signedAt: new Date(), components: "[]" });
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.payrollReady).toBe(false);
    expect(db.salaryStructure.create).not.toHaveBeenCalled();
    const auditArg = logAuditMock.mock.calls.find((c) => c[0].action === "hiring.candidate_joined")?.[0];
    expect(auditArg?.detail).toContain("NO salary structure");
  });
});

describe("F2.10 — the unified onboarding template (F-R8)", () => {
  it("markJoined instantiates the checklist from the TEMPLATE TABLE rows (not a code copy)", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerRecord.findFirst.mockResolvedValue({
      id: "or-signed", status: "SIGNED", signedAt: new Date(),
      components: JSON.stringify([{ key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 68_000 }]),
    });
    db.onboardingTemplateTask.findMany.mockResolvedValue([
      { id: "tt-1", kind: "ONBOARDING", title: "Laptop + accounts", dueOffsetDays: 1, assignSelf: false, isActive: true, sortOrder: 10 },
      { id: "tt-2", kind: "ONBOARDING", title: "Read the handbook", dueOffsetDays: 2, assignSelf: true, isActive: true, sortOrder: 20 },
      { id: "tt-3", kind: "SEPARATION", title: "Exit-only task", dueOffsetDays: 3, assignSelf: true, isActive: true, sortOrder: 10 },
      { id: "tt-4", kind: "ONBOARDING", title: "Deactivated task", dueOffsetDays: 4, assignSelf: true, isActive: false, sortOrder: 30 },
    ]);
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    const checklistArg = db.onboardingChecklist.create.mock.calls[0][0] as {
      data: { tasks: { create: { title: string; assigneeId: string | null }[] } };
    };
    // Only the kind's ACTIVE rows, in sortOrder order — self tasks to the hire.
    expect(checklistArg.data.tasks.create.map((t) => t.title)).toEqual(["Laptop + accounts", "Read the handbook"]);
    expect(checklistArg.data.tasks.create[0].assigneeId).toBeNull();
    expect(checklistArg.data.tasks.create[1].assigneeId).toBe("u-new");
    // The instantiated tasks ride the return for the day-one handout.
    if (res.ok) {
      expect(res.data.checklistTasks.map((t) => t.title)).toEqual(["Laptop + accounts", "Read the handbook"]);
    }
  });

  it("manager tasks auto-assign to the hire's manager — the createChecklist discipline markJoined used to drift from", async () => {
    db.candidate.findUnique.mockResolvedValue(candidateWithStages({ status: "SELECTED" }));
    db.offerRecord.findFirst.mockResolvedValue({
      id: "or-signed", status: "SIGNED", signedAt: new Date(),
      components: JSON.stringify([{ key: "basic", label: "Basic", kind: "EARNING", mode: "FIXED", amount: 68_000 }]),
    });
    // The hire's (newly created) account has a manager — the roster lookup
    // inside instantiateChecklist finds managerId and claims the null tasks.
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) => {
      if (where.id === "u-new") return { managerId: "u-mgr" };
      return null; // email probes (nextAvailableHireEmail) find no collision
    });
    const res = await markJoined({ candidateId: "cand-1" });
    expect(res.ok).toBe(true);
    expect(db.onboardingTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { checklistId: "oc-new", assigneeId: null },
        data: { assigneeId: "u-mgr" },
      }),
    );
  });
});

describe("F2.10 — interview invite + reschedule cleanup (F-R10/F-R6)", () => {
  it("scheduling writes the reserved INTERVIEW_INVITE outbox kind to the candidate", async () => {
    db.candidateStage.findUnique.mockResolvedValue(INTERVIEW_STAGE);
    db.candidateStage.findMany.mockResolvedValue([]);
    db.user.findUnique.mockResolvedValue({ name: "Ingrid Solberg" });
    const when = new Date("2026-11-10T09:30:00.000Z").toISOString();
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: when, interviewerId: "u-mgr" });
    expect(res.ok).toBe(true);
    const outboxArg = db.mailOutbox.create.mock.calls[0][0] as { data: { kind: string; toAddress: string; subject: string } };
    expect(outboxArg.data.kind).toBe("INTERVIEW_INVITE");
    expect(outboxArg.data.toAddress).toBe("nadia@example.com");
    expect(outboxArg.data.subject).toContain("Interview invitation");
  });

  it("a reschedule deletes the previous event + its linked reminder, then creates the fresh pair", async () => {
    db.candidateStage.findUnique.mockResolvedValue({
      ...INTERVIEW_STAGE, scheduledAt: new Date("2026-11-09T09:00:00Z"), eventId: "ev-old",
    });
    db.candidateStage.findMany.mockResolvedValue([]);
    db.user.findUnique.mockResolvedValue({ name: "Ingrid Solberg" });
    const when = new Date("2026-11-12T14:00:00.000Z").toISOString();
    const res = await scheduleInterview({ stageId: "st-2", scheduledAt: when, interviewerId: "u-mgr" });
    expect(res.ok).toBe(true);
    // The stale pair goes via the eventId link (F-R6 — no more orphans).
    expect(db.reminder.deleteMany).toHaveBeenCalledWith({ where: { eventId: "ev-old" } });
    expect(db.calendarEvent.delete).toHaveBeenCalledWith({ where: { id: "ev-old" } });
    // The new reminder carries the NEW event's id (the next reschedule's link).
    expect(db.reminder.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventId: "ev-1" }) }),
    );
    expect(db.candidateStage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventId: "ev-1" }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "hiring.interview_rescheduled" }));
  });
});

describe("F2.10 — getOffersAwaitingApproval (the approver's queue)", () => {
  it("requires hiring:approve — HR (the composer) cannot read the queue", async () => {
    requirePermissionMock.mockImplementation(denyFor("hiring:approve"));
    const res = await getOffersAwaitingApproval();
    expect(res.ok).toBe(false);
  });

  it("lists DRAFT offers for SELECTED candidates with CTC + composer, never tokens or letters", async () => {
    db.offerRecord.findMany.mockResolvedValue([
      {
        id: "or-d1", candidateId: "cand-1", templateLabel: "Designer Band", notes: "band match",
        components: R6_OFFER.components, createdById: "u-hr", createdAt: new Date(),
        candidate: { id: "cand-1", fullName: "Nadia Petrova", position: "Product Designer", status: "SELECTED" },
      },
      {
        id: "or-d2", candidateId: "cand-9", templateLabel: "Stale", notes: "",
        components: "[]", createdById: "u-hr", createdAt: new Date(),
        candidate: { id: "cand-9", fullName: "Moved On", position: "", status: "REJECTED" },
      },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u-hr", name: "Remy" }]);
    const res = await getOffersAwaitingApproval();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        id: "or-d1", candidateName: "Nadia Petrova", createdBy: "Remy",
        ctc: 70_040, notes: "band match",
      });
      expect(Object.keys(res.data[0])).not.toContain("token");
    }
  });
});
