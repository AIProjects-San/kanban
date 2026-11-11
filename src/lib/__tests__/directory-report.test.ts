import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P32 (EM-R02) — the employee_information report kernel tests. The CSV
// mirrors the directory roster card's facts; every display string arrives
// already resolved (the action resolves the department + employment-status
// labels), so the kernel is pure byte-shaping: the header, the deterministic
// (name, employee number) order, blank unset fields, RFC 4180 escaping and
// the CRLF body.
// ---------------------------------------------------------------------------

import { employeeInformationCsv } from "@/lib/directory-report";

const GENERATED_AT = new Date("2026-11-11T04:00:00.000Z");

describe("directory-report — the file shape", () => {
  it("leads with the identity + disclaimer; the header carries the roster card's facts", () => {
    const csv = employeeInformationCsv({ generatedAt: GENERATED_AT, rows: [] });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("# Employee information — Fernly HR — directory export");
    expect(lines[1]).toContain("Generated 2026-11-11T04:00:00.000Z");
    expect(lines[1]).toContain("non-statutory");
    expect(lines[2]).toBe(
      "Employee no,Employee,Email,Role,Job title,Department,Manager,Employment status,Hire date,Location,Skills",
    );
    expect(lines[3]).toBe("");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("sorts rows by (name, employee number) — deterministic output for diffs", () => {
    const csv = employeeInformationCsv({
      generatedAt: GENERATED_AT,
      rows: [
        { employeeNumber: "EMP-0002", name: "Zoe Zhang", email: "zoe@x.co", role: "MEMBER", jobTitle: "", department: "", managerName: null, employmentStatus: "Not set", hireDate: "", location: "", skills: "" },
        { employeeNumber: "EMP-0001", name: "Ada Lovelace", email: "ada@x.co", role: "ADMIN", jobTitle: "Founding Engineer", department: "Engineering", managerName: null, employmentStatus: "Active", hireDate: "2026-01-05", location: "Auckland, NZ", skills: "" },
        { employeeNumber: null, name: "Ada Bytes", email: "ab@x.co", role: "MEMBER", jobTitle: "", department: "", managerName: null, employmentStatus: "Not set", hireDate: "", location: "", skills: "" },
      ],
    });
    const lines = csv.split("\r\n");
    // "Ada Bytes" < "Ada Lovelace" by name (localeCompare); employee number
    // only breaks exact name ties.
    expect(lines[3].startsWith(",Ada Bytes,")).toBe(true);
    expect(lines[4].startsWith("EMP-0001,Ada Lovelace,")).toBe(true);
    expect(lines[5].startsWith("EMP-0002,Zoe Zhang,")).toBe(true);
  });

  it("unset facts render blank; resolved labels carry through verbatim", () => {
    const csv = employeeInformationCsv({
      generatedAt: GENERATED_AT,
      rows: [
        { employeeNumber: null, name: "Theo Vance", email: "theo@x.co", role: "MEMBER", jobTitle: "", department: "", managerName: null, employmentStatus: "Not set", hireDate: "", location: "", skills: "" },
      ],
    });
    const line = csv.split("\r\n")[3];
    // job title / department / manager are blank, employment status carries
    // its resolved "Not set" label, hire date / location / skills blank.
    expect(line).toBe(",Theo Vance,theo@x.co,MEMBER,,,,Not set,,,");
  });

  it("RFC 4180 escapes names/skills through the shared escaper", () => {
    const csv = employeeInformationCsv({
      generatedAt: GENERATED_AT,
      rows: [
        { employeeNumber: "EMP-0003", name: 'Solberg, "Ingrid"', email: "ingrid@x.co", role: "HR", jobTitle: "Research Analyst", department: "Research", managerName: "Ada Lovelace", employmentStatus: "Probation", hireDate: "2026-02-02", location: "Wellington", skills: "SQL, Python" },
      ],
    });
    const line = csv.split("\r\n")[3];
    expect(line).toBe(
      'EMP-0003,"Solberg, ""Ingrid""",ingrid@x.co,HR,Research Analyst,Research,Ada Lovelace,Probation,2026-02-02,Wellington,"SQL, Python"',
    );
  });
});
