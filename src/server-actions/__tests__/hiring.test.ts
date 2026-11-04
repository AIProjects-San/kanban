import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Recruitment R1 — hiring action tests (docs/RECRUITMENT_MODULE_PLAN.md §5):
// template snapshot at creation, advance/skip transitions, decisions with
// reasons, the hired-candidate delete guard, and template-config gating.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["hiringStageConfig", "candidate", "candidateStage", "user", "auditLog", "notification"];
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
} from "../hiring";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MANAGER_AUTH = { userId: "u-mgr", role: "MANAGER" as const, name: "Ingrid", email: "ingrid@x.co" };

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
      { id: "st-1", candidateId: "cand-1", stageKey: "screening", label: "Application Screening", stageType: "SCREENING", ownerUserId: null, status: "PASSED", scheduledAt: null, remarks: "", rating: null, sortOrder: 10, startedAt: new Date(), completedAt: new Date() },
      { id: "st-2", candidateId: "cand-1", stageKey: "interview_1", label: "Interview 1 — Technical", stageType: "INTERVIEW", ownerUserId: "u-mgr", status: "IN_PROGRESS", scheduledAt: null, remarks: "", rating: null, sortOrder: 20, startedAt: new Date(), completedAt: null },
      { id: "st-3", candidateId: "cand-1", stageKey: "offer", label: "Offer & Signature", stageType: "OFFER", ownerUserId: null, status: "PENDING", scheduledAt: null, remarks: "", rating: null, sortOrder: 70, startedAt: null, completedAt: null },
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
});

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
  it("rejects without a reason (reason feeds the R3 rejection email)", async () => {
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
