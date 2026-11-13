// ---------------------------------------------------------------------------
// P32 (EM-R02) — the employee_information report (pure kernel).
// Benchmark: hrms/hr/report/employee_information — one row per employee
// with the directory facts. Fernly renders the HR console's directory
// roster (HR module feature 2) as the CSV, deliberately mirroring the
// roster CARD's facts:
//   employee no · name · email · role · job title · department (label) ·
//   grade · employment type (label) · branch · manager (org-chart name) ·
//   employment status · hire date · location · skills
// and deliberately NOT exporting what the card never displays — birthday,
// emergency contact and the HR notes stay out of data files (the PII
// posture: a person's sensitive facts are read on-screen by entitled
// roles, not bulk-exported). Employment status renders its roster label
// ("Not set" when unclassified — a status column should state its
// unknown-ness); every other unset fact renders blank (data files feed
// parsers, "—" is a UI affordance) — the P34 grouping axes follow that
// rule too (grade/branch raw, employment type as its display label).
//
// Rows sort by (name, employee number) for deterministic output — the
// golden-file CSV test owns the bytes.
//
// The file rides the P32 shared `lib/report-csv.ts` helper (RFC 4180
// escaping, the disclaimer header, the CRLF body). Pure and
// dependency-free: the server action resolves every display string (the
// department label, the employment-status label) before calling.
// ---------------------------------------------------------------------------

import { csvRow, reportCsvHeaderLines, csvFileBody } from "@/lib/report-csv";

export interface DirectoryReportRow {
  employeeNumber: string | null;
  name: string;
  email: string;
  /** Raw role key (ADMIN / HR / MANAGER / MEMBER). */
  role: string;
  jobTitle: string;
  /** The display label, or "" when unclassified. */
  department: string;
  /** P34 (EM-03) — the raw ladder string, or "" when ungraded. */
  grade: string;
  /** The display label ("Full-time"…), or "" when unclassified. */
  employmentType: string;
  /** The plain branch string, or "" when unset. */
  branch: string;
  /** The manager's display name, or null when nobody reports above. */
  managerName: string | null;
  /** The display label ("Not set" when unclassified). */
  employmentStatus: string;
  /** "yyyy-mm-dd" or "". */
  hireDate: string;
  location: string;
  skills: string;
}

/**
 * EM-R02 — the employee information CSV: leading comment lines (identity +
 * disclaimer), the header row, one row per member (name-sorted, deleted
 * members already filtered by the caller — the roster hides them and so
 * does the export).
 */
export function employeeInformationCsv(input: {
  generatedAt?: Date;
  rows: DirectoryReportRow[];
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const rows = [...input.rows].sort(
    (a, b) => a.name.localeCompare(b.name) || (a.employeeNumber ?? "").localeCompare(b.employeeNumber ?? ""),
  );
  const lines = [
    ...reportCsvHeaderLines({ kind: "Employee information", scope: "directory export", generatedAt }),
    csvRow([
      "Employee no",
      "Employee",
      "Email",
      "Role",
      "Job title",
      "Department",
      "Grade",
      "Employment type",
      "Branch",
      "Manager",
      "Employment status",
      "Hire date",
      "Location",
      "Skills",
    ]),
    ...rows.map((r) =>
      csvRow([
        r.employeeNumber ?? "",
        r.name,
        r.email,
        r.role,
        r.jobTitle,
        r.department,
        r.grade,
        r.employmentType,
        r.branch,
        r.managerName ?? "",
        r.employmentStatus,
        r.hireDate,
        r.location,
        r.skills,
      ]),
    ),
  ];
  return csvFileBody(lines);
}
