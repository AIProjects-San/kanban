// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Recruitment R2 — candidate detail modal: interview scheduling + scorecard
// contract (docs/RECRUITMENT_MODULE_PLAN.md §5).
//   • INTERVIEW stages get Schedule/Reschedule + scorecard buttons.
//   • Scheduling writes via scheduleInterview with the picked interviewer.
//   • The scorecard form saves rating/strengths/concerns/recommendation.
//   • A filled scorecard renders read-only with the recommendation badge.
//   • Scorecard edit is offered to the assigned interviewer even without
//     hiring:manage.
// ---------------------------------------------------------------------------

const {
  scheduleInterview,
  saveScorecard,
  advanceStage,
  decideCandidate,
  addCandidateStage,
  setStageStatus,
  getDirectory,
  getJoiningFormalities,
  requestDocument,
  receiveDocument,
  verifyDocument,
  rejectDocument,
  initiateBackgroundCheck,
  updateBackgroundCheck,
  markJoined,
} = vi.hoisted(() => ({
  scheduleInterview: vi.fn(),
  saveScorecard: vi.fn(),
  advanceStage: vi.fn(),
  decideCandidate: vi.fn(),
  addCandidateStage: vi.fn(),
  setStageStatus: vi.fn(),
  getDirectory: vi.fn(),
  getJoiningFormalities: vi.fn(),
  requestDocument: vi.fn(),
  receiveDocument: vi.fn(),
  verifyDocument: vi.fn(),
  rejectDocument: vi.fn(),
  initiateBackgroundCheck: vi.fn(),
  updateBackgroundCheck: vi.fn(),
  markJoined: vi.fn(),
}));

vi.mock("@/server-actions/hiring", () => ({
  scheduleInterview,
  saveScorecard,
  advanceStage,
  decideCandidate,
  addCandidateStage,
  setStageStatus,
  getJoiningFormalities,
  requestDocument,
  receiveDocument,
  verifyDocument,
  rejectDocument,
  initiateBackgroundCheck,
  updateBackgroundCheck,
  markJoined,
}));

vi.mock("@/server-actions/hr-directory", () => ({ getDirectory }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

// Stub the Modal portal but keep children rendering (project-detail pattern).
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="modal-stub">{children}</div> : null,
}));

import { CandidateDetailModal } from "@/components/ui/candidate-detail-modal";
import type { CandidateT, CandidateStageT } from "@/lib/types";

function stage(overrides: Partial<CandidateStageT>): CandidateStageT {
  return {
    id: "st-2", stageKey: "interview_1", label: "Interview 1 — Technical",
    stageType: "INTERVIEW", ownerUserId: "u-mgr", ownerName: "Ingrid", status: "IN_PROGRESS",
    scheduledAt: null, remarks: "", rating: null, strengths: "", concerns: "",
    recommendation: null, eventId: null, sortOrder: 20, startedAt: null, completedAt: null,
    ...overrides,
  };
}

function cand(stages: CandidateStageT[], overrides: Partial<CandidateT> = {}): CandidateT {
  return {
    id: "cand-1", fullName: "Nadia Petrova", email: "nadia@example.com", phone: "",
    position: "Senior Frontend Engineer", department: "ENGINEERING", source: "Referral",
    resumeUrl: "", notes: "", status: "ACTIVE", rejectReason: "", decidedAt: null,
    createdById: "u-admin", userId: null, joinedAt: null,
    createdAt: new Date().toISOString(),
    stages,
    ...overrides,
  };
}

const onChanged = vi.fn();
const onEdit = vi.fn();
const onBuildOffer = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getDirectory.mockResolvedValue({
    ok: true,
    data: { profiles: [{ userId: "u-mgr", name: "Ingrid" }, { userId: "u-hr", name: "Remy" }] },
  });
  // R4 — formalities bundle default (empty checklist + no BGV).
  getJoiningFormalities.mockResolvedValue({
    ok: true,
    data: { docTypes: [], documents: [], bgChecks: [] },
  });
});

