"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Panel, RefreshButton, StatCard, StatusLine } from "@/components/ui";
import { useAuth } from "@/components/auth-provider";
import { AgentDownload, AgentDownloadsResponse } from "@/lib/types";
import { downloadAuthenticatedFile } from "@/lib/download-file";

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString("es-NI");
}

function platformTone(platform: string) {
  if (platform === "Windows") return "badge attendance-good";
  if (platform === "macOS") return "badge attendance-warn";
  return "badge";
}

function isManualInstaller(item: AgentDownload) {
  return item.filename.toLowerCase().endsWith(".exe");
}

export default function DownloadsPage() {
  const { apiGet, token, user } = useAuth();
  const [downloads, setDownloads] = useState<AgentDownload[]>([]);
  const [directoryReady, setDirectoryReady] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
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
      const visibleCount = response.downloads.filter(isManualInstaller).length;
      setStatusText(visibleCount ? `${visibleCount} instaladores disponibles` : "No hay instaladores manuales publicados");
    } catch {
      setDownloads([]);
      setDirectoryReady(false);
      setStatusText("No se pudieron cargar las descargas");
    } finally {
      setLoading(false);
    }
  }, [apiGet, canManageDevices]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDownloads();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDownloads]);

  async function downloadFile(item: AgentDownload) {
    setDownloading(item.filename);
    setStatusText(`Descargando ${item.filename}...`);
    try {
      await downloadAuthenticatedFile(item.download_url, token, item.filename);
      setStatusText("Descarga iniciada");
    } catch {
      setStatusText("No se pudo descargar el instalador");
    } finally {
      setDownloading("");
    }
  }

  if (!canManageDevices) {
    return (
      <AppShell title="Descargas" description="Instaladores oficiales del agente VYNTRA">
        <EmptyState>Tu rol no tiene permiso para descargar instaladores.</EmptyState>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Descargas"
      description="Instaladores oficiales para estaciones monitoreadas."
      actions={<RefreshButton loading={loading} onClick={loadDownloads} />}
    >
      <section className="settings-page downloads-page">
        <div className="stat-grid">
          <StatCard label="Instaladores" value={`${manualDownloads.length}`} detail="Disponibles para usuarios" />
          <StatCard label="Windows" value={`${windowsCount}`} detail="Listo para usuarios PC" tone={windowsCount ? "good" : "warn"} />
          <StatCard label="Actualizaciones" value={`${hiddenUpdatePackages}`} detail="Paquetes internos ocultos" tone={hiddenUpdatePackages ? "plain" : "warn"} />
        </div>

        <div className="downloads-layout">
          <Panel title="Archivos disponibles" meta={directoryReady ? "Carpeta activa" : "Carpeta no preparada"}>
            {!directoryReady ? (
              <div className="download-warning">
                <strong>Falta publicar la carpeta de descargas en el servidor.</strong>
                <p>Sube los instaladores a <code>/opt/vyntra/downloads</code> y reconstruye la API para activar el montaje.</p>
              </div>
            ) : null}

            <div className="download-list">
              {manualDownloads.map((item) => (
                <article className="download-card" key={item.filename}>
                  <div>
                    <span className={platformTone(item.platform)}>{item.platform}</span>
                    <h3>{item.filename}</h3>
                    <p>{formatSize(item.size_bytes)} · actualizado {formatDate(item.updated_at)}</p>
                  </div>
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => downloadFile(item)}
                    disabled={downloading === item.filename}
                  >
                    {downloading === item.filename ? "Descargando..." : "Descargar"}
                  </button>
                </article>
              ))}
            </div>

            {!manualDownloads.length ? <EmptyState>No hay instaladores para descargar.</EmptyState> : null}
          </Panel>

          <Panel title="Uso recomendado">
            <ol className="download-steps">
              <li>Descarga unicamente el instalador .exe de Windows desde esta vista.</li>
              <li>Instalalo por videollamada o soporte remoto con el usuario autorizado.</li>
              <li>El usuario inicia sesion, cambia clave si aplica y acepta consentimiento.</li>
              <li>Verifica el equipo en Dispositivos y las capturas en el perfil del empleado.</li>
            </ol>
            <div className="download-note">
              <strong>Piloto privado.</strong>
              <p>Los paquetes ZIP quedan reservados para actualizaciones internas del agente y no se muestran como instaladores manuales.</p>
            </div>
          </Panel>
        </div>

        <StatusLine>{statusText}</StatusLine>
      </section>
    </AppShell>
  );
}
