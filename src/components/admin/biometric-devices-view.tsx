"use client";

// ---------------------------------------------------------------------------
// G5 — the biometric device catalog (/admin/settings/biometric/devices):
// CRUD + the adapter-backed connection probe. The push token is write-
// only (the server sends hasPushToken, never the token itself).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Fingerprint, Pencil, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import {
  createBiometricDevice,
  updateBiometricDevice,
  deleteBiometricDevice,
  testDeviceConnection,
} from "@/server-actions/biometric";
import type { BiometricDeviceT } from "@/lib/types";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const VENDORS = ["ZKTECO", "SUPREMA", "HIKVISION", "OTHER"] as const;
const PROTOCOLS = ["ADMS_PUSH", "TCP_POLL", "SDK", "CSV_IMPORT"] as const;

interface Draft {
  id: string | null;
  name: string;
  vendor: string;
  protocol: string;
  serial: string;
  location: string;
  pushToken: string;
  breakMinutes: string;
  isActive: boolean;
}

const BLANK: Draft = {
  id: null,
  name: "",
  vendor: "ZKTECO",
  protocol: "ADMS_PUSH",
  serial: "",
  location: "",
  pushToken: "",
  breakMinutes: "0",
  isActive: true,
};

function fmtSync(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-NZ")} ${d.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" })}`;
}

export function BiometricDevicesView({ devices }: { devices: BiometricDeviceT[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = () => {
    if (!draft) return;
    setBusy(true);
    const isEdit = draft.id !== null;
    const payload = {
      name: draft.name,
      serial: draft.serial || undefined,
      location: draft.location || undefined,
      pushToken: draft.pushToken.trim() ? draft.pushToken.trim() : undefined,
      breakMinutes: Math.max(0, Number.parseInt(draft.breakMinutes || "0", 10) || 0),
    };
    startTransition(async () => {
      const res = isEdit
        ? await updateBiometricDevice({ deviceId: draft.id, ...payload, isActive: draft.isActive })
        : await createBiometricDevice({ ...payload, vendor: draft.vendor, protocol: draft.protocol });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(isEdit ? "Device updated." : "Device registered.");
      setDraft(null);
      router.refresh();
    });
  };

  const toggleActive = (d: BiometricDeviceT) => {
    startTransition(async () => {
      const res = await updateBiometricDevice({ deviceId: d.id, isActive: !d.isActive });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(!d.isActive ? ` "${d.name}" reactivated.` : `"${d.name}" deactivated.`);
      router.refresh();
    });
  };

  const remove = (d: BiometricDeviceT) => {
    startTransition(async () => {
      const res = await deleteBiometricDevice({ deviceId: d.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`"${d.name}" deleted.`);
      router.refresh();
    });
  };

  const test = (d: BiometricDeviceT) => {
    startTransition(async () => {
      const res = await testDeviceConnection({ deviceId: d.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.data.ok) toast.success(`"${d.name}" is reachable and configured.`);
      else toast.warning(`"${d.name}": ${res.data.error ?? "connection failed."}`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="biometric-devices-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Fingerprint size={20} /> Biometric devices
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {devices.length} device{devices.length === 1 ? "" : "s"} — punches arrive via the push endpoint or CSV
            import; vendor polling adapters arrive with the vendor integration.
          </p>
        </div>
        <button className="f-btn f-btn-primary" onClick={() => setDraft({ ...BLANK })} type="button" data-testid="new-device-btn">
          <Plus size={15} /> Register device
        </button>
      </div>

      {draft && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="device-editor">
          <h2 className="text-sm font-semibold">{draft.id ? "Edit device" : "Register a device"}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <input
                className={inputCls}
                placeholder="e.g. Front door scanner"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            {!draft.id && (
              <>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Vendor</span>
                  <select
                    className={inputCls}
                    value={draft.vendor}
                    onChange={(e) => setDraft({ ...draft, vendor: e.target.value })}
                  >
                    {VENDORS.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Protocol</span>
                  <select
                    className={inputCls}
                    value={draft.protocol}
                    onChange={(e) => setDraft({ ...draft, protocol: e.target.value })}
                  >
                    {PROTOCOLS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Serial (optional)</span>
              <input
                className={inputCls}
                placeholder="Device serial no."
                value={draft.serial}
                onChange={(e) => setDraft({ ...draft, serial: e.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Location (optional)</span>
              <input
                className={inputCls}
                placeholder="e.g. Auckland office"
                value={draft.location}
                onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Push token (16+ chars)</span>
              <input
                className={inputCls}
                placeholder={draft.id ? "unchanged" : "e.g. tok_9f3ab2c1de4567ef"}
                value={draft.pushToken}
                onChange={(e) => setDraft({ ...draft, pushToken: e.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Unpaid break (min)</span>
              <input
                className={cn(inputCls, "w-28 text-right")}
                type="number"
                min="0"
                max="480"
                value={draft.breakMinutes}
                onChange={(e) => setDraft({ ...draft, breakMinutes: e.target.value })}
              />
            </label>
            {draft.id && (
              <label className="flex items-end gap-2 pb-1.5">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={draft.isActive}
                  onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                />
                <span className="text-sm">Active</span>
              </label>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button className="f-btn f-btn-primary" type="button" disabled={busy || pending || !draft.name.trim()} onClick={save}>
              {busy || pending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {draft.id ? "Save changes" : "Register"}
            </button>
            <button className="f-btn f-btn-ghost" type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Device</th>
              <th className="px-4 py-2.5 font-medium">Vendor / protocol</th>
              <th className="px-4 py-2.5 font-medium">Serial</th>
              <th className="px-4 py-2.5 font-medium">Last sync</th>
              <th className="px-4 py-2.5 font-medium text-right">Punches</th>
              <th className="px-4 py-2.5 font-medium text-right">Mappings</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  No biometric devices yet — register one to start ingesting punches.
                </td>
              </tr>
            )}
            {devices.map((d) => (
              <tr key={d.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5">
                  <p className="font-medium">{d.name}</p>
                  <p className="text-xs text-muted-foreground">{d.location || "—"}</p>
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-xs">{d.vendor}</span>
                  <p className="text-xs text-muted-foreground">{d.protocol}</p>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">{d.serial || "—"}</td>
                <td className="px-4 py-2.5 text-xs">{fmtSync(d.lastSyncAt)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{d.punchCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{d.mappingCount}</td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      d.isActive ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {d.isActive ? "Active" : "Inactive"}
                  </span>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {d.hasPushToken ? "token set" : "no token"} · {d.breakMinutes}m break
                  </p>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                      title="Test connection"
                      type="button"
                      onClick={() => test(d)}
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                      title={d.isActive ? "Deactivate" : "Reactivate"}
                      type="button"
                      onClick={() => toggleActive(d)}
                    >
                      <Power size={14} />
                    </button>
                    <button
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                      title="Edit"
                      type="button"
                      onClick={() =>
                        setDraft({
                          id: d.id,
                          name: d.name,
                          vendor: d.vendor,
                          protocol: d.protocol,
                          serial: d.serial ?? "",
                          location: d.location ?? "",
                          pushToken: "",
                          breakMinutes: String(d.breakMinutes),
                          isActive: d.isActive,
                        })
                      }
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                      title="Delete"
                      type="button"
                      onClick={() => remove(d)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
