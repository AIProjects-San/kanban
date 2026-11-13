// The plain-text → HTML body every transactional mail shares.
//
// One wrap discipline: lines escaped and joined with <br />, inside the
// house Arial style. Before this module four mail builders hand-rolled the
// same split/escape/join/wrap with per-file bold-prefix sniffing.

import { escapeHtml } from "@/lib/utils";

export function emailHtml(
  text: string,
  opts: { bold?: (line: string) => boolean } = {},
): string {
  const body = text
    .split("\n")
    .map((line) => (opts.bold?.(line) ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line)))
    .join("<br />");
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111;">${body}</div>`;
}
