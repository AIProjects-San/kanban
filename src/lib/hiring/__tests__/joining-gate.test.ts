import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// F2.10 — the joining gate's pure rule (lib/joining-gate.ts; defect F-R9,
// benchmark E5 required_for_employee_creation). The rule matrix the
// acceptance criteria pin: every mandatory document VERIFIED + every
// background check terminal (FLAGGED is a decision, not a blocker).
// ---------------------------------------------------------------------------

import { evaluateJoiningGate } from "@/lib/hiring/joining-gate";

const TYPES = (over: Partial<Record<string, { isMandatory?: boolean; isActive?: boolean }>> = {}) => [
  { key: "id_proof", label: "ID Document", isMandatory: true, isActive: true, ...over.id_proof },
  { key: "bank_details", label: "Bank Details", isMandatory: true, isActive: true, ...over.bank_details },
  { key: "education", label: "Education Certificates", isMandatory: false, isActive: true, ...over.education },
];

describe("evaluateJoiningGate — documents", () => {
  it("all mandatory VERIFIED → allowed", () => {
    const res = evaluateJoiningGate({
      docTypes: TYPES(),
      documents: [
        { docTypeKey: "id_proof", status: "VERIFIED" },
        { docTypeKey: "bank_details", status: "VERIFIED" },
      ],
      bgChecks: [],
    });
    expect(res.allowed).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(res.summary).toContain("2 of 2 mandatory documents verified");
  });

  it.each([
    ["REQUESTED", "requested, not yet received"],
    ["RECEIVED", "received, not yet verified"],
    ["REJECTED", "rejected"],
  ])("a mandatory document in %s blocks, with the honest reason", (status, phrase) => {
    const res = evaluateJoiningGate({
      docTypes: TYPES(),
      documents: [
        { docTypeKey: "id_proof", status: "VERIFIED" },
        { docTypeKey: "bank_details", status },
      ],
      bgChecks: [],
    });
    expect(res.allowed).toBe(false);
    expect(res.blockers).toEqual([`Bank Details: ${phrase}`]);
  });

  it("a missing mandatory document blocks — \"not requested yet\"", () => {
    const res = evaluateJoiningGate({
      docTypes: TYPES(),
      documents: [{ docTypeKey: "id_proof", status: "VERIFIED" }],
      bgChecks: [],
    });
    expect(res.allowed).toBe(false);
    expect(res.blockers).toEqual(["Bank Details: not requested yet"]);
    expect(res.summary).toContain("1 of 2 mandatory documents verified");
  });

  it("non-mandatory and inactive types never gate", () => {
    const res = evaluateJoiningGate({
      docTypes: [
        ...TYPES({ education: { isMandatory: false } }),
        { key: "old", label: "Retired Type", isMandatory: true, isActive: false },
      ],
      documents: [
        { docTypeKey: "id_proof", status: "VERIFIED" },
        { docTypeKey: "bank_details", status: "VERIFIED" },
        // education stuck at REQUESTED, old never requested — both ignored.
        { docTypeKey: "education", status: "REQUESTED" },
      ],
      bgChecks: [],
    });
    expect(res.allowed).toBe(true);
  });

  it("no mandatory types + no checks → allowed (nothing to gate on)", () => {
    const res = evaluateJoiningGate({
      docTypes: [{ key: "education", label: "Education", isMandatory: false, isActive: true }],
      documents: [],
      bgChecks: [],
    });
    expect(res.allowed).toBe(true);
    expect(res.summary).toBe("no mandatory documents or checks configured");
  });
});

describe("evaluateJoiningGate — background checks", () => {
  it("non-terminal checks block (INITIATED / IN_REVIEW), naming the vendor", () => {
    for (const status of ["INITIATED", "IN_REVIEW"]) {
      const res = evaluateJoiningGate({
        docTypes: [],
        documents: [],
        bgChecks: [{ vendor: "VerifyRight", status }],
      });
      expect(res.allowed).toBe(false);
      expect(res.blockers).toEqual([`Background check (VerifyRight): ${status === "INITIATED" ? "initiated" : "in review"}`]);
    }
  });

  it("terminal checks never block — FLAGGED is a decision HR may proceed on", () => {
    const res = evaluateJoiningGate({
      docTypes: [],
      documents: [],
      bgChecks: [
        { vendor: "VerifyRight", status: "CLEARED" },
        { vendor: "SecondLook", status: "FLAGGED" },
      ],
    });
    expect(res.allowed).toBe(true);
    expect(res.summary).toContain("background checks terminal");
  });

  it("one pending among several blocks only on the pending one", () => {
    const res = evaluateJoiningGate({
      docTypes: [],
      documents: [],
      bgChecks: [
        { vendor: "VerifyRight", status: "CLEARED" },
        { vendor: "SecondLook", status: "IN_REVIEW" },
      ],
    });
    expect(res.allowed).toBe(false);
    expect(res.blockers).toEqual(["Background check (SecondLook): in review"]);
    expect(res.summary).toContain("pending (1)");
  });
});

describe("evaluateJoiningGate — combined", () => {
  it("the full refusal lists every blocker in order (documents first, then checks)", () => {
    const res = evaluateJoiningGate({
      docTypes: TYPES(),
      documents: [{ docTypeKey: "id_proof", status: "RECEIVED" }],
      bgChecks: [{ vendor: "VerifyRight", status: "IN_REVIEW" }],
    });
    expect(res.allowed).toBe(false);
    expect(res.blockers).toEqual([
      "ID Document: received, not yet verified",
      "Bank Details: not requested yet",
      "Background check (VerifyRight): in review",
    ]);
  });
});
