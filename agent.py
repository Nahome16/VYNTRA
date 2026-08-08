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
import json
import os
import socket
import sys
import tkinter as tk

import customtkinter as ctk

from config import Config
from outbox import append_event, count_pending
from screenshots import ScreenshotEngine
from shift import ShiftManager, fmt_hms


VERSION = "1.0.0"


# Paleta VYNTRA aprobada
NAV_BG = "#001D39"
NAV_HEAD = "#001D39"
NAV_CARD = "#0A4174"
NAV_CARD2 = "#0E3358"
NAV_BORDER = "#14375C"
NAV_BORDER2 = "#1C4C7A"
NAV_ACCENT = "#7BBDE8"
NAV_ACCENT_D = "#49769F"
NAV_TX = "#EAF6FF"
NAV_TX2 = "#9FBCD1"
NAV_LIGHT = "#7BBDE8"
NAV_GREEN = "#77D8AE"
NAV_AMBER = "#F2C96D"
NAV_PILL = "#0A3A63"
NAV_DANGER_TX = "#F3B5C0"
NAV_MODAL_ENTRY = "#07345D"

CONSENT_BG = "#F4F7FA"
CONSENT_PANEL = "#FFFFFF"
CONSENT_TEXT = "#122033"
CONSENT_MUTED = "#64748B"

ESTADO_INFO = {
    "FUERA": ("Fuera de jornada", "#9FBCD1"),
    "TRABAJANDO": ("Jornada activa", NAV_GREEN),
    "BREAK": ("En break", NAV_AMBER),
    "LUNCH": ("En almuerzo", NAV_AMBER),
    "TERMINADO": ("Jornada finalizada", "#9FBCD1"),
}


# ==========================================================================
# Consentimiento
# ==========================================================================
def _consent_path() -> str:
    base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
    carpeta = os.path.join(base, "VYNTRA")
    os.makedirs(carpeta, exist_ok=True)
    return os.path.join(carpeta, "consent.json")


