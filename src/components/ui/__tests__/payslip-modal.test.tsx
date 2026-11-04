// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Recruitment R7 — payslip modal: editable lines with live gross/net while
// OPEN (LOP days auto-compute the pro-rated deduction), read-only + print
// affordance when LOCKED.
// ---------------------------------------------------------------------------

const { updatePayslip } = vi.hoisted(() => ({ updatePayslip: vi.fn() }));
vi.mock("@/server-actions/payroll", () => ({ updatePayslip }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="modal-stub">{children}</div> : null,
}));

import { PayslipModal } from "@/components/ui/payslip-modal";
import type { PayslipT } from "@/lib/types";

function payslip(overrides: Partial<PayslipT> = {}): PayslipT {
  return {
    id: "ps-1", runId: "run-1", runPeriod: "2026-11", runStatus: "OPEN",
    userId: "u-yuki", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
    slipNo: "PS-2026-11-001",
    earnings: [
      { key: "basic", label: "Basic Salary", amount: 6_500 },
      { key: "transport", label: "Transport Allowance", amount: 200 },
    ],
    deductions: [],
    note: "", lopDays: 0, gross: 6_700, net: 6_700, ytdNet: 13_400,
    ...overrides,
  };
}

const onChanged = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PayslipModal (OPEN run)", () => {
  it("shows live totals and updates net when a line is edited", async () => {
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    const totals = await screen.findByTestId("payslip-totals");
    expect(totals.textContent).toContain("$6,700.00");
    expect(totals.textContent).toContain("$6,700.00");

    // Bump the first earning amount input to 7,000.
    const amounts = screen.getAllByLabelText("Amount");
    fireEvent.change(amounts[0], { target: { value: "7000" } });
    await waitFor(() =>
      expect(screen.getByTestId("payslip-totals").textContent).toContain("$7,200.00"),
    );
  });

  it("LOP days auto-compute the pro-rated deduction and adjust net live", async () => {
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("payslip-lop-days"), { target: { value: "2" } });
    // November (30 days): 6,700 × 2 / 30 = 446.67.
    const lop = await screen.findByTestId("payslip-lop-amount");
    expect(lop.textContent).toContain("$446.67");
    await waitFor(() =>
      expect(screen.getByTestId("payslip-totals").textContent).toContain("$6,253.33"),
    );
  });

  it("saving posts the lines + lopDays and the server owns the LOP line", async () => {
    updatePayslip.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("payslip-lop-days"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("payslip-note"), { target: { value: "Welcome bonus month" } });
    fireEvent.click(screen.getByTestId("payslip-save"));
    await waitFor(() =>
      expect(updatePayslip).toHaveBeenCalledWith({
        payslipId: "ps-1",
        earnings: payslip().earnings,
        deductions: [], // manual deductions only — the LOP line is server-side
        lopDays: 1,
        note: "Welcome bonus month",
      }),
    );
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("a server error keeps the modal open with the toast", async () => {
    updatePayslip.mockResolvedValue({ ok: false, error: "The 2026-11 run is locked — payslips are immutable once paid." });
    const { toast } = await import("sonner");
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("payslip-save"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("PayslipModal (LOCKED run)", () => {
  it("renders the stored record read-only with the print button", () => {
    const locked = payslip({
      runStatus: "LOCKED",
      lopDays: 2,
      deductions: [{ key: "lop", label: "Loss of pay (2 days)", amount: 446.67 }],
      net: 6_253.33,
    });
    render(<PayslipModal payslip={locked} onClose={onClose} onChanged={onChanged} />);
    // No editing affordances.
    expect(screen.queryByTestId("payslip-save")).toBeNull();
    expect(screen.queryByTestId("payslip-lop-days")).toBeNull();
    expect(screen.queryByTestId("payslip-add-earnings")).toBeNull();
    // Stored amounts + immutable note + print.
    const totals = screen.getByTestId("payslip-totals");
    expect(totals.textContent).toContain("$6,700.00");
    expect(totals.textContent).toContain("$6,253.33");
    expect(screen.getByTestId("payslip-print")).toBeTruthy();
    expect(updatePayslip).not.toHaveBeenCalled();
  });
});
