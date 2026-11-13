"use server";

// ---------------------------------------------------------------------------
// R5 + R6 — the offer lifecycle (split from hiring.ts). Templates are
// hiring:config; offers are hiring:manage and only for SELECTED candidates
// (the hire decision gates the offer, not the other way round). Components
// are stored as JSON and computed by lib/hiring/offer-math.ts.
//
// R6 e-sign flow: createOfferRecord (HR composes, DRAFT) → approveOffer (a
// MANAGER — the four-eyes step, hiring:approve, distinct from the composer)
// → sendOffer (hiring:manage) mints a single-use token + emails the signing
// link via the outbox; the candidate opens the PUBLIC /offer/[token] page
// (no session) and either signs (typed full name → immutable snapshot with
// IP + timestamp) or declines; the link's expiry is honored on BOTH paths
// and lapsed reads flip stale SENT rows to EXPIRED (F-R5).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import crypto from "node:crypto";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import type { OfferTemplateT, OfferRecordT } from "@/lib/types";
import {
  saveOfferTemplateSchema,
  deleteOfferTemplateSchema,
  createOfferRecordSchema,
  updateOfferRecordSchema,
  approveOfferSchema,
  parseOrThrow,
} from "@/lib/validation";
import { logAudit, queueOutboxMail, deliverOutboxMail } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/shared/action-result";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import { computeOffer, parseComponents, parseBenefits, renderOfferLetter, formatMoney } from "@/lib/hiring/offer-math";
import { isOfferLinkExpired, formatOfferDate, dateOnlyISO } from "@/lib/hiring/offer-lifecycle";
import { escapeHtml } from "@/lib/shared/utils";
import { namesFor } from "@/lib/hiring/user-names";
import { lapseExpiredSentOffers } from "@/lib/hiring/offer-lapse";

// ---------------------------------------------------------------------------
// R5 — offer builder (docs/RECRUITMENT_MODULE_PLAN.md §5). Templates are
// hiring:config; offers are hiring:manage and only for SELECTED candidates
// (the hire decision gates the offer, not the other way round). Components
// are stored as JSON and computed by lib/hiring/offer-math.ts.
// ---------------------------------------------------------------------------

function serializeOfferTemplate(t: {
  id: string; key: string; label: string; description: string;
  components: string; benefits: string; letterTemplate: string;
  isActive: boolean; sortOrder: number;
}): OfferTemplateT {
  return {
    id: t.id, key: t.key, label: t.label, description: t.description,
    components: parseComponents(t.components),
    benefits: parseBenefits(t.benefits),
    letterTemplate: t.letterTemplate,
    isActive: t.isActive, sortOrder: t.sortOrder,
  };
}

/** List offer templates (hiring:manage — salary bands are sensitive). */
export async function getOfferTemplates(): Promise<ActionResult<OfferTemplateT[]>> {
  return toResult(async () => {
    await requirePermission("hiring:manage");
    const rows = await db.offerTemplate.findMany({
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });
    return rows.map(serializeOfferTemplate);
  });
}

/** P23 (PR-02/PR-03) — offers and offer templates REFUSE percent-of-net
 * lines: "net" resolves only at payroll time (the run's two-pass kernel,
 * sequential on the docked running net — an offer's net is not stable). The
 * mode lives in salary structures; the friendly error names the offending
 * line (QA-18 convention). */
function assertNoNetPercentLines(
  components: Array<{ key: string; label: string; mode: string }>,
  context: string,
): void {
  const offender = components.find((c) => c.mode === "PERCENT_OF_NET");
  if (offender) {
    throw new AuthorizationError(
      `"${offender.label || offender.key}" is a percent-of-net line — net resolves only at payroll time. Remove it from the ${context} (salary structures accept it).`,
    );
  }
}

