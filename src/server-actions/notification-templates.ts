"use server";

// ---------------------------------------------------------------------------
// P24 (PL-01) — the notification template master, actions half.
//
// updateNotificationTemplate: upsert one event's override row (role:manage),
// after the structural zod pass AND the semantic placeholder audit — every
// {{name}} must exist in the event's registry vocabulary, so a typo can
// never silently render empty in production mail. resetNotificationTemplate
// deletes the row (idempotent): the event falls back to the built-in
// default byte-identically. Both bump the config cache (the writers read
// templates through the same 10s-cached getWorkspaceConfig the knobs ride)
// and audit the change.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { bumpConfigCache } from "@/lib/config-loader";
import {
  getNotificationTemplateEvent,
  unknownPlaceholdersByField,
  NOTIFICATION_TEMPLATE_EVENTS,
} from "@/lib/notification-template";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import {
  notificationTemplateSchema,
  notificationTemplateResetSchema,
  parseOrThrow,
} from "@/lib/validation";

/** The registry keys, for the unknown-event refusal message. */
const NOTIFICATION_TEMPLATE_EVENT_KEYS = NOTIFICATION_TEMPLATE_EVENTS.map((e) => e.eventKey);

export async function updateNotificationTemplate(input: {
  eventKey: string;
  subject: string;
  body: string;
  title: string;
  message: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    const data = parseOrThrow(notificationTemplateSchema, input);

    // The event must be one the product defines — the registry is the
    // vocabulary, rows only ever override registry events.
    const def = getNotificationTemplateEvent(data.eventKey);
    if (!def) {
      throw new AuthorizationError(
        `Unknown notification event “${data.eventKey}”. Known events: ${NOTIFICATION_TEMPLATE_EVENT_KEYS.join(", ")}.`,
      );
    }

    // Semantic validation — every placeholder must be a registry variable
    // of this event. The refusal names the field, the placeholder(s) and
    // the known names (the QA-18 friendly-error convention).
    const audit = unknownPlaceholdersByField(data.eventKey, {
      subject: data.subject,
      body: data.body,
      title: data.title,
      message: data.message,
    });
    const offenders = audit.filter((f) => f.unknown.length > 0);
    if (offenders.length) {
      const known = def.variables.map((v) => `{{${v.name}}}`).join(", ");
      const parts = offenders.map((f) => `${f.field}: ${f.unknown.map((n) => `{{${n}}}`).join(", ")}`);
      throw new AuthorizationError(
        `Unknown placeholder(s) — ${parts.join("; ")}. Variables available for ${def.label}: ${known}.`,
      );
    }

    await db.notificationTemplate.upsert({
      where: { eventKey: data.eventKey },
      create: {
        eventKey: data.eventKey,
        subjectTemplate: data.subject,
        bodyTemplate: data.body,
        titleTemplate: data.title,
        messageTemplate: data.message,
      },
      update: {
        subjectTemplate: data.subject,
        bodyTemplate: data.body,
        titleTemplate: data.title,
        messageTemplate: data.message,
      },
    });
    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "notification.template_updated",
      entityType: "NOTIFICATION_TEMPLATE",
      entityId: data.eventKey,
      entityLabel: def.label,
      detail: `Customized the “${def.label}” notification template`,
    });
    revalidatePath("/");
  });
}

export async function resetNotificationTemplate(input: {
  eventKey: string;
}): Promise<ActionResult<void>> {
  return toResult(async () => {
    const auth = await requirePermission("role:manage");
    const data = parseOrThrow(notificationTemplateResetSchema, input);

    const def = getNotificationTemplateEvent(data.eventKey);
    if (!def) {
      throw new AuthorizationError(`Unknown notification event “${data.eventKey}”.`);
    }

    // deleteMany is idempotent: resetting an event that was never
    // customized (no row) still succeeds — the default is already in force.
    await db.notificationTemplate.deleteMany({ where: { eventKey: data.eventKey } });
    bumpConfigCache();
    await logAudit({
      actor: auth,
      action: "notification.template_reset",
      entityType: "NOTIFICATION_TEMPLATE",
      entityId: data.eventKey,
      entityLabel: def.label,
      detail: `Reset the “${def.label}” notification template to the system default`,
    });
    revalidatePath("/");
  });
}
