"use client";

// ---------------------------------------------------------------------------
// G5 — the device-user ↔ employee mapping table (/admin/settings/
// biometric/mappings): per-device rows, single add/remove, and the CSV
// bulk import (the fallback's fallback — no vendor portal needed).
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Link2, Plus, Trash2, Upload } from "lucide-react";
import { createDeviceMapping, deleteDeviceMapping, importDeviceMappings } from "@/server-actions/biometric";
import type { DeviceMappingT } from "@/lib/types";
import { MAPPINGS_CSV_TEMPLATE } from "@/lib/biometric/punch-csv";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function BiometricMappingsView({
  mappings,
  devices,
  employees,
}: {
  mappings: DeviceMappingT[];
  devices: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState("");
  const [newUserId, setNewUserId] = useState("");
  const [newEmployee, setNewEmployee] = useState("");
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvDevice, setCsvDevice] = useState("");
  const [csvText, setCsvText] = useState("");

  const rows = scope ? mappings.filter((m) => m.deviceId === scope) : mappings;

  const add = () => {
    const deviceId = scope || csvDevice || devices[0]?.id;
    if (!deviceId || !newUserId.trim() || !newEmployee) {
      toast.error("Pick a device, a device user id and an employee.");
      return;
    }
    setBusy(true);
    startTransition(async () => {
      const res = await createDeviceMapping({
        deviceId,
        deviceUserId: newUserId.trim(),
        employeeId: newEmployee,
      });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Mapping saved.");
      setNewUserId("");
      router.refresh();
    });
  };

  const remove = (m: DeviceMappingT) => {
    startTransition(async () => {
      const res = await deleteDeviceMapping({ mappingId: m.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Mapping removed.");
      router.refresh();
    });
  };

  const importCsv = () => {
    const deviceId = csvDevice || scope || devices[0]?.id;
    if (!deviceId) {
      toast.error("Pick a device to import onto.");
      return;
    }
    if (!csvText.trim()) {
      toast.error("Paste the CSV first.");
      return;
    }
    setBusy(true);
    startTransition(async () => {
      const res = await importDeviceMappings({ deviceId, csv: csvText });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Imported ${res.data.created} mapping(s) — ${res.data.duplicates} already mapped.`);
      setCsvText("");
      setCsvOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="biometric-mappings-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Link2 size={20} /> Device user mappings
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {rows.length} mapping{rows.length === 1 ? "" : "s"} — reconciliation resolves punches through this table;
            unmapped device users land in the exception queue.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className={cn(inputCls, "w-52")}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label="Filter by device"
          >
            <option value="">All devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <button className="f-btn f-btn-secondary" type="button" onClick={() => setCsvOpen((v) => !v)} data-testid="import-mappings-btn">
            <Upload size={15} /> Import CSV
          </button>
        </div>
      </div>

      {csvOpen && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="mappings-import">
          <h2 className="text-sm font-semibold">Bulk import from CSV</h2>
          <p className="text-xs text-muted-foreground">
            Header <code className="rounded bg-muted px-1">deviceUserId,employeeEmail</code> (or{" "}
            <code className="rounded bg-muted px-1">employeeId</code>). Unknown employees reject the whole import —
            fix and re-upload (already-mapped rows are skipped, never doubled).
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Import onto device</span>
              <select className={inputCls} value={csvDevice} onChange={(e) => setCsvDevice(e.target.value)}>
                <option value="">Pick a device…</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button
                className="f-btn f-btn-ghost"
                type="button"
                onClick={() => setCsvText(MAPPINGS_CSV_TEMPLATE)}
              >
                Insert template
              </button>
            </div>
          </div>
          <textarea
            className="h-32 w-full rounded-md border border-input bg-transparent p-2.5 font-mono text-xs"
            placeholder={MAPPINGS_CSV_TEMPLATE}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button className="f-btn f-btn-primary" type="button" disabled={busy || pending} onClick={importCsv}>
              {busy || pending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              Import mappings
            </button>
            <button className="f-btn f-btn-ghost" type="button" onClick={() => setCsvOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="mapping-add">
        <h2 className="text-sm font-semibold">Add a mapping</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Device</span>
            <select
              className={inputCls}
              value={scope || devices[0]?.id || ""}
              disabled={scope !== ""}
              onChange={(e) => setScope(e.target.value)}
            >
              {devices.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Device user id</span>
            <input
              className={inputCls}
              placeholder="e.g. 1001"
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Employee</span>
            <select className={inputCls} value={newEmployee} onChange={(e) => setNewEmployee(e.target.value)}>
              <option value="">Pick an employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <button className="f-btn f-btn-primary" type="button" disabled={busy || pending} onClick={add}>
            {busy || pending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add mapping
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Device</th>
              <th className="px-4 py-2.5 font-medium">Device user id</th>
              <th className="px-4 py-2.5 font-medium">Employee</th>
              <th className="px-4 py-2.5 font-medium">Since</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No mappings yet — add one above or import from CSV.
                </td>
              </tr>
            )}
            {rows.map((m) => (
              <tr key={m.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5">{m.deviceName || m.deviceId}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{m.deviceUserId}</td>
                <td className="px-4 py-2.5">{m.employeeName}</td>
                <td className="px-4 py-2.5 text-xs">{m.createdAt}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                    title="Remove mapping"
                    type="button"
                    onClick={() => remove(m)}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
