// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P33 (EM-06/EM-01/EM-B02) — the directory's promotion/transfer surface:
//   • the card's Promote / transfer button (canAdmin-gated) opens the modal
//     and a submit flows to applyEmploymentChange with the form's payload;
//     success toasts + reloads, failure toasts and keeps the modal open
//   • the profile modal's retirement projection (EM-B02) renders ONLY when
//     the workspace age is configured and the birthday is on file
//   • the structured employment-changes panel (EM-06) lazy-loads on expand
// ---------------------------------------------------------------------------

const { getDirectory, getMyProfile, upsertMyProfile, updateProfileAsAdmin, exportDirectoryCsv, transitionEmployment, applyEmploymentChange, getEmploymentHistory } = vi.hoisted(() => ({
  getDirectory: vi.fn(),
  getMyProfile: vi.fn(),
  upsertMyProfile: vi.fn(),
  updateProfileAsAdmin: vi.fn(),
  exportDirectoryCsv: vi.fn(),
  transitionEmployment: vi.fn(),
  applyEmploymentChange: vi.fn(),
  getEmploymentHistory: vi.fn(),
}));

vi.mock("@/server-actions/hr-directory", () => ({
  getDirectory,
  getMyProfile,
  upsertMyProfile,
  updateProfileAsAdmin,
  exportDirectoryCsv,
}));

