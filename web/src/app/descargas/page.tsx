"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Chip, EmptyBlock, RefreshButton, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { AgentDownload, AgentDownloadsResponse } from "@/lib/types";
import { downloadAuthenticatedFile } from "@/lib/download-file";
import styles from "./descargas.module.css";

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Version publicada en el nombre del archivo (p. ej. VyntraAgent-Setup-1.4.2.exe). */
function versionOf(filename: string) {
  const match = filename.match(/(\d+\.\d+(?:\.\d+){0,2})/);
  return match ? match[1] : "";
}

function isManualInstaller(item: AgentDownload) {
  return item.filename.toLowerCase().endsWith(".exe");
}

function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

const downloadIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4v11M7 10l5 5 5-5M5 19h14" />
  </svg>
);

function PlatformIcon({ platform }: { platform: string }) {
  if (platform === "Windows") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 5.5 10.5 4.4v7.1H3zM11.5 4.3 21 3v8.5h-9.5zM3 12.5h7.5v7.1L3 18.5zM11.5 12.5H21V21l-9.5-1.3z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export default function DownloadsPage() {
  const { apiGet, token, user } = useAuth();
  const { t, language } = usePreferences();
  const locale = language === "en" ? "en-US" : "es-NI";
  const [downloads, setDownloads] = useState<AgentDownload[]>([]);
  const [directoryReady, setDirectoryReady] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [downloading, setDownloading] = useState("");

  const canManageDevices = Boolean(user?.permissions?.includes("devices:manage"));
  const manualDownloads = useMemo(() => downloads.filter(isManualInstaller), [downloads]);
  const windowsCount = useMemo(() => manualDownloads.filter((item) => item.platform === "Windows").length, [manualDownloads]);
  const hiddenUpdatePackages = useMemo(() => downloads.length - manualDownloads.length, [downloads.length, manualDownloads.length]);

  const loadDownloads = useCallback(async () => {
    if (!canManageDevices) return;
    setLoading(true);
    setStatusText("Cargando instaladores...");
    try {
      const response = await apiGet<AgentDownloadsResponse>("/api/downloads/agent");
      setDownloads(response.downloads);
      setDirectoryReady(response.directory_ready);
      setLoadFailed(false);
      const visibleCount = response.downloads.filter(isManualInstaller).length;
      setStatusText(visibleCount ? `${visibleCount} ${t("instaladores disponibles")}` : "No hay instaladores manuales publicados");
    } catch {
      setDownloads([]);
      setDirectoryReady(false);
      setLoadFailed(true);
      setStatusText("No se pudieron cargar las descargas");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [apiGet, canManageDevices, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDownloads();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDownloads]);

  async function downloadFile(item: AgentDownload) {
    setDownloading(item.filename);
    setStatusText(`${t("Descargando")} ${item.filename}...`);
    try {
      await downloadAuthenticatedFile(item.download_url, token, item.filename);
      setStatusText("Descarga iniciada");
    } catch {
      setStatusText("No se pudo descargar el instalador");
    } finally {
      setDownloading("");
    }
  }

  function formatDate(value: string) {
    if (!value) return "-";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  }

  if (!canManageDevices) {
    return (
      <AppShell title={t("Descargas")} description={t("Instaladores oficiales del agente VYNTRA")}>
        <EmptyBlock title={t("Acceso restringido")} description={t("Tu rol no tiene permiso para descargar instaladores.")} />
      </AppShell>
    );
  }

  // El resultado de la carga ya se ve en el resumen, la lista o el estado vacio.
  const routineStatus =
    statusText === "Cargando instaladores..." ||
    statusText === "No hay instaladores manuales publicados" ||
    statusText === "No se pudieron cargar las descargas" ||
    statusText.endsWith(t("instaladores disponibles"));

  const summary = [
    fill(t(manualDownloads.length === 1 ? "1 instalador" : "{n} instaladores"), { n: manualDownloads.length }),
    fill(t("{n} para Windows"), { n: windowsCount }),
    hiddenUpdatePackages
      ? fill(t(hiddenUpdatePackages === 1 ? "1 paquete de actualización oculto" : "{n} paquetes de actualización ocultos"), {
          n: hiddenUpdatePackages,
        })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <AppShell
      title={t("Descargas")}
      description={t("Instaladores oficiales para estaciones monitoreadas.")}
      actions={<RefreshButton loading={loading} onClick={() => void loadDownloads()} />}
    >
      <div className={styles.layout}>
        <section className={styles.main} aria-labelledby="downloads-title">
          <div className={styles.sectionHead}>
            <h2 id="downloads-title">{t("Instaladores")}</h2>
            {loaded && !loadFailed ? <span>{summary}</span> : null}
            {loaded && !loadFailed ? (
              <span className={styles.folder}>
                <Chip tone={directoryReady ? "good" : "warn"}>{directoryReady ? t("Carpeta activa") : t("Carpeta no preparada")}</Chip>
              </span>
            ) : null}
          </div>

          {loaded && !loadFailed && !directoryReady ? (
            <div className={styles.warning} role="note">
              <i aria-hidden />
              <div>
                <strong>{t("Falta publicar la carpeta de descargas en el servidor.")}</strong>
                <p>
                  {t("Sube los instaladores a")} <code>/opt/vyntra/downloads</code> {t("y reconstruye la API para activar el montaje.")}
                </p>
              </div>
            </div>
          ) : null}

          {!loaded ? (
            <p className={styles.loadingText}>{t("Cargando instaladores...")}</p>
          ) : loadFailed ? (
            <EmptyBlock
              title={t("No se pudieron cargar las descargas")}
              description={t("Revisa la conexión con la API e inténtalo de nuevo.")}
              action={
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void loadDownloads()} disabled={loading}>
                  {t("Reintentar")}
                </button>
              }
            />
          ) : !manualDownloads.length ? (
            <EmptyBlock
              title={t("No hay instaladores publicados")}
              description={t("Cuando se publique el instalador .exe de Windows en el servidor aparecerá aquí.")}
              action={
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void loadDownloads()} disabled={loading}>
                  {t("Actualizar")}
                </button>
              }
            />
          ) : (
            <ul className={styles.list}>
              {manualDownloads.map((item) => {
                const version = versionOf(item.filename);
                const busy = downloading === item.filename;
                return (
                  <li className={styles.item} key={item.filename}>
                    <span className={styles.platformIcon}>
                      <PlatformIcon platform={item.platform} />
                    </span>
                    <div className={styles.itemBody}>
                      <h3 title={item.filename}>{item.filename}</h3>
                      <div className={styles.meta}>
                        <Chip dot={false}>{item.platform}</Chip>
                        <span>{version ? `${t("Versión")} ${version}` : t("Versión sin indicar")}</span>
                        <span>{formatSize(item.size_bytes)}</span>
                        <span>
                          {t("Actualizado")} {formatDate(item.updated_at)}
                        </span>
                      </div>
                    </div>
                    <button type="button" className="btn" onClick={() => void downloadFile(item)} disabled={busy}>
                      {downloadIcon}
                      <span>{busy ? t("Descargando...") : t("Descargar")}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {statusText && !routineStatus ? <StatusLine>{t(statusText)}</StatusLine> : null}
        </section>

        <aside className={styles.guide} aria-labelledby="downloads-guide-title">
          <h2 id="downloads-guide-title">{t("Uso recomendado")}</h2>
          <ol className={styles.steps}>
            <li>{t("Descarga unicamente el instalador .exe de Windows desde esta vista.")}</li>
            <li>{t("Instalalo por videollamada o soporte remoto con el usuario autorizado.")}</li>
            <li>{t("El usuario inicia sesion, cambia clave si aplica y acepta consentimiento.")}</li>
            <li>{t("Verifica el equipo en Dispositivos y las capturas en el perfil del empleado.")}</li>
          </ol>
          <div className={styles.note}>
            <strong>{t("Piloto privado.")}</strong>
            <p>
              {t(
                "Los paquetes ZIP quedan reservados para actualizaciones internas del agente y no se muestran como instaladores manuales.",
              )}
            </p>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
