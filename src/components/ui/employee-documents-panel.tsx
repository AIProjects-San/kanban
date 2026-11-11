"use client";

// P36 (EM-21) — the employee identification-documents panel
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P36). ONE component,
// two mounts: the HR console's directory (any employee, canManage=true)
// and the Settings self-service surface (the member's own rows — they
// submit, HR verifies).
//
// Lifecycle: REQUESTED → RECEIVED → VERIFIED | REJECTED (a re-request
// after a rejection resets the row — HR may re-chase).

import { useCallback, useEffect, useState } from "react";
import { FileCheck2, FileText, IdCard, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Field } from "./field";
import { Section } from "./section";
import { cn } from "@/lib/utils";
import type { EmployeeDocumentT } from "@/lib/types";
import { EMPLOYEE_DOC_STATUS_LABELS } from "@/lib/employee-documents";
import {
  getEmployeeDocuments,
  requestEmployeeDocument,
  submitEmployeeDocument,
  verifyEmployeeDocument,
  rejectEmployeeDocument,
} from "@/server-actions/hr-employee-documents";

const STATUS_CHIP: Record<EmployeeDocumentT["status"], string> = {
  REQUESTED: "bg-muted text-muted-foreground",
  RECEIVED: "bg-primary/10 text-primary",
  VERIFIED: "bg-success/15 text-success",
  REJECTED: "bg-destructive/10 text-destructive",
};

export function EmployeeDocumentsPanel({
  userId, self,
}: {
  /** The employee being viewed (omit = the signed-in member themself). */
  userId?: string;
  /** true = the Settings self-service mount (no HR action buttons). */
  self: boolean;
}) {
  const [documents, setDocuments] = useState<EmployeeDocumentT[] | null>(null);
  const [docTypes, setDocTypes] = useState<{ key: string; label: string; isMandatory: boolean }[]>([]);
  const [summary, setSummary] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [typeKey, setTypeKey] = useState("");
  const [remarks, setRemarks] = useState("");
  const [fileRefs, setFileRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await getEmployeeDocuments(userId ? { userId } : {});
    if (res.ok) {
      setDocuments(res.data.documents);
      setDocTypes(res.data.docTypes);
      setSummary(res.data.summary);
      setCanManage(res.data.canManage);
    } else {
      toast.error(res.error);
      setDocuments([]);
    }
  }, [userId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okToast: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) { toast.error((res as { error: string }).error); return; }
    toast.success(okToast);
    await load();
  };

  if (documents === null) {
    return <div className="text-sm text-muted-foreground py-2">Loading identification documents…</div>;
  }

  const hrActions = !self && canManage;

  return (
    <div className="space-y-3" data-testid="employee-documents-panel">
      <div className="text-sm text-muted-foreground" data-testid="employee-documents-summary">{summary}</div>
      <div className="space-y-1.5">
        {documents.map((d) => (
          <div
            key={d.id}
            className="rounded-md border border-border px-3 py-2 flex items-center gap-3"
            data-testid={`employee-doc-${d.label}`}
          >
            <FileText size={14} className="text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate flex items-center gap-1.5">
                <span className="truncate">{d.label}</span>
                {d.isMandatory && (
                  <span className="text-[0.5625rem] font-semibold uppercase tracking-wider px-1 py-0.5 rounded bg-warning/15 text-warning">
                    req
                  </span>
                )}
              </div>
              <div className="text-[0.625rem] text-muted-foreground truncate">
                {d.fileRef || "no file reference"}{d.verifiedBy ? ` · verified by ${d.verifiedBy}` : ""}
                {d.remarks ? ` · ${d.remarks}` : ""}
              </div>
            </div>
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium", STATUS_CHIP[d.status])}>
              {EMPLOYEE_DOC_STATUS_LABELS[d.status]}
            </span>
            {(self || hrActions) && (d.status === "REQUESTED" || d.status === "REJECTED") && (
              <div className="flex items-center gap-1 shrink-0">
                <input
                  className="f-input h-7 text-xs w-32"
                  placeholder="file reference"
                  value={fileRefs[d.id] ?? ""}
                  onChange={(e) => setFileRefs((m) => ({ ...m, [d.id]: e.target.value }))}
                  data-testid={`doc-fileref-${d.label}`}
                />
                <button
                  className="f-btn f-btn-secondary f-btn-sm"
                  disabled={busy}
                  onClick={() => void run(
                    () => submitEmployeeDocument({ documentId: d.id, fileRef: fileRefs[d.id] ?? "" }),
                    "Document submitted — HR will verify it.",
                  )}
                  data-testid={`doc-submit-${d.label}`}
                >
                  Submit
                </button>
              </div>
            )}
            {hrActions && d.status === "RECEIVED" && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  className="f-btn f-btn-secondary f-btn-sm"
                  disabled={busy}
                  onClick={() => void run(() => verifyEmployeeDocument({ documentId: d.id }), "Document verified.")}
                  data-testid={`doc-verify-${d.label}`}
                >
                  <FileCheck2 size={12} /> Verify
                </button>
                <button
                  className="f-btn f-btn-ghost f-btn-sm text-destructive"
                  disabled={busy}
                  onClick={() => {
                    const note = window.prompt(`Why is "${d.label}" rejected? (required)`);
                    if (!note) return;
                    void run(() => rejectEmployeeDocument({ documentId: d.id, remarks: note }), "Document rejected — re-request to re-chase.");
                  }}
                  data-testid={`doc-reject-${d.label}`}
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
        {documents.length === 0 && (
          <div className="text-sm text-muted-foreground">No identification documents on file yet.</div>
        )}
      </div>

      {hrActions && (
        <form
          className="rounded-md border border-border p-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!typeKey) return;
            void run(
              () => requestEmployeeDocument({ userId: userId ?? "", docTypeKey: typeKey, remarks }),
              "Document requested.",
            );
            setTypeKey("");
            setRemarks("");
          }}
          data-testid="employee-doc-request-form"
        >
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-2">
            <Field label="Request an identification document">
              <select className="f-input" value={typeKey} onChange={(e) => setTypeKey(e.target.value)} data-testid="employee-doc-type-select" required>
                <option value="" disabled>Pick a type…</option>
                {docTypes.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}{t.isMandatory ? " (mandatory)" : ""}</option>
                ))}
              </select>
            </Field>
            <Field label="Note (optional)">
              <input className="f-input" value={remarks} maxLength={2000} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. for the payroll file" />
            </Field>
          </div>
          <button type="submit" className="f-btn f-btn-secondary f-btn-sm" disabled={busy || !typeKey}>
            <Plus size={12} /> Request
          </button>
        </form>
      )}
      {hrActions && documents.some((d) => d.status === "REJECTED") && (
        <div className="text-[0.625rem] text-muted-foreground flex items-center gap-1">
          <RotateCcw size={10} /> A rejected row can be re-requested (Request again) — history is never silently reopened.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Settings self-service mount (P36/EM-21): the member's own
// identification rows — they submit the file reference; verification is
// HR's decision, so no HR action buttons render here.
// ---------------------------------------------------------------------------

export function MyDocumentsSection() {
  return (
    <Section
      icon={IdCard}
      title="My identification documents"
      description="Documents HR has requested from you — submit the reference and HR verifies it"
    >
      <EmployeeDocumentsPanel self />
    </Section>
  );
}
