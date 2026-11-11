// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P30 (LV-01/LV-11) — the compensatory claim queue's HR surface (Requests
// tab). Pins the section's contract: rows render with the worked span and
// earned days, the inline decision buttons call the action with the claim's
// id + decision, an empty queue renders nothing, and the member's OWN claim
// carries no buttons (the chain decides for them, not themselves).
// ---------------------------------------------------------------------------

const { decideCompensatoryLeaveRequest } = vi.hoisted(() => ({
  decideCompensatoryLeaveRequest: vi.fn(),
}));

vi.mock("@/server-actions/compensatory-leave", () => ({
  getCompensatoryQueue: vi.fn(),
  decideCompensatoryLeaveRequest,
  getMyCompensatoryRequests: vi.fn(),
  createCompensatoryLeaveRequest: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { CompOffQueueSection } from "@/components/views/hr-view";
import { toast } from "sonner";
import type { CompLeaveRequestT } from "@/lib/types";

const CLAIM: CompLeaveRequestT = {
  id: "cr-1",
  userId: "u-theo",
  userName: "Theo Vance",
  leaveTypeId: "lt-comp",
  typeName: "Comp Off",
  typeColor: "#84cc16",
  workFromDate: "2026-11-07",
  workToDate: "2026-11-07",
  days: 1,
  reason: "Weekend rollout support",
  status: "PENDING",
  decidedById: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: "",
  createdAt: "2026-11-08T02:00:00.000Z",
};

const onChanged = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  decideCompensatoryLeaveRequest.mockResolvedValue({ ok: true, data: { ok: true } });
});

describe("CompOffQueueSection", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(
      <CompOffQueueSection compRequests={[]} currentUserId="u-admin" onChanged={onChanged} />,
    );
    expect(container.firstElementChild).toBeNull();
  });

  it("lists the claim with the worked span, earned days and reason", () => {
    render(<CompOffQueueSection compRequests={[CLAIM]} currentUserId="u-admin" onChanged={onChanged} />);
    const row = screen.getByTestId("compoff-queue-row");
    expect(row.textContent).toContain("Theo Vance");
    expect(row.textContent).toContain("Comp Off");
    expect(row.textContent).toContain("7 Nov 2026 → 7 Nov 2026");
    expect(row.textContent).toContain("1");
    expect(row.textContent).toContain("Weekend rollout support");
  });

  it("Approve calls the action with the claim id and reloads", async () => {
    render(<CompOffQueueSection compRequests={[CLAIM]} currentUserId="u-admin" onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("compoff-approve-cr-1"));
    await waitFor(() =>
      expect(decideCompensatoryLeaveRequest).toHaveBeenCalledWith({ compId: "cr-1", decision: "APPROVE" }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("Reject calls the action and surfaces the toast", async () => {
    render(<CompOffQueueSection compRequests={[CLAIM]} currentUserId="u-admin" onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("compoff-reject-cr-1"));
    await waitFor(() =>
      expect(decideCompensatoryLeaveRequest).toHaveBeenCalledWith({ compId: "cr-1", decision: "REJECT" }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Comp-off claim rejected."));
  });

  it("a refusal surfaces as an error toast without reloading", async () => {
    decideCompensatoryLeaveRequest.mockResolvedValue({ ok: false, error: "The claim no longer checks out." });
    render(<CompOffQueueSection compRequests={[CLAIM]} currentUserId="u-admin" onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("compoff-approve-cr-1"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The claim no longer checks out."));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("the member's own claim carries no decision buttons (the chain decides)", () => {
    render(<CompOffQueueSection compRequests={[CLAIM]} currentUserId="u-theo" onChanged={onChanged} />);
    expect(screen.queryByTestId("compoff-approve-cr-1")).toBeNull();
    expect(screen.queryByTestId("compoff-reject-cr-1")).toBeNull();
  });
});
