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
  readonly barColor?: string;
}

/**
 * A small, dependency-free bar chart (B13 scope §3 / this WP's brief §6:
 * "a small local chart component (no CDN)"). Plain SVG, no chart library —
 * the admin console's own dashboards need one glance, not a zoomable,
 * hoverable data-viz surface, and pulling in a charting package for that
 * would be the wrong trade on a shared, memory-constrained build.
 *
 * Renders nothing but an empty caption when `data` is empty, rather than a
 * chart with a phantom zero-width bar.
 */
export function BarChart({
  title,
  data,
  caption,
  height = 160,
  barColor = "#a3a3a3",
}: BarChartProps): React.JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barWidth = data.length === 0 ? 0 : 100 / data.length;

  return (
    <div className="rounded border border-neutral-800 p-4">
      <p className="text-sm font-medium text-neutral-100">{title}</p>
      {caption !== undefined && <p className="text-xs text-neutral-500">{caption}</p>}
      {data.length === 0 ? (
        <p className="mt-2 text-xs text-neutral-500">No data yet.</p>
      ) : (
        <svg
          role="img"
          aria-label={title}
          viewBox={`0 0 100 ${String(height)}`}
          preserveAspectRatio="none"
          className="mt-2 h-40 w-full"
        >
          {data.map((d, index) => {
            const barHeight = (d.value / max) * (height - 20);
            const x = index * barWidth;
            return (
              <g key={d.label}>
                <rect
                  x={x + barWidth * 0.15}
                  y={height - 20 - barHeight}
                  width={barWidth * 0.7}
                  height={barHeight}
                  fill={barColor}
                >
                  <title>
                    {d.label}: {d.value}
                  </title>
                </rect>
                <text
                  x={x + barWidth / 2}
                  y={height - 6}
                  fontSize={4}
                  textAnchor="middle"
                  fill="#737373"
                >
                  {d.label.length > 10 ? `${d.label.slice(0, 9)}…` : d.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
