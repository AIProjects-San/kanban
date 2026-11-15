import { getDeviceMappings } from "@/server-actions/biometric";
import { BiometricMappingsView } from "@/components/admin/biometric-mappings-view";

// ---------------------------------------------------------------------------
// G5 — the device-user ↔ employee mapping table + the CSV bulk import
// (/admin/settings/biometric/mappings).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function BiometricMappingsPage() {
  const res = await getDeviceMappings();
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return (
    <BiometricMappingsView
      mappings={res.data.mappings}
      devices={res.data.devices}
      employees={res.data.employees}
    />
  );
}
