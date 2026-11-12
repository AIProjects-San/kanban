// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P16 (PR-11 + PR-04) — structure modal: the catalog picker's validity-window
// badges, the client-side refusal pre-check, and the opening-YTD editor that
// rides the save payload.
// ---------------------------------------------------------------------------

const { saveSalaryStructure, createStructureFromOffer, getSalaryComponents, getSalaryStructures } = vi.hoisted(() => ({
  saveSalaryStructure: vi.fn(),
  createStructureFromOffer: vi.fn(),
  getSalaryComponents: vi.fn(),
  // P23 — the default-package prefill fetches the structures list.
  getSalaryStructures: vi.fn(),
}));
vi.mock("@/server-actions/payroll", () => ({ saveSalaryStructure, createStructureFromOffer, getSalaryStructures }));
vi.mock("@/server-actions/payroll-components", () => ({ getSalaryComponents }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="modal-stub">{children}</div> : null,
}));

import { StructureModal } from "@/components/ui/structure-modal";
import type { SalaryComponentT, SalaryStructureT } from "@/lib/types";

const EMPLOYEES = [{ userId: "u-yuki", name: "Yuki Tanaka" }];

function catalogRow(overrides: Partial<SalaryComponentT> = {}): SalaryComponentT {
  return {
    id: "sc-1", code: "study_support", label: "Study Support Payment",
    kind: "EARNING", mode: "FIXED", defaultAmount: 3_000,
    dependsOnPaymentDays: true, effectiveFrom: null, effectiveTo: null,
    isActive: true, sortOrder: 65,
    taxApplicable: true, statutoryCategory: "TAXABLE_EARNING", wageBaseRef: "GROSS", isSystemGenerated: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function structure(edit: Partial<SalaryStructureT> = {}): SalaryStructureT {
  return {
    id: "ss-1", userId: "u-yuki", userName: "Yuki Tanaka", jobTitle: "Data Engineer",
    department: "ENGINEERING", source: "MANUAL",
    components: [{ key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78_000 }],
    notes: "", effectiveFrom: "2026-07-01T00:00:00.000Z", isActive: true,
    createdAt: "2026-07-01T00:00:00.000Z", maxBenefits: 0, frequency: "MONTHLY",
    openingYtd: null,
    // P23 — the workspace default package flag (fixtures default false).
    isDefault: false,
    ...edit,
  };
}

const onClose = vi.fn();
const onChanged = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getSalaryComponents.mockResolvedValue({ ok: true, data: [] });
  saveSalaryStructure.mockResolvedValue({ ok: true, data: { id: "ss-new" } });
  // P23 — no default package by default (the prefill stays the hard-coded
  // basic line, so the pre-P23 tests keep their shapes).
  getSalaryStructures.mockResolvedValue({ ok: true, data: [] });
});

describe("StructureModal — P16 opening YTD editor (PR-04)", () => {
  it("renders the empty-state hint when no opening rows exist", async () => {
    render(<StructureModal open onClose={onClose} onChanged={onChanged} edit={null} employees={EMPLOYEES} />);
    expect(await screen.findByTestId("structure-opening-block")).toBeTruthy();
    expect(screen.getByTestId("structure-opening-block").textContent).toContain("None — payslip YTD starts");
  });

  it("adds rows, edits them, and rides them on the save payload", async () => {
    render(<StructureModal open onClose={onClose} onChanged={onChanged} edit={null} employees={EMPLOYEES} />);
    fireEvent.change(screen.getByTestId("structure-employee"), { target: { value: "u-yuki" } });
    fireEvent.click(await screen.findByTestId("structure-opening-add"));
    const codeInput = screen.getByLabelText("Opening component code");
    fireEvent.change(codeInput, { target: { value: "basic" } });
    fireEvent.change(screen.getByLabelText("Opening component label"), { target: { value: "Basic (prior employer)" } });
    fireEvent.change(screen.getByLabelText("Opening annual amount"), { target: { value: "39000" } });
    // Live totals name the opening gross.
    expect(screen.getByTestId("structure-opening-total").textContent).toContain("$39,000");

    fireEvent.click(screen.getByTestId("structure-save"));
    await vi.waitFor(() => {
      const payload = saveSalaryStructure.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.openingYtd).toEqual([
        { key: "basic", label: "Basic (prior employer)", side: "EARNING", amount: 39_000 },
      ]);
    });
  });

  it("loads an edited structure's stored opening rows into the editor", async () => {
    render(
      <StructureModal
        open
        onClose={onClose}
        onChanged={onChanged}
        edit={structure({
          openingYtd: [{ key: "basic", label: "Basic (prior)", side: "EARNING", amount: 39_000 }],
        })}
        employees={EMPLOYEES}
      />,
    );
    expect(await screen.findByLabelText("Opening component code")).toBeTruthy();
    expect(screen.getByLabelText("Opening component code")).toHaveProperty("value", "basic");
    expect(screen.getByTestId("structure-opening-total").textContent).toContain("$39,000");
  });
});