describe("CandidateDetailModal: scheduling", () => {
  it("opens the schedule form on an INTERVIEW stage and submits interviewer + time", async () => {
    scheduleInterview.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    fireEvent.click(screen.getByTestId("schedule-btn-interview_1"));
    const when = await screen.findByTestId("schedule-when");
    fireEvent.change(when, { target: { value: "2026-11-10T09:30" } });
    fireEvent.change(screen.getByTestId("schedule-interviewer"), { target: { value: "u-mgr" } });
    fireEvent.click(screen.getByTestId("schedule-submit"));
    await waitFor(() =>
      expect(scheduleInterview).toHaveBeenCalledWith(
        expect.objectContaining({ stageId: "st-2", interviewerId: "u-mgr" }),
      ),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("hides the schedule button for non-INTERVIEW stages", () => {
    render(
      <CandidateDetailModal
        open candidate={cand([stage({ stageKey: "screening", stageType: "SCREENING", label: "Screening" })])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    expect(screen.queryByTestId("schedule-btn-screening")).toBeNull();
  });
});

describe("CandidateDetailModal: scorecards", () => {
  it("saves a structured scorecard (rating, strengths, concerns, recommendation)", async () => {
    saveScorecard.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    fireEvent.click(screen.getByTestId("scorecard-btn-interview_1"));
    fireEvent.change(screen.getByTestId("scorecard-rating"), { target: { value: "4" } });
    fireEvent.change(screen.getByTestId("scorecard-recommendation"), { target: { value: "HIRE" } });
    fireEvent.click(screen.getByTestId("scorecard-submit"));
    await waitFor(() =>
      expect(saveScorecard).toHaveBeenCalledWith(
        expect.objectContaining({ stageId: "st-2", rating: 4, recommendation: "HIRE" }),
      ),
    );
  });

  it("renders a filled scorecard read-only with the recommendation badge", () => {
    render(
      <CandidateDetailModal
        open
        candidate={cand([stage({
          status: "PASSED", rating: 4, strengths: "Deep React + a11y",
          concerns: "Little backend", recommendation: "HIRE",
        })])}
        canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    const card = screen.getByTestId("scorecard-interview_1");
    expect(card.textContent).toContain("4/5");
    expect(card.textContent).toContain("Deep React + a11y");
    expect(card.textContent).toContain("Little backend");
    expect(card.textContent).toContain("Hire");
  });

  it("offers scorecard editing to the assigned interviewer without hiring:manage", () => {
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage={false}
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-mgr" hasSignedOffer={false}
      />,
    );
    expect(screen.getByTestId("scorecard-btn-interview_1")).toBeTruthy();
    // But no manage controls: advance/skip/fail are hidden.
    expect(screen.queryByTestId("advance-stage-btn")).toBeNull();
  });

  it("withholds scorecard editing from a third party (non-owner, non-manager)", () => {
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage={false}
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-diego" hasSignedOffer={false}
      />,
    );
    expect(screen.queryByTestId("scorecard-btn-interview_1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R3 — decisions: SELECT + opt-in rejection email
// ---------------------------------------------------------------------------

describe("CandidateDetailModal: R3 decisions", () => {
  it("Select (canManage, ACTIVE) calls decideCandidate with SELECT", async () => {
    decideCandidate.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    fireEvent.click(screen.getByTestId("select-btn"));
    await waitFor(() =>
      expect(decideCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ candidateId: "cand-1", decision: "SELECT" }),
      ),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("hides Select from a non-manager (MANAGER read-only view)", () => {
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage={false}
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-mgr" hasSignedOffer={false}
      />,
    );
    expect(screen.queryByTestId("select-btn")).toBeNull();
    expect(screen.queryByTestId("reject-btn")).toBeNull();
  });

  it("a SELECTED candidate shows the offer-prep banner + reactivate", () => {
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})], { status: "SELECTED", decidedAt: "2026-11-10T00:00:00.000Z" })} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    expect(screen.getByText(/Offer preparation pending/)).toBeTruthy();
    expect(screen.getByText(/SELECTED/)).toBeTruthy();
    expect(screen.getByTestId("reactivate-btn")).toBeTruthy();
  });

  it("reject with the email toggle submits sendEmail + remarks", async () => {
    decideCandidate.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    fireEvent.click(screen.getByTestId("reject-btn"));
    fireEvent.change(screen.getByTestId("reject-reason"), { target: { value: "Internal: depth below bar" } });
    // The remarks field only exists once the email toggle is on.
    expect(screen.queryByTestId("reject-email-remarks")).toBeNull();
    fireEvent.click(screen.getByTestId("reject-email-toggle"));
    fireEvent.change(screen.getByTestId("reject-email-remarks"), {
      target: { value: "Please apply again next quarter." },
    });
    fireEvent.click(screen.getByTestId("reject-confirm"));
    await waitFor(() =>
      expect(decideCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateId: "cand-1", decision: "REJECT", reason: "Internal: depth below bar",
          sendEmail: true, emailRemarks: "Please apply again next quarter.",
        }),
      ),
    );
  });

  it("reject without the toggle sends no email flags (defaults)", async () => {
    decideCandidate.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    fireEvent.click(screen.getByTestId("reject-btn"));
    fireEvent.change(screen.getByTestId("reject-reason"), { target: { value: "Not a fit" } });
    fireEvent.click(screen.getByTestId("reject-confirm"));
    await waitFor(() =>
      expect(decideCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ decision: "REJECT", reason: "Not a fit", sendEmail: false }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// R4 — joining formalities panel (docs checklist + background checks)
// ---------------------------------------------------------------------------

const FORMALITIES = {
  ok: true,
  data: {
    docTypes: [
      { id: "dt-1", key: "id_proof", label: "ID Document", description: "", isMandatory: true, sortOrder: 10, isActive: true },
      { id: "dt-2", key: "bank_details", label: "Bank Details", description: "", isMandatory: true, sortOrder: 20, isActive: true },
      { id: "dt-3", key: "education", label: "Education Certificates", description: "", isMandatory: false, sortOrder: 40, isActive: true },
    ],
    documents: [
      { id: "cd-1", candidateId: "cand-1", docTypeKey: "id_proof", label: "ID Document", status: "RECEIVED", fileRef: "passport.pdf", remarks: "", requestedAt: "2026-11-10T00:00:00.000Z", receivedAt: "2026-11-11T00:00:00.000Z", verifiedBy: null, verifiedAt: null },
      { id: "cd-2", candidateId: "cand-1", docTypeKey: "bank_details", label: "Bank Details", status: "VERIFIED", fileRef: "bank.pdf", remarks: "", requestedAt: "2026-11-10T00:00:00.000Z", receivedAt: "2026-11-11T00:00:00.000Z", verifiedBy: "Remy", verifiedAt: "2026-11-12T00:00:00.000Z" },
    ],
    bgChecks: [
      { id: "bg-1", candidateId: "cand-1", vendor: "VerifyRight", status: "IN_REVIEW", reportRef: "", notes: "ETA 5 days", initiatedBy: "Remy", initiatedAt: "2026-11-08T00:00:00.000Z", completedAt: null },
    ],
  },
};

describe("CandidateDetailModal: R4 joining formalities", () => {
  it("renders the checklist with per-type status chips and the BGV card (canManage)", async () => {
    getJoiningFormalities.mockResolvedValue(FORMALITIES);
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    const panel = await screen.findByTestId("joining-formalities");
    expect(panel.textContent).toContain("ID Document");
    expect(panel.textContent).toContain("Bank Details");
    // RECEIVED + VERIFIED chips render; the unrequested type offers Request.
    const idChip = await screen.findByTestId("doc-status-id_proof");
    expect(idChip.textContent).toBe("RECEIVED");
    expect(screen.getByTestId("doc-status-bank_details").textContent).toBe("VERIFIED");
    expect(screen.getByTestId("request-doc-education")).toBeTruthy();
    // BGV row with vendor + status.
    expect(panel.textContent).toContain("VerifyRight");
    expect(panel.textContent).toContain("IN REVIEW");
  });

  it("Request on an unrequested type calls requestDocument with the type key", async () => {
    getJoiningFormalities.mockResolvedValue(FORMALITIES);
    requestDocument.mockResolvedValue({ ok: true, data: { id: "cd-3" } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    await screen.findByTestId("joining-formalities");
    fireEvent.click(screen.getByTestId("request-doc-education"));
    await waitFor(() =>
      expect(requestDocument).toHaveBeenCalledWith(
        expect.objectContaining({ candidateId: "cand-1", docTypeKey: "education" }),
      ),
    );
  });

  it("Verify on a RECEIVED row calls verifyDocument", async () => {
    getJoiningFormalities.mockResolvedValue(FORMALITIES);
    verifyDocument.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    await screen.findByTestId("joining-formalities");
    fireEvent.click(screen.getByTestId("verify-doc-id_proof"));
    await waitFor(() =>
      expect(verifyDocument).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "cd-1" }),
      ),
    );
  });

  it("Mark received opens the inline fileRef form and submits receiveDocument", async () => {
    getJoiningFormalities.mockResolvedValue({
      ...FORMALITIES,
      data: {
        ...FORMALITIES.data,
        documents: [FORMALITIES.data.documents[0]],
      },
    });
    // id_proof REQUESTED (not received yet).
    getJoiningFormalities.mockResolvedValue({
      ok: true,
      data: {
        ...FORMALITIES.data,
        documents: [
          { ...FORMALITIES.data.documents[0], status: "REQUESTED", fileRef: "" },
        ],
      },
    });
    receiveDocument.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    await screen.findByTestId("joining-formalities");
    fireEvent.click(screen.getByTestId("receive-doc-id_proof"));
    fireEvent.change(screen.getByTestId("doc-action-input-id_proof"), { target: { value: "passport_scan.pdf" } });
    fireEvent.click(screen.getByTestId("doc-action-submit-id_proof"));
    await waitFor(() =>
      expect(receiveDocument).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "cd-1", fileRef: "passport_scan.pdf" }),
      ),
    );
  });

  it("Cleared on a BGV row calls updateBackgroundCheck", async () => {
    getJoiningFormalities.mockResolvedValue(FORMALITIES);
    updateBackgroundCheck.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    await screen.findByTestId("joining-formalities");
    fireEvent.click(screen.getByTestId("bg-clear-bg-1"));
    await waitFor(() =>
      expect(updateBackgroundCheck).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bg-1", status: "CLEARED" }),
      ),
    );
  });

  it("hides the panel entirely without canManage (interviewer view)", async () => {
    getJoiningFormalities.mockResolvedValue(FORMALITIES);
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage={false}
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-mgr" hasSignedOffer={false}
      />,
    );
    // Give the effect a beat, then the panel must be absent.
    await waitFor(() => expect(screen.getByTestId("candidate-timeline")).toBeTruthy());
    expect(screen.queryByTestId("joining-formalities")).toBeNull();
    expect(getJoiningFormalities).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R6 — e-sign completion: Mark joined + HIRED display
// ---------------------------------------------------------------------------

describe("CandidateDetailModal: R6 joining", () => {
  it("keeps Mark joined disabled until a SIGNED offer exists", () => {
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})], { status: "SELECTED", decidedAt: "2026-11-10T00:00:00.000Z" })} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer={false}
      />,
    );
    const btn = screen.getByTestId("mark-joined-btn");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // The waiting hint shows instead of the signed banner.
    expect(screen.getByTestId("offer-prep-banner")).toBeTruthy();
    expect(screen.queryByTestId("offer-signed-banner")).toBeNull();
  });

  it("Mark joined (SELECTED + SIGNED offer) calls markJoined and toasts the created account email", async () => {
    markJoined.mockResolvedValue({ ok: true, data: { userId: "u-new", email: "nadia.petrova@fernly.app", mailStatus: "SENT" } });
    const { toast } = await import("sonner");
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})], { status: "SELECTED", decidedAt: "2026-11-10T00:00:00.000Z" })} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer
      />,
    );
    const btn = screen.getByTestId("mark-joined-btn");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("offer-signed-banner")).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(markJoined).toHaveBeenCalledWith(expect.objectContaining({ candidateId: "cand-1" })),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("nadia.petrova@fernly.app"),
      ),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("Mark joined with the welcome email SKIPPED warns HR instead of claiming delivery", async () => {
    markJoined.mockResolvedValue({ ok: true, data: { userId: "u-new", email: "nadia.petrova@fernly.app", mailStatus: "SKIPPED" } });
    const { toast } = await import("sonner");
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})], { status: "SELECTED", decidedAt: "2026-11-10T00:00:00.000Z" })} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer
      />,
    );
    fireEvent.click(screen.getByTestId("mark-joined-btn"));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining("welcome email was NOT delivered"),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a HIRED candidate shows the joined date + onboarding pointer (no joined button)", () => {
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})], { status: "HIRED", userId: "u-new", joinedAt: "2026-11-18T00:00:00.000Z" })} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} onBuildOffer={onBuildOffer} currentUserId="u-hr" hasSignedOffer
      />,
    );
    const details = screen.getByTestId("hired-details");
    expect(details.textContent).toContain("Employee account created");
    expect(details.textContent).toContain("onboarding checklist");
    expect(screen.queryByTestId("mark-joined-btn")).toBeNull();
  });
});
