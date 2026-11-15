import { getPunchLog } from "@/server-actions/biometric";
import { BiometricPunchesView } from "@/components/admin/biometric-punches-view";

// ---------------------------------------------------------------------------
// G5 — the raw punch log (/admin/attendance/punches): filters, the CSV
// fallback import, and the reconcile trigger.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

function asString(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function asPage(v: string | string[] | undefined): number | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

export default async function BiometricPunchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const res = await getPunchLog({
    deviceId: asString(sp.deviceId),
    status: asString(sp.status),
    from: asString(sp.from),
    to: asString(sp.to),
    page: asPage(sp.page),
  });
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return (
    <BiometricPunchesView
      punches={res.data.punches}
      page={res.data.page}
      pageCount={res.data.pageCount}
      devices={res.data.devices}
      activeFilters={{
        deviceId: asString(sp.deviceId) ?? "",
        status: asString(sp.status) ?? "",
        from: asString(sp.from) ?? "",
        to: asString(sp.to) ?? "",
      }}
    />
  );
}
