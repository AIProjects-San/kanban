import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P1-20 — audit log retention tests.
// Deep-dive review F-09 updates covered here:
//   • prune/getInfo require role:manage (not audit:view — MANAGERs hold that)
//   • retention reads Workspace.auditRetentionDays (not auditLogLimit)
//   • batching goes through $executeRaw with a real LIMIT

const db = vi.hoisted(() => ({
  workspace: { findUnique: vi.fn() },
  auditLog: { deleteMany: vi.fn() },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}));

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

import { pruneAuditLogs, getAuditRetentionInfo } from "../audit-retention";
import { DEFAULT_AUDIT_RETENTION_DAYS, MIN_AUDIT_RETENTION_DAYS } from "@/lib/audit-retention-config";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN", name: "Admin", email: "a@x" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  db.workspace.findUnique.mockResolvedValue({ auditRetentionDays: 180 });
  db.$executeRaw.mockResolvedValue(0);
  db.$queryRaw.mockResolvedValue([{ estimate: 12345 }]);
});

describe("L-P1-20 pruneAuditLogs", () => {
  it("deletes rows older than the retention window and writes a meta-audit row", async () => {
    db.$executeRaw.mockResolvedValue(42);
    const res = await pruneAuditLogs();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.deletedCount).toBe(42);
    expect(res.data.retentionDays).toBe(180);
    const cutoff = new Date(res.data.cutoff);
    expect(cutoff.getTime()).toBeLessThan(Date.now());
    expect(Date.now() - cutoff.getTime()).toBeGreaterThan(179 * 24 * 60 * 60 * 1000);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: ADMIN_AUTH,
        action: "audit.pruned",
        detail: expect.stringMatching(/Pruned 42 audit rows/),
      }),
    );
  });

  it("uses the default 180-day retention when workspace config is missing", async () => {
    db.workspace.findUnique.mockResolvedValue(null);
    db.$executeRaw.mockResolvedValue(0);
    const res = await pruneAuditLogs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.retentionDays).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });

  it("clamps retention to the 30-day minimum (safety floor)", async () => {
    db.workspace.findUnique.mockResolvedValue({ auditRetentionDays: 1 });
    db.$executeRaw.mockResolvedValue(0);
    const res = await pruneAuditLogs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.retentionDays).toBe(MIN_AUDIT_RETENTION_DAYS);
  });

  it("clamps retention to the default when the value is invalid (0, negative)", async () => {
    db.workspace.findUnique.mockResolvedValue({ auditRetentionDays: 0 });
    db.$executeRaw.mockResolvedValue(0);
    const res = await pruneAuditLogs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.retentionDays).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });

  it("no longer conflates the UI display limit with retention (F-09)", async () => {
    // auditLogLimit is how many rows the audit PAGE shows. Setting it to 90
    // must NOT change the retention window.
    db.workspace.findUnique.mockResolvedValue({ auditLogLimit: 90, auditRetentionDays: 180 });
    db.$executeRaw.mockResolvedValue(0);
    const res = await pruneAuditLogs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.retentionDays).toBe(180);
  });

  it("batches deletes via $executeRaw with a LIMIT and loops until a short batch", async () => {
    db.$executeRaw
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(5_000);
    const res = await pruneAuditLogs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.deletedCount).toBe(25_000);
    expect(db.$executeRaw).toHaveBeenCalledTimes(3);
    expect(db.auditLog.deleteMany).not.toHaveBeenCalled();
  });

  it("stops after 1M rows to avoid a single prune running for hours", async () => {
    db.$executeRaw.mockResolvedValue(10_000);
    const res = await pruneAuditLogs();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.deletedCount).toBe(1_010_000);
    expect(db.$executeRaw.mock.calls.length).toBeLessThan(150);
  });

  it("requires role:manage permission — audit:view holders (MANAGER) cannot purge (F-09)", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await pruneAuditLogs();
    expect(res.ok).toBe(false);
    // And the permission it demanded was role:manage, not audit:view.
    expect(requirePermissionMock).toHaveBeenCalledWith("role:manage");
  });

  it("is idempotent — running twice deletes 0 rows the second time", async () => {
    db.$executeRaw
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(0);
    const first = await pruneAuditLogs();
    const second = await pruneAuditLogs();
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.data.deletedCount).toBe(100);
    expect(second.data.deletedCount).toBe(0);
  });
});

describe("L-P1-20 getAuditRetentionInfo", () => {
  it("returns the retention config + a row-count estimate", async () => {
    db.workspace.findUnique.mockResolvedValue({ auditRetentionDays: 90 });
    db.$queryRaw.mockResolvedValue([{ estimate: 50000 }]);
    const res = await getAuditRetentionInfo();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.retentionDays).toBe(90);
    expect(res.data.estimatedRowCount).toBe(50000);
    expect(res.data.cutoff).toBeTruthy();
  });

  it("requires role:manage permission (F-09)", async () => {
    requirePermissionMock.mockRejectedValue(new Error("no perm"));
    const res = await getAuditRetentionInfo();
    expect(res.ok).toBe(false);
    expect(requirePermissionMock).toHaveBeenCalledWith("role:manage");
  });

  it("returns 0 estimate when the table doesn't exist yet (pg_class miss)", async () => {
    db.$queryRaw.mockResolvedValue([]);
    const res = await getAuditRetentionInfo();
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.estimatedRowCount).toBe(0);
  });
});
