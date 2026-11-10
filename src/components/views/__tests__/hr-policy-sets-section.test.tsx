// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P28 (LV-02/LV-03) — the policy set master + bulk assignment's HR surface
// (Types & Policies tab). Pins the section's contract: the EMPTY master
// shows the per-type-policy default notice, the sets list with their
// allocation chips and the assignments with their granted badges, the set
// editor submits the built rows, the bulk-assign modal submits set + bucket
// + employees, and the per-employee failures surface as toasts (the
// actions' own guards are pinned in leave-policy-sets.test.ts).
// ---------------------------------------------------------------------------

const { listLeavePolicyState, createLeavePolicySet, bulkAssignLeavePolicySet, deleteLeavePolicySet, deleteLeavePolicyAssignment, updateLeavePolicySet } =
  vi.hoisted(() => ({
    listLeavePolicyState: vi.fn(),
    createLeavePolicySet: vi.fn(),
    updateLeavePolicySet: vi.fn(),
    deleteLeavePolicySet: vi.fn(),
    bulkAssignLeavePolicySet: vi.fn(),
    deleteLeavePolicyAssignment: vi.fn(),
  }));

vi.mock("@/server-actions/leave-policy-sets", () => ({
  listLeavePolicyState,
  createLeavePolicySet,
  updateLeavePolicySet,
  deleteLeavePolicySet,
  bulkAssignLeavePolicySet,
  deleteLeavePolicyAssignment,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { PolicySetsSection } from "@/components/views/hr-view";
import { toast } from "sonner";
import type { LeaveTypeT } from "@/lib/types";

const TYPES: LeaveTypeT[] = [
  {
    id: "t-annual",
    name: "Annual Leave",
    code: "AL",
    requiresDoc: false,
    paid: true,
    color: "#8b5cf6",
    active: true,
    policy: {
      annualDays: 20,
      maxCarryOver: 5,
      minNoticeDays: 1,
      maxConsecutiveDays: 15,
      allocationStrategy: "MANUAL",
      prorateForJoiners: true,
      accrualRounding: "FLOOR_QUARTER",
    },
  },
  {
    id: "t-sick",
    name: "Sick Leave",
    code: "SL",
    requiresDoc: false,
    paid: true,
    color: "#ef4444",
    active: true,
    policy: {
      annualDays: 10,
      maxCarryOver: 0,
      minNoticeDays: 0,
      maxConsecutiveDays: 15,
      allocationStrategy: "MANUAL",
      prorateForJoiners: true,
      accrualRounding: "FLOOR_QUARTER",
    },
  },
];

const CURRENT_YEAR = Number(new Date().toISOString().slice(0, 4));
const FUTURE_YEAR = CURRENT_YEAR + 5;

const SET = {
  id: "s-1",
  name: "Standard 2027",
  description: "everyone",
  active: true,
  items: [
    { id: "i-1", leaveTypeId: "t-annual", typeName: "Annual Leave", annualDays: 25 },
    { id: "i-2", leaveTypeId: "t-sick", typeName: "Sick Leave", annualDays: 8 },
  ],
  assignmentCount: 1,
};

const STATE = {
  sets: [SET],
  assignments: [
    {
      id: "a-1",
      userId: "u-yuki",
      userName: "Yuki Tanaka",
      setId: "s-1",
      setName: "Standard 2027",
      bucketYear: FUTURE_YEAR,
      periodName: null,
      assignedAt: "2026-11-01T00:00:00.000Z",
      assignedByName: "Ada",
      granted: false,
    },
  ],
  employees: [
    { userId: "u-yuki", name: "Yuki Tanaka", hireDate: `${CURRENT_YEAR - 2}-03-15`, employmentStatus: "ACTIVE" },
    { userId: "u-hana", name: "Hana Kim", hireDate: `${CURRENT_YEAR}-07-02`, employmentStatus: "PROBATION" },
  ],
  buckets: [
    { bucketYear: CURRENT_YEAR, label: `Calendar year ${CURRENT_YEAR} (Jan → Dec)`, named: false },
    { bucketYear: CURRENT_YEAR + 1, label: `Calendar year ${CURRENT_YEAR + 1} (Jan → Dec)`, named: false },
    { bucketYear: CURRENT_YEAR + 2, label: `Calendar year ${CURRENT_YEAR + 2} (Jan → Dec)`, named: false },
  ],
};

const EMPTY_STATE = { sets: [], assignments: [], employees: [], buckets: STATE.buckets };

const onChanged = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  listLeavePolicyState.mockResolvedValue({ ok: true, data: EMPTY_STATE });
  createLeavePolicySet.mockResolvedValue({ ok: true, data: { id: "s-new" } });
  updateLeavePolicySet.mockResolvedValue({ ok: true, data: undefined });
  deleteLeavePolicySet.mockResolvedValue({ ok: true, data: undefined });
  deleteLeavePolicyAssignment.mockResolvedValue({ ok: true, data: undefined });
  bulkAssignLeavePolicySet.mockResolvedValue({
    ok: true,
    data: { assigned: 1, pairsMaterialized: 0, failures: [] },
  });
});

describe("PolicySetsSection", () => {
  it("an empty master shows the per-type-policy default notice", async () => {
    render(<PolicySetsSection types={TYPES} onChanged={onChanged} />);
    expect(await screen.findByTestId("policy-sets-empty")).toBeTruthy();
    expect(screen.getByTestId("policy-sets-empty").textContent).toContain("per-type policies");
  });

  it("lists the sets with their allocation chips and the assignments with granted badges", async () => {
    listLeavePolicyState.mockResolvedValue({ ok: true, data: STATE });
    render(<PolicySetsSection types={TYPES} onChanged={onChanged} />);
    await screen.findByTestId("policy-set-row-0");
    expect(screen.getByTestId("policy-set-name-0").textContent).toBe("Standard 2027");
    expect(screen.getByTestId("policy-set-items-0").textContent).toContain("Annual Leave 25d");
    expect(screen.getByTestId("policy-set-items-0").textContent).toContain("Sick Leave 8d");
    expect(screen.getByTestId("policy-assignment-row-0").textContent).toContain("Yuki Tanaka");
    expect(screen.getByTestId("policy-assignment-row-0").textContent).toContain("calendar year " + FUTURE_YEAR);
    expect(screen.getByTestId("policy-assignment-row-0").textContent).toContain("pending window");
  });

  it("the set editor builds rows (type select + days) and submits them", async () => {
    render(<PolicySetsSection types={TYPES} onChanged={onChanged} />);
    await screen.findByTestId("policy-sets-empty");
    fireEvent.click(screen.getByTestId("policy-set-new-button"));
    const nameInput = await screen.findByTestId("policy-set-name-input");
    fireEvent.change(nameInput, { target: { value: "Standard 2027" } });
    // The first row is prefilled with the first type's policy numbers…
    expect((screen.getByTestId("policy-set-row-type-0") as HTMLSelectElement).value).toBe("t-annual");
    expect((screen.getByTestId("policy-set-row-days-0") as HTMLInputElement).value).toBe("20");
    // …then a second row is added and set to Sick Leave 8.
    fireEvent.click(screen.getByTestId("policy-set-row-add"));
    fireEvent.change(screen.getByTestId("policy-set-row-type-1"), { target: { value: "t-sick" } });
    fireEvent.change(screen.getByTestId("policy-set-row-days-1"), { target: { value: "8" } });
    fireEvent.click(screen.getByTestId("policy-set-submit"));
    await waitFor(() =>
      expect(createLeavePolicySet).toHaveBeenCalledWith({
        name: "Standard 2027",
        description: "",
        items: [
          { leaveTypeId: "t-annual", annualDays: 20 },
          { leaveTypeId: "t-sick", annualDays: 8 },
        ],
      }),
    );
    await waitFor(() => expect(listLeavePolicyState).toHaveBeenCalledTimes(2));
  });

  it("the bulk-assign modal submits set + bucket + the selected employees", async () => {
    listLeavePolicyState.mockResolvedValue({ ok: true, data: STATE });
    render(<PolicySetsSection types={TYPES} onChanged={onChanged} />);
    await screen.findByTestId("policy-set-row-0");
    fireEvent.click(screen.getByTestId("policy-set-assign-0"));
    await screen.findByTestId("bulk-policy-modal");
    // The future-year bucket is offered and selectable.
    fireEvent.change(screen.getByTestId("bulk-policy-bucket"), { target: { value: String(CURRENT_YEAR + 2) } });
    fireEvent.click(screen.getByTestId("bulk-policy-employee-u-hana"));
    fireEvent.click(screen.getByTestId("bulk-policy-submit"));
    await waitFor(() =>
      expect(bulkAssignLeavePolicySet).toHaveBeenCalledWith({
        setId: "s-1",
        bucketYear: CURRENT_YEAR + 2,
        userIds: ["u-hana"],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("1 employee(s)"));
  });

  it("a per-employee overlap failure surfaces as a toast", async () => {
    listLeavePolicyState.mockResolvedValue({ ok: true, data: STATE });
    bulkAssignLeavePolicySet.mockResolvedValue({
      ok: true,
      data: {
        assigned: 1,
        pairsMaterialized: 0,
        failures: [{ userId: "u-yuki", reason: "already has an assignment for the calendar year 2031 (another set)" }],
      },
    });
    render(<PolicySetsSection types={TYPES} onChanged={onChanged} />);
    await screen.findByTestId("policy-set-row-0");
    fireEvent.click(screen.getByTestId("policy-set-assign-0"));
    await screen.findByTestId("bulk-policy-modal");
    fireEvent.click(screen.getByTestId("bulk-policy-employee-u-yuki"));
    fireEvent.click(screen.getByTestId("bulk-policy-employee-u-hana"));
    fireEvent.click(screen.getByTestId("bulk-policy-submit"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("already has an assignment"),
        expect.anything(),
      ),
    );
  });

  it("deleting a set calls the action with the row id; a refusal surfaces as the toast", async () => {
    listLeavePolicyState.mockResolvedValue({ ok: true, data: STATE });
    deleteLeavePolicySet.mockResolvedValue({
      ok: false,
      error: "“Standard 2027” still has 1 assignment(s) — delete those first.",
    });
    render(<PolicySetsSection types={TYPES} onChanged={onChanged} />);
    await screen.findByTestId("policy-set-row-0");
    fireEvent.click(screen.getByTestId("policy-set-delete-0"));
    await waitFor(() => expect(deleteLeavePolicySet).toHaveBeenCalledWith({ id: "s-1" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("still has 1 assignment")),
    );
  });

  it("an ungranted assignment row offers Delete; the granted one does not", async () => {
    listLeavePolicyState.mockResolvedValue({
      ok: true,
      data: {
        ...STATE,
        assignments: [
          STATE.assignments[0],
          { ...STATE.assignments[0], id: "a-2", userId: "u-hana", userName: "Hana Kim", granted: true },
        ],
      },
    });
    render(<PolicySetsSection types={TYPES} onChanged={onChanged} />);
    await screen.findByTestId("policy-assignment-row-1");
    expect(screen.getByTestId("policy-assignment-delete-0")).toBeTruthy(); // pending window → deletable
    expect(screen.queryByTestId("policy-assignment-delete-1")).toBeNull(); // granted → no delete
  });
});
