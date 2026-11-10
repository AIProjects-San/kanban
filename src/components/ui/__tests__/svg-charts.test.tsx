// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { BarListChart, TrendChart } from "@/components/ui/svg-charts";

// ---------------------------------------------------------------------------
// P22 (PR-C01–04) — the shared dependency-free SVG chart pair. These tests
// pin the render contract the analytics panels ride: accessible summary,
// honest empty state, value formatting, and the others-fold at maxRows.
// ---------------------------------------------------------------------------

describe("TrendChart", () => {
  it("renders the series with min/max callouts and the last-point legend", () => {
    render(
      <TrendChart
        title="Outgoing salary — disbursed net per month"
        points={[
          { label: "Oct 2026", value: 90 },
          { label: "Nov 2026", value: 180 },
        ]}
        formatValue={(n) => `$${n}`}
        testId="trend"
      />,
    );
    const el = screen.getByTestId("trend");
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Outgoing salary — disbursed net per month");
    const text = el.textContent ?? "";
    expect(text).toContain("min $90");
    expect(text).toContain("max $180");
    expect(text).toContain("Nov 2026: $180");
    expect(text).toContain("Oct 2026");
  });

  it("renders the honest empty state when there are no points", () => {
    render(
      <TrendChart
        title="Benefit claims"
        points={[]}
        emptyHint="No benefit claims yet."
        testId="trend-empty"
      />,
    );
    const el = screen.getByTestId("trend-empty");
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Benefit claims — No benefit claims yet.");
    expect(el.textContent).toContain("No benefit claims yet.");
  });

  it("renders a single point without dividing by zero", () => {
    render(
      <TrendChart title="One month" points={[{ label: "Nov 2026", value: 42 }]} testId="trend-one" />,
    );
    expect(screen.getByTestId("trend-one").textContent).toContain("Nov 2026: 42");
  });
});

describe("BarListChart", () => {
  it("renders rows with formatted values and share percentages", () => {
    render(
      <BarListChart
        title="Salary by department — gross in the latest paid month"
        rows={[
          { label: "DESIGN", value: 500 },
          { label: "ENGINEERING", value: 500 },
        ]}
        formatValue={(n) => `$${n}`}
        testId="bars"
      />,
    );
    const el = screen.getByTestId("bars");
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Salary by department — gross in the latest paid month");
    const text = el.textContent ?? "";
    expect(text).toContain("DESIGN");
    expect(text).toContain("ENGINEERING");
    expect(text).toContain("$500");
    expect(text).toContain("50%");
  });

  it("folds rows beyond maxRows into an honest Others summary row", () => {
    render(
      <BarListChart
        title="Many departments"
        rows={[
          { label: "A", value: 40 },
          { label: "B", value: 30 },
          { label: "C", value: 20 },
          { label: "D", value: 10 },
        ]}
        maxRows={2}
        testId="bars-folded"
      />,
    );
    const text = screen.getByTestId("bars-folded").textContent ?? "";
    expect(text).toContain("A");
    expect(text).toContain("B");
    expect(text).not.toContain("C");
    expect(text).toContain("Others (2)");
    expect(text).toContain("30"); // 20 + 10 folded total
  });

  it("renders the honest empty state when there are no rows", () => {
    render(
      <BarListChart title="Salary by department" rows={[]} emptyHint="No locked runs yet." testId="bars-empty" />,
    );
    const el = screen.getByTestId("bars-empty");
    expect(el.getAttribute("aria-label")).toBe("Salary by department — No locked runs yet.");
    expect(el.textContent).toContain("No locked runs yet.");
  });
});
