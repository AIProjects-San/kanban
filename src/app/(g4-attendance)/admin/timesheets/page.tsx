import { getTimesheetsForReview } from "@/server-actions/timesheets";
import { TimesheetsReviewView } from "@/components/admin/timesheets-review-view";

// ---------------------------------------------------------------------------
// G4 — the timesheet review queue (attendance:manage): every timesheet
// with status filters, the approve / reject decisions and the drill-down
// into an employee's sheet.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function TimesheetsReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const res = await getTimesheetsForReview(status ? { status } : undefined);
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return <TimesheetsReviewView sheets={res.data} activeStatus={status ?? "ALL"} />;
}
