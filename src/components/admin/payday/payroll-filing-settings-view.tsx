"use client";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the employer filing profile editor. Everything
// here lands verbatim in the HEI2/HED2/EIA2 headers: the employer IRD
// number (the file is rejected outright on a mismatch with the logged-in
// myIR account), the payroll contact, and the package/form-version stamps.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Landmark, Loader2, Save } from "lucide-react";
import { savePayrollFilingSettings } from "@/server-actions/payday-filing";
import type { PayrollFilingSettingsT } from "@/lib/ird/filing-types";

export function PayrollFilingSettingsView({ initial }: { initial: PayrollFilingSettingsT | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    employerIrdNumber: initial?.employerIrdNumber ?? "",
    employerName: initial?.employerName ?? "",
    payeIntermediaryIrd: initial?.payeIntermediaryIrd ?? "",
    payrollContactName: initial?.payrollContactName ?? "",
    payrollContactPhone: initial?.payrollContactPhone ?? "",
    payrollContactEmail: initial?.payrollContactEmail ?? "",
    payrollPackageIdentifier: initial?.payrollPackageIdentifier ?? "Fernly v1.0",
    irFormVersionNumber: "0001",
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await savePayrollFilingSettings(form);
    setBusy(false);
    if (!res.ok) { toast.error(res.error, { duration: 10_000 }); return; }
    toast.success("Filing profile saved — every generated EI/ED file will carry these details.");
    router.refresh();
  };

  return (
    <div className="space-y-4 max-w-2xl" data-testid="filing-settings-view">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Landmark size={20} /> Employer filing profile
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          The details myIR expects on every Employment Information / Employee Details file header.
        </p>
      </div>

      <form onSubmit={save} className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="block text-xs font-medium mb-1.5">Employer IRD number *</span>
            <input required className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="123456789" value={form.employerIrdNumber} onChange={set("employerIrdNumber")} />
            <span className="mt-1 block text-xs text-muted-foreground">9 digits, mod-11 validated — must match the myIR account you upload to.</span>
          </label>
          <label className="block">
            <span className="block text-xs font-medium mb-1.5">Employer name (as registered with IRD)</span>
            <input required className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={form.employerName} onChange={set("employerName")} />
          </label>
          <label className="block">
            <span className="block text-xs font-medium mb-1.5">PAYE intermediary IRD number</span>
            <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="blank if none" value={form.payeIntermediaryIrd} onChange={set("payeIntermediaryIrd")} />
            <span className="mt-1 block text-xs text-muted-foreground">Only if a registered intermediary files for you.</span>
          </label>
          <label className="block">
            <span className="block text-xs font-medium mb-1.5">Payroll contact name * <span className="text-muted-foreground">(≤ 20 chars)</span></span>
            <input required maxLength={20} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={form.payrollContactName} onChange={set("payrollContactName")} />
          </label>
          <label className="block">
            <span className="block text-xs font-medium mb-1.5">Payroll contact work phone * <span className="text-muted-foreground">(≤ 12 chars, digits)</span></span>
            <input required maxLength={12} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="041234567" value={form.payrollContactPhone} onChange={set("payrollContactPhone")} />
          </label>
          <label className="block">
            <span className="block text-xs font-medium mb-1.5">Payroll contact email *</span>
            <input required type="email" maxLength={60} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="payroll@company.co.nz" value={form.payrollContactEmail} onChange={set("payrollContactEmail")} />
          </label>
          <label className="block">
            <span className="block text-xs font-medium mb-1.5">Payroll package identifier * <span className="text-muted-foreground">(≤ 80 chars)</span></span>
            <input required maxLength={80} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={form.payrollPackageIdentifier} onChange={set("payrollPackageIdentifier")} />
            <span className="mt-1 block text-xs text-muted-foreground">e.g. Fernly v1.0 — no commas, no employer details.</span>
          </label>
          <label className="block">
            <span className="block text-xs font-medium mb-1.5">IR form version *</span>
            <input readOnly disabled className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm font-mono" value="0001" />
            <span className="mt-1 block text-xs text-muted-foreground">IRD requires exactly 0001.</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={busy}
            data-testid="save-filing-settings-btn"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save filing profile
          </button>
          <span className="text-xs text-muted-foreground">Validated on save: IRD numbers mod-11, contact length limits, no commas.</span>
        </div>
      </form>
    </div>
  );
}
