// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P27 (LV-08) — the leave period master's HR surface (Types & Policies tab).
// Pins the section's contract: the EMPTY master shows the implicit-calendar
// notice (the zero-change default), the chain lists with its status badges
// and the ledger bucket, Create calls the action with the form's payload,
// Delete only exists for upcoming windows, and both refusals surface as
// toasts (the actions' own guards are pinned in leave-periods.test.ts).
// ---------------------------------------------------------------------------

const { listLeavePeriods, createLeavePeriod, deleteLeavePeriod } = vi.hoisted(() => ({
  listLeavePeriods: vi.fn(),
  createLeavePeriod: vi.fn(),
  deleteLeavePeriod: vi.fn(),
}));

vi.mock("@/server-actions/leave-periods", () => ({
  listLeavePeriods,
  createLeavePeriod,
  deleteLeavePeriod,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { LeavePeriodsSection } from "@/components/views/hr-view";
import { toast } from "sonner";

const FUTURE_PERIOD = {
  id: "p1",
  name: "FY 2031/32 (Apr → Mar)",
  startDate: "2031-04-01",
  endDate: "2032-03-31",
  bucketYear: 2031,
};

beforeEach(() => {
  vi.clearAllMocks();
  listLeavePeriods.mockResolvedValue({ ok: true, data: { periods: [] } });
  createLeavePeriod.mockResolvedValue({ ok: true, data: { period: FUTURE_PERIOD } });
  deleteLeavePeriod.mockResolvedValue({ ok: true, data: undefined });
});

describe("LeavePeriodsSection", () => {
  it("an empty master shows the implicit-calendar-year notice", async () => {
    render(<LeavePeriodsSection />);
    expect(await screen.findByTestId("leave-periods-empty")).toBeTruthy();
    expect(screen.getByTestId("leave-periods-empty").textContent).toContain("implicit calendar year");
  });

  it("lists the chain with the window, bucket and upcoming badge; only upcoming rows carry Delete", async () => {
    listLeavePeriods.mockResolvedValue({
      ok: true,
      data: {
        periods: [
          // A long-past closed window (bucket clean in this mock world).
          { id: "p0", name: "Calendar 2024", startDate: "2024-01-01", endDate: "2024-12-31", bucketYear: 2024 },
          FUTURE_PERIOD,
        ],
      },
    });
    render(<LeavePeriodsSection />);
    await screen.findByTestId("leave-period-row-1");
    expect(screen.getByTestId("leave-period-name-1").textContent).toBe("FY 2031/32 (Apr → Mar)");
    expect(screen.getByTestId("leave-period-row-1").textContent).toContain("2031-04-01 → 2032-03-31");
    expect(screen.getByTestId("leave-period-row-1").textContent).toContain("ledger bucket 2031");
    expect(screen.getByTestId("leave-period-row-1").textContent).toContain("upcoming");
    expect(screen.getByTestId("leave-period-row-0").textContent).toContain("closed");
    // The closed row (index 0) has no delete button; the upcoming one does.
    expect(screen.queryByTestId("leave-period-delete-0")).toBeNull();
    expect(screen.getByTestId("leave-period-delete-1")).toBeTruthy();
  });

  it("Create submits the form's payload and reloads the list", async () => {
    render(<LeavePeriodsSection />);
    await screen.findByTestId("leave-periods-empty");
    fireEvent.change(screen.getByTestId("leave-period-name-input"), { target: { value: "FY 2031/32" } });
    fireEvent.change(screen.getByTestId("leave-period-start-input"), { target: { value: "2031-04-01" } });
    fireEvent.change(screen.getByTestId("leave-period-end-input"), { target: { value: "2032-03-31" } });
    fireEvent.click(screen.getByTestId("leave-period-create-button"));
    await waitFor(() =>
      expect(createLeavePeriod).toHaveBeenCalledWith({
        name: "FY 2031/32",
        startDate: "2031-04-01",
        endDate: "2032-03-31",
      }),
    );
    // The reloaded list now carries the created row.
    listLeavePeriods.mockResolvedValue({ ok: true, data: { periods: [FUTURE_PERIOD] } });
    await waitFor(() => expect(listLeavePeriods).toHaveBeenCalledTimes(2));
  });

  it("a refused create surfaces the action's sentence as a toast", async () => {
    createLeavePeriod.mockResolvedValue({
      ok: false,
      error: "“FY 2031/32” already starts in 2031 — one allocation window per start year keeps the ledger buckets unique.",
    });
    render(<LeavePeriodsSection />);
    await screen.findByTestId("leave-periods-empty");
    fireEvent.change(screen.getByTestId("leave-period-name-input"), { target: { value: "FY 2031/32" } });
    fireEvent.change(screen.getByTestId("leave-period-start-input"), { target: { value: "2031-04-01" } });
    fireEvent.change(screen.getByTestId("leave-period-end-input"), { target: { value: "2032-03-31" } });
    fireEvent.click(screen.getByTestId("leave-period-create-button"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("one allocation window per start year")));
  });

  it("Delete calls the action with the row id", async () => {
    listLeavePeriods.mockResolvedValue({ ok: true, data: { periods: [FUTURE_PERIOD] } });
    render(<LeavePeriodsSection />);
    await screen.findByTestId("leave-period-row-0");
    fireEvent.click(screen.getByTestId("leave-period-delete-0"));
    await waitFor(() => expect(deleteLeavePeriod).toHaveBeenCalledWith({ id: "p1" }));
  });
});
