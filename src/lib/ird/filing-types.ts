// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — client-safe wire types for the filing UI.
// (Server-action files cannot export types to client components cleanly,
// so the DTOs live here; the actions in
// src/server-actions/payday-filing.ts build them.)
// ---------------------------------------------------------------------------

import type { ReconciliationReport } from "./reconciliation";

export interface PayrollFilingSettingsT {
  employerIrdNumber: string;
  employerName: string;
  payeIntermediaryIrd: string;
  payrollContactName: string;
  payrollContactPhone: string;
  payrollContactEmail: string;
  payrollPackageIdentifier: string;
  irFormVersionNumber: string;
}

export interface PaydayFilingSummaryT {
  id: string;
  employerIrd: string;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  payCycle: string;
  status: string;
  totalEmployeeLines: number;
  totalGrossCents: number;
  totalPayeCents: number;
  totalKiwisaverEmployeeCents: number;
  totalKiwisaverEmployerNetCents: number;
  totalEsctCents: number;
  totalStudentLoanCents: number;
  dueDate: string;
  overdueFlaggedAt: string | null;
  generatedAt: string | null;
  generatedById: string | null;
  filedAt: string | null;
  filedById: string | null;
  irdReference: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  irdErrorReport: string | null;
  amendedByFilingId: string | null;
  /** True when the frozen file bytes exist (the download button). */
  hasFile: boolean;
  /** Whole working days remaining (negative = overdue). */
  workingDaysRemaining: number;
  /** The run period keys this filing covers (display). */
  runPeriods: string[];
}

export interface RunFilingPanelT {
  run: {
    id: string;
    period: string;
    frequency: string;
    status: string;
    startDate: string | null;
    endDate: string | null;
    payDate: string | null;
  };
  filingCadenceSupported: boolean;
  filing: PaydayFilingSummaryT | null;
  reconciliation: ReconciliationReport | null;
  amendments: Array<{
    id: string;
    status: string;
    correctionCount: number;
    generatedAt: string | null;
    filedAt: string | null;
    acceptedAt: string | null;
  }>;
}

export interface EmployeeDetailsFilingT {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeIrd: string;
  kind: string;
  status: string;
  generatedAt: string | null;
  filedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  irdErrorReport: string | null;
}

export interface PendingEmployeeDetailsT {
  userId: string;
  name: string;
  email: string;
  kind: "NEW" | "DEPARTING";
  reason: string;
}

export interface EmployeeDetailsViewT {
  periodKey: string;
  pending: PendingEmployeeDetailsT[];
  filed: EmployeeDetailsFilingT[];
}

export interface AmendmentCorrectionT {
  employeeId: string;
  employeeName: string;
  /** Corrected money fields, DOLLARS (null = leave as filed). */
  gross?: number | null;
  paye?: number | null;
  studentLoan?: number | null;
  kiwisaverEmployee?: number | null;
  kiwisaverEmployerNet?: number | null;
  esct?: number | null;
  /** Null = DELETE the line; true = update with the values above. */
  delete?: boolean;
}
