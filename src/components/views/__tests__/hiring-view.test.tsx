// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Recruitment R1 — Hiring board view tests (docs/RECRUITMENT_MODULE_PLAN.md §6).
//
//   • HR — full board: columns per active stage, cards at their current
//     stage, manage controls (Add candidate) + template editor visible.
//   • MANAGER — interviewer view: board visible, manage/config controls
//     hidden (hiring:view only).
//   • Status filter — REJECTED pool shows the rejection reason.
//   • Opening a candidate renders the stage timeline + advance button.
// ---------------------------------------------------------------------------

const { getHiringBoard, getHiringPermissions, advanceStage, getMyInterviews, getMailOutbox, getOfferRecords, getHiringFunnel } = vi.hoisted(() => ({
  getHiringBoard: vi.fn(),
  getHiringPermissions: vi.fn(),
  advanceStage: vi.fn(),
  getMyInterviews: vi.fn(),
  getMailOutbox: vi.fn(),
  getOfferRecords: vi.fn(),
  getHiringFunnel: vi.fn(),
}));

vi.mock("@/server-actions/hiring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server-actions/hiring")>()),
  getHiringBoard,
  getHiringPermissions,
  advanceStage,
  getMyInterviews,
  getMailOutbox,
  getOfferRecords,
  getHiringFunnel,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The detail/create/template modals are covered by their own suites; stub
// them so this file pins the BOARD contract only.
vi.mock("@/components/ui/candidate-modal", () => ({
  CandidateModal: () => <div data-testid="candidate-modal-stub" />,
}));
vi.mock("@/components/ui/candidate-detail-modal", () => ({
  CandidateDetailModal: () => <div data-testid="candidate-detail-stub" />,
}));
vi.mock("@/components/ui/hiring-stage-modal", () => ({
  HiringStageModal: () => <div data-testid="stage-modal-stub" />,
}));
vi.mock("@/components/ui/document-type-modal", () => ({
  DocumentTypeModal: () => <div data-testid="doc-type-modal-stub" />,
}));
vi.mock("@/components/ui/offer-builder-modal", () => ({
  OfferBuilderModal: () => <div data-testid="offer-builder-stub" />,
}));
vi.mock("@/components/ui/offer-template-modal", () => ({
  OfferTemplateModal: () => <div data-testid="offer-template-modal-stub" />,
}));

import { HiringView } from "@/components/views/hiring-view";
import type { CandidateT, HiringStageConfigT } from "@/lib/types";

const STAGES: HiringStageConfigT[] = [
  { id: "tpl-1", key: "screening", label: "Application Screening", stageType: "SCREENING", ownerRole: "HR", description: "", sortOrder: 10, isActive: true },
  { id: "tpl-2", key: "interview_1", label: "Interview 1 — Technical", stageType: "INTERVIEW", ownerRole: "MANAGER", description: "", sortOrder: 20, isActive: true },
  { id: "tpl-3", key: "old", label: "Old stage", stageType: "CUSTOM", ownerRole: "HR", description: "", sortOrder: 80, isActive: false },
];

