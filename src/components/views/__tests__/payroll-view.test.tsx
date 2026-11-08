// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Recruitment R7 — Payroll view tests (docs/RECRUITMENT_MODULE_PLAN.md §6):
// runs list with status chips, payslip table with net + YTD, the payslip
// editor (LOP + live net), and lock gating. All actions are payroll:manage
// gated server-side; the view itself is only reachable by ADMIN/HR.
// ---------------------------------------------------------------------------

const {
  getPayrollData, getPayrollRun, createPayrollRun, lockPayrollRun, getDirectory,
} = vi.hoisted(() => ({
  getPayrollData: vi.fn(),
  getPayrollRun: vi.fn(),
  createPayrollRun: vi.fn(),
  lockPayrollRun: vi.fn(),
  getDirectory: vi.fn(),
}));

vi.mock("@/server-actions/payroll", () => ({
  getPayrollData,
  getPayrollRun,
  createPayrollRun,
  lockPayrollRun,
}));

vi.mock("@/server-actions/hr-directory", () => ({ getDirectory }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// The modals are covered by their own suites; stub them here so this file
// pins the VIEW contract (runs / payslips / structures panels).
vi.mock("@/components/ui/structure-modal", () => ({
  StructureModal: () => <div data-testid="structure-modal-stub" />,
}));
vi.mock("@/components/ui/payslip-modal", () => ({
  PayslipModal: () => <div data-testid="payslip-modal-stub" />,
}));

import { PayrollView } from "@/components/views/payroll-view";
import type { PayrollRunT, PayslipT, SalaryStructureT } from "@/lib/types";

const RUNS: PayrollRunT[] = [
  {
    id: "run-1", period: "2026-11", status: "OPEN", lockedBy: null, lockedAt: null,
    payslipCount: 3, totalGross: 20_100, totalNet: 19_600, workingDays: 21, createdAt: "2026-11-01T00:00:00.000Z",
  },
  {
    id: "run-0", period: "2026-10", status: "LOCKED", lockedBy: "Remy", lockedAt: "2026-11-03T00:00:00.000Z",
    payslipCount: 3, totalGross: 19_600, totalNet: 19_600, workingDays: 21, createdAt: "2026-10-01T00:00:00.000Z",
  },
];

const PAYSLIPS: PayslipT[] = [
  {
    id: "ps-1", runId: "run-1", runPeriod: "2026-11", runStatus: "OPEN", runWorkingDays: 0,
    userId: "u-yuki", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
    slipNo: "PS-2026-11-001",
    earnings: [{ key: "basic", label: "Basic Salary", amount: 6_700 }],
    deductions: [{ key: "lop", label: "Loss of pay (1 day)", amount: 223.33 }],
    note: "", lopDays: 1, lopSource: "MANUAL", version: 0, gross: 6_700, net: 6_476.67, ytdNet: 13_176.67,
  },
];

const STRUCTURES: SalaryStructureT[] = [
  {
    id: "ss-1", userId: "u-yuki", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
    department: "ENGINEERING", source: "MANUAL",
    components: [{ key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 80_400 }],
    notes: "", effectiveFrom: "2026-07-01T00:00:00.000Z", isActive: true,
    createdAt: "2026-07-01T00:00:00.000Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  getPayrollData.mockResolvedValue({ ok: true, data: { structures: STRUCTURES, runs: RUNS } });
  getDirectory.mockResolvedValue({
    ok: true,
    data: { profiles: [{ userId: "u-yuki", name: "Yuki Tanaka" }] },
  });
  getPayrollRun.mockResolvedValue({
    ok: true,
    data: { run: RUNS[0], payslips: PAYSLIPS },
  });
});

describe("PayrollView", () => {
  it("renders the runs with status chips, totals, and the locked-by trail", async () => {
    render(<PayrollView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    expect(await screen.findByTestId("run-row-2026-11")).toBeTruthy();
    expect(screen.getByTestId("run-row-2026-10")).toBeTruthy();
    const open = screen.getByTestId("run-row-2026-11").textContent ?? "";
    expect(open).toContain("OPEN");
    const locked = screen.getByTestId("run-row-2026-10").textContent ?? "";
    expect(locked).toContain("LOCKED");
    expect(locked).toContain("locked by Remy");
  });

  // Persona-audit D-06 / P0-3 (ADR-014): the pre-statutory scope must be
  // stated where payroll is used — permanent, in every environment.
  it("states the pre-statutory scope permanently (D-06, ADR-014)", async () => {
    render(<PayrollView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const banner = await screen.findByTestId("statutory-scope-banner");
    const text = banner.textContent ?? "";
    expect(text).toContain("Pre-statutory payroll");
    expect(text).toContain("PF, ESI, professional tax, TDS, Form 16, investment declarations");
    expect(text).toContain("manual deduction lines");
    expect(text).toContain("ADR-014");
  });

  it("only OPEN runs offer the lock button (with a confirm step)", async () => {
    render(<PayrollView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    await screen.findByTestId("run-row-2026-11");
    expect(screen.getByTestId("lock-run-2026-11")).toBeTruthy();
    expect(screen.queryByTestId("lock-run-2026-10")).toBeNull();
  });

  it("lock flows through the confirm button to the action", async () => {
    lockPayrollRun.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<PayrollView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    await screen.findByTestId("lock-run-2026-11");
    fireEvent.click(screen.getByTestId("lock-run-2026-11"));
    fireEvent.click(await screen.findByTestId("lock-confirm-2026-11"));
    await waitFor(() =>
      expect(lockPayrollRun).toHaveBeenCalledWith({ runId: "run-1" }),
    );
  });

  it("shows the selected run's payslips with net, YTD, and LOP hint", async () => {
    render(<PayrollView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const rows = await screen.findAllByTestId("payslip-row");
    expect(rows).toHaveLength(1);
    const text = rows[0].textContent ?? "";
    expect(text).toContain("Yuki Tanaka");
    expect(text).toContain("PS-2026-11-001");
    expect(text).toContain("LOP 1d");
    expect(text).toContain("YTD");
  });

  it("creating a run posts the picked period", async () => {
    createPayrollRun.mockResolvedValue({ ok: true, data: { id: "run-2", payslipCount: 3 } });
    render(<PayrollView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    await screen.findByTestId("new-run-form");
    fireEvent.change(screen.getByTestId("new-run-period"), { target: { value: "2026-12" } });
    fireEvent.click(screen.getByTestId("create-run-btn"));
    await waitFor(() =>
      expect(createPayrollRun).toHaveBeenCalledWith({ period: "2026-12" }),
    );
  });

  it("lists salary structures with monthly gross and effective date", async () => {
    render(<PayrollView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    const rows = await screen.findAllByTestId("structure-row");
    expect(rows).toHaveLength(1);
    const text = rows[0].textContent ?? "";
    expect(text).toContain("Yuki Tanaka");
    expect(text).toContain("ACTIVE");
    expect(text).toContain("6,700.00/mo");
  });

  it("surfaces a creation error as a toast without navigating", async () => {
    createPayrollRun.mockResolvedValue({ ok: false, error: "A run for 2026-12 already exists." });
    const { toast } = await import("sonner");
    render(<PayrollView currentUser={{ id: "u-hr", name: "Remy", role: "HR" }} />);
    await screen.findByTestId("new-run-form");
    fireEvent.click(screen.getByTestId("create-run-btn"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A run for 2026-12 already exists."));
  });
});
