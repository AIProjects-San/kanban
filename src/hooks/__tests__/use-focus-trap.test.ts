import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useFocusTrap } from "../use-focus-trap";

// L-P1-18 — focus trap hook tests. jsdom doesn't fully implement focus /
// offsetParent, so these verify the hook's wiring (listeners, focus moved on
// activate) rather than full Tab-cycling.

describe("L-P1-18 useFocusTrap", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when active is false", () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, false);
      return ref;
    });
    expect(result.current).toBeDefined();
  });

  it("moves focus into the container on activate", () => {
    const container = document.createElement("div");
    const button = document.createElement("button");
    button.textContent = "First focusable";
    container.appendChild(button);
    document.body.appendChild(container);

    const focusSpy = vi.spyOn(button, "focus");

    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => {
        const ref = useRef<HTMLDivElement>(null);
        (ref as { current: HTMLDivElement | null }).current = container;
        useFocusTrap(ref, active);
      },
      { initialProps: { active: false } },
    );

    rerender({ active: true });
    expect(focusSpy).toHaveBeenCalled();
  });

  it("restores focus to the previously-focused element on deactivate", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const container = document.createElement("div");
    const inner = document.createElement("button");
    container.appendChild(inner);
    document.body.appendChild(container);

    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => {
        const ref = useRef<HTMLDivElement>(null);
        (ref as { current: HTMLDivElement | null }).current = container;
        useFocusTrap(ref, active);
      },
      { initialProps: { active: false } },
    );

    rerender({ active: true });
    expect(document.activeElement).not.toBe(trigger);

    rerender({ active: false });
    expect(document.activeElement).toBe(trigger);
  });
});
