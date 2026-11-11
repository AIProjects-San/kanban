// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P35 (EM-12/EM-B06/EM-11) — the onboarding console's template-depth surface:
//   • the derived completion status chip (not started / N% in progress /
//     complete) + the open-required counter on each checklist card
//   • the per-task rendering: the required flag, the role-scoped assignee
//     label, and the holiday-aware due date (vs "due day N" when undated)
//   • the template editor's row chips (@user / HR role / hire / manager,
//     "required")
// ---------------------------------------------------------------------------

const { getOnboarding, getDirectory, getOnboardingTemplates } = vi.hoisted(() => ({
  getOnboarding: vi.fn(),
  getDirectory: vi.fn(),
  getOnboardingTemplates: vi.fn(),
}));

vi.mock("@/server-actions/hr-onboarding", () => ({
  getOnboarding,
  createChecklist: vi.fn(),
  addTask: vi.fn(),
  getMyOnboardingTasks: vi.fn(),
  setTaskDone: vi.fn(),
  getOnboardingTemplates,
  saveOnboardingTemplateTask: vi.fn(),
  deleteOnboardingTemplateTask: vi.fn(),
}));

vi.mock("@/server-actions/hr-directory", () => ({ getDirectory }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/store/app-store", () => ({ useApp: () => ({ bumpRefresh: vi.fn() }) }));

import { OnboardingTab } from "@/components/views/hr-onboarding";

const checklist = (over: Record<string, unknown>) => ({
  id: "c-1",
  newHireId: "u-1",
  hireName: "Nadia Petrova",
  title: "November onboarding",
  kind: "ONBOARDING",
  completedAt: null,
  startDate: "2026-11-09T00:00:00.000Z",
  createdAt: "2026-11-01T00:00:00.000Z",
  completion: { done: 1, total: 2, percent: 50, status: "IN_PROGRESS", requiredOpen: 1 },
  tasks: [
    {
      id: "t-1", checklistId: "c-1", title: "Sign the employment contract",
      assigneeId: "u-2", assigneeName: "Ingrid Solberg", assigneeRole: "",
      dueOffsetDays: 1, dueDate: "2026-11-10T00:00:00.000Z", isRequired: true,
      done: true, doneAt: "2026-11-10T09:00:00.000Z", doneBy: "Ingrid Solberg",
      notes: "", order: 0,
    },
    {
      id: "t-2", checklistId: "c-1", title: "File the tax forms",
      assigneeId: null, assigneeName: null, assigneeRole: "HR",
      dueOffsetDays: 2, dueDate: "2026-11-11T00:00:00.000Z", isRequired: true,
      done: false, doneAt: null, doneBy: null, notes: "", order: 1,
    },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getDirectory.mockResolvedValue({ ok: true, data: { profiles: [{ userId: "u-2", name: "Ingrid Solberg" }] } });
  getOnboardingTemplates.mockResolvedValue({ ok: true, data: [] });
});

describe("P35 — the derived completion status + per-task depth", () => {
  it("renders the IN_PROGRESS status chip with the percent and the open-required counter", async () => {
    getOnboarding.mockResolvedValue({ ok: true, data: [checklist({})] });
    render(<OnboardingTab />);
    const status = await screen.findByTestId("status-November onboarding");
    expect(status.textContent).toContain("50% in progress");
    expect(screen.getByText(/1 required open/)).toBeTruthy();
  });

  it("renders COMPLETE and NOT_STARTED chips for the boundary states", async () => {
    getOnboarding.mockResolvedValue({
      ok: true,
      data: [
        checklist({ id: "c-done", title: "Done list", completion: { done: 2, total: 2, percent: 100, status: "COMPLETE", requiredOpen: 0 } }),
        checklist({ id: "c-fresh", title: "Fresh list", completion: { done: 0, total: 2, percent: 0, status: "NOT_STARTED", requiredOpen: 2 } }),
      ],
    });
    render(<OnboardingTab />);
    expect((await screen.findByTestId("status-Done list")).textContent).toContain("complete");
    expect(screen.getByTestId("status-Fresh list").textContent).toContain("not started");
  });

  it("flags the open required task, labels the role-scoped assignee, and shows the holiday-aware due date", async () => {
    getOnboarding.mockResolvedValue({ ok: true, data: [checklist({})] });
    render(<OnboardingTab />);
    await screen.findByTestId("checklist-November onboarding");
    // The open required task carries the flag; the done one does not.
    expect(screen.getByTestId("required-File the tax forms")).toBeTruthy();
    expect(screen.queryByTestId("required-Sign the employment contract")).toBeNull();
    // Role-scoped assignee label + the derived date (11 Nov 2026).
    expect(screen.getByText(/the HR role/)).toBeTruthy();
    expect(screen.getByText(/due 11 Nov/i)).toBeTruthy();
    expect(screen.getByText(/@Ingrid Solberg/)).toBeTruthy();
  });

  it("falls back to the raw offset when a task is undated (pre-P35 row)", async () => {
    const [doneTask, openTask] = checklist({}).tasks;
    getOnboarding.mockResolvedValue({
      ok: true,
      data: [checklist({
        startDate: null,
        completion: { done: 0, total: 1, percent: 0, status: "NOT_STARTED", requiredOpen: 1 },
        tasks: [{ ...doneTask, dueDate: null }, { ...openTask, dueDate: null }],
      })],
    });
    render(<OnboardingTab />);
    await screen.findByTestId("checklist-November onboarding");
    expect(screen.getByText(/due day 1/)).toBeTruthy();
    expect(screen.getByText(/due day 2/)).toBeTruthy();
  });

  it("the template editor chips render the assignee axis and the required flag", async () => {
    getOnboarding.mockResolvedValue({ ok: true, data: [] });
    getOnboardingTemplates.mockResolvedValue({
      ok: true,
      data: [
        { id: "tt-1", kind: "ONBOARDING", title: "Laptop procurement", dueOffsetDays: 2, assignSelf: false, assigneeUserId: "u-2", assigneeRole: "", isRequired: true, isActive: true, sortOrder: 1 },
        { id: "tt-2", kind: "SEPARATION", title: "Revoke accounts, SSO and tool access", dueOffsetDays: 5, assignSelf: false, assigneeUserId: null, assigneeRole: "HR", isRequired: true, isActive: true, sortOrder: 2 },
        { id: "tt-3", kind: "ONBOARDING", title: "Complete the workspace tour", dueOffsetDays: 5, assignSelf: true, assigneeUserId: null, assigneeRole: "", isRequired: false, isActive: true, sortOrder: 3 },
      ],
    });
    render(<OnboardingTab />);
    expect(await screen.findByTestId("onboarding-template-editor")).toBeTruthy();
    expect(screen.getByTestId("template-chip-Laptop procurement").textContent).toContain("@user");
    expect(screen.getByTestId("template-chip-Laptop procurement").textContent).toContain("required");
    expect(screen.getByTestId("template-chip-Revoke accounts, SSO and tool access").textContent).toContain("HR role");
    expect(screen.getByTestId("template-chip-Complete the workspace tour").textContent).toContain("hire");
  });
});
