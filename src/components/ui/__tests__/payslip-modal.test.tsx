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
    note: "", lopDays: 0, lopSource: "AUTO", paidDays: null, lopDetail: null, version: 0, gross: 6_700, net: 6_700, ytdNet: 13_400, ytdGross: 13_400, mtdNet: 6_700, componentYtd: [{ key: "basic", label: "Basic Salary", side: "EARNING", amount: 13_000 }, { key: "transport", label: "Transport Allowance", side: "EARNING", amount: 400 }], withholdStatus: "",
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

  it("P15 (PR-06) — the frozen LOP breakdown lists leave rows with fractions and attendance docks", () => {
    const locked = payslip({
      runStatus: "LOCKED",
      lopDays: 2,
      lopSource: "AUTO",
      deductions: [{ key: "lop", label: "Loss of pay (2 days)", amount: 638.1 }],
      net: 6_061.9,
      lopDetail: {
        absentDays: 1,
        halfDays: 0,
        unmarkedDays: 0,
        leave: [
          { leaveTypeId: "lt-half", code: "HALF_PAY", name: "Half-pay Study Leave", takenDays: 2, chargedDays: 1, fraction: 0.5, paid: true },
          { leaveTypeId: "lt-annual", code: "ANNUAL", name: "Annual Leave", takenDays: 1, chargedDays: 0, fraction: 1, paid: true },
        ],
      },
    });
    render(<PayslipModal payslip={locked} onClose={onClose} onChanged={onChanged} />);
    const detail = screen.getByTestId("payslip-lop-detail");
    expect(detail.textContent).toContain("Half-pay Study Leave: 2 days taken at 50% salary → 1 day charged");
    // A fully-paid row rides along at zero charge (the child lists the
    // applications, not only the docking ones).
    expect(detail.textContent).toContain("Annual Leave: 1 day taken → 0 days charged");
    expect(detail.textContent).toContain("Attendance docks: 1 absent + 0 half-day");
  });

  it("P15 (PR-06) — a MANUAL override shows no breakdown (it was cleared) and the note says so", () => {
    const locked = payslip({
      runStatus: "LOCKED",
      lopDays: 1,
      lopSource: "MANUAL",
      deductions: [{ key: "lop", label: "Loss of pay (1 day)", amount: 319.05 }],
      net: 6_380.95,
      lopDetail: null,
    });
    render(<PayslipModal payslip={locked} onClose={onClose} onChanged={onChanged} />);
    expect(screen.queryByTestId("payslip-lop-detail")).toBeNull();
    expect(screen.getByTestId("payslip-lop-source").textContent).toContain("manually set by HR");
  });

  it("F1.4 — a locked slip with zero LOP days shows no provenance box", () => {
    const locked = payslip({ runStatus: "LOCKED", lopDays: 0 });
    render(<PayslipModal payslip={locked} onClose={onClose} onChanged={onChanged} />);
    expect(screen.queryByTestId("payslip-lop-source")).toBeNull();
  });
});

describe("PayslipModal — P16 (PR-11) fiscal-year YTD chip", () => {
  it("shows the FY chip + basis note when the workspace basis is April; nothing at calendar year", () => {
    const { rerender } = render(
      <PayslipModal payslip={payslip({ fiscalYearStartMonth: 4 })} onClose={onClose} onChanged={onChanged} />,
    );
    // Nov 2026 falls in FY 2026/27 (Apr 2026 – Mar 2027).
    const totals = screen.getByTestId("payslip-totals");
    expect(totals.textContent).toContain("2026/27");
    expect(screen.getByTestId("payslip-ytd-basis").textContent).toContain("fiscal year 2026/27");

    // Calendar-year basis (or field absent): no chip, byte-identical note.
    rerender(<PayslipModal payslip={payslip({ fiscalYearStartMonth: 1 })} onClose={onClose} onChanged={onChanged} />);
    expect(screen.getByTestId("payslip-totals").textContent).not.toContain("2026/27");
    expect(screen.getByTestId("payslip-ytd-basis").textContent).not.toContain("fiscal year");
  });
});

// ---------------------------------------------------------------------------
// P17 — PR-B25 (leave balances on the slip, read-time) + PR-B27 (the basis
// note on the AUTO provenance box).
// ---------------------------------------------------------------------------

