"use client";

// ---------------------------------------------------------------------------
// P22 (PR-C01–04) — the shared, dependency-free SVG chart pair the analytics
// panels ride. Recharts stays confined to the lazily-loaded Analytics view
// (L-P1-17 bundle budget — the Payroll view is NOT lazy, so a recharts import
// here would ship ~100KB gzipped to every user); these two components are
// hand-rolled SVG with no runtime dependency, and later items (PL-04/PL-05,
// EM-C06/07, RJ-C01) reuse them.
//
//   • TrendChart  — one area+line series over ordered buckets (months),
//                   min/max labels, sparse x labels, honest empty state.
//   • BarListChart — horizontal categorical bars, largest first (the caller
//                   sorts), value + share labels, honest empty state.
//
// Both render role="img" with an aria-label and a <title> so screen readers
// and the test suite see the same summary.
// ---------------------------------------------------------------------------

import { cn } from "@/lib/utils";

export interface TrendPoint {
  /** Bucket display label ("Nov 2026"). */
  label: string;
  value: number;
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${round1(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${round1(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Area+line trend over ordered buckets. `formatValue` renders the
 * min/max/last callouts (money in the Payroll panel); points render
 * left-to-right regardless of count (label density adapts).
 */
export function TrendChart({
  title,
  points,
  formatValue,
  className,
  color = "#0ea5e9",
  fill = "rgba(14,165,233,0.12)",
  emptyHint = "No data yet",
  testId,
}: {
  /** Accessible summary (also the rendered heading-less <title>). */
  title: string;
  points: TrendPoint[];
  /** e.g. (n) => `$${n.toLocaleString()}` — renders on the min/max/last marks. */
  formatValue?: (n: number) => string;
  className?: string;
  color?: string;
  fill?: string;
  emptyHint?: string;
  testId?: string;
}) {
  if (points.length === 0) {
    return (
      <div
        className={cn("rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground", className)}
        data-testid={testId}
        role="img"
        aria-label={`${title} — ${emptyHint}`}
      >
        {emptyHint}
      </div>
    );
  }

  const W = 560;
  const H = 180;
  const PAD_L = 8;
  const PAD_R = 8;
  const PAD_T = 18;
  const PAD_B = 22;
  const values = points.map((p) => (Number.isFinite(p.value) ? p.value : 0));
  const max = Math.max(...values, 0);
  // Axis floor is zero (the area baseline — money trends read best from 0),
  // but the CALLOUT states the smallest data value, never the axis floor.
  const dataMin = Math.min(...values);
  const axisMin = Math.min(...values, 0);
  const span = max - axisMin || 1;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD_T + innerH - ((v - axisMin) / span) * innerH;

  const lineD = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const areaD = `${lineD} L${x(points.length - 1).toFixed(1)},${(PAD_T + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD_T + innerH).toFixed(1)} Z`;

  // Sparse x labels: first + last always; in between when there is room.
  const labelIdx = new Set<number>([0, points.length - 1]);
  if (points.length > 2) {
    const mid = Math.floor((points.length - 1) / 2);
    if (mid !== 0 && mid !== points.length - 1) labelIdx.add(mid);
  }

  const maxIdx = values.indexOf(Math.max(...values));
  const fmt = formatValue ?? ((n: number) => String(n));

  return (
    <div className={cn("w-full", className)} data-testid={testId} role="img" aria-label={title}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
        <title>{title}</title>
        {/* gridlines at the axis floor / midpoint / max value */}
        {[axisMin, axisMin + span / 2, max].map((v, i) => (
          <line
            key={i}
            x1={PAD_L}
            x2={W - PAD_R}
            y1={y(v)}
            y2={y(v)}
            stroke="currentColor"
            strokeWidth={0.5}
            strokeDasharray="2,3"
            className="text-border"
          />
        ))}
        <path d={areaD} fill={fill} />
        <path d={lineD} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* the max + last points get markers */}
        <circle cx={x(maxIdx)} cy={y(values[maxIdx])} r={3.5} fill={color} />
        <circle cx={x(points.length - 1)} cy={y(values[values.length - 1])} r={3.5} fill={color} />
        {/* x labels */}
        {[...labelIdx].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 6}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
            className="fill-muted-foreground"
            fontSize={10}
          >
            {points[i].label}
          </text>
        ))}
        {/* min/max callouts (values, top-left/top-right) */}
        <text x={PAD_L} y={12} className="fill-muted-foreground" fontSize={10}>
          min {fmt(dataMin)}
        </text>
        <text x={W - PAD_R} y={12} textAnchor="end" className="fill-muted-foreground" fontSize={10}>
          max {fmt(max)}
        </text>
      </svg>
      {/* sighted value legend under the chart (also the accessible detail) */}
      <div className="mt-1 flex items-center justify-between text-[0.625rem] text-muted-foreground">
        <span>{points[0].label}</span>
        <span className="font-medium text-foreground">
          {points[points.length - 1].label}: {fmt(values[values.length - 1])}
        </span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}

export interface BarListRow {
  label: string;
  value: number;
}

/** One rendered bar row (module-level — never created during render). */
function BarRow({ row, max, total, fmt, color }: {
  row: BarListRow;
  max: number;
  total: number;
  fmt: (n: number) => string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-28 shrink-0 truncate text-xs text-foreground" title={row.label}>{row.label}</span>
      <span className="grow h-4 rounded-sm bg-muted overflow-hidden">
        <span
          className="block h-full rounded-sm"
          style={{ width: `${max > 0 ? Math.max(1, (row.value / max) * 100) : 0}%`, backgroundColor: color }}
        />
      </span>
      <span className="w-20 shrink-0 text-right text-xs font-medium tabular-nums text-foreground">{fmt(row.value)}</span>
      <span className="w-10 shrink-0 text-right text-[0.625rem] text-muted-foreground tabular-nums">
        {Math.round((row.value / total) * 100)}%
      </span>
    </div>
  );
}

/**
 * Horizontal categorical bars — one row per bucket, width proportional to
 * the largest bucket, the value and its share rendered beside the label.
 * The caller sorts (largest first is the house convention).
 */
export function BarListChart({
  title,
  rows,
  formatValue,
  className,
  color = "#34d399",
  emptyHint = "No data yet",
  testId,
  maxRows = 8,
}: {
  /** Accessible summary (also the rendered <title>). */
  title: string;
  rows: BarListRow[];
  /** e.g. (n) => `$${n.toLocaleString()}` — renders each row's value. */
  formatValue?: (n: number) => string;
  className?: string;
  color?: string;
  emptyHint?: string;
  testId?: string;
  /** Rows beyond this are folded into an "others" summary row. */
  maxRows?: number;
}) {
  if (rows.length === 0) {
    return (
      <div
        className={cn("rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground", className)}
        data-testid={testId}
        role="img"
        aria-label={`${title} — ${emptyHint}`}
      >
        {emptyHint}
      </div>
    );
  }

  const fmt = formatValue ?? ((n: number) => String(n));
  const shown = rows.slice(0, maxRows);
  const rest = rows.slice(maxRows);
  const restTotal = rest.reduce((sum, r) => sum + r.value, 0);
  const max = Math.max(...shown.map((r) => r.value), 0);
  const total = rows.reduce((sum, r) => sum + r.value, 0) || 1;

  return (
    <div className={cn("w-full", className)} data-testid={testId} role="img" aria-label={title}>
      <svg viewBox="0 0 1 1" className="sr-only" aria-hidden="true">
        <title>{title}</title>
      </svg>
      <div className="divide-y divide-border">
        {shown.map((r) => <BarRow key={r.label} row={r} max={max} total={total} fmt={fmt} color={color} />)}
        {rest.length > 0 && <BarRow key="__others__" row={{ label: `Others (${rest.length})`, value: restTotal }} max={max} total={total} fmt={fmt} color={color} />}
      </div>
    </div>
  );
}

export { fmtCompact as formatCompactNumber };
