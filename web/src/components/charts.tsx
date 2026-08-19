"use client";

import { useId, useMemo, useState } from "react";

/* ==========================================================================
   Gráficas en SVG, sin dependencias externas.
   Los colores salen de variables CSS, de modo que el modo nocturno se
   resuelve solo. La paleta está validada para daltonismo en ambos modos.
   ========================================================================== */

type TrendPoint = { key: string; label: string; value: number };

const TREND_WIDTH = 640;
const TREND_HEIGHT = 210;
const TREND_PAD = { top: 14, right: 16, bottom: 26, left: 34 };
const COMPOSITION_WIDTH = 640;
const COMPOSITION_HEIGHT = 42;
const COMPOSITION_GAP = 2;

/**
 * Tendencia de un único indicador a lo largo del tiempo.
 * Una sola serie: no lleva leyenda, el título la nombra.
 */
export function TrendChart({
  points,
  emptyLabel,
  averageLabel,
  valueSuffix = "%",
}: {
  points: TrendPoint[];
  emptyLabel: string;
  averageLabel: string;
  valueSuffix?: string;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const W = TREND_WIDTH;
  const H = TREND_HEIGHT;
  const PAD = TREND_PAD;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
    const coords = points.map((p, i) => ({
      ...p,
      x: PAD.left + (points.length > 1 ? i * stepX : plotW / 2),
      y: PAD.top + plotH - (Math.min(100, Math.max(0, p.value)) / 100) * plotH,
    }));
    const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const area =
      `${line} L${coords[coords.length - 1].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)}` +
      ` L${coords[0].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;
    const average = points.reduce((sum, p) => sum + p.value, 0) / points.length;
    return { coords, line, area, average };
  }, [PAD.left, PAD.top, plotH, plotW, points]);

  if (!geometry) return <p className="empty">{emptyLabel}</p>;

  const { coords, line, area, average } = geometry;
  const avgY = PAD.top + plotH - (Math.min(100, Math.max(0, average)) / 100) * plotH;
  const active = hover !== null ? coords[hover] : null;

  // Se rotulan como mucho tres fechas para que no se solapen.
  const tickIdx = new Set<number>([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        role="img"
        aria-label={`${averageLabel}: ${average.toFixed(1)}${valueSuffix}`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 25, 50, 75, 100].map((tick) => {
          const y = PAD.top + plotH - (tick / 100) * plotH;
          return (
            <g key={tick}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} className="chart-grid" />
              <text x={PAD.left - 8} y={y + 3.5} className="chart-axis" textAnchor="end">
                {tick}
              </text>
            </g>
          );
        })}

        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} className="chart-line" />

        <line
          x1={PAD.left}
          y1={avgY}
          x2={W - PAD.right}
          y2={avgY}
          className="chart-average"
        />

        {coords.map((c, i) =>
          tickIdx.has(i) ? (
            <text key={`t-${c.key}`} x={c.x} y={H - 8} className="chart-axis" textAnchor="middle">
              {c.label}
            </text>
          ) : null,
        )}

        {active ? (
          <>
            <line
              x1={active.x}
              y1={PAD.top}
              x2={active.x}
              y2={PAD.top + plotH}
              className="chart-crosshair"
            />
            <circle cx={active.x} cy={active.y} r="5" className="chart-dot" />
          </>
        ) : null}

        {/* Zonas de captura, más anchas que el punto para facilitar el apuntado. */}
        {coords.map((c, i) => (
          <rect
            key={`h-${c.key}`}
            x={c.x - (plotW / Math.max(1, coords.length)) / 2}
            y={PAD.top}
            width={plotW / Math.max(1, coords.length)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>

      {active ? (
        <div
          className="chart-tooltip"
          style={{ left: `${(active.x / W) * 100}%`, top: `${(active.y / H) * 100}%` }}
        >
          <strong>
            {active.value}
            {valueSuffix}
          </strong>
          <span>{active.label}</span>
        </div>
      ) : null}

      <p className="chart-note">
        {averageLabel}: {average.toFixed(1)}
        {valueSuffix}
      </p>
    </div>
  );
}

export type CompositionSegment = {
  key: string;
  label: string;
  seconds: number;
  /** 1 a 4; 4 se dibuja con trama por tratarse de ausencia de actividad. */
  slot: 1 | 2 | 3 | 4;
  display: string;
};

/**
 * Reparto del tiempo en una barra apilada, con leyenda y cifras directas.
 */
export function CompositionChart({
  segments,
  emptyLabel,
}: {
  segments: CompositionSegment[];
  emptyLabel: string;
}) {
  const patternId = useId();
  const [hover, setHover] = useState<string | null>(null);
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.seconds), 0);

  if (total <= 0) return <p className="empty">{emptyLabel}</p>;

  const W = COMPOSITION_WIDTH;
  const H = COMPOSITION_HEIGHT;
  const GAP = COMPOSITION_GAP;
  const visible = segments.filter((s) => s.seconds > 0);

  const bars = visible.reduce<Array<CompositionSegment & { x: number; width: number; share: number }>>((rows, s, i) => {
    const previous = rows.at(-1);
    const x = previous ? previous.x + previous.share * W : 0;
    const share = s.seconds / total;
    const raw = share * W;
    const width = Math.max(0, raw - (i < visible.length - 1 ? GAP : 0));
    rows.push({ ...s, x, width, share });
    return rows;
  }, []);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg composition" role="img" aria-label={emptyLabel}>
        <defs>
          <pattern id={patternId} width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="7" height="7" className="chart-idle-bg" />
            <line x1="0" y1="0" x2="0" y2="7" className="chart-idle-line" />
          </pattern>
        </defs>
        {bars.map((b, i) => (
          <g key={b.key} onMouseEnter={() => setHover(b.key)} onMouseLeave={() => setHover(null)}>
            <rect
              x={b.x}
              y={0}
              width={b.width}
              height={H}
              rx={i === 0 || i === bars.length - 1 ? 4 : 0}
              fill={b.slot === 4 ? `url(#${patternId})` : `var(--chart-${b.slot})`}
              className={hover && hover !== b.key ? "chart-seg dim" : "chart-seg"}
            />
            {b.width > 58 ? (
              <text x={b.x + b.width / 2} y={H / 2 + 4} className="chart-seg-label" textAnchor="middle">
                {Math.round(b.share * 100)}%
              </text>
            ) : null}
          </g>
        ))}
      </svg>

      <ul className="chart-legend">
        {segments.map((s) => (
          <li key={s.key} className={hover && hover !== s.key ? "dim" : undefined}>
            <i className={`swatch slot-${s.slot}`} aria-hidden />
            <span>{s.label}</span>
            <strong>{s.display}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
