// Recruitment module types (docs/RECRUITMENT_MODULE_PLAN.md) — stage
// configs, candidates + stages, the mail outbox, document types, candidate
// documents, background checks, offers + templates, and funnel analytics.
// (Split from the former lib/types/index.ts god-file.)


// ---------------------------------------------------------------------------
// Recruitment module types (docs/RECRUITMENT_MODULE_PLAN.md).
// ---------------------------------------------------------------------------

export interface HiringStageConfigT {
  id: string;
  key: string;
  label: string;
  stageType: string;
  ownerRole: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

export interface CandidateStageT {
  id: string;
  stageKey: string;
  label: string;
  stageType: string;
  ownerUserId: string | null;
  ownerName: string | null;
  status: string;
  scheduledAt: string | null;
  remarks: string;
  rating: number | null;
  /** R2 scorecard (docs/RECRUITMENT_MODULE_PLAN.md §5). */
  strengths: string;
  concerns: string;
  recommendation: string | null;
  /** CalendarEvent id when the interview has been scheduled (R2). */
  eventId: string | null;
  sortOrder: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CandidateT {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  position: string;
  department: string;
  source: string;
  resumeUrl: string;
  notes: string;
  status: string;
  rejectReason: string;
  decidedAt: string | null;
  createdById: string;
  userId: string | null;
  joinedAt: string | null;
  createdAt: string;
  stages: CandidateStageT[];
}

/** R3 — one audited outgoing email (docs/RECRUITMENT_MODULE_PLAN.md §5).
 * status: QUEUED → SENT | SKIPPED | FAILED. */
export interface MailOutboxT {
  id: string;
  kind: string;
  candidateId: string | null;
  candidateName: string | null;
  toAddress: string;
  subject: string;
  body: string;
  status: string;
  sentBy: string | null;
  sentAt: string | null;
  providerMessageId: string;
  error: string;
  createdAt: string;
}

/** R4 — one configurable document type in the joining-formalities checklist. */
export interface DocumentTypeConfigT {
  id: string;
  key: string;
  label: string;
  description: string;
  isMandatory: boolean;
  /** P36 (EM-21) — CANDIDATE (joining formalities) | EMPLOYEE
   * (identification). */
  scope: "CANDIDATE" | "EMPLOYEE";
  sortOrder: number;
  isActive: boolean;
}

/** R4 — one document being collected from one candidate.
 * status: REQUESTED → RECEIVED → VERIFIED | REJECTED. */
export interface CandidateDocumentT {
  id: string;
  candidateId: string;
  docTypeKey: string;
  label: string;
  status: string;
  fileRef: string;
  remarks: string;
  requestedAt: string;
  receivedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

/** R4 — one background-verification record.
 * status: INITIATED → IN_REVIEW → CLEARED | FLAGGED. */
export interface BackgroundCheckT {
  id: string;
  candidateId: string;
  vendor: string;
  status: string;
  reportRef: string;
  notes: string;
  initiatedBy: string | null;
  initiatedAt: string;
  completedAt: string | null;
}

/** R5 — one salary line of an offer (lib/offer-math.ts). P23 — the mode
 * vocabulary widens: PERCENT_OF_GROSS (annual resolution in computeOffer)
 * and PERCENT_OF_NET (payroll-time only — offers refuse it; structures
 * carry it and the run's two-pass kernel resolves it). */
export type OfferComponentT = {
  key: string;
  label: string;
  kind: "EARNING" | "EMPLOYER_CONTRIBUTION" | "DEDUCTION" | "STATISTICAL";
  mode: "FIXED" | "PERCENT_OF_BASIC" | "PERCENT_OF_GROSS" | "PERCENT_OF_NET";
  amount: number;
  /** PR-B02 (S6) — payment-days exemption snapshot (sparse: only false is
   * meaningful; absent = true). */
  dependsOnPaymentDays?: boolean;
};

/** R5 — a per-role offer template (hiring:config). */
export interface OfferTemplateT {
  id: string;
  key: string;
  label: string;
  description: string;
  components: OfferComponentT[];
  benefits: string[];
  letterTemplate: string;
  isActive: boolean;
  sortOrder: number;
}

/** R5 — one offer for one candidate. status: DRAFT → APPROVED → SENT →
 * SIGNED | DECLINED | EXPIRED (F2.10: APPROVED is the manager four-eyes
 * step — approvedBy/At carry it; EXPIRED is the lapsed signing link).
 * R6 adds the e-sign fields: token (null while DRAFT), expiry, and the typed
 * signature capture (signedAt/signedName/signedIp). F2.10 adds startDate
 * (the negotiated join date — F-R11). */
export interface OfferRecordT {
  id: string;
  candidateId: string;
  candidateName: string;
  position: string;
  templateId: string | null;
  templateLabel: string;
  components: OfferComponentT[];
  benefits: string[];
  letterText: string;
  status: string;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  token: string | null;
  tokenExpiresAt: string | null;
  signedAt: string | null;
  signedName: string;
  /** F2.10 — the manager who approved the draft (null until APPROVED). */
  approvedBy: string | null;
  approvedAt: string | null;
  /** F2.10 — the proposed join date ("YYYY-MM-DD", "" when unset). */
  startDate: string;
}

/** R8 — recruitment funnel analytics (getHiringFunnel): pool totals, per-stage
 * load + velocity, and the offer funnel. hiring:view — not salary-sensitive. */
export interface HiringFunnelT {
  totals: { total: number; active: number; selected: number; hired: number; rejected: number; withdrawn: number };
  stages: Array<{ stageKey: string; label: string; inStage: number; passed: number; avgDays: number | null }>;
  /** F2.10 — expired counts lapsed/lapsing SENT links separately from
   * awaiting (F-R5: stale links never inflate the awaiting number). */
  offers: { total: number; awaiting: number; signed: number; declined: number; expired: number; acceptRate: number | null };
}
