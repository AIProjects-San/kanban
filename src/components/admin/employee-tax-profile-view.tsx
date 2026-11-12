"use client";

// ---------------------------------------------------------------------------
// Task 3.4 (revised) — the employee tax profile editor (super admin).
//
//   Section A — Tax code (dropdown M/ME/SB/S/SH/ST/SA/STC/ND + special
//               codes, student-loan checkbox, IRD number, effective from)
//               with the full STC certificate group.
//   Section B — KiwiSaver (status, employee rate 3% temporary / 3.5% default
//               / 4 / 6 / 8 / 10, employer rate, ESCT override).
//   Section C — Employment / casual status (type, holiday-pay-in-wages,
//               start / end dates).
//
// The auto-enrolment preview recomputes LIVE through the same pure engine
// the payroll run uses (buildTaxProfilePreview → resolveKiwiSaverStatus +
// autoEnrolDueDate), e.g. "Temporary — 28-day rule: auto-enrol on
// 2027-03-29".
//
// Guardrails:
//   • STC without a certificate rate blocks the save (exact spec message).
//   • Casual without holiday-pay-in-wages warns (save continues).
//   • TEMPORARY → PERMANENT past day 28: the server action writes the
//     REQUIRED auto-enrolment audit entry; the form shows the note.
// ---------------------------------------------------------------------------

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, CheckCircle2, Save, ShieldCheck } from "lucide-react";
import { saveEmployeeTaxProfile } from "@/server-actions/tax-admin";
import { buildTaxProfilePreview, isValidIrdNumber } from "@/lib/tax-profile-preview";
import type { EmployeeTaxProfileT } from "@/lib/types";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const TAX_CODES = [
  { value: "M", label: "M — main job" },
  { value: "ME", label: "ME — main job, no student loan (IETC applies)" },
  { value: "SB", label: "SB — secondary, bottom band" },
  { value: "S", label: "S — secondary" },
  { value: "SH", label: "SH — secondary, high" },
  { value: "ST", label: "ST — secondary, top" },
  { value: "SA", label: "SA — secondary, all" },
  { value: "ND", label: "ND — no declaration (45%)" },
  { value: "STC", label: "STC — tailored tax code (IR23 certificate)" },
  { value: "CAE", label: "CAE — casual agricultural (special)" },
  { value: "NSW", label: "NSW — recognised seasonal worker" },
  { value: "EDW", label: "EDW — election day worker" },
];

const KS_STATUSES = [
  { value: "ACTIVE", label: "ENROLLED — in the scheme (auto-enrol posture)" },
  { value: "NOT_ENROLLED", label: "NOT ENROLLED — recorded as not in the scheme" },
  { value: "OPTED_OUT", label: "OPT OUT — opted out (nothing deducted)" },
  { value: "ON_HOLIDAY", label: "SAVINGS SUSPENSION — employee 0%, employer continues" },
  { value: "NOT_ELIGIBLE", label: "NOT ELIGIBLE — under 18 / 65+ (opt-in only)" },
];

const EMPLOYMENT_TYPES = [
  { value: "PERMANENT", label: "Permanent" },
  { value: "CASUAL", label: "Casual (irregular / intermittent)" },
  { value: "TEMPORARY", label: "Temporary (28-day auto-enrolment rule)" },
  { value: "CASUAL_AGRICULTURAL", label: "Casual agricultural (3-month rule)" },
];

const STATUS_BADGES: Record<string, string> = {
  ENROLLED: "bg-emerald-500/10 text-emerald-600",
  NOT_ENROLLED: "bg-muted text-muted-foreground",
  OPT_OUT: "bg-amber-500/10 text-amber-600",
  ON_HOLIDAY: "bg-blue-500/10 text-blue-600",
  NOT_ELIGIBLE: "bg-rose-500/10 text-rose-600",
};

