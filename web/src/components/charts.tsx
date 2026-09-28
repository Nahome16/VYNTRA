"use client";

import { ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import styles from "./charts.module.css";

/* ==========================================================================
   Graficas sin dependencias externas (sistema de diseno v2).
   Colores por token: --chart-1 productivo (teal), --chart-2 neutral (pizarra),
   --chart-3 no productivo (rosa), --chart-4 inactivo (gris, con trama).
   Alturas fijas y ancho medido: el texto nunca se escala ni se deforma.
   ========================================================================== */

type TrendPoint = { key: string; label: string; value: number };

/** 1 productivo · 2 neutral · 3 no productivo · 4 inactivo · 5 sin clasificar. */
export type ChartSlot = 1 | 2 | 3 | 4 | 5;

const slotClass: Record<ChartSlot, string> = {
  1: styles.slot1,
  2: styles.slot2,
  3: styles.slot3,
  4: styles.slot4,
  5: styles.slot5,
};

const slotStroke: Record<ChartSlot, string> = {
  1: "var(--chart-1)",
  2: "var(--chart-2)",
  3: "var(--chart-3)",
  4: "var(--chart-4)",
  5: "var(--line-strong)",
};

/** Clase de muestra de color para un slot, util para leyendas externas. */
export function swatchClass(slot: ChartSlot) {
  return `${styles.swatch} ${slotClass[slot]}`;
}

/** Ancho real del contenedor, para dibujar en pixeles con alto fijo. */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    if (typeof ResizeObserver === "undefined") {
      const timer = window.setTimeout(() => setWidth(element.clientWidth), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width || 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

function clampPct(value: number) {
  return Math.min(100, Math.max(0, value));
}

function ChartEmpty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

/* --------------------------------------------------------------------------
   Tendencia (linea + area) de un unico indicador en %
   -------------------------------------------------------------------------- */

const TREND_PAD = { top: 12, right: 12, bottom: 26, left: 34 };

/**
 * Tendencia de un unico indicador a lo largo del tiempo.
 * Una sola serie: no lleva leyenda, el titulo la nombra.
 */
export function TrendChart({
  points,
  emptyLabel,
  averageLabel,
  valueSuffix = "%",
  height = 220,
}: {
  points: TrendPoint[];
  emptyLabel: string;
  averageLabel: string;
  valueSuffix?: string;
  height?: number;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [measureRef, width] = useElementWidth<HTMLDivElement>();

  const W = Math.max(width, 120);
  const H = height;
  const PAD = TREND_PAD;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
    const coords = points.map((p, i) => ({
      ...p,
      x: PAD.left + (points.length > 1 ? i * stepX : plotW / 2),
      y: PAD.top + plotH - (clampPct(p.value) / 100) * plotH,
    }));
    const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const area =
      `${line} L${coords[coords.length - 1].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)}` +
      ` L${coords[0].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;
    const average = points.reduce((sum, p) => sum + p.value, 0) / points.length;
    return { coords, line, area, average };
  }, [PAD.left, PAD.top, plotH, plotW, points]);

  if (!geometry) return <ChartEmpty>{emptyLabel}</ChartEmpty>;

  const { coords, line, area, average } = geometry;
  const avgY = PAD.top + plotH - (clampPct(average) / 100) * plotH;
  const active = hover !== null ? coords[hover] : null;

  // Se rotulan como mucho cinco fechas para que no se solapen.
  const maxTicks = Math.max(2, Math.min(5, Math.floor(plotW / 70)));
  const every = Math.max(1, Math.ceil(coords.length / maxTicks));
  const tickIdx = new Set<number>(coords.map((_, i) => i).filter((i) => i % every === 0 || i === coords.length - 1));

  return (
    <div className={styles.chart}>
      <div ref={measureRef} className={styles.measure} style={{ height: H }}>
        {width > 0 ? (
          <svg
            width={W}
            height={H}
            className={styles.svg}
            role="img"
            aria-label={`${averageLabel}: ${average.toFixed(1)}${valueSuffix}`}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.18" />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0.01" />
              </linearGradient>
            </defs>

            {[0, 25, 50, 75, 100].map((tick) => {
              const y = PAD.top + plotH - (tick / 100) * plotH;
              return (
                <g key={tick}>
                  <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} className={styles.grid} />
                  <text x={PAD.left - 8} y={y + 3.5} className={styles.axis} textAnchor="end">
                    {tick}
                  </text>
                </g>
              );
            })}

            <path d={area} fill={`url(#${gradientId})`} />
            <path d={line} className={styles.line} />
            <line x1={PAD.left} y1={avgY} x2={W - PAD.right} y2={avgY} className={styles.average} />

            {coords.map((c, i) =>
              tickIdx.has(i) ? (
                <text key={`t-${c.key}`} x={c.x} y={H - 6} className={styles.axis} textAnchor="middle">
                  {c.label}
                </text>
              ) : null,
            )}

            {coords.length <= 14
              ? coords.map((c, i) => (i === hover ? null : <circle key={`p-${c.key}`} cx={c.x} cy={c.y} r="2.5" className={styles.dot} />))
              : null}

            {active ? (
              <>
                <line x1={active.x} y1={PAD.top} x2={active.x} y2={PAD.top + plotH} className={styles.crosshair} />
                <circle cx={active.x} cy={active.y} r="5" className={styles.dot} />
              </>
            ) : null}

            {/* Zonas de captura, mas anchas que el punto para facilitar el apuntado. */}
            {coords.map((c, i) => (
              <rect
                key={`h-${c.key}`}
                x={c.x - plotW / Math.max(1, coords.length) / 2}
                y={PAD.top}
                width={plotW / Math.max(1, coords.length)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
        ) : null}
      </div>

      {active ? (
        <div className={styles.tooltip} style={{ left: active.x, top: active.y }}>
          <strong>
            {active.value}
            {valueSuffix}
          </strong>
          <span>{active.label}</span>
        </div>
      ) : null}

      <p className={styles.note}>
        <span className={styles.swatchLine} aria-hidden /> {averageLabel}: {average.toFixed(1)}
        {valueSuffix}
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Barras diarias (un valor en % por dia) con linea de promedio
   -------------------------------------------------------------------------- */

/**
 * Barras verticales para pocos puntos (hasta ~14). Resalta el ultimo dia,
 * dibuja el promedio como linea discontinua y muestra el valor al pasar.
 */
export function BarTrendChart({
  points,
  emptyLabel,
  seriesLabel,
  averageLabel,
  valueSuffix = "%",
  height = 220,
}: {
  points: TrendPoint[];
  emptyLabel: string;
  seriesLabel: string;
  averageLabel: string;
  valueSuffix?: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <ChartEmpty>{emptyLabel}</ChartEmpty>;

  const average = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const active = hover !== null ? points[hover] : null;
  const slotWidth = 100 / points.length;

  return (
    <div className={styles.chart}>
      <ul className={styles.legendInline}>
        <li>
          <i className={swatchClass(1)} aria-hidden />
          {seriesLabel}
        </li>
        <li>
          <i className={styles.swatchLine} aria-hidden />
          {averageLabel} <b>{average.toFixed(1)}{valueSuffix}</b>
        </li>
      </ul>

      <div className={styles.bars} role="img" aria-label={`${averageLabel}: ${average.toFixed(1)}${valueSuffix}`}>
        <div className={styles.barsAxis} style={{ height }} aria-hidden>
          {[0, 50, 100].map((tick) => (
            <span key={tick} style={{ bottom: `${tick}%` }}>{tick}</span>
          ))}
        </div>
        <div className={styles.barsPlot} style={{ height }} onMouseLeave={() => setHover(null)}>
          {[50, 100].map((tick) => (
            <span key={tick} className={styles.barsGridLine} style={{ bottom: `${tick}%` }} aria-hidden />
          ))}
          <span className={styles.barsAverage} style={{ bottom: `${clampPct(average)}%` }} aria-hidden />
          {points.map((point, index) => (
            <div
              className={styles.barSlot}
              key={point.key}
              onMouseEnter={() => setHover(index)}
              title={`${point.label}: ${point.value}${valueSuffix}`}
            >
              <span
                className={`${styles.bar}${index === points.length - 1 ? ` ${styles.current}` : ""}`}
                style={{ height: `${Math.max(1.5, clampPct(point.value))}%` }}
              />
            </div>
          ))}
          {active && hover !== null ? (
            <div
              className={styles.tooltip}
              style={{ left: `${slotWidth * hover + slotWidth / 2}%`, top: `${100 - clampPct(active.value)}%` }}
            >
              <strong>
                {active.value}
                {valueSuffix}
              </strong>
              <span>{active.label}</span>
            </div>
          ) : null}
        </div>
        <div className={styles.barsLabels} aria-hidden>
          {points.map((point) => (
            <span key={point.key}>{point.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Dona de composicion (porcentajes que suman como mucho 100)
   -------------------------------------------------------------------------- */

export type DonutSegment = {
  key: string;
  label: string;
  /** Porcentaje 0-100 del total. */
  value: number;
  slot: ChartSlot;
  /** Texto secundario opcional (p. ej. una duracion). */
  detail?: string;
};

export function DonutChart({
  segments,
  centerValue,
  centerLabel,
  ariaLabel,
  size = 168,
}: {
  segments: DonutSegment[];
  centerValue: string;
  centerLabel: string;
  ariaLabel: string;
  size?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const stroke = 18;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = 2;

  const arcs = segments.reduce<Array<DonutSegment & { length: number; offset: number }>>((rows, segment) => {
    const previous = rows.at(-1);
    const offset = previous ? previous.offset + previous.length : 0;
    rows.push({ ...segment, offset, length: (clampPct(segment.value) / 100) * circumference });
    return rows;
  }, []);

  return (
    <div className={styles.donutWrap}>
      <div className={styles.donutFigure} style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle cx={size / 2} cy={size / 2} r={radius} className={styles.donutTrack} strokeWidth={stroke} />
            {arcs.map((arc) =>
              arc.length > 0 ? (
                <circle
                  key={arc.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  stroke={slotStroke[arc.slot]}
                  strokeWidth={stroke}
                  strokeDasharray={`${Math.max(0.5, arc.length - gap)} ${circumference}`}
                  strokeDashoffset={-arc.offset}
                  className={`${styles.donutSeg}${hover && hover !== arc.key ? ` ${styles.dim}` : ""}`}
                  onMouseEnter={() => setHover(arc.key)}
                  onMouseLeave={() => setHover(null)}
                />
              ) : null,
            )}
          </g>
        </svg>
        <div className={styles.donutCenter}>
          <strong>{centerValue}</strong>
          <span>{centerLabel}</span>
        </div>
      </div>

      <ul className={styles.legend}>
        {segments.map((segment) => (
          <li
            key={segment.key}
            className={hover && hover !== segment.key ? styles.dim : undefined}
            onMouseEnter={() => setHover(segment.key)}
            onMouseLeave={() => setHover(null)}
          >
            <i className={swatchClass(segment.slot)} aria-hidden />
            <span>{segment.label}</span>
            <small>{segment.detail || ""}</small>
            <strong>{segment.value}%</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Barra apilada de composicion (segundos por categoria)
   -------------------------------------------------------------------------- */

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
  stacked = false,
}: {
  segments: CompositionSegment[];
  emptyLabel: string;
  /** Leyenda en una sola columna con porcentaje (para paneles estrechos). */
  stacked?: boolean;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.seconds), 0);

  if (total <= 0) return <ChartEmpty>{emptyLabel}</ChartEmpty>;

  const visible = segments.filter((s) => s.seconds > 0);

  return (
    <div className={styles.chart}>
      <div className={styles.stack} role="img" aria-label={visible.map((s) => `${s.label} ${Math.round((s.seconds / total) * 100)}%`).join(", ")}>
        {visible.map((s) => {
          const share = s.seconds / total;
          return (
            <span
              key={s.key}
              className={`${styles.stackSeg} ${slotClass[s.slot]}${hover && hover !== s.key ? ` ${styles.dim}` : ""}`}
              style={{ flexGrow: share, flexBasis: 0 }}
              title={`${s.label}: ${s.display}`}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
            >
              {share >= 0.09 ? `${Math.round(share * 100)}%` : ""}
            </span>
          );
        })}
      </div>

      <ul className={`${styles.legend}${stacked ? ` ${styles.legendStacked}` : ""}`}>
        {segments.map((s) => (
          <li
            key={s.key}
            className={hover && hover !== s.key ? styles.dim : undefined}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <i className={swatchClass(s.slot)} aria-hidden />
            <span>{s.label}</span>
            {stacked ? <small>{Math.round((Math.max(0, s.seconds) / total) * 100)}%</small> : null}
            <strong>{s.display}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Tarjeta de cifra (KPI) con marcador de categoria y comparacion
   -------------------------------------------------------------------------- */

export type StatTone = "plain" | "good" | "warn" | "bad";

export function StatTile({
  label,
  value,
  detail,
  marker,
  valueTone = "plain",
  delta,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  /** Slot de color de la serie a la que corresponde la cifra, o un nodo propio (p. ej. `live-dot`). */
  marker?: ChartSlot | ReactNode;
  valueTone?: StatTone;
  /** Comparacion con el periodo anterior; se omite si no aporta. */
  delta?: { text: string; direction: "up" | "down"; tone: StatTone; note: string };
}) {
  const markerNode =
    typeof marker === "number" ? (
      <i className={`${styles.tileMarker} ${slotClass[marker as ChartSlot]}`} aria-hidden />
    ) : (
      marker ?? null
    );
  return (
    <section className={styles.tile}>
      <span className={styles.tileLabel}>
        {markerNode}
        {label}
      </span>
      <strong className={`${styles.tileValue}${valueTone !== "plain" ? ` ${styles[valueTone]}` : ""}`}>{value}</strong>
      <span className={styles.tileFoot}>
        {delta ? (
          <span className={`${styles.delta} ${styles[delta.tone === "warn" ? "bad" : delta.tone]}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {delta.direction === "up" ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M19 12l-7 7-7-7" />}
            </svg>
            {delta.text}
            <span className={styles.deltaNote}>{delta.note}</span>
          </span>
        ) : null}
        {detail ? <span>{detail}</span> : null}
      </span>
    </section>
  );
}
