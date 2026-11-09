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
    id: "ps-1", runId: "run-1", runPeriod: "2026-11", runStatus: "OPEN", runWorkingDays: 0,
    userId: "u-yuki", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
    slipNo: "PS-2026-11-001",
    earnings: [
      { key: "basic", label: "Basic Salary", amount: 6_500 },
      { key: "transport", label: "Transport Allowance", amount: 200 },
    ],
    deductions: [],
    note: "", lopDays: 0, lopSource: "AUTO", paidDays: null, version: 0, gross: 6_700, net: 6_700, ytdNet: 13_400, ytdGross: 13_400, mtdNet: 6_700, componentYtd: [{ key: "basic", label: "Basic Salary", side: "EARNING", amount: 13_000 }, { key: "transport", label: "Transport Allowance", side: "EARNING", amount: 400 }], withholdStatus: "",
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

  it("F1.4 — half-day LOP values type and compute correctly (1.5 days)", async () => {
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    // Decimal typing exercises the string-state input: "1", "1.", "1.5".
    const input = screen.getByTestId("payslip-lop-days") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(input.value).toBe("1.5");
    // 6,700 × 1.5 / 30 = 335 → net 6,365.00.
    const lop = await screen.findByTestId("payslip-lop-amount");
    expect(lop.textContent).toContain("$335.00");
    await waitFor(() =>
      expect(screen.getByTestId("payslip-totals").textContent).toContain("$6,365.00"),
    );
  });

  it("F1.4 — the provenance note reflects lopSource (AUTO → derived, MANUAL → override)", async () => {
    const { rerender } = render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    expect(screen.getByTestId("payslip-lop-source").textContent).toContain("Auto-derived");
    rerender(<PayslipModal payslip={payslip({ lopSource: "MANUAL" })} onClose={onClose} onChanged={onChanged} />);
    await waitFor(() =>
      expect(screen.getByTestId("payslip-lop-source").textContent).toContain("Manually set"),
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
        expectedVersion: 0, // F-R2 — the loaded version rides every save
        earnings: payslip().earnings,
        deductions: [], // manual deductions only — the LOP line is server-side
        lopDays: 1,
        note: "Welcome bonus month",
      }),
    );
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("F-R3 (S15) — the YTD line explains the HR basis vs the employee's locked-only basis", () => {
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    const basis = screen.getByTestId("payslip-ytd-basis");
    expect(basis.textContent).toContain("HR basis");
    expect(basis.textContent).toContain("locked (paid) runs only");
  });

  it("P11 (PR-B09) — shows YTD gross, MTD net and per-line component YTD", () => {
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    // The totals box carries the three read-time aggregates.
    expect(screen.getByTestId("payslip-ytd-gross").textContent).toBe("$13,400.00");
    expect(screen.getByTestId("payslip-ytd-net").textContent).toBe("$13,400.00");
    expect(screen.getByTestId("payslip-mtd-net").textContent).toBe("$6,700.00");
    // Each earnings line shows its component YTD (basic 13,000 /
    // transport 400 through this period).
    expect(screen.getByTestId("payslip-earnings-ytd-0").textContent).toContain("$13,000.00");
    expect(screen.getByTestId("payslip-earnings-ytd-1").textContent).toContain("$400.00");
  });

  it("F-R2 — a conflict error keeps the modal open (the toast says who saved first)", async () => {
    updatePayslip.mockResolvedValue({
      ok: false,
      error: "Payslip PS-2026-11-001 was saved by someone else while you were editing. Reopen it to see their changes, then re-apply your edit.",
    });
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("payslip-save"));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("saved by someone else"),
    ));
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
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

  it("F1.4 — the paid record shows the read-only LOP provenance note", () => {
    const locked = payslip({
      runStatus: "LOCKED",
      lopDays: 1,
      lopSource: "AUTO",
      deductions: [{ key: "lop", label: "Loss of pay (1 day)", amount: 223.33 }],
      net: 6_476.67,
    });
    render(<PayslipModal payslip={locked} onClose={onClose} onChanged={onChanged} />);
    const note = screen.getByTestId("payslip-lop-source");
    expect(note.textContent).toContain("Loss of pay: 1 day");
    expect(note.textContent).toContain("auto-derived");
  });

  it("F1.4 — a locked slip with zero LOP days shows no provenance box", () => {
    const locked = payslip({ runStatus: "LOCKED", lopDays: 0 });
    render(<PayslipModal payslip={locked} onClose={onClose} onChanged={onChanged} />);
    expect(screen.queryByTestId("payslip-lop-source")).toBeNull();
  });
});
