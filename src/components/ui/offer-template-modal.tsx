"use client";

// Recruitment R5 — offer-template editor (hiring:config). Per-role salary
// structures HR configures once: components (fixed or % of basic), benefits
// bullets, and the letter text with {{placeholders}}. Existing offers keep
// their snapshots — template edits never rewrite a live offer.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import type { OfferComponentT, OfferTemplateT } from "@/lib/types";
import { getOfferTemplates, saveOfferTemplate, deleteOfferTemplate } from "@/server-actions/hiring";
import { computeOffer, formatMoney } from "@/lib/offer-math";

interface Draft {
  id?: string;
  key: string;
  label: string;
  description: string;
  components: OfferComponentT[];
  benefitsText: string;
  letterTemplate: string;
  isActive: boolean;
  sortOrder: number;
}

const KIND_LABEL: Record<string, string> = {
  EARNING: "Earning",
  EMPLOYER_CONTRIBUTION: "Employer",
  DEDUCTION: "Deduction",
};

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
}

function toDraft(t: OfferTemplateT): Draft {
  return {
    id: t.id, key: t.key, label: t.label, description: t.description,
    components: t.components.map((c) => ({ ...c })),
    benefitsText: t.benefits.join("\n"),
    letterTemplate: t.letterTemplate,
    isActive: t.isActive, sortOrder: t.sortOrder,
  };
}

