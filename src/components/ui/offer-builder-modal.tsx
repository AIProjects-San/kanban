"use client";

// Recruitment R5 — the per-candidate offer builder
// (docs/RECRUITMENT_MODULE_PLAN.md §5). Opened from the candidate detail
// modal for SELECTED candidates: generate an offer from a role template,
// negotiate the components (fixed amounts or % of basic), edit benefits +
// the letter text, with live CTC / net-take-home totals (lib/offer-math.ts).
// R6 will add the tokenized send + e-signature on top of the DRAFT record.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field } from "./field";
import { cn } from "@/lib/utils";
import type { CandidateT, OfferComponentT, OfferRecordT, OfferTemplateT } from "@/lib/types";
import {
  createOfferRecord,
  getOfferRecords,
  getOfferTemplates,
  updateOfferRecord,
} from "@/server-actions/hiring";
import { computeOffer, formatMoney } from "@/lib/offer-math";

const OFFER_STATUS_CLS: Record<string, string> = {
  DRAFT: "bg-amber-500/10 text-amber-600",
  SENT: "bg-indigo-500/10 text-indigo-600",
  SIGNED: "bg-emerald-500/10 text-emerald-600",
  DECLINED: "bg-destructive/10 text-destructive",
};

const KIND_LABEL: Record<string, string> = {
  EARNING: "Earning",
  EMPLOYER_CONTRIBUTION: "Employer",
  DEDUCTION: "Deduction",
};

function newComponent(): OfferComponentT {
  return { key: "", label: "", kind: "EARNING", mode: "FIXED", amount: 0 };
}

