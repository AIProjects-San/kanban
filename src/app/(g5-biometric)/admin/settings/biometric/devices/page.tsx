import { getBiometricDevices } from "@/server-actions/biometric";
import { BiometricDevicesView } from "@/components/admin/biometric-devices-view";

// ---------------------------------------------------------------------------
// G5 — the device catalog + CRUD + the connection probe (/admin/settings/
// biometric/devices).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function BiometricDevicesPage() {
  const res = await getBiometricDevices();
  if (!res.ok) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {res.error}
      </div>
    );
  }
  return <BiometricDevicesView devices={res.data} />;
}
