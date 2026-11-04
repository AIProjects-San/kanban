"use client";

// Recruitment R1 — hiring stage-template editor (hiring:config).
// The workspace pipeline template: add / rename / retype / reorder / disable
// stages. Per the configurability contract, existing candidates keep their
// snapshotted timelines — edits apply to NEW candidates only.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import type { HiringStageConfigT } from "@/lib/types";
import { HIRING_STAGE_TYPES } from "@/lib/validation";
import { getStageTemplates, saveStageTemplate, deleteStageTemplate } from "@/server-actions/hiring";

const TYPE_LABEL: Record<string, string> = {
  SCREENING: "Screening", INTERVIEW: "Interview", ASSESSMENT: "Assessment",
  BG_CHECK: "Background check", DOCUMENTS: "Documents", OFFER: "Offer", CUSTOM: "Custom",
};

interface Draft {
  id?: string;
  key: string;
  label: string;
  stageType: string;
  ownerRole: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
}

export function HiringStageModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [stages, setStages] = useState<HiringStageConfigT[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await getStageTemplates();
    if (res.ok) setStages(res.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { void load(); setDraft(null); }
  }, [open, load]);

  const move = async (stage: HiringStageConfigT, dir: -1 | 1) => {
    const sorted = stages.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex((s) => s.id === stage.id);
    const swapWith = sorted[idx + dir];
    if (!swapWith) return;
    setBusy(true);
    await saveStageTemplate({ ...stage, sortOrder: swapWith.sortOrder });
    await saveStageTemplate({ ...swapWith, sortOrder: stage.sortOrder });
    setBusy(false);
    await load();
    onChanged();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    const res = await saveStageTemplate(draft);
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(draft.id ? "Stage updated — new candidates will use it." : "Stage added to the template.");
    setDraft(null);
    await load();
    onChanged();
  };

  const remove = async (stage: HiringStageConfigT) => {
    setBusy(true);
    const res = await deleteStageTemplate({ id: stage.id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Stage "${stage.label}" removed from the template.`);
    await load();
    onChanged();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Hiring stage template"
      description="The pipeline every new candidate enters. Existing candidates keep their snapshotted stages."
      size="lg"
    >
      <div className="space-y-3" data-testid="stage-template-list">
        {stages
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s, i, arr) => (
            <div key={s.id} className="rounded-lg border border-border p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{s.label}</span>
                  <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
                    {TYPE_LABEL[s.stageType] ?? s.stageType}
                  </span>
                  <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{s.ownerRole}</span>
                  {!s.isActive && <span className="text-[0.625rem] text-amber-500">inactive</span>}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 font-mono">{s.key}</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="f-btn f-btn-icon" aria-label={`Move ${s.label} up`} disabled={busy || i === 0} onClick={() => move(s, -1)}>
                  <ChevronUp size={14} />
                </button>
                <button className="f-btn f-btn-icon" aria-label={`Move ${s.label} down`} disabled={busy || i === arr.length - 1} onClick={() => move(s, 1)}>
                  <ChevronDown size={14} />
                </button>
                <button className="f-btn f-btn-icon" aria-label={`Edit ${s.label}`} disabled={busy} onClick={() => setDraft(s)}>
                  <span className="text-xs px-1">Edit</span>
                </button>
                <button className="f-btn f-btn-icon text-destructive" aria-label={`Delete ${s.label}`} disabled={busy} onClick={() => remove(s)} data-testid={`delete-stage-${s.key}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        {loaded && stages.length === 0 && (
          <div className="text-sm text-muted-foreground">No stages yet — add the first one below.</div>
        )}
      </div>

      {draft ? (
        <form onSubmit={save} className="mt-4 pt-4 border-t border-border space-y-3" data-testid="stage-draft-form">
          <FormRow>
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
          </FormRow>
          <FormRow>
            <Field label="Stage type">
              <select className="f-input" value={draft.stageType} onChange={(e) => setDraft({ ...draft, stageType: e.target.value })}>
                {HIRING_STAGE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </Field>
            <Field label="Default owner role">
              <select className="f-input" value={draft.ownerRole} onChange={(e) => setDraft({ ...draft, ownerRole: e.target.value })}>
                {["HR", "MANAGER", "ADMIN", "MEMBER"].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
          </FormRow>
          <Field label="Description">
            <input className="f-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
            Active (included for new candidates)
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="f-btn f-btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
            <button type="submit" className="f-btn f-btn-primary" disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : "Save stage"}
            </button>
          </div>
        </form>
      ) : (
        <button
          className="f-btn f-btn-secondary mt-4"
          disabled={busy}
          onClick={() => setDraft({ key: "", label: "", stageType: "CUSTOM", ownerRole: "HR", description: "", sortOrder: (stages.length + 1) * 10, isActive: true })}
          data-testid="add-template-stage-btn"
        >
          <Plus size={15} /> Add stage
        </button>
      )}
    </Modal>
  );
}
