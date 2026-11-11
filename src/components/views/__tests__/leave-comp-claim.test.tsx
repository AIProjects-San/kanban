// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P30 (LV-01/LV-11) — the ESS comp-off claim modal (Leave view). Pins the
// form's contract: the live preview counts the span's non-working days (the
// claimedNonWorkingDays kernel against the holiday map), the submit button
// stays disabled until a claimable span exists, and a submit calls the
// action with the form's payload (attendance facts are the server's to
// judge — the modal never claims to validate them).
// ---------------------------------------------------------------------------

const { createCompensatoryLeaveRequest } = vi.hoisted(() => ({
  createCompensatoryLeaveRequest: vi.fn(),
}));

vi.mock("@/server-actions/compensatory-leave", () => ({
  getMyCompensatoryRequests: vi.fn(),
  createCompensatoryLeaveRequest,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { CompClaimModal } from "@/components/views/leave-view";
import { toast } from "sonner";
import type { LeaveTypeT, HolidayT } from "@/lib/types";

const COMP_TYPE: LeaveTypeT = {
  id: "lt-comp",
  name: "Comp Off",
  code: "COMP_OFF",
  requiresDoc: false,
  paid: true,
  color: "#84cc16",
  active: true,
  isCompensatory: true,
  policy: null,
};

// 2026-11-07 is a Saturday, 2026-11-08 a Sunday; the holidays list is empty
// (a plain weekend — no calendar entries needed).
const HOLIDAYS: HolidayT[] = [];

const onCreated = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  createCompensatoryLeaveRequest.mockResolvedValue({ ok: true, data: { id: "cr-1", days: 1 } });
});

function setDates(from: string, to: string) {
  fireEvent.change(screen.getByTestId("compoff-from"), { target: { value: from } });
  fireEvent.change(screen.getByTestId("compoff-to"), { target: { value: to } });
}

describe("CompClaimModal", () => {
  it("submits a worked-Saturday claim with the form's payload", async () => {
    render(
      <CompClaimModal open onClose={vi.fn()} compTypes={[COMP_TYPE]} holidays={HOLIDAYS} onCreated={onCreated} />,
    );
    setDates("2026-11-07", "2026-11-07");
    fireEvent.change(screen.getByTestId("compoff-type"), { target: { value: "lt-comp" } });
    fireEvent.click(screen.getByTestId("compoff-submit"));
    await waitFor(() =>
      expect(createCompensatoryLeaveRequest).toHaveBeenCalledWith({
        leaveTypeId: "lt-comp",
        workFromDate: "2026-11-07",
        workToDate: "2026-11-07",
        reason: undefined,
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("the preview counts the span's non-working days (Sat + Sun = 2)", () => {
    render(
      <CompClaimModal open onClose={vi.fn()} compTypes={[COMP_TYPE]} holidays={HOLIDAYS} onCreated={onCreated} />,
    );
    setDates("2026-11-07", "2026-11-08");
    expect(screen.getByTestId("compoff-form").textContent).toContain("2 non-working days claimed");
    expect(screen.getByTestId("compoff-form").textContent).toContain("attendance must be marked worked");
  });

  it("stays disabled for a working-day span (nothing claimable)", () => {
    render(
      <CompClaimModal open onClose={vi.fn()} compTypes={[COMP_TYPE]} holidays={HOLIDAYS} onCreated={onCreated} />,
    );
    // 2026-11-09 is a Monday.
    setDates("2026-11-09", "2026-11-09");
    expect(screen.getByTestId("compoff-form").textContent).toContain("0 non-working days claimed");
    expect(screen.getByTestId("compoff-submit")).toHaveProperty("disabled", true);
    expect(createCompensatoryLeaveRequest).not.toHaveBeenCalled();
  });

  it("a refusal surfaces as an error toast and keeps the form open", async () => {
    createCompensatoryLeaveRequest.mockResolvedValue({
      ok: false,
      error: "The claim can't be filed — 2026-11-07 has no attendance marked — ask HR to mark you worked first.",
    });
    render(
      <CompClaimModal open onClose={vi.fn()} compTypes={[COMP_TYPE]} holidays={HOLIDAYS} onCreated={onCreated} />,
    );
    setDates("2026-11-07", "2026-11-07");
    fireEvent.click(screen.getByTestId("compoff-submit"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("renders the comp type select with only compensatory types", () => {
    render(
      <CompClaimModal open onClose={vi.fn()} compTypes={[COMP_TYPE]} holidays={HOLIDAYS} onCreated={onCreated} />,
    );
    const select = screen.getByTestId("compoff-type") as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
    expect(select.options[0].textContent).toBe("Comp Off");
  });
});
