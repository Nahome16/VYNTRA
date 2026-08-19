"""
agent.py - VYNTRA agente de marcaje y monitoreo consentido.

Flujo:
  1. Si no hay consentimiento, se muestra la pantalla de autorizacion.
  2. Si el usuario rechaza, no se activa el monitoreo.
  3. Si acepta, se abre la estacion de marcaje visible.
  4. La estacion controla jornada, break, lunch, capturas e incidencias.
"""

import datetime
import getpass
import hashlib
import json
import os
import socket
import sys
import tkinter as tk

import customtkinter as ctk

from agent_event_uploader import AgentEventUploader
import local_auth
from config import Config
from outbox import append_event, count_pending
from rules_downloader import RulesDownloader
from screenshots import ScreenshotEngine
from shift import ShiftManager, fmt_hms


VERSION = "1.1.0"  # subio de 1.0.0: se reescribio el aviso de consentimiento


# ==========================================================================
# Paleta VYNTRA - Blanco y Azul (minimalista / profesional)
# ==========================================================================
APP_BG = "#F4F7FC"          # Fondo general de la app
SURFACE = "#FFFFFF"         # Tarjetas y paneles
SURFACE_ALT = "#F0F5FC"     # Relleno secundario (metricas, inputs, chips)
BORDER = "#E2E8F3"          # Bordes suaves
BORDER_STRONG = "#CBD8EA"   # Bordes con mas contraste

PRIMARY = "#2563EB"         # Azul principal (marca, botones, acentos)
PRIMARY_DARK = "#1D4ED8"    # Hover / enfasis
PRIMARY_DEEP = "#1E3A8A"    # Barra superior / marca
PRIMARY_LIGHT = "#EFF6FF"   # Fondo azul claro (chips, hover suave)
PRIMARY_LIGHT2 = "#DBEAFE"  # Fondo azul claro, un poco mas intenso

TEXT_DARK = "#0F172A"       # Titulos
TEXT_BODY = "#334155"       # Texto de cuerpo
TEXT_MUTED = "#64748B"      # Texto secundario / etiquetas
TEXT_FAINT = "#94A3B8"      # Texto deshabilitado / placeholders
TEXT_ON_PRIMARY = "#FFFFFF"

SUCCESS = "#16A34A"
SUCCESS_BG = "#DCFCE7"
WARNING = "#D97706"
WARNING_BG = "#FEF3C7"
DANGER = "#DC2626"
DANGER_BG = "#FEE2E2"
NEUTRAL_BG = "#EEF2F8"
NEUTRAL_TEXT = "#94A3B8"

CONSENT_BG = APP_BG
CONSENT_PANEL = SURFACE
CONSENT_TEXT = TEXT_DARK
CONSENT_MUTED = TEXT_MUTED

# texto, color de texto del chip, color de fondo del chip
ESTADO_INFO = {
    "FUERA": ("Fuera de jornada", NEUTRAL_TEXT, NEUTRAL_BG),
    "TRABAJANDO": ("Jornada activa", SUCCESS, SUCCESS_BG),
    "BREAK": ("En break", WARNING, WARNING_BG),
    "LUNCH": ("En almuerzo", WARNING, WARNING_BG),
    "TERMINADO": ("Jornada finalizada", TEXT_MUTED, NEUTRAL_BG),
}


