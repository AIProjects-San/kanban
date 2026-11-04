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
} = vi.hoisted(() => ({
  scheduleInterview: vi.fn(),
  saveScorecard: vi.fn(),
  advanceStage: vi.fn(),
  decideCandidate: vi.fn(),
  addCandidateStage: vi.fn(),
  setStageStatus: vi.fn(),
  getDirectory: vi.fn(),
}));

vi.mock("@/server-actions/hiring", () => ({
  scheduleInterview,
  saveScorecard,
  advanceStage,
  decideCandidate,
  addCandidateStage,
  setStageStatus,
}));

vi.mock("@/server-actions/hr-directory", () => ({ getDirectory }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getDirectory.mockResolvedValue({
    ok: true,
    data: { profiles: [{ userId: "u-mgr", name: "Ingrid" }, { userId: "u-hr", name: "Remy" }] },
  });
});

describe("CandidateDetailModal: scheduling", () => {
  it("opens the schedule form on an INTERVIEW stage and submits interviewer + time", async () => {
    scheduleInterview.mockResolvedValue({ ok: true, data: { ok: true } });
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})])} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-hr"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-hr"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-hr"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-hr"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-mgr"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-diego"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-hr"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-mgr"
      />,
    );
    expect(screen.queryByTestId("select-btn")).toBeNull();
    expect(screen.queryByTestId("reject-btn")).toBeNull();
  });

  it("a SELECTED candidate shows the offer-prep banner + reactivate", () => {
    render(
      <CandidateDetailModal
        open candidate={cand([stage({})], { status: "SELECTED", decidedAt: "2026-11-10T00:00:00.000Z" })} canManage
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-hr"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-hr"
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
        onClose={onClose} onChanged={onChanged} onEdit={onEdit} currentUserId="u-hr"
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