vi.mock("@/server-actions/employment", () => ({
  transitionEmployment,
  applyEmploymentChange,
  getEmploymentHistory,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { DirectoryTab } from "@/components/views/hr-directory";

const PROFILE = {
  id: "ep-1", userId: "u-1", employeeNumber: "EMP-0003", leaveApproverId: null,
  name: "Theo Vance", email: "theo@x.co", role: "MEMBER", managerName: "Ada Lovelace",
  jobTitle: "Senior Frontend Engineer", department: "ENGINEERING",
  hireDate: "2024-06-10", birthDate: "1992-06-14", phone: "+64 21 555 0003", location: "Auckland, NZ",
  emergencyContactName: "Rae Vance", emergencyContactPhone: "+64 21 555 0199",
  skills: "React, TypeScript", notes: "HR note", employmentStatus: "ACTIVE",
  probationEndsAt: null, noticePeriodWeeks: null, lastWorkingDay: null,
};

function directoryPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      profiles: [PROFILE],
      canAdmin: true,
      retirementAge: 65,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDirectory.mockResolvedValue(directoryPayload());
  updateProfileAsAdmin.mockResolvedValue({ ok: true });
  applyEmploymentChange.mockResolvedValue({ ok: true, data: { applied: 2 } });
  getEmploymentHistory.mockResolvedValue({ ok: true, data: [] });
});

describe("P33 — the Promote / transfer button and modal (EM-06/EM-01)", () => {
  it("renders for canAdmin holders", async () => {
    render(<DirectoryTab />);
    expect(await screen.findAllByTestId("directory-promote")).toHaveLength(1);
  });

  it("never renders for plain hr:view readers (the roster's own gate)", async () => {
    getDirectory.mockResolvedValue(directoryPayload({ canAdmin: false }));
    render(<DirectoryTab />);
    await screen.findAllByTestId("hr-directory");
    expect(screen.queryAllByTestId("directory-promote")).toHaveLength(0);
  });

  it("opens the modal prefilled with the member's current facts; a submit flows to the action", async () => {
    render(<DirectoryTab />);
    fireEvent.click((await screen.findAllByTestId("directory-promote"))[0]);

    const titleInput = await screen.findByTestId("employment-change-title");
    expect((titleInput as HTMLInputElement).value).toBe("Senior Frontend Engineer");

    fireEvent.change(titleInput, { target: { value: "Lead Frontend Engineer" } });
    fireEvent.change(screen.getByTestId("employment-change-kind"), { target: { value: "TRANSFER" } });
    fireEvent.click(screen.getByTestId("employment-change-submit"));

    await waitFor(() => {
      expect(applyEmploymentChange).toHaveBeenCalledWith(
        "u-1",
        expect.objectContaining({
          kind: "TRANSFER",
          jobTitle: "Lead Frontend Engineer",
          department: "ENGINEERING",
          effectiveDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });
    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Transfer applied — 2 property changes recorded\./));
    // The roster reloads after an applied change.
    await waitFor(() => expect(getDirectory).toHaveBeenCalledTimes(2));
  });

  it("a refusal surfaces as an error toast and keeps the modal open (fix and retry)", async () => {
    applyEmploymentChange.mockResolvedValue({ ok: false, error: "Nothing to record — pick at least one property to change (title, department, manager or salary)." });
    render(<DirectoryTab />);
    fireEvent.click((await screen.findAllByTestId("directory-promote"))[0]);
    await screen.findByTestId("employment-change-title");

    fireEvent.click(screen.getByTestId("employment-change-submit"));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Nothing to record")));
    // The modal stays open for a retry.
    expect(screen.getByTestId("employment-change-submit")).toBeTruthy();
    expect(getDirectory).toHaveBeenCalledTimes(1);
  });
});

describe("P33 — the retirement projection in the profile modal (EM-B02)", () => {
  async function openProfileModal() {
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-promote");
    fireEvent.click(screen.getByRole("button", { name: "Edit Theo Vance's profile" }));
    await screen.findByTestId("birth-date-input");
  }

  it("projects the retirement month when the workspace age is configured and the birthday is on file", async () => {
    await openProfileModal();
    const line = await screen.findByTestId("retirement-projection");
    // 1992-06-14 + 65 → Jun 2057.
    expect(line.textContent).toContain("Jun 2057");
    expect(line.textContent).toContain("65");
  });

  it("renders no line when the workspace age is not configured (the pre-P33 silence)", async () => {
    getDirectory.mockResolvedValue(directoryPayload({ retirementAge: null }));
    await openProfileModal();
    expect(screen.queryByTestId("retirement-projection")).toBeNull();
  });

  it("renders no line without a birthday on file (never a fabricated projection)", async () => {
    getDirectory.mockResolvedValue(directoryPayload({ profiles: [{ ...PROFILE, birthDate: null }] }));
    await openProfileModal();
    expect(screen.queryByTestId("retirement-projection")).toBeNull();
  });
});

describe("P33 — the structured employment-changes panel (EM-06)", () => {
  it("lazy-loads on first expand and renders the property diff rows", async () => {
    getEmploymentHistory.mockResolvedValue({
      ok: true,
      data: [
        {
          id: "h-1", userId: "u-1", property: "jobTitle",
          currentValue: "Frontend Engineer", newValue: "Senior Frontend Engineer",
          effectiveAt: "2026-09-27", sourceKind: "PROMOTION", createdAt: "2026-09-27T00:00:00.000Z",
        },
        {
          id: "h-2", userId: "u-1", property: "department",
          currentValue: "Engineering", newValue: "Design",
          effectiveAt: "2026-10-20", sourceKind: "TRANSFER", createdAt: "2026-10-20T00:00:00.000Z",
        },
      ],
    });

    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-promote");
    fireEvent.click(screen.getByRole("button", { name: "Edit Theo Vance's profile" }));
    await screen.findByTestId("birth-date-input");

    // Collapsed by default: no fetch yet.
    expect(getEmploymentHistory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Employment changes"));
    await waitFor(() => expect(getEmploymentHistory).toHaveBeenCalledWith("u-1"));

    const rows = await screen.findAllByTestId("employment-change-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Job title");
    expect(rows[0].textContent).toContain("Frontend Engineer");
    expect(rows[0].textContent).toContain("Senior Frontend Engineer");
    expect(rows[1].textContent).toContain("Department");
    expect(rows[1].textContent).toContain("Design");
  });

  it("renders the honest empty state when no structured changes exist", async () => {
    getEmploymentHistory.mockResolvedValue({ ok: true, data: [] });
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-promote");
    fireEvent.click(screen.getByRole("button", { name: "Edit Theo Vance's profile" }));
    await screen.findByTestId("birth-date-input");
    fireEvent.click(screen.getByText("Employment changes"));
    await waitFor(() =>
      expect(screen.getByText(/No promotions or transfers have been recorded/)).toBeTruthy(),
    );
  });
});
