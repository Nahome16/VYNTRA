"use client";

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip, EmptyBlock, Panel, RefreshButton, StatusLine, Tabs } from "@/components/ui";
import { BarTrendChart, CompositionChart, TrendChart, swatchClass } from "@/components/charts";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { EmployeeDetailResponse } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { useDialog } from "@/lib/use-dialog";
import { monthStartISO, todayISO } from "@/lib/dates";
import { formatDuration, fullDate } from "@/lib/format";
import styles from "./employee-profile.module.css";

const activityHours = [9, 10, 11, 12, 13, 14, 15, 16, 17];
const EMPTY_PREVIEWS: Record<string, string> = {};

type EvidenceItem = EmployeeDetailResponse["evidence"][number];
type ProfileTab = "resumen" | "actividad" | "evidencias";

/**
 * Miniatura de evidencia que pide su vista previa solo cuando entra (o esta por
 * entrar) en pantalla, en lugar de descargar todas las capturas a la vez.
 */
function LazyEvidenceThumb({
  resetKey,
  onVisible,
  className,
  disabled,
  title,
  onClick,
  children,
}: {
  /** Al cambiar (nueva lista de evidencias) se vuelve a observar la miniatura. */
  resetKey: unknown;
  onVisible: () => void;
  className: string;
  disabled: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const onVisibleRef = useRef(onVisible);

  useEffect(() => {
    onVisibleRef.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    const element = buttonRef.current;
    if (!element) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      onVisibleRef.current();
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onVisibleRef.current();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [resetKey]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

type HourBucket = {
  productive: number;
  neutral: number;
  nonProductive: number;
  idle: number;
  total: number;
};

function initialsFor(name: string) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "US";
}

function percent(part: number, total: number) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

function shortDay(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("es-NI", {
    weekday: "short",
    day: "numeric",
  });
}

function classificationLabel(value: string) {
  const labels: Record<string, string> = {
    productive: "Productivo",
    neutral: "Neutral",
    non_productive: "No productivo",
    uncategorized: "Sin clasificar",
  };
  return labels[value] || value;
}

function classificationTone(value: string) {
  if (value === "productive") return "accent" as const;
  if (value === "neutral") return "info" as const;
  if (value === "non_productive") return "bad" as const;
  return "plain" as const;
}

function appShare(appSeconds: number, totalSeconds: number) {
  return `${Math.max(3, percent(appSeconds, totalSeconds))}%`;
}

function hourLabel(hour: number) {
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

function emptyHourBucket(): HourBucket {
  return {
    productive: 0,
    neutral: 0,
    nonProductive: 0,
    idle: 0,
    total: 0,
  };
}

function statusTone(status: string) {
  if (status === "active") return "good" as const;
  if (status === "inactive" || status === "suspended") return "warn" as const;
  return "plain" as const;
}

export function EmployeeProfile({
  employeeId,
  initialDateFrom,
  initialDateTo,
}: {
  employeeId: string;
  initialDateFrom?: string;
  initialDateTo?: string;
}) {
  const { apiGet, token } = useAuth();
  const { t } = usePreferences();
  const [employeeDetail, setEmployeeDetail] = useState<EmployeeDetailResponse | null>(null);
  const [previewState, setPreviewState] = useState<{ source: EvidenceItem[] | null; urls: Record<string, string> }>({
    source: null,
    urls: {},
  });
  const previewUrlsRef = useRef<string[]>([]);
  const previewRequestedRef = useRef<Set<string>>(new Set());
  const previewGenerationRef = useRef(0);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState("");
  const [dateFrom, setDateFrom] = useState(initialDateFrom || monthStartISO());
  const [dateTo, setDateTo] = useState(initialDateTo || todayISO());
  const [tab, setTab] = useState<ProfileTab>("resumen");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  const loadProfile = useCallback(async (nextDateFrom: string, nextDateTo: string) => {
    setLoading(true);
    setStatusText(t("Cargando perfil empleado..."));
    const params = new URLSearchParams();
    if (nextDateFrom) params.set("date_from", nextDateFrom);
    if (nextDateTo) params.set("date_to", nextDateTo);

    try {
      const detail = await apiGet<EmployeeDetailResponse>(
        `/api/employees/${employeeId}/detail?${params.toString()}`,
      );
      setEmployeeDetail(detail);
      setStatusText(t("Perfil actualizado"));
    } catch {
      setStatusText(t("No se pudo cargar el perfil empleado"));
    } finally {
      setLoading(false);
    }
  }, [apiGet, employeeId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadProfile(initialDateFrom || monthStartISO(), initialDateTo || todayISO());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialDateFrom, initialDateTo, loadProfile]);

  /** Cambiar una fecha aplica el rango al momento (si ambas son validas). */
  function changeRange(nextFrom: string, nextTo: string) {
    setDateFrom(nextFrom);
    setDateTo(nextTo);
    if (nextFrom && nextTo && nextFrom <= nextTo) void loadProfile(nextFrom, nextTo);
  }

  const evidenceList = employeeDetail?.evidence;
  // Las vistas previas pertenecen a la lista de evidencias actual; al cambiar de
  // rango o empleado se descartan (y sus object URLs se liberan abajo).
  const evidencePreviews = previewState.source === evidenceList ? previewState.urls : EMPTY_PREVIEWS;

  useEffect(() => {
    const requested = previewRequestedRef.current;
    return () => {
      previewGenerationRef.current += 1;
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current = [];
      requested.clear();
    };
  }, [evidenceList, token]);

  const requestEvidencePreview = useCallback(
    async (item: EvidenceItem) => {
      if (!token || !evidenceList || !item.content_type.includes("image")) return;
      if (previewRequestedRef.current.has(item.id)) return;
      previewRequestedRef.current.add(item.id);
      const generation = previewGenerationRef.current;
      try {
        const response = await apiFetch(item.view_url, { token, timeoutMs: 60_000 });
        const blob = await response.blob();
        if (generation !== previewGenerationRef.current) return;
        const url = URL.createObjectURL(blob);
        previewUrlsRef.current.push(url);
        setPreviewState((current) => ({
          source: evidenceList,
          urls: current.source === evidenceList ? { ...current.urls, [item.id]: url } : { [item.id]: url },
        }));
      } catch {
        // Sin vista previa: la miniatura queda como marcador deshabilitado.
      }
    },
    [evidenceList, token],
  );

  const productiveApps = useMemo(
    () => (employeeDetail?.apps || []).filter((app) => app.classification === "productive").slice(0, 5),
    [employeeDetail],
  );
  const distractingApps = useMemo(
    () => (employeeDetail?.apps || []).filter((app) => app.classification === "non_productive").slice(0, 5),
    [employeeDetail],
  );
  const detailTotal = employeeDetail?.totals.active_seconds || employeeDetail?.totals.total_seconds || 0;
  const selectedEvidence = useMemo(
    () => employeeDetail?.evidence.find((item) => item.id === selectedEvidenceId) || null,
    [employeeDetail?.evidence, selectedEvidenceId],
  );
  const evidenceDialogOpen = Boolean(selectedEvidence && evidencePreviews[selectedEvidence.id]);
  const evidenceDialogRef = useDialog<HTMLDivElement>(evidenceDialogOpen, () => setSelectedEvidenceId(""));
  const activityMap = useMemo(() => {
    if (!employeeDetail) return [];
    const dayLabels = new Map(employeeDetail.days.slice(-7).map((day) => [day.date, shortDay(day.date)]));
    const byDayHour = new Map<string, Map<number, HourBucket>>();

    (employeeDetail.blocks || []).forEach((block) => {
      if (!dayLabels.has(block.block_date)) return;
      const hour = Number(block.block_start.slice(0, 2));
      if (!activityHours.includes(hour)) return;
      if (!byDayHour.has(block.block_date)) byDayHour.set(block.block_date, new Map());
      const hourMap = byDayHour.get(block.block_date);
      if (!hourMap) return;
      const bucket = hourMap.get(hour) || emptyHourBucket();
      bucket.productive += block.productive_seconds;
      bucket.neutral += block.neutral_seconds + block.uncategorized_seconds;
      bucket.nonProductive += block.non_productive_seconds;
      bucket.idle += block.idle_seconds;
      bucket.total +=
        block.productive_seconds +
        block.neutral_seconds +
        block.uncategorized_seconds +
        block.non_productive_seconds +
        block.idle_seconds;
      hourMap.set(hour, bucket);
    });

    return Array.from(dayLabels, ([date, label]) => ({
      date,
      label,
      hours: activityHours.map((hour) => byDayHour.get(date)?.get(hour) || emptyHourBucket()),
    }));
  }, [employeeDetail]);

  const dailyTrend = useMemo(
    () =>
      (employeeDetail?.days || []).map((day) => ({
        key: day.date,
        label: fullDate(day.date).slice(0, 5),
        value: day.active_seconds
          ? Math.round(((day.productive_seconds + day.neutral_seconds) / day.active_seconds) * 1000) / 10
          : 0,
      })),
    [employeeDetail],
  );

  function exportProfileCsv() {
    if (!employeeDetail) return;
    const header = ["App", t("Clasificacion"), t("Tiempo"), t("Muestras")];
    const rows = employeeDetail.apps.map((app) => [
      app.app,
      t(classificationLabel(app.classification)),
      formatDuration(app.seconds),
      app.samples,
    ]);
    downloadCsv(`vyntra-perfil-${employeeDetail.employee.employee_code}-${dateFrom}-${dateTo}.csv`, header, rows);
  }

  const topApps = productiveApps.length ? productiveApps : (employeeDetail?.apps || []).slice(0, 5);
  const focusApps = distractingApps.length
    ? distractingApps
    : (employeeDetail?.apps || []).filter((app) => app.classification !== "productive").slice(0, 5);

  return (
    <div className={styles.view}>
      <section className={`toolbar ${styles.toolbar}`} aria-label={t("Periodo")}>
        <div className={styles.range} role="group" aria-label={t("Periodo")}>
          <span className={styles.rangeLabel}>{t("Periodo")}</span>
          <input
            type="date"
            aria-label={t("Desde")}
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => changeRange(event.target.value, dateTo)}
          />
          <span aria-hidden>–</span>
          <input
            type="date"
            aria-label={t("Hasta")}
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => changeRange(dateFrom, event.target.value)}
          />
        </div>
        <div className={styles.actions}>
          <RefreshButton loading={loading} onClick={() => void loadProfile(dateFrom, dateTo)} />
          <button className="btn btn-outline" onClick={exportProfileCsv} disabled={!employeeDetail}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
            </svg>
            <span>{t("Descargar informe")}</span>
          </button>
        </div>
      </section>

      {!employeeDetail ? (
        <EmptyBlock
          title={loading ? t("Cargando informacion del empleado...") : t("No se pudo cargar este perfil.")}
          description={loading ? undefined : t("Revisa el rango de fechas o vuelve a intentarlo.")}
          action={
            loading ? undefined : (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void loadProfile(dateFrom, dateTo)}>
                {t("Reintentar")}
              </button>
            )
          }
        />
      ) : (
        <div className={`${styles.content}${loading ? ` ${styles.busy}` : ""}`} aria-busy={loading}>
          <section className={styles.header}>
            <div className={styles.identity}>
              <div className={styles.avatarXl} aria-hidden>{initialsFor(employeeDetail.employee.full_name)}</div>
              <div>
                <h2>
                  {employeeDetail.employee.full_name}
                  <Chip tone={statusTone(employeeDetail.employee.status)}>
                    {employeeDetail.employee.status === "active" ? t("Activo") : t(employeeDetail.employee.status)}
                  </Chip>
                </h2>
                <p>
                  {employeeDetail.employee.position || t("Empleado monitoreado")} · {employeeDetail.employee.department || t("Sin departamento")}
                </p>
                <div className={styles.meta}>
                  <span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <path d="m3 7 9 6 9-6" />
                    </svg>
                    {employeeDetail.employee.email || t("Sin correo laboral")}
                  </span>
                  <span title={t("Equipo")}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <path d="M7 9h4M7 13h10M7 16h6" />
                    </svg>
                    {t("Equipo")} <span className={styles.mono}>{employeeDetail.employee.employee_code}</span>
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.stats}>
              <div className={styles.stat}>
                <span className={styles.statLabel}>{t("Horas rango")}</span>
                <strong className={styles.statValue}>{formatDuration(employeeDetail.totals.active_seconds)}</strong>
                <small className={styles.statDetail}>{t("Actividad real capturada")}</small>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}><i className={`${styles.mk} ${styles.mk1}`} aria-hidden />{t("Productividad")}</span>
                <strong className={styles.statValue}>{employeeDetail.totals.productivity_pct}%</strong>
                <small className={styles.statDetail}>{t("Sobre tiempo activo")}</small>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}><i className={`${styles.mk} ${styles.mk3}`} aria-hidden />{t("No productivo")}</span>
                <strong className={`${styles.statValue}${employeeDetail.totals.non_productive_pct > 12 ? ` ${styles.bad}` : ""}`}>
                  {employeeDetail.totals.non_productive_pct}%
                </strong>
                <small className={styles.statDetail}>{formatDuration(employeeDetail.totals.non_productive_seconds)}</small>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}><i className={`${styles.mk} ${styles.mk4}`} aria-hidden />{t("Inactivo")}</span>
                <strong className={`${styles.statValue}${employeeDetail.totals.idle_pct > 15 ? ` ${styles.warn}` : ""}`}>
                  {employeeDetail.totals.idle_pct}%
                </strong>
                <small className={styles.statDetail}>{formatDuration(employeeDetail.totals.idle_seconds)}</small>
              </div>
            </div>
          </section>

          <div className={styles.tabsBar}>
          <Tabs<ProfileTab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "resumen", label: t("Resumen") },
              { id: "actividad", label: t("Actividad") },
              { id: "evidencias", label: `${t("Evidencias")} · ${employeeDetail.evidence.length}` },
            ]}
          />
          </div>

          {tab === "resumen" ? (
            <>
              <div className={styles.grid2}>
                <Panel title={t("Distribucion del tiempo")} meta={`${fullDate(dateFrom)} – ${fullDate(dateTo)}`}>
                  <CompositionChart
                    stacked
                    emptyLabel={t("No hay actividad registrada para el rango.")}
                    segments={[
                      {
                        key: "productive",
                        label: t("Productivo"),
                        seconds: employeeDetail.totals.productive_seconds,
                        slot: 1,
                        display: formatDuration(employeeDetail.totals.productive_seconds),
                      },
                      {
                        key: "neutral",
                        label: t("Neutral"),
                        seconds: employeeDetail.totals.neutral_seconds + employeeDetail.totals.uncategorized_seconds,
                        slot: 2,
                        display: formatDuration(employeeDetail.totals.neutral_seconds + employeeDetail.totals.uncategorized_seconds),
                      },
                      {
                        key: "non-productive",
                        label: t("No productivo"),
                        seconds: employeeDetail.totals.non_productive_seconds,
                        slot: 3,
                        display: formatDuration(employeeDetail.totals.non_productive_seconds),
                      },
                      {
                        key: "idle",
                        label: t("Inactivo"),
                        seconds: employeeDetail.totals.idle_seconds,
                        slot: 4,
                        display: formatDuration(employeeDetail.totals.idle_seconds),
                      },
                    ]}
                  />
                </Panel>
                <Panel title={t("Productividad diaria")} meta={`${dailyTrend.length} ${dailyTrend.length === 1 ? t("día") : t("días")}`}>
                  {dailyTrend.length > 14 ? (
                    <TrendChart points={dailyTrend} emptyLabel={t("Sin datos suficientes para graficar.")} averageLabel={t("Promedio")} height={180} />
                  ) : (
                    <BarTrendChart
                      points={dailyTrend}
                      emptyLabel={t("Sin datos suficientes para graficar.")}
                      seriesLabel={t("Productivo + neutral")}
                      averageLabel={t("Promedio")}
                      height={150}
                    />
                  )}
                </Panel>
              </div>

              <div className={styles.grid2}>
                <Panel title={t("Aplicaciones principales")} meta={`${employeeDetail.apps.length} apps`}>
                  {topApps.length ? (
                    <div className={styles.appList}>
                      {topApps.map((app) => (
                        <div className={styles.appRow} key={`${app.app}-${app.classification}`}>
                          <div>
                            <span>{app.app}</span>
                            <small>{formatDuration(app.seconds)}</small>
                          </div>
                          <div className={styles.appBar} aria-hidden>
                            <i style={{ width: appShare(app.seconds, detailTotal) }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyBlock title={t("No hay apps registradas para el rango.")} />
                  )}
                </Panel>
                <Panel title={t("Puntos de foco")} meta={t("Apps que restan productividad")}>
                  {focusApps.length ? (
                    <div className={styles.appList}>
                      {focusApps.map((app) => (
                        <div className={styles.appRow} key={`${app.app}-${app.classification}`}>
                          <div>
                            <span>{app.app}</span>
                            <small>{formatDuration(app.seconds)}</small>
                          </div>
                          <div className={`${styles.appBar} ${styles.focus}`} aria-hidden>
                            <i style={{ width: appShare(app.seconds, detailTotal) }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyBlock title={t("No hay apps registradas para el rango.")} />
                  )}
                </Panel>
              </div>
            </>
          ) : null}

          {tab === "actividad" ? (
            <>
              <Panel title={t("Composicion de actividad (ultimos 7 dias)")} meta={`${fullDate(dateFrom)} – ${fullDate(dateTo)}`} className={styles.section}>
                <div className={styles.legendRow}>
                  <span><i className={swatchClass(1)} aria-hidden />{t("Productivo")}</span>
                  <span><i className={swatchClass(2)} aria-hidden />{t("Neutral")}</span>
                  <span><i className={swatchClass(3)} aria-hidden />{t("No productivo")}</span>
                  <span><i className={swatchClass(4)} aria-hidden />{t("Inactivo")}</span>
                </div>
                {activityMap.length ? (
                  <div className={styles.heatmap}>
                    <div className={`${styles.heatRow} ${styles.heatHead}`}>
                      <strong />
                      {activityHours.map((hour) => (
                        <strong key={hour}>{hourLabel(hour)}</strong>
                      ))}
                    </div>
                    {activityMap.map((day) => (
                      <div className={styles.heatRow} key={day.date}>
                        <strong>{day.label}</strong>
                        {day.hours.map((bucket, index) => (
                          <div
                            className={styles.cell}
                            key={`${day.date}-${activityHours[index]}`}
                            title={`${day.label} ${hourLabel(activityHours[index])}: ${formatDuration(bucket.total)}`}
                          >
                            {bucket.total ? (
                              <>
                                <span className={styles.segProductive} style={{ width: `${percent(bucket.productive, bucket.total)}%` }} />
                                <span className={styles.segNeutral} style={{ width: `${percent(bucket.neutral, bucket.total)}%` }} />
                                <span className={styles.segBad} style={{ width: `${percent(bucket.nonProductive, bucket.total)}%` }} />
                                <span className={styles.segIdle} style={{ width: `${percent(bucket.idle, bucket.total)}%` }} />
                              </>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyBlock title={t("No hay composicion calculada para este rango.")} />
                )}
              </Panel>

              <Panel title={t("Registro completo")} meta={`${employeeDetail.apps.length} apps`} className={styles.section}>
                {employeeDetail.apps.length ? (
                  <div className={styles.tableCard}>
                    <table>
                      <thead>
                        <tr>
                          <th>App</th>
                          <th>{t("Clasificacion")}</th>
                          <th className="num">{t("Tiempo")}</th>
                          <th className="num">{t("Muestras")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {employeeDetail.apps.map((app) => (
                          <tr key={`${app.app}-${app.classification}`}>
                            <td className={styles.appName}>{app.app}</td>
                            <td>
                              <Chip tone={classificationTone(app.classification)}>{t(classificationLabel(app.classification))}</Chip>
                            </td>
                            <td className="num">{formatDuration(app.seconds)}</td>
                            <td className="num">{app.samples}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyBlock title={t("No hay apps registradas para el rango.")} />
                )}
              </Panel>
            </>
          ) : null}

          {tab === "evidencias" ? (
            <Panel title={t("Revision de capturas")} meta={`${employeeDetail.evidence.length} ${t("archivos")}`} className={styles.section}>
              {employeeDetail.evidence.length ? (
                <div className={styles.gallery}>
                  {employeeDetail.evidence.map((item) => {
                    const preview = evidencePreviews[item.id];
                    const isImage = item.content_type.includes("image");
                    return (
                      <article className={styles.tile} key={item.id}>
                        <LazyEvidenceThumb
                          className={styles.thumb}
                          resetKey={evidenceList}
                          onVisible={() => void requestEvidencePreview(item)}
                          onClick={() => setSelectedEvidenceId(item.id)}
                          disabled={!preview}
                          title={preview ? `${t("Ver evidencia")}: ${item.original_filename}` : t("Vista previa no disponible")}
                        >
                          {preview ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={preview} alt={item.original_filename} loading="lazy" />
                          ) : (
                            <span className={styles.placeholder}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                {isImage ? (
                                  <>
                                    <rect x="3" y="4" width="18" height="16" rx="2" />
                                    <circle cx="9" cy="10" r="1.8" />
                                    <path d="m21 16-5-5-9 9" />
                                  </>
                                ) : (
                                  <>
                                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 3v5h5" />
                                  </>
                                )}
                              </svg>
                              {isImage ? "IMG" : "FILE"}
                            </span>
                          )}
                        </LazyEvidenceThumb>
                        <div className={styles.caption}>
                          <strong title={item.original_filename}>{item.original_filename}</strong>
                          <span>{new Date(item.captured_at).toLocaleString("es-NI")}</span>
                          <div className={styles.captionFoot}>
                            <small title={item.equipment}>{item.equipment}</small>
                            <Chip dot={false}>{t(item.status)}</Chip>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyBlock title={t("No hay capturas asociadas a este empleado en el rango.")} />
              )}
            </Panel>
          ) : null}
        </div>
      )}

      {selectedEvidence && evidencePreviews[selectedEvidence.id] ? (
        <div
          className={styles.modal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="evidence-dialog-title"
          ref={evidenceDialogRef}
          onClick={() => setSelectedEvidenceId("")}
        >
          <section className={styles.modalPanel} onClick={(event) => event.stopPropagation()}>
            <header className={styles.modalHead}>
              <div>
                <h2 id="evidence-dialog-title">{t("Evidencia")}</h2>
                <p>{selectedEvidence.original_filename}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setSelectedEvidenceId("")} aria-label={t("Cerrar")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </header>
            <div className={styles.modalImage}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={evidencePreviews[selectedEvidence.id]} alt={selectedEvidence.original_filename} />
            </div>
            <footer className={styles.modalFoot}>
              <span>{new Date(selectedEvidence.captured_at).toLocaleString("es-NI")}</span>
              <span>{selectedEvidence.equipment} · {t(selectedEvidence.status)}</span>
            </footer>
          </section>
        </div>
      ) : null}

      <StatusLine>{statusText}</StatusLine>
    </div>
  );
}
