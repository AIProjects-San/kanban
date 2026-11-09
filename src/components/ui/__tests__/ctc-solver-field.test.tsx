// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P12 (PR-B20 / RJ-B14) — the shared CTC solver control: target in, solved
// base out (applied through onSolved), refusals toasted with the reason.
// ---------------------------------------------------------------------------

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { CtcSolverField } from "@/components/ui/ctc-solver-field";
import type { OfferComponent } from "@/lib/offer-math";

const PACKAGE: OfferComponent[] = [
  { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 60_000 },
  { key: "housing", label: "Housing", kind: "EARNING", mode: "PERCENT_OF_BASIC", amount: 10 },
  { key: "kiwisaver", label: "KiwiSaver", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
];

const onSolved = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CtcSolverField (P12)", () => {
  it("solves the target and hands the base to the parent", () => {
    render(<CtcSolverField components={PACKAGE} onSolved={onSolved} />);
    fireEvent.change(screen.getByTestId("ctc-solver-target"), { target: { value: "100000" } });
    fireEvent.click(screen.getByTestId("ctc-solver-btn"));
    // (100,000 − 0) / 1.13 = 88,495.57… → rounds to 88,496.
    expect(onSolved).toHaveBeenCalledWith(88_496, "basic");
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("toasts the refusal reason and never calls onSolved", () => {
    render(<CtcSolverField components={[{ key: "loan", label: "Loan", kind: "DEDUCTION", mode: "FIXED", amount: 1_000 }]} onSolved={onSolved} />);
    fireEvent.change(screen.getByTestId("ctc-solver-target"), { target: { value: "90000" } });
    fireEvent.click(screen.getByTestId("ctc-solver-btn"));
    expect(onSolved).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("No basic component to flex — add a fixed earning (e.g. Basic Salary) first.");
  });

  it("an impossible target is refused with the fixed-cost reason", () => {
    const components: OfferComponent[] = [
      { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 1 },
      { key: "transport", label: "Transport", kind: "EARNING", mode: "FIXED", amount: 50_000 },
    ];
    render(<CtcSolverField components={components} onSolved={onSolved} />);
    fireEvent.change(screen.getByTestId("ctc-solver-target"), { target: { value: "40000" } });
    fireEvent.click(screen.getByTestId("ctc-solver-btn"));
    expect(onSolved).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("below the fixed components' cost"));
  });

  it("the solve button stays disabled without a target", () => {
    render(<CtcSolverField components={PACKAGE} onSolved={onSolved} />);
    expect(screen.getByTestId("ctc-solver-btn")).toBeDisabled();
  });
});
