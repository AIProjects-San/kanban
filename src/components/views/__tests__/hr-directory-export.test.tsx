// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P32 (EM-R02) — the Directory tab's Export CSV button: the click flows to
// exportDirectoryCsv (zero inputs — the report is the whole roster);
// success toasts the filename, failure toasts the action's error and never
// crashes (the Blob download itself is browser machinery — the analytics
// pattern, not asserted, same as the payroll CSV buttons).
// ---------------------------------------------------------------------------

const { getDirectory, getMyProfile, upsertMyProfile, updateProfileAsAdmin, exportDirectoryCsv, transitionEmployment, applyEmploymentChange, getEmploymentHistory } = vi.hoisted(() => ({
  getDirectory: vi.fn(),
  getMyProfile: vi.fn(),
  upsertMyProfile: vi.fn(),
  updateProfileAsAdmin: vi.fn(),
  exportDirectoryCsv: vi.fn(),
  transitionEmployment: vi.fn(),
  // P33 — the promotion/transfer writer + the structured history reader
  // (rendered components import them; the export tests never call them).
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

vi.mock("@/server-actions/employment", () => ({ transitionEmployment, applyEmploymentChange, getEmploymentHistory }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { DirectoryTab } from "@/components/views/hr-directory";

beforeEach(() => {
  vi.clearAllMocks();
  getDirectory.mockResolvedValue({
    ok: true,
    data: {
      profiles: [
        {
          id: "ep-1", userId: "u-1", employeeNumber: "EMP-0003", leaveApproverId: null,
          name: "Theo Vance", email: "theo@x.co", role: "MEMBER", managerName: "Ada Lovelace",
          jobTitle: "Senior Frontend Engineer", department: "ENGINEERING",
          hireDate: "2024-06-10", birthDate: null, phone: "+64 21 555 0003", location: "Auckland, NZ",
          emergencyContactName: "Rae Vance", emergencyContactPhone: "+64 21 555 0199",
          skills: "React, TypeScript", notes: "HR note", employmentStatus: "ACTIVE",
          probationEndsAt: null, noticePeriodWeeks: null, lastWorkingDay: null,
        },
      ],
      canAdmin: false,
      retirementAge: null,
    },
  });
});

describe("P32 (EM-R02) — the Directory tab's Export CSV button", () => {
  it("renders beside the roster count and a click flows to the action with zero inputs, toasting the filename", async () => {
    const { toast } = await import("sonner");
    exportDirectoryCsv.mockResolvedValue({
      ok: true,
      data: { filename: "employee-information-2026-11-11.csv", csv: "# Employee information…\r\n", mime: "text/csv; charset=utf-8" },
    });
    render(<DirectoryTab />);
    expect(await screen.findByTestId("directory-name")).toBeTruthy();
    expect(screen.getByText("1 of 1 people")).toBeTruthy();

    fireEvent.click(screen.getByTestId("directory-export"));
    await waitFor(() => {
      expect(exportDirectoryCsv).toHaveBeenCalledWith();
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("employee-information-2026-11-11.csv"));
    });
  });

  it("an export failure surfaces as a toast, never a crash", async () => {
    const { toast } = await import("sonner");
    exportDirectoryCsv.mockResolvedValue({ ok: false, error: "You do not have permission to view the directory." });
    render(<DirectoryTab />);
    await screen.findByTestId("directory-name");

    fireEvent.click(screen.getByTestId("directory-export"));
    await waitFor(() => {
      expect(exportDirectoryCsv).toHaveBeenCalledWith();
      expect(toast.error).toHaveBeenCalledWith("You do not have permission to view the directory.");
    });
  });

  it("the button is disabled while an export is in flight (double-click can't double-export)", async () => {
    let release: () => void = () => {};
    exportDirectoryCsv.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ ok: true, data: { filename: "employee-information-2026-11-11.csv", csv: "x\r\n", mime: "text/csv; charset=utf-8" } });
      }),
    );
    render(<DirectoryTab />);
    await screen.findByTestId("directory-name");

    const btn = screen.getByTestId("directory-export") as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    release();
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(exportDirectoryCsv).toHaveBeenCalledTimes(1);
  });
});
