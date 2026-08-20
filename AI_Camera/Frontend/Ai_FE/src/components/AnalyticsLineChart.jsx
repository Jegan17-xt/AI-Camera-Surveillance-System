import { useId, useRef, useState } from "react";

// Dependency-free SVG line chart — this app has no charting library
// installed, and one series per chart doesn't warrant adding one. Fixed
// height, scales responsively via viewBox (width: 100%). One series only
// (per the "one axis" / "a single series needs no legend" rule — the
// card's own title already names what's plotted).
const WIDTH = 640;
const HEIGHT = 260;
const PAD = { top: 20, right: 20, bottom: 32, left: 34 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

// Rounds a max value up to a "clean" axis ceiling (0 stays 4, so a
// flat-zero series still draws a readable band instead of a degenerate
// 0-height plot).
function niceCeiling(max) {
  if (max <= 4) return 4;

  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalized = max / magnitude;
  const step = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;

  return step * magnitude;
}

// Catmull-Rom -> cubic Bezier smoothing through every point, so the line
// reads as a smooth curve instead of a raw polyline, without overshooting
// past the actual data range.
function smoothPath(points) {
  if (points.length < 2) return "";

  let d = `M ${points[0].x} ${points[0].y}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;

    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }

  return d;
}

export default function AnalyticsLineChart({ data = [], color = "#22d3ee", valueSuffix = "" }) {
  const gradientId = useId();
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const values = data.map((d) => d.count);
  const maxValue = niceCeiling(Math.max(...values, 0));
  const stepX = data.length > 1 ? PLOT_W / (data.length - 1) : 0;

  const points = data.map((d, i) => ({
    x: PAD.left + (data.length > 1 ? i * stepX : PLOT_W / 2),
    y: PAD.top + PLOT_H - (d.count / maxValue) * PLOT_H,
    ...d,
  }));

  const linePath = smoothPath(points);
  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x} ${PAD.top + PLOT_H} L ${points[0].x} ${PAD.top + PLOT_H} Z`
      : "";

  const yTicks = [0, 0.5, 1].map((f) => Math.round(maxValue * f));

  const handleMove = (e) => {
    if (!svgRef.current || points.length === 0) return;

    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const nearest = points.reduce(
      (best, p, i) => (Math.abs(p.x - relX) < Math.abs(points[best].x - relX) ? i : best),
      0
    );

    setHoverIndex(nearest);
  };

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  // Keep the tooltip from running off either edge of the chart.
  const tooltipWidth = 108;
  const tooltipX = hovered ? Math.min(Math.max(hovered.x - tooltipWidth / 2, 0), WIDTH - tooltipWidth) : 0;

  return (
    <div className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Gridlines — hairline, recessive, one step off the surface */}
        {yTicks.map((tick) => {
          const y = PAD.top + PLOT_H - (tick / maxValue) * PLOT_H;
          return (
            <g key={tick}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <text x={PAD.left - 10} y={y + 4} textAnchor="end" className="fill-ink-500" fontSize="11" fontFamily="var(--font-mono)">
                {tick}
              </text>
            </g>
          );
        })}

        {/* Area wash + line */}
        {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
        {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}

        {/* X-axis labels */}
        {points.map((p, i) => (
          <text
            key={i}
            x={p.x}
            y={HEIGHT - 10}
            textAnchor="middle"
            className="fill-ink-500"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            {p.label}
          </text>
        ))}

        {/* Dots — 2px surface ring so they stay legible crossing the line */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === hoverIndex ? 5 : 3.5}
            fill={color}
            stroke="#0a0e1a"
            strokeWidth="2"
            className="transition-[r] duration-100"
          />
        ))}

        {/* Crosshair */}
        {hovered && (
          <line
            x1={hovered.x}
            x2={hovered.x}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
            stroke={color}
            strokeOpacity="0.35"
            strokeWidth="1"
          />
        )}

        {/* Hit layer for hover tracking */}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          style={{ cursor: "crosshair" }}
        />
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg glass-strong px-3 py-2 text-xs shadow-xl"
          style={{ left: `${(tooltipX / WIDTH) * 100}%`, width: `${(tooltipWidth / WIDTH) * 100}%` }}
        >
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-500">{hovered.label}</p>
          <p className="font-display text-sm font-semibold text-white">
            {hovered.count}
            {valueSuffix}
          </p>
        </div>
      )}
    </div>
  );
}
