// Client-safe display formatters — the one money/date/download kit every
// view shares. Before this module thirteen views carried private money()
// copies (one without the "$"), six carried fmtDay copies, and nine
// hand-rolled the CSV download dance.

/** "$1,234.56" — dollars, always two decimals, en-NZ grouping. */
export function formatMoney(dollars: number): string {
  return `$${dollars.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "$1,234.56" from integer cents (the filed amounts' storage unit). */
export function formatMoneyCents(cents: number): string {
  return formatMoney(cents / 100);
}

/** "12 Nov 2026" for a "YYYY-MM-DD" day key, timezone-stable (UTC). */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Trigger a browser download of a text payload (CSV exports etc.). */
export function downloadBlob(content: string, filename: string, mime = "text/csv"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
