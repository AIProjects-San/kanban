// ---------------------------------------------------------------------------
// Recruitment schemas — stage templates, candidates, interviews, scorecards,
// joining formalities (document types, candidate documents, background
// checks) and the offer builder (templates, records, component lines).
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish, email, isoDateStr, text } from "./common";


// ---------------------------------------------------------------------------
// Recruitment module (docs/RECRUITMENT_MODULE_PLAN.md).
// ---------------------------------------------------------------------------

export const HIRING_STAGE_TYPES = [
  "SCREENING", "INTERVIEW", "ASSESSMENT", "BG_CHECK", "DOCUMENTS", "OFFER", "CUSTOM",
] as const;
// F-R14 (S16) — the exported-but-unused HIRING_STAGE_STATUSES and
// CANDIDATE_STATUSES constants were removed (dead since the hiring
// module's own status machines landed; nothing imported them).

export const saveStageTemplateSchema = z.object({
  id: cuidish.optional(),
  key: z.string().trim().min(1, "Stage key is required.").max(60)
    .regex(/^[a-z0-9_]+$/, "Key must be lowercase letters, digits and underscores."),
  label: z.string().trim().min(1, "Stage label is required.").max(120),
  stageType: z.enum(HIRING_STAGE_TYPES),
  ownerRole: z.enum(["ADMIN", "MANAGER", "HR", "MEMBER"]),
  description: z.string().trim().max(500).default(""),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
}).strict();

export const createCandidateSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required.").max(120),
  email,
  phone: z.string().trim().max(40).default(""),
  position: z.string().trim().max(120).default(""),
  department: z.string().trim().max(60).default(""),
  source: z.string().trim().max(60).default(""),
  resumeUrl: z.string().trim().max(500).default(""),
  notes: text.default(""),
}).strict();

export const updateCandidateSchema = createCandidateSchema.extend({
  id: cuidish,
}).strict();

export const setStageStatusSchema = z.object({
  stageId: cuidish,
  // PASSED | FAILED | SKIPPED — starting a stage happens via advanceStage.
  status: z.enum(["PASSED", "FAILED", "SKIPPED"]),
  remarks: text.default(""),
}).strict();

export const addCandidateStageSchema = z.object({
  candidateId: cuidish,
  label: z.string().trim().min(1, "Stage label is required.").max(120),
  stageType: z.enum(HIRING_STAGE_TYPES).default("CUSTOM"),
  // Insert before this stage's sort order (null = append at the end).
  beforeStageId: cuidish.nullable().optional(),
}).strict();

export const decideCandidateSchema = z.object({
  candidateId: cuidish,
  // SELECT (R3): ACTIVE → SELECTED — offer prep pointer (offer builder R5).
  decision: z.enum(["SELECT", "REJECT", "WITHDRAW", "REACTIVATE"]),
  // Required for REJECT — audit-only; the email carries HR-approved remarks.
  reason: z.string().trim().max(2_000),
  // R3 — opt-in rejection email. sendEmail: the MailOutbox row is queued and
  // a send is attempted (SENT only when RESEND_API_KEY is wired; SKIPPED in
  // dev dry-run). emailRemarks: the personal note merged into the email.
  sendEmail: z.boolean().default(false),
  emailRemarks: z.string().trim().max(2_000).default(""),
}).strict();

export const deleteStageTemplateSchema = z.object({
  id: cuidish,
}).strict();

export const SCORECARD_RECOMMENDATIONS = ["STRONG_HIRE", "HIRE", "NO_HIRE"] as const;

export const scheduleInterviewSchema = z.object({
  stageId: cuidish,
  // F-R18 (S18) — TWO facts, each on the basis where it is true: the
  // instant (ISO with offset) drives scheduling semantics (clash guard,
  // stage row, reminder); the wall-clock string the user picked (the raw
  // datetime-local value) drives the calendar event's day + label via the
  // pure planInterviewEvent kernel. The shape check here mirrors the
  // kernel's rules (real calendar date + 24-hour ranges land there).
  scheduledAt: z.string().min(4, "A date/time is required.").max(40),
  wallClock: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Wall-clock must be 'YYYY-MM-DDTHH:MM' (a datetime-local value).")
    .max(20),
  interviewerId: cuidish.nullable().optional(),
}).strict();

export const scorecardSchema = z.object({
  stageId: cuidish,
  rating: z.number().int().min(1).max(5).nullable().optional(),
  strengths: z.string().trim().max(2_000).default(""),
  concerns: z.string().trim().max(2_000).default(""),
  recommendation: z.enum(SCORECARD_RECOMMENDATIONS).nullable().optional(),
  remarks: z.string().trim().max(2_000).default(""),
}).strict();

// ---------------------------------------------------------------------------
// R4 — joining formalities: document checklist + background checks
// ---------------------------------------------------------------------------

export const saveDocumentTypeSchema = z.object({
  id: cuidish.optional(),
  key: z.string().trim().min(1, "A key is required.").max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  description: z.string().trim().max(500).default(""),
  isMandatory: z.boolean().default(false),
  // P36 (EM-21) — the scope axis: CANDIDATE (the joining-formalities
  // checklist) | EMPLOYEE (identification types).
  scope: z.enum(["CANDIDATE", "EMPLOYEE"]).default("CANDIDATE"),
  sortOrder: z.number().int().min(0).max(9_999).default(0),
  isActive: z.boolean().default(true),
}).strict();

