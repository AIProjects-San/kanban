import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P24 (PL-01) — the notification template master, action tests: RBAC
// (role:manage), the semantic placeholder audit (friendly refusal naming
// the offender), the unknown-event refusal, the upsert/deleteMany write
// shapes, and the cache-bump + audit discipline every config mutation
// carries. Same mock topology as payroll-components.test.ts.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const models = ["notificationTemplate", "auditLog"];
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

const bumpConfigCacheMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/config-loader", () => ({
  bumpConfigCache: (...a: unknown[]) => bumpConfigCacheMock(...a),
}));

import {
  updateNotificationTemplate,
  resetNotificationTemplate,
} from "../notification-templates";
import { NOTIFICATION_TEMPLATE_EVENTS } from "@/lib/email/notification-template";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const, name: "Mira", email: "mira@x.co" };

function denyFor(perm: string) {
  return async (p: string) => {
    if (p === perm) {
      throw new (class extends Error { digest = "AuthorizationError"; })("denied");
    }
    return ADMIN_AUTH;
  };
}

const VALID_PENDING_INPUT = {
  eventKey: "LEAVE_PENDING",
  subject: "Ping: {{typeName}} request from {{requesterName}}",
  body: "{{requesterName}} asked for {{days}} of {{typeName}} ({{startDate}} → {{endDate}}).",
  title: "{{typeName}} request waiting",
  message: "{{requesterName}} wants {{daysCount}} day(s) — {{startDate}} to {{endDate}}.",
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePermissionMock.mockResolvedValue(ADMIN_AUTH);
  db.notificationTemplate.upsert.mockResolvedValue({ id: "nt-1", eventKey: "LEAVE_PENDING" });
  db.notificationTemplate.deleteMany.mockResolvedValue({ count: 1 });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("P24 — RBAC (role:manage only)", () => {
  it("MANAGER is denied on both actions", async () => {
    requirePermissionMock.mockImplementation(denyFor("role:manage"));
    const save = await updateNotificationTemplate(VALID_PENDING_INPUT);
    expect(save.ok).toBe(false);
    const reset = await resetNotificationTemplate({ eventKey: "LEAVE_PENDING" });
    expect(reset.ok).toBe(false);
    expect(db.notificationTemplate.upsert).not.toHaveBeenCalled();
    expect(db.notificationTemplate.deleteMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateNotificationTemplate
// ---------------------------------------------------------------------------

describe("P24 — updateNotificationTemplate", () => {
  it("upserts the override row with the validated payload, bumps the cache and audits", async () => {
    const res = await updateNotificationTemplate(VALID_PENDING_INPUT);
    expect(res.ok).toBe(true);
    expect(db.notificationTemplate.upsert).toHaveBeenCalledTimes(1);
    expect(db.notificationTemplate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventKey: "LEAVE_PENDING" },
        create: expect.objectContaining({
          eventKey: "LEAVE_PENDING",
          subjectTemplate: VALID_PENDING_INPUT.subject,
          bodyTemplate: VALID_PENDING_INPUT.body,
          titleTemplate: VALID_PENDING_INPUT.title,
          messageTemplate: VALID_PENDING_INPUT.message,
        }),
        update: expect.objectContaining({
          subjectTemplate: VALID_PENDING_INPUT.subject,
          messageTemplate: VALID_PENDING_INPUT.message,
        }),
      }),
    );
    expect(bumpConfigCacheMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification.template_updated",
        entityType: "NOTIFICATION_TEMPLATE",
        entityId: "LEAVE_PENDING",
      }),
    );
  });

  it("refuses an unknown placeholder, naming the field, the name and the vocabulary — and writes nothing", async () => {
    const res = await updateNotificationTemplate({
      ...VALID_PENDING_INPUT,
      message: "{{requesterNam}} asked for {{days}}.",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/message/);
      expect(res.error).toMatch(/\{\{requesterNam\}\}/);
      // The refusal teaches the vocabulary (QA-18).
      expect(res.error).toMatch(/\{\{requesterName\}\}/);
    }
    expect(db.notificationTemplate.upsert).not.toHaveBeenCalled();
    expect(bumpConfigCacheMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown placeholder in ANY of the four fields", async () => {
    for (const field of ["subject", "body", "title", "message"] as const) {
      vi.clearAllMocks();
      const res = await updateNotificationTemplate({
        ...VALID_PENDING_INPUT,
        [field]: "Oops {{typo}}",
      });
      expect(res.ok, `field ${field}`).toBe(false);
      expect(db.notificationTemplate.upsert).not.toHaveBeenCalled();
    }
  });

  it("refuses an event key outside the registry (the vocabulary is code)", async () => {
    const res = await updateNotificationTemplate({ ...VALID_PENDING_INPUT, eventKey: "PAYSLIP_SPAM" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Unknown notification event/);
    expect(db.notificationTemplate.upsert).not.toHaveBeenCalled();
  });

  it("refuses an empty subject at the schema gate", async () => {
    const res = await updateNotificationTemplate({ ...VALID_PENDING_INPUT, subject: "   " });
    expect(res.ok).toBe(false);
    expect(db.notificationTemplate.upsert).not.toHaveBeenCalled();
  });

  it("refuses unknown payload keys (strict schema)", async () => {
    const res = await updateNotificationTemplate({ ...VALID_PENDING_INPUT, extra: "x" } as unknown as typeof VALID_PENDING_INPUT);
    expect(res.ok).toBe(false);
    expect(db.notificationTemplate.upsert).not.toHaveBeenCalled();
  });

  it("accepts every registry event (the editor iterates them)", async () => {
    for (const def of NOTIFICATION_TEMPLATE_EVENTS) {
      const res = await updateNotificationTemplate({
        eventKey: def.eventKey,
        subject: def.defaults.subject,
        body: def.defaults.body,
        title: def.defaults.title,
        message: def.defaults.message,
      });
      expect(res.ok, def.eventKey).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resetNotificationTemplate
// ---------------------------------------------------------------------------

describe("P24 — resetNotificationTemplate", () => {
  it("deletes the override row (idempotent), bumps the cache and audits the reset", async () => {
    const res = await resetNotificationTemplate({ eventKey: "LEAVE_PENDING" });
    expect(res.ok).toBe(true);
    expect(db.notificationTemplate.deleteMany).toHaveBeenCalledWith({
      where: { eventKey: "LEAVE_PENDING" },
    });
    expect(bumpConfigCacheMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification.template_reset",
        entityType: "NOTIFICATION_TEMPLATE",
        entityId: "LEAVE_PENDING",
      }),
    );
  });

  it("resetting an uncustomized event still succeeds (deleteMany is idempotent)", async () => {
    db.notificationTemplate.deleteMany.mockResolvedValue({ count: 0 });
    const res = await resetNotificationTemplate({ eventKey: "LEAVE_DECIDED" });
    expect(res.ok).toBe(true);
  });

  it("refuses an unknown event key", async () => {
    const res = await resetNotificationTemplate({ eventKey: "NOT_AN_EVENT" });
    expect(res.ok).toBe(false);
    expect(db.notificationTemplate.deleteMany).not.toHaveBeenCalled();
  });
});
