"use client";

import { useEffect, useState } from "react";
import { Loader2, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import { DEPARTMENT_LABELS } from "@/lib/config";
import { applyEmploymentChange } from "@/server-actions/employment";
import type { EmployeeProfileT } from "@/lib/types";

// ---------------------------------------------------------------------------
// P33 (EM-06/EM-01, F2.5-lite) — the promotion/transfer modal (the HR
// directory card's Promote / transfer button opens it).
//
// ONE effective-dated change through the guarded applyEmploymentChange
// action: the diff is computed server-side (title / department / manager /
// salary), the salary raise is percent-shaped (FIXED earnings scale;
// percent lines ride the grown basis), and everything lands in ONE
// transaction with structured property-history rows, the structure
// revision and the member's in-app notice.
//
// The form prefills the member's CURRENT facts (the roster's own values);
// leaving a property unchanged records nothing — the server refuses an
// empty diff with the friendly error, so the modal never disables submit
// on "what changed" bookkeeping the server owns.
// ---------------------------------------------------------------------------

export function EmploymentChangeModal({
  profile,
  roster,
  onClose,
  onSaved,
}: {
  profile: EmployeeProfileT | null;
  /** Live members (excluding the subject) for the manager picker. */
  roster: { userId: string; name: string }[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState<"PROMOTION" | "TRANSFER">("PROMOTION");
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [jobTitle, setJobTitle] = useState("");
  const [department, setDepartment] = useState("");
  // P34 (EM-03) — the grade grouping axis is promotable (the registry
  // registered it at P34): a promotion moves "L3" → "L4" like any other
  // property, recorded as a structured diff row.
  const [grade, setGrade] = useState("");
  // "" = no change (the picker never offers it as a value); "__none__" is
  // the explicit clear (a transfer can remove the reporting line).
  const [managerId, setManagerId] = useState("");
  const [raisePercent, setRaisePercent] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (profile) {
      setKind("PROMOTION");
      setEffectiveDate(new Date().toISOString().slice(0, 10));
      setJobTitle(profile.jobTitle);
      setDepartment(profile.department);
      setGrade(profile.grade);
      setManagerId("");
      setRaisePercent("");
      setNote("");
    }
  }, [profile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!profile) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await applyEmploymentChange(profile.userId, {
      kind,
      effectiveDate,
      jobTitle,
      department,
      grade,
      managerId: managerId === "" ? undefined : managerId === "__none__" ? null : managerId,
      raisePercent: raisePercent === "" ? undefined : Number(raisePercent),
      note: note || undefined,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(
        `${kind === "PROMOTION" ? "Promotion" : "Transfer"} applied — ${res.data.applied} property change${res.data.applied === 1 ? "" : "s"} recorded.`,
      );
      onClose();
      await onSaved();
    } else {
      toast.error(res.error);
    }
  };

  return (
    <Modal
      open={Boolean(profile)}
      onClose={onClose}
      title={`Promote or transfer ${profile.name}`}
      description="One effective-dated change — the diff is recorded as structured property history, and a salary raise revises the structure on the same date."
    >
      <form className="space-y-4" onSubmit={submit}>
        <FormRow>
          <Field label="Change type">
            <select
              className="f-input"
              value={kind}
              data-testid="employment-change-kind"
              onChange={(e) => setKind(e.target.value as "PROMOTION" | "TRANSFER")}
            >
              <option value="PROMOTION">Promotion</option>
              <option value="TRANSFER">Transfer</option>
            </select>
          </Field>
          <Field label="Effective date">
            <input
              className="f-input"
              type="date"
              value={effectiveDate}
              data-testid="employment-change-date"
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Job title" hint="Leave unchanged to record nothing">
            <input
              className="f-input"
              maxLength={100}
              value={jobTitle}
              data-testid="employment-change-title"
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </Field>
          <Field label="Department">
            <select
              className="f-input"
              value={department}
              data-testid="employment-change-department"
              onChange={(e) => setDepartment(e.target.value)}
            >
              <option value="">— Not set —</option>
              {DEPARTMENT_LABELS.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </select>
          </Field>
        </FormRow>
        <FormRow>
          {/* P34 (EM-03) — grade is promotable: a ladder move rides the same
              structured diff as the title ("" records "—", the QA-19 shape). */}
          <Field label="Grade" hint="Free-form ladder, e.g. L4 — unchanged records nothing">
            <input
              className="f-input"
              maxLength={64}
              value={grade}
              data-testid="employment-change-grade"
              onChange={(e) => setGrade(e.target.value)}
            />
          </Field>
          <Field label="Reporting manager" hint="Unchanged keeps the current reporting line">
            <select
              className="f-input"
              value={managerId}
              data-testid="employment-change-manager"
              onChange={(e) => setManagerId(e.target.value)}
            >
              <option value="">— No change —</option>
              <option value="__none__">No manager (remove)</option>
              {roster
                .filter((r) => r.userId !== profile?.userId)
                .map((r) => (
                  <option key={r.userId} value={r.userId}>{r.name}</option>
                ))}
            </select>
          </Field>
        </FormRow>
        <FormRow>
          <Field
            label="Salary raise (%)"
            hint="Scales the fixed earnings; percent-based lines ride the grown basis. Needs an active salary structure — the server refuses otherwise."
          >
            <input
              className="f-input"
              type="number"
              min={0.5}
              max={100}
              step={0.5}
              value={raisePercent}
              data-testid="employment-change-raise"
              onChange={(e) => setRaisePercent(e.target.value)}
              placeholder="e.g. 8"
            />
          </Field>
          <Field label="Note (optional, recorded with the change)">
            <input
              className="f-input"
              maxLength={500}
              value={note}
              data-testid="employment-change-note"
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Annual review cycle, effective this quarter"
            />
          </Field>
        </FormRow>
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy} data-testid="employment-change-submit">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpRight size={13} />}
            {busy ? "Applying…" : `Apply ${kind === "PROMOTION" ? "promotion" : "transfer"}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
