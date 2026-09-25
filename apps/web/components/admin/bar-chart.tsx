import * as React from "react";

export interface BarChartDatum {
  readonly label: string;
  readonly value: number;
}

export interface BarChartProps {
  readonly title: string;
  readonly data: readonly BarChartDatum[];
  /** Rendered under the title — for example, "no daily buckets yet; today's snapshot". */
  readonly caption?: string;
  readonly height?: number;
  /** Any CSS colour. Omit it for the neutral bar the admin console uses everywhere. */
  readonly barColor?: string;
}

/**
 * A small, dependency-free bar chart (B13 scope §3 / this WP's brief §6:
 * "a small local chart component (no CDN)"). Plain SVG, no chart library —
 * the admin console's own dashboards need one glance, not a zoomable,
 * hoverable data-viz surface, and pulling in a charting package for that
 * would be the wrong trade on a shared, memory-constrained build.
 *
 * Only the bars are SVG. The labels and values are HTML under it, because the
 * SVG stretches (`preserveAspectRatio="none"`) and text inside it stretched
 * with it. Bars are a neutral, not the accent: a chart is content, and the
 * accent is spent elsewhere (DESIGN.md › Accent budget). Every value is also
 * written out, and a screen reader gets the whole series as a list (HIG
 * charts › Enhancing the accessibility of a chart).
 *
 * Renders nothing but an empty caption when `data` is empty, rather than a
 * chart with a phantom zero-width bar.
 */
export function BarChart({
  title,
  data,
  caption,
  height = 160,
  barColor,
}: BarChartProps): React.JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barWidth = data.length === 0 ? 0 : 100 / data.length;
  const plotHeight = height - 8;

  return (
    <div className="flex min-w-0 flex-col rounded-md border border-border bg-surface p-5">
      <h3 className="text-sm font-semibold text-fg-0">{title}</h3>
      {caption !== undefined && <p className="mt-0.5 text-xs text-fg-2">{caption}</p>}
      {data.length === 0 ? (
        <p className="mt-4 text-sm text-fg-2">No data yet.</p>
      ) : (
        <>
          <svg
            role="img"
            aria-label={title}
            viewBox={`0 0 100 ${String(height)}`}
            preserveAspectRatio="none"
            className="mt-4 h-32 w-full"
          >
            <line
              x1={0}
              x2={100}
              y1={plotHeight}
              y2={plotHeight}
              className="stroke-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {data.map((d, index) => {
              const barHeight = (d.value / max) * (plotHeight - 4);
              const x = index * barWidth;
              return (
                <rect
                  key={d.label}
                  x={x + barWidth * 0.2}
                  y={plotHeight - barHeight}
                  width={barWidth * 0.6}
                  height={barHeight}
                  rx={1}
                  className={barColor === undefined ? "fill-neutral-500" : undefined}
                  style={barColor === undefined ? undefined : { fill: barColor }}
                >
                  <title>
                    {d.label}: {d.value}
                  </title>
                </rect>
              );
            })}
          </svg>
          <div
            aria-hidden="true"
            className="mt-2 grid gap-1"
            style={{ gridTemplateColumns: `repeat(${String(data.length)}, minmax(0, 1fr))` }}
          >
            {data.map((d) => (
              <div key={d.label} className="flex min-w-0 flex-col items-center text-center">
                <span className="text-xs font-medium tabular-nums text-fg-0">{d.value}</span>
                <span className="w-full truncate text-2xs text-fg-2" title={d.label}>
                  {d.label.length > 10 ? `${d.label.slice(0, 9)}…` : d.label}
                </span>
              </div>
            ))}
          </div>
          <ul className="sr-only">
            {data.map((d) => (
              <li key={d.label}>
                {d.label}: {d.value}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
