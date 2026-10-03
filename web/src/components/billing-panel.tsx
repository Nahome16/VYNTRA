"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { usePreferences } from "@/components/preferences-provider";
import { AttentionList, Chip, ConfirmDialog, Drawer, EmptyBlock } from "@/components/ui";
import { downloadAuthenticatedFile } from "@/lib/download-file";
import { BillingResponse, InvoicePreviewResponse, InvoiceRecord, InvoiceSendResponse, InvoiceStatus } from "@/lib/types";
import styles from "./billing-panel.module.css";

/*
 * Facturación de una empresa (Sistema → Plan y suscripción).
 * Flujo: elegir periodo → ajustar usuarios y destinatarios → revisar el correo → enviar.
 * Cada envío queda registrado con su periodo en el historial.
 */

function money(cents: number, currency = "USD") {
  const value = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${value}`;
}

function shortDate(iso: string, locale: string) {
  if (!iso) return "—";
  const date = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

function dateTime(iso: string | null, locale: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const statusTone: Record<InvoiceStatus, "good" | "warn" | "bad" | "plain"> = {
  sent: "good",
  partial: "warn",
  failed: "bad",
  not_configured: "warn",
};

const statusLabel: Record<InvoiceStatus, string> = {
  sent: "Enviada",
  partial: "Envío parcial",
  failed: "No se pudo enviar",
  not_configured: "Correo sin configurar",
};

type Preview = InvoicePreviewResponse & { source: "draft" | "history" };

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}

export function BillingPanel({ companyId, onSent }: { companyId: string; onSent?: () => void }) {
  const { apiGet, apiPost, token } = useAuth();
  const { t, language } = usePreferences();
  const locale = language === "en" ? "en-US" : "es";
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [activeUsers, setActiveUsers] = useState("");
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState<{ tone: "good" | "warn" | "bad"; text: string } | null>(null);

  const loadBilling = useCallback(async () => {
    setLoadError("");
    try {
      const response = await apiGet<BillingResponse>(`/api/system/companies/${companyId}/billing`);
      setBilling(response);
      setPeriodStart((current) => (current && response.periods.some((period) => period.start === current) ? current : response.default_period_start));
      setActiveUsers(String(response.active_users));
      setSelectedRecipients(response.recipients.map((recipient) => recipient.email));
    } catch {
      setLoadError(t("No se pudo cargar la facturación de esta empresa."));
    }
  }, [apiGet, companyId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBilling(null);
      setPreview(null);
      setNotice(null);
      void loadBilling();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadBilling]);

  const period = billing?.periods.find((row) => row.start === periodStart) || null;
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const unitPrice = billing?.settings.unit_price_cents ?? 0;
  const currency = billing?.settings.currency || "USD";
  const total = users * unitPrice;
  const alreadySent = Boolean(period?.invoice && (period.invoice.status === "sent" || period.invoice.status === "partial"));
  const pendingPeriod = useMemo(
    () => billing?.periods.find((row) => row.status === "closed" && !(row.invoice && (row.invoice.status === "sent" || row.invoice.status === "partial"))) || null,
    [billing],
  );
  const canSend = Boolean(billing && period && selectedRecipients.length && activeUsers !== "" && users >= 0);

  function requestBody() {
    return { period_start: periodStart, active_users: users, recipients: selectedRecipients };
  }

  async function openPreview() {
    if (!canSend) return;
    setPreviewLoading(true);
    setNotice(null);
    try {
      const response = await apiPost<InvoicePreviewResponse>(`/api/system/companies/${companyId}/invoices/preview`, requestBody());
      setPreview({ ...response, source: "draft" });
    } catch (error) {
      const detail = (error as { detail?: string }).detail;
      setNotice({ tone: "bad", text: detail || t("No se pudo generar la vista previa.") });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function openHistory(invoice: InvoiceRecord) {
    setNotice(null);
    try {
      const response = await apiGet<{ subject: string; html: string }>(`/api/system/invoices/${invoice.id}/html`);
      setPreview({
        source: "history",
        subject: response.subject,
        html: response.html,
        invoice,
        recipients: invoice.recipients.map((recipient) => ({ email: recipient.email, full_name: recipient.full_name })),
        already_sent: true,
      });
    } catch {
      setNotice({ tone: "bad", text: t("No se pudo abrir la factura.") });
    }
  }

  async function sendInvoice() {
    if (!canSend) return;
    setSending(true);
    try {
      const response = await apiPost<InvoiceSendResponse>(`/api/system/companies/${companyId}/invoices/send`, requestBody());
      const sent = response.delivery.filter((row) => row.status === "sent").length;
      const status = response.invoice.status;
      setNotice(
        status === "sent"
          ? { tone: "good", text: `${t("Factura")} ${response.invoice.number} ${t("enviada a")} ${sent} ${sent === 1 ? t("destinatario") : t("destinatarios")}.` }
          : status === "not_configured"
            ? { tone: "warn", text: t("La factura quedó registrada, pero el servidor no tiene el correo (SMTP) configurado. No se envió.") }
            : status === "partial"
              ? { tone: "warn", text: `${t("Envío parcial")}: ${sent} ${t("de")} ${response.delivery.length} ${t("correos enviados")}.` }
              : { tone: "bad", text: t("No se pudo enviar la factura. Revisa la configuración del correo e inténtalo de nuevo.") },
      );
      setConfirmOpen(false);
      setPreview(null);
      await loadBilling();
      onSent?.();
    } catch (error) {
      const detail = (error as { detail?: string }).detail;
      setNotice({ tone: "bad", text: detail || t("No se pudo enviar la factura.") });
      setConfirmOpen(false);
    } finally {
      setSending(false);
    }
  }

  async function downloadPdf(invoice?: { id?: string; number: string }) {
    setDownloading(true);
    try {
      if (invoice?.id) {
        await downloadAuthenticatedFile(`/api/system/invoices/${invoice.id}/pdf`, token, `Factura-${invoice.number}.pdf`);
      } else {
        await downloadAuthenticatedFile(`/api/system/companies/${companyId}/invoices/pdf`, token, "Factura.pdf", {
          method: "POST",
          body: requestBody(),
        });
      }
    } catch {
      setNotice({ tone: "bad", text: t("No se pudo descargar el PDF de la factura.") });
    } finally {
      setDownloading(false);
    }
  }

  function toggleRecipient(email: string) {
    setSelectedRecipients((current) => (current.includes(email) ? current.filter((value) => value !== email) : [...current, email]));
  }

  if (loadError) {
    return (
      <section className={styles.billing}>
        <EmptyBlock
          title={loadError}
          action={
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void loadBilling()}>
              {t("Reintentar")}
            </button>
          }
        />
      </section>
    );
  }

  if (!billing) {
    return (
      <section className={styles.billing}>
        <p className={styles.muted}>{t("Cargando facturación...")}</p>
      </section>
    );
  }

  return (
    <section className={styles.billing} aria-labelledby="billing-title">
      <header className={styles.head}>
        <div>
          <h3 id="billing-title">{t("Facturación")}</h3>
          <p>
            {money(unitPrice, currency)} {t("por usuario monitoreado activo")} · {t("sin IVA")} · {t("vence a los")} {billing.settings.due_business_days}{" "}
            {t("días hábiles")}
          </p>
        </div>
      </header>

      <AttentionList
        label={t("Recordatorio de facturación")}
        items={[
          ...(pendingPeriod
            ? [
                {
                  key: "pending",
                  tone: "warn" as const,
                  title: `${t("Factura pendiente de envío")}: ${pendingPeriod.label}`,
                  detail: t("El periodo ya cerró y aún no se ha enviado la factura a la empresa."),
                  selectable: pendingPeriod.start !== periodStart,
                  action: pendingPeriod.start !== periodStart ? t("Seleccionar periodo") : undefined,
                },
              ]
            : []),
          ...(!billing.settings.payment_configured
            ? [
                {
                  key: "bank",
                  tone: "info" as const,
                  title: t("Faltan los datos bancarios en el servidor"),
                  detail: t("La factura dirá que los datos de pago se enviarán por separado. Configura BILLING_BANK_* en .env.production."),
                },
              ]
            : []),
        ]}
        onSelect={(key) => {
          if (key === "pending" && pendingPeriod) setPeriodStart(pendingPeriod.start);
        }}
      />

      {notice ? (
        <p className={`${styles.notice} ${styles[notice.tone]}`} role={notice.tone === "bad" ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}

      <div className={styles.composer}>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span>{t("Periodo de facturación")}</span>
            <select value={periodStart} onChange={(event) => setPeriodStart(event.target.value)}>
              {billing.periods.map((row) => (
                <option key={row.start} value={row.start}>
                  {row.label}
                  {row.status === "open" ? ` · ${t("en curso")}` : ""}
                  {row.invoice && (row.invoice.status === "sent" || row.invoice.status === "partial") ? ` · ${t("enviada")} (${row.invoice.number})` : ""}
                </option>
              ))}
            </select>
            {period?.status === "open" ? <small className={styles.hintWarn}>{t("Este periodo aún no termina; normalmente se factura el día siguiente al cierre.")}</small> : null}
            {alreadySent && period?.invoice ? (
              <small className={styles.hint}>
                {t("Ya se envió la factura")} {period.invoice.number} {t("el")} {dateTime(period.invoice.sent_at, locale)}. {t("Puedes reenviarla.")}
              </small>
            ) : null}
          </label>

          <label className={styles.field}>
            <span>{t("Usuarios activos")}</span>
            <input type="number" min={0} max={100000} value={activeUsers} onChange={(event) => setActiveUsers(event.target.value)} />
            <small className={styles.hint}>
              {t("Hoy hay")} {billing.active_users} {billing.active_users === 1 ? t("empleado activo") : t("empleados activos")}.
            </small>
          </label>
        </div>

        <div className={styles.totalBox} aria-live="polite">
          <span>{t("Total a facturar")}</span>
          <strong>{money(total, currency)}</strong>
          <small>
            {users} × {money(unitPrice, currency)} · {t("IVA")} {money(0, currency)}
          </small>
        </div>
      </div>

      <fieldset className={styles.recipients}>
        <legend>{t("Destinatarios")}</legend>
        {billing.recipients.length ? (
          billing.recipients.map((recipient) => (
            <label key={recipient.id} className={styles.recipient}>
              <input type="checkbox" checked={selectedRecipients.includes(recipient.email)} onChange={() => toggleRecipient(recipient.email)} />
              <span>
                <strong>{recipient.full_name}</strong>
                <small>
                  {recipient.email} · {recipient.role === "owner" ? t("Propietario") : t("Administrador")}
                </small>
              </span>
            </label>
          ))
        ) : (
          <p className={styles.hintWarn}>{t("Esta empresa no tiene administradores activos que puedan recibir la factura.")}</p>
        )}
      </fieldset>

      <div className={styles.actions}>
        <button type="button" className="btn btn-ghost" onClick={() => void downloadPdf()} disabled={!canSend || downloading}>
          <DownloadIcon />
          {downloading ? t("Descargando...") : t("Descargar PDF")}
        </button>
        <button type="button" className="btn btn-outline" onClick={() => void openPreview()} disabled={!canSend || previewLoading}>
          {previewLoading ? t("Generando...") : t("Revisar factura")}
        </button>
        <button type="button" className="btn" onClick={() => setConfirmOpen(true)} disabled={!canSend || sending}>
          {alreadySent ? t("Reenviar factura") : t("Enviar factura")}
        </button>
      </div>

      <div className={styles.history}>
        <h4>{t("Facturas enviadas")}</h4>
        {billing.invoices.length ? (
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>{t("Factura")}</th>
                  <th>{t("Periodo")}</th>
                  <th className="num">{t("Usuarios")}</th>
                  <th className="num">{t("Total")}</th>
                  <th>{t("Enviada")}</th>
                  <th>{t("Estado")}</th>
                  <th aria-label={t("Acciones")} />
                </tr>
              </thead>
              <tbody>
                {billing.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <strong className={styles.mono}>{invoice.number}</strong>
                      <small>
                        {t("Vence")} {shortDate(invoice.due_on, locale)}
                      </small>
                    </td>
                    <td>{invoice.period_label}</td>
                    <td className="num">{invoice.active_users}</td>
                    <td className="num">{money(invoice.total_cents, invoice.currency)}</td>
                    <td>
                      {dateTime(invoice.sent_at, locale)}
                      <small>
                        {invoice.recipients.length} {invoice.recipients.length === 1 ? t("destinatario") : t("destinatarios")}
                        {invoice.send_count > 1 ? ` · ${invoice.send_count} ${t("envíos")}` : ""}
                      </small>
                    </td>
                    <td>
                      <Chip tone={statusTone[invoice.status]}>{t(statusLabel[invoice.status])}</Chip>
                    </td>
                    <td className={styles.rowAction}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openHistory(invoice)}>
                        {t("Ver")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void downloadPdf(invoice)}
                        disabled={downloading}
                        aria-label={`${t("Descargar PDF")} ${invoice.number}`}
                        title={t("Descargar PDF")}
                      >
                        <DownloadIcon />
                        PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.muted}>{t("Todavía no se ha enviado ninguna factura a esta empresa.")}</p>
        )}
      </div>

      <Drawer
        open={Boolean(preview)}
        wide
        onClose={() => setPreview(null)}
        title={preview?.source === "history" ? `${t("Factura")} ${preview.invoice.number}` : t("Revisar factura")}
        description={preview?.subject}
        footer={
          preview?.source === "draft" ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => void downloadPdf()} disabled={downloading}>
                <DownloadIcon />
                {t("Descargar PDF")}
              </button>
              <button type="button" className="btn btn-outline" onClick={() => setPreview(null)}>
                {t("Volver")}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmOpen(true)} disabled={sending}>
                {preview.already_sent ? t("Reenviar factura") : t("Enviar factura")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => preview && "id" in preview.invoice && void downloadPdf(preview.invoice as InvoiceRecord)}
                disabled={downloading}
              >
                <DownloadIcon />
                {t("Descargar PDF")}
              </button>
              <button type="button" className="btn" onClick={() => setPreview(null)}>
                {t("Cerrar")}
              </button>
            </>
          )
        }
      >
        {preview ? (
          <div className={styles.preview}>
            <dl className={styles.previewFacts}>
              <div>
                <dt>{t("Para")}</dt>
                <dd>{preview.recipients.map((recipient) => recipient.email).join(", ")}</dd>
              </div>
              <div>
                <dt>{t("Periodo")}</dt>
                <dd>{preview.invoice.period_label}</dd>
              </div>
              <div>
                <dt>{t("Total")}</dt>
                <dd>{money(preview.invoice.total_cents, preview.invoice.currency)}</dd>
              </div>
              <div>
                <dt>{t("Vence")}</dt>
                <dd>{shortDate(preview.invoice.due_on, locale)}</dd>
              </div>
            </dl>
            <iframe className={styles.frame} title={t("Vista previa del correo")} srcDoc={preview.html} sandbox="" />
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        danger={false}
        busy={sending}
        title={alreadySent ? t("¿Reenviar la factura?") : t("¿Enviar la factura?")}
        description={
          <p>
            {t("Se enviará la factura del periodo")} <strong>{period?.label}</strong> {t("por")} <strong>{money(total, currency)}</strong> {t("a")}{" "}
            {selectedRecipients.join(", ")}.
          </p>
        }
        confirmLabel={sending ? t("Enviando...") : alreadySent ? t("Reenviar") : t("Enviar")}
        onConfirm={() => void sendInvoice()}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