export const deleteDocumentTypeSchema = z.object({
  id: cuidish,
}).strict();

export const requestDocumentSchema = z.object({
  candidateId: cuidish,
  docTypeKey: z.string().trim().min(1).max(60),
  remarks: z.string().trim().max(2_000).default(""),
}).strict();

export const receiveDocumentSchema = z.object({
  documentId: cuidish,
  // A reference to the received file (URL / name) — optional in v1.
  fileRef: z.string().trim().max(500).default(""),
}).strict();

export const verifyDocumentSchema = z.object({
  documentId: cuidish,
  remarks: z.string().trim().max(2_000).default(""),
}).strict();

export const rejectDocumentSchema = z.object({
  documentId: cuidish,
  // Required — the candidate/HR needs to know what to fix.
  remarks: z.string().trim().min(1, "A rejection note is required.").max(2_000),
}).strict();

export const BG_CHECK_STATUSES = ["INITIATED", "IN_REVIEW", "CLEARED", "FLAGGED"] as const;

export const initiateBackgroundCheckSchema = z.object({
  candidateId: cuidish,
  vendor: z.string().trim().min(1, "A vendor is required.").max(120),
  notes: z.string().trim().max(2_000).default(""),
}).strict();

export const updateBackgroundCheckSchema = z.object({
  id: cuidish,
  status: z.enum(BG_CHECK_STATUSES),
  reportRef: z.string().trim().max(500).default(""),
  notes: z.string().trim().max(2_000).default(""),
}).strict();

// ---------------------------------------------------------------------------
// R5 — offer builder: templates + per-candidate offers
// ---------------------------------------------------------------------------

// PR-B03 (S8) — STATISTICAL: display-only component (slip info line,
// never money).
export const OFFER_COMPONENT_KINDS = ["EARNING", "EMPLOYER_CONTRIBUTION", "DEDUCTION", "STATISTICAL"] as const;
// P23 (PR-02/PR-03) — the catalog percent modes join the vocabulary:
// PERCENT_OF_GROSS resolves annually in computeOffer; PERCENT_OF_NET
// resolves only at payroll time (the run's two-pass kernel) and is
// DEDUCTION-only (no stable earning basis) — offers/offer templates refuse
// it at the action layer (assertNoNetPercentLines in hiring.ts).
export const OFFER_COMPONENT_MODES = ["FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "PERCENT_OF_NET"] as const;

/** P23 — the shared component-line refinements: percent-of-net is
 * deduction-only (the kernel rule), and the new percent modes carry a
 * percent in (0, 100] (PERCENT_OF_BASIC stays unbounded — pre-existing
 * behavior, left byte-identical). */
export function refineOfferComponent(c: { kind: string; mode: string; amount: number }, ctx: z.RefinementCtx): void {
  if (c.mode === "PERCENT_OF_NET" && c.kind !== "DEDUCTION") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mode"],
      message: "Percent-of-net is a deduction-only mode — an earning on \"net\" has no stable basis.",
    });
  }
  if (c.mode === "PERCENT_OF_GROSS" || c.mode === "PERCENT_OF_NET") {
    if (!(c.amount > 0 && c.amount <= 100)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "Percent modes need a percent between 0 and 100.",
      });
    }
  }
}

export const offerComponentSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  kind: z.enum(OFFER_COMPONENT_KINDS),
  mode: z.enum(OFFER_COMPONENT_MODES),
  amount: z.number().min(0).max(100_000_000),
  // PR-B02 (S6) — snapshot of the payment-days exemption (sparse: only
  // false is meaningful; absent = true).
  dependsOnPaymentDays: z.boolean().optional(),
}).strict().superRefine(refineOfferComponent);

export const saveOfferTemplateSchema = z.object({
  id: cuidish.optional(),
  key: z.string().trim().min(1, "A key is required.").max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  description: z.string().trim().max(500).default(""),
  components: z.array(offerComponentSchema).max(30),
  benefits: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  letterTemplate: z.string().trim().max(10_000).default(""),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9_999).default(0),
}).strict();

export const deleteOfferTemplateSchema = z.object({
  id: cuidish,
}).strict();

export const createOfferRecordSchema = z.object({
  candidateId: cuidish,
  templateId: cuidish,
  notes: z.string().trim().max(2_000).default(""),
  // F2.10 (F-R11) — the negotiated start date; feeds {{startDate}}.
  startDate: isoDateStr.optional(),
}).strict();

export const updateOfferRecordSchema = z.object({
  id: cuidish,
  components: z.array(offerComponentSchema).max(30),
  benefits: z.array(z.string().trim().min(1).max(200)).max(30),
  letterText: z.string().trim().max(10_000).default(""),
  notes: z.string().trim().max(2_000).default(""),
  // F2.10 — editable alongside the letter (editing an APPROVED draft
  // demotes it back to DRAFT: re-approval required).
  startDate: isoDateStr.optional(),
}).strict();

// F2.10 — the manager approval step (R11/D-20): DRAFT → APPROVED.
export const approveOfferSchema = z.object({
  offerId: cuidish,
}).strict();
