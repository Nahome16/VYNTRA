"""
mailer.py - Envio de correo saliente para activacion y recuperacion de acceso.

El envio nunca interrumpe la peticion: si el SMTP falla, la operacion de
negocio ya quedo confirmada y el fallo se registra para reintento manual.
"""

from __future__ import annotations

from email.message import EmailMessage
from email.utils import formataddr, make_msgid
import logging
import smtplib
import ssl

from app.config import settings

logger = logging.getLogger("vyntra.mailer")

# Estados posibles de entrega, usados tambien en la auditoria.
SENT = "sent"
FAILED = "failed"
NOT_CONFIGURED = "not_configured"


def _build_message(to_email: str, subject: str, text_body: str, html_body: str) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr((settings.mail_from_name, settings.effective_mail_from))
    message["To"] = to_email
    message["Message-ID"] = make_msgid(domain="vyntra.local")
    if settings.mail_reply_to:
        message["Reply-To"] = settings.mail_reply_to
    # Cabeceras que evitan respuestas automaticas a un correo transaccional.
    message["Auto-Submitted"] = "auto-generated"
    message["X-Auto-Response-Suppress"] = "All"
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")
    return message


def send_email(to_email: str, subject: str, text_body: str, html_body: str) -> str:
    """Devuelve SENT, FAILED o NOT_CONFIGURED. Nunca lanza excepcion."""
    if not to_email:
        return FAILED
    if not settings.smtp_configured:
        logger.warning("SMTP no configurado; no se envio el correo a %s", to_email)
        return NOT_CONFIGURED

    message = _build_message(to_email, subject, text_body, html_body)
    context = ssl.create_default_context()
    try:
        if settings.smtp_ssl:
            with smtplib.SMTP_SSL(
                settings.smtp_host,
                settings.smtp_port,
                timeout=settings.smtp_timeout_seconds,
                context=context,
            ) as server:
                if settings.smtp_user:
                    server.login(settings.smtp_user, settings.smtp_password)
                server.send_message(message)
        else:
            with smtplib.SMTP(
                settings.smtp_host,
                settings.smtp_port,
                timeout=settings.smtp_timeout_seconds,
            ) as server:
                server.ehlo()
                if settings.smtp_starttls:
                    server.starttls(context=context)
                    server.ehlo()
                if settings.smtp_user:
                    server.login(settings.smtp_user, settings.smtp_password)
                server.send_message(message)
        logger.info("Correo enviado a %s (%s)", to_email, subject)
        return SENT
    except Exception:
        logger.exception("Fallo el envio de correo a %s", to_email)
        return FAILED


# ---------------------------------------------------------------- plantillas

_STYLE = (
    "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;"
    "color:#0e1726;line-height:1.55;"
)
_CODE_STYLE = (
    "display:inline-block;font-family:Consolas,Menlo,monospace;font-size:26px;"
    "letter-spacing:5px;font-weight:700;color:#16307f;background:#ecf1fe;"
    "border:1px solid #dbe5fd;border-radius:10px;padding:14px 22px;margin:18px 0;"
)


def _wrap(title: str, intro: str, code: str, steps: list[str], footer: str) -> tuple[str, str]:
    steps_text = "\n".join(f"  {i}. {s}" for i, s in enumerate(steps, 1))
    text = (
        f"{title}\n\n{intro}\n\n"
        f"    {code}\n\n"
        f"Pasos:\n{steps_text}\n\n{footer}\n"
    )
    steps_html = "".join(f"<li style='margin-bottom:6px'>{s}</li>" for s in steps)
    html = (
        f"<div style=\"{_STYLE}max-width:520px;margin:0 auto;padding:8px\">"
        f"<h2 style='margin:0 0 6px;font-size:20px'>{title}</h2>"
        f"<p style='margin:0 0 4px;color:#33415a'>{intro}</p>"
        f"<div style=\"text-align:center\"><span style=\"{_CODE_STYLE}\">{code}</span></div>"
        f"<ol style='padding-left:20px;color:#33415a'>{steps_html}</ol>"
        f"<p style='margin-top:20px;font-size:12.5px;color:#64748b'>{footer}</p>"
        f"</div>"
    )
    return text, html


def send_activation_email(
    to_email: str, full_name: str, company: str, code: str, hours: int
) -> str:
    title = "Activa tu acceso a VYNTRA"
    intro = (
        f"Hola {full_name or ''}, {company} habilito tu estacion de marcaje. "
        f"Este es tu codigo de activacion, valido por {hours} horas y de un solo uso."
    )
    steps = [
        "Abre la aplicacion VYNTRA en tu computadora de trabajo.",
        "Pulsa <strong>Activar cuenta</strong>.",
        "Escribe tu correo y este codigo.",
        "Define tu contrasena personal. Solo tu la conoceras.",
    ]
    footer = (
        "Nadie de tu empresa conoce ni puede ver tu contrasena. "
        "Si no esperabas este mensaje, ignoralo y avisa a tu supervisor."
    )
    text, html = _wrap(title, intro, code, steps, footer)
    return send_email(to_email, title, text, html)


def send_reset_email(to_email: str, full_name: str, company: str, code: str, hours: int) -> str:
    title = "Restablece tu contrasena de VYNTRA"
    intro = (
        f"Hola {full_name or ''}, se solicito restablecer el acceso de tu estacion en {company}. "
        f"Este codigo es valido por {hours} horas y de un solo uso."
    )
    steps = [
        "Abre la aplicacion VYNTRA en tu computadora de trabajo.",
        "Pulsa <strong>Olvide mi contrasena</strong>.",
        "Escribe tu correo y este codigo.",
        "Define tu nueva contrasena.",
    ]
    footer = (
        "Si no solicitaste este cambio, ignora el mensaje: tu contrasena actual sigue vigente. "
        "El codigo caduca solo."
    )
    text, html = _wrap(title, intro, code, steps, footer)
    return send_email(to_email, title, text, html)


def send_password_changed_email(to_email: str, full_name: str, company: str, when: str) -> str:
    """Aviso posterior al cambio: permite detectar un acceso indebido."""
    title = "Tu contrasena de VYNTRA fue cambiada"
    intro = (
        f"Hola {full_name or ''}, la contrasena de tu estacion en {company} se cambio el {when}."
    )
    text = (
        f"{title}\n\n{intro}\n\n"
        "Si fuiste tu, no tienes que hacer nada.\n"
        "Si no reconoces este cambio, avisa de inmediato a tu supervisor.\n"
    )
    html = (
        f"<div style=\"{_STYLE}max-width:520px;margin:0 auto;padding:8px\">"
        f"<h2 style='margin:0 0 6px;font-size:20px'>{title}</h2>"
        f"<p style='color:#33415a'>{intro}</p>"
        f"<p style='color:#33415a'>Si fuiste tu, no tienes que hacer nada.</p>"
        f"<p style='color:#c62741;font-weight:600'>Si no reconoces este cambio, "
        f"avisa de inmediato a tu supervisor.</p></div>"
    )
    return send_email(to_email, title, text, html)