export function EmployeeTaxProfileView({
  profile,
  today,
}: {
  profile: EmployeeTaxProfileT;
  today: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(profile);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof EmployeeTaxProfileT>(key: K, value: EmployeeTaxProfileT[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // The live preview — the same pure engine call the payroll run uses.
  const preview = useMemo(
    () => buildTaxProfilePreview(draft, new Date(`${today}T00:00:00.000Z`)),
    [draft, today],
  );

  // Guardrail 1 — STC needs the certificate rate.
  const stcBlocked = draft.taxCodeBase === "STC" && draft.stcCertificateRate == null;

  // IRD mod-11 (live).
  const irdInvalid = draft.irdNumber.trim().length > 0 && !isValidIrdNumber(draft.irdNumber);

  // Guardrail 2 — casual holiday-pay warning.
  const casualWarning =
    draft.employmentType === "CASUAL" && !draft.casualHolidayPayInWages;

  // Guardrail 3 — TEMPORARY → PERMANENT after 28 days: the audit entry is
  // written server-side; show the note when the transition is happening.
  const temporaryToPermanent =
    profile.employmentType === "TEMPORARY" &&
    draft.employmentType === "PERMANENT" &&
    draft.employmentStartDate != null &&
    Math.round((Date.now() - new Date(`${draft.employmentStartDate}T00:00:00.000Z`).getTime()) / 86_400_000) >= 28;

  const canSave = !stcBlocked && !irdInvalid && !pending;

  function save() {
    startTransition(async () => {
      const res = await saveEmployeeTaxProfile({
        userId: draft.userId,
        irdNumber: draft.irdNumber,
        taxCodeBase: draft.taxCodeBase,
        studentLoan: draft.studentLoan,
        taxCodeEffectiveFrom: draft.taxCodeEffectiveFrom || null,
        stcCertificateRate: draft.stcCertificateRate,
        stcAccTreatment: draft.stcAccTreatment,
        stcStudentLoanRate: draft.stcStudentLoanRate,
        stcCertificateExpiry: draft.stcCertificateExpiry || null,
        kiwiSaverStatus: draft.kiwiSaverStatus,
        kiwiSaverEmployeeRate: draft.kiwiSaverEmployeeRate,
        kiwiSaverEmployerRate: draft.kiwiSaverEmployerRate,
        esctRateOverride: draft.esctRateOverride,
        employmentType: draft.employmentType,
        casualHolidayPayInWages: draft.casualHolidayPayInWages,
        employmentStartDate: draft.employmentStartDate || null,
        employmentEndDate: draft.employmentEndDate || null,
        notes: draft.notes,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Tax profile saved for ${draft.userName}`);
      for (const w of res.data.warnings) toast.warning(w);
      router.refresh();
    });
  }

  const employeeRates = draft.allowedEmployeeRates.length > 0 ? draft.allowedEmployeeRates : [3, 3.5, 4, 6, 8, 10];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{draft.userName}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {draft.userEmail}
            {!draft.exists && (
              <span className="ml-2 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
                no tax profile on file yet — this save creates it
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="ml-auto inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" /> Save tax profile
        </button>
      </div>

      {/* Auto-enrolment preview (live) */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <CalendarClock className="h-5 w-5 text-violet-500" />
          <h2 className="text-sm font-semibold">Auto-enrolment preview (KiwiSaver)</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              STATUS_BADGES[preview.resolvedStatus] ?? "bg-muted text-muted-foreground"
            }`}
          >
            {preview.resolvedStatus.replace(/_/g, " ")}
          </span>
          {preview.autoEnrolTriggered && (
            <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600">
              auto-enrolment fires this period
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{preview.reason}</p>
        {preview.dueDate && (
          <p className="mt-1 text-sm">
            Computed auto-enrol date:{" "}
            <span className="font-semibold tabular-nums">{preview.dueDate}</span>
          </p>
        )}
      </section>

      {/* Section A — Tax code */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">Section A — Tax code</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium">Tax code (IR330)</label>
            <select
              className={inputCls}
              value={draft.taxCodeBase}
              onChange={(e) => set("taxCodeBase", e.target.value as EmployeeTaxProfileT["taxCodeBase"])}
            >
              {TAX_CODES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium">IRD number</label>
            <input
              className={`${inputCls} tabular-nums`}
              value={draft.irdNumber}
              placeholder="e.g. 49091869"
              onChange={(e) => set("irdNumber", e.target.value)}
            />
            {irdInvalid && (
              <p className="mt-1 text-xs text-destructive">
                Fails the mod-11 check digit — recheck the digits.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium">Tax code effective from</label>
            <input
              type="date"
              className={inputCls}
              value={draft.taxCodeEffectiveFrom}
              onChange={(e) => set("taxCodeEffectiveFrom", e.target.value)}
            />
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={draft.studentLoan}
              onChange={(e) => set("studentLoan", e.target.checked)}
            />
            Student loan — deduct via the{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">SL</code> suffix
          </label>
        </div>

        {/* STC certificate group */}
        {draft.taxCodeBase === "STC" && (
          <div className="mt-5 rounded-lg border border-violet-500/30 bg-violet-500/5 p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-violet-600">
              IR23 tailored tax code certificate
            </h3>
            <div className="mt-3 grid gap-4 md:grid-cols-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium">Tailored rate % (required)</label>
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  max={100}
                  className={inputCls}
                  value={draft.stcCertificateRate ?? ""}
                  onChange={(e) =>
                    set("stcCertificateRate", e.target.value === "" ? null : Number(e.target.value))
                  }
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium">ACC treatment</label>
                <select
                  className={inputCls}
                  value={draft.stcAccTreatment}
                  onChange={(e) => set("stcAccTreatment", e.target.value as "INC" | "PLUS")}
                >
                  <option value="INC">INC — rate includes the levy</option>
                  <option value="PLUS">PLUS — levy added separately</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium">Special SL rate % (optional)</label>
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  max={12}
                  className={inputCls}
                  value={draft.stcStudentLoanRate ?? ""}
                  onChange={(e) =>
                    set("stcStudentLoanRate", e.target.value === "" ? null : Number(e.target.value))
                  }
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium">Certificate expiry</label>
                <input
                  type="date"
                  className={inputCls}
                  value={draft.stcCertificateExpiry}
                  onChange={(e) => set("stcCertificateExpiry", e.target.value)}
                />
              </div>
            </div>
            {stcBlocked && (
              <p className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                STC requires a tailored rate from the IR23 certificate — no default exists.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Section B — KiwiSaver */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">Section B — KiwiSaver</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium">Status</label>
            <select
              className={inputCls}
              value={draft.kiwiSaverStatus}
              onChange={(e) => set("kiwiSaverStatus", e.target.value as EmployeeTaxProfileT["kiwiSaverStatus"])}
            >
              {KS_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium">Employee rate</label>
            <select
              className={inputCls}
              value={draft.kiwiSaverEmployeeRate ?? ""}
              onChange={(e) =>
                set("kiwiSaverEmployeeRate", e.target.value === "" ? null : Number(e.target.value))
              }
            >
              <option value="">
                No election — default {draft.defaultEmployeeRate}% applies
              </option>
              {employeeRates.map((r) => (
                <option key={r} value={r}>
                  {r}%
                  {r === draft.defaultEmployeeRate ? " (default)" : ""}
                  {r === 3 ? " (temporary — pre-existing elections only)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium">Employer rate</label>
            <select
              className={inputCls}
              value={draft.kiwiSaverEmployerRate ?? ""}
              onChange={(e) =>
                set("kiwiSaverEmployerRate", e.target.value === "" ? null : Number(e.target.value))
              }
            >
              <option value="">Default — compulsory {draft.employerRate}%</option>
              {[3, 3.5, 4, 6, 8, 10].map((r) => (
                <option key={r} value={r}>
                  {r}%{r === draft.kiwiSaverEmployeeRate ? " (matches employee)" : ""}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              May match the employee rate.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium">ESCT rate override (optional)</label>
            <input
              type="number"
              step="0.5"
              min={0}
              max={100}
              className={inputCls}
              value={draft.esctRateOverride ?? ""}
              placeholder="tier lookup applies"
              onChange={(e) =>
                set("esctRateOverride", e.target.value === "" ? null : Number(e.target.value))
              }
            />
          </div>
        </div>
      </section>

      {/* Section C — Employment / casual status */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">Section C — Employment / casual status</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium">Employment type</label>
            <select
              className={inputCls}
              value={draft.employmentType}
              onChange={(e) => set("employmentType", e.target.value as EmployeeTaxProfileT["employmentType"])}
            >
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium">Employment start date</label>
            <input
              type="date"
              className={inputCls}
              value={draft.employmentStartDate}
              onChange={(e) => set("employmentStartDate", e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium">Employment end date (if known)</label>
            <input
              type="date"
              className={inputCls}
              value={draft.employmentEndDate}
              onChange={(e) => set("employmentEndDate", e.target.value)}
            />
          </div>
          {draft.employmentType === "CASUAL" && (
            <label className="inline-flex cursor-pointer items-start gap-2 self-end rounded-md border border-border px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={draft.casualHolidayPayInWages}
                onChange={(e) => set("casualHolidayPayInWages", e.target.checked)}
              />
              Holiday pay is paid <strong>with wages</strong> (8% on top — the
              statutory casual definition)
            </label>
          )}
        </div>

        {casualWarning && (
          <p className="mt-4 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Casual exemption requires holiday pay to be paid with wages. If
            holiday pay is paid on leave, consider TEMPORARY or PERMANENT.
          </p>
        )}

        {temporaryToPermanent && (
          <p className="mt-4 flex items-start gap-2 rounded-md bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-400">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            Converting a temporary employment to permanent after the 28-day
            rule: saving records the required auto-enrolment audit entry
            (KiwiSaver applies from day 29 — {preview.dueDate ?? "see preview"}).
          </p>
        )}
      </section>

      {/* Notes */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <label className="mb-1.5 block text-xs font-medium">Notes</label>
        <textarea
          className="min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={draft.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="IR23 certificate details, declaration dates, exemptions…"
        />
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" /> Save tax profile
        </button>
        {canSave && !pending && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> Ready to save
          </span>
        )}
      </div>
    </div>
  );
}
