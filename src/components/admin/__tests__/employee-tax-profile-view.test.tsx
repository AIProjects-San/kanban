// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P0 pre-filing item 4 — the employee tax profile editor's IRD range guard.
// A saved IRD that passes the mod-11 check digit but sits OUTSIDE IRD's
// issued range [10,000,000–200,000,000] (spec 5.8 step 1 — every seeded
// demo IRD, e.g. 752783373) must show the "demo data" warning so an admin
// catches it before the first real filing. The warning never blocks the
// save: myIR accepts those lines with a warning, not an error. A
// check-digit failure keeps showing only the mod-11 error.
// ---------------------------------------------------------------------------

const { saveEmployeeTaxProfile } = vi.hoisted(() => ({ saveEmployeeTaxProfile: vi.fn() }));

vi.mock("@/server-actions/tax-admin", () => ({ saveEmployeeTaxProfile }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { EmployeeTaxProfileView } from "@/components/admin/employee-tax-profile-view";
import type { EmployeeTaxProfileT } from "@/lib/types";

function profile(over: Partial<EmployeeTaxProfileT>): EmployeeTaxProfileT {
  return {
    userId: "u-1",
    userName: "Hana Doe",
    userEmail: "hana@fernly.app",
    exists: true,
    irdNumber: "",
    taxCodeBase: "M",
    studentLoan: false,
    taxCodeEffectiveFrom: "",
    stcCertificateRate: null,
    stcAccTreatment: "INC",
    stcStudentLoanRate: null,
    stcCertificateExpiry: "",
    kiwiSaverStatus: "ACTIVE",
    kiwiSaverEmployeeRate: null,
    kiwiSaverEmployerRate: null,
    esctRateOverride: null,
    employmentType: "PERMANENT",
    casualHolidayPayInWages: false,
    employmentStartDate: "2024-07-15",
    employmentEndDate: "",
    notes: "",
    allowedEmployeeRates: [3, 3.5, 4, 6, 8, 10],
    defaultEmployeeRate: 3.5,
    employerRate: 3.5,
    ...over,
  };
}

describe("EmployeeTaxProfileView — IRD issued-range guard (P0 item 4)", () => {
  it("a saved IRD outside the issued range shows the demo-data warning (not a save blocker)", () => {
    render(<EmployeeTaxProfileView profile={profile({ irdNumber: "752783373" })} today="2026-11-13" />);
    // The seeded demo IRD: mod-11 valid, but 752,783,373 > 200,000,000.
    expect(screen.getByText(/demo data/i)).toBeTruthy();
    expect(screen.getByText(/Outside IRD’s issued range \(10,000,000–200,000,000\)/)).toBeTruthy();
    // The warning does not block the save the way a check-digit failure does.
    expect(screen.queryByText(/Fails the mod-11 check digit/i)).toBeNull();
  });

  it("an in-range valid IRD (IRD's own spec example 49091850) shows no warning", () => {
    render(<EmployeeTaxProfileView profile={profile({ irdNumber: "49091850" })} today="2026-11-13" />);
    expect(screen.queryByText(/demo data/i)).toBeNull();
    expect(screen.queryByText(/issued range/i)).toBeNull();
  });

  it("a check-digit failure shows the mod-11 error only — the range warning stays out of the way", () => {
    // 752783374 breaks the check digit AND is out of range: the mod-11 error
    // is the actionable one, so the demo-data warning must not also render.
    render(<EmployeeTaxProfileView profile={profile({ irdNumber: "752783374" })} today="2026-11-13" />);
    expect(screen.getByText(/Fails the mod-11 check digit/i)).toBeTruthy();
    expect(screen.queryByText(/demo data/i)).toBeNull();
  });
});
