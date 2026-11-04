"use client";

// ADR-002 — local primitives over a component kit. This modal implements
// its own focus trap + ESC handling instead of pulling in @radix-ui or
// shadcn/ui's full Modal. The tradeoff: more code here, but zero bundle
// cost, full control over the OKLCH token integration, and no foreign
// design language to fight. See docs/DECISIONS.md §ADR-002.

import { useEffect, useRef, useId } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/hooks/use-focus-trap";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /** "xl" is the wide layout for dense detail views (project detail) —
   *  it exists so multi-section modals can use a two-column layout and
   *  avoid deep internal scrolling. */
  size?: "sm" | "md" | "lg" | "xl";
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  size = "md",
}: ModalProps) {
  // L-P1-18 — unique ids for aria-labelledby so screen readers announce the
  // dialog title when focus moves into the dialog.
  const titleId = useId();
  const descId = useId();
  // L-P1-18 — focus trap. Traps Tab/Shift+Tab inside the dialog and restores
  // focus to the trigger element on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const widths = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-5xl" };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-hidden
      />
      <div
        ref={dialogRef}
        className={cn(
          "relative w-full bg-card border border-border rounded-xl shadow-2xl max-h-[90vh] flex flex-col",
          widths[size],
          className
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
      >
        <div className="flex items-start justify-between p-5 border-b border-border">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-foreground">{title}</h2>
            {description && (
              <p id={descId} className="text-xs text-muted-foreground mt-0.5">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="f-btn f-btn-ghost f-btn-icon -mr-2 -mt-1"
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto f-scroll p-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
