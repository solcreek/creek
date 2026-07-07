/**
 * Lightweight SVG sparkline — no chart library dependency.
 * Renders a filled area chart from an array of data points.
 */

interface SparklineProps {
  data: number[];
  max?: number;
  width?: number;
  height?: number;
  color?: string;
  fillOpacity?: number;
  label?: string;
}

export function Sparkline({
  data,
  max: maxOverride,
  width = 200,
  height = 48,
  color = "#22c55e",
  fillOpacity = 0.15,
  label,
}: SparklineProps) {
  if (data.length < 2) {
    return (
      <div
        style={{ width, height }}
        className="flex items-center justify-center text-xs text-muted-foreground"
      >
        {label ? `${label}: collecting…` : "collecting…"}
      </div>
    );
  }

  const max = maxOverride ?? Math.max(...data, 1);
  const padding = 2;
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * chartW;
    const y = padding + chartH - (Math.min(v, max) / max) * chartH;
    return `${x},${y}`;
  });

  const linePath = `M ${points.join(" L ")}`;
  const areaPath = `${linePath} L ${padding + chartW},${padding + chartH} L ${padding},${padding + chartH} Z`;

  return (
    <svg width={width} height={height} className="block">
      <path d={areaPath} fill={color} fillOpacity={fillOpacity} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
