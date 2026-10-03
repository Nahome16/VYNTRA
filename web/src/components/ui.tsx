"use client";

import { CSSProperties, Fragment, ReactNode, useEffect, useId, useRef, useState } from "react";
import { useDialog } from "@/lib/use-dialog";
import { useT } from "@/components/preferences-provider";

export function StatCard({
  label,
  value,
  detail,
  tone = "plain",
  delta,
  deltaTone = "plain",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "plain" | "good" | "warn" | "bad";
  delta?: string;
  deltaTone?: "plain" | "good" | "warn" | "bad";
}) {
  return (
    <section className={`stat stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {delta ? <b className={`stat-delta delta-${deltaTone}`}>{delta}</b> : null}
      <small>{detail}</small>
    </section>
  );
}

export type MetricTone = "plain" | "good" | "warn" | "bad";

export type MetricItem = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  /** Indicador principal de la franja: más grande y con estado visible. */
  lead?: boolean;
  /** Estado que comunica el indicador (solo color del borde y la etiqueta, nunca del número). */
  tone?: MetricTone;
  /** Texto corto del estado, p. ej. "Requiere revisión". */
  status?: string;
  /** Avance 0-100 para mostrar una barra (uso de licencias, presencia...). */
  meter?: number;
};

/**
 * Franja de indicadores con jerarquía: los `lead` pesan más y llevan estado;
 * el resto son de apoyo. Sustituye a las filas de tarjetas iguales.
 */
export function MetricBand({ items, label }: { items: MetricItem[]; label: string }) {
  const columns = items.map((item) => (item.lead ? "minmax(0, 1.45fr)" : "minmax(0, 1fr)")).join(" ");
  return (
    <section className="metric-band" aria-label={label} style={{ "--metric-cols": columns } as CSSProperties}>
      {items.map((item) => (
        <div key={item.key} className={`metric${item.lead ? " metric-lead" : ""} metric-${item.tone || "plain"}`}>
          <span className="metric-label">{item.label}</span>
          <strong className="metric-value">{item.value}</strong>
          {item.meter !== undefined ? (
            <span className="metric-meter" aria-hidden>
              <i style={{ width: `${Math.min(100, Math.max(0, item.meter))}%` }} />
            </span>
          ) : null}
          {item.status || item.detail ? (
            <small className="metric-detail">
              {item.status ? <b className="metric-status">{item.status}</b> : null}
              {item.detail}
            </small>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export type AttentionTone = "bad" | "warn" | "info" | "good";

export type AttentionItem = {
  key: string;
  tone: AttentionTone;
  title: ReactNode;
  detail?: ReactNode;
  href?: string;
  /** La fila es un botón que llama a `onSelect` de la lista con su `key`. */
  selectable?: boolean;
  action?: string;
};

function AttentionGlyph({ tone }: { tone: AttentionTone }) {
  if (tone === "good") {
    return (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8.5 12.5 2.5 2.5 4.5-5" />
      </svg>
    );
  }
  if (tone === "info") {
    return (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24">
      <path d="M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 17h.01" />
    </svg>
  );
}

/**
 * Lista "requiere tu atención": cada fila con severidad (color + icono + texto)
 * y una acción directa. Lo más grave primero.
 */
export function AttentionList({
  items,
  label,
  empty,
  onSelect,
}: {
  items: AttentionItem[];
  label: string;
  onSelect?: (key: string) => void;
  /** Fila mostrada cuando no hay pendientes; si se omite, la lista no se pinta. */
  empty?: { title: ReactNode; detail?: ReactNode };
}) {
  const order: Record<AttentionTone, number> = { bad: 0, warn: 1, info: 2, good: 3 };
  const sorted = [...items].sort((a, b) => order[a.tone] - order[b.tone]);
  if (!sorted.length && !empty) return null;
  const rows: AttentionItem[] = sorted.length ? sorted : [{ key: "empty", tone: "good", title: empty!.title, detail: empty!.detail }];
  return (
    <section className="attention-list" aria-label={label}>
      {rows.map((item) => {
        const body = (
          <>
            <span className="attention-icon" aria-hidden>
              <AttentionGlyph tone={item.tone} />
            </span>
            <span className="attention-copy">
              <strong>{item.title}</strong>
              {item.detail ? <small>{item.detail}</small> : null}
            </span>
            {item.action ? (
              <span className="attention-action">
                {item.action}
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
            ) : null}
          </>
        );
        const className = `attention-row attention-${item.tone}`;
        if (item.href) {
          return (
            <a key={item.key} href={item.href} className={className}>
              {body}
            </a>
          );
        }
        if (item.selectable && onSelect) {
          return (
            <button key={item.key} type="button" className={className} onClick={() => onSelect(item.key)}>
              {body}
            </button>
          );
        }
        return (
          <div key={item.key} className={className}>
            {body}
          </div>
        );
      })}
    </section>
  );
}

export function Panel({
  title,
  meta,
  className = "",
  children,
}: {
  title: string;
  meta?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-title">
        <h2>{title}</h2>
        {meta ? <span>{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function StatusLine({ children }: { children: ReactNode }) {
  return (
    <span className="status-line" role="status" aria-live="polite">
      {children}
    </span>
  );
}

export function RefreshButton({
  loading,
  onClick,
}: {
  loading: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button className="btn btn-outline" onClick={onClick} disabled={loading}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4" />
        <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" />
      </svg>
      <span>{loading ? t("Actualizando") : t("Actualizar")}</span>
    </button>
  );
}

/* ==========================================================================
   Componentes del sistema de diseno v2 (ver src/app/design-system.css)
   ========================================================================== */

type Tone = "plain" | "good" | "warn" | "bad" | "accent" | "info";

/** Etiqueta de estado con punto: `<Chip tone="good">Activa</Chip>`. */
export function Chip({ tone = "plain", dot = true, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  const toneClass = tone === "plain" ? "" : ` chip-${tone}`;
  return <span className={`chip${toneClass}${dot ? "" : " no-dot"}`}>{children}</span>;
}

/** Barra de uso (plan, licencias). `value` y `max` en las mismas unidades. */
export function UsageBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
  const tone = pct >= 100 ? " bad" : pct >= 85 ? " warn" : "";
  return (
    <div className={`usage-bar${tone}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Estado vacio con titulo, una linea y una accion opcional. */
export function EmptyBlock({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}

/** Panel lateral (drawer) accesible: foco atrapado, Escape cierra, clic fuera cierra. */
export function Drawer({
  open,
  title,
  description,
  onClose,
  footer,
  wide = false,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const ref = useDialog<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden />
      <div ref={ref} className={`drawer${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="drawer-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("Cerrar")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </div>
    </>
  );
}

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; separatorBefore?: boolean };

/** Menu de acciones de fila (boton ⋮). Cierra al elegir, al hacer clic fuera o con Escape. */
export function RowMenu({ items, label }: { items: MenuItem[]; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  // El menu se posiciona respecto a la ventana (position: fixed) para que no lo
  // recorten las tablas con desplazamiento horizontal.
  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      const menuHeight = items.length * 34 + 16;
      const fitsBelow = rect.bottom + 4 + menuHeight <= window.innerHeight;
      setPosition({
        top: fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - 4 - menuHeight),
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={anchorRef} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label || t("Acciones")}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open ? (
        <div
          className="context-menu"
          role="menu"
          style={position ? { position: "fixed", top: position.top, right: position.right } : undefined}
        >
          {items.map((item) => (
            <Fragment key={item.label}>
              {item.separatorBefore ? <hr /> : null}
              <button
                type="button"
                role="menuitem"
                className={item.danger ? "danger" : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Pestanas simples controladas. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; danger?: boolean }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          className={tab.danger ? "danger" : undefined}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Dialogo de confirmacion accesible para acciones destructivas o irreversibles. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const ref = useDialog<HTMLDivElement>(open, onCancel);
  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onClick={onCancel} aria-hidden />
      <div ref={ref} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {description ? <div className="confirm-dialog-body">{description}</div> : null}
        <div className="confirm-dialog-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>
            {t("Cancelar")}
          </button>
          <button type="button" className={danger ? "btn btn-danger" : "btn"} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
