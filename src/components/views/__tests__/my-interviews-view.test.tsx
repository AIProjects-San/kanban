// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Persona-audit P0-5 (D-04) — My Interviews view tests: a MEMBER-interviewer
// sees their OWN assigned stages (never the board), fills their own
// scorecard through saveScorecard, sees the saved card read-only, and the
// empty state explains the assignment rule. All fetches are self-scoped
// server actions — the view itself never receives other users' data.
// ---------------------------------------------------------------------------

const { getMyInterviews, saveScorecard } = vi.hoisted(() => ({
  getMyInterviews: vi.fn(),
  saveScorecard: vi.fn(),
}));

vi.mock("@/server-actions/hiring", () => ({
  getMyInterviews,
  saveScorecard,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { MyInterviewsView } from "@/components/views/my-interviews-view";

const CURRENT_USER = { id: "u-diego", name: "Diego Morales", role: "MEMBER" };

const ROWS = [
  {
    stageId: "st-9",
    stageLabel: "Interview 1 — Technical",
    candidateId: "cand-7",
    candidateName: "Tomas Eriksen",
    position: "QA Engineer",
    status: "PENDING",
    scheduledAt: "2026-11-12T09:30:00Z",
    rating: null,
    recommendation: null,
  },
  {
    stageId: "st-4",
    stageLabel: "Interview 2 — HR & Culture",
    candidateId: "cand-1",
    candidateName: "Nadia Petrova",
    position: "Senior Frontend Engineer",
    status: "IN_PROGRESS",
    scheduledAt: null,
    rating: 4,
    recommendation: "HIRE",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  getMyInterviews.mockResolvedValue({ ok: true, data: ROWS });
  saveScorecard.mockResolvedValue({ ok: true, data: { ok: true } });
});

describe("My Interviews view (P0-5 / D-04)", () => {
  it("lists own assigned interview stages with candidate, stage and schedule", async () => {
    render(<MyInterviewsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getAllByTestId("my-interview-row").length).toBe(2));
    expect(screen.getByText("Tomas Eriksen")).toBeTruthy();
    expect(screen.getByText("Nadia Petrova")).toBeTruthy();
    // Scheduled vs unscheduled rendering.
    expect(screen.getByText(/12 Nov/i)).toBeTruthy();
    expect(screen.getByText("unscheduled")).toBeTruthy();
  });

  it("shows a read-only own-scorecard summary when already filled, and still allows editing", async () => {
    render(<MyInterviewsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getAllByTestId("my-interview-row").length).toBe(2));
    // Nadia's stage carries rating 4 / HIRE — rendered as the filled card.
    expect(screen.getByTestId("my-interview-card-st-4").textContent).toContain("4/5");
    expect(screen.getByTestId("my-interview-card-st-4").textContent).toContain("Hire");
    // Filled stages get the Edit affordance; unfilled get Fill.
    expect(screen.getByTestId("my-interview-edit-st-4")).toBeTruthy();
    expect(screen.getByTestId("my-interview-fill-st-9")).toBeTruthy();
  });

  it("fills an own scorecard via saveScorecard and reloads the list", async () => {
    render(<MyInterviewsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getAllByTestId("my-interview-row").length).toBe(2));
    fireEvent.click(screen.getByTestId("my-interview-fill-st-9"));
    fireEvent.change(screen.getByTestId("my-scorecard-rating"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("my-scorecard-recommendation"), { target: { value: "STRONG_HIRE" } });
    fireEvent.change(screen.getByTestId("my-scorecard-strengths"), { target: { value: "Sharp systems thinking" } });
    fireEvent.click(screen.getByTestId("my-scorecard-submit"));
    await waitFor(() =>
      expect(saveScorecard).toHaveBeenCalledWith(
        expect.objectContaining({ stageId: "st-9", rating: 5, recommendation: "STRONG_HIRE" }),
      ),
    );
    // The list reloads after a successful save.
    await waitFor(() => expect(getMyInterviews).toHaveBeenCalledTimes(2));
  });

  it("surfaces a save error as a toast without clearing the form target", async () => {
    saveScorecard.mockResolvedValue({ ok: false, error: "Only the assigned interviewer or an HR/admin can fill this scorecard." });
    render(<MyInterviewsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getAllByTestId("my-interview-row").length).toBe(2));
    fireEvent.click(screen.getByTestId("my-interview-fill-st-9"));
    fireEvent.click(screen.getByTestId("my-scorecard-submit"));
    await waitFor(() => expect(saveScorecard).toHaveBeenCalled());
    // Form stays open for a retry.
    expect(screen.getByTestId("my-interview-scorecard-form")).toBeTruthy();
    expect(getMyInterviews).toHaveBeenCalledTimes(1);
  });

  it("shows the assignment-rule empty state when nothing is assigned", async () => {
    getMyInterviews.mockResolvedValue({ ok: true, data: [] });
    render(<MyInterviewsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getByTestId("my-interviews-empty")).toBeTruthy());
    expect(screen.getByTestId("my-interviews-empty").textContent).toContain("assigned");
  });

  it("surfaces a fetch error as a toast and renders the empty state", async () => {
    getMyInterviews.mockResolvedValue({ ok: false, error: "You must be signed in." });
    render(<MyInterviewsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getByTestId("my-interviews-empty")).toBeTruthy());
    expect(screen.queryByTestId("my-interview-row")).toBeNull();
  });
});
