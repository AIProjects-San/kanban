"use client";

// P7 (PR-20/PR-21, F3.3) — the gratuity rule editor modal: the enabled
// switch, the earnings averaging window, and the years→fraction slab table
// (add/remove rows). The pure kernel validates the draft live (overlaps,
// inverted bands) and previews what the rule pays at three sample service
// lengths; the non-statutory disclaimer renders before the save button.
// Saving writes config only — the rule prices future FnF statements.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Scale, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import { getGratuityRule, saveGratuityRule } from "@/server-actions/payroll-gratuity";
import { computeGratuity, validateGratuityRuleInput, GRATUITY_DISCLAIMER } from "@/lib/payroll/gratuity";
import type { GratuityRuleT } from "@/lib/types";

/** A slab as the editor holds it (strings while typing, parsed on save). */
interface SlabDraft {
  fromYears: string;
  toYears: string;
  fraction: string;
}

const EMPTY_RULE: { enabled: boolean; averagingMonths: string; slabs: SlabDraft[] } = {
  enabled: false,
  averagingMonths: "3",
  slabs: [
    { fromYears: "1", toYears: "2", fraction: "0" },
    { fromYears: "3", toYears: "4", fraction: "0.25" },
    { fromYears: "5", toYears: "", fraction: "0.5" },
  ],
};

function parseDraft(draft: { enabled: boolean; averagingMonths: string; slabs: SlabDraft[] }) {
  const averaging = Number(draft.averagingMonths);
  const slabs = draft.slabs.map((s) => ({
    fromYears: Number(s.fromYears),
    toYears: s.toYears.trim() === "" ? null : Number(s.toYears),
    fraction: Number(s.fraction),
  }));
  return {
    enabled: draft.enabled,
    averagingMonths: Number.isFinite(averaging) ? averaging : NaN,
    slabs,
  };
}

/** What the rule pays at a sample service length, $10,000 average. */
function sampleAmount(
  slabs: Array<{ fromYears: number; toYears: number | null; fraction: number }>,
  completedYears: number,
): number {
  return computeGratuity({
    service: { completedYears, extraMonths: 0, totalMonths: completedYears * 12 },
    averageMonthlyEarnings: 10_000,
    slabs,
  }).amount;
}

export function GratuityRuleModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(EMPTY_RULE);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getGratuityRule();
    setLoading(false);
    if (!res.ok) { toast.error(res.error); return; }
    const rule: GratuityRuleT = res.data;
    setDraft({
      enabled: rule.enabled,
      averagingMonths: String(rule.averagingMonths),
      slabs: rule.slabs.length > 0
        ? rule.slabs.map((s) => ({
            fromYears: String(s.fromYears),
            toYears: s.toYears === null ? "" : String(s.toYears),
            fraction: String(s.fraction),
          }))
        : EMPTY_RULE.slabs,
    });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void load();
  }, [open, load]);

  const parsed = parseDraft(draft);
  const plan =
    Number.isInteger(parsed.averagingMonths) && parsed.slabs.every((s) =>
      Number.isFinite(s.fromYears) && (s.toYears === null || Number.isFinite(s.toYears)) && Number.isFinite(s.fraction),
    )
      ? validateGratuityRuleInput(parsed)
      : ({ ok: false as const, reason: "Fill every slab field (leave “to” empty for open-ended bands)." });

  const setSlab = (i: number, patch: Partial<SlabDraft>) => {
    setDraft((d) => ({ ...d, slabs: d.slabs.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plan.ok) { toast.error(plan.reason); return; }
    setBusy(true);
    const res = await saveGratuityRule(parsed);
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Gratuity rule saved — ${parsed.enabled ? "prices future full-and-final statements" : "disabled"}.`);
    onChanged();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Gratuity rule"
      description="The slab rule that prices the gratuity line on future full-and-final statements.">
      <form onSubmit={submit} className="space-y-3" data-testid="gratuity-form">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 size={16} className="animate-spin mr-2" /> Loading the rule…
          </div>
        ) : (
          <>
            <FormRow>
              <Field label="Enabled">
                <label className="flex items-center gap-2 f-input cursor-pointer" data-testid="gratuity-enabled">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
                  />
                  <span className="text-sm">Price gratuity into full-and-final statements</span>
                </label>
              </Field>
              <Field label="Earnings averaging (months)">
                <input className="f-input" type="number" min={1} max={12} step={1}
                  value={draft.averagingMonths}
                  onChange={(e) => setDraft((d) => ({ ...d, averagingMonths: e.target.value }))}
                  data-testid="gratuity-averaging" />
              </Field>
            </FormRow>

            <div className="rounded-md border border-border">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Slabs — completed years → months of average earnings per year
                </div>
                <button
                  type="button"
                  className="f-btn f-btn-ghost text-xs"
                  onClick={() => setDraft((d) => ({ ...d, slabs: [...d.slabs, { fromYears: "", toYears: "", fraction: "" }] }))}
                  data-testid="gratuity-add-slab"
                >
                  <Plus size={13} /> Slab
                </button>
              </div>
              <div className="divide-y divide-border" data-testid="gratuity-slab-rows">
                {draft.slabs.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2">
                    <input className="f-input w-20" type="number" min={0} step={1} placeholder="from yr"
                      value={s.fromYears} onChange={(e) => setSlab(i, { fromYears: e.target.value })}
                      aria-label={`Slab ${i + 1} from year`} />
                    <span className="text-xs text-muted-foreground">to</span>
                    <input className="f-input w-20" type="number" min={1} step={1} placeholder="∞"
                      value={s.toYears} onChange={(e) => setSlab(i, { toYears: e.target.value })}
                      aria-label={`Slab ${i + 1} to year (empty = open-ended)`} />
                    <span className="text-xs text-muted-foreground">×</span>
                    <input className="f-input w-24" type="number" min={0} step={0.05} placeholder="0.5"
                      value={s.fraction} onChange={(e) => setSlab(i, { fraction: e.target.value })}
                      aria-label={`Slab ${i + 1} fraction of monthly earnings`} />
                    <span className="text-xs text-muted-foreground grow hidden sm:block">mo/yr</span>
                    <button
                      type="button"
                      className="f-btn f-btn-ghost text-xs shrink-0 text-rose-500"
                      onClick={() => setDraft((d) => ({ ...d, slabs: d.slabs.filter((_, j) => j !== i) }))}
                      aria-label={`Remove slab ${i + 1}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                {draft.slabs.length === 0 && (
                  <div className="px-3 py-3 text-sm text-muted-foreground">
                    No slabs — an enabled rule pays nothing (every year uncovered).
                  </div>
                )}
              </div>
            </div>

            {plan.ok ? (
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400" data-testid="gratuity-preview">
                At a $10,000 average: 3 yr → {`$${sampleAmount(plan.slabs, 3).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                {" · "}5 yr → {`$${sampleAmount(plan.slabs, 5).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                {" · "}10 yr → {`$${sampleAmount(plan.slabs, 10).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </div>
            ) : (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{plan.reason}</div>
            )}

            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
              <Scale size={13} className="shrink-0 mt-0.5" />
              <span>{GRATUITY_DISCLAIMER}</span>
            </div>

            <div className="flex justify-end">
              <button type="submit" className="f-btn f-btn-primary" disabled={busy || !plan.ok} data-testid="gratuity-submit">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Scale size={15} />} Save rule
              </button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
