"use client";

// Recruitment R1 — create/edit candidate modal (docs/RECRUITMENT_MODULE_PLAN.md).
// On create the server instantiates the stage timeline from the active
// template; this form only captures the person.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Field, FormRow } from "./field";
import type { CandidateT } from "@/lib/types";
import { createCandidate, updateCandidate } from "@/server-actions/hiring";

const DEPARTMENTS = ["", "ENGINEERING", "DESIGN", "MARKETING", "MANAGEMENT"];

export function CandidateModal({
  open,
  onClose,
  onSaved,
  edit,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** When set, the modal edits this candidate instead of creating one. */
  edit?: CandidateT | null;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [position, setPosition] = useState("");
  const [department, setDepartment] = useState("");
  const [source, setSource] = useState("");
  const [resumeUrl, setResumeUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFullName(edit?.fullName ?? "");
    setEmail(edit?.email ?? "");
    setPhone(edit?.phone ?? "");
    setPosition(edit?.position ?? "");
    setDepartment(edit?.department ?? "");
    setSource(edit?.source ?? "");
    setResumeUrl(edit?.resumeUrl ?? "");
    setNotes(edit?.notes ?? "");
  }, [open, edit]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const payload = {
      fullName, email, phone, position, department, source, resumeUrl, notes,
    };
    const res = edit
      ? await updateCandidate({ ...payload, id: edit.id })
      : await createCandidate(payload);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(edit ? "Candidate updated." : "Candidate added to the pipeline.");
    onSaved();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={edit ? "Edit candidate" : "Add candidate"}
      description={edit
        ? "Update the candidate's details."
        : "The stage timeline is created from the active pipeline template."}
      size="lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <FormRow>
          <Field label="Full name">
            <input
              className="f-input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              data-testid="candidate-name"
              required
              maxLength={120}
            />
          </Field>
          <Field label="Email">
            <input
              className="f-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="candidate-email"
              required
            />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Phone">
            <input className="f-input" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Position applied for">
            <input
              className="f-input"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="e.g. Senior Frontend Engineer"
              maxLength={120}
            />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Department">
            <select className="f-input" value={department} onChange={(e) => setDepartment(e.target.value)}>
              {DEPARTMENTS.map((d) => (
                <option key={d || "none"} value={d}>{d === "" ? "— Not set —" : d}</option>
              ))}
            </select>
          </Field>
          <Field label="Source">
            <input
              className="f-input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Referral, job board, website…"
              maxLength={60}
            />
          </Field>
        </FormRow>
        <Field label="Resume link">
          <input
            className="f-input"
            value={resumeUrl}
            onChange={(e) => setResumeUrl(e.target.value)}
            placeholder="https://…"
            maxLength={500}
          />
        </Field>
        <Field label="Notes">
          <textarea
            className="f-input min-h-[72px]"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={10_000}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="f-btn f-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary" disabled={busy} data-testid="candidate-submit">
            {busy ? <Loader2 size={15} className="animate-spin" /> : edit ? "Save changes" : "Add candidate"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
