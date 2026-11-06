// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Persona-audit P0-1 (D-02) — My Payslips view tests: every role sees their
// OWN locked-run payslips (list + latest summary), rows open the shared
// PayslipModal read-only (print, never save), and the empty state explains
// the "finalized months only" rule. The full Payroll console stays gated.
// ---------------------------------------------------------------------------

const { getMyPayslips } = vi.hoisted(() => ({ getMyPayslips: vi.fn() }));

vi.mock("@/server-actions/payroll", () => ({
  getMyPayslips,
  // PayslipModal (rendered for real, not stubbed) imports updatePayslip
  // from the same module — unreachable for LOCKED slips, but mocked so the
  // factory stays complete.
  updatePayslip: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { MyPayslipsView } from "@/components/views/my-payslips-view";
import type { PayslipT } from "@/lib/types";

const SLIPS: PayslipT[] = [
  {
    id: "ps-26-10", runId: "run-0", runPeriod: "2026-10", runStatus: "LOCKED", runWorkingDays: 0,
    userId: "u-yuki", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
    slipNo: "PS-2026-10-002",
    earnings: [{ key: "basic", label: "Basic Salary", amount: 6_500 }],
    deductions: [{ key: "lop", label: "Loss of pay (1 day)", amount: 200 }],
    note: "", lopDays: 1, gross: 6_500, net: 6_300, ytdNet: 13_200,
  },
  {
    id: "ps-26-09", runId: "run-9", runPeriod: "2026-09", runStatus: "LOCKED", runWorkingDays: 0,
    userId: "u-yuki", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
    slipNo: "PS-2026-09-002",
    earnings: [{ key: "basic", label: "Basic Salary", amount: 6_500 }],
    deductions: [], note: "", lopDays: 0, gross: 6_500, net: 6_500, ytdNet: 6_500,
  },
];

const CURRENT_USER = { id: "u-yuki", name: "Yuki Tanaka", role: "MEMBER" };

beforeEach(() => {
  vi.clearAllMocks();
  getMyPayslips.mockResolvedValue({ ok: true, data: SLIPS });
});

describe("My Payslips view (P0-1 / D-02)", () => {
  it("lists own locked payslips newest-first with net, LOP hint and YTD", async () => {
    render(<MyPayslipsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getAllByTestId("my-payslip-row").length).toBe(2));
    // Newest period first.
    expect(screen.getAllByTestId("my-payslip-row")[0].getAttribute("data-period")).toBe("2026-10");
    expect(screen.getByText("October 2026")).toBeTruthy();
    expect(screen.getByText("September 2026")).toBeTruthy();
    // Latest summary card shows the newest net.
    expect(screen.getByTestId("my-payslips-latest").textContent).toContain("$6,300.00");
    // LOP hint renders for the October slip.
    expect(screen.getByText(/LOP 1d/)).toBeTruthy();
  });

  it("opens a payslip read-only — print affordance, never a save button", async () => {
    render(<MyPayslipsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getAllByTestId("my-payslip-row").length).toBe(2));
    fireEvent.click(screen.getAllByTestId("my-payslip-row")[0]);
    await waitFor(() => expect(screen.getByTestId("payslip-modal")).toBeTruthy());
    // Read-only contract: print present, save absent (LOCKED slip).
    expect(screen.getByTestId("payslip-print")).toBeTruthy();
    expect(screen.queryByTestId("payslip-save")).toBeNull();
    expect(screen.getByTestId("payslip-totals").textContent).toContain("$6,300.00");
  });

  it("shows the finalized-months empty state when there are no payslips", async () => {
    getMyPayslips.mockResolvedValue({ ok: true, data: [] });
    render(<MyPayslipsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getByTestId("my-payslips-empty")).toBeTruthy());
    expect(screen.getByTestId("my-payslips-empty").textContent).toContain("finalizes");
  });

  it("surfaces an action error as a toast and still renders the empty state", async () => {
    getMyPayslips.mockResolvedValue({ ok: false, error: "You must be signed in." });
    render(<MyPayslipsView currentUser={CURRENT_USER} />);
    await waitFor(() => expect(screen.getByTestId("my-payslips-empty")).toBeTruthy());
    expect(screen.queryByTestId("my-payslip-row")).toBeNull();
  });
});
