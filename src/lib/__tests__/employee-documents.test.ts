import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P36 (EM-21) — the employee identification-document lifecycle kernel
// (lib/employee-documents.ts): the state-machine predicates and the
// summary line. The CandidateDocument twin, pinned so the two can never
// drift.
// ---------------------------------------------------------------------------

import {
  canRequestEmployeeDocument,
  canSubmitEmployeeDocument,
  canDecideEmployeeDocument,
  employeeDocumentSummary,
  isDocTypeScope,
} from "@/lib/employee-documents";

describe("the lifecycle predicates", () => {
  it("a fresh REQUESTED or a REJECTED row may be (re-)requested", () => {
    expect(canRequestEmployeeDocument("REQUESTED")).toBe(true);
    expect(canRequestEmployeeDocument("REJECTED")).toBe(true);
    expect(canRequestEmployeeDocument("RECEIVED")).toBe(false);
    expect(canRequestEmployeeDocument("VERIFIED")).toBe(false);
  });

  it("REQUESTED or REJECTED rows may be submitted (RECEIVED); VERIFIED is history", () => {
    expect(canSubmitEmployeeDocument("REQUESTED")).toBe(true);
    expect(canSubmitEmployeeDocument("REJECTED")).toBe(true);
    expect(canSubmitEmployeeDocument("RECEIVED")).toBe(false);
    expect(canSubmitEmployeeDocument("VERIFIED")).toBe(false);
  });

  it("only a RECEIVED row is decisionable (verify/reject)", () => {
    expect(canDecideEmployeeDocument("RECEIVED")).toBe(true);
    for (const s of ["REQUESTED", "VERIFIED", "REJECTED"]) {
      expect(canDecideEmployeeDocument(s)).toBe(false);
    }
  });
});

describe("the summary line", () => {
  it("no rows reads as 'no identification documents on file'", () => {
    expect(employeeDocumentSummary([]).summary).toBe("no identification documents on file");
  });

  it("partial: '1 of 3 verified · 2 outstanding'; all: '2 of 2 verified'", () => {
    expect(employeeDocumentSummary([
      { status: "VERIFIED" }, { status: "RECEIVED" }, { status: "REQUESTED" },
    ]).summary).toBe("1 of 3 verified · 2 outstanding");
    expect(employeeDocumentSummary([
      { status: "VERIFIED" }, { status: "VERIFIED" },
    ]).summary).toBe("2 of 2 verified");
  });

  it("REJECTED counts outstanding (the re-chase is open)", () => {
    const out = employeeDocumentSummary([{ status: "VERIFIED" }, { status: "REJECTED" }]);
    expect(out.outstanding).toBe(1);
    expect(out.verified).toBe(1);
  });
});

describe("the scope axis", () => {
  it("only CANDIDATE | EMPLOYEE are scopes", () => {
    expect(isDocTypeScope("CANDIDATE")).toBe(true);
    expect(isDocTypeScope("EMPLOYEE")).toBe(true);
    expect(isDocTypeScope("BOTH")).toBe(false);
    expect(isDocTypeScope("")).toBe(false);
  });
});
