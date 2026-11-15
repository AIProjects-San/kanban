import { getRosterDay } from "@/server-actions/shifts";
import { RosterDayView } from "@/components/admin/roster-day-view";

// ---------------------------------------------------------------------------
// G4 — one roster day (/admin/shifts/roster/[date], attendance:manage):
// the day's slots with assign / swap / unassign / status corrections and
// the explicit absence-detection pass (assigned but unmarked → ABSENT).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function RosterDayPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        Not a valid yyyy-mm-dd date.
      </div>
    );
  }
  const res = await getRosterDay({ date });
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return <RosterDayView {...res.data} />;
}
