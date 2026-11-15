import { getRoster, getShifts } from "@/server-actions/shifts";
import { RosterGridView } from "@/components/admin/roster-grid-view";

// ---------------------------------------------------------------------------
// G4 — the roster grid (/admin/shifts/roster, attendance:manage): one week
// (or month) of slots, drag-drop to move a slot across days. ?from= and
// ?to= bound the window (default: the current Mon–Sun week); ?span=month
// widens it to the from-date's calendar month.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  const delta = dow === 0 ? -6 : 1 - dow;
  return new Date(d.getTime() + delta * 86_400_000).toISOString().slice(0, 10);
}

export default async function RosterPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; span?: string }>;
}) {
  const { from, to, span } = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : mondayOf(today);
  let end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : "";
  if (!end) {
    if (span === "month") {
      const [y, m] = start.split("-").map(Number);
      end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    } else {
      end = new Date(new Date(`${start}T00:00:00.000Z`).getTime() + 6 * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
  }
  const [rosterRes, shiftsRes] = await Promise.all([getRoster({ from: start, to: end }), getShifts()]);
  if (!rosterRes.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {rosterRes.error}
      </div>
    );
  }
  return (
    <RosterGridView
      days={rosterRes.data.days}
      from={start}
      to={end}
      span={span === "month" ? "month" : "week"}
      shifts={shiftsRes.ok ? shiftsRes.data : []}
    />
  );
}