export function OfferTemplateModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [templates, setTemplates] = useState<OfferTemplateT[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await getOfferTemplates();
    if (res.ok) setTemplates(res.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { void load(); setDraft(null); }
  }, [open, load]);

  const totals = draft ? computeOffer(draft.components) : null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    if (draft.components.some((x) => !x.key.trim() || !x.label.trim())) {
      toast.error("Every component needs a key and a label.");
      return;
    }
    setBusy(true);
    const res = await saveOfferTemplate({
      id: draft.id,
      key: draft.key,
      label: draft.label,
      description: draft.description,
      components: draft.components,
      benefits: draft.benefitsText.split("\n").map((b) => b.trim()).filter(Boolean),
      letterTemplate: draft.letterTemplate,
      isActive: draft.isActive,
      sortOrder: draft.sortOrder,
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(draft.id ? "Offer template updated." : "Offer template created.");
    setDraft(null);
    await load();
    onChanged();
  };

  const remove = async (t: OfferTemplateT) => {
    setBusy(true);
    const res = await deleteOfferTemplate({ id: t.id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Offer template "${t.label}" removed (existing offers keep their snapshots).`);
    await load();
    onChanged();
  };

  const patch = (i: number, part: Partial<OfferComponentT>) => {
    setDraft((d) => (d ? { ...d, components: d.components.map((x, idx) => (idx === i ? { ...x, ...part } : x)) } : d));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Offer templates"
      description="Per-role salary structures the offer builder generates from. Existing offers keep their snapshots."
      size="lg"
    >
      <div className="space-y-3" data-testid="offer-template-list">
        {templates.map((t) => {
          const tt = computeOffer(t.components);
          return (
            <div key={t.id} className="rounded-lg border border-border p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{t.label}</span>
                  <span className="text-xs text-muted-foreground">CTC {formatMoney(tt.ctc)}</span>
                  <span className="text-xs text-muted-foreground">{t.components.length} components</span>
                  {!t.isActive && <span className="text-[0.625rem] text-amber-500">inactive</span>}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 font-mono">{t.key}</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="f-btn f-btn-icon" aria-label={`Edit ${t.label}`} disabled={busy} onClick={() => setDraft(toDraft(t))}>
                  <span className="text-xs px-1">Edit</span>
                </button>
                <button className="f-btn f-btn-icon text-destructive" aria-label={`Delete ${t.label}`} disabled={busy} onClick={() => remove(t)} data-testid={`delete-offer-template-${t.key}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
        {loaded && templates.length === 0 && (
          <div className="text-sm text-muted-foreground">No offer templates yet — add the first one below.</div>
        )}
      </div>

      {draft ? (
        <form onSubmit={save} className="mt-4 pt-4 border-t border-border space-y-3" data-testid="offer-template-draft-form">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label">
              <input
                className="f-input" value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value, key: draft.id ? draft.key : slugify(e.target.value) })}
                required maxLength={120}
              />
            </Field>
            <Field label="Key (auto from label)">
              <input
                className="f-input font-mono" value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                required maxLength={60} pattern="[a-z0-9_]+"
              />
            </Field>
          </div>
          <Field label="Description">
            <input className="f-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} />
          </Field>

          <div className="space-y-1.5">
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Annual components {totals && <span className="normal-case">· CTC {formatMoney(totals.ctc)} · net {formatMoney(totals.net)}</span>}
            </div>
            {draft.components.map((comp, i) => (
              <div key={i} className="flex items-center gap-1.5 flex-wrap">
                <input
                  className="f-input text-xs grow min-w-[110px]" placeholder="Label"
                  value={comp.label}
                  onChange={(e) => patch(i, {
                    label: e.target.value,
                    key: comp.key || slugify(e.target.value),
                  })}
                  maxLength={120}
                />
                <select className="f-input text-xs w-auto" value={comp.kind} onChange={(e) => patch(i, { kind: e.target.value as OfferComponentT["kind"] })} aria-label="Kind">
                  {Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
                <select className="f-input text-xs w-auto" value={comp.mode} onChange={(e) => patch(i, { mode: e.target.value as OfferComponentT["mode"] })} aria-label="Mode" title="P23: % of gross resolves annually. (% of net is refused in offer templates — net resolves only at payroll time.)">
                  <option value="FIXED">$/yr</option>
                  <option value="PERCENT_OF_BASIC">% basic</option>
                  <option value="PERCENT_OF_GROSS">% gross</option>
                </select>
                <input
                  className="f-input text-xs w-24" type="number" min={0} step="0.01"
                  value={comp.amount}
                  onChange={(e) => patch(i, { amount: Number(e.target.value) })}
                  aria-label="Amount"
                />
                <button
                  type="button" className="f-btn f-btn-icon text-destructive" aria-label={`Remove ${comp.label || "component"}`}
                  onClick={() => setDraft({ ...draft, components: draft.components.filter((_, idx) => idx !== i) })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button
              type="button" className="f-btn f-btn-ghost text-xs"
              onClick={() => setDraft({ ...draft, components: [...draft.components, { key: "", label: "", kind: "EARNING", mode: "FIXED", amount: 0 }] })}
              data-testid="add-template-component-btn"
            >
              <Plus size={13} /> Add component
            </button>
          </div>

          <Field label="Benefits (one per line)">
            <textarea
              className="f-input text-xs min-h-[56px]"
              value={draft.benefitsText}
              onChange={(e) => setDraft({ ...draft, benefitsText: e.target.value })}
            />
          </Field>
          <Field label="Letter template — placeholders: {{candidateName}} {{position}} {{workspaceName}} {{startDate}} {{annualCtc}} {{netPay}}">
            <textarea
              className="f-input text-xs min-h-[100px]"
              value={draft.letterTemplate}
              onChange={(e) => setDraft({ ...draft, letterTemplate: e.target.value })}
              maxLength={10_000}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
            Active (available in the offer builder)
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="f-btn f-btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
            <button type="submit" className="f-btn f-btn-primary" disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : "Save template"}
            </button>
          </div>
        </form>
      ) : (
        <button
          className="f-btn f-btn-secondary mt-4"
          disabled={busy}
          onClick={() => setDraft({ key: "", label: "", description: "", components: [], benefitsText: "", letterTemplate: "", isActive: true, sortOrder: (templates.length + 1) * 10 })}
          data-testid="add-offer-template-btn"
        >
          <Plus size={15} /> Add offer template
        </button>
      )}
    </Modal>
  );
}