function cand(overrides: Partial<CandidateT>): CandidateT {
  return {
    id: "cand-1", fullName: "Nadia Petrova", email: "nadia@example.com", phone: "",
    position: "Senior Frontend Engineer", department: "ENGINEERING", source: "Referral",
    resumeUrl: "", notes: "", status: "ACTIVE", rejectReason: "", decidedAt: null,
    createdById: "u-admin", userId: null, joinedAt: null,
    createdAt: new Date().toISOString(),
    stages: [
      { id: "st-1", stageKey: "screening", label: "Application Screening", stageType: "SCREENING", ownerUserId: null, ownerName: null, status: "PASSED", scheduledAt: null, remarks: "", rating: null, strengths: "", concerns: "", recommendation: null, eventId: null, sortOrder: 10, startedAt: null, completedAt: null },
      { id: "st-2", stageKey: "interview_1", label: "Interview 1 — Technical", stageType: "INTERVIEW", ownerUserId: "u-mgr", ownerName: "Ingrid", status: "IN_PROGRESS", scheduledAt: null, remarks: "", rating: null, strengths: "", concerns: "", recommendation: null, eventId: null, sortOrder: 20, startedAt: null, completedAt: null },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getHiringBoard.mockResolvedValue({
    ok: true,
    data: { stages: STAGES, candidates: [cand({})] },
  });
  getHiringPermissions.mockResolvedValue({ ok: true, data: { canManage: true, canConfig: true, mailConfigured: true } });
  getMyInterviews.mockResolvedValue({ ok: true, data: [] });
  getMailOutbox.mockResolvedValue({ ok: true, data: [] });
  getOfferRecords.mockResolvedValue({ ok: true, data: [] });
  getHiringFunnel.mockResolvedValue({ ok: true, data: {
    totals: { total: 7, active: 4, selected: 1, hired: 1, rejected: 1, withdrawn: 0 },
    stages: [
      { stageKey: "screening", label: "Application Screening", inStage: 1, passed: 5, avgDays: 2.4 },
      { stageKey: "interview_1", label: "Interview 1 — Technical", inStage: 2, passed: 2, avgDays: null },
    ],
    offers: { total: 2, awaiting: 1, signed: 1, declined: 0, acceptRate: 100 },
  } });
});

describe("HiringView: HR (full manage)", () => {
  it("renders one column per ACTIVE template stage with counts and the candidate card at its current stage", async () => {
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    expect(await screen.findByTestId("stage-column-screening")).toBeTruthy();
    expect(screen.getByTestId("stage-column-interview_1")).toBeTruthy();
    // Inactive template stages never render as columns.
    expect(screen.queryByTestId("stage-column-old")).toBeNull();
    // Nadia's current stage is interview_1 (IN_PROGRESS).
    const col = screen.getByTestId("stage-column-interview_1");
    expect(col.querySelector('[data-testid="candidate-card"]')).toBeTruthy();
    expect(screen.getByText("Nadia Petrova")).toBeTruthy();
  });

  it("shows the manage + config controls (hiring:manage / hiring:config)", async () => {
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    expect(await screen.findByTestId("add-candidate-btn")).toBeTruthy();
    expect(screen.getByTestId("stage-template-btn")).toBeTruthy();
    // R4 — the document-type editor is another hiring:config surface.
    expect(screen.getByTestId("doc-type-btn")).toBeTruthy();
  });

  it("the REJECTED pool shows the rejection reason", async () => {
    getHiringBoard.mockResolvedValue({
      ok: true,
      data: {
        stages: STAGES,
        candidates: [cand({ status: "REJECTED", rejectReason: "Depth below bar" })],
      },
    });
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    fireEvent.click(await screen.findByTestId("hiring-filter-rejected"));
    expect(await screen.findByText(/Depth below bar/)).toBeTruthy();
  });
});

describe("HiringView: MANAGER (interviewer, view-only)", () => {
  it("renders the board but hides manage/config controls", async () => {
    getHiringPermissions.mockResolvedValue({ ok: true, data: { canManage: false, canConfig: false, mailConfigured: true } });
    render(<HiringView currentUser={{ id: "u-mgr", name: "Ingrid", role: "MANAGER" }} />);
    expect(await screen.findByTestId("stage-column-screening")).toBeTruthy();
    expect(screen.queryByTestId("add-candidate-btn")).toBeNull();
    expect(screen.queryByTestId("stage-template-btn")).toBeNull();
    expect(screen.queryByTestId("doc-type-btn")).toBeNull();
    expect(screen.getByText(/interviewer view/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// P0-6 (D-05/D-18) — first-run guidance: HR (hiring:manage) sees a warning
// above the outbox until a mail provider is wired; managers never do (they
// cannot send, and the outbox itself is manage-gated).
// ---------------------------------------------------------------------------

describe("HiringView: P0-6 mail-config warning", () => {
  it("shows the warning banner when mail is not configured (canManage)", async () => {
    getHiringPermissions.mockResolvedValue({ ok: true, data: { canManage: true, canConfig: true, mailConfigured: false } });
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const banner = await screen.findByTestId("mail-config-warning");
    expect(banner.textContent).toContain("Email delivery is off");
    expect(banner.textContent).toContain("RESEND_API_KEY");
    // The outbox panel the banner explains is right below it.
    expect(screen.getByTestId("email-outbox")).toBeTruthy();
  });

  it("hides the banner when a provider is configured", async () => {
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    expect(await screen.findByTestId("email-outbox")).toBeTruthy();
    expect(screen.queryByTestId("mail-config-warning")).toBeNull();
  });

  it("never shows the banner for a view-only interviewer (MANAGER)", async () => {
    getHiringPermissions.mockResolvedValue({ ok: true, data: { canManage: false, canConfig: false, mailConfigured: false } });
    render(<HiringView currentUser={{ id: "u-mgr", name: "Ingrid", role: "MANAGER" }} />);
    expect(await screen.findByTestId("stage-column-screening")).toBeTruthy();
    expect(screen.queryByTestId("mail-config-warning")).toBeNull();
    expect(screen.queryByTestId("email-outbox")).toBeNull();
  });
});

describe("HiringView: R2 interviewer panel", () => {
  it("renders 'Your upcoming interviews' when the signed-in user has assigned stages", async () => {
    getMyInterviews.mockResolvedValue({
      ok: true,
      data: [
        {
          stageId: "st-2", stageLabel: "Interview 1 — Technical", candidateId: "cand-1",
          candidateName: "Nadia Petrova", position: "SWE", status: "IN_PROGRESS",
          scheduledAt: "2026-11-10T09:30:00.000Z", rating: null, recommendation: null,
        },
      ],
    });
    render(<HiringView currentUser={{ id: "u-mgr", name: "Ingrid", role: "MANAGER" }} />);
    const panel = await screen.findByTestId("my-interviews");
    expect(panel.textContent).toContain("Nadia Petrova");
    expect(panel.textContent).toContain("Interview 1 — Technical");
  });

  it("hides the panel when the user has no assigned interviews", async () => {
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    expect(await screen.findByTestId("stage-column-screening")).toBeTruthy();
    expect(screen.queryByTestId("my-interviews")).toBeNull();
  });
});

describe("HiringView: empty template", () => {
  it("explains that no stages are configured", async () => {
    getHiringBoard.mockResolvedValue({ ok: true, data: { stages: [], candidates: [] } });
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    expect(await screen.findByText(/No active stages in the template/)).toBeTruthy();
  });

  it("surfaces a board fetch error as a toast", async () => {
    getHiringBoard.mockResolvedValue({ ok: false, code: "AUTH", error: "denied" });
    const { toast } = await import("sonner");
    render(<HiringView currentUser={{ id: "u-mgr", name: "Ingrid", role: "MANAGER" }} />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("denied"));
  });
});

// ---------------------------------------------------------------------------
// R3 — decisions & email outbox
// ---------------------------------------------------------------------------

describe("HiringView: R3 email outbox", () => {
  const OUTBOX_ROW = {
    id: "ob-1", kind: "REJECTION", candidateId: "cand-1", candidateName: "Nadia Petrova",
    toAddress: "nadia@example.com", subject: "Update on your application — SWE at Fernly Workspace",
    body: "Hi Nadia,\n\nThank you for taking the time to apply.",
    status: "SENT", sentBy: "Remy", sentAt: "2026-11-12T01:02:03.000Z",
    providerMessageId: "re-1", error: "", createdAt: "2026-11-12T01:02:03.000Z",
  };

  it("HR sees the outbox panel with status chip + subject; rows expand to the body", async () => {
    getMailOutbox.mockResolvedValue({ ok: true, data: [OUTBOX_ROW] });
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const panel = await screen.findByTestId("email-outbox");
    expect(panel.textContent).toContain("Update on your application");
    expect(panel.textContent).toContain("nadia@example.com");
    expect(panel.textContent).toContain("SENT");
    // Body hidden until the row is expanded.
    expect(panel.textContent).not.toContain("Thank you for taking the time");
    fireEvent.click(screen.getAllByTestId("outbox-row")[0]);
    expect(panel.textContent).toContain("Thank you for taking the time");
  });

  it("shows the empty-outbox hint when nothing has been sent", async () => {
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const panel = await screen.findByTestId("email-outbox");
    expect(panel.textContent).toContain("No candidate emails yet");
  });

  it("MANAGERs (no hiring:manage) never see the outbox panel — and never trigger the fetch", async () => {
    getHiringPermissions.mockResolvedValue({ ok: true, data: { canManage: false, canConfig: false } });
    render(<HiringView currentUser={{ id: "u-mgr", name: "Ingrid", role: "MANAGER" }} />);
    expect(await screen.findByTestId("stage-column-screening")).toBeTruthy();
    expect(screen.queryByTestId("email-outbox")).toBeNull();
    expect(getMailOutbox).not.toHaveBeenCalled();
  });

  it("a FAILED row surfaces the delivery error on expand", async () => {
    getMailOutbox.mockResolvedValue({
      ok: true,
      data: [{ ...OUTBOX_ROW, id: "ob-2", status: "FAILED", error: "Resend API error 422: quota exceeded" }],
    });
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    await screen.findByTestId("email-outbox");
    fireEvent.click(screen.getAllByTestId("outbox-row")[0]);
    expect(await screen.findByText(/quota exceeded/)).toBeTruthy();
  });
});

describe("HiringView: R3 SELECTED pool", () => {
  it("the Selected filter chip counts and lists selected candidates", async () => {
    getHiringBoard.mockResolvedValue({
      ok: true,
      data: {
        stages: STAGES,
        candidates: [
          cand({}),
          cand({ id: "cand-2", fullName: "Priyanka Menon", status: "SELECTED", decidedAt: "2026-11-10T00:00:00.000Z" }),
        ],
      },
    });
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const chip = await screen.findByTestId("hiring-filter-selected");
    expect(chip.textContent).toContain("Selected");
    expect(chip.textContent).toContain("1");
    fireEvent.click(chip);
    expect(await screen.findByText("Priyanka Menon")).toBeTruthy();
  });
});


describe("HiringView: R5 offers panel", () => {
  it("HR sees the offers panel with CTC; the Offers template button is config-gated", async () => {
    getOfferRecords.mockResolvedValue({
      ok: true,
      data: [
        {
          id: "or-1", candidateId: "cand-1", candidateName: "Priyanka Menon",
          position: "Product Designer", templateId: "ot-1", templateLabel: "Designer Band",
          components: [
            { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68000 },
            { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
          ],
          benefits: [], letterText: "", status: "DRAFT", notes: "",
          createdBy: "Remy", createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
        },
      ],
    });
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const panel = await screen.findByTestId("offers-panel");
    expect(panel.textContent).toContain("Priyanka Menon");
    expect(panel.textContent).toContain("Designer Band");
    expect(panel.textContent).toContain("CTC $70,040");
    expect(screen.getByTestId("offer-template-btn")).toBeTruthy();
  });

  it("MANAGERs see neither the offers panel nor the template button", async () => {
    getHiringPermissions.mockResolvedValue({ ok: true, data: { canManage: false, canConfig: false } });
    render(<HiringView currentUser={{ id: "u-mgr", name: "Ingrid", role: "MANAGER" }} />);
    expect(await screen.findByTestId("stage-column-screening")).toBeTruthy();
    expect(screen.queryByTestId("offers-panel")).toBeNull();
    expect(screen.queryByTestId("offer-template-btn")).toBeNull();
    expect(getOfferRecords).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R8 — funnel analytics panel
// ---------------------------------------------------------------------------

describe("HiringView: R8 funnel panel", () => {
  it("renders pool totals, stage velocity, and the offer accept rate", async () => {
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const funnel = await screen.findByTestId("hiring-funnel");
    expect(funnel.textContent).toContain("7 candidates all-time");

    const screening = await screen.findByTestId("funnel-stage-screening");
    expect(screening.textContent).toContain("2.4d");

    // 100% accept rate (1 signed / 1 decided).
    expect(screen.getByTestId("funnel-accept-rate").textContent).toBe("100%");
    const offers = screen.getByTestId("funnel-offers");
    expect(offers.textContent).toContain("Awaiting signature");
  });

  it("hides the funnel while it has not loaded (no layout flash)", () => {
    getHiringFunnel.mockResolvedValue({ ok: false, error: "denied" });
    render(<HiringView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    expect(screen.queryByTestId("hiring-funnel")).toBeNull();
  });
});
