import { notFound } from "next/navigation";
import { getRunFilingPanel, getPayrollFilingSettings } from "@/server-actions/payday-filing";
import { PaydayFilingPanel } from "@/components/admin/payday/payday-filing-panel";

// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the per-run filing panel: payDate + deadline
// countdown, the EI lifecycle (generate → download → filed → accepted/
// rejected), the 8-check reconciliation, and the EIA2 amendment flow.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export default async function RunFilingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [panelRes, settingsRes] = await Promise.all([
    getRunFilingPanel({ runId: id }),
    getPayrollFilingSettings(),
  ]);
  if (!panelRes.ok) notFound();
  return (
    <PaydayFilingPanel
      panel={panelRes.data}
      settings={settingsRes.ok ? settingsRes.data : null}
    />
  );
}
