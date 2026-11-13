import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P36 (EM-21) — employee identification documents: the action layer
// (request / submit / verify / reject + the reads and the scope guard).
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["employeeDocument", "documentTypeConfig", "user", "auditLog"];
  const methods = [
    "findMany", "findUnique", "findFirst", "create", "createMany", "update",
    "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
  ];
  const obj: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  for (const m of models) {
    obj[m] = {};
    for (const meth of methods) obj[m][meth] = vi.fn();
  }
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

const requirePermissionMock = vi.fn();
const checkPermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  checkPermission: (...a: unknown[]) => checkPermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  getEmployeeDocTypes,
  getEmployeeDocuments,
  requestEmployeeDocument,
  submitEmployeeDocument,
  verifyEmployeeDocument,
  rejectEmployeeDocument,
} from "../hr-employee-documents";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };
const MEMBER_AUTH = { userId: "u-diego", role: "MEMBER" as const, name: "Diego", email: "diego@x.co" };

const DOC_TYPE = { id: "dt-1", key: "passport", label: "Passport", description: "", isMandatory: true, scope: "EMPLOYEE", sortOrder: 10, isActive: true };
const CANDIDATE_TYPE = { ...DOC_TYPE, key: "right_to_work", label: "Right to Work", scope: "CANDIDATE" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
  checkPermissionMock.mockResolvedValue(false);
  db.user.findUnique.mockResolvedValue({ id: "u-diego", name: "Diego Morales", deletedAt: null });
  db.user.findMany.mockResolvedValue([{ id: "u-diego", name: "Diego Morales" }, { id: "u-hr", name: "Remy Laurent" }]);
  db.documentTypeConfig.findUnique.mockResolvedValue(DOC_TYPE);
  db.documentTypeConfig.findMany.mockResolvedValue([DOC_TYPE]);
  db.employeeDocument.findUnique.mockResolvedValue(null);
  db.employeeDocument.findMany.mockResolvedValue([]);
  db.employeeDocument.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ed-new", ...data }));
  db.employeeDocument.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ed-1", ...data }));
});

describe("reads", () => {
  it("a member reading without a userId gets their own rows (self mode)", async () => {
    const res = await getEmployeeDocuments({});
    expect(res.ok).toBe(true);
    expect(db.employeeDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-diego" } }),
    );
    if (res.ok) expect(res.data.canManage).toBe(false);
  });

  it("a member cannot read another employee's documents (self-service isolation)", async () => {
    const res = await getEmployeeDocuments({ userId: "u-hana" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/your own/i);
  });

  it("an hr:view holder reads any employee + the EMPLOYEE-scope type master", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    checkPermissionMock.mockResolvedValue(true);
    const res = await getEmployeeDocuments({ userId: "u-diego" });
    expect(res.ok).toBe(true);
    expect(db.documentTypeConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: "EMPLOYEE", isActive: true } }),
    );
    if (res.ok) expect(res.data.canManage).toBe(true);
  });

  it("getEmployeeDocTypes returns only the EMPLOYEE scope (the identification master)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    await getEmployeeDocTypes();
    expect(db.documentTypeConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: "EMPLOYEE" } }),
    );
  });
});

describe("requestEmployeeDocument (hr:admin)", () => {
  it("requests a type from an employee — idempotent create with the label snapshot", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    const res = await requestEmployeeDocument({ userId: "u-diego", docTypeKey: "passport" });
    expect(res.ok).toBe(true);
    expect(db.employeeDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u-diego", docTypeKey: "passport", label: "Passport", status: "REQUESTED",
        }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee_document_requested" }),
    );
  });

  it("refuses a CANDIDATE-scope type (identification types are EMPLOYEE scope)", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.documentTypeConfig.findUnique.mockResolvedValue(CANDIDATE_TYPE);
    const res = await requestEmployeeDocument({ userId: "u-diego", docTypeKey: "right_to_work" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/candidates, not employee/i);
  });

  it("a re-request after REJECTION resets the row; a VERIFIED row refuses", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.employeeDocument.findUnique.mockResolvedValue({ id: "ed-1", status: "REJECTED" });
    const reset = await requestEmployeeDocument({ userId: "u-diego", docTypeKey: "passport" });
    expect(reset.ok).toBe(true);
    expect(db.employeeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REQUESTED", fileRef: "" }) }),
    );

    db.employeeDocument.findUnique.mockResolvedValue({ id: "ed-2", status: "VERIFIED" });
    const refused = await requestEmployeeDocument({ userId: "u-diego", docTypeKey: "passport" });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toMatch(/history is not reopened/i);
  });
});

describe("submitEmployeeDocument (the member themself or HR)", () => {
  it("the OWNER member submits their REQUESTED row with a file reference", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.employeeDocument.findUnique.mockResolvedValue({ id: "ed-1", userId: "u-diego", label: "Passport", status: "REQUESTED" });
    const res = await submitEmployeeDocument({ documentId: "ed-1", fileRef: "passport-scan.pdf" });
    expect(res.ok).toBe(true);
    expect(db.employeeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RECEIVED", fileRef: "passport-scan.pdf" }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee_document_submitted" }),
    );
  });

  it("a different member cannot submit someone else's row", async () => {
    requirePermissionMock.mockResolvedValue({ ...MEMBER_AUTH, userId: "u-stranger" });
    db.employeeDocument.findUnique.mockResolvedValue({ id: "ed-1", userId: "u-diego", status: "REQUESTED" });
    const res = await submitEmployeeDocument({ documentId: "ed-1", fileRef: "x" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/themself or HR/i);
  });

  it("a VERIFIED row cannot be re-submitted (history)", async () => {
    requirePermissionMock.mockResolvedValue(MEMBER_AUTH);
    db.employeeDocument.findUnique.mockResolvedValue({ id: "ed-1", userId: "u-diego", status: "VERIFIED" });
    const res = await submitEmployeeDocument({ documentId: "ed-1", fileRef: "x" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already VERIFIED/i);
  });
});

describe("verify / reject (hr:admin)", () => {
  it("verifies a RECEIVED row with the verifier stamped", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.employeeDocument.findUnique.mockResolvedValue({ id: "ed-1", userId: "u-diego", label: "Passport", status: "RECEIVED" });
    const res = await verifyEmployeeDocument({ documentId: "ed-1" });
    expect(res.ok).toBe(true);
    expect(db.employeeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "VERIFIED", verifiedById: "u-hr" }) }),
    );
  });

  it("rejection requires a note and only a RECEIVED row is decisionable", async () => {
    requirePermissionMock.mockResolvedValue(HR_AUTH);
    db.employeeDocument.findUnique.mockResolvedValue({ id: "ed-1", userId: "u-diego", label: "Passport", status: "RECEIVED" });
    const noNote = await rejectEmployeeDocument({ documentId: "ed-1", remarks: "" });
    expect(noNote.ok).toBe(false); // zod: the note is required

    db.employeeDocument.findUnique.mockResolvedValue({ id: "ed-1", userId: "u-diego", status: "REQUESTED" });
    const wrongState = await rejectEmployeeDocument({ documentId: "ed-1", remarks: "blurry scan" });
    expect(wrongState.ok).toBe(false);
    expect(wrongState.ok === false && wrongState.error).toMatch(/RECEIVED/i);
  });
});
