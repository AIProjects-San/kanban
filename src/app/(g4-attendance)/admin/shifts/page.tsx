import { getShifts } from "@/server-actions/shifts";
import { ShiftsMasterView } from "@/components/admin/shifts-master-view";

// ---------------------------------------------------------------------------
// G4 — the shift master (/admin/shifts, attendance:manage): the catalog
// of shift definitions (expected clock times) with its CRUD. isOvernight
// is derived from the clock times server-side, never an author's claim.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function ShiftsPage() {
  const res = await getShifts();
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return <ShiftsMasterView shifts={res.data} />;
}
