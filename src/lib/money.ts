// The rounding + cents policy — a leaf module so every consumer (the
// payslip math, the offer builder, the leave kernels, the IRD filers)
// shares one rule without import cycles.

/** Round to 2 decimal places. Non-finite input collapses to 0; -0 is
 *  normalized (Object.is(-0, 0) is false, so a net-zero result must not
 *  surface as "negative zero" downstream or in JSON). */
export function round2(n: number): number {
  const r = Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
  return r === 0 ? 0 : r;
}

/** Integer cents from a dollar amount (same finite/-0 policy as round2). */
export function toCents(n: number): number {
  const c = Math.round((Number.isFinite(n) ? n : 0) * 100);
  return c === 0 ? 0 : c;
}
