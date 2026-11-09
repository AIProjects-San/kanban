// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P16 (PR-11 + PR-04) — structure modal: the catalog picker's validity-window
// badges, the client-side refusal pre-check, and the opening-YTD editor that
// rides the save payload.
// ---------------------------------------------------------------------------

const { saveSalaryStructure, createStructureFromOffer, getSalaryComponents } = vi.hoisted(() => ({
  saveSalaryStructure: vi.fn(),
  createStructureFromOffer: vi.fn(),
  getSalaryComponents: vi.fn(),
}));
vi.mock("@/server-actions/payroll", () => ({ saveSalaryStructure, createStructureFromOffer }));
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
    isActive: true, sortOrder: 65, createdAt: "2026-01-01T00:00:00.000Z",
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
    ...edit,
  };
}

const onClose = vi.fn();
const onChanged = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getSalaryComponents.mockResolvedValue({ ok: true, data: [] });
  saveSalaryStructure.mockResolvedValue({ ok: true, data: { id: "ss-new" } });
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
