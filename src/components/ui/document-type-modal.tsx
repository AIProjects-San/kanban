"use client";

// Recruitment R4 — joining-formalities document-type editor (hiring:config).
// The workspace checklist template: which documents HR collects from every
// joining candidate. Candidate rows reference types by KEY, so label renames
// never orphan a candidate's history.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import { cn } from "@/lib/utils";
import type { DocumentTypeConfigT } from "@/lib/types";
import { getDocumentTypes, saveDocumentType, deleteDocumentType } from "@/server-actions/hiring-formalities";

interface Draft {
  id?: string;
  key: string;
  label: string;
  description: string;
  isMandatory: boolean;
  // P36 (EM-21) — CANDIDATE (joining formalities) | EMPLOYEE
  // (identification types — never gate a join).
  scope: "CANDIDATE" | "EMPLOYEE";
  sortOrder: number;
  isActive: boolean;
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
}

export function DocumentTypeModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [types, setTypes] = useState<DocumentTypeConfigT[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await getDocumentTypes();
    if (res.ok) setTypes(res.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { void load(); setDraft(null); }
  }, [open, load]);

  const move = async (t: DocumentTypeConfigT, dir: -1 | 1) => {
    const sorted = types.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex((s) => s.id === t.id);
    const swapWith = sorted[idx + dir];
    if (!swapWith) return;
    setBusy(true);
    await saveDocumentType({ ...t, sortOrder: swapWith.sortOrder });
    await saveDocumentType({ ...swapWith, sortOrder: t.sortOrder });
    setBusy(false);
    await load();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    const res = await saveDocumentType(draft);
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(draft.id ? "Document type updated." : "Document type added to the checklist.");
    setDraft(null);
    await load();
    onChanged();
  };

  const remove = async (t: DocumentTypeConfigT) => {
    setBusy(true);
    const res = await deleteDocumentType({ id: t.id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(`Document type "${t.label}" removed (existing candidates keep their history).`);
    await load();
    onChanged();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Joining document types"
      description="The checklist HR collects from every joining candidate. Existing candidates keep their requested documents."
      size="lg"
    >
      <div className="space-y-3" data-testid="doc-type-list">
        {types
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((t, i, arr) => (
            <div key={t.id} className="rounded-lg border border-border p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{t.label}</span>
                  {t.isMandatory && (
                    <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 uppercase tracking-wide">
                      mandatory
                    </span>
                  )}
                  {/* P36 — the scope chip: which flow the type belongs to. */}
                  <span
                    className={cn(
                      "text-[0.625rem] px-1.5 py-0.5 rounded uppercase tracking-wide",
                      t.scope === "EMPLOYEE" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                    )}
                    data-testid={`doc-type-scope-${t.key}`}
                  >
                    {t.scope === "EMPLOYEE" ? "employee id" : "candidate"}
                  </span>
                  {!t.isActive && <span className="text-[0.625rem] text-amber-500">inactive</span>}
                </div>
                {t.description && <div className="text-xs text-muted-foreground mt-0.5">{t.description}</div>}
                <div className="text-xs text-muted-foreground mt-0.5 font-mono">{t.key}</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="f-btn f-btn-icon" aria-label={`Move ${t.label} up`} disabled={busy || i === 0} onClick={() => move(t, -1)}>
                  <ChevronUp size={14} />
                </button>
                <button className="f-btn f-btn-icon" aria-label={`Move ${t.label} down`} disabled={busy || i === arr.length - 1} onClick={() => move(t, 1)}>
                  <ChevronDown size={14} />
                </button>
                <button className="f-btn f-btn-icon" aria-label={`Edit ${t.label}`} disabled={busy} onClick={() => setDraft(t)}>
                  <span className="text-xs px-1">Edit</span>
                </button>
                <button className="f-btn f-btn-icon text-destructive" aria-label={`Delete ${t.label}`} disabled={busy} onClick={() => remove(t)} data-testid={`delete-doc-type-${t.key}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        {loaded && types.length === 0 && (
          <div className="text-sm text-muted-foreground">No document types yet — add the first one below.</div>
        )}
      </div>

      {draft ? (
        <form onSubmit={save} className="mt-4 pt-4 border-t border-border space-y-3" data-testid="doc-type-draft-form">
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
          <Field label="Description">
            <input className="f-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} />
          </Field>
          <Field label="Scope (P36: which flow collects it)">
            <select
              className="f-input" value={draft.scope}
              onChange={(e) => setDraft({ ...draft, scope: e.target.value as Draft["scope"] })}
              data-testid="doc-type-scope-select"
            >
              <option value="CANDIDATE">Candidate — joining formalities (gates the join when mandatory)</option>
              <option value="EMPLOYEE">Employee — identification documents</option>
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm" data-testid="doc-type-mandatory">
            <input type="checkbox" checked={draft.isMandatory} onChange={(e) => setDraft({ ...draft, isMandatory: e.target.checked })} />
            Mandatory (flagged in the joining checklist)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
            Active (available to request)
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="f-btn f-btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
            <button type="submit" className="f-btn f-btn-primary" disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : "Save document type"}
            </button>
          </div>
        </form>
      ) : (
        <button
          className="f-btn f-btn-secondary mt-4"
          disabled={busy}
          onClick={() => setDraft({ key: "", label: "", description: "", isMandatory: false, scope: "CANDIDATE", sortOrder: (types.length + 1) * 10, isActive: true })}
          data-testid="add-doc-type-btn"
        >
          <Plus size={15} /> Add document type
        </button>
      )}
    </Modal>
  );
}
