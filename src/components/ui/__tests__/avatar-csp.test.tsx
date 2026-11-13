// PR-40 — CSP style-src hardening. The production policy is
// `style-src 'self'` (no 'unsafe-inline), so NOTHING may server-render a
// style attribute. The Avatar is on every SSR'd surface (topbar, dashboard,
// team, chat), and barWidthClass backs every progress bar. Both must stay
// class-only. End-to-end enforcement lives in scripts/prod-smoke.mjs (the
// authenticated-shell HTML scan); these are the fast unit tripwires.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { Avatar, AVATAR_SIZES } from "@/components/ui/avatar";
import { barWidthClass } from "@/lib/shared/utils";

describe("PR-40: Avatar renders without inline style attributes", () => {
  it.each([...AVATAR_SIZES])("size %ipx uses only classes (online dot too)", (size) => {
    const { container } = render(<Avatar name="Ada Lovelace" size={size} online />);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    expect(container.firstElementChild).toHaveClass(`f-av-${size}`);
    expect(container.querySelector(".f-avatar")).toBeTruthy();
    expect(container.querySelector(".f-av-dot")).toBeTruthy();
  });

  it("offline dot and default size (32) are class-only as well", () => {
    const { container } = render(<Avatar name="Demo User" online={false} />);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    expect(container.firstElementChild).toHaveClass("f-av-32");
  });

  it("every size in the closed set has its class trio in globals.css", () => {
    const css = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf-8");
    for (const s of AVATAR_SIZES) {
      expect(css).toMatch(new RegExp(`\\.f-av-${s} \\{ width: ${s}px; height: ${s}px; \\}`));
      expect(css).toMatch(new RegExp(`\\.f-av-${s} > \\.f-av-dot`));
    }
  });
});

describe("PR-40: barWidthClass maps percentages onto the static f-w grid", () => {
  it("rounds to the nearest whole percent", () => {
    expect(barWidthClass(0)).toBe("f-w-0");
    expect(barWidthClass(42.4)).toBe("f-w-42");
    expect(barWidthClass(42.6)).toBe("f-w-43");
    expect(barWidthClass(100)).toBe("f-w-100");
  });

  it("clamps out-of-range and non-finite values", () => {
    expect(barWidthClass(120)).toBe("f-w-100");
    expect(barWidthClass(-5)).toBe("f-w-0");
    expect(barWidthClass(Number.NaN)).toBe("f-w-0");
    expect(barWidthClass(Number.POSITIVE_INFINITY)).toBe("f-w-100");
  });

  it("every class it can emit exists in the stylesheet (grid completeness)", () => {
    const css = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf-8");
    for (let n = 0; n <= 100; n++) {
      expect(css).toMatch(new RegExp(`^  \\.f-w-${n} \\{ width: ${n}%; \\}$`, "m"));
    }
  });
});
