// ---------------------------------------------------------------------------
// P36 (EM-21) — the employee identification-document lifecycle
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P36; the
// CandidateDocument twin). Pure so both sides import it: the server
// actions' guards and the panel's button rendering.
//
// The state machine (the benchmark's Employee Document flow):
//   REQUESTED → RECEIVED → VERIFIED | REJECTED
//   (a re-request after REJECTION resets the row — HR may re-chase.)
//
// Ownership: the member themself may move THEIR OWN row to RECEIVED (the
// self-service submission — they hold the passport); verification and
// rejection stay HR-owned. The row is unique per (userId, docTypeKey).
// ---------------------------------------------------------------------------

export const EMPLOYEE_DOC_STATUSES = ["REQUESTED", "RECEIVED", "VERIFIED", "REJECTED"] as const;
export type EmployeeDocStatus = (typeof EMPLOYEE_DOC_STATUSES)[number];

export const EMPLOYEE_DOC_STATUS_LABELS: Record<EmployeeDocStatus, string> = {
  REQUESTED: "Requested",
  RECEIVED: "Received",
  VERIFIED: "Verified",
  REJECTED: "Rejected",
};

/** The doc-type master's scope axis (P36). */
export const DOC_TYPE_SCOPES = ["CANDIDATE", "EMPLOYEE"] as const;
export type DocTypeScope = (typeof DOC_TYPE_SCOPES)[number];

export function isDocTypeScope(v: unknown): v is DocTypeScope {
  return v === "CANDIDATE" || v === "EMPLOYEE";
}

/** May this row be (re-)requested? Only terminal-ish resets: a REJECTED row
 *  (the re-chase) or a fresh REQUESTED row (the remarks refresh). VERIFIED
 *  rows are done — history, never reopened. */
export function canRequestEmployeeDocument(status: string): boolean {
  return status === "REQUESTED" || status === "REJECTED";
}

/** May the row move to RECEIVED (the member or HR submitting the file)? */
export function canSubmitEmployeeDocument(status: string): boolean {
  return status === "REQUESTED" || status === "REJECTED";
}

/** May HR verify/reject it? Only a RECEIVED row is decisionable. */
export function canDecideEmployeeDocument(status: string): boolean {
  return status === "RECEIVED";
}

/** The one-line status the panel shows: "2 of 3 verified · 1 outstanding". */
export function employeeDocumentSummary(
  docs: Array<{ status: string; isMandatory?: boolean }>,
): { total: number; verified: number; outstanding: number; summary: string } {
  const total = docs.length;
  const verified = docs.filter((d) => d.status === "VERIFIED").length;
  const outstanding = total - verified;
  const summary = total === 0
    ? "no identification documents on file"
    : outstanding === 0
      ? `${total} of ${total} verified`
      : `${verified} of ${total} verified · ${outstanding} outstanding`;
  return { total, verified, outstanding, summary };
}