export async function saveOfferTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:config");
    const data = parseOrThrow(saveOfferTemplateSchema, input);
    // P23 — offers refuse percent-of-net lines: net is not stable at offer
    // time (it depends on the window's LOP and the period's adjustments);
    // the mode resolves only at payroll time, so it lives in salary
    // structures. The refusal names the line (QA-18).
    assertNoNetPercentLines(data.components, "offer template");
    const payload = {
      key: data.key,
      label: data.label,
      description: data.description,
      components: JSON.stringify(data.components),
      benefits: JSON.stringify(data.benefits),
      letterTemplate: data.letterTemplate,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
    };
    const row = data.id
      ? await db.offerTemplate.update({ where: { id: data.id }, data: payload })
      : await db.offerTemplate.create({ data: payload });
    await logAudit({
      actor: auth,
      action: "hiring.offer_template_saved",
      entityType: "OFFER_TEMPLATE",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} ${data.id ? "updated" : "created"} offer template "${row.label}" (${data.components.length} components).`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

export async function deleteOfferTemplate(input: { id: string }): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:config");
    const data = parseOrThrow(deleteOfferTemplateSchema, input);
    const row = await db.offerTemplate.delete({ where: { id: data.id } });
    await logAudit({
      actor: auth,
      action: "hiring.offer_template_deleted",
      entityType: "OFFER_TEMPLATE",
      entityId: row.id,
      entityLabel: row.label,
      detail: `${auth.name} removed offer template "${row.label}" (existing offers keep their snapshots).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Generate an offer for a SELECTED candidate from a template: components +
 * benefits are copied (the template snapshot), the letter is rendered with
 * the candidate's numbers. Status DRAFT — editable until approved + sent
 * (R6). F2.10: an optional negotiated start date feeds the {{startDate}}
 * letter placeholder (F-R11 — it used to render empty). */
export async function createOfferRecord(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(createOfferRecordSchema, input);
    const [candidate, template] = await Promise.all([
      db.candidate.findUnique({ where: { id: data.candidateId } }),
      db.offerTemplate.findUnique({ where: { id: data.templateId } }),
    ]);
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    if (candidate.status !== "SELECTED") {
      throw new AuthorizationError("Offers can only be created for SELECTED candidates.");
    }
    if (!template || !template.isActive) {
      throw new AuthorizationError("Unknown or inactive offer template.");
    }
    const components = parseComponents(template.components);
    const benefits = parseBenefits(template.benefits);
    const config = await getWorkspaceConfig();
    const totals = computeOffer(components);
    const startDate = data.startDate ? new Date(`${data.startDate}T00:00:00Z`) : null;
    const letterText = renderOfferLetter(
      template.letterTemplate,
      {
        candidateName: candidate.fullName,
        position: candidate.position,
        workspaceName: config.workspace.name,
        // F-R11 — "15 Jan 2027" in the letter, "" when HR has not set one.
        startDate: formatOfferDate(startDate),
      },
      totals,
    );
    const row = await db.offerRecord.create({
      data: {
        candidateId: candidate.id,
        templateId: template.id,
        templateLabel: template.label,
        components: JSON.stringify(components),
        benefits: JSON.stringify(benefits),
        letterText,
        startDate,
        status: "DRAFT",
        notes: data.notes,
        createdById: auth.userId,
      },
    });
    await logAudit({
      actor: auth,
      action: "hiring.offer_created",
      entityType: "OFFER_RECORD",
      entityId: row.id,
      entityLabel: `${candidate.fullName} — ${template.label}`,
      detail: `${auth.name} generated a draft offer for ${candidate.fullName} from "${template.label}" (CTC ${formatMoney(totals.ctc)}${startDate ? `, proposed start ${formatOfferDate(startDate)}` : ""}).`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Edit a DRAFT offer's negotiated numbers / benefits / letter / start
 * date. F2.10: an APPROVED draft is editable too, but the edit DEMOTES it
 * back to DRAFT (the manager approved specific numbers — changing them
 * needs fresh approval; the audit line says so). Once SENT the record is
 * immutable — the signed snapshot is the contract. */
export async function updateOfferRecord(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const data = parseOrThrow(updateOfferRecordSchema, input);
    // P23 — offers refuse percent-of-net lines (net resolves only at
    // payroll time; salary structures accept them).
    assertNoNetPercentLines(data.components, "offer");
    const offer = await db.offerRecord.findUnique({
      where: { id: data.id },
      include: { candidate: { select: { fullName: true } } },
    });
    if (!offer) throw new AuthorizationError("Offer not found.");
    if (offer.status !== "DRAFT" && offer.status !== "APPROVED") {
      throw new AuthorizationError(`Offer is already ${offer.status} — sent offers are immutable.`);
    }
    const startDate = data.startDate ? new Date(`${data.startDate}T00:00:00Z`) : null;
    const demoted = offer.status === "APPROVED";
    await db.offerRecord.update({
      where: { id: offer.id },
      data: {
        components: JSON.stringify(data.components),
        benefits: JSON.stringify(data.benefits),
        letterText: data.letterText,
        notes: data.notes,
        startDate,
        // The demotion: an edit invalidates the approval.
        ...(demoted ? { status: "DRAFT", approvedById: "", approvedAt: null } : {}),
      },
    });
    const totals = computeOffer(data.components);
    await logAudit({
      actor: auth,
      action: "hiring.offer_updated",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${auth.name} updated the ${demoted ? "approved " : ""}draft offer for ${offer.candidate.fullName} (CTC ${formatMoney(totals.ctc)})${demoted ? " — the edit demoted it back to DRAFT; manager approval is required again." : ""}`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** F2.10 (R11/D-20) — the manager approval step: DRAFT → APPROVED. Gated
 * to hiring:approve (MANAGER + ADMIN in the static floor, deliberately NOT
 * HR — the composer's role), and four-eyes: the composer themself cannot
 * approve their own offer. Only APPROVED offers are sendable. */
export async function approveOffer(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:approve");
    const data = parseOrThrow(approveOfferSchema, input);
    const offer = await db.offerRecord.findUnique({
      where: { id: data.offerId },
      include: { candidate: { select: { id: true, fullName: true, status: true } } },
    });
    if (!offer) throw new AuthorizationError("Offer not found.");
    if (offer.status !== "DRAFT") {
      throw new AuthorizationError(`Offer is already ${offer.status} — only DRAFT offers can be approved.`);
    }
    if (offer.candidate.status !== "SELECTED") {
      throw new AuthorizationError(`Candidate is ${offer.candidate.status} — approve the offer of a SELECTED candidate.`);
    }
    if (offer.createdById && offer.createdById === auth.userId) {
      throw new AuthorizationError(
        "The composer cannot approve their own offer — a second pair of eyes (a manager) is required before it can be sent.",
      );
    }
    await db.offerRecord.update({
      where: { id: offer.id },
      data: { status: "APPROVED", approvedById: auth.userId, approvedAt: new Date() },
    });
    const totals = computeOffer(parseComponents(offer.components));
    await logAudit({
      actor: auth,
      action: "hiring.offer_approved",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${auth.name} approved the draft offer for ${offer.candidate.fullName} (CTC ${formatMoney(totals.ctc)}) — it can now be sent.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** All offers, newest first (hiring:manage) — the Offers panel. Lapses
 * stale SENT links to EXPIRED first (F-R5) so the panel never shows a dead
 * link as "awaiting". */
export async function getOfferRecords(): Promise<ActionResult<OfferRecordT[]>> {
  return toResult(async () => {
    await requirePermission("hiring:manage");
    await lapseExpiredSentOffers();
    const rows = await db.offerRecord.findMany({
      include: { candidate: { select: { fullName: true, position: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const names = await namesFor(rows.map((r) => r.createdById).concat(rows.map((r) => r.approvedById)));
    return rows.map((r) => ({
      id: r.id,
      candidateId: r.candidateId,
      candidateName: r.candidate.fullName,
      position: r.candidate.position,
      templateId: r.templateId,
      templateLabel: r.templateLabel,
      components: parseComponents(r.components),
      benefits: parseBenefits(r.benefits),
      letterText: r.letterText,
      status: r.status,
      notes: r.notes,
      createdBy: names.get(r.createdById) ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      // R6 e-sign fields — the token lets HR re-copy the signing link (the
      // action is already hiring:manage gated); signedName/At power the
      // "signed by" display on SENT → SIGNED records.
      token: r.token,
      tokenExpiresAt: r.tokenExpiresAt ? r.tokenExpiresAt.toISOString() : null,
      signedAt: r.signedAt ? r.signedAt.toISOString() : null,
      signedName: r.signedName,
      // F2.10 — the approval trail + the negotiated start date.
      approvedBy: r.approvedById ? names.get(r.approvedById) ?? null : null,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      startDate: dateOnlyISO(r.startDate),
    }));
  });
}

/** F2.10 (R11/D-20) — DRAFT offers awaiting a manager's approval, for the
 * approver's panel (hiring:approve — MANAGER/ADMIN, not the HR composer).
 * Deliberately leaner than getOfferRecords: candidate, template, CTC and
 * notes — but never tokens, letters or the composer's audit copy (salary
 * surfaces stay hiring:manage-scoped; the approver sees exactly what the
 * decision needs). */
export async function getOffersAwaitingApproval(): Promise<ActionResult<{
  id: string;
  candidateId: string;
  candidateName: string;
  position: string;
  templateLabel: string;
  ctc: number;
  notes: string;
  createdBy: string | null;
  createdAt: string;
}[]>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:approve");
    void auth;
    const rows = await db.offerRecord.findMany({
      where: { status: "DRAFT" },
      include: { candidate: { select: { id: true, fullName: true, position: true, status: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    const names = await namesFor(rows.map((r) => r.createdById));
    return rows
      // A DRAFT whose candidate moved on is not approvable — hide it (the
      // approveOffer guard still refuses it if raced).
      .filter((r) => r.candidate.status === "SELECTED")
      .map((r) => {
        const totals = computeOffer(parseComponents(r.components));
        return {
          id: r.id,
          candidateId: r.candidateId,
          candidateName: r.candidate.fullName,
          position: r.candidate.position,
          templateLabel: r.templateLabel,
          ctc: totals.ctc,
          notes: r.notes,
          createdBy: names.get(r.createdById) ?? null,
          createdAt: r.createdAt.toISOString(),
        };
      });
  });
}

// ---------------------------------------------------------------------------
// R6 — e-sign + auto employee creation (docs/RECRUITMENT_MODULE_PLAN.md §5).
// Flow: createOfferRecord (HR composes, DRAFT) → approveOffer (a MANAGER —
// F2.10's four-eyes step, hiring:approve, distinct from the composer) →
// sendOffer (hiring:manage) mints a single-use token + emails the signing
// link via the outbox; the candidate opens the PUBLIC /offer/[token]
// page (no session) and either signs (typed full name → immutable snapshot
// with IP + timestamp) or declines; the link's expiry is honored on BOTH
// paths and lapsed reads flip stale SENT rows to EXPIRED (F-R5); markJoined
// then creates the User account (deterministic <first>.<last>@domain
// email), EmployeeProfile, TeamMember roster entry, salary structure copied
// from the signed offer (F-R7), onboarding checklist from the unified
// template source (F-R8), and queues a welcome email.
// ---------------------------------------------------------------------------

const OFFER_TOKEN_TTL_DAYS = 7;

function generateOfferToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function offerBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? "http://localhost:3000";
}

export async function sendOffer(input: { offerId: string }): Promise<ActionResult<{ token: string; mailStatus: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const offerId = String(input?.offerId ?? "").trim();
    if (!offerId) throw new AuthorizationError("An offer id is required.");
    const offer = await db.offerRecord.findUnique({
      where: { id: offerId },
      include: { candidate: { select: { id: true, fullName: true, email: true, position: true, status: true } } },
    });
    if (!offer) throw new AuthorizationError("Offer not found.");
    if (offer.status === "DRAFT") {
      // F2.10 — the approval step sits between compose and send.
      throw new AuthorizationError(
        "Manager approval is required before an offer can be sent — approve the draft first.",
      );
    }
    if (offer.status !== "APPROVED") {
      throw new AuthorizationError(`Offer is already ${offer.status}.`);
    }
    if (offer.candidate.status !== "SELECTED") {
      throw new AuthorizationError("Offers can only be sent to SELECTED candidates.");
    }

    const token = generateOfferToken();
    const tokenExpiresAt = new Date(Date.now() + OFFER_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Email the signing link via the audited outbox (best-effort like the
    // rejection email; a provider outage never fails the send itself).
    const config = await getWorkspaceConfig();
    const link = `${offerBaseUrl()}/offer/${token}`;
    const totals = computeOffer(parseComponents(offer.components));
    const subject = `Your offer from ${config.workspace.name} — ${offer.candidate.position || "the role"}`;
    const text =
      `Hi ${offer.candidate.fullName.split(/\s+/)[0]},\n\n` +
      `Please review and sign your offer from ${config.workspace.name}:\n\n${link}\n\n` +
      `Total package: ${formatMoney(totals.ctc)} per year (net ${formatMoney(totals.net)}).\n` +
      (offer.startDate ? `Proposed start date: ${formatOfferDate(offer.startDate)}.\n` : "") +
      `The link expires in ${OFFER_TOKEN_TTL_DAYS} days and can be used once.\n\n` +
      `We are looking forward to having you on the team!\n\nThe ${config.workspace.name} Hiring Team`;
    const html =
      `<p>Hi ${escapeHtml(offer.candidate.fullName.split(/\s+/)[0])},</p>` +
      `<p>Please review and sign your offer from ${escapeHtml(config.workspace.name)}:</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      `<p>Total package: <strong>${formatMoney(totals.ctc)}</strong> per year (net ${formatMoney(totals.net)}).</p>` +
      (offer.startDate ? `<p>Proposed start date: <strong>${escapeHtml(formatOfferDate(offer.startDate))}</strong>.</p>` : "") +
      `<p>The link expires in ${OFFER_TOKEN_TTL_DAYS} days and can be used once.</p>` +
      `<p>We are looking forward to having you on the team!</p>` +
      `<p>The ${escapeHtml(config.workspace.name)} Hiring Team</p>`;

    // F-R12 (S17) — the SENT flip and the outbox row land in ONE
    // transaction (previously the status flip preceded the outbox write:
    // a crash between them left a SENT offer with no emailed link). The
    // provider delivery itself stays OUTSIDE the transaction on purpose —
    // network I/O never holds a write lock; a provider outage resolves the
    // row to FAILED without touching the (already durable) SENT state.
    const outboxRow = await db.$transaction(async (tx) => {
      await tx.offerRecord.update({
        where: { id: offer.id },
        data: { status: "SENT", token, tokenExpiresAt },
      });
      return queueOutboxMail(tx, {
        kind: "OFFER",
        candidateId: offer.candidateId,
        toAddress: offer.candidate.email,
        subject,
        text,
        sentById: auth.userId,
      });
    });
    const { status } = await deliverOutboxMail(outboxRow.id, {
      toAddress: offer.candidate.email,
      subject,
      html,
      text,
    });

    await logAudit({
      actor: auth,
      action: "hiring.offer_sent",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${auth.name} sent the approved offer to ${offer.candidate.email} (signing link expires in ${OFFER_TOKEN_TTL_DAYS} days; email ${status}).`,
    });
    revalidatePath("/");
    return { token, mailStatus: status };
  });
}

/** Public (no session): the candidate's view of a tokenized offer. Never
 * exposes internal notes or the outbox; only the letter + numbers.
 *
 * `state` mirrors the token's lifecycle: OPEN (signable), or SIGNED /
 * DECLINED after the single use — those CONSUMED states still return the
 * payload (with signedAt/signedName where relevant) so revisiting the link
 * shows the candidate their own recorded outcome instead of a dead-end
 * error. Genuinely unopenable links (unknown token, expired, not yet sent)
 * still throw user-friendly errors. */
export async function getOfferByToken(
  token: string,
): Promise<ActionResult<{
  state: "OPEN" | "SIGNED" | "DECLINED";
  offerId: string;
  candidateName: string;
  position: string;
  workspaceName: string;
  templateLabel: string;
  letterText: string;
  components: { key: string; label: string; kind: string; mode: string; amount: number; resolved: number }[];
  benefits: string[];
  totals: { earnings: number; employerContributions: number; deductions: number; net: number; ctc: number };
  expiresAt: string;
  signedAt: string | null;
  signedName: string | null;
}>> {
  return toResult(async () => {
    const t = String(token ?? "").trim();
    if (!t) throw new AuthorizationError("A token is required.");
    const offer = await db.offerRecord.findUnique({
      where: { token: t },
      include: { candidate: { select: { fullName: true, position: true } } },
    });
    if (!offer) throw new AuthorizationError("This offer link is not valid.");
    if (offer.status === "EXPIRED") {
      // F2.10 — the lapsed outcome gets the same honest message a stale
      // SENT link produces, never the misleading "not available yet".
      throw new AuthorizationError("This offer link has expired — please ask HR to resend it.");
    }
    if (offer.status !== "SENT" && offer.status !== "SIGNED" && offer.status !== "DECLINED") {
      throw new AuthorizationError("This offer is not available for signing yet.");
    }
    if (offer.status === "SENT" && isOfferLinkExpired(offer.tokenExpiresAt)) {
      throw new AuthorizationError("This offer link has expired — please ask HR to resend it.");
    }
    const components = parseComponents(offer.components);
    const totals = computeOffer(components);
    const config = await getWorkspaceConfig();
    return {
      state: offer.status === "SIGNED" ? "SIGNED" : offer.status === "DECLINED" ? "DECLINED" : "OPEN",
      offerId: offer.id,
      candidateName: offer.candidate.fullName,
      position: offer.candidate.position,
      workspaceName: config.workspace.name,
      templateLabel: offer.templateLabel,
      letterText: offer.letterText,
      components: components.map((c) => ({ ...c, resolved: totals.resolved[c.key] ?? 0 })),
      benefits: parseBenefits(offer.benefits),
      totals: {
        earnings: totals.earnings,
        employerContributions: totals.employerContributions,
        deductions: totals.deductions,
        net: totals.net,
        ctc: totals.ctc,
      },
      expiresAt: (offer.tokenExpiresAt ?? new Date()).toISOString(),
      signedAt: offer.signedAt ? offer.signedAt.toISOString() : null,
      signedName: offer.signedName || null,
    };
  });
}

/** Public (no session): typed-signature capture. The typed name must match
 * the candidate's full name (case-insensitive) — the ceremony that makes the
 * signature deliberate. Records signedAt + source IP; the record becomes
 * immutable (updateOfferRecord refuses non-DRAFT states). */
export async function signOffer(input: {
  token: string;
  signedName: string;
}): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const t = String(input?.token ?? "").trim();
    const signedName = String(input?.signedName ?? "").trim();
    if (!t || !signedName) throw new AuthorizationError("A token and your full name are required.");
    const offer = await db.offerRecord.findUnique({
      where: { token: t },
      include: { candidate: { select: { id: true, fullName: true } } },
    });
    if (!offer) throw new AuthorizationError("This offer link is not valid.");
    if (offer.status !== "SENT") throw new AuthorizationError(`This offer is ${offer.status}.`);
    if (isOfferLinkExpired(offer.tokenExpiresAt)) {
      throw new AuthorizationError("This offer link has expired — please ask HR to resend it.");
    }
    if (signedName.toLowerCase() !== offer.candidate.fullName.toLowerCase()) {
      throw new AuthorizationError("Please type your full legal name exactly as it appears on the offer.");
    }
    // Best-effort client IP (behind the reverse proxy), like password-reset.
    let ip = "unknown";
    try {
      const h = await headers();
      const xff = h.get("x-forwarded-for") ?? "";
      ip = xff.split(",")[0].trim() || "unknown";
    } catch {
      ip = "unknown";
    }
    await db.offerRecord.update({
      where: { id: offer.id },
      data: { status: "SIGNED", signedAt: new Date(), signedName, signedIp: ip },
    });
    await logAudit({
      actor: { userId: `candidate:${offer.candidateId}`, name: signedName, role: "CANDIDATE" },
      action: "hiring.offer_signed",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${signedName} signed the offer (IP ${ip}).`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}

/** Public (no session): decline without signing. F2.10 (F-R5): the expiry
 * check is now honored here too — symmetric with signOffer; a stale link
 * can neither sign NOR decline (the outcome already reads EXPIRED). */
export async function declineOffer(input: { token: string }): Promise<ActionResult<{ ok: true }>> {
  return toResult(async () => {
    const t = String(input?.token ?? "").trim();
    if (!t) throw new AuthorizationError("A token is required.");
    const offer = await db.offerRecord.findUnique({
      where: { token: t },
      include: { candidate: { select: { id: true, fullName: true } } },
    });
    if (!offer) throw new AuthorizationError("This offer link is not valid.");
    if (offer.status !== "SENT") throw new AuthorizationError(`This offer is ${offer.status}.`);
    if (isOfferLinkExpired(offer.tokenExpiresAt)) {
      throw new AuthorizationError("This offer link has expired — please ask HR to resend it.");
    }
    await db.offerRecord.update({ where: { id: offer.id }, data: { status: "DECLINED" } });
    await logAudit({
      actor: { userId: `candidate:${offer.candidateId}`, name: offer.candidate.fullName, role: "CANDIDATE" },
      action: "hiring.offer_declined",
      entityType: "OFFER_RECORD",
      entityId: offer.id,
      entityLabel: `${offer.candidate.fullName} — ${offer.templateLabel}`,
      detail: `${offer.candidate.fullName} declined the offer.`,
    });
    revalidatePath("/");
    return { ok: true };
  });
}
