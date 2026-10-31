// ---------------------------------------------------------------------------
// L-P1-20 — Audit log retention constants (non-server module).
//
// Constants + types for audit retention, importable by both server actions
// (audit-retention.ts is a "use server" file that can ONLY export async
// functions) and by tests / UI code.
// ---------------------------------------------------------------------------

// Default retention: 180 days (the audit's "hot window" recommendation).
export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

// Safety floor: never prune rows newer than this, even if a misconfigured
// retention value says otherwise. Prevents an admin typo from wiping the log.
export const MIN_AUDIT_RETENTION_DAYS = 30;

export interface PruneResult {
  /** ISO timestamp of the cutoff — rows older than this were deleted */
  cutoff: string;
  /** number of rows deleted */
  deletedCount: number;
  /** retention window in days (after clamping) */
  retentionDays: number;
}
