// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// PR-63 — role-scoped Analytics view.
//
// The view fetches its own data via getAnalyticsData (mocked here) and:
//   • MEMBER — no filter dropdown; "Your performance"; contributors hidden.
//   • MANAGER — defaults to "My team"; dropdown offers Just me + reports.
//   • ADMIN — defaults to "Just me" (own data first); dropdown offers
//     Everyone, manager teams, and individuals; switching re-fetches with
//     the new scope and contributors reappear for multi-person scopes.
// ---------------------------------------------------------------------------

// Charts are stubbed — jsdom can't size ResponsiveContainer, and the chart
// internals are not what these tests pin.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="chart">{children}</div>
  ),
  AreaChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

const { getAnalyticsData } = vi.hoisted(() => ({ getAnalyticsData: vi.fn() }));

vi.mock("@/server-actions/data", () => ({ getAnalyticsData }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AnalyticsView } from "@/components/views/analytics-view";
import type { AnalyticsData } from "@/server-actions/data";

function payload(overrides: Partial<AnalyticsData>): AnalyticsData {
  return {
    scope: { kind: "self" },
    members: [],
    timeEntries: [],
    projects: [],
    filter: { showEveryone: false, people: [], teams: [] },
    ...overrides,
  } as AnalyticsData;
}

const MEMBER_ENTRY = {
  id: "e1", projectId: "p-1", memberId: "m-mia", taskId: null,
  date: new Date().toISOString(), hours: 4, description: "",
};

const MIA: AnalyticsData["members"][number] = {
  id: "m-mia", name: "Mia Hale", role: "MEMBER", department: "ENGINEERING",
  email: "mia@x.co", avatarColor: "plum", online: false, openTasks: 2,
  completedTasks: 8, workload: 40, userId: "u-mia",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AnalyticsView: MEMBER (fixed self scope)", () => {
  it("renders own data with no filter dropdown; contributors hidden", async () => {
    getAnalyticsData.mockResolvedValue({
      ok: true,
      data: payload({
        scope: { kind: "self" },
        members: [MIA],
        timeEntries: [MEMBER_ENTRY],
        filter: { showEveryone: false, people: [], teams: [] },
      }),
    });
    render(<AnalyticsView user={{ id: "u-mia", name: "Mia Hale", role: "MEMBER" }} />);

    await waitFor(() => {
      expect(screen.getByText("Your performance over the last 30 days")).toBeTruthy();
    });
    // Own hours are in the metric card.
    expect(screen.getByText("4h")).toBeTruthy();
    // No filter select, no contributors section.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Top contributors")).toBeNull();
  });

  it("always requests the self scope on mount", async () => {
    getAnalyticsData.mockResolvedValue({ ok: true, data: payload({}) });
    render(<AnalyticsView user={{ id: "u-mia", name: "Mia", role: "MEMBER" }} />);
    await waitFor(() => expect(getAnalyticsData).toHaveBeenCalled());
    expect(getAnalyticsData).toHaveBeenCalledWith({ kind: "self" });
  });
});