def load_consent() -> dict | None:
    try:
        with open(_consent_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_consent(aceptado: bool, detalles: dict | None = None) -> dict:
    registro = {
        "aceptado": aceptado,
        "empleado": getpass.getuser(),
        "equipo": socket.gethostname(),
        "fechaHora": datetime.datetime.now().isoformat(),
        "version": VERSION,
        "autorizaciones": detalles or {},
    }
    with open(_consent_path(), "w", encoding="utf-8") as f:
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
        self.geometry("860x620")
        self.minsize(800, 560)
        self.configure(fg_color=CONSENT_BG)

        self._build()

    def _build(self):
        header = ctk.CTkFrame(self, fg_color=NAV_BG, corner_radius=0, height=86)
        header.pack(fill="x")
        header.pack_propagate(False)
        h = ctk.CTkFrame(header, fg_color="transparent")
        h.pack(fill="both", expand=True, padx=26, pady=16)

        ctk.CTkLabel(h, text="VYNTRA",
                    font=ctk.CTkFont(size=23, weight="bold"),
                    text_color="#FFFFFF").pack(anchor="w")
        ctk.CTkLabel(h, text="Autorizacion para participar en programa piloto",
                    font=ctk.CTkFont(size=13),
                    text_color=NAV_TX2).pack(anchor="w", pady=(4, 0))

        body = ctk.CTkFrame(self, fg_color=CONSENT_PANEL, corner_radius=8)
        body.pack(fill="both", expand=True, padx=24, pady=22)

        content = ctk.CTkScrollableFrame(body, fg_color="transparent")
        content.pack(fill="both", expand=True, padx=20, pady=18)

        ctk.CTkLabel(content, text="Antes de continuar",
                    font=ctk.CTkFont(size=20, weight="bold"),
                    text_color=CONSENT_TEXT).pack(anchor="w")
        ctk.CTkLabel(
            content,
            text=(
                f"{self.cfg.empresa} usara VYNTRA para registrar jornada, pausas, "
                "capturas durante horario laboral, estado de actividad y solicitudes "
                "relacionadas con asistencia. La app permanece visible."
            ),
            font=ctk.CTkFont(size=13),
            text_color=CONSENT_MUTED,
            wraplength=760,
            justify="left",
        ).pack(anchor="w", pady=(8, 16))

        self._section(content, "Que registra")
        for text in [
            "Inicio, break, almuerzo y finalizacion de jornada.",
            "Capturas de pantalla durante jornada activa.",
            "Aplicacion o ventana activa para fines administrativos.",
            "Solicitudes de incidencia enviadas por el usuario.",
        ]:
            self._bullet(content, text)

        self._section(content, "Limites")
        for text in [
            "No registra contrasenas.",
            "No captura contenido escrito con el teclado.",
            "No activa camara ni microfono.",
            "No funciona de forma oculta.",
        ]:
            self._bullet(content, text)

        self._section(content, "Autorizaciones requeridas")
        for text in [
            "Confirmo que lei y comprendo este aviso.",
            "Confirmo que mi empleador me informo las finalidades de uso.",
            "Autorizo el registro de mi jornada laboral.",
            "Autorizo capturas de pantalla durante mi jornada.",
        ]:
            self._checkbox(content, text)

        footer = ctk.CTkFrame(self, fg_color=CONSENT_BG, corner_radius=0, height=70)
        footer.pack(fill="x", side="bottom")
        footer.pack_propagate(False)
        row = ctk.CTkFrame(footer, fg_color="transparent")
        row.pack(fill="both", expand=True, padx=24)
        ctk.CTkLabel(row, text=f"Contacto: {self.cfg.correo_contacto}",
                    font=ctk.CTkFont(size=12),
                    text_color=CONSENT_MUTED).pack(side="left")

        ctk.CTkButton(row, text="No aceptar y salir", command=self._rechazar,
                     fg_color="#FFFFFF", text_color=CONSENT_TEXT,
                     hover_color="#E8EEF5", border_width=1,
                     border_color="#CBD5E1", width=150, height=40,
                     corner_radius=8).pack(side="right")
        self.btn_aceptar = ctk.CTkButton(
            row,
            text="Aceptar y continuar",
            command=self._aceptar,
            state="disabled",
            fg_color="#CBD5E1",
            text_color="#94A3B8",
            hover_color=NAV_ACCENT_D,
            width=170,
            height=40,
            corner_radius=8,
            font=ctk.CTkFont(size=13, weight="bold"),
        )
        self.btn_aceptar.pack(side="right", padx=(0, 10))

    def _section(self, parent, title):
        ctk.CTkLabel(parent, text=title,
                    font=ctk.CTkFont(size=14, weight="bold"),
                    text_color=CONSENT_TEXT).pack(anchor="w", pady=(12, 6))

    def _bullet(self, parent, text):
        row = ctk.CTkFrame(parent, fg_color="transparent")
        row.pack(fill="x", pady=2)
        ctk.CTkLabel(row, text="-", width=16, text_color=NAV_ACCENT,
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
                       fg_color=NAV_ACCENT, hover_color=NAV_ACCENT_D).pack(
            side="left", anchor="n", pady=2)
        ctk.CTkLabel(row, text=text, text_color=CONSENT_TEXT,
                    font=ctk.CTkFont(size=12), justify="left",
                    wraplength=710).pack(side="left", padx=(6, 0))

    def _validar(self):
        listo = all(v.get() for v in self.req_vars)
        if listo:
            self.btn_aceptar.configure(
                state="normal", fg_color=NAV_ACCENT, text_color=NAV_BG
            )
        else:
            self.btn_aceptar.configure(
                state="disabled", fg_color="#CBD5E1", text_color="#94A3B8"
            )

    def _aceptar(self):
        self.decision = True
        self.detalles = {
            "leido_aviso": True,
            "empleador_informo": True,
            "registro_jornada": True,
            "capturas_pantalla": True,
        }
        self.destroy()

    def _rechazar(self):
        self.decision = False
        self.destroy()


# ==========================================================================
# Estacion de marcaje
# ==========================================================================
class StationWindow(ctk.CTk):
    def __init__(self, cfg: Config, consentimiento: dict):
        super().__init__()
        self.cfg = cfg
        self.consentimiento = consentimiento
        self.shift = ShiftManager(cfg, on_state=self._on_state, on_tick=self._on_tick)
        self.screens = ScreenshotEngine(cfg, on_event=self._on_screen_event)
        self.shift.on_shift_start = self.screens.start
        self.shift.on_shift_pause = self.screens.pause
        self.shift.on_shift_resume = self.screens.resume
        self.shift.on_shift_end = self.screens.stop
        self._ultima_captura_txt = "--:--"
        self._ui_error = None

        self.title("VYNTRA - Estacion de marcaje")
        self.geometry("1040x700")
        self.minsize(980, 640)
        self.configure(fg_color=NAV_BG)

        try:
            self._build()
            self.protocol("WM_DELETE_WINDOW", self._al_cerrar)
            self._render_controles()
            self._pintar_estado_items()
            self.shift.resume_runtime_if_needed()
            self._refresh_sync_status()
            self.after(200, lambda: self._draw_clock(0))
            self._start_healthcheck()
        except Exception as exc:
            self._ui_error = exc
            self._build_fallback_ui(str(exc))

    def _build(self):
        self._barra_superior()

        shell = ctk.CTkFrame(self, fg_color="transparent")
        shell.pack(fill="both", expand=True, padx=18, pady=18)
        shell.grid_columnconfigure(0, weight=58, uniform="main")
        shell.grid_columnconfigure(1, weight=42, uniform="main")
        shell.grid_rowconfigure(0, weight=1)

        left = ctk.CTkFrame(
            shell,
            fg_color=NAV_CARD,
            corner_radius=8,
            border_width=1,
            border_color=NAV_BORDER,
        )
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 9))

        right = ctk.CTkFrame(shell, fg_color="transparent")
        right.grid(row=0, column=1, sticky="nsew", padx=(9, 0))

        self._panel_reloj(left)
        self._panel_logo(right)
        self._panel_estado(right)
        self._panel_soporte(right)

    def _barra_superior(self):
        bar = ctk.CTkFrame(self, fg_color=NAV_HEAD, corner_radius=0, height=64)
        bar.pack(fill="x")
        bar.pack_propagate(False)
        cont = ctk.CTkFrame(bar, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=22)

        marca = ctk.CTkFrame(cont, fg_color="transparent")
        marca.pack(side="left", anchor="center")
        ctk.CTkLabel(
            marca,
            text="V",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color="#FFFFFF",
            fg_color=NAV_ACCENT_D,
            corner_radius=7,
            width=34,
            height=34,
        ).pack(side="left", padx=(0, 10))

        textos = ctk.CTkFrame(marca, fg_color="transparent")
        textos.pack(side="left")
        ctk.CTkLabel(
            textos,
            text="VYNTRA",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=NAV_TX,
        ).pack(anchor="w")
        ctk.CTkLabel(
            textos,
            text="Estacion de marcaje",
            font=ctk.CTkFont(size=11),
            text_color=NAV_TX2,
        ).pack(anchor="w")

        der = ctk.CTkFrame(cont, fg_color="transparent")
        der.pack(side="right", anchor="center")
        self.badge = ctk.CTkLabel(
            der,
            text="  Jornada inactiva  ",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=NAV_TX,
            fg_color=NAV_PILL,
            corner_radius=14,
            height=34,
        )
        self.badge.pack(side="left", padx=(0, 8))
        ctk.CTkLabel(
            der,
            text=f"  {getpass.getuser()} - {socket.gethostname()}  ",
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX,
            fg_color=NAV_PILL,
            corner_radius=14,
            height=34,
        ).pack(side="left", padx=(0, 8))
        ctk.CTkButton(
            der,
            text="!",
            width=34,
            height=34,
            corner_radius=17,
            fg_color=NAV_PILL,
            hover_color=NAV_CARD2,
            command=self._modal_incidencia,
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(side="left")

    def _panel_reloj(self, parent):
        parent.grid_columnconfigure(0, weight=1)
        parent.grid_rowconfigure(1, weight=1)

        head = ctk.CTkFrame(parent, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=22, pady=(22, 0))
        head.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            head,
            text="TURNO ACTUAL",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=NAV_TX2,
        ).grid(row=0, column=0, sticky="w")
        ctk.CTkLabel(
            head,
            text="Operacion BPO - Managua",
            font=ctk.CTkFont(size=24, weight="bold"),
            text_color=NAV_TX,
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))

        self.lbl_captura_estado = ctk.CTkLabel(
            head,
            text=" Captura detenida ",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=NAV_TX,
            fg_color=NAV_PILL,
            corner_radius=14,
            height=34,
        )
        self.lbl_captura_estado.grid(row=0, column=1, rowspan=2, sticky="e")

        clock_box = ctk.CTkFrame(parent, fg_color="transparent")
        clock_box.grid(row=1, column=0, sticky="nsew", padx=22, pady=(8, 0))
        clock_box.grid_columnconfigure(0, weight=1)
        clock_box.grid_rowconfigure(0, weight=1)

        self.clock_canvas = tk.Canvas(
            clock_box,
            width=340,
            height=340,
            bg=NAV_CARD,
            highlightthickness=0,
        )
        self.clock_canvas.grid(row=0, column=0)

        self.ctrl_inner = ctk.CTkFrame(parent, fg_color="transparent")
        self.ctrl_inner.grid(row=2, column=0, sticky="ew", padx=22, pady=(6, 0))

        metrics = ctk.CTkFrame(parent, fg_color="transparent")
        metrics.grid(row=3, column=0, sticky="ew", padx=22, pady=(12, 22))
        for i in range(4):
            metrics.grid_columnconfigure(i, weight=1, uniform="m")

        self.lbl_hora = self._metric_card(metrics, 0, "HORA ACTUAL", "--:--:--")
        self.lbl_break = self._metric_card(metrics, 1, "BREAK USADO", "00:00:00")
        self.lbl_lunch = self._metric_card(metrics, 2, "ALMUERZO USADO", "00:00:00")
        self.lbl_extra = self._metric_card(metrics, 3, "HORAS EXTRA", "00:00:00")

    def _metric_card(self, parent, col, title, value):
        card = ctk.CTkFrame(
            parent,
            fg_color=NAV_MODAL_ENTRY,
            corner_radius=8,
            border_width=1,
            border_color=NAV_BORDER,
        )
        card.grid(row=0, column=col, sticky="ew", padx=(0 if col == 0 else 6, 0))
        ctk.CTkLabel(
            card,
            text=title,
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color=NAV_TX2,
        ).pack(anchor="w", padx=14, pady=(12, 2))
        lbl = ctk.CTkLabel(
            card,
            text=value,
            font=ctk.CTkFont(size=20, weight="bold"),
            text_color=NAV_TX,
        )
        lbl.pack(anchor="w", padx=14, pady=(0, 12))
        return lbl

    def _panel_logo(self, parent):
        card = ctk.CTkFrame(
            parent,
            fg_color=NAV_CARD,
            corner_radius=8,
            border_width=1,
            border_color=NAV_BORDER,
            height=164,
        )
        card.pack(fill="x", pady=(0, 14))
        card.pack_propagate(False)

        inner = ctk.CTkFrame(card, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=22, pady=20)

        ctk.CTkLabel(
            inner,
            text="V",
            font=ctk.CTkFont(size=38, weight="bold"),
            text_color="#FFFFFF",
            fg_color=NAV_ACCENT_D,
            corner_radius=16,
            width=78,
            height=78,
        ).pack(side="left", padx=(0, 18))

        copy = ctk.CTkFrame(inner, fg_color="transparent")
        copy.pack(side="left", fill="both", expand=True)
        ctk.CTkLabel(
            copy,
            text="VYNTRA",
            font=ctk.CTkFont(size=28, weight="bold"),
            text_color=NAV_TX,
        ).pack(anchor="w", pady=(10, 0))
        ctk.CTkLabel(
            copy,
            text="Agente empresarial",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=NAV_LIGHT,
        ).pack(anchor="w")
        ctk.CTkLabel(
            copy,
            text="Agente de marcaje laboral instalado en este equipo.",
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX2,
            wraplength=330,
            justify="left",
        ).pack(anchor="w", pady=(12, 0))

    def _panel_estado(self, parent):
        card = ctk.CTkFrame(
            parent,
            fg_color=NAV_CARD,
            corner_radius=8,
            border_width=1,
            border_color=NAV_BORDER,
        )
        card.pack(fill="x", pady=(0, 14))
        inner = ctk.CTkFrame(card, fg_color="transparent")
        inner.pack(fill="x", padx=16, pady=16)

        head = ctk.CTkFrame(inner, fg_color="transparent")
        head.pack(fill="x", pady=(0, 10))
        ctk.CTkLabel(
            head,
            text="Estado de jornada",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color=NAV_TX,
        ).pack(side="left")
        ctk.CTkLabel(
            head,
            text="Registro visible",
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX2,
        ).pack(side="right")

        self.estado_items = ctk.CTkFrame(inner, fg_color="transparent")
        self.estado_items.pack(fill="x")

    def _panel_soporte(self, parent):
        card = ctk.CTkFrame(
            parent,
            fg_color=NAV_CARD,
            corner_radius=8,
            border_width=1,
            border_color=NAV_BORDER,
        )
        card.pack(fill="both", expand=True)
        inner = ctk.CTkFrame(card, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=16, pady=16)

        head = ctk.CTkFrame(inner, fg_color="transparent")
        head.pack(fill="x", pady=(0, 12))
        ctk.CTkLabel(
            head,
            text="Incidencias y ajustes",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color=NAV_TX,
        ).pack(side="left")
        ctk.CTkLabel(
            head,
            text="Solicitudes",
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX2,
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
            fg_color=NAV_ACCENT_D,
            hover_color=NAV_ACCENT,
            text_color="#FFFFFF",
            corner_radius=8,
            height=46,
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", pady=(10, 0))

    def _support_card(self, parent, col, icon, title, detail):
        card = ctk.CTkFrame(
            parent,
            fg_color=NAV_MODAL_ENTRY,
            corner_radius=8,
            border_width=1,
            border_color=NAV_BORDER,
        )
        card.grid(row=0, column=col, sticky="ew", padx=(0 if col == 0 else 6, 0))

        ctk.CTkLabel(
            card,
            text=icon,
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=NAV_LIGHT,
            fg_color=NAV_CARD2,
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
            text_color=NAV_TX,
        ).pack(anchor="w")
        lbl = ctk.CTkLabel(
            texts,
            text=detail,
            font=ctk.CTkFont(size=11),
            text_color=NAV_TX2,
        )
        lbl.pack(anchor="w")
        return lbl

    def _draw_clock(self, segundos):
        try:
            c = getattr(self, "clock_canvas", None)
            if c is None or not c.winfo_exists():
                return
            c.delete("all")
            w = int(c["width"]) or 340
            h = int(c["height"]) or 340
            pad = 32
            box = (pad, pad, w - pad, h - pad)
            progress = min(max(segundos / (8 * 3600), 0), 1)
            break_progress = min(max(self.shift.seg_break / 3600, 0), 1)

            c.create_oval(box, outline="#173E66", width=28)
            c.create_arc(
                box,
                start=130,
                extent=-360 * progress,
                style="arc",
                outline=NAV_LIGHT,
                width=28,
            )

            inner = (pad + 22, pad + 22, w - pad - 22, h - pad - 22)
            c.create_oval(inner, outline="#244F75", width=18)
            c.create_arc(
                inner,
                start=210,
                extent=-220 * break_progress,
                style="arc",
                outline=NAV_GREEN,
                width=18,
            )

            c.create_text(
                w / 2,
                h / 2 - 16,
                text=fmt_hms(segundos),
                fill=NAV_TX,
                font=("Segoe UI", 48, "bold"),
            )
            c.create_text(
                w / 2,
                h / 2 + 42,
                text="Tiempo trabajado hoy",
                fill=NAV_TX2,
                font=("Segoe UI", 12, "bold"),
            )
        except Exception:
            try:
                c = getattr(self, "clock_canvas", None)
                if c is not None:
                    c.delete("all")
                    c.create_text(10, 10, anchor="nw", text="Reloj no disponible", fill=NAV_TX)
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
                bg = NAV_LIGHT if active else NAV_CARD2
                tx = NAV_BG if active else NAV_LIGHT
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
                    text_color=NAV_TX,
                ).pack(side="left", padx=(12, 0))
                ctk.CTkLabel(
                    row,
                    text=detail,
                    font=ctk.CTkFont(size=12),
                    text_color=NAV_TX2,
                ).pack(side="right")
        except Exception:
            if hasattr(self, "estado_items") and self.estado_items.winfo_exists():
                for w in self.estado_items.winfo_children():
                    w.destroy()
                ctk.CTkLabel(
                    self.estado_items,
                    text="No fue posible mostrar el estado de la jornada.",
                    font=ctk.CTkFont(size=12),
                    text_color=NAV_TX2,
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
                color = NAV_ACCENT_D if primary else NAV_MODAL_ENTRY
                hover = NAV_ACCENT if primary else NAV_CARD2
                ctk.CTkButton(
                    parent,
                    text=texto,
                    command=cmd,
                    height=50,
                    corner_radius=8,
                    fg_color=color,
                    hover_color=hover,
                    text_color="#FFFFFF",
                    border_width=0 if primary else 1,
                    border_color=NAV_BORDER2,
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
                    text_color=NAV_TX2,
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
                text_color=NAV_TX2,
                wraplength=540,
            ).pack(anchor="w", pady=8)

    def _modal(self, titulo, ancho, alto):
        top = ctk.CTkToplevel(self)
        top.title(titulo)
        top.geometry(f"{ancho}x{alto}")
        top.configure(fg_color=NAV_BG)
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
            text_color=NAV_TX,
            wraplength=360,
        ).pack(padx=24, pady=(28, 6))
        if detalle:
            ctk.CTkLabel(
                top,
                text=detalle,
                font=ctk.CTkFont(size=12),
                text_color=NAV_TX2,
                wraplength=360,
            ).pack(padx=24)

        fila = ctk.CTkFrame(top, fg_color="transparent")
        fila.pack(pady=20)
        ctk.CTkButton(
            fila,
            text="Cancelar",
            command=top.destroy,
            fg_color=NAV_MODAL_ENTRY,
            hover_color=NAV_CARD2,
            border_width=1,
            border_color=NAV_BORDER2,
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
            fg_color=NAV_ACCENT_D,
            hover_color=NAV_ACCENT,
            width=150,
            height=40,
            corner_radius=8,
            font=ctk.CTkFont(weight="bold"),
        ).pack(side="left", padx=6)

    def _modal_incidencia(self):
        top = self._modal("Incidencias y ajustes", 500, 460)
        cont = ctk.CTkFrame(top, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=22, pady=20)
        ctk.CTkLabel(
            cont,
            text="Incidencias y ajustes",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=NAV_TX,
        ).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text="Selecciona el tipo de solicitud o correccion.",
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX2,
        ).pack(anchor="w", pady=(4, 14))

        opciones = [
            ("Restaurar jornada laboral", "restaurar"),
            ("Horas extra", "horas_extra"),
            ("Correccion de marcaje", "correccion_marcaje"),
            ("Permisos o vacaciones", "permiso_vacaciones"),
            ("Tiempo perdido por sistema", "tiempo_perdido"),
        ]
        for texto, tipo in opciones:
            def abrir(t=tipo, x=texto):
                top.destroy()
                if t == "restaurar":
                    self._modal_restaurar()
                elif t == "horas_extra":
                    self._modal_horas_extra()
                else:
                    self._modal_excepcion(t, x)

            ctk.CTkButton(
                cont,
                text=texto,
                command=abrir,
                height=42,
                fg_color=NAV_MODAL_ENTRY,
                hover_color=NAV_CARD2,
                border_width=1,
                border_color=NAV_BORDER2,
                corner_radius=8,
                font=ctk.CTkFont(size=13, weight="bold"),
            ).pack(fill="x", pady=4)

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
            text_color=NAV_TX,
        ).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text=(
                "Ingresa el codigo de un solo uso enviado por tu jefe o administrador. "
                "El cronometro solo marcara el tiempo autorizado."
            ),
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX2,
            wraplength=440,
            justify="left",
        ).pack(anchor="w", pady=(4, 14))

        ctk.CTkLabel(cont, text="Codigo de autorizacion", text_color="#CFE0F0").pack(anchor="w")
        codigo = ctk.CTkEntry(
            cont,
            placeholder_text="Ej: HE-120-X7K2",
            fg_color=NAV_MODAL_ENTRY,
            border_color=NAV_BORDER2,
            text_color=NAV_TX,
        )
        codigo.pack(fill="x", pady=(4, 8))

        error = ctk.CTkLabel(cont, text="", text_color=NAV_DANGER_TX)
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
                error.configure(text="Codigo invalido, vencido o ya utilizado.")

        ctk.CTkButton(
            cont,
            text="Activar horas extra",
            command=activar,
            fg_color=NAV_GREEN,
            hover_color="#5DBF96",
            text_color=NAV_BG,
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
            text_color=NAV_GREEN,
        ).pack(anchor="w")
        asignadas = getattr(self.shift, "horas_extra_asignadas_segundos", 0)
        ctk.CTkLabel(
            cont,
            text=f"Tiempo asignado: {fmt_hms(asignadas)}",
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX2,
        ).pack(anchor="w", pady=(4, 0))
        timer = ctk.CTkLabel(
            cont,
            text=fmt_hms(self.shift.seg_horas_extra),
            font=ctk.CTkFont(size=54, weight="bold"),
            text_color=NAV_TX,
        )
        timer.pack(expand=True)
        restante = ctk.CTkLabel(
            cont,
            text="",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color=NAV_AMBER,
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
            fg_color=NAV_MODAL_ENTRY,
            hover_color=NAV_CARD2,
            border_width=1,
            border_color=NAV_BORDER2,
            height=42,
            corner_radius=8,
        ).pack(fill="x")
        refrescar()

    def _modal_excepcion(self, tipo, titulo):
        top = self._modal(titulo, 440, 360)
        ctk.CTkLabel(
            top,
            text=titulo,
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=NAV_TX,
        ).pack(anchor="w", padx=20, pady=(20, 4))
        ctk.CTkLabel(
            top,
            text="Esta solicitud se registra para revision de RR. HH.",
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX2,
        ).pack(anchor="w", padx=20)

        ctk.CTkLabel(
            top,
            text="Horas (si aplica)",
            font=ctk.CTkFont(size=12),
            text_color="#CFE0F0",
        ).pack(anchor="w", padx=20, pady=(14, 2))
        entry_horas = ctk.CTkEntry(
            top,
            placeholder_text="Ej: 2",
            fg_color=NAV_MODAL_ENTRY,
            border_color=NAV_BORDER2,
            text_color=NAV_TX,
        )
        entry_horas.pack(fill="x", padx=20)

        ctk.CTkLabel(
            top,
            text="Motivo",
            font=ctk.CTkFont(size=12),
            text_color="#CFE0F0",
        ).pack(anchor="w", padx=20, pady=(12, 2))
        motivo = ctk.CTkTextbox(
            top, height=80, fg_color=NAV_MODAL_ENTRY, text_color=NAV_TX
        )
        motivo.pack(fill="x", padx=20)

        def enviar():
            self.shift.registrar_excepcion(
                tipo,
                {
                    "horas": entry_horas.get().strip(),
                    "motivo": motivo.get("1.0", "end").strip(),
                },
            )
            top.destroy()

        ctk.CTkButton(
            top,
            text="Enviar solicitud",
            command=enviar,
            fg_color=NAV_ACCENT_D,
            hover_color=NAV_ACCENT,
            height=40,
            corner_radius=8,
            text_color="#FFFFFF",
            font=ctk.CTkFont(weight="bold"),
        ).pack(side="bottom", fill="x", padx=20, pady=16)

    def _modal_restaurar(self):
        top = self._modal("Restauracion de administrador", 430, 320)
        cont = ctk.CTkFrame(top, fg_color="transparent")
        cont.pack(fill="both", expand=True, padx=22, pady=20)
        ctk.CTkLabel(
            cont,
            text="Restauracion de administrador",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=NAV_TX,
        ).pack(anchor="w")
        ctk.CTkLabel(
            cont,
            text="Ingresa el PIN para reabrir o restaurar marcajes.",
            font=ctk.CTkFont(size=12),
            text_color=NAV_TX2,
            wraplength=380,
            justify="left",
        ).pack(anchor="w", pady=(6, 12))

        pin = ctk.CTkEntry(
            cont,
            show="*",
            placeholder_text="PIN de administrador",
            fg_color=NAV_MODAL_ENTRY,
            border_color=NAV_BORDER2,
            text_color=NAV_TX,
        )
        pin.pack(fill="x")

        error = ctk.CTkLabel(
            cont, text="", font=ctk.CTkFont(size=12), text_color=NAV_DANGER_TX
        )
        error.pack(anchor="w", pady=(6, 0))

        opciones = ctk.CTkFrame(cont, fg_color="transparent")

        def mostrar():
            for w in opciones.winfo_children():
                w.destroy()
            opciones.pack(fill="x", pady=(8, 0))
            algo = False
            if self.shift.estado == "TERMINADO":
                algo = True
                self._btn_restaurar(
                    opciones, "Reabrir jornada", self.shift.restaurar_jornada, top
                )
            if self.shift.break_consumido:
                algo = True
                self._btn_restaurar(
                    opciones, "Reactivar break", self.shift.restaurar_break, top
                )
            if self.shift.lunch_consumido:
                algo = True
                self._btn_restaurar(
                    opciones, "Reactivar almuerzo", self.shift.restaurar_lunch, top
                )
            if not algo:
                ctk.CTkLabel(
                    opciones,
                    text="No hay marcajes que restaurar.",
                    font=ctk.CTkFont(size=12),
                    text_color=NAV_TX2,
                ).pack(anchor="w")

        def validar():
            if self.shift.validar_admin(pin.get().strip()):
                pin.configure(state="disabled")
                error.configure(text="")
                mostrar()
            else:
                error.configure(text="PIN incorrecto.")

        ctk.CTkButton(
            cont,
            text="Validar",
            command=validar,
            fg_color=NAV_ACCENT_D,
            hover_color=NAV_ACCENT,
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
            fg_color=NAV_ACCENT_D,
            hover_color=NAV_ACCENT,
            text_color="#FFFFFF",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", pady=4)

    def _on_screen_event(self, msg):
        if msg.startswith("Captura "):
            self._ultima_captura_txt = msg.replace("Captura ", "", 1)[:5]

    def _build_fallback_ui(self, error_text):
        self._clear_window_contents()
        frame = ctk.CTkFrame(self, fg_color=NAV_CARD, corner_radius=10)
        frame.pack(fill="both", expand=True, padx=24, pady=24)
        ctk.CTkLabel(
            frame,
            text="No fue posible cargar la estación de marcaje",
            font=ctk.CTkFont(size=20, weight="bold"),
            text_color=NAV_TX,
        ).pack(anchor="w", padx=24, pady=(24, 8))
        ctk.CTkLabel(
            frame,
            text=(
                "La interfaz se reabrió en modo seguro. Revisa la consola para ver el detalle exacto "
                "y podrás seguir usando la app."
            ),
            font=ctk.CTkFont(size=13),
            text_color=NAV_TX2,
            wraplength=720,
            justify="left",
        ).pack(anchor="w", padx=24, pady=(0, 12))
        ctk.CTkLabel(
            frame,
            text=error_text,
            font=ctk.CTkFont(size=11),
            text_color=NAV_DANGER_TX,
            wraplength=720,
            justify="left",
        ).pack(anchor="w", padx=24, pady=(0, 18))
        ctk.CTkButton(
            frame,
            text="Reintentar",
            command=self._retry_initialization,
            fg_color=NAV_ACCENT_D,
            hover_color=NAV_ACCENT,
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
            texto, color = ESTADO_INFO.get(estado, (estado, NAV_TX2))
            self.badge.configure(text=f"  {texto}  ", text_color=color)
            self.lbl_captura_estado.configure(
                text=" Captura activa " if self.screens.activo else " Captura detenida "
            )
            self._render_controles()
            self._pintar_estado_items()
            self._draw_clock(self.shift.seg_trabajado)
            self._refresh_sync_status()

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
        fg_color=NAV_ACCENT_D,
        hover_color=NAV_ACCENT,
        height=40,
    ).pack(anchor="e")
    aviso.mainloop()


def main():
    ctk.set_appearance_mode("light")
    cfg = Config()
    consentimiento = load_consent()

    if consentimiento is None:
        ventana = ConsentWindow(cfg)
        ventana.mainloop()

        if ventana.decision is not True:
            save_consent(False)
            _mensaje_rechazo(cfg)
            sys.exit(0)

        consentimiento = save_consent(True, ventana.detalles)

    elif consentimiento.get("aceptado") is not True:
        _mensaje_rechazo(cfg)
        sys.exit(0)

    ctk.set_appearance_mode("dark")
    StationWindow(cfg, consentimiento).mainloop()


if __name__ == "__main__":
    main()
