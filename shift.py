"""
shift.py - Estacion de marcaje y control de asistencia.

Este modulo coordina la jornada del usuario. La interfaz decide cuando llamar
estas transiciones; el manager se encarga de relojes, pausas, bitacora local,
telemetria y callbacks para capturas.
"""

import datetime
import getpass
import json
import os
import socket
import threading
import time

from activity_tracker import ActivityTracker
from outbox import append_event


def fmt_hms(segundos: int) -> str:
    segundos = int(segundos)
    h, r = divmod(segundos, 3600)
    m, s = divmod(r, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


class ShiftManager:
    """
    Estados:
      FUERA
      TRABAJANDO
      BREAK
      LUNCH
      TERMINADO
    """

    def __init__(self, cfg, on_state=None, on_tick=None):
        self.cfg = cfg
        self.on_state = on_state
        self.on_tick = on_tick

        self.estado = "FUERA"
        self.eventos = []
        self.excepciones = []

        self.seg_trabajado = 0
        self.seg_break = 0
        self.seg_lunch = 0
        self.seg_horas_extra = 0
        self.inicio_jornada = None
        self.fin_jornada = None
        self.break_consumido = False
        self.lunch_consumido = False
        self.horas_extra_estado = "SIN_HORAS_EXTRA"
        self.horas_extra_codigo = ""
        self.horas_extra_origen = ""
        self.horas_extra_inicio = None
        self.horas_extra_fin = None
        self.horas_extra_asignadas_segundos = 0
        self.horas_extra_solicitud = None
        self.horas_extra_asignacion = None
        self.horas_extra_codigos_usados = []
        self._cierre_snapshot = None

        self.tracker = ActivityTracker(cfg, on_update=self._on_tracker)
        self.ultimo_snapshot = {}

        self._running = False
        self._thread = None
        self._io_lock = threading.Lock()
        self._last_periodic_save = 0.0
        self._last_activity_snapshot_sync = 0.0

        self.on_shift_start = None
        self.on_shift_pause = None
        self.on_shift_resume = None
        self.on_shift_end = None

        self._cargar_jornada()

    # ---- transiciones -------------------------------------------------
    def iniciar_jornada(self):
        if self.estado not in ("FUERA", "TERMINADO"):
            return
        self.estado = "TRABAJANDO"
        self.inicio_jornada = datetime.datetime.now()
        self.fin_jornada = None
        self._log("inicio_jornada")
        self._queue("shift_started")
        self.tracker.pausado = False
        self.tracker.start()
        self._arrancar_reloj()
        self._safe(self.on_shift_start)
        self._notificar_estado()

    def finalizar_jornada(self):
        if self.estado in ("FUERA", "TERMINADO"):
            return
        self.estado = "TERMINADO"
        self.fin_jornada = datetime.datetime.now()
        self.finalizar_horas_extra()
        self._log("fin_jornada")
        self._queue("shift_finished")
        self._running = False
        self.tracker.stop()
        self._safe(self.on_shift_end)

        # Las horas acumuladas solo se reinician a cero aqui, al confirmar
        # "Finalizar jornada". Apagar el equipo o cerrar la app NO las borra
        # (ver _cargar_jornada). Se guarda una copia por si un administrador
        # deshace este cierre por error con "Restaurar jornada".
        self._cierre_snapshot = {
            "seg_trabajado": self.seg_trabajado,
            "seg_break": self.seg_break,
            "seg_lunch": self.seg_lunch,
            "seg_horas_extra": self.seg_horas_extra,
            "break_consumido": self.break_consumido,
            "lunch_consumido": self.lunch_consumido,
            "horas_extra_estado": self.horas_extra_estado,
            "horas_extra_asignadas_segundos": self.horas_extra_asignadas_segundos,
            "inicio_jornada": (
                self.inicio_jornada.isoformat() if self.inicio_jornada else None
            ),
        }
        self.seg_trabajado = 0
        self.seg_break = 0
        self.seg_lunch = 0
        self.seg_horas_extra = 0
        self.break_consumido = False
        self.lunch_consumido = False
        self.horas_extra_estado = "SIN_HORAS_EXTRA"
        self.horas_extra_asignadas_segundos = 0

        self._guardar()
        self._notificar_estado()

    def shutdown_runtime(self):
        """Detiene hilos sin cerrar la jornada para poder reanudar al abrir."""
        self._running = False
        self.tracker.stop()
        self._safe(self.on_shift_end)
        self._guardar()

    def iniciar_break(self):
        if self.estado != "TRABAJANDO" or self.break_consumido:
            return
        self.break_consumido = True
        self._queue("break_started")
        self._pausar("BREAK", "inicio_break")

    def finalizar_break(self):
        if self.estado == "BREAK":
            self._reanudar("fin_break")
            self._queue("break_finished")

    def iniciar_lunch(self):
        if self.estado != "TRABAJANDO" or self.lunch_consumido:
            return
        self.lunch_consumido = True
        self._queue("lunch_started")
        self._pausar("LUNCH", "inicio_lunch")

    def finalizar_lunch(self):
        if self.estado == "LUNCH":
            self._reanudar("fin_lunch")
            self._queue("lunch_finished")

    # Alias de compatibilidad con versiones anteriores.
    def tomar_break(self):
        self.iniciar_break()

    def tomar_lunch(self):
        self.iniciar_lunch()

    def reanudar(self):
        self._reanudar("reanudar")

    def _pausar(self, nuevo_estado: str, accion: str):
        if self.estado != "TRABAJANDO":
            return
        self.estado = nuevo_estado
        self._log(accion)
        self.tracker.pausado = True
        self._safe(self.on_shift_pause)
        self._notificar_estado()

    def _reanudar(self, accion: str):
        if self.estado not in ("BREAK", "LUNCH"):
            return
        self.estado = "TRABAJANDO"
        self._log(accion)
        self.tracker.pausado = False
        self._safe(self.on_shift_resume)
        self._notificar_estado()

    # ---- restauracion por administrador ------------------------------
    def validar_admin(self, pin: str) -> bool:
        esperado = str(getattr(self.cfg, "admin_pin", "1234")).strip()
        return bool(pin) and pin == esperado

    def restaurar_jornada(self):
        if self.estado != "TERMINADO":
            return
        snap = self._cierre_snapshot
        if snap:
            self.seg_trabajado = snap.get("seg_trabajado", 0)
            self.seg_break = snap.get("seg_break", 0)
            self.seg_lunch = snap.get("seg_lunch", 0)
            self.seg_horas_extra = snap.get("seg_horas_extra", 0)
            self.break_consumido = snap.get("break_consumido", False)
            self.lunch_consumido = snap.get("lunch_consumido", False)
            self.horas_extra_estado = snap.get("horas_extra_estado", "SIN_HORAS_EXTRA")
            self.horas_extra_asignadas_segundos = snap.get(
                "horas_extra_asignadas_segundos", 0
            )
            self._cierre_snapshot = None
        self.estado = "TRABAJANDO"
        self.fin_jornada = None
        self._log("restaurar_jornada")
        self._queue("shift_restored_by_admin")
        self.tracker.pausado = False
        self.tracker.start()
        self._arrancar_reloj()
        self._safe(self.on_shift_start)
        self._notificar_estado()

    def resetear_reloj(self):
        if self.estado not in ("TRABAJANDO", "BREAK", "LUNCH"):
            return
        self.seg_trabajado = 0
        self.seg_break = 0
        self.seg_lunch = 0
        self.inicio_jornada = datetime.datetime.now()
        self._log("resetear_reloj")
        self._queue("shift_clock_reset")
        self._guardar()
        self._notificar_estado()

    def restaurar_break(self):
        if not self.break_consumido:
            return
        self.break_consumido = False
        self._log("restaurar_break")
        self._queue("break_restored_by_admin")
        self._notificar_estado()

    def restaurar_lunch(self):
        if not self.lunch_consumido:
            return
        self.lunch_consumido = False
        self._log("restaurar_lunch")
        self._queue("lunch_restored_by_admin")
        self._notificar_estado()

    def resume_runtime_if_needed(self):
        """Reactiva hilos y hooks despues de cargar una jornada en curso."""
        if self.estado not in ("TRABAJANDO", "BREAK", "LUNCH"):
            if self.horas_extra_estado == "ACTIVA":
                self.tracker.pausado = False
                self.tracker.start()
                self._arrancar_reloj()
                self._safe(self.on_shift_start)
                self._notificar_estado()
            return
        self.tracker.pausado = self.estado in ("BREAK", "LUNCH")
        self.tracker.start()
        self._arrancar_reloj()
        if self.estado == "TRABAJANDO":
            self._safe(self.on_shift_start)
        else:
            self._safe(self.on_shift_start)
            self._safe(self.on_shift_pause)
        self._notificar_estado()

    # ---- reloj --------------------------------------------------------
    def _arrancar_reloj(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while self._running:
            if self.estado == "TRABAJANDO":
                self.seg_trabajado += 1
            elif self.estado == "BREAK":
                self.seg_break += 1
            elif self.estado == "LUNCH":
                self.seg_lunch += 1
            if self.horas_extra_estado == "ACTIVA":
                self.seg_horas_extra += 1
                if (
                    self.horas_extra_asignadas_segundos > 0
                    and self.seg_horas_extra >= self.horas_extra_asignadas_segundos
                ):
                    self.finalizar_horas_extra()

            if self.on_tick:
                info = {
                    "estado": self.estado,
                    "trabajado": self.seg_trabajado,
                    "break": self.seg_break,
                    "lunch": self.seg_lunch,
                    "horas_extra": self.seg_horas_extra,
                    "horas_extra_estado": self.horas_extra_estado,
                    "horas_extra_asignadas": self.horas_extra_asignadas_segundos,
                    "hora": datetime.datetime.now().strftime("%H:%M:%S"),
                    "snapshot": self.ultimo_snapshot,
                }
                self._safe(lambda: self.on_tick(info))
            ahora = time.time()
            if ahora - self._last_periodic_save >= 10:
                self._guardar()
                self._last_periodic_save = ahora
            if ahora - self._last_activity_snapshot_sync >= 30:
                self._queue("activity_snapshot")
                self._last_activity_snapshot_sync = ahora
            time.sleep(1)

    # ---- incidencias --------------------------------------------------
    def registrar_excepcion(self, tipo: str, detalle: dict):
        registro = {
            "tipo": tipo,
            "detalle": detalle,
            "empleado": getpass.getuser(),
            "equipo": socket.gethostname(),
            "timestamp": datetime.datetime.now().isoformat(),
        }
        self.excepciones.append(registro)
        self._guardar()
        append_event("incidence_created", registro)
        return registro

    def solicitar_horas_extra(self, dia: str, hora_salida: str, motivo: str) -> dict:
        registro = {
            "dia": dia,
            "hora_salida": hora_salida,
            "motivo": motivo,
            "estado": "pendiente_autorizacion",
            "empleado": getpass.getuser(),
            "equipo": socket.gethostname(),
            "timestamp": datetime.datetime.now().isoformat(),
        }
        self.horas_extra_solicitud = registro
        self._guardar()
        append_event("overtime_requested", registro)
        return registro

    def activar_horas_extra_con_codigo(self, codigo: str, origen: str = "codigo", asignacion: dict | None = None) -> bool:
        codigo = (codigo or "").strip()
        autorizacion = self.resolver_codigo_horas_extra(codigo)
        if not autorizacion:
            return False
        if codigo in self.horas_extra_codigos_usados:
            return False
        self.horas_extra_estado = "ACTIVA"
        self.horas_extra_codigo = codigo
        self.horas_extra_origen = origen
        self.horas_extra_inicio = datetime.datetime.now()
        self.horas_extra_fin = None
        self.seg_horas_extra = 0
        self.horas_extra_asignadas_segundos = autorizacion["segundos_asignados"]
        if asignacion:
            self.horas_extra_asignacion = asignacion
        else:
            self.horas_extra_asignacion = autorizacion
        self.horas_extra_codigos_usados.append(codigo)
        self._log("inicio_horas_extra")
        append_event("overtime_started", self.snapshot())
        self._arrancar_reloj()
        self._notificar_estado()
        return True

    def aceptar_asignacion_horas_extra(self, asignacion: dict) -> bool:
        codigo = asignacion.get("codigo") or "ASIGNACION"
        return self.activar_horas_extra_con_codigo(
            codigo,
            origen="asignacion",
            asignacion=asignacion,
        )

    def registrar_asignacion_horas_extra(self, asignacion: dict):
        self.horas_extra_estado = "PENDIENTE_ASIGNACION"
        self.horas_extra_asignacion = asignacion
        self._guardar()
        append_event("overtime_assigned", asignacion)
        self._notificar_estado()

    def finalizar_horas_extra(self):
        if self.horas_extra_estado != "ACTIVA":
            return
        self.horas_extra_estado = "FINALIZADA"
        self.horas_extra_fin = datetime.datetime.now()
        self._log("fin_horas_extra")
        append_event("overtime_finished", self.snapshot())
        self._guardar()
        self._notificar_estado()

    @staticmethod
    def resolver_codigo_horas_extra(codigo: str) -> dict | None:
        codigo = (codigo or "").strip()
        if len(codigo) < 6:
            return None

        minutos = 60
        partes = codigo.upper().split("-")
        if len(partes) >= 3 and partes[0] == "HE":
            try:
                minutos = max(1, min(720, int(partes[1])))
            except ValueError:
                minutos = 60

        return {
            "codigo": codigo,
            "segundos_asignados": minutos * 60,
            "minutos_asignados": minutos,
            "origen": "codigo_admin",
        }

    # ---- persistencia -------------------------------------------------
    def _log(self, accion: str):
        self.eventos.append(
            {
                "accion": accion,
                "estado": self.estado,
                "timestamp": datetime.datetime.now().isoformat(),
            }
        )
        self._guardar()

    def _queue(self, tipo: str):
        append_event(tipo, self.snapshot())

    def snapshot(self) -> dict:
        return {
            "estado": self.estado,
            "empleado": getpass.getuser(),
            "equipo": socket.gethostname(),
            "fecha": datetime.date.today().isoformat(),
            "inicio_jornada": (
                self.inicio_jornada.isoformat() if self.inicio_jornada else None
            ),
            "fin_jornada": self.fin_jornada.isoformat() if self.fin_jornada else None,
            "seg_trabajado": self.seg_trabajado,
            "seg_break": self.seg_break,
            "seg_lunch": self.seg_lunch,
            "seg_horas_extra": self.seg_horas_extra,
            "horas_extra_estado": self.horas_extra_estado,
            "horas_extra_codigo": self.horas_extra_codigo,
            "horas_extra_origen": self.horas_extra_origen,
            "horas_extra_inicio": (
                self.horas_extra_inicio.isoformat() if self.horas_extra_inicio else None
            ),
            "horas_extra_fin": (
                self.horas_extra_fin.isoformat() if self.horas_extra_fin else None
            ),
            "horas_extra_asignadas_segundos": self.horas_extra_asignadas_segundos,
            "horas_extra_solicitud": self.horas_extra_solicitud,
            "horas_extra_asignacion": self.horas_extra_asignacion,
            "horas_extra_codigos_usados": self.horas_extra_codigos_usados,
            "break_consumido": self.break_consumido,
            "lunch_consumido": self.lunch_consumido,
            "telemetria": self.ultimo_snapshot,
            "timestamp": datetime.datetime.now().isoformat(),
        }

    def _ruta_bitacora(self) -> str:
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        carpeta = os.path.join(base, "VYNTRA", "jornadas")
        os.makedirs(carpeta, exist_ok=True)
        self._archivar_jornadas_antiguas(carpeta)
        dia = datetime.date.today().strftime("%Y%m%d")
        return os.path.join(carpeta, f"jornada_{dia}.json")
    
    def _archivar_jornadas_antiguas(self, carpeta_jornadas: str):
        """Archiva jornadas con más de 30 días y limpia la carpeta."""
        try:
            ahora = datetime.datetime.now()
            limite = ahora - datetime.timedelta(days=30)
            
            for archivo in os.listdir(carpeta_jornadas):
                if archivo.startswith("jornada_") and archivo.endswith(".json"):
                    try:
                        fecha_str = archivo.replace("jornada_", "").replace(".json", "")
                        fecha = datetime.datetime.strptime(fecha_str, "%Y%m%d")
                        if fecha < limite:
                            carpeta_archivo = os.path.join(carpeta_jornadas, "archivo")
                            os.makedirs(carpeta_archivo, exist_ok=True)
                            ruta_vieja = os.path.join(carpeta_jornadas, archivo)
                            ruta_nueva = os.path.join(carpeta_archivo, archivo)
                            os.rename(ruta_vieja, ruta_nueva)
                    except Exception:
                        pass
        except Exception:
            pass

    def _guardar(self):
        data = {
            "estado": self.estado,
            "empleado": getpass.getuser(),
            "equipo": socket.gethostname(),
            "fecha": datetime.date.today().isoformat(),
            "inicio_jornada": (
                self.inicio_jornada.isoformat() if self.inicio_jornada else None
            ),
            "fin_jornada": self.fin_jornada.isoformat() if self.fin_jornada else None,
            "seg_trabajado": self.seg_trabajado,
            "seg_break": self.seg_break,
            "seg_lunch": self.seg_lunch,
            "seg_horas_extra": self.seg_horas_extra,
            "horas_extra_estado": self.horas_extra_estado,
            "horas_extra_codigo": self.horas_extra_codigo,
            "horas_extra_origen": self.horas_extra_origen,
            "horas_extra_inicio": (
                self.horas_extra_inicio.isoformat() if self.horas_extra_inicio else None
            ),
            "horas_extra_fin": (
                self.horas_extra_fin.isoformat() if self.horas_extra_fin else None
            ),
            "horas_extra_asignadas_segundos": self.horas_extra_asignadas_segundos,
            "horas_extra_solicitud": self.horas_extra_solicitud,
            "horas_extra_asignacion": self.horas_extra_asignacion,
            "horas_extra_codigos_usados": self.horas_extra_codigos_usados,
            "break_consumido": self.break_consumido,
            "lunch_consumido": self.lunch_consumido,
            "eventos": self.eventos,
            "excepciones": self.excepciones,
            "telemetria": self.ultimo_snapshot,
            "cierre_snapshot": self._cierre_snapshot,
            "last_update": datetime.datetime.now().isoformat(),
        }
        try:
            ruta = self._ruta_bitacora()
            tmp = f"{ruta}.tmp"
            with self._io_lock:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                os.replace(tmp, ruta)
        except Exception:
            pass

    def _cargar_jornada(self):
        ruta = self._ruta_bitacora()
        if not os.path.exists(ruta):
            return
        try:
            with open(ruta, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return

        if data.get("fecha") != datetime.date.today().isoformat():
            return

        self.estado = data.get("estado") or self._inferir_estado(data)
        self.eventos = data.get("eventos", [])
        self.excepciones = data.get("excepciones", [])
        self.seg_trabajado = int(data.get("seg_trabajado", 0) or 0)
        self.seg_break = int(data.get("seg_break", 0) or 0)
        self.seg_lunch = int(data.get("seg_lunch", 0) or 0)
        self.seg_horas_extra = int(data.get("seg_horas_extra", 0) or 0)
        self.break_consumido = bool(data.get("break_consumido", False))
        self.lunch_consumido = bool(data.get("lunch_consumido", False))
        self.horas_extra_estado = data.get("horas_extra_estado", "SIN_HORAS_EXTRA")
        self.horas_extra_codigo = data.get("horas_extra_codigo", "")
        self.horas_extra_origen = data.get("horas_extra_origen", "")
        self.horas_extra_inicio = self._parse_dt(data.get("horas_extra_inicio"))
        self.horas_extra_fin = self._parse_dt(data.get("horas_extra_fin"))
        self.horas_extra_asignadas_segundos = int(
            data.get("horas_extra_asignadas_segundos", 0) or 0
        )
        self.horas_extra_solicitud = data.get("horas_extra_solicitud")
        self.horas_extra_asignacion = data.get("horas_extra_asignacion")
        self.horas_extra_codigos_usados = data.get("horas_extra_codigos_usados", [])
        self.ultimo_snapshot = data.get("telemetria", {}) or {}
        self.inicio_jornada = self._parse_dt(data.get("inicio_jornada"))
        self.fin_jornada = self._parse_dt(data.get("fin_jornada"))
        self._cierre_snapshot = data.get("cierre_snapshot")

        # Las horas se restauran tal cual quedaron guardadas. El tiempo en que
        # el equipo estuvo apagado o la app cerrada NO se suma al contador:
        # si acumulo 3h y apago el equipo, al volver a entrar sigue en 3h y
        # continua desde ahi (no salta a 3h + tiempo apagado).

    @staticmethod
    def _parse_dt(value):
        if not value:
            return None
        try:
            return datetime.datetime.fromisoformat(value)
        except Exception:
            return None

    @staticmethod
    def _inferir_estado(data: dict) -> str:
        eventos = data.get("eventos", [])
        if not eventos:
            return "FUERA"
        accion = eventos[-1].get("accion")
        if accion in ("fin_jornada",):
            return "TERMINADO"
        if accion in ("inicio_break",):
            return "BREAK"
        if accion in ("inicio_lunch",):
            return "LUNCH"
        return "TRABAJANDO"

    # ---- auxiliares ---------------------------------------------------
    def _on_tracker(self, snap):
        self.ultimo_snapshot = snap

    def _notificar_estado(self):
        if self.on_state:
            self._safe(lambda: self.on_state(self.estado))

    @staticmethod
    def _safe(fn):
        if not fn:
            return
        try:
            fn()
        except Exception:
            pass
