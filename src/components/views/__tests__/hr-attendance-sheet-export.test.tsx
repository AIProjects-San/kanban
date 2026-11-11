// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P32 (AT-R01) — the Attendance tab's Sheet CSV button: the click flows to
// exportAttendanceSheetCsv with the tab's current (year, month); success
// toasts the filename, failure toasts the action's error and never crashes
// (the Blob download itself is browser machinery — the analytics pattern,
// not asserted, same as the payroll CSV buttons).
// ---------------------------------------------------------------------------

const { getAttendanceMonth, upsertAttendanceRecord, deleteAttendanceRecord, exportAttendanceSheetCsv } = vi.hoisted(() => ({
  getAttendanceMonth: vi.fn(),
  upsertAttendanceRecord: vi.fn(),
  deleteAttendanceRecord: vi.fn(),
  exportAttendanceSheetCsv: vi.fn(),
}));

vi.mock("@/server-actions/hr-attendance", () => ({
  getAttendanceMonth,
  upsertAttendanceRecord,
  deleteAttendanceRecord,
  exportAttendanceSheetCsv,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { AttendanceTab } from "@/components/views/hr-attendance";

beforeEach(() => {
  vi.clearAllMocks();
  // Pin the clock so the tab's initial (year, month) state is deterministic.
  vi.useFakeTimers({ now: new Date("2026-11-11T03:00:00.000Z"), toFake: ["Date"] });
  getAttendanceMonth.mockResolvedValue({
    ok: true,
    data: {
      year: 2026,
      month: 11,
      members: [{ userId: "u-1", userName: "Theo Vance" }],
      records: [],
      holidays: [],
      dayStart: "09:00",
      dayEnd: "17:30",
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("P32 (AT-R01) — the Attendance tab's Sheet CSV button", () => {
  it("a click flows to the action with the tab's current (year, month) and toasts the filename", async () => {
    const { toast } = await import("sonner");
    exportAttendanceSheetCsv.mockResolvedValue({
      ok: true,
      data: { filename: "attendance-sheet-2026-11.csv", csv: "# Monthly attendance sheet…\r\n", mime: "text/csv; charset=utf-8" },
    });
    render(<AttendanceTab />);
    await screen.findByTestId("attendance-grid");

    fireEvent.click(screen.getByTestId("att-sheet-export"));
    await waitFor(() => {
      expect(exportAttendanceSheetCsv).toHaveBeenCalledWith({ year: 2026, month: 11 });
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("attendance-sheet-2026-11.csv"));
    });
  });

  it("an export failure surfaces as a toast, never a crash", async () => {
    const { toast } = await import("sonner");
    exportAttendanceSheetCsv.mockResolvedValue({ ok: false, error: "You do not have permission to export attendance." });
    render(<AttendanceTab />);
    await screen.findByTestId("attendance-grid");

    fireEvent.click(screen.getByTestId("att-sheet-export"));
    await waitFor(() => {
      expect(exportAttendanceSheetCsv).toHaveBeenCalledWith({ year: 2026, month: 11 });
      expect(toast.error).toHaveBeenCalledWith("You do not have permission to export attendance.");
    });
  });

  it("the button is disabled while an export is in flight (double-click can't double-export)", async () => {
    let release: () => void = () => {};
    exportAttendanceSheetCsv.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ ok: true, data: { filename: "attendance-sheet-2026-11.csv", csv: "x\r\n", mime: "text/csv; charset=utf-8" } });
      }),
    );
    render(<AttendanceTab />);
    await screen.findByTestId("attendance-grid");

    const btn = screen.getByTestId("att-sheet-export") as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    release();
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(exportAttendanceSheetCsv).toHaveBeenCalledTimes(1);
  });
});
