"use client";

import { useEffect, useRef, type RefObject } from "react";

// ---------------------------------------------------------------------------
// L-P1-18 — Focus trap hook for modal dialogs.
//
// On activate: saves the previously-focused element, moves focus into the
// container (first focusable element or the container itself with tabindex=-1).
// While active: Tab on the last focusable wraps to the first; Shift+Tab on
// the first wraps to the last. On deactivate: restores focus to the element
// that had it before the trap activated.
// ---------------------------------------------------------------------------

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
].join(", ");

function getFocusable(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return candidates.filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.offsetParent !== null) return true;
    if (el === document.activeElement) return true;
    // jsdom / position:fixed fallback: accept unless explicitly hidden
    const style = el.style;
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  });
}

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const focusables = getFocusable(container);
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      container.setAttribute("tabindex", "-1");
      container.focus();
    }

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const currentContainer = containerRef.current;
      if (!currentContainer) return;
      const focusable = getFocusable(currentContainer);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", handleKeydown);
    document.addEventListener("keydown", handleKeydown, true);

    return () => {
      container.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("keydown", handleKeydown, true);
      if (previouslyFocusedRef.current && typeof previouslyFocusedRef.current.focus === "function") {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [active, containerRef]);
}