describe("AnalyticsView: MANAGER (team default + individual filter)", () => {
  it("defaults to the manager's team scope and offers Just me + reports", async () => {
    getAnalyticsData.mockResolvedValue({
      ok: true,
      data: payload({
        scope: { kind: "team", managerId: "u-max" },
        members: [MIA],
        timeEntries: [MEMBER_ENTRY],
        filter: {
          showEveryone: false,
          people: [{ userId: "u-mia", name: "Mia Hale", role: "MEMBER" }],
          teams: [],
        },
      }),
    });
    render(<AnalyticsView user={{ id: "u-max", name: "Max Ray", role: "MANAGER" }} />);

    await waitFor(() => {
      expect(screen.getByText("Your team's performance over the last 30 days")).toBeTruthy();
    });
    expect(getAnalyticsData).toHaveBeenCalledWith({ kind: "team", managerId: "u-max" });

    const select = screen.getByRole("combobox", { name: /filter analytics/i });
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["My team", "Just me", "Mia Hale"]);
    // Contributors visible for a multi-person scope.
    expect(screen.getByText("Top contributors")).toBeTruthy();
  });

  it("switching to an individual re-fetches with the user scope", async () => {
    getAnalyticsData.mockResolvedValue({
      ok: true,
      data: payload({
        scope: { kind: "team", managerId: "u-max" },
        filter: { showEveryone: false, people: [{ userId: "u-mia", name: "Mia Hale", role: "MEMBER" }], teams: [] },
      }),
    });
    render(<AnalyticsView user={{ id: "u-max", name: "Max Ray", role: "MANAGER" }} />);
    await waitFor(() => expect(getAnalyticsData).toHaveBeenCalledTimes(1));

    getAnalyticsData.mockResolvedValue({
      ok: true,
      data: payload({
        scope: { kind: "user", userId: "u-mia" },
        members: [MIA],
        filter: { showEveryone: false, people: [{ userId: "u-mia", name: "Mia Hale", role: "MEMBER" }], teams: [] },
      }),
    });
    fireEvent.change(screen.getByRole("combobox", { name: /filter analytics/i }), {
      target: { value: "user:u-mia" },
    });
    await waitFor(() => {
      expect(getAnalyticsData).toHaveBeenCalledWith({ kind: "user", userId: "u-mia" });
    });
    await waitFor(() => {
      // Single-person scope: person-possessive title + contributors hidden.
      expect(screen.getByText("Mia Hale's performance over the last 30 days")).toBeTruthy();
      expect(screen.queryByText("Top contributors")).toBeNull();
    });
  });
});

describe("AnalyticsView: ADMIN (own data first, then filters)", () => {
  function adminPayload(scope: AnalyticsData["scope"]): AnalyticsData {
    return payload({
      scope,
      members: [MIA],
      timeEntries: [MEMBER_ENTRY],
      filter: {
        showEveryone: true,
        people: [
          { userId: "u-mia", name: "Mia Hale", role: "MEMBER" },
          { userId: "u-max", name: "Max Ray", role: "MANAGER" },
        ],
        teams: [{ managerId: "u-max", name: "Max Ray" }],
      },
    });
  }

  it("starts on own data ('Just me') with Everyone/teams/people options", async () => {
    getAnalyticsData.mockResolvedValue({ ok: true, data: adminPayload({ kind: "self" }) });
    render(<AnalyticsView user={{ id: "u-ada", name: "Ada Ray", role: "ADMIN" }} />);

    await waitFor(() => {
      expect(screen.getByText("Your performance over the last 30 days")).toBeTruthy();
    });
    expect(getAnalyticsData).toHaveBeenCalledWith({ kind: "self" });

    const select = screen.getByRole("combobox", { name: /filter analytics/i });
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual([
      "Just me", "Everyone", "Max Ray's team", "Mia Hale", "Max Ray",
    ]);
    // Single-person default scope → contributors hidden.
    expect(screen.queryByText("Top contributors")).toBeNull();
  });

  it("picking Everyone re-fetches workspace-wide and shows contributors", async () => {
    getAnalyticsData.mockResolvedValue({ ok: true, data: adminPayload({ kind: "self" }) });
    render(<AnalyticsView user={{ id: "u-ada", name: "Ada Ray", role: "ADMIN" }} />);
    await waitFor(() => expect(getAnalyticsData).toHaveBeenCalledTimes(1));

    getAnalyticsData.mockResolvedValue({ ok: true, data: adminPayload({ kind: "everyone" }) });
    fireEvent.change(screen.getByRole("combobox", { name: /filter analytics/i }), {
      target: { value: "everyone" },
    });
    await waitFor(() => {
      expect(getAnalyticsData).toHaveBeenCalledWith({ kind: "everyone" });
    });
    await waitFor(() => {
      expect(screen.getByText("Workspace performance over the last 30 days")).toBeTruthy();
      expect(screen.getByText("Top contributors")).toBeTruthy();
    });
  });

  it("renders the error message when the action fails", async () => {
    getAnalyticsData.mockResolvedValue({ ok: false, error: "You must be signed in." });
    render(<AnalyticsView user={{ id: "u-ada", name: "Ada", role: "ADMIN" }} />);
    await waitFor(() => {
      expect(screen.getByText("You must be signed in.")).toBeTruthy();
    });
  });
});