describe("PayslipModal — P17 (PR-B25 / PR-B27)", () => {
  it("PR-B25 — renders the live leave-balances box when the payload carries balances", () => {
    render(
      <PayslipModal
        payslip={payslip({
          leaveBalances: [
            { typeName: "Annual Leave", availableDays: 12.5 },
            { typeName: "Sick Leave", availableDays: 3 },
          ],
        })}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
    const box = screen.getByTestId("payslip-leave-balances");
    expect(box.textContent).toContain("Annual Leave");
    expect(box.textContent).toContain("12.5");
    expect(box.textContent).toContain("Sick Leave");
    expect(box.textContent).toContain("3");
    // The honesty line: read-time, not part of the frozen record.
    expect(box.textContent).toContain("not part of the frozen payslip record");
  });

  it("PR-B25 — no balances field (toggle off / older payload) → no box at all", () => {
    render(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    expect(screen.queryByTestId("payslip-leave-balances")).toBeNull();
  });

  it("PR-B27 — the AUTO note names a non-HYBRID basis; HYBRID (default) stays silent", () => {
    const { rerender } = render(
      <PayslipModal
        payslip={payslip()}
        lopBasisMode="LEAVE"
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByTestId("payslip-lop-source").textContent).toContain("Proration basis: LEAVE only");

    rerender(
      <PayslipModal
        payslip={payslip()}
        lopBasisMode="ATTENDANCE"
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByTestId("payslip-lop-source").textContent).toContain("ATTENDANCE only — leave never charges loss-of-pay");

    // Default HYBRID = the pre-P17 note byte-for-byte.
    rerender(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    expect(screen.getByTestId("payslip-lop-source").textContent).not.toContain("Proration basis");
  });
});

// ---------------------------------------------------------------------------
// P19 (PR-P01–03) — the print-format variants (classic / compact /
// detailed) on the LOCKED print surface. Screen output never changes; the
// variants are @media-print visibility keyed off the form's
// data-print-format, plus the DETAILED-only meta footer.
// ---------------------------------------------------------------------------

describe("PayslipModal — P19 (PR-P01–03) print formats", () => {
  const locked = () => payslip({
    runStatus: "LOCKED",
    lopDays: 2,
    deductions: [{ key: "lop", label: "Loss of pay (2 days)", amount: 446.67 }],
    net: 6_253.33,
  });

  beforeEach(() => {
    window.localStorage.removeItem("fernly-payslip-print-format");
  });

  it("the picker renders on LOCKED runs only, defaulting to CLASSIC", () => {
    const { rerender } = render(<PayslipModal payslip={locked()} onClose={onClose} onChanged={onChanged} />);
    const picker = screen.getByTestId("payslip-print-format");
    expect(picker).toBeTruthy();
    expect(screen.getByTestId("payslip-modal").getAttribute("data-print-format")).toBe("CLASSIC");
    // Only the active variant is aria-pressed.
    expect(screen.getByTestId("payslip-print-format-CLASSIC").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("payslip-print-format-DETAILED").getAttribute("aria-pressed")).toBe("false");

    // OPEN runs never show the picker (printing is a LOCKED affordance).
    rerender(<PayslipModal payslip={payslip()} onClose={onClose} onChanged={onChanged} />);
    expect(screen.queryByTestId("payslip-print-format")).toBeNull();
  });

  it("choosing a variant switches data-print-format and persists the choice", () => {
    render(<PayslipModal payslip={locked()} onClose={onClose} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("payslip-print-format-COMPACT"));
    expect(screen.getByTestId("payslip-modal").getAttribute("data-print-format")).toBe("COMPACT");
    expect(window.localStorage.getItem("fernly-payslip-print-format")).toBe("COMPACT");

    fireEvent.click(screen.getByTestId("payslip-print-format-DETAILED"));
    expect(screen.getByTestId("payslip-modal").getAttribute("data-print-format")).toBe("DETAILED");
    expect(window.localStorage.getItem("fernly-payslip-print-format")).toBe("DETAILED");
  });

  it("the DETAILED-only meta footer renders in DETAILED (slip identity + withhold state), never in CLASSIC", () => {
    const withheld = payslip({ ...locked(), withholdStatus: "WITHHELD" });
    const { rerender } = render(<PayslipModal payslip={withheld} onClose={onClose} onChanged={onChanged} />);
    // CLASSIC default: no meta footer.
    expect(screen.queryByTestId("payslip-print-meta")).toBeNull();

    fireEvent.click(screen.getByTestId("payslip-print-format-DETAILED"));
    const meta = screen.getByTestId("payslip-print-meta");
    expect(meta.textContent).toContain("PS-2026-11-001");
    expect(meta.textContent).toContain("2026-11");
    expect(meta.textContent).toContain("WITHHELD");
    expect(meta.textContent).toContain("printed");

    // Compact: back to nothing.
    fireEvent.click(screen.getByTestId("payslip-print-format-COMPACT"));
    expect(screen.queryByTestId("payslip-print-meta")).toBeNull();
    rerender(<PayslipModal payslip={locked()} onClose={onClose} onChanged={onChanged} />);
  });

  it("a stored choice preselects the variant on the next open", () => {
    window.localStorage.setItem("fernly-payslip-print-format", "DETAILED");
    render(<PayslipModal payslip={locked()} onClose={onClose} onChanged={onChanged} />);
    expect(screen.getByTestId("payslip-modal").getAttribute("data-print-format")).toBe("DETAILED");
    expect(screen.getByTestId("payslip-print-format-DETAILED").getAttribute("aria-pressed")).toBe("true");
  });

  it("a garbage stored value falls back to CLASSIC (no fourth variant)", () => {
    window.localStorage.setItem("fernly-payslip-print-format", "GARBAGE");
    render(<PayslipModal payslip={locked()} onClose={onClose} onChanged={onChanged} />);
    expect(screen.getByTestId("payslip-modal").getAttribute("data-print-format")).toBe("CLASSIC");
  });
});
