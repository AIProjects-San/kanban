// ---------------------------------------------------------------------------
// P18 (PR-B16) — the payslip email builders (pure; a "use server" file may
// only export async functions, so these live here). Subject carries no
// amounts (subjects leak through notification previews); the text body is
// the audit copy the Outbox re-reads, and the HTML mirrors it (the
// retention email's house pattern). The PDF itself stays the download-only
// decision §9.2 — the mailer has no attachment support.
// ---------------------------------------------------------------------------

import { parsePayslipLines } from "@/lib/payroll-math";
import { escapeHtml } from "@/lib/utils";

function nz(n: number): string {
  return `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The deduction total off a slip's stored line snapshots (the canonical
 * parsePayslipLines is defensive: a malformed column reads as [] and the
 * total as 0 — the money lives in gross/net anyway). */
export function deductionTotal(deductions: string): number {
  return Math.round(parsePayslipLines(deductions).reduce((s, l) => s + l.amount, 0) * 100) / 100;
}

/** The subject names the period only — no amounts (privacy: subjects leak
 * through mail-client previews and lock screens). */
export function payslipEmailSubject(period: string): string {
  return `Your ${period} payslip is ready`;
}

export function payslipEmailText(
  slip: {
    slipNo: string;
    gross: number;
    net: number;
    lopDays: number;
    withholdStatus: string;
    deductions: string;
    user: { name: string };
  },
  period: string,
): string {
  return [
    `Hi ${slip.user.name},`,
    "",
    `Your payslip ${slip.slipNo} for ${period} is ready.`,
    "",
    `Gross earnings: ${nz(slip.gross)}`,
    `Total deductions: ${nz(deductionTotal(slip.deductions))}`,
    `Net pay: ${nz(slip.net)}`,
    ...(slip.lopDays > 0 ? [`Loss of pay: ${slip.lopDays} day${slip.lopDays === 1 ? "" : "s"} applied.`] : []),
    ...(slip.withholdStatus === "WITHHELD"
      ? ["Your net is on hold (withheld) pending release — the amount above is what the hold covers."]
      : []),
    "",
    "The printable PDF is in Fernly under Payroll → My payslips.",
    "",
    "— Fernly Payroll",
  ].join("\n");
}

export function payslipEmailHtml(text: string): string {
  const body = text
    .split("\n")
    .map((l) => (l.startsWith("Net pay:") ? `<strong>${escapeHtml(l)}</strong>` : escapeHtml(l)))
    .join("<br />");
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111;">${body}</div>`;
}
