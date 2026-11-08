// ---------------------------------------------------------------------------
// F2.10 — the joining gate (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2
// F2.10 item 3; defect F-R9, benchmark E5 required_for_employee_creation).
//
// PURE rule: given the workspace's document-type template, a candidate's
// document rows and background checks, decide whether markJoined may run.
// The writers (markJoined, getJoiningFormalities) load the rows and call
// this; the UI renders the same result so HR sees the gate before it bites.
//
// Policy (mirrors the benchmark's gate):
//   • every ACTIVE + MANDATORY document type must have a VERIFIED document
//     for the candidate (REQUESTED/RECEIVED/REJECTED all block);
//   • if the candidate has ANY background check, EVERY check must be
//     terminal (CLEARED or FLAGGED) — INITIATED/IN_REVIEW block. A FLAGGED
//     check is a decision: HR may still choose to join the candidate, so
//     the gate reports it but does not block on it;
//   • no mandatory types + no checks = allowed (nothing to gate on).
// ---------------------------------------------------------------------------

export interface JoiningGateDocType {
  key: string;
  label: string;
  isMandatory: boolean;
  isActive: boolean;
}

export interface JoiningGateDocument {
  docTypeKey: string;
  status: string;
}

export interface JoiningGateBgCheck {
  vendor: string;
  status: string;
}

export interface JoiningGateEvaluation {
  /** False when any blocker is outstanding. */
  allowed: boolean;
  /** One human sentence per outstanding blocker (the refusal message and
   * the panel list are built from these). */
  blockers: string[];
  /** "2 of 3 mandatory documents verified · background check in review" —
   * the one-line status the formalities panel shows. */
  summary: string;
}

const DOC_STATUS_WORD: Record<string, string> = {
  REQUESTED: "requested, not yet received",
  RECEIVED: "received, not yet verified",
  REJECTED: "rejected",
};

const BG_STATUS_WORD: Record<string, string> = {
  INITIATED: "initiated",
  IN_REVIEW: "in review",
};

/** Evaluate the joining gate. See the module comment for the policy. */
export function evaluateJoiningGate(input: {
  docTypes: JoiningGateDocType[];
  documents: JoiningGateDocument[];
  bgChecks: JoiningGateBgCheck[];
}): JoiningGateEvaluation {
  const mandatory = input.docTypes.filter((t) => t.isActive && t.isMandatory);
  const docByType = new Map<string, JoiningGateDocument>();
  for (const d of input.documents) docByType.set(d.docTypeKey, d);

  const blockers: string[] = [];
  let verified = 0;

  for (const t of mandatory) {
    const doc = docByType.get(t.key);
    if (doc?.status === "VERIFIED") {
      verified += 1;
      continue;
    }
    const label = t.label?.trim() || t.key;
    if (!doc) {
      blockers.push(`${label}: not requested yet`);
    } else {
      blockers.push(`${label}: ${DOC_STATUS_WORD[doc.status] ?? doc.status.toLowerCase()}`);
    }
  }

  for (const bg of input.bgChecks) {
    if (bg.status !== "CLEARED" && bg.status !== "FLAGGED") {
      const vendor = bg.vendor?.trim() || "background check";
      blockers.push(`Background check (${vendor}): ${BG_STATUS_WORD[bg.status] ?? bg.status.toLowerCase()}`);
    }
  }

  const parts: string[] = [];
  if (mandatory.length > 0) {
    parts.push(`${verified} of ${mandatory.length} mandatory document${mandatory.length === 1 ? "" : "s"} verified`);
  }
  const pendingBg = input.bgChecks.filter((b) => b.status !== "CLEARED" && b.status !== "FLAGGED").length;
  if (input.bgChecks.length > 0) {
    const plural = input.bgChecks.length === 1 ? "" : "s";
    parts.push(pendingBg === 0 ? `background check${plural} terminal` : `background check${plural} pending (${pendingBg})`);
  }
  if (parts.length === 0) {
    parts.push("no mandatory documents or checks configured");
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    summary: parts.join(" · "),
  };
}
