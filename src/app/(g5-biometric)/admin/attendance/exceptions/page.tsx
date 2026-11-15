import { getAttendanceExceptions } from "@/server-actions/biometric";
import { AttendanceExceptionsView } from "@/components/admin/biometric-exceptions-view";

// ---------------------------------------------------------------------------
// G5 — the attendance exception queue (/admin/attendance/exceptions):
// unmatched punches (manual override), duplicates, and the missing
// IN/OUT days.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function BiometricExceptionsPage() {
  const res = await getAttendanceExceptions();
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return (
    <AttendanceExceptionsView
      unmatched={res.data.unmatched}
      duplicates={res.data.duplicates}
      missingOut={res.data.missingOut}
      missingIn={res.data.missingIn}
      employees={res.data.employees}
    />
  );
}