# ==========================================================================
# Verificacion de usuario (login)
# ==========================================================================
class LoginWindow(ctk.CTk):
    """
    Primer paso al abrir VYNTRA: pide correo y contrasena para verificar
    quien esta operando el equipo. El agente de escritorio NO crea ni
    administra usuarios (eso se hara desde la plataforma web mas adelante);
    aqui solo se VERIFICAN credenciales. Mientras esa integracion no exista,
    se valida contra un usuario de pruebas fijo (ver local_auth.py). Esto es
    independiente del aviso de privacidad (que se muestra despues) y de la
    sincronizacion con el backend.
    """

    def __init__(self, cfg: Config):
        super().__init__()
        self.cfg = cfg
        self.decision = None  # True si quedo autenticado, False si cancelo/salio
        self.authenticated_email = ""

        self.title("VYNTRA - Verificacion de usuario")
        self.geometry("500x620")
        self.minsize(480, 600)
        self.configure(fg_color=APP_BG)
        self.resizable(True, True)

        self._build()

    def _build(self):
        body = ctk.CTkFrame(self, fg_color=SURFACE, corner_radius=12,
                            border_width=1, border_color=BORDER)
        body.pack(fill="both", expand=True, padx=28, pady=28)
        cont = ctk.CTkFrame(body, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=28, pady=28)

        brand = ctk.CTkFrame(cont, fg_color="transparent")
        brand.pack(fill="x", pady=(0, 24))
        ctk.CTkLabel(
            brand,
            text="V",
            font=ctk.CTkFont(size=19, weight="bold"),
            text_color="#FFFFFF",
            fg_color=PRIMARY_DEEP,
            corner_radius=10,
            width=46,
            height=46,
        ).pack(side="left")
        brand_copy = ctk.CTkFrame(brand, fg_color="transparent")
        brand_copy.pack(side="left", fill="x", expand=True, padx=(12, 0))
        ctk.CTkLabel(
            brand_copy,
            text="VYNTRA",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            brand_copy,
            text="Estacion de marcaje laboral",
            font=ctk.CTkFont(size=11),
            text_color=TEXT_MUTED,
        ).pack(anchor="w", pady=(2, 0))

        ctk.CTkLabel(cont, text="Inicia sesion",
                    font=ctk.CTkFont(size=19, weight="bold"),
                    text_color=TEXT_DARK).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text="Verifica tu identidad para continuar con tu jornada en este equipo.",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=380,
            justify="left",
        ).pack(anchor="w", pady=(6, 18))

        self.entry_correo = self._campo(cont, "Correo electronico", "tu.correo@empresa.com")
        self.entry_pass = self._campo(cont, "Contrasena", "Tu contrasena", show="*")

        ctk.CTkButton(
            cont,
            text="¿Olvidaste tu contrasena?",
            command=self._modal_recuperar_password,
            fg_color="transparent",
            hover_color=PRIMARY_LIGHT,
            text_color=PRIMARY,
            height=28,
            corner_radius=6,
            font=ctk.CTkFont(size=12, weight="bold"),
        ).pack(anchor="e", pady=(6, 0))

        self.error_lbl = ctk.CTkLabel(cont, text="", font=ctk.CTkFont(size=12),
                                      text_color=DANGER, wraplength=380, justify="left")
        self.error_lbl.pack(anchor="w", pady=(4, 0))

        ctk.CTkButton(
            cont, text="Iniciar sesion", command=self._iniciar_sesion,
            fg_color=PRIMARY, hover_color=PRIMARY_DARK, text_color="#FFFFFF",
            height=44, corner_radius=8, font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", pady=(16, 8))

        ctk.CTkButton(
            cont, text="Salir", command=self._salir,
            fg_color=SURFACE, hover_color=APP_BG, text_color=TEXT_BODY,
            border_width=1, border_color=BORDER_STRONG,
            height=40, corner_radius=8,
        ).pack(fill="x")

        ctk.CTkLabel(
            cont,
            text=f"¿Problemas para entrar? Contacta a {self.cfg.correo_contacto}",
            font=ctk.CTkFont(size=11),
            text_color=TEXT_FAINT,
        ).pack(anchor="w", pady=(14, 0))

    def _campo(self, parent, etiqueta, placeholder, show=None):
        ctk.CTkLabel(parent, text=etiqueta, font=ctk.CTkFont(size=12, weight="bold"),
                    text_color=TEXT_BODY).pack(anchor="w", pady=(10, 4))
        entry = ctk.CTkEntry(
            parent, placeholder_text=placeholder, show=show,
            fg_color=SURFACE_ALT, border_color=BORDER_STRONG, text_color=TEXT_DARK,
            height=38,
        )
        entry.pack(fill="x")
        return entry

    def _toggle_password_entries(self, entries, visible: bool):
        show = "" if visible else "*"
        for entry in entries:
            entry.configure(show=show)

    def _password_visibility_control(self, parent, entries):
        row = ctk.CTkFrame(
            parent,
            fg_color=PRIMARY_LIGHT,
            corner_radius=8,
            border_width=1,
            border_color=PRIMARY_LIGHT2,
        )
        row.pack(fill="x", pady=(10, 8))

        copy = ctk.CTkFrame(row, fg_color="transparent")
        copy.pack(side="left", fill="x", expand=True, padx=14, pady=12)
        ctk.CTkLabel(
            copy,
            text="Mostrar contrasenas",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            copy,
            text="Activalo solo si necesitas revisar lo que estas escribiendo.",
            font=ctk.CTkFont(size=11),
            text_color=TEXT_MUTED,
            wraplength=300,
            justify="left",
        ).pack(anchor="w", pady=(2, 0))

        visible_var = tk.BooleanVar(value=False)
        action = ctk.CTkButton(
            row,
            text="Mostrar",
            width=110,
            height=38,
            corner_radius=8,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            text_color="#FFFFFF",
            font=ctk.CTkFont(size=12, weight="bold"),
        )
        action.pack(side="right", padx=14, pady=12)

        def toggle():
            visible_var.set(not visible_var.get())
            visible = visible_var.get()
            self._toggle_password_entries(entries, visible)
            action.configure(
                text="Ocultar" if visible else "Mostrar",
                fg_color=SUCCESS if visible else PRIMARY,
                hover_color="#15803D" if visible else PRIMARY_DARK,
            )

        action.configure(command=toggle)
        return visible_var

    def _iniciar_sesion(self):
        correo = self.entry_correo.get().strip()
        pw = self.entry_pass.get()
        if not correo or not pw:
            self.error_lbl.configure(text="Ingresa tu correo y tu contrasena.", text_color=DANGER)
            return
        auth_result = local_auth.autenticar_credenciales(correo, pw, self.cfg, VERSION)
        if auth_result.get("ok"):
            self.authenticated_email = correo.lower()
            payload = auth_result.get("payload") or {}
            credential = payload.get("credential") or {}
            if credential.get("password_change_required"):
                self._modal_cambiar_password_obligatorio(correo, pw)
                return
            if auth_result.get("source") != "backend":
                append_event(
                    "station_login",
                    {
                        "email": self.authenticated_email,
                        "success": True,
                        "occurred_at": datetime.datetime.now().isoformat(),
                        "agent_version": VERSION,
                        "auth_source": auth_result.get("source", "local"),
                    },
                )
            self.decision = True
            self.destroy()
        else:
            reason = auth_result.get("reason") or "invalid_credentials"
            if auth_result.get("source") != "backend":
                append_event(
                    "station_login",
                    {
                        "email": correo.lower(),
                        "success": False,
                        "failure_reason": reason,
                        "occurred_at": datetime.datetime.now().isoformat(),
                        "agent_version": VERSION,
                        "auth_source": auth_result.get("source", "local"),
                    },
                )
            if reason == "backend_unavailable":
                self.error_lbl.configure(
                    text="No se pudo conectar con el servidor de VYNTRA. Intenta de nuevo.",
                    text_color=DANGER,
                )
            else:
                self.error_lbl.configure(text="Correo o contrasena incorrectos.", text_color=DANGER)

    def _finish_authenticated_session(self):
        self.decision = True
        self.destroy()

    def _password_policy_text(self):
        return "Usa 8 caracteres o mas, mayusculas, minusculas, numeros y un signo."

    def _password_checks(self, password: str, confirmation: str):
        signs = "!@#$%*?_-."
        return [
            ("8 caracteres o mas", len(password) >= 8),
            ("Una letra mayuscula", any(char.isupper() for char in password)),
            ("Una letra minuscula", any(char.islower() for char in password)),
            ("Un numero", any(char.isdigit() for char in password)),
            (f"Un signo: {signs}", any(char in signs for char in password)),
            ("Ambas contrasenas coinciden", bool(password) and password == confirmation),
        ]

    def _password_is_valid(self, password: str, confirmation: str) -> bool:
        return all(done for _, done in self._password_checks(password, confirmation))

    def _password_checklist(self, parent, password_entry, confirmation_entry, save_button_ref):
        box = ctk.CTkFrame(
            parent,
            fg_color=SURFACE,
            corner_radius=8,
            border_width=1,
            border_color=BORDER,
        )
        box.pack(fill="x", pady=(10, 4))
        ctk.CTkLabel(
            box,
            text="Requisitos de seguridad",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w", padx=12, pady=(10, 4))

        labels = []
        for text, _ in self._password_checks("", ""):
            item = ctk.CTkFrame(box, fg_color="transparent")
            item.pack(fill="x", padx=12, pady=1)
            badge = ctk.CTkLabel(
                item,
                text="Pendiente",
                font=ctk.CTkFont(size=10, weight="bold"),
                text_color=TEXT_MUTED,
                fg_color=SURFACE_ALT,
                corner_radius=999,
                width=72,
                height=20,
            )
            badge.pack(side="left", padx=(0, 8))
            label = ctk.CTkLabel(
                item,
                text=text,
                font=ctk.CTkFont(size=12),
                text_color=TEXT_MUTED,
                anchor="w",
            )
            label.pack(side="left", fill="x", expand=True)
            labels.append((badge, label))

        def refresh(_event=None):
            password = password_entry.get()
            confirmation = confirmation_entry.get()
            checks = self._password_checks(password, confirmation)
            for (badge, label), (text, done) in zip(labels, checks):
                badge.configure(
                    text="OK" if done else "Pendiente",
                    fg_color=SUCCESS_BG if done else SURFACE_ALT,
                    text_color=SUCCESS if done else TEXT_MUTED,
                )
                label.configure(
                    text=text,
                    text_color=SUCCESS if done else TEXT_MUTED,
                    font=ctk.CTkFont(size=12, weight="bold" if done else "normal"),
                )
            button = save_button_ref.get("button")
            if button:
                can_save = all(done for _, done in checks)
                button.configure(
                    state="normal" if can_save else "disabled",
                    fg_color=PRIMARY if can_save else BORDER_STRONG,
                    hover_color=PRIMARY_DARK if can_save else BORDER_STRONG,
                    text_color="#FFFFFF",
                )
            return all(done for _, done in checks)

        password_entry.bind("<KeyRelease>", refresh)
        confirmation_entry.bind("<KeyRelease>", refresh)
        refresh()
        return refresh

    def _modal_base_login(self, title: str, width: int = 460, height: int = 420):
        top = ctk.CTkToplevel(self)
        top.title(title)
        top.minsize(min(width, 520), min(height, 520))
        top.resizable(True, True)
        top.configure(fg_color=APP_BG)
        top.transient(self)
        top.grab_set()
        self.update_idletasks()
        screen_w = top.winfo_screenwidth()
        screen_h = top.winfo_screenheight()
        parent_x = self.winfo_rootx()
        parent_y = self.winfo_rooty()
        parent_w = max(self.winfo_width(), 1)
        parent_h = max(self.winfo_height(), 1)
        x = parent_x + max(0, (parent_w - width) // 2)
        y = parent_y + max(0, (parent_h - height) // 2)
        x = max(20, min(x, screen_w - width - 20))
        y = max(20, min(y, screen_h - height - 60))
        top.geometry(f"{width}x{height}+{x}+{y}")
        return top

    def _modal_cambiar_password_obligatorio(self, correo: str, actual: str):
        top = self._modal_base_login("Cambiar contrasena temporal", 520, 640)
        cont = ctk.CTkFrame(top, fg_color=SURFACE, corner_radius=12, border_width=1, border_color=BORDER)
        cont.pack(fill="both", expand=True, padx=22, pady=22)
        footer = ctk.CTkFrame(cont, fg_color="transparent")
        footer.pack(side="bottom", fill="x", padx=22, pady=(0, 20))
        inner = ctk.CTkScrollableFrame(cont, fg_color="transparent")
        inner.pack(side="top", fill="both", expand=True, padx=22, pady=(20, 10))

        ctk.CTkLabel(
            inner,
            text="Cambia tu contrasena",
            font=ctk.CTkFont(size=18, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            inner,
            text=f"Tu contrasena actual es temporal. {self._password_policy_text()}",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=380,
            justify="left",
        ).pack(anchor="w", pady=(6, 14))

        nueva = self._campo(inner, "Nueva contrasena", "Nueva contrasena", show="*")
        confirmar = self._campo(inner, "Confirmar contrasena", "Repite la contrasena", show="*")

        self._password_visibility_control(inner, [nueva, confirmar])
        save_ref = {"button": None}
        refresh_checks = self._password_checklist(inner, nueva, confirmar, save_ref)

        error = ctk.CTkLabel(inner, text="", font=ctk.CTkFont(size=12), text_color=DANGER, wraplength=380, justify="left")
        error.pack(anchor="w", pady=(8, 0))

        def guardar():
            error.configure(text="", text_color=DANGER)
            if not refresh_checks():
                error.configure(text="Completa todos los requisitos antes de guardar.")
                return
            if nueva.get() != confirmar.get():
                error.configure(text="Las contrasenas no coinciden.")
                return
            result = local_auth.cambiar_password(correo, actual, nueva.get(), self.cfg)
            if result.get("ok"):
                top.destroy()
                self._finish_authenticated_session()
            else:
                error.configure(text=result.get("message") or "No se pudo cambiar la contrasena.")

        save_button = ctk.CTkButton(
            footer,
            text="Guardar cambios",
            command=guardar,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            text_color="#FFFFFF",
            height=44,
            corner_radius=8,
            font=ctk.CTkFont(size=13, weight="bold"),
        )
        save_button.pack(fill="x")
        save_ref["button"] = save_button
        refresh_checks()

    def _modal_recuperar_password(self):
        top = self._modal_base_login("Recuperar contrasena", 560, 680)
        cont = ctk.CTkFrame(top, fg_color=SURFACE, corner_radius=12, border_width=1, border_color=BORDER)
        cont.pack(fill="both", expand=True, padx=22, pady=22)
        footer = ctk.CTkFrame(cont, fg_color="transparent")
        footer.pack(side="bottom", fill="x", padx=22, pady=(0, 20))
        inner = ctk.CTkScrollableFrame(cont, fg_color="transparent")
        inner.pack(side="top", fill="both", expand=True, padx=22, pady=(20, 10))

        ctk.CTkLabel(
            inner,
            text="Recuperar contrasena",
            font=ctk.CTkFont(size=18, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            inner,
            text="Solicita un codigo de verificacion y luego define una nueva contrasena.",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=390,
            justify="left",
        ).pack(anchor="w", pady=(6, 14))

        request_box = ctk.CTkFrame(inner, fg_color=PRIMARY_LIGHT, corner_radius=8, border_width=1, border_color=BORDER)
        request_box.pack(fill="x", pady=(0, 12))
        request_inner = ctk.CTkFrame(request_box, fg_color="transparent")
        request_inner.pack(fill="x", padx=14, pady=12)
        ctk.CTkLabel(
            request_inner,
            text="1. Verifica tu correo",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        correo = self._campo(request_inner, "Correo electronico", "tu.correo@empresa.com")
        correo.insert(0, self.entry_correo.get().strip())

        reset_box = ctk.CTkFrame(inner, fg_color=PRIMARY_LIGHT, corner_radius=8, border_width=1, border_color=BORDER)
        reset_box.pack(fill="x")
        reset_inner = ctk.CTkFrame(reset_box, fg_color="transparent")
        reset_inner.pack(fill="x", padx=14, pady=12)
        ctk.CTkLabel(
            reset_inner,
            text="2. Define una nueva contrasena",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        codigo = self._campo(reset_inner, "Codigo de verificacion", "Codigo recibido")
        nueva = self._campo(reset_inner, "Nueva contrasena", "Nueva contrasena", show="*")
        confirmar = self._campo(reset_inner, "Confirmar contrasena", "Repite la contrasena", show="*")

        self._password_visibility_control(reset_inner, [nueva, confirmar])
        save_ref = {"button": None}
        refresh_checks = self._password_checklist(reset_inner, nueva, confirmar, save_ref)

        status = ctk.CTkLabel(
            inner,
            text=self._password_policy_text(),
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=430,
            justify="left",
        )
        status.pack(anchor="w", pady=(10, 0))

        def solicitar():
            if not correo.get().strip():
                status.configure(text="Ingresa tu correo.", text_color=DANGER)
                return
            result = local_auth.solicitar_recuperacion_password(correo.get(), self.cfg)
            if result.get("ok"):
                testing_code = result.get("reset_code")
                if testing_code:
                    codigo.delete(0, "end")
                    codigo.insert(0, testing_code)
                    status.configure(
                        text=f"Codigo generado para prueba local: {testing_code}",
                        text_color=SUCCESS,
                    )
                else:
                    status.configure(text="Si el correo existe, se envio un codigo de verificacion.", text_color=SUCCESS)
            else:
                status.configure(text=result.get("message") or "No se pudo solicitar el codigo.", text_color=DANGER)

        def confirmar_reset():
            if not refresh_checks():
                status.configure(text="Completa todos los requisitos antes de guardar.", text_color=DANGER)
                return
            if nueva.get() != confirmar.get():
                status.configure(text="Las contrasenas no coinciden.", text_color=DANGER)
                return
            result = local_auth.confirmar_recuperacion_password(correo.get(), codigo.get(), nueva.get(), self.cfg)
            if result.get("ok"):
                self.entry_correo.delete(0, "end")
                self.entry_correo.insert(0, correo.get().strip())
                self.entry_pass.delete(0, "end")
                self.entry_pass.insert(0, nueva.get())
                top.destroy()
                self.error_lbl.configure(text="Contrasena actualizada. Puedes iniciar sesion.", text_color=SUCCESS)
            else:
                status.configure(text=result.get("message") or "No se pudo actualizar la contrasena.", text_color=DANGER)

        ctk.CTkButton(
            request_inner,
            text="Solicitar codigo",
            command=solicitar,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            text_color="#FFFFFF",
            height=40,
            corner_radius=8,
            font=ctk.CTkFont(weight="bold"),
        ).pack(fill="x", pady=(12, 0))

        ctk.CTkButton(
            footer,
            text="Cancelar",
            command=top.destroy,
            fg_color=SURFACE,
            hover_color=APP_BG,
            text_color=TEXT_BODY,
            border_width=1,
            border_color=BORDER_STRONG,
            height=42,
            corner_radius=8,
        ).pack(side="left", fill="x", expand=True, padx=(0, 8))
        save_button = ctk.CTkButton(
            footer,
            text="Guardar cambios",
            command=confirmar_reset,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            text_color="#FFFFFF",
            height=42,
            corner_radius=8,
            font=ctk.CTkFont(weight="bold"),
        )
        save_button.pack(side="left", fill="x", expand=True, padx=(8, 0))
        save_ref["button"] = save_button
        refresh_checks()

    def _salir(self):
        self.decision = False
        self.destroy()


# ==========================================================================
# Consentimiento
# ==========================================================================
def _consent_path(auth_email: str = "") -> str:
    base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
    carpeta = os.path.join(base, "VYNTRA")
    os.makedirs(carpeta, exist_ok=True)
    if auth_email:
        email_hash = hashlib.sha256(auth_email.strip().lower().encode("utf-8")).hexdigest()[:16]
        return os.path.join(carpeta, f"consent_{email_hash}.json")
    return os.path.join(carpeta, "consent.json")


def load_consent(auth_email: str = "") -> dict | None:
    try:
        with open(_consent_path(auth_email), "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_consent(aceptado: bool, detalles: dict | None = None, auth_email: str = "") -> dict:
    registro = {
        "aceptado": aceptado,
        "auth_email": auth_email.strip().lower(),
        "empleado": getpass.getuser(),
        "equipo": socket.gethostname(),
        "fechaHora": datetime.datetime.now().isoformat(),
        "version": VERSION,
        "autorizaciones": detalles or {},
    }
    with open(_consent_path(auth_email), "w", encoding="utf-8") as f:
        json.dump(registro, f, indent=2, ensure_ascii=False)
    append_event("consent_saved", registro)
    return registro


class ConsentWindow(ctk.CTk):
    def __init__(self, cfg: Config):
        super().__init__()
        self.cfg = cfg
        self.decision = None
        self.detalles = {}
        self.req_vars = []

        self.title("VYNTRA - Consentimiento")
        self.geometry("900x680")
        self.minsize(820, 600)
        self.configure(fg_color=CONSENT_BG)

        self._build()

    def _build(self):
        header = ctk.CTkFrame(self, fg_color=PRIMARY_DEEP, corner_radius=0, height=88)
        header.pack(fill="x")
        header.pack_propagate(False)
        h = ctk.CTkFrame(header, fg_color="transparent")
        h.pack(fill="both", expand=True, padx=28, pady=16)

        marca = ctk.CTkFrame(h, fg_color="transparent")
        marca.pack(anchor="w")
        ctk.CTkLabel(
            marca, text="V",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=PRIMARY_DEEP, fg_color="#FFFFFF",
            corner_radius=8, width=34, height=34,
        ).pack(side="left", padx=(0, 10))
        textos = ctk.CTkFrame(marca, fg_color="transparent")
        textos.pack(side="left")
        ctk.CTkLabel(textos, text="VYNTRA",
                    font=ctk.CTkFont(size=21, weight="bold"),
                    text_color="#FFFFFF").pack(anchor="w")
        ctk.CTkLabel(textos, text="Autorizacion para participar en programa piloto",
                    font=ctk.CTkFont(size=12),
                    text_color="#C7D9FB").pack(anchor="w")

        body = ctk.CTkFrame(self, fg_color=CONSENT_PANEL, corner_radius=12,
                            border_width=1, border_color=BORDER)
        body.pack(fill="both", expand=True, padx=24, pady=22)

        content = ctk.CTkScrollableFrame(body, fg_color="transparent")
        content.pack(fill="both", expand=True, padx=22, pady=18)

        ctk.CTkLabel(content, text="Antes de continuar",
                    font=ctk.CTkFont(size=20, weight="bold"),
                    text_color=CONSENT_TEXT).pack(anchor="w")
        ctk.CTkLabel(
            content,
            text=(
                f"{self.cfg.empresa} usara VYNTRA para registrar jornada, pausas, "
                "capturas durante horario laboral, estado de actividad y solicitudes "
                "relacionadas con asistencia. La app permanece visible en todo momento y "
                "este aviso se basa en la legislacion vigente de Nicaragua."
            ),
            font=ctk.CTkFont(size=13),
            text_color=CONSENT_MUTED,
            wraplength=790,
            justify="left",
        ).pack(anchor="w", pady=(8, 18))

        self._section(content, "Base legal de este aviso")
        for text in [
            "Constitucion Politica de Nicaragua, articulo 26: derecho a la vida privada "
            "y a conocer que informacion se registra sobre la persona, por que y con "
            "que finalidad.",
            "Ley No. 787, Ley de Proteccion de Datos Personales (La Gaceta No. 61 del "
            "29 de marzo de 2012) y su Reglamento, Decreto No. 36-2012: exige "
            "consentimiento libre, especifico e informado para tratar datos personales, "
            "y establece los derechos del titular.",
            "Codigo del Trabajo, Ley No. 185: articulo 17 (obligacion del empleador de "
            "tratar al trabajador con respeto y de certificar el tiempo trabajado) y "
            "articulo 49 (limites de la jornada laboral).",
            "Nicaragua no cuenta con una ley especial de teletrabajo; el trabajo "
            "supervisado a distancia se rige por el Codigo del Trabajo y por la Ley 787 "
            "en lo relativo al tratamiento de datos.",
        ]:
            self._bullet(content, text)

        self._section(content, "Que datos recopila y por que")
        for text in [
            "Inicio, break, almuerzo y finalizacion de jornada, para llevar el registro "
            "de asistencia que exige el Codigo del Trabajo.",
            "Capturas de pantalla durante jornada activa, para verificar continuidad de "
            "la operacion durante el horario laboral.",
            "Aplicacion o ventana activa, tiempo de inactividad y clics, solo con fines "
            "administrativos de control de asistencia.",
            "Solicitudes de incidencia (permisos, correcciones, horas extra) enviadas "
            "por el propio usuario.",
        ]:
            self._bullet(content, text)

        self._section(content, "Principios con los que se tratan tus datos (Ley 787)")
        for text in [
            "Los datos se usan unicamente para los fines descritos en este aviso, de "
            "forma adecuada, proporcional y necesaria.",
            "Se protegen con medidas tecnicas, organizativas y fisicas razonables.",
            "No se comparten con terceros ajenos a la relacion laboral.",
        ]:
            self._bullet(content, text)

        self._section(content, "Tus derechos como titular de los datos")
        for text in [
            "Acceso: pedir una copia de los datos que VYNTRA ha registrado sobre ti.",
            "Rectificacion: pedir que se corrijan datos inexactos.",
            "Cancelacion: pedir la eliminacion de datos cuando ya no sean necesarios "
            "para el fin que motivo su recoleccion.",
            "Oposicion y revocacion: puedes revocar este consentimiento en cualquier "
            "momento y sin costo, escribiendo a "
            f"{self.cfg.correo_contacto}. Revocarlo detiene el monitoreo, pero no "
            "borra retroactivamente los registros ya generados mientras estuvo activo.",
        ]:
            self._bullet(content, text)

        self._section(content, "Limites (lo que VYNTRA no hace)")
        for text in [
            "No registra contrasenas.",
            "No captura contenido escrito con el teclado.",
            "No activa camara ni microfono.",
            "No funciona de forma oculta: la app permanece visible en todo momento.",
        ]:
            self._bullet(content, text)

        self._section(content, "Autorizaciones requeridas")
        for text in [
            "Confirmo que lei y comprendo este aviso, incluida la base legal citada.",
            "Autorizo el tratamiento de mis datos personales conforme a la Ley No. 787 "
            "y su Reglamento (Decreto No. 36-2012).",
            "Autorizo el registro de mi jornada laboral conforme al Codigo del Trabajo "
            "(Ley No. 185).",
            "Autorizo las capturas de pantalla durante mi jornada laboral activa.",
            "Entiendo que puedo revocar este consentimiento en cualquier momento, sin "
            "costo, contactando a RR. HH.",
        ]:
            self._checkbox(content, text)

        footer = ctk.CTkFrame(self, fg_color=CONSENT_BG, corner_radius=0, height=74)
        footer.pack(fill="x", side="bottom")
        footer.pack_propagate(False)
        row = ctk.CTkFrame(footer, fg_color="transparent")
        row.pack(fill="both", expand=True, padx=24)
        ctk.CTkLabel(row, text=f"Contacto: {self.cfg.correo_contacto}",
                    font=ctk.CTkFont(size=12),
                    text_color=CONSENT_MUTED).pack(side="left")

        ctk.CTkButton(row, text="No aceptar y salir", command=self._rechazar,
                     fg_color=SURFACE, text_color=CONSENT_TEXT,
                     hover_color=APP_BG, border_width=1,
                     border_color=BORDER_STRONG, width=155, height=42,
                     corner_radius=8).pack(side="right")
        self.btn_aceptar = ctk.CTkButton(
            row,
            text="Aceptar y continuar",
            command=self._aceptar,
            state="disabled",
            fg_color=BORDER_STRONG,
            text_color="#FFFFFF",
            hover_color=PRIMARY_DARK,
            width=180,
            height=42,
            corner_radius=8,
            font=ctk.CTkFont(size=13, weight="bold"),
        )
        self.btn_aceptar.pack(side="right", padx=(0, 10))

    def _section(self, parent, title):
        ctk.CTkLabel(parent, text=title,
                    font=ctk.CTkFont(size=14, weight="bold"),
                    text_color=CONSENT_TEXT).pack(anchor="w", pady=(14, 6))

    def _bullet(self, parent, text):
        row = ctk.CTkFrame(parent, fg_color="transparent")
        row.pack(fill="x", pady=2)
        ctk.CTkLabel(row, text="•", width=16, text_color=PRIMARY,
                    font=ctk.CTkFont(size=14, weight="bold")).pack(side="left")
        ctk.CTkLabel(row, text=text, text_color=CONSENT_MUTED,
                    font=ctk.CTkFont(size=12), justify="left",
                    wraplength=720).pack(side="left")

    def _checkbox(self, parent, text):
        var = ctk.BooleanVar(value=False)
        self.req_vars.append(var)
        row = ctk.CTkFrame(parent, fg_color="transparent")
        row.pack(fill="x", pady=4)
        ctk.CTkCheckBox(row, text="", variable=var, command=self._validar,
                       width=26, checkbox_width=18, checkbox_height=18,
                       fg_color=PRIMARY, hover_color=PRIMARY_DARK,
                       border_color=BORDER_STRONG).pack(
            side="left", anchor="n", pady=2)
        ctk.CTkLabel(row, text=text, text_color=CONSENT_TEXT,
                    font=ctk.CTkFont(size=12), justify="left",
                    wraplength=710).pack(side="left", padx=(6, 0))

    def _validar(self):
        listo = all(v.get() for v in self.req_vars)
        if listo:
            self.btn_aceptar.configure(
                state="normal", fg_color=PRIMARY, text_color="#FFFFFF"
            )
        else:
            self.btn_aceptar.configure(
                state="disabled", fg_color=BORDER_STRONG, text_color="#FFFFFF"
            )

    def _aceptar(self):
        self.decision = True
        self.detalles = {
            "leido_aviso": True,
            "tratamiento_datos_ley_787": True,
            "registro_jornada_codigo_trabajo": True,
            "capturas_pantalla": True,
            "conoce_derecho_revocacion": True,
            "base_legal": "Constitucion Art. 26; Ley 787 y Decreto 36-2012; Codigo del Trabajo (Ley 185) Art. 17 y 49",
        }
        self.destroy()

    def _rechazar(self):
        self.decision = False
        self.destroy()


# ==========================================================================
# Estacion de marcaje
# ==========================================================================
class StationWindow(ctk.CTk):
    def __init__(self, cfg: Config, consentimiento: dict, auth_email: str = ""):
        super().__init__()
        self.cfg = cfg
        self.consentimiento = consentimiento
        self.auth_email = auth_email
        self.shift = ShiftManager(cfg, on_state=self._on_state, on_tick=self._on_tick)
        self.screens = ScreenshotEngine(cfg, on_event=self._on_screen_event)
        self.event_uploader = AgentEventUploader(cfg, on_event=self._on_sync_event)
        self.rules_downloader = RulesDownloader(cfg, on_event=self._on_rules_event)
        self.shift.on_shift_start = self.screens.start
        self.shift.on_shift_pause = self.screens.pause
        self.shift.on_shift_resume = self.screens.resume
        self.shift.on_shift_end = self.screens.stop
        self._ultima_captura_txt = "--:--"
        self._ui_error = None

        self.title("VYNTRA - Estacion de marcaje")
        self.geometry("1080x720")
        self.minsize(1000, 660)
        self.configure(fg_color=APP_BG)

        try:
            self._build()
            self.protocol("WM_DELETE_WINDOW", self._al_cerrar)
            self._render_controles()
            self._pintar_estado_items()
            self.shift.resume_runtime_if_needed()
            self._refresh_sync_status()
            self.after(200, lambda: self._draw_clock(0))
            self.event_uploader.start()
            self.rules_downloader.start()
            self._start_healthcheck()
        except Exception as exc:
            self._ui_error = exc
            self._build_fallback_ui(str(exc))

    def _build(self):
        self._barra_superior()

        shell = ctk.CTkFrame(self, fg_color="transparent")
        shell.pack(fill="both", expand=True, padx=20, pady=20)
        shell.grid_columnconfigure(0, weight=58, uniform="main")
        shell.grid_columnconfigure(1, weight=42, uniform="main")
        shell.grid_rowconfigure(0, weight=1)

        left = ctk.CTkFrame(
            shell,
            fg_color=SURFACE,
            corner_radius=12,
            border_width=1,
            border_color=BORDER,
        )
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 10))

        right = ctk.CTkFrame(shell, fg_color="transparent")
        right.grid(row=0, column=1, sticky="nsew", padx=(10, 0))

        self._panel_reloj(left)
        self._panel_logo(right)
        self._panel_estado(right)
        self._panel_soporte(right)

    def _barra_superior(self):
        bar = ctk.CTkFrame(self, fg_color=PRIMARY_DEEP, corner_radius=0, height=64)
        bar.pack(fill="x")
        bar.pack_propagate(False)
        cont = ctk.CTkFrame(bar, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=24)

        marca = ctk.CTkFrame(cont, fg_color="transparent")
        marca.pack(side="left", anchor="center")
        ctk.CTkLabel(
            marca,
            text="V",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=PRIMARY_DEEP,
            fg_color="#FFFFFF",
            corner_radius=8,
            width=34,
            height=34,
        ).pack(side="left", padx=(0, 10))

        textos = ctk.CTkFrame(marca, fg_color="transparent")
        textos.pack(side="left")
        ctk.CTkLabel(
            textos,
            text="VYNTRA",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color="#FFFFFF",
        ).pack(anchor="w")
        ctk.CTkLabel(
            textos,
            text="Estacion de marcaje",
            font=ctk.CTkFont(size=11),
            text_color="#C7D9FB",
        ).pack(anchor="w")

        der = ctk.CTkFrame(cont, fg_color="transparent")
        der.pack(side="right", anchor="center")
        self.badge = ctk.CTkLabel(
            der,
            text="  Jornada inactiva  ",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=NEUTRAL_TEXT,
            fg_color="#FFFFFF",
            corner_radius=14,
            height=34,
        )
        self.badge.pack(side="left", padx=(0, 8))
        ctk.CTkLabel(
            der,
            text=f"  {getpass.getuser()} · {socket.gethostname()}  ",
            font=ctk.CTkFont(size=12),
            text_color="#FFFFFF",
            fg_color="#2F5AC7",
            corner_radius=14,
            height=34,
        ).pack(side="left", padx=(0, 8))
        ctk.CTkButton(
            der,
            text="?",
            width=34,
            height=34,
            corner_radius=17,
            fg_color="#2F5AC7",
            hover_color=PRIMARY,
            command=self._modal_incidencia,
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(side="left")

    def _panel_reloj(self, parent):
        parent.grid_columnconfigure(0, weight=1)
        parent.grid_rowconfigure(1, weight=1)

        head = ctk.CTkFrame(parent, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=24, pady=(24, 0))
        head.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            head,
            text="TURNO ACTUAL",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=TEXT_MUTED,
        ).grid(row=0, column=0, sticky="w")
        ctk.CTkLabel(
            head,
            text="Operacion BPO - Managua",
            font=ctk.CTkFont(size=24, weight="bold"),
            text_color=TEXT_DARK,
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))

        self.lbl_captura_estado = ctk.CTkLabel(
            head,
            text=" Captura detenida ",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=NEUTRAL_TEXT,
            fg_color=NEUTRAL_BG,
            corner_radius=14,
            height=34,
        )
        self.lbl_captura_estado.grid(row=0, column=1, rowspan=2, sticky="e")

        clock_box = ctk.CTkFrame(parent, fg_color="transparent")
        clock_box.grid(row=1, column=0, sticky="nsew", padx=24, pady=(10, 0))
        clock_box.grid_columnconfigure(0, weight=1)
        clock_box.grid_rowconfigure(0, weight=1)

        self.clock_canvas = tk.Canvas(
            clock_box,
            width=320,
            height=320,
            bg=SURFACE,
            highlightthickness=0,
        )
        self.clock_canvas.grid(row=0, column=0)

        ctk.CTkLabel(
            parent,
            text="Selecciona una accion para tu jornada actual.",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_FAINT,
        ).grid(row=1, column=0, sticky="sw", padx=24, pady=(0, 4))

        self.ctrl_inner = ctk.CTkFrame(parent, fg_color="transparent")
        self.ctrl_inner.grid(row=2, column=0, sticky="ew", padx=24, pady=(6, 0))

        metrics = ctk.CTkFrame(parent, fg_color="transparent")
        metrics.grid(row=3, column=0, sticky="ew", padx=24, pady=(14, 24))
        for i in range(4):
            metrics.grid_columnconfigure(i, weight=1, uniform="m")

        self.lbl_hora = self._metric_card(metrics, 0, "HORA ACTUAL", "--:--:--")
        self.lbl_break = self._metric_card(metrics, 1, "BREAK USADO", "00:00:00")
        self.lbl_lunch = self._metric_card(metrics, 2, "ALMUERZO USADO", "00:00:00")
        self.lbl_extra = self._metric_card(metrics, 3, "HORAS EXTRA", "00:00:00")

    def _metric_card(self, parent, col, title, value):
        card = ctk.CTkFrame(
            parent,
            fg_color=SURFACE_ALT,
            corner_radius=10,
            border_width=1,
            border_color=BORDER,
        )
        card.grid(row=0, column=col, sticky="ew", padx=(0 if col == 0 else 6, 0))
        ctk.CTkLabel(
            card,
            text=title,
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color=TEXT_MUTED,
        ).pack(anchor="w", padx=14, pady=(12, 2))
        lbl = ctk.CTkLabel(
            card,
            text=value,
            font=ctk.CTkFont(size=20, weight="bold"),
            text_color=TEXT_DARK,
        )
        lbl.pack(anchor="w", padx=14, pady=(0, 12))
        return lbl

    def _panel_logo(self, parent):
        card = ctk.CTkFrame(
            parent,
            fg_color=SURFACE,
            corner_radius=12,
            border_width=1,
            border_color=BORDER,
            height=160,
        )
        card.pack(fill="x", pady=(0, 14))
        card.pack_propagate(False)

        inner = ctk.CTkFrame(card, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=22, pady=20)

        ctk.CTkLabel(
            inner,
            text="V",
            font=ctk.CTkFont(size=34, weight="bold"),
            text_color="#FFFFFF",
            fg_color=PRIMARY,
            corner_radius=16,
            width=74,
            height=74,
        ).pack(side="left", padx=(0, 18))

        copy = ctk.CTkFrame(inner, fg_color="transparent")
        copy.pack(side="left", fill="both", expand=True)
        ctk.CTkLabel(
            copy,
            text="VYNTRA",
            font=ctk.CTkFont(size=26, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w", pady=(8, 0))
        ctk.CTkLabel(
            copy,
            text="Agente empresarial",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color=PRIMARY,
        ).pack(anchor="w")
        ctk.CTkLabel(
            copy,
            text="Agente de marcaje laboral instalado en este equipo.",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=320,
            justify="left",
        ).pack(anchor="w", pady=(10, 0))

    def _panel_estado(self, parent):
        card = ctk.CTkFrame(
            parent,
            fg_color=SURFACE,
            corner_radius=12,
            border_width=1,
            border_color=BORDER,
        )
        card.pack(fill="x", pady=(0, 14))
        inner = ctk.CTkFrame(card, fg_color="transparent")
        inner.pack(fill="x", padx=18, pady=16)

        head = ctk.CTkFrame(inner, fg_color="transparent")
        head.pack(fill="x", pady=(0, 10))
        ctk.CTkLabel(
            head,
            text="Estado de jornada",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(side="left")
        ctk.CTkLabel(
            head,
            text="Registro visible",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_FAINT,
        ).pack(side="right")

        self.estado_items = ctk.CTkFrame(inner, fg_color="transparent")
        self.estado_items.pack(fill="x")

    def _panel_soporte(self, parent):
        card = ctk.CTkFrame(
            parent,
            fg_color=SURFACE,
            corner_radius=12,
            border_width=1,
            border_color=BORDER,
        )
        card.pack(fill="both", expand=True)
        inner = ctk.CTkFrame(card, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=18, pady=16)

        head = ctk.CTkFrame(inner, fg_color="transparent")
        head.pack(fill="x", pady=(0, 12))
        ctk.CTkLabel(
            head,
            text="Incidencias y ajustes",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(side="left")
        ctk.CTkLabel(
            head,
            text="Solicitudes",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_FAINT,
        ).pack(side="right")

        row = ctk.CTkFrame(inner, fg_color="transparent")
        row.pack(fill="x")
        row.grid_columnconfigure(0, weight=1, uniform="s")
        row.grid_columnconfigure(1, weight=1, uniform="s")
        self.lbl_sync = self._support_card(row, 0, "S", "Sincronizado", "Local")
        self.lbl_ultima_captura = self._support_card(
            row, 1, "C", "Ultima captura", "--:--"
        )

        ctk.CTkButton(
            inner,
            text="Abrir incidencias",
            command=self._modal_incidencia,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            text_color="#FFFFFF",
            corner_radius=8,
            height=46,
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", pady=(10, 0))

        ctk.CTkButton(
            inner,
            text="Descargar reglas de productividad",
            command=self._download_rules_now,
            fg_color="#059669",
            hover_color="#047857",
            text_color="#FFFFFF",
            corner_radius=8,
            height=46,
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", pady=(8, 0))

    def _support_card(self, parent, col, icon, title, detail):
        card = ctk.CTkFrame(
            parent,
            fg_color=SURFACE_ALT,
            corner_radius=10,
            border_width=1,
            border_color=BORDER,
        )
        card.grid(row=0, column=col, sticky="ew", padx=(0 if col == 0 else 6, 0))

        ctk.CTkLabel(
            card,
            text=icon,
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=PRIMARY,
            fg_color=PRIMARY_LIGHT2,
            corner_radius=7,
            width=30,
            height=30,
        ).pack(side="left", padx=(12, 10), pady=12)

        texts = ctk.CTkFrame(card, fg_color="transparent")
        texts.pack(side="left", fill="x", expand=True)
        ctk.CTkLabel(
            texts,
            text=title,
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        lbl = ctk.CTkLabel(
            texts,
            text=detail,
            font=ctk.CTkFont(size=11),
            text_color=TEXT_MUTED,
        )
        lbl.pack(anchor="w")
        return lbl

    def _draw_clock(self, segundos):
        try:
            c = getattr(self, "clock_canvas", None)
            if c is None or not c.winfo_exists():
                return
            c.delete("all")
            w = int(c["width"]) or 320
            h = int(c["height"]) or 320
            pad = 30
            box = (pad, pad, w - pad, h - pad)
            progress = min(max(segundos / (8 * 3600), 0), 1)

            c.create_oval(box, outline=SURFACE_ALT, width=22)
            if progress > 0:
                c.create_arc(
                    box,
                    start=90,
                    extent=-360 * progress,
                    style="arc",
                    outline=PRIMARY,
                    width=22,
                )

            c.create_text(
                w / 2,
                h / 2 - 14,
                text=fmt_hms(segundos),
                fill=TEXT_DARK,
                font=("Segoe UI", 46, "bold"),
            )
            c.create_text(
                w / 2,
                h / 2 + 40,
                text="Tiempo trabajado hoy",
                fill=TEXT_MUTED,
                font=("Segoe UI", 12, "bold"),
            )
            c.create_text(
                w / 2,
                h / 2 + 62,
                text="Meta diaria: 8h",
                fill=TEXT_FAINT,
                font=("Segoe UI", 10),
            )
        except Exception:
            try:
                c = getattr(self, "clock_canvas", None)
                if c is not None:
                    c.delete("all")
                    c.create_text(10, 10, anchor="nw", text="Reloj no disponible", fill=TEXT_MUTED)
            except Exception:
                pass

    def _pintar_estado_items(self):
        try:
            for w in self.estado_items.winfo_children():
                w.destroy()

            estado = self.shift.estado
            items = [
                ("1", "Inicio de jornada", self._hora(self.shift.inicio_jornada),
                 self.shift.inicio_jornada is not None),
                ("2", "Trabajando", self._trabajando_txt(), estado == "TRABAJANDO"),
                ("3", "Break", self._pausa_txt("BREAK", self.shift.break_consumido),
                 estado == "BREAK"),
                ("4", "Lunch", self._pausa_txt("LUNCH", self.shift.lunch_consumido),
                 estado == "LUNCH"),
                ("5", "Fin de jornada", self._hora(self.shift.fin_jornada),
                 estado == "TERMINADO"),
            ]

            for num, label, detail, active in items:
                row = ctk.CTkFrame(self.estado_items, fg_color="transparent")
                row.pack(fill="x", pady=4)
                bg = PRIMARY if active else NEUTRAL_BG
                tx = "#FFFFFF" if active else TEXT_FAINT
                ctk.CTkLabel(
                    row,
                    text=num,
                    width=26,
                    height=26,
                    corner_radius=13,
                    fg_color=bg,
                    text_color=tx,
                    font=ctk.CTkFont(size=12, weight="bold"),
                ).pack(side="left")
                ctk.CTkLabel(
                    row,
                    text=label,
                    font=ctk.CTkFont(size=13, weight="bold"),
                    text_color=TEXT_DARK if active else TEXT_BODY,
                ).pack(side="left", padx=(12, 0))
                ctk.CTkLabel(
                    row,
                    text=detail,
                    font=ctk.CTkFont(size=12),
                    text_color=PRIMARY if active else TEXT_MUTED,
                ).pack(side="right")
        except Exception:
            if hasattr(self, "estado_items") and self.estado_items.winfo_exists():
                for w in self.estado_items.winfo_children():
                    w.destroy()
                ctk.CTkLabel(
                    self.estado_items,
                    text="No fue posible mostrar el estado de la jornada.",
                    font=ctk.CTkFont(size=12),
                    text_color=TEXT_MUTED,
                    wraplength=320,
                ).pack(anchor="w")

    def _trabajando_txt(self):
        if self.shift.estado == "TRABAJANDO":
            return "Ahora"
        if self.shift.estado in ("BREAK", "LUNCH"):
            return "Pausado"
        if self.shift.estado == "TERMINADO":
            return "Cerrada"
        return "--"

    def _pausa_txt(self, estado, consumido):
        if self.shift.estado == estado:
            return "Ahora"
        return "Usado" if consumido else "Libre"

    @staticmethod
    def _hora(dt):
        return dt.strftime("%H:%M") if dt else "--:--"

    def _render_controles(self):
        try:
            for w in self.ctrl_inner.winfo_children():
                w.destroy()

            e = self.shift.estado
            fila = ctk.CTkFrame(self.ctrl_inner, fg_color="transparent")
            fila.pack(fill="x")

            def btn(parent, texto, cmd, primary=False):
                if primary:
                    color, hover, tx, bw, bc = PRIMARY, PRIMARY_DARK, "#FFFFFF", 0, PRIMARY
                else:
                    color, hover, tx, bw, bc = SURFACE, PRIMARY_LIGHT, PRIMARY, 1, PRIMARY
                ctk.CTkButton(
                    parent,
                    text=texto,
                    command=cmd,
                    height=50,
                    corner_radius=8,
                    fg_color=color,
                    hover_color=hover,
                    text_color=tx,
                    border_width=bw,
                    border_color=bc,
                    font=ctk.CTkFont(size=13, weight="bold"),
                ).pack(side="left", expand=True, fill="x", padx=5)

            if e == "FUERA":
                btn(
                    fila,
                    "Iniciar jornada",
                    lambda: self._confirmar(
                        "Iniciar jornada laboral",
                        "Al confirmar se activan el reloj y las capturas.",
                        self.shift.iniciar_jornada,
                    ),
                    primary=True,
                )
            elif e == "TRABAJANDO":
                btn(
                    fila,
                    "Finalizar jornada",
                    lambda: self._confirmar(
                        "Finalizar jornada laboral",
                        "El monitoreo y las capturas se detendran al confirmar.",
                        self.shift.finalizar_jornada,
                    ),
                    primary=True,
                )
                if not self.shift.break_consumido:
                    btn(
                        fila,
                        "Break",
                        lambda: self._confirmar(
                            "Iniciar break",
                            "Solo puedes tomar break una vez por jornada.",
                            self.shift.iniciar_break,
                        ),
                    )
                if not self.shift.lunch_consumido:
                    btn(
                        fila,
                        "Lunch",
                        lambda: self._confirmar(
                            "Iniciar almuerzo",
                            "Solo puedes tomar almuerzo una vez por jornada.",
                            self.shift.iniciar_lunch,
                        ),
                    )
            elif e == "BREAK":
                btn(
                    fila,
                    "Finalizar break",
                    lambda: self._confirmar(
                        "Finalizar break",
                        "Volveras a jornada activa.",
                        self.shift.finalizar_break,
                    ),
                    primary=True,
                )
            elif e == "LUNCH":
                btn(
                    fila,
                    "Finalizar almuerzo",
                    lambda: self._confirmar(
                        "Finalizar almuerzo",
                        "Volveras a jornada activa.",
                        self.shift.finalizar_lunch,
                    ),
                    primary=True,
                )
            elif e == "TERMINADO":
                ctk.CTkLabel(
                    self.ctrl_inner,
                    text="Jornada finalizada. El monitoreo y las capturas se detuvieron.",
                    font=ctk.CTkFont(size=13),
                    text_color=TEXT_MUTED,
                    wraplength=540,
                    justify="left",
                ).pack(anchor="w", pady=8)

        except Exception:
            for w in self.ctrl_inner.winfo_children():
                w.destroy()
            ctk.CTkLabel(
                self.ctrl_inner,
                text="No fue posible cargar los botones de marcaje.",
                font=ctk.CTkFont(size=13),
                text_color=TEXT_MUTED,
                wraplength=540,
            ).pack(anchor="w", pady=8)

    def _modal(self, titulo, ancho, alto):
        top = ctk.CTkToplevel(self)
        top.title(titulo)
        top.geometry(f"{ancho}x{alto}")
        top.configure(fg_color=APP_BG)
        top.transient(self)
        top.after(80, top.grab_set)
        top.update_idletasks()
        x = self.winfo_x() + (self.winfo_width() - ancho) // 2
        y = self.winfo_y() + (self.winfo_height() - alto) // 2
        top.geometry(f"+{max(x, 0)}+{max(y, 0)}")
        return top

    def _confirmar(self, titulo, detalle, on_yes):
        top = self._modal("Confirmar", 430, 220)
        ctk.CTkLabel(
            top,
            text=titulo,
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=TEXT_DARK,
            wraplength=360,
        ).pack(padx=24, pady=(28, 6))
        if detalle:
            ctk.CTkLabel(
                top,
                text=detalle,
                font=ctk.CTkFont(size=12),
                text_color=TEXT_MUTED,
                wraplength=360,
            ).pack(padx=24)

        fila = ctk.CTkFrame(top, fg_color="transparent")
        fila.pack(pady=20)
        ctk.CTkButton(
            fila,
            text="Cancelar",
            command=top.destroy,
            fg_color=SURFACE,
            hover_color=APP_BG,
            text_color=TEXT_BODY,
            border_width=1,
            border_color=BORDER_STRONG,
            width=130,
            height=40,
            corner_radius=8,
        ).pack(side="left", padx=6)

        def si():
            top.destroy()
            on_yes()

        ctk.CTkButton(
            fila,
            text="Confirmar",
            command=si,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            text_color="#FFFFFF",
            width=150,
            height=40,
            corner_radius=8,
            font=ctk.CTkFont(weight="bold"),
        ).pack(side="left", padx=6)

    def _modal_incidencia(self):
        top = self._modal("Incidencias y ajustes", 500, 350)
        cont = ctk.CTkFrame(top, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=22, pady=20)
        ctk.CTkLabel(
            cont,
            text="Incidencias y ajustes",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text="Selecciona la accion que necesitas reportar.",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
        ).pack(anchor="w", pady=(4, 14))

        opciones = [
            ("Restaurar jornada laboral", "restaurar"),
            ("Horas extra", "horas_extra"),
            ("Reportar falla tecnica", "tiempo_perdido"),
        ]
        for texto, tipo in opciones:
            def abrir(t=tipo, x=texto):
                top.destroy()
                if t == "restaurar":
                    self._modal_restaurar()
                elif t == "horas_extra":
                    self._modal_horas_extra()
                elif t == "tiempo_perdido":
                    self._modal_falla_tecnica()
                else:
                    self._modal_excepcion(t, x)

            ctk.CTkButton(
                cont,
                text=texto,
                command=abrir,
                height=42,
                fg_color=SURFACE,
                hover_color=PRIMARY_LIGHT,
                text_color=TEXT_DARK,
                border_width=1,
                border_color=BORDER_STRONG,
                corner_radius=8,
                font=ctk.CTkFont(size=13, weight="bold"),
                anchor="w",
            ).pack(fill="x", pady=4)

    def _download_rules_now(self):
        """Descarga reglas de productividad del backend inmediatamente."""
        try:
            success = self.rules_downloader.download_now()
            rules_info = self.rules_downloader.get_rules_info()
            
            top = self._modal("Reglas de productividad", 500, 280)
            cont = ctk.CTkFrame(top, fg_color="transparent")
            cont.pack(fill="both", expand=True, padx=22, pady=20)
            
            if success:
                ctk.CTkLabel(
                    cont,
                    text="✓ Reglas descargadas exitosamente",
                    font=ctk.CTkFont(size=16, weight="bold"),
                    text_color=SUCCESS,
                ).pack(anchor="w", pady=(0, 14))
                ctk.CTkLabel(
                    cont,
                    text=f"Total de reglas: {rules_info['count']}",
                    font=ctk.CTkFont(size=13),
                    text_color=TEXT_BODY,
                ).pack(anchor="w", pady=4)
                ctk.CTkLabel(
                    cont,
                    text=f"Última actualización: {rules_info['last_update'] or 'Nunca'}",
                    font=ctk.CTkFont(size=12),
                    text_color=TEXT_MUTED,
                ).pack(anchor="w", pady=4)
            else:
                ctk.CTkLabel(
                    cont,
                    text="✗ Error al descargar reglas",
                    font=ctk.CTkFont(size=16, weight="bold"),
                    text_color=DANGER,
                ).pack(anchor="w", pady=(0, 14))
                ctk.CTkLabel(
                    cont,
                    text="Intenta nuevamente más tarde.",
                    font=ctk.CTkFont(size=13),
                    text_color=TEXT_BODY,
                ).pack(anchor="w", pady=4)
            
            ctk.CTkButton(
                cont,
                text="Cerrar",
                command=top.destroy,
                height=42,
                fg_color=PRIMARY,
                hover_color=PRIMARY_DARK,
                text_color="#FFFFFF",
                corner_radius=8,
                font=ctk.CTkFont(size=13, weight="bold"),
            ).pack(fill="x", pady=(20, 0))
        except Exception as exc:
            pass

    def _modal_horas_extra(self):
        if self.shift.horas_extra_estado == "ACTIVA":
            self._modal_cronometro_horas_extra()
            return

        top = self._modal("Horas extra", 500, 330)
        cont = ctk.CTkFrame(top, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=22, pady=20)
        ctk.CTkLabel(
            cont,
            text="Horas extra",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text=(
                "Ingresa el codigo de un solo uso enviado por tu jefe o administrador. "
                "El cronometro solo marcara el tiempo autorizado."
            ),
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=440,
            justify="left",
        ).pack(anchor="w", pady=(4, 14))

        ctk.CTkLabel(cont, text="Codigo de autorizacion", text_color=TEXT_BODY).pack(anchor="w")
        codigo = ctk.CTkEntry(
            cont,
            placeholder_text="Ej: HE-120-X7K2",
            fg_color=SURFACE_ALT,
            border_color=BORDER_STRONG,
            text_color=TEXT_DARK,
        )
        codigo.pack(fill="x", pady=(4, 8))

        error = ctk.CTkLabel(cont, text="", text_color=DANGER)
        error.pack(anchor="w")

        def activar():
            if self.shift.horas_extra_estado == "ACTIVA":
                top.destroy()
                self._modal_cronometro_horas_extra()
                return
            if self.shift.activar_horas_extra_con_codigo(codigo.get().strip()):
                top.destroy()
                self._modal_cronometro_horas_extra()
            else:
                error.configure(
                    text=self.shift.ultimo_error_codigo
                    or "Codigo invalido, vencido o ya utilizado."
                )

        ctk.CTkButton(
            cont,
            text="Activar horas extra",
            command=activar,
            fg_color=SUCCESS,
            hover_color="#15803D",
            text_color="#FFFFFF",
            height=44,
            corner_radius=8,
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(side="bottom", fill="x", pady=(12, 0))

    def _modal_cronometro_horas_extra(self):
        top = self._modal("Horas extra activas", 520, 340)
        cont = ctk.CTkFrame(top, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=26, pady=24)
        ctk.CTkLabel(
            cont,
            text="Horas extra activas",
            font=ctk.CTkFont(size=18, weight="bold"),
            text_color=SUCCESS,
        ).pack(anchor="w")
        asignadas = getattr(self.shift, "horas_extra_asignadas_segundos", 0)
        ctk.CTkLabel(
            cont,
            text=f"Tiempo asignado: {fmt_hms(asignadas)}",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
        ).pack(anchor="w", pady=(4, 0))
        timer = ctk.CTkLabel(
            cont,
            text=fmt_hms(self.shift.seg_horas_extra),
            font=ctk.CTkFont(size=54, weight="bold"),
            text_color=TEXT_DARK,
        )
        timer.pack(expand=True)
        restante = ctk.CTkLabel(
            cont,
            text="",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color=WARNING,
        )
        restante.pack(pady=(0, 12))

        def refrescar():
            if not top.winfo_exists():
                return
            timer.configure(text=fmt_hms(self.shift.seg_horas_extra))
            asignadas_actual = getattr(self.shift, "horas_extra_asignadas_segundos", 0)
            faltan = max(0, asignadas_actual - self.shift.seg_horas_extra)
            restante.configure(text=f"Restante: {fmt_hms(faltan)}")
            if self.shift.horas_extra_estado != "ACTIVA":
                restante.configure(text="Horas extra finalizadas.")
                return
            top.after(1000, refrescar)

        def finalizar():
            self.shift.finalizar_horas_extra()
            top.destroy()

        ctk.CTkButton(
            cont,
            text="Finalizar horas extra",
            command=finalizar,
            fg_color=SURFACE,
            hover_color=APP_BG,
            text_color=TEXT_BODY,
            border_width=1,
            border_color=BORDER_STRONG,
            height=42,
            corner_radius=8,
        ).pack(fill="x")
        refrescar()

    def _technical_evidence_snapshot(self):
        now = datetime.datetime.now()
        last_capture = getattr(self.screens, "ultima", None)
        pending = count_pending()
        telemetry = getattr(self.shift, "ultimo_snapshot", {}) or {}
        samples = telemetry.get("muestras_recientes") or []
        last_sample = samples[-1] if samples else {}
        active_app = str(last_sample.get("proceso") or "").strip()
        active_title = str(last_sample.get("titulo") or "").strip()
        if not active_app or active_app == "(desconocido)":
            active_app = "(sin dato)"
        if not active_title or active_title == "(desconocido)":
            active_title = "(sin dato)"
        sync_label = "Local"
        try:
            if getattr(self.cfg, "drive_upload_enabled", False):
                sync_label = "Drive imagenes"
            elif pending:
                sync_label = f"{pending} eventos pendientes"
        except Exception:
            pass
        suggested_start = last_capture or self.shift.inicio_jornada or now
        if suggested_start > now:
            suggested_start = now
        gap_minutes = max(0, int((now - suggested_start).total_seconds() // 60))
        return {
            "estado_jornada": self.shift.estado,
            "captura_activa": bool(self.screens.activo),
            "ultima_captura": last_capture.isoformat() if last_capture else None,
            "ultima_captura_txt": last_capture.strftime("%H:%M") if last_capture else "Sin captura registrada",
            "eventos_pendientes": pending,
            "sincronizacion": sync_label,
            "inicio_sugerido": suggested_start.isoformat(),
            "fin_sugerido": now.isoformat(),
            "periodo_sugerido": f"{suggested_start:%H:%M} - {now:%H:%M}",
            "minutos_estimados": gap_minutes,
            "app_activa": active_app,
            "ventana_activa": active_title[:180],
            "idle_segundos": last_sample.get("idle_segundos"),
            "usuario_idle": bool(last_sample.get("is_idle", False)),
            "clics_recientes": telemetry.get("clics", 0),
            "cambios_ventana": telemetry.get("cambios_ventana", 0),
            "muestras_recientes": samples[-20:],
            "backend_habilitado": bool(getattr(self.cfg, "evidence_backend_enabled", False)),
            "equipo": socket.gethostname(),
            "usuario_windows": getpass.getuser(),
        }

    def _modal_falla_tecnica(self):
        evidencia = self._technical_evidence_snapshot()
        top = self._modal("Reportar falla tecnica", 560, 640)
        cont = ctk.CTkFrame(top, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=22, pady=20)

        ctk.CTkLabel(
            cont,
            text="Reportar falla tecnica",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text=(
                "VYNTRA adjuntara evidencia tecnica automaticamente. "
                "Esta solicitud no se aprueba como tiempo laboral hasta que RR. HH. la revise."
            ),
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=460,
            justify="left",
        ).pack(anchor="w", pady=(4, 14))

        ctk.CTkLabel(
            cont,
            text="Que ocurrio",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=TEXT_BODY,
        ).pack(anchor="w")
        tipo_problema = ctk.CTkOptionMenu(
            cont,
            values=[
                "No pude marcar entrada/salida",
                "La estacion no cargaba",
                "Aplicacion de trabajo lenta o congelada",
                "Internet caido",
                "Computadora reiniciada",
                "App cerrada o congelada",
                "Otro problema tecnico",
            ],
            fg_color=SURFACE_ALT,
            button_color=PRIMARY,
            button_hover_color=PRIMARY_DARK,
            text_color=TEXT_DARK,
        )
        tipo_problema.pack(fill="x", pady=(5, 12))

        evidence_card = ctk.CTkFrame(
            cont,
            fg_color=PRIMARY_LIGHT,
            corner_radius=10,
            border_width=1,
            border_color=BORDER_STRONG,
        )
        evidence_card.pack(fill="x", pady=(0, 12))

        rows = [
            ("Periodo sugerido", evidencia["periodo_sugerido"]),
            ("Minutos estimados", str(evidencia["minutos_estimados"])),
            ("App activa", evidencia["app_activa"]),
            ("Ventana activa", evidencia["ventana_activa"]),
            ("Estado de jornada", evidencia["estado_jornada"]),
            ("Ultima captura", evidencia["ultima_captura_txt"]),
            ("Sincronizacion", evidencia["sincronizacion"]),
            ("Captura activa", "Si" if evidencia["captura_activa"] else "No"),
        ]
        for label, value in rows:
            row = ctk.CTkFrame(evidence_card, fg_color="transparent")
            row.pack(fill="x", padx=14, pady=(10 if label == "Periodo sugerido" else 3, 0))
            ctk.CTkLabel(
                row,
                text=label,
                font=ctk.CTkFont(size=11, weight="bold"),
                text_color=TEXT_MUTED,
                width=140,
                anchor="w",
            ).pack(side="left")
            ctk.CTkLabel(
                row,
                text=value,
                font=ctk.CTkFont(size=12, weight="bold"),
                text_color=TEXT_DARK,
                anchor="w",
            ).pack(side="left", fill="x", expand=True)

        ctk.CTkLabel(
            cont,
            text="Comentario del empleado",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=TEXT_BODY,
        ).pack(anchor="w")
        comentario = ctk.CTkTextbox(
            cont,
            height=76,
            fg_color=SURFACE_ALT,
            text_color=TEXT_DARK,
            border_width=1,
            border_color=BORDER_STRONG,
        )
        comentario.pack(fill="x", pady=(5, 8))

        error = ctk.CTkLabel(cont, text="", text_color=DANGER, font=ctk.CTkFont(size=12))
        error.pack(anchor="w")

        def enviar():
            comentario_txt = comentario.get("1.0", "end").strip()
            if len(comentario_txt) < 6:
                error.configure(text="Agrega un comentario breve para contextualizar la falla.")
                return
            selected_problem = tipo_problema.get()
            current_evidence = self._technical_evidence_snapshot()
            app_failure_signal = (
                selected_problem == "Aplicacion de trabajo lenta o congelada"
                and current_evidence.get("app_activa") not in ("", "(sin dato)")
                and not current_evidence.get("usuario_idle")
            )
            detalle = {
                "motivo": comentario_txt,
                "problema": selected_problem,
                "verificacion": "pendiente",
                "falla_app_probable": app_failure_signal,
                "evidencia_tecnica": current_evidence,
            }
            registro = self.shift.registrar_excepcion("tiempo_perdido", detalle)
            top.destroy()
            self._modal_solicitud_enviada("Falla tecnica", registro)

        ctk.CTkButton(
            cont,
            text="Enviar para verificacion",
            command=enviar,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            height=42,
            corner_radius=8,
            text_color="#FFFFFF",
            font=ctk.CTkFont(weight="bold"),
        ).pack(side="bottom", fill="x", pady=(12, 0))

    def _modal_excepcion(self, tipo, titulo):
        top = self._modal(titulo, 440, 360)
        ctk.CTkLabel(
            top,
            text=titulo,
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w", padx=20, pady=(20, 4))
        ctk.CTkLabel(
            top,
            text="Esta solicitud se registra para revision de RR. HH.",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
        ).pack(anchor="w", padx=20)

        ctk.CTkLabel(
            top,
            text="Horas (si aplica)",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_BODY,
        ).pack(anchor="w", padx=20, pady=(14, 2))
        entry_horas = ctk.CTkEntry(
            top,
            placeholder_text="Ej: 2",
            fg_color=SURFACE_ALT,
            border_color=BORDER_STRONG,
            text_color=TEXT_DARK,
        )
        entry_horas.pack(fill="x", padx=20)

        ctk.CTkLabel(
            top,
            text="Motivo",
            font=ctk.CTkFont(size=12),
            text_color=TEXT_BODY,
        ).pack(anchor="w", padx=20, pady=(12, 2))
        motivo = ctk.CTkTextbox(
            top, height=80, fg_color=SURFACE_ALT, text_color=TEXT_DARK,
            border_width=1, border_color=BORDER_STRONG,
        )
        motivo.pack(fill="x", padx=20)

        error = ctk.CTkLabel(top, text="", text_color=DANGER, font=ctk.CTkFont(size=12))
        error.pack(anchor="w", padx=20, pady=(8, 0))

        def enviar():
            motivo_txt = motivo.get("1.0", "end").strip()
            if len(motivo_txt) < 8:
                error.configure(text="Describe el motivo con un poco mas de detalle.")
                return
            registro = self.shift.registrar_excepcion(
                tipo,
                {
                    "horas": entry_horas.get().strip(),
                    "motivo": motivo_txt,
                },
            )
            top.destroy()
            self._modal_solicitud_enviada(titulo, registro)

        ctk.CTkButton(
            top,
            text="Enviar solicitud",
            command=enviar,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            height=40,
            corner_radius=8,
            text_color="#FFFFFF",
            font=ctk.CTkFont(weight="bold"),
        ).pack(side="bottom", fill="x", padx=20, pady=16)

    def _modal_solicitud_enviada(self, titulo, registro):
        top = self._modal("Solicitud enviada", 440, 270)
        cont = ctk.CTkFrame(top, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=22, pady=20)
        ctk.CTkLabel(
            cont,
            text="Solicitud registrada",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=SUCCESS,
        ).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text=(
                f"{titulo} quedo pendiente de revision. "
                "RR. HH. o tu supervisor podra aprobarla, rechazarla o cerrarla desde el panel."
            ),
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=390,
            justify="left",
        ).pack(anchor="w", pady=(8, 12))
        ctk.CTkLabel(
            cont,
            text=f"Referencia local: {registro.get('source_event_id') or 'pendiente de sincronizar'}",
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color=TEXT_BODY,
            wraplength=390,
            justify="left",
        ).pack(anchor="w")
        ctk.CTkButton(
            cont,
            text="Entendido",
            command=top.destroy,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            height=40,
            corner_radius=8,
            text_color="#FFFFFF",
            font=ctk.CTkFont(weight="bold"),
        ).pack(side="bottom", fill="x")

    def _modal_restaurar(self):
        top = self._modal("Restaurar jornada laboral", 460, 300)
        cont = ctk.CTkFrame(top, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=22, pady=20)
        ctk.CTkLabel(
            cont,
            text="Restaurar jornada laboral",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text=(
                "Ingresa el codigo unico generado desde el panel web. "
                "Debe estar vigente y asignado a este usuario."
            ),
            font=ctk.CTkFont(size=12),
            text_color=TEXT_MUTED,
            wraplength=400,
            justify="left",
        ).pack(anchor="w", pady=(6, 12))

        codigo = ctk.CTkEntry(
            cont,
            placeholder_text="Ej: VX-7K2P9",
            fg_color=SURFACE_ALT,
            border_color=BORDER_STRONG,
            text_color=TEXT_DARK,
        )
        codigo.pack(fill="x")

        error = ctk.CTkLabel(
            cont, text="", font=ctk.CTkFont(size=12), text_color=DANGER
        )
        error.pack(anchor="w", pady=(6, 0))

        def validar():
            if self.shift.restaurar_jornada_con_codigo(codigo.get().strip()):
                top.destroy()
            else:
                error.configure(
                    text=self.shift.ultimo_error_codigo
                    or "Codigo invalido, vencido o ya utilizado."
                )

        ctk.CTkButton(
            cont,
            text="Reabrir jornada",
            command=validar,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            height=38,
            corner_radius=8,
            text_color="#FFFFFF",
            font=ctk.CTkFont(weight="bold"),
        ).pack(fill="x", pady=(10, 0))

    def _btn_restaurar(self, parent, texto, accion, top):
        def hacer():
            accion()
            top.destroy()

        ctk.CTkButton(
            parent,
            text=texto,
            command=hacer,
            height=38,
            corner_radius=8,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            text_color="#FFFFFF",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", pady=4)

    def _on_screen_event(self, msg):
        if msg.startswith("Captura "):
            self._ultima_captura_txt = msg.replace("Captura ", "", 1)[:5]

    def _on_sync_event(self, msg):
        try:
            self.after(0, self._refresh_sync_status)
        except Exception:
            pass

    def _on_rules_event(self, msg):
        try:
            self.after(0, self._refresh_sync_status)
        except Exception:
            pass

    def _build_fallback_ui(self, error_text):
        self._clear_window_contents()
        frame = ctk.CTkFrame(self, fg_color=SURFACE, corner_radius=12,
                             border_width=1, border_color=BORDER)
        frame.pack(fill="both", expand=True, padx=24, pady=24)
        ctk.CTkLabel(
            frame,
            text="No fue posible cargar la estación de marcaje",
            font=ctk.CTkFont(size=20, weight="bold"),
            text_color=TEXT_DARK,
        ).pack(anchor="w", padx=24, pady=(24, 8))
        ctk.CTkLabel(
            frame,
            text=(
                "La interfaz se reabrió en modo seguro. Revisa la consola para ver el detalle exacto "
                "y podrás seguir usando la app."
            ),
            font=ctk.CTkFont(size=13),
            text_color=TEXT_MUTED,
            wraplength=720,
            justify="left",
        ).pack(anchor="w", padx=24, pady=(0, 12))
        ctk.CTkLabel(
            frame,
            text=error_text,
            font=ctk.CTkFont(size=11),
            text_color=DANGER,
            wraplength=720,
            justify="left",
        ).pack(anchor="w", padx=24, pady=(0, 18))
        ctk.CTkButton(
            frame,
            text="Reintentar",
            command=self._retry_initialization,
            fg_color=PRIMARY,
            hover_color=PRIMARY_DARK,
            height=42,
            corner_radius=8,
            text_color="#FFFFFF",
        ).pack(anchor="e", padx=24, pady=(0, 24))

    def _clear_window_contents(self):
        for child in self.winfo_children():
            child.destroy()

    def _retry_initialization(self):
        self._clear_window_contents()
        self._ui_error = None
        try:
            self._build()
            self.protocol("WM_DELETE_WINDOW", self._al_cerrar)
            self._render_controles()
            self._pintar_estado_items()
            self.shift.resume_runtime_if_needed()
            self._refresh_sync_status()
            self.after(200, lambda: self._draw_clock(0))
        except Exception as exc:
            self._ui_error = exc
            self._build_fallback_ui(str(exc))

    def _on_state(self, estado):
        def _apply():
            texto, color, bg = ESTADO_INFO.get(estado, (estado, NEUTRAL_TEXT, NEUTRAL_BG))
            self.badge.configure(text=f"  {texto}  ", text_color=color, fg_color=bg)
            if self.screens.activo:
                self.lbl_captura_estado.configure(
                    text=" Captura activa ", text_color=SUCCESS, fg_color=SUCCESS_BG
                )
            else:
                self.lbl_captura_estado.configure(
                    text=" Captura detenida ", text_color=NEUTRAL_TEXT, fg_color=NEUTRAL_BG
                )
            self._render_controles()
            self._pintar_estado_items()
            self._draw_clock(self.shift.seg_trabajado)
            self._refresh_sync_status()
            # El hilo del reloj se detiene al finalizar la jornada (o al
            # cargar el estado inicial), asi que estas tarjetas no se
            # refrescan solas via _on_tick: se actualizan aqui para que el
            # reinicio a 0 horas se vea de inmediato al pulsar
            # "Finalizar jornada".
            self.lbl_break.configure(text=fmt_hms(self.shift.seg_break))
            self.lbl_lunch.configure(text=fmt_hms(self.shift.seg_lunch))
            self.lbl_extra.configure(text=fmt_hms(self.shift.seg_horas_extra))

        try:
            self.after(0, _apply)
        except Exception:
            pass

    def _on_tick(self, info):
        def _apply():
            self.lbl_hora.configure(text=info["hora"])
            self.lbl_break.configure(text=fmt_hms(info["break"]))
            self.lbl_lunch.configure(text=fmt_hms(info["lunch"]))
            self.lbl_extra.configure(text=fmt_hms(info.get("horas_extra", 0)))
            self.lbl_ultima_captura.configure(text=self._ultima_captura_txt)
            self._draw_clock(info["trabajado"])
            self._pintar_estado_items()
            self._refresh_sync_status()

        try:
            self.after(0, _apply)
        except Exception:
            pass

    def _refresh_sync_status(self):
        pendientes = count_pending()
        if getattr(self.cfg, "drive_upload_enabled", False):
            self.lbl_sync.configure(text="Drive imagenes")
        elif pendientes:
            self.lbl_sync.configure(text=f"{pendientes} pendientes")
        else:
            self.lbl_sync.configure(text="Local")

    def _start_healthcheck(self):
        """Verifica cada 60s que los threads críticos sigan vivos."""
        def check():
            try:
                shift_ok = self.shift._running or self.shift.estado == "FUERA"
                tracker_ok = self.shift.tracker.activo or self.shift.estado == "FUERA"
                screens_ok = self.screens._running or not self.screens.activo

                if not (shift_ok and tracker_ok and screens_ok):
                    self._on_state(self.shift.estado)
            except Exception:
                pass
            if hasattr(self, "winfo_exists") and self.winfo_exists():
                self.after(60000, check)

        self.after(60000, check)

    def _al_cerrar(self):
        if self.shift.estado in ("TRABAJANDO", "BREAK", "LUNCH"):
            self.shift.shutdown_runtime()
        try:
            self.event_uploader.process_pending(limit=100)
        except Exception:
            pass
        self.event_uploader.stop()
        self.destroy()


def _mensaje_rechazo(cfg: Config):
    aviso = ctk.CTk()
    aviso.title("VYNTRA")
    aviso.geometry("420x220")
    aviso.configure(fg_color=CONSENT_BG)

    marco = ctk.CTkFrame(aviso, fg_color="transparent")
    marco.pack(expand=True, fill="both", padx=28, pady=28)
    ctk.CTkLabel(
        marco,
        text="No se activo el monitoreo",
        font=ctk.CTkFont(size=18, weight="bold"),
        text_color=CONSENT_TEXT,
    ).pack(anchor="w")
    ctk.CTkLabel(
        marco,
        text=f"No se capturara nada en este equipo.\n\nContacta a {cfg.correo_contacto}.",
        font=ctk.CTkFont(size=13),
        text_color=CONSENT_MUTED,
        justify="left",
    ).pack(anchor="w", pady=(10, 20))
    ctk.CTkButton(
        marco,
        text="Entendido",
        command=aviso.destroy,
        fg_color=PRIMARY,
        hover_color=PRIMARY_DARK,
        text_color="#FFFFFF",
        height=40,
    ).pack(anchor="e")
    aviso.mainloop()


def main():
    ctk.set_appearance_mode("light")
    cfg = Config()

    # 1) Login: se pide cada vez que se abre la app. Esta identidad permite
    #    asociar el consentimiento y la jornada con la credencial del empleado.
    login = LoginWindow(cfg)
    login.mainloop()
    if login.decision is not True:
        sys.exit(0)

    auth_email = login.authenticated_email

    # 2) Consentimiento: aparece una vez por usuario autenticado en este equipo.
    #    Asi el registro legal queda asociado a la credencial que abrio la
    #    estacion de marcaje.
    consentimiento = load_consent(auth_email)

    if consentimiento is None:
        ventana = ConsentWindow(cfg)
        ventana.mainloop()

        if ventana.decision is not True:
            save_consent(False, auth_email=auth_email)
            try:
                AgentEventUploader(cfg).process_pending(limit=20)
            except Exception:
                pass
            _mensaje_rechazo(cfg)
            sys.exit(0)

        consentimiento = save_consent(True, ventana.detalles, auth_email=auth_email)

    elif consentimiento.get("aceptado") is not True:
        _mensaje_rechazo(cfg)
        sys.exit(0)

    StationWindow(cfg, consentimiento, auth_email).mainloop()


if __name__ == "__main__":
    main()