export function OfferBuilderModal({
  open,
  onClose,
  onChanged,
  candidate,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  candidate: CandidateT | null;
}) {
  const [templates, setTemplates] = useState<OfferTemplateT[]>([]);
  const [offers, setOffers] = useState<OfferRecordT[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [genTemplateId, setGenTemplateId] = useState("");

  // Draft editor state.
  const [editing, setEditing] = useState<OfferRecordT | null>(null);
  const [components, setComponents] = useState<OfferComponentT[]>([]);
  const [benefitsText, setBenefitsText] = useState("");
  const [letterText, setLetterText] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async (cid: string) => {
    const [tplRes, offerRes] = await Promise.all([getOfferTemplates(), getOfferRecords()]);
    if (tplRes.ok) setTemplates(tplRes.data);
    if (offerRes.ok) setOffers(offerRes.data.filter((o) => o.candidateId === cid));
    setLoaded(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && candidate) { setLoaded(false); setEditing(null); setGenTemplateId(""); void load(candidate.id); }
  }, [open, candidate, load]);

  const totals = useMemo(() => computeOffer(components), [components]);

  if (!candidate) return null;
  const c = candidate;
  const activeTemplates = templates.filter((t) => t.isActive);

  const openDraft = (o: OfferRecordT) => {
    setEditing(o);
    setComponents(o.components.map((x) => ({ ...x })));
    setBenefitsText(o.benefits.join("\n"));
    setLetterText(o.letterText);
    setNotes(o.notes);
  };

  const generate = async () => {
    if (!genTemplateId) { toast.error("Pick a template first."); return; }
    setBusy(true);
    const res = await createOfferRecord({ candidateId: c.id, templateId: genTemplateId });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Draft offer generated — adjust the numbers below.");
    onChanged();
    await load(c.id);
    // Open the fresh draft for editing.
    const fresh = await getOfferRecords();
    if (fresh.ok) {
      const mine = fresh.data.filter((o) => o.candidateId === c.id);
      setOffers(mine);
      const draft = mine.find((o) => o.id === res.data.id);
      if (draft) openDraft(draft);
    }
  };

  const saveDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    if (components.some((x) => !x.key.trim() || !x.label.trim())) {
      toast.error("Every component needs a key and a label.");
      return;
    }
    setBusy(true);
    const res = await updateOfferRecord({
      id: editing.id,
      components,
      benefits: benefitsText.split("\n").map((b) => b.trim()).filter(Boolean),
      letterText,
      notes,
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Draft offer saved.");
    onChanged();
    await load(c.id);
    setEditing(null);
  };

  const patch = (i: number, part: Partial<OfferComponentT>) => {
    setComponents((prev) => prev.map((x, idx) => (idx === i ? { ...x, ...part } : x)));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Offer — ${c.fullName}`}
      description={c.status === "SELECTED" ? "Generate from a role template, then negotiate the numbers. Sending + e-signature arrive with the next milestone." : "Offer records for this candidate."}
      size="lg"
    >
      {/* Existing offers */}
      <div className="space-y-1.5" data-testid="offer-list">
        {!loaded && <div className="text-xs text-muted-foreground">Loading offers…</div>}
        {offers.map((o) => {
          const t = computeOffer(o.components);
          return (
            <div key={o.id} className="rounded-md border border-border px-3 py-2 flex items-center gap-2 flex-wrap" data-testid={`offer-row-${o.id}`}>
              <span className="text-sm font-medium">{o.templateLabel || "Custom offer"}</span>
              <span className={cn("text-[0.625rem] font-semibold px-1.5 py-0.5 rounded", OFFER_STATUS_CLS[o.status] ?? "bg-muted text-muted-foreground")}>
                {o.status}
              </span>
              <span className="text-xs text-muted-foreground">CTC {formatMoney(t.ctc)}</span>
              <span className="ml-auto" />
              {o.status === "DRAFT" && (
                <button className="f-btn f-btn-ghost text-xs" disabled={busy} onClick={() => openDraft(o)} data-testid={`edit-offer-${o.id}`}>
                  Edit draft
                </button>
              )}
              {editing?.id === o.id && (
                <button className="f-btn f-btn-icon" aria-label="Close editor" onClick={() => setEditing(null)}>
                  <X size={14} />
                </button>
              )}
            </div>
          );
        })}
        {loaded && offers.length === 0 && (
          <div className="text-xs text-muted-foreground">No offer yet.</div>
        )}
      </div>

      {/* Generate (SELECTED only) */}
      {c.status === "SELECTED" && (
        <div className="mt-3 flex items-end gap-2 flex-wrap">
          <div className="grow min-w-[220px]">
            <Field label="Generate from template">
              <select
                className="f-input"
                value={genTemplateId}
                onChange={(e) => setGenTemplateId(e.target.value)}
                data-testid="offer-template-select"
              >
                <option value="">— Pick a role template —</option>
                {activeTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </Field>
          </div>
          <button className="f-btn f-btn-secondary" disabled={busy || !genTemplateId} onClick={generate} data-testid="generate-offer-btn">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Generate
          </button>
        </div>
      )}

      {/* Draft editor */}
      {editing && (
        <form onSubmit={saveDraft} className="mt-4 pt-4 border-t border-border space-y-3" data-testid="offer-editor">
          <div className="space-y-1.5">
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Annual components</div>
            {components.map((comp, i) => (
              <div key={i} className="flex items-center gap-1.5 flex-wrap" data-testid={`offer-component-${i}`}>
                <input
                  className="f-input text-xs grow min-w-[110px]" placeholder="Label (e.g. Basic Salary)"
                  value={comp.label}
                  onChange={(e) => patch(i, {
                    label: e.target.value,
                    key: comp.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50),
                  })}
                  maxLength={120}
                />
                <select className="f-input text-xs w-auto" value={comp.kind} onChange={(e) => patch(i, { kind: e.target.value as OfferComponentT["kind"] })} aria-label="Kind">
                  {Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
                <select className="f-input text-xs w-auto" value={comp.mode} onChange={(e) => patch(i, { mode: e.target.value as OfferComponentT["mode"] })} aria-label="Mode">
                  <option value="FIXED">$/yr</option>
                  <option value="PERCENT_OF_BASIC">% basic</option>
                </select>
                <input
                  className="f-input text-xs w-24" type="number" min={0} step="0.01"
                  value={comp.amount}
                  onChange={(e) => patch(i, { amount: Number(e.target.value) })}
                  aria-label="Amount"
                />
                <span className="text-xs text-muted-foreground w-20 text-right tabular-nums">
                  {comp.mode === "PERCENT_OF_BASIC" ? formatMoney(totals.resolved[comp.key] ?? 0) : ""}
                </span>
                <button
                  type="button" className="f-btn f-btn-icon text-destructive" aria-label={`Remove ${comp.label || "component"}`}
                  onClick={() => setComponents((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button type="button" className="f-btn f-btn-ghost text-xs" onClick={() => setComponents((prev) => [...prev, newComponent()])} data-testid="add-component-btn">
              <Plus size={13} /> Add component
            </button>
          </div>

          {/* Live totals */}
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs" data-testid="offer-totals">
            <div><div className="text-muted-foreground">Earnings</div><div className="font-semibold tabular-nums">{formatMoney(totals.earnings)}</div></div>
            <div><div className="text-muted-foreground">Employer</div><div className="font-semibold tabular-nums">{formatMoney(totals.employerContributions)}</div></div>
            <div><div className="text-muted-foreground">Deductions</div><div className="font-semibold tabular-nums">{formatMoney(totals.deductions)}</div></div>
            <div><div className="text-muted-foreground">Net / yr</div><div className="font-semibold tabular-nums text-primary">{formatMoney(totals.net)}</div></div>
            <div><div className="text-muted-foreground">CTC</div><div className="font-semibold tabular-nums text-emerald-600">{formatMoney(totals.ctc)}</div></div>
          </div>

          <Field label="Benefits (one per line)">
            <textarea
              className="f-input text-xs min-h-[56px]"
              value={benefitsText}
              onChange={(e) => setBenefitsText(e.target.value)}
              data-testid="offer-benefits"
            />
          </Field>
          <Field label="Letter text (sent with the offer; the signing page shows exactly this)">
            <textarea
              className="f-input text-xs min-h-[120px]"
              value={letterText}
              onChange={(e) => setLetterText(e.target.value)}
              data-testid="offer-letter"
              maxLength={10_000}
            />
          </Field>
          <Field label="Internal notes (audit only)">
            <input className="f-input text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2_000} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" className="f-btn f-btn-ghost" onClick={() => setEditing(null)}>Close</button>
            <button type="submit" className="f-btn f-btn-primary" disabled={busy} data-testid="save-offer-btn">
              {busy ? <Loader2 size={15} className="animate-spin" /> : "Save draft"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
