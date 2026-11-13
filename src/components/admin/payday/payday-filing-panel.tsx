"use client";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the per-run EI filing panel.
//
// The whole IRD contract is visible here: Fernly BUILDS the file; the
// user downloads it and uploads it to myIR themselves ("File or upload a
// return" or express file transfer) within 2 working days of the payday.
// The panel tracks that lifecycle (GENERATED → FILED → ACCEPTED/REJECTED)
// and refuses to regenerate anything already filed.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, Download, FilePlus2,
  FileWarning, Loader2, RefreshCw, ShieldCheck, Upload, XCircle, History, FilePenLine,
} from "lucide-react";
import {
  downloadPaydayFilingFile,
  generateAmendmentFilingAction,
  generatePaydayFilingAction,
  listFilingLines,
  markPaydayFilingAccepted,
  markPaydayFilingFiled,
  markPaydayFilingRejected,
  downloadAmendmentFile,
} from "@/server-actions/payday-filing";
import type { PaydayFilingSummaryT, PayrollFilingSettingsT, RunFilingPanelT } from "@/lib/ird/filing-types";
import { formatMoneyCents, downloadBlob } from "@/lib/format";
import { FILING_STATUS_BADGE } from "@/lib/config";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-[0.625rem] font-semibold px-1.5 py-0.5 rounded ${FILING_STATUS_BADGE[status] ?? FILING_STATUS_BADGE.DRAFT}`}>
      {status}
    </span>
  );
}

export function PaydayFilingPanel({
  panel,
  settings,
}: {
  panel: RunFilingPanelT;
  settings: PayrollFilingSettingsT | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [irdReference, setIrdReference] = useState("");
  const [errorReport, setErrorReport] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [showAmend, setShowAmend] = useState(false);

  const filing = panel.filing;
  const refresh = useCallback(() => router.refresh(), [router]);

  const generate = async () => {
    setBusy(true);
    const res = await generatePaydayFilingAction({ runId: panel.run.id });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error, { duration: 12_000 });
      return;
    }
    toast.success(`Employment Information file generated — ${res.data.reconciliation.checks.length} reconciliation checks pass. Download it and upload to myIR before the due date.`);
    refresh();
  };

  const download = async () => {
    if (!filing) return;
    setBusy(true);
    const res = await downloadPaydayFilingFile({ filingId: filing.id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    downloadBlob(res.data.csv, res.data.filename);
    toast.success(`${res.data.filename} downloaded — upload it to myIR (File or upload a return / express file transfer).`);
  };

  const markFiled = async () => {
    if (!filing) return;
    setBusy(true);
    const res = await markPaydayFilingFiled({ filingId: filing.id, irdReference: irdReference || undefined });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Marked as filed — recorded who uploaded and when.");
    setIrdReference("");
    refresh();
  };

  const markAccepted = async () => {
    if (!filing) return;
    setBusy(true);
    const res = await markPaydayFilingAccepted({ filingId: filing.id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Marked accepted by myIR.");
    refresh();
  };

  const markRejected = async () => {
    if (!filing) return;
    setBusy(true);
    const res = await markPaydayFilingRejected({ filingId: filing.id, errorReport });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success("Rejection recorded. Fix the cause, then regenerate and upload again.");
    setErrorReport("");
    setShowReject(false);
    refresh();
  };

  const downloadAmendment = async (id: string) => {
    setBusy(true);
    const res = await downloadAmendmentFile({ id });
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    downloadBlob(res.data.csv, res.data.filename);
    toast.success(`${res.data.filename} downloaded.`);
  };

  const daysLeft = filing?.workingDaysRemaining ?? null;

  return (
    <div className="space-y-5" data-testid="payday-filing-panel">
      {/* Run header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Payroll
          </Link>
          <h1 className="mt-1 text-xl font-bold tracking-tight">
            Filing · {panel.run.period}
            <span className="ml-2 align-middle"><StatusBadge status={panel.run.status} /></span>
            {filing && <span className="ml-1.5 align-middle"><StatusBadge status={filing.status} /></span>}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {panel.run.frequency.toLowerCase()} run · period {day(panel.run.startDate)} → {day(panel.run.endDate)} · payday {day(panel.run.payDate)}
          </p>
        </div>
      </div>

      {/* Deadline card */}
      <div className={`rounded-lg border p-4 ${daysLeft != null && daysLeft <= 0 && filing && filing.status !== "ACCEPTED" && filing.status !== "AMENDED" ? "border-red-400 bg-red-500/5" : "border-border bg-card"}`}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <div className="text-sm">
              <span className="text-muted-foreground">Payday</span>{" "}
              <span className="font-medium">{day(panel.run.payDate)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <div className="text-sm">
              <span className="text-muted-foreground">IRD due (payday + 2 working days)</span>{" "}
              <span className="font-medium">{filing ? day(filing.dueDate) : "—"}</span>
            </div>
          </div>
          {daysLeft != null && (
            <div className={`text-sm font-semibold ${daysLeft <= 0 ? "text-red-600" : daysLeft <= 1 ? "text-amber-600" : "text-emerald-600"}`}>
              {daysLeft > 0
                ? `${daysLeft} working day${daysLeft === 1 ? "" : "s"} remaining`
                : daysLeft === 0
                  ? "due today"
                  : `${Math.abs(daysLeft)} working day${Math.abs(daysLeft) === 1 ? "" : "s"} OVERDUE`}
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Fernly does not upload for you: download the file and submit it in myIR within 2 working days of the payday
          (Tax Administration Act 1994 s 23D(4)). A late Employment Information return risks a late-filing penalty.
        </p>
      </div>

      {/* Settings warning */}
      {!settings && (
        <div className="rounded-lg border border-amber-400 bg-amber-500/5 p-4 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm">
            The employer filing profile is not configured.{" "}
            <Link href="/admin/payroll/settings" className="font-medium underline underline-offset-2">Set the employer IRD number and payroll contact</Link>{" "}
            before generating any IRD file.
          </div>
        </div>
      )}

      {/* Cadence warning */}
      {!panel.filingCadenceSupported && (
        <div className="rounded-lg border border-amber-400 bg-amber-500/5 p-4 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm">
            The {panel.run.frequency.toLowerCase()} cadence has no confirmed IRD pay cycle code — Employment Information
            cannot be generated for this run (supported: weekly, fortnightly, monthly, twice-monthly, daily).
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        <div className="flex items-center gap-2 px-4 py-2.5">
          <FilePlus2 size={14} className="text-emerald-600" />
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Employment Information (EI)
          </div>
        </div>
        <div className="px-4 py-3 flex flex-wrap items-center gap-2">
          {panel.run.status === "LOCKED" && (
            <button
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={busy || !settings || !panel.filingCadenceSupported || (filing != null && ["FILED", "ACCEPTED", "AMENDED"].includes(filing.status))}
              onClick={() => void generate()}
              data-testid="generate-ei-btn"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <FilePlus2 size={14} />}
              {filing ? "Regenerate EI file" : "Generate EI file"}
            </button>
          )}
          {filing && filing.hasFile && (
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              disabled={busy}
              onClick={() => void download()}
              data-testid="download-ei-btn"
            >
              <Download size={14} /> Download EI file
            </button>
          )}
          {filing && filing.status === "GENERATED" && (
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              disabled={busy}
              onClick={() => void markFiled()}
              data-testid="mark-filed-btn"
            >
              <Upload size={14} /> Mark as uploaded to myIR
            </button>
          )}
          {filing && filing.status === "GENERATED" && (
            <input
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
              placeholder="myIR reference (optional)"
              value={irdReference}
              onChange={(e) => setIrdReference(e.target.value)}
            />
          )}
          {filing && filing.status === "FILED" && (
            <>
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-500/20"
                disabled={busy}
                onClick={() => void markAccepted()}
                data-testid="mark-accepted-btn"
              >
                <ShieldCheck size={14} /> Mark accepted
              </button>
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-500/20"
                disabled={busy}
                onClick={() => setShowReject((s) => !s)}
                data-testid="mark-rejected-btn"
              >
                <XCircle size={14} /> Mark rejected
              </button>
            </>
          )}
          {filing && ["FILED", "ACCEPTED", "AMENDED", "REJECTED"].includes(filing.status) && (
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              onClick={() => setShowAmend((s) => !s)}
              data-testid="amend-toggle-btn"
            >
              <FilePenLine size={14} /> Amend (EIA2)
            </button>
          )}
          {filing == null && panel.run.status === "OPEN" && (
            <span className="text-sm text-muted-foreground">Lock the run (mark it paid) before generating its EI file.</span>
          )}
        </div>

        {/* Rejection capture */}
        {showReject && filing && filing.status === "FILED" && (
          <div className="px-4 py-3 bg-red-500/5">
            <label className="block text-xs font-medium mb-1.5" htmlFor="ird-error-report">
              Paste the myIR error report (myIR → View and export error report)
            </label>
            <textarea
              id="ird-error-report"
              className="w-full min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
              value={errorReport}
              onChange={(e) => setErrorReport(e.target.value)}
              placeholder="Line 2, field 15: …"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                disabled={busy || errorReport.trim() === ""}
                onClick={() => void markRejected()}
              >
                <FileWarning size={14} /> Record rejection
              </button>
              <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => setShowReject(false)} type="button">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Totals + history */}
        {filing && (
          <div className="px-4 py-3 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
            <div className="flex justify-between"><span className="text-muted-foreground">Employee lines</span><span className="font-medium">{filing.totalEmployeeLines}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Gross (EI field 11)</span><span className="font-medium">{formatMoneyCents(filing.totalGrossCents)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">PAYE income tax (field 15)</span><span className="font-medium">{formatMoneyCents(filing.totalPayeCents)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Student loan (field 19)</span><span className="font-medium">{formatMoneyCents(filing.totalStudentLoanCents)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">KiwiSaver employee (field 22)</span><span className="font-medium">{formatMoneyCents(filing.totalKiwisaverEmployeeCents)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Employer KiwiSaver net (field 23)</span><span className="font-medium">{formatMoneyCents(filing.totalKiwisaverEmployerNetCents)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">ESCT (field 24)</span><span className="font-medium">{formatMoneyCents(filing.totalEsctCents)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Pay cycle</span><span className="font-medium font-mono">{filing.payCycle}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Generated</span><span className="font-medium">{day(filing.generatedAt)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Uploaded to myIR</span><span className="font-medium">{day(filing.filedAt)}{filing.irdReference ? ` · ref ${filing.irdReference}` : ""}</span></div>
            {filing.acceptedAt && <div className="flex justify-between"><span className="text-muted-foreground">Accepted</span><span className="font-medium">{day(filing.acceptedAt)}</span></div>}
            {filing.rejectedAt && <div className="flex justify-between"><span className="text-muted-foreground">Rejected</span><span className="font-medium text-red-600">{day(filing.rejectedAt)}</span></div>}
          </div>
        )}

        {/* Reconciliation */}
        {panel.reconciliation && (
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 size={14} className={panel.reconciliation.allPass ? "text-emerald-600" : "text-red-600"} />
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                Ledger reconciliation — the filed return vs the books
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 pr-3 font-medium">#</th>
                    <th className="py-1.5 pr-3 font-medium">Check</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Filed</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Source</th>
                    <th className="py-1.5 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.reconciliation.checks.map((c, i) => (
                    <tr key={i} className="border-b border-border/60">
                      <td className="py-1.5 pr-3 text-muted-foreground">{c.index}</td>
                      <td className="py-1.5 pr-3">{c.label}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{c.filingCents.toLocaleString("en-NZ")}c</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{c.sourceCents.toLocaleString("en-NZ")}c</td>
                      <td className="py-1.5">
                        {c.pass ? (
                          <span className="text-emerald-600 font-medium">pass</span>
                        ) : (
                          <span className="text-red-600 font-medium">FAIL</span>
                        )}
                        {c.note && <span className="ml-1 text-muted-foreground">({c.note})</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              ACC earners&apos; levy total (never filed — IRD derives it): {formatMoneyCents(panel.reconciliation.accLevyCents)}.
              Check 2 is informational; checks 1, 3–8 must pass before a file can be generated.
            </p>
          </div>
        )}

        {/* Amendments */}
        {panel.amendments.length > 0 && (
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <History size={14} className="text-orange-500" />
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">EIA2 amendments</div>
            </div>
            <div className="space-y-1.5">
              {panel.amendments.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={a.status} />
                  <span>{a.correctionCount} correction{a.correctionCount === 1 ? "" : "s"}</span>
                  <span className="text-muted-foreground">generated {day(a.generatedAt)}{a.filedAt ? ` · uploaded ${day(a.filedAt)}` : ""}{a.acceptedAt ? ` · accepted ${day(a.acceptedAt)}` : ""}</span>
                  <button
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
                    disabled={busy}
                    onClick={() => void downloadAmendment(a.id)}
                  >
                    <Download size={12} /> EIA2 file
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Amendment form */}
      {showAmend && filing && <AmendmentForm filing={filing} onDone={() => { setShowAmend(false); refresh(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The EIA2 amendment form: pick employees on the filing, enter corrected
// dollars (blank = keep as filed), or delete the line outright.
// ---------------------------------------------------------------------------

function AmendmentForm({ filing, onDone }: { filing: PaydayFilingSummaryT; onDone: () => void }) {
  // The filing's lines are loaded lazily through the panel DTO — the
  // amendments endpoint takes employee ids; the caller gets them from the
  // reconciliation-free listing below via listPaydayFilings? Simplest
  // robust source: the panel page passes only the summary, so the form
  // asks the actions layer for the filing's lines via a tiny fetch.
  const [lines, setLines] = useState<Array<{ employeeId: string; employeeName: string; grossCents: number; payeCents: number }>>([]);
  const [values, setValues] = useState<Record<string, { gross?: string; paye?: string; studentLoan?: string; kiwisaverEmployee?: string; delete?: boolean }>>({});
  const [busy, setBusy] = useState(false);
  // One shot per filing id (a ref, not state: no cascading re-render).
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    if (loadedRef.current === filing.id) return;
    loadedRef.current = filing.id;
    void (async () => {
      const res = await listFilingLines({ filingId: filing.id });
      if (res.ok) setLines(res.data);
    })();
  }, [filing.id]);

  const corrections = useMemo(() => {
    const out: Array<{ employeeId: string; delete?: boolean; gross?: number; paye?: number; studentLoan?: number; kiwisaverEmployee?: number }> = [];
    for (const l of lines) {
      const v = values[l.employeeId];
      if (!v) continue;
      if (v.delete) {
        out.push({ employeeId: l.employeeId, delete: true });
        continue;
      }
      const has = ["gross", "paye", "studentLoan", "kiwisaverEmployee"].some((k) => (v as Record<string, string | undefined | boolean>)[k] !== undefined && (v as Record<string, string | undefined | boolean>)[k] !== "");
      if (!has) continue;
      out.push({
        employeeId: l.employeeId,
        ...(v.gross !== undefined && v.gross !== "" ? { gross: Number(v.gross) } : {}),
        ...(v.paye !== undefined && v.paye !== "" ? { paye: Number(v.paye) } : {}),
        ...(v.studentLoan !== undefined && v.studentLoan !== "" ? { studentLoan: Number(v.studentLoan) } : {}),
        ...(v.kiwisaverEmployee !== undefined && v.kiwisaverEmployee !== "" ? { kiwisaverEmployee: Number(v.kiwisaverEmployee) } : {}),
      });
    }
    return out;
  }, [lines, values]);

  const submit = async () => {
    if (corrections.length === 0) {
      toast.error("Enter at least one correction (dollars) or tick delete for one employee.");
      return;
    }
    setBusy(true);
    const res = await generateAmendmentFilingAction({ originalFilingId: filing.id, corrections });
    setBusy(false);
    if (!res.ok) { toast.error(res.error, { duration: 10_000 }); return; }
    toast.success(`EIA2 amendment generated — ${res.data.pairCount} DTI/DAI pair(s). The original filing is now AMENDED.`);
    onDone();
  };

  return (
    <div className="rounded-lg border border-orange-400/50 bg-orange-500/5 p-4 space-y-3" data-testid="amendment-form">
      <div className="flex items-center gap-2">
        <FilePenLine size={15} className="text-orange-600" />
        <h2 className="text-sm font-semibold">Amend the filed return (EIA2)</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Each corrected employee produces a DTI line (the values as originally filed — frozen from this filing) immediately
        followed by a DAI line (the corrected values). Leave a field blank to keep the filed value; tick delete to remove the line.
      </p>
      {lines.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Loading the filed lines…</div>
      ) : (
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.employeeId} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
              <div className="min-w-40">
                <div className="text-sm font-medium">{l.employeeName}</div>
                <div className="text-xs text-muted-foreground">filed: gross {formatMoneyCents(l.grossCents)} · PAYE {formatMoneyCents(l.payeCents)}</div>
              </div>
              {(["gross", "paye", "studentLoan", "kiwisaverEmployee"] as const).map((f) => (
                <label key={f} className="text-xs">
                  <span className="mr-1 text-muted-foreground">{f === "kiwisaverEmployee" ? "KS ee" : f === "studentLoan" ? "SL" : f}</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
                    placeholder="as filed"
                    value={values[l.employeeId]?.[f] ?? ""}
                    disabled={values[l.employeeId]?.delete}
                    onChange={(e) => setValues((prev) => ({ ...prev, [l.employeeId]: { ...prev[l.employeeId], [f]: e.target.value } }))}
                  />
                </label>
              ))}
              <label className="ml-auto flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={values[l.employeeId]?.delete ?? false}
                  onChange={(e) => setValues((prev) => ({ ...prev, [l.employeeId]: { ...prev[l.employeeId], delete: e.target.checked } }))}
                />
                delete line
              </label>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={busy || corrections.length === 0}
          onClick={() => void submit()}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Generate EIA2 amendment ({corrections.length})
        </button>
        <span className="text-xs text-muted-foreground">The amendment appears above once generated; download it there.</span>
      </div>
    </div>
  );
}
