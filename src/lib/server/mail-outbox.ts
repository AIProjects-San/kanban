// SERVER-ONLY audited mail outbox.
//
// Lives in lib so the reminder cron jobs and the leave/encashment auto-drafts
// can queue + deliver mail without importing the action layer.
//
// Delivery discipline: the QUEUED row is written FIRST (the audit copy
// exists even when the provider is down), delivery is attempted best-effort,
// then the row resolves to SENT / SKIPPED / FAILED. Delivery never throws —
// a provider outage must not fail the business action that triggered it.

import { db } from "@/lib/db";
import { createMailer } from "@/lib/mailer";
import type { Prisma } from "@prisma/client";

export interface OutboxMailInput {
  kind: string;
  candidateId?: string | null;
  toAddress: string;
  subject: string;
  text: string;
  sentById: string;
}

export type OutboxMailStatus = {
  status: "SENT" | "SKIPPED" | "FAILED";
  providerMessageId: string;
  error: string;
};

/** Queue + deliver in one call (the common case for action-triggered mail). */
export async function sendOutboxMail(input: OutboxMailInput & { html: string }): Promise<OutboxMailStatus> {
  const row = await queueOutboxMail(db, input);
  return deliverOutboxMail(row.id, input);
}

/** The queue half: creates the QUEUED outbox row on the GIVEN client (db or
 *  a transaction's tx), so a business write and its outbox row land
 *  atomically. Returns the created row. */
export async function queueOutboxMail(
  tx: Pick<Prisma.TransactionClient, "mailOutbox">,
  input: OutboxMailInput,
) {
  return tx.mailOutbox.create({
    data: {
      kind: input.kind,
      candidateId: input.candidateId ?? null,
      toAddress: input.toAddress,
      subject: input.subject,
      body: input.text,
      status: "QUEUED",
      sentById: input.sentById,
    },
  });
}

/** The delivery half: attempts the provider send best-effort and resolves
 *  the row to SENT / SKIPPED / FAILED. NEVER called inside a transaction
 *  (network I/O); never throws. */
export async function deliverOutboxMail(
  rowId: string,
  input: { toAddress: string; subject: string; html: string; text: string },
): Promise<OutboxMailStatus> {
  let status: "SENT" | "SKIPPED" | "FAILED" = "SKIPPED";
  let providerMessageId = "";
  let error = "";
  try {
    const result = await createMailer().sendMail({
      to: input.toAddress,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (result.delivered) {
      status = "SENT";
      providerMessageId = result.messageId ?? "";
    }
  } catch (err) {
    status = "FAILED";
    error = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
  }
  await db.mailOutbox.update({
    where: { id: rowId },
    data: { status, providerMessageId, error, sentAt: new Date() },
  });
  return { status, providerMessageId, error };
}
