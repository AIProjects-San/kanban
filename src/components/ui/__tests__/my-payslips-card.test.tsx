// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Persona-audit P0-1 (D-02) — dashboard MyPayslipsCard: renders ONLY when the
// signed-in user has at least one finalized payslip (no empty card for users
// without payroll history) and links to the my-payslips view.
// ---------------------------------------------------------------------------

const { getMyPayslips } = vi.hoisted(() => ({ getMyPayslips: vi.fn() }));

vi.mock("@/server-actions/payroll", () => ({ getMyPayslips }));

import { MyPayslipsCard } from "@/components/ui/my-payslips-card";
import type { PayslipT } from "@/lib/types";

const LATEST: PayslipT = {
  id: "ps-26-10", runId: "run-0", runPeriod: "2026-10", runStatus: "LOCKED", runWorkingDays: 0,
  userId: "u-yuki", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
  slipNo: "PS-2026-10-002",
  earnings: [{ key: "basic", label: "Basic Salary", amount: 6_500 }],
  deductions: [], note: "", lopDays: 0, lopSource: "AUTO", gross: 6_500, net: 6_300, ytdNet: 6_300,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MyPayslipsCard (P0-1 / D-02)", () => {
  it("renders the latest finalized net with a link to My Payslips", async () => {
    getMyPayslips.mockResolvedValue({ ok: true, data: [LATEST] });
    render(<MyPayslipsCard />);
    await waitFor(() => expect(screen.getByTestId("my-payslips-card")).toBeTruthy());
    expect(screen.getByTestId("my-payslips-card").textContent).toContain("$6,300.00");
    expect(screen.getByTestId("my-payslips-card").textContent).toContain("October 2026");
    expect(screen.getByTestId("my-payslips-card-link").textContent).toContain("My Payslips");
  });

  it("renders nothing when the user has no finalized payslips", async () => {
    getMyPayslips.mockResolvedValue({ ok: true, data: [] });
    const { container } = render(<MyPayslipsCard />);
    // Wait for the fetch to settle, then assert no card.
    await waitFor(() => expect(getMyPayslips).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="my-payslips-card"]')).toBeNull();
  });

  it("renders nothing on error (never a broken card on the dashboard)", async () => {
    getMyPayslips.mockResolvedValue({ ok: false, error: "boom" });
    const { container } = render(<MyPayslipsCard />);
    await waitFor(() => expect(getMyPayslips).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="my-payslips-card"]')).toBeNull();
  });
});
