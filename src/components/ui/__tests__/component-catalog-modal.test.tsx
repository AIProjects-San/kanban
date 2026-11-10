// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P23 (PR-02/PR-03) — the component catalog modal: the widened percent-mode
// vocabulary (% gross everywhere, % net only on deductions), the percent
// amount label, and the mode-aware row display.
// ---------------------------------------------------------------------------

const { getSalaryComponents, saveSalaryComponent, deleteSalaryComponent } = vi.hoisted(() => ({
  getSalaryComponents: vi.fn(),
  saveSalaryComponent: vi.fn(),
  deleteSalaryComponent: vi.fn(),
}));
vi.mock("@/server-actions/payroll-components", () => ({
  getSalaryComponents,
  saveSalaryComponent,
  deleteSalaryComponent,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="modal-stub">{children}</div> : null,
}));

import { ComponentCatalogModal } from "@/components/ui/component-catalog-modal";
import type { SalaryComponentT } from "@/lib/types";

function row(overrides: Partial<SalaryComponentT> = {}): SalaryComponentT {
  return {
    id: "sc-1", code: "basic", label: "Basic Salary",
    kind: "EARNING", mode: "FIXED", defaultAmount: 84_000,
    dependsOnPaymentDays: true, effectiveFrom: null, effectiveTo: null,
    isActive: true, sortOrder: 10, createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const onClose = vi.fn();
const onChanged = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getSalaryComponents.mockResolvedValue({ ok: true, data: [] });
  saveSalaryComponent.mockResolvedValue({ ok: true, data: { id: "sc-new" } });
  deleteSalaryComponent.mockResolvedValue({ ok: true, data: { ok: true } });
});

describe("ComponentCatalogModal — P23 percent modes", () => {
  it("renders percent-mode rows with their basis (% gross / % net)", async () => {
    getSalaryComponents.mockResolvedValue({
      ok: true,
      data: [
        row(),
        row({ id: "sc-2", code: "variable_pay", label: "Variable Pay Allowance", kind: "EARNING", mode: "PERCENT_OF_GROSS", defaultAmount: 8 }),
        row({ id: "sc-3", code: "advance_recovery", label: "Advance Recovery", kind: "DEDUCTION", mode: "PERCENT_OF_NET", defaultAmount: 6 }),
        row({ id: "sc-4", code: "kiwisaver", label: "KiwiSaver", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", defaultAmount: 3 }),
      ],
    });
    render(<ComponentCatalogModal open onClose={onClose} onChanged={onChanged} />);
    expect((await screen.findByTestId("catalog-row-variable_pay")).textContent).toContain("8% gross");
    expect(screen.getByTestId("catalog-row-advance_recovery").textContent).toContain("6% net");
    expect(screen.getByTestId("catalog-row-kiwisaver").textContent).toContain("3% basic");
    expect(screen.getByTestId("catalog-row-basic").textContent).toContain("$84,000/yr");
  });

  it("the editor offers % net only when the kind is a deduction", async () => {
    getSalaryComponents.mockResolvedValue({ ok: true, data: [row()] });
    render(<ComponentCatalogModal open onClose={onClose} onChanged={onChanged} />);
    fireEvent.click(await screen.findByLabelText("Edit basic"));
    const modeSelect = await screen.findByLabelText("Mode");
    let netOption = Array.from(modeSelect.querySelectorAll("option")).find((o) => o.getAttribute("value") === "PERCENT_OF_NET");
    // EARNING kind → % net disabled.
    expect(netOption?.hasAttribute("disabled")).toBe(true);

    // Switch the kind to DEDUCTION → the option enables.
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "DEDUCTION" } });
    netOption = Array.from(modeSelect.querySelectorAll("option")).find((o) => o.getAttribute("value") === "PERCENT_OF_NET");
    expect(netOption?.hasAttribute("disabled")).toBe(false);

    // Pick it and check the amount field relabels to Percent.
    fireEvent.change(modeSelect, { target: { value: "PERCENT_OF_NET" } });
    expect(screen.getByTestId("catalog-amount").getAttribute("aria-label")).not.toBe("");
    expect(screen.getByText("Percent")).toBeTruthy();
  });

  it("saves a percent-of-net deduction row", async () => {
    getSalaryComponents.mockResolvedValue({ ok: true, data: [] });
    render(<ComponentCatalogModal open onClose={onClose} onChanged={onChanged} />);
    // Start the blank editor: code + label + DEDUCTION kind + % net mode.
    fireEvent.click(await screen.findByTestId("catalog-add"));
    fireEvent.change(screen.getByTestId("catalog-code"), { target: { value: "advance_recovery" } });
    fireEvent.change(screen.getByTestId("catalog-label"), { target: { value: "Advance Recovery" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "DEDUCTION" } });
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "PERCENT_OF_NET" } });
    fireEvent.change(screen.getByTestId("catalog-amount"), { target: { value: "6" } });
    fireEvent.click(screen.getByTestId("catalog-save"));
    await waitFor(() => expect(saveSalaryComponent).toHaveBeenCalled());
    const payload = saveSalaryComponent.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ code: "advance_recovery", kind: "DEDUCTION", mode: "PERCENT_OF_NET", defaultAmount: 6 });
  });
});