describe("StructureModal — P16 catalog window badges (PR-11)", () => {
  it("picker options append the window hint and offending lines pre-warn", async () => {
    getSalaryComponents.mockResolvedValue({
      ok: true,
      data: [catalogRow({ code: "study_support", effectiveFrom: "2026-04-01", effectiveTo: "2027-03-31" })],
    });
    render(<StructureModal open onClose={onClose} onChanged={onChanged} edit={null} employees={EMPLOYEES} />);
    const picker = await screen.findByTestId("structure-catalog-picker");
    expect(picker.textContent).toContain("Study Support Payment (study_support)");
    // The effective date defaults to today (2026-11) — inside the window, so
    // the option shows the "ends" hint but no warning line yet.
    expect(picker.textContent).toContain("ends 2027-03-31");
    expect(screen.queryByTestId("structure-window-warnings")).toBeNull();

    // Move the effective date past the window's end → the warning appears.
    fireEvent.change(screen.getByTestId("structure-effective"), { target: { value: "2027-04-15" } });
    expect(screen.queryByTestId("structure-window-warnings")).toBeNull(); // no line picked yet

    // Pick the component from the catalog, then move the date out of range.
    fireEvent.change(picker, { target: { value: "study_support" } });
    fireEvent.change(screen.getByTestId("structure-effective"), { target: { value: "2027-04-15" } });
    const warn = screen.getByTestId("structure-window-warnings");
    expect(warn.textContent).toContain("study_support — expired 2027-03-31");
  });
});

// ---------------------------------------------------------------------------
// P23 (PR-02/PR-03) — the percent modes + the workspace default package:
// the mode picker offers % gross everywhere and % net only on deductions;
// percent-of-net lines annotate "at payroll"; the unresolved note keeps the
// totals honest; the default-package checkbox rides the save payload; the
// default structure prefills a NEW editor session.
// ---------------------------------------------------------------------------

describe("StructureModal — P23 percent modes (PR-02/PR-03)", () => {
  it("offers % gross and % net in the mode picker (% net disabled off-deductions)", async () => {
    render(<StructureModal open onClose={onClose} onChanged={onChanged} edit={null} employees={EMPLOYEES} />);
    const modeSelect = await screen.findByLabelText("Mode");
    const options = Array.from(modeSelect.querySelectorAll("option"));
    expect(options.map((o) => o.textContent)).toEqual(["$/yr", "% basic", "% gross", "% net"]);
    // The starter line is an EARNING → the % net option is disabled.
    const netOption = options.find((o) => o.getAttribute("value") === "PERCENT_OF_NET");
    expect(netOption?.hasAttribute("disabled")).toBe(true);
  });

  it("a percent-of-gross deduction line resolves in the live column; % net annotates 'at payroll'", async () => {
    render(<StructureModal open onClose={onClose} onChanged={onChanged} edit={null} employees={EMPLOYEES} />);
    // Starter: basic 60,000 EARNING (row 0). Add a blank row and make it a
    // percent-of-gross DEDUCTION (union dues 1%).
    fireEvent.click(await screen.findByTestId("structure-add-component"));
    const kindSelect = screen.getAllByLabelText("Kind")[1];
    fireEvent.change(kindSelect, { target: { value: "DEDUCTION" } });
    const modeSelect = screen.getAllByLabelText("Mode")[1];
    fireEvent.change(modeSelect, { target: { value: "PERCENT_OF_GROSS" } });
    const amount = screen.getAllByLabelText("Percent")[0];
    fireEvent.change(amount, { target: { value: "1" } });
    // 1% × 60,000 = 600 annual.
    expect(screen.getByTestId("structure-component-1-resolved").textContent).toBe("$600");

    // Now flip it to percent-of-net (allowed on a DEDUCTION).
    fireEvent.change(modeSelect, { target: { value: "PERCENT_OF_NET" } });
    expect(screen.getByTestId("structure-component-1-resolved").textContent).toBe("at payroll");
    // The honesty note names the unresolved line.
    expect(screen.getByTestId("structure-unresolved-note").textContent).toContain("percent-of-net");
    expect(screen.getByTestId("structure-unresolved-note").textContent).toContain("payroll time");
  });

  it("the default-package checkbox rides the save payload", async () => {
    render(<StructureModal open onClose={onClose} onChanged={onChanged} edit={null} employees={EMPLOYEES} />);
    fireEvent.change(await screen.findByTestId("structure-employee"), { target: { value: "u-yuki" } });
    fireEvent.click(screen.getByTestId("structure-default-package"));
    fireEvent.click(screen.getByTestId("structure-save"));
    await vi.waitFor(() => {
      const payload = saveSalaryStructure.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.isDefault).toBe(true);
    });
  });

  it("the workspace default package prefills a NEW structure (replacing the hard-coded starter)", async () => {
    getSalaryStructures.mockResolvedValue({
      ok: true,
      data: [
        structure({
          id: "ss-pkg",
          isDefault: true,
          components: [
            { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 70_000 },
            { key: "variable_pay", label: "Variable Pay Allowance", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 8 },
          ],
        }),
      ],
    });
    render(<StructureModal open onClose={onClose} onChanged={onChanged} edit={null} employees={EMPLOYEES} />);
    await vi.waitFor(() => {
      // Two rows rendered — the prefill landed (the starter was one row).
      expect(screen.getAllByTestId(/^structure-component-\d+$/)).toHaveLength(2);
    });
    expect(screen.getByTestId("structure-component-1-resolved").textContent).toBe("$5,600");
  });

  it("an EDIT session loads the edit's own components — the default package never clobbers it", async () => {
    getSalaryStructures.mockResolvedValue({
      ok: true,
      data: [
        structure({
          id: "ss-pkg",
          isDefault: true,
          components: [
            { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 70_000 },
            { key: "variable_pay", label: "Variable Pay Allowance", kind: "EARNING", mode: "PERCENT_OF_GROSS", amount: 8 },
          ],
        }),
      ],
    });
    render(
      <StructureModal
        open
        onClose={onClose}
        onChanged={onChanged}
        edit={structure({ components: [{ key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78_000 }] })}
        employees={EMPLOYEES}
      />,
    );
    await vi.waitFor(() => {
      expect(screen.getAllByTestId(/^structure-component-\d+$/)).toHaveLength(1);
    });
  });
});
