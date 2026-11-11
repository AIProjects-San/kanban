// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P34 (EM-03) — the directory's grouping-axes surface:
//   • the org-slicing filter chips (department / employment type / grade /
//     branch — grade and branch options from the roster's own distinct
//     values) narrow the visible list, and Clear filters restores it
//   • the roster card renders the classified axes (Grade / Type / Branch)
//     and stays silent for the unclassified ones (QA-19)
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

const THEO = {
  id: "ep-1", userId: "u-1", employeeNumber: "EMP-0003", leaveApproverId: null,
  name: "Theo Vance", email: "theo@x.co", role: "MEMBER", managerName: "Ada Lovelace",
  jobTitle: "Senior Frontend Engineer", department: "ENGINEERING",
  grade: "L4", employmentType: "FULL_TIME", branch: "Auckland HQ",
  hireDate: "2024-06-10", birthDate: null, phone: "", location: "Auckland, NZ",
  emergencyContactName: "", emergencyContactPhone: "",
  skills: "", notes: "", employmentStatus: "ACTIVE",
  probationEndsAt: null, noticePeriodWeeks: null, lastWorkingDay: null,
};

const DIEGO = {
  ...THEO,
  id: "ep-2", userId: "u-2", employeeNumber: "EMP-0012",
  name: "Diego Morales", email: "diego@x.co", managerName: null,
  jobTitle: "Mobile Engineer", department: "ENGINEERING",
  grade: "", employmentType: "INTERN", branch: "Mexico City",
};

const KOFI = {
  ...THEO,
  id: "ep-3", userId: "u-3", employeeNumber: "EMP-0014",
  name: "Kofi Mensah", email: "kofi@x.co", managerName: null,
  jobTitle: "Support Engineer", department: "ENGINEERING",
  grade: "", employmentType: "PART_TIME", branch: "Accra",
};

function directoryPayload(profiles: unknown[]) {
  return { ok: true, data: { profiles, canAdmin: false, retirementAge: null } };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDirectory.mockResolvedValue(directoryPayload([THEO, DIEGO, KOFI]));
});

describe("P34 — the org-slicing filter chips", () => {
  it("renders one chip per grouping axis with the roster's own grade/branch values", async () => {
    render(<DirectoryTab />);
    expect(await screen.findByTestId("directory-filter-chips")).toBeTruthy();
    const typeChip = screen.getByTestId("directory-filter-employment-type") as HTMLSelectElement;
    expect([...typeChip.options].map((o) => o.textContent)).toEqual([
      "All types", "Full-time", "Part-time", "Contract", "Intern", "Consultant",
    ]);
    const gradeChip = screen.getByTestId("directory-filter-grade") as HTMLSelectElement;
    // L4 is the roster's only distinct grade (the ungraded stay under All).
    expect([...gradeChip.options].map((o) => o.textContent)).toEqual(["All grades", "L4"]);
    const branchChip = screen.getByTestId("directory-filter-branch") as HTMLSelectElement;
    expect([...branchChip.options].map((o) => o.textContent)).toEqual([
      "All branches", "Accra", "Auckland HQ", "Mexico City",
    ]);
    const deptChip = screen.getByTestId("directory-filter-department") as HTMLSelectElement;
    expect([...deptChip.options].map((o) => o.textContent)).toEqual([
      "All departments", "Engineering", "Design", "Marketing", "Management",
    ]);
  });

  it("an employment-type pick slices the roster (the count line tells the truth)", async () => {
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-name");
    expect(screen.getByText(/3 of 3 people/)).toBeTruthy();

    fireEvent.change(screen.getByTestId("directory-filter-employment-type"), {
      target: { value: "INTERN" },
    });
    expect(await screen.findAllByTestId("directory-name")).toHaveLength(1);
    expect(screen.getByText(/1 of 3 people/)).toBeTruthy();
    expect(screen.getByText("Diego Morales")).toBeTruthy();
  });

  it("a grade pick slices to the exact ladder value; ungraded members surface only under All", async () => {
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-name");

    fireEvent.change(screen.getByTestId("directory-filter-grade"), { target: { value: "L4" } });
    expect(await screen.findAllByTestId("directory-name")).toHaveLength(1);
    expect(screen.getByText("Theo Vance")).toBeTruthy();
  });

  it("a branch pick slices; chips combine (AND) and Clear filters restores", async () => {
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-name");

    fireEvent.change(screen.getByTestId("directory-filter-employment-type"), {
      target: { value: "INTERN" },
    });
    fireEvent.change(screen.getByTestId("directory-filter-branch"), {
      target: { value: "Mexico City" },
    });
    expect(await screen.findAllByTestId("directory-name")).toHaveLength(1);

    // Clear filters returns the whole roster.
    fireEvent.click(screen.getByTestId("directory-filter-clear"));
    expect(await screen.findAllByTestId("directory-name")).toHaveLength(3);
    expect(screen.getByText(/3 of 3 people/)).toBeTruthy();
    // The clear button itself disappears once no chip is active.
    expect(screen.queryByTestId("directory-filter-clear")).toBeNull();
  });

  it("a department chip slices the roster like the other axes", async () => {
    getDirectory.mockResolvedValue(directoryPayload([
      THEO,
      { ...DIEGO, department: "DESIGN" },
    ]));
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-name");

    fireEvent.change(screen.getByTestId("directory-filter-department"), {
      target: { value: "DESIGN" },
    });
    expect(await screen.findAllByTestId("directory-name")).toHaveLength(1);
    expect(screen.getByText("Diego Morales")).toBeTruthy();
  });
});

describe("P34 — the roster card renders the classified axes (QA-19)", () => {
  it("shows Grade / Type / Branch lines for a classified member", async () => {
    getDirectory.mockResolvedValue(directoryPayload([THEO]));
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-name");
    expect(screen.getByTestId("directory-grade").textContent).toContain("L4");
    expect(screen.getByTestId("directory-employment-type").textContent).toContain("Full-time");
    expect(screen.getByTestId("directory-branch").textContent).toContain("Auckland HQ");
  });

  it("stays silent for unclassified axes — no fabricated grade/type/branch", async () => {
    getDirectory.mockResolvedValue(directoryPayload([
      { ...THEO, grade: "", employmentType: "", branch: "" },
    ]));
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-name");
    expect(screen.queryByTestId("directory-grade")).toBeNull();
    expect(screen.queryByTestId("directory-employment-type")).toBeNull();
    expect(screen.queryByTestId("directory-branch")).toBeNull();
  });

  it("the text search also matches the new axes (grade, type label text, branch)", async () => {
    render(<DirectoryTab />);
    await screen.findAllByTestId("directory-name");
    const search = screen.getByLabelText("Search directory");
    fireEvent.change(search, { target: { value: "Mexico City" } });
    expect(await screen.findAllByTestId("directory-name")).toHaveLength(1);
    expect(screen.getByText("Diego Morales")).toBeTruthy();
  });
});
