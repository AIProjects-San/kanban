"use client";

// P12 (PR-B20 / RJ-B14) — the shared "solve base for target CTC" control.
// Used by BOTH compensation editors (the structure editor and the offer
// builder): enter the target annual CTC, the pure kernel solves the basic
// that hits it, the parent writes the solved amount into its basic
// component line. The rounding residue is toasted, never hidden.

import { useState } from "react";
import { Calculator, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { solveBaseForCtc } from "@/lib/hiring/ctc-solver";
import { basicKeyOf, formatMoney, type OfferComponent } from "@/lib/hiring/offer-math";

export function CtcSolverField({
  components,
  onSolved,
  testIdPrefix = "ctc-solver",
}: {
  /** The CURRENT component draft (the solver never mutates it — the parent
   * applies the solved base through onSolved). */
  components: OfferComponent[];
  /** Receives the solved basic amount (write it into your basic line). */
  onSolved: (base: number, baseKey: string) => void;
  /** Testid prefix (modals mount one each). */
  testIdPrefix?: string;
}) {
  const [target, setTarget] = useState("");
  const [busy] = useState(false); // pure computation — instant, but kept for symmetry

  const solve = () => {
    const res = solveBaseForCtc({ components, targetCtc: Number(target) });
    if (!res.ok || !res.baseKey) {
      toast.error(res.reason || "Could not solve the base for this target.");
      return;
    }
    onSolved(res.base, res.baseKey);
    toast.success(
      `Base solved: ${formatMoney(res.base)} → CTC ${formatMoney(res.achievedCtc)}${res.delta !== 0 ? ` (rounding ${res.delta >= 0 ? "+" : "−"}${formatMoney(Math.abs(res.delta))} off target)` : " — exact"}.`,
    );
  };

  const hasBasic = basicKeyOf(components) != null;

  return (
    <div
      className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 flex items-center gap-2 flex-wrap"
      data-testid={testIdPrefix}
    >
      <Calculator size={13} className="text-emerald-600 shrink-0" />
      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400 shrink-0">Solve base for target CTC</span>
      <input
        className="f-input text-xs w-32"
        type="number"
        min={0}
        step={1000}
        placeholder="e.g. 95,000"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        aria-label="Target annual CTC"
        data-testid={`${testIdPrefix}-target`}
      />
      <button
        type="button"
        className="f-btn f-btn-secondary text-xs"
        disabled={busy || !target}
        onClick={solve}
        data-testid={`${testIdPrefix}-btn`}
        title={hasBasic
          ? "Solves the basic amount that hits this annual CTC, holding every other component (fixed amounts and percent rates) constant"
          : "Needs a basic component — add a fixed earning first"}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : null} Solve
      </button>
      <span className="text-[0.6875rem] text-muted-foreground basis-full sm:basis-auto">
        Holds fixed amounts + percent rates constant; the residue from whole-unit rounding is reported.
      </span>
    </div>
  );
}
