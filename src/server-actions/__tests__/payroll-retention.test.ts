import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P6 (PR-20/PR-23, PR-T01) — retention-bonus action tests.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = [
    "user", "payrollRun", "payAdjustment", "mailOutbox", "notification", "auditLog",
  ];
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
      typeof fn === "function" ? fn(obj) : Promise.resolve(fn),
  );
  return obj;
});

vi.mock("@/lib/infra/db", () => ({ db }));

const requirePermissionMock = vi.fn();
vi.mock("@/server-actions/auth-guard", () => ({
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
  AuthorizationError: class AuthorizationError extends Error {
    readonly digest = "AuthorizationError";
    constructor(m: string) { super(m); this.name = "AuthorizationError"; }
  },
}));

const queueOutboxMailMock = vi.fn();
const deliverOutboxMailMock = vi.fn();
const logAuditMock = vi.fn();
vi.mock("@/server-actions/shared", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
  queueOutboxMail: (...a: unknown[]) => queueOutboxMailMock(...(a as [])),
  deliverOutboxMail: (...a: unknown[]) => deliverOutboxMailMock(...(a as [])),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createRetentionBonus } from "../payroll-retention";

const HR_AUTH = { userId: "u-hr", role: "HR" as const, name: "Remy", email: "remy@x.co" };

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(HR_AUTH);
  db.user.findUnique.mockResolvedValue({ id: "u-diego", name: "Diego Fernández", email: "diego@fernly.app" });
  db.payrollRun.findUnique.mockResolvedValue(null);
  db.payAdjustment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `adj-${String(data.period)}`, ...data }));
  db.mailOutbox.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "mail-x", ...data }));
  db.notification.create.mockResolvedValue({});
  queueOutboxMailMock.mockResolvedValue({ id: "mail-x" });
  deliverOutboxMailMock.mockResolvedValue({ status: "SENT", providerMessageId: "", error: "" });
});

describe("P6 — createRetentionBonus", () => {
  it("writes one ONE_SHOT installment row per month (the last absorbs rounding) and notifies", async () => {
    const res = await createRetentionBonus({ userId: "u-diego", totalAmount: 1_000, installments: 3, firstPeriod: "2026-12", note: "Key contributor retention" });
    expect(res.ok).toBe(true);
    expect(db.payAdjustment.create).toHaveBeenCalledTimes(3);
    const periods = db.payAdjustment.create.mock.calls.map((c: Array<{ data: { period: string } }>) => c[0].data.period);
    expect(periods).toEqual(["2026-12", "2027-01", "2027-02"]);
    const amounts = db.payAdjustment.create.mock.calls.map((c: Array<{ data: { amount: number } }>) => c[0].data.amount);
    expect(amounts).toEqual([333.33, 333.33, 333.34]);
    const first = db.payAdjustment.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(first.data).toMatchObject({
      userId: "u-diego", sourceType: "RETENTION_BONUS", side: "EARNING",
      recurrence: "ONE_SHOT", calcMode: "FIXED", label: "Retention bonus — Diego Fernández",
    });
    // PR-T01 — the email rides the outbox: queued in the transaction (tx
    // === db in the mock), delivered outside it.
    expect(queueOutboxMailMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: "RETENTION_BONUS",
        toAddress: "diego@fernly.app",
        subject: "Retention bonus",
      }),
    );
    expect(deliverOutboxMailMock).toHaveBeenCalledWith("mail-x", expect.objectContaining({ toAddress: "diego@fernly.app" }));
    // The in-app notification (best-effort).
    expect(db.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recipientUserId: "u-diego", title: "Retention bonus approved" }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.retention_bonus_created" }));
  });

  it("a single installment is one row for the whole total", async () => {
    const res = await createRetentionBonus({ userId: "u-diego", totalAmount: 750, installments: 1, firstPeriod: "2026-12" });
    expect(res.ok).toBe(true);
    expect(db.payAdjustment.create).toHaveBeenCalledTimes(1);
    const only = db.payAdjustment.create.mock.calls[0][0] as { data: { amount: number } };
    expect(only.data.amount).toBe(750);
  });

  it("refuses a LOCKED first period", async () => {
    db.payrollRun.findUnique.mockResolvedValue({ status: "LOCKED" });
    const res = await createRetentionBonus({ userId: "u-diego", totalAmount: 500, installments: 2, firstPeriod: "2026-11" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already locked");
  });

  it("refuses out-of-range installments (the schema gate, before the kernel)", async () => {
    const res = await createRetentionBonus({ userId: "u-diego", totalAmount: 500, installments: 13, firstPeriod: "2026-12" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("<=12");
  });

  it("a delivery failure never breaks the business write (delivered outside the tx)", async () => {
    deliverOutboxMailMock.mockRejectedValue(new Error("provider down"));
    const res = await createRetentionBonus({ userId: "u-diego", totalAmount: 500, installments: 2, firstPeriod: "2026-12" });
    expect(res.ok).toBe(true);
  });
});
