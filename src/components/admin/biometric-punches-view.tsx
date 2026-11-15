"use client";

// ---------------------------------------------------------------------------
// G5 — the raw punch log (/admin/attendance/punches): status/device/date
// filters (server-side, via the URL), the CSV fallback import, and the
// reconcile trigger with its report.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, ClipboardList, Loader2, RefreshCw, Upload } from "lucide-react";
import { importPunchesCsv, reconcileDevicePunches } from "@/server-actions/biometric";
import type { PunchLogItemT, ReconciliationReportT } from "@/lib/types";
import { PUNCH_CSV_TEMPLATE } from "@/lib/biometric/punch-csv";
import { PUNCH_STATUS_LABELS, PUNCH_RECONCILIATION_STATUSES } from "@/lib/biometric/punches";
import { cn } from "@/lib/shared/utils";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_CLS: Record<string, string> = {
  PENDING: "bg-amber-500/10 text-amber-700",
  MATCHED: "bg-sky-500/10 text-sky-700",
  ATTENDED: "bg-emerald-500/10 text-emerald-700",
  UNMATCHED: "bg-red-500/10 text-red-700",
  DUPLICATE: "bg-violet-500/10 text-violet-700",
  IGNORED: "bg-muted text-muted-foreground",
};

function defaultFrom(): string {
  const d = new Date(Date.now() - 6 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function BiometricPunchesView({
  punches,
  page,
  pageCount,
  devices,
  activeFilters,
}: {
  punches: PunchLogItemT[];
  page: number;
  pageCount: number;
  devices: Array<{ id: string; name: string }>;
  activeFilters: { deviceId: string; status: string; from: string; to: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState(activeFilters.deviceId);
  const [status, setStatus] = useState(activeFilters.status);
  const [from, setFrom] = useState(activeFilters.from);
  const [to, setTo] = useState(activeFilters.to);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [rDevice, setRDevice] = useState("");
  const [rFrom, setRFrom] = useState(defaultFrom());
  const [rTo, setRTo] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<ReconciliationReportT | null>(null);

  const apply = (extra?: Record<string, string | number>) => {
    const params = new URLSearchParams();
    if (deviceId) params.set("deviceId", deviceId);
    if (status) params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    for (const [k, v] of Object.entries(extra ?? {})) params.set(k, String(v));
    router.push(`/admin/attendance/punches?${params.toString()}`);
  };

  const importCsv = () => {
    const target = deviceId || rDevice || devices[0]?.id;
    if (!target) {
      toast.error("Pick a device filter first (the CSV imports onto it).");
      return;
    }
    if (!csvText.trim()) {
      toast.error("Paste the punch CSV first.");
      return;
    }
    setBusy(true);
    startTransition(async () => {
      const res = await importPunchesCsv({ deviceId: target, csv: csvText });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Imported ${res.data.inserted} punch(es) — ${res.data.duplicates} duplicate skip(s).`);
      setCsvText("");
      setCsvOpen(false);
      router.refresh();
    });
  };

  const runReconcile = () => {
    const target = rDevice || deviceId || devices[0]?.id;
    if (!target) {
      toast.error("Pick a device to reconcile.");
      return;
    }
    if (!rFrom || !rTo) {
      toast.error("Pick the window's from and to days.");
      return;
    }
    setBusy(true);
    startTransition(async () => {
      const res = await reconcileDevicePunches({ deviceId: target, from: rFrom, to: rTo });
      setBusy(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setReport(res.data);
      toast.success("Reconcile pass complete.");
      router.refresh();
    });
  };

  return (
    <div className="space-y-5" data-testid="biometric-punches-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList size={20} /> Punch log
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Raw punches as the devices reported them — page {page} of {pageCount}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="f-btn f-btn-secondary" type="button" onClick={() => setCsvOpen((v) => !v)} data-testid="import-punches-btn">
            <Upload size={15} /> Import CSV
          </button>
          <button className="f-btn f-btn-primary" type="button" onClick={() => setReconcileOpen((v) => !v)} data-testid="reconcile-btn">
            <RefreshCw size={15} /> Reconcile
          </button>
        </div>
      </div>

      {csvOpen && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="punches-import">
          <h2 className="text-sm font-semibold">Import punches from CSV</h2>
          <p className="text-xs text-muted-foreground">
            The vendor fallback — punches land in the same table and reconcile identically. Header{" "}
            <code className="rounded bg-muted px-1">deviceUserId,punchedAt,direction,verifyMethod</code>; naive
            timestamps read as NZ local time.
            {deviceId ? ` Importing onto the filtered device.` : " Set the device filter above to choose the target device."}
          </p>
          <textarea
            className="h-32 w-full rounded-md border border-input bg-transparent p-2.5 font-mono text-xs"
            placeholder={PUNCH_CSV_TEMPLATE}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button className="f-btn f-btn-primary" type="button" disabled={busy || pending} onClick={importCsv}>
              {busy || pending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              Import punches
            </button>
            <button className="f-btn f-btn-ghost" type="button" onClick={() => setCsvText(PUNCH_CSV_TEMPLATE)}>
              Insert template
            </button>
          </div>
        </div>
      )}

      {reconcileOpen && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3" data-testid="reconcile-panel">
          <h2 className="text-sm font-semibold">Reconcile a device window</h2>
          <p className="text-xs text-muted-foreground">
            Maps device users onto employees, derives the day attendance records, and flips punch statuses. Idempotent
            — running the same window twice changes nothing the second time.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Device</span>
              <select className={inputCls} value={rDevice || deviceId} onChange={(e) => setRDevice(e.target.value)}>
                <option value="">Pick a device…</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">From (NZ day)</span>
              <input className={inputCls} type="date" value={rFrom} onChange={(e) => setRFrom(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">To (NZ day)</span>
              <input className={inputCls} type="date" value={rTo} onChange={(e) => setRTo(e.target.value)} />
            </label>
          </div>
          <div>
            <button className="f-btn f-btn-primary" type="button" disabled={busy || pending} onClick={runReconcile}>
              {busy || pending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Run reconcile
            </button>
          </div>
          {report && (
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs" data-testid="reconcile-report">
              <p className="font-semibold">{report.deviceName} · {report.windowStart.slice(0, 10)} → {report.windowEnd.slice(0, 10)}</p>
              <p className="mt-1 text-muted-foreground">
                {report.processed} processed · {report.matched} matched · {report.attended} attended ·{" "}
                {report.unmatched} unmatched · {report.duplicates} duplicate(s)
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {report.recordsCreated} record(s) created · {report.recordsUpdated} updated ·{" "}
                {report.recordsSkippedExisting} manual mark(s) kept · {report.daysSkippedNonWorking} non-working day(s) skipped
              </p>
              <p className="mt-0.5 text-muted-foreground">
                Exceptions: {report.missingOutDays} missing-OUT day(s) · {report.missingInDays} missing-IN day(s)
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card shadow-sm p-4" data-testid="punch-filters">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Device</span>
          <select className={cn(inputCls, "w-44")} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">All devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Status</span>
          <select className={cn(inputCls, "w-36")} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {PUNCH_RECONCILIATION_STATUSES.map((s) => (
              <option key={s} value={s}>{PUNCH_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">From (NZ day)</span>
          <input className={cn(inputCls, "w-40")} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">To (NZ day)</span>
          <input className={cn(inputCls, "w-40")} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="flex items-center gap-2">
          <button className="f-btn f-btn-secondary" type="button" onClick={() => apply({ page: 1 })}>
            Apply
          </button>
          {(deviceId || status || from || to) && (
            <button
              className="f-btn f-btn-ghost"
              type="button"
              onClick={() => {
                setDeviceId("");
                setStatus("");
                setFrom("");
                setTo("");
                router.push("/admin/attendance/punches");
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">When (NZ)</th>
              <th className="px-4 py-2.5 font-medium">Device</th>
              <th className="px-4 py-2.5 font-medium">Device user</th>
              <th className="px-4 py-2.5 font-medium">Employee</th>
              <th className="px-4 py-2.5 font-medium">Dir.</th>
              <th className="px-4 py-2.5 font-medium">Verify</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Record</th>
            </tr>
          </thead>
          <tbody>
            {punches.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  No punches match — devices push to /api/biometric/punch, or import from CSV.
                </td>
              </tr>
            )}
            {punches.map((p) => (
              <tr key={p.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <p className="font-medium tabular-nums">{p.time}</p>
                  <p className="text-xs text-muted-foreground">{p.day}</p>
                </td>
                <td className="px-4 py-2.5 text-xs">{p.deviceName || p.deviceId}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{p.deviceUserId}</td>
                <td className="px-4 py-2.5">{p.employeeName ?? <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-2.5 text-xs font-medium">{p.direction}</td>
                <td className="px-4 py-2.5 text-xs">{p.verifyMethod ?? "—"}</td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      STATUS_CLS[p.reconciliationStatus] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {PUNCH_STATUS_LABELS[p.reconciliationStatus as keyof typeof PUNCH_STATUS_LABELS] ?? p.reconciliationStatus}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {p.attendanceRecordId ? (
                    <span className="text-emerald-600">linked</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between">
          <button
            className="f-btn f-btn-secondary"
            type="button"
            disabled={page <= 1}
            onClick={() => apply({ page: page - 1 })}
          >
            <ChevronLeft size={14} /> Previous
          </button>
          <span className="text-xs text-muted-foreground">Page {page} / {pageCount}</span>
          <button
            className="f-btn f-btn-secondary"
            type="button"
            disabled={page >= pageCount}
            onClick={() => apply({ page: page + 1 })}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
