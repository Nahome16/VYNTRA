"""
shift.py - Estacion de marcaje y control de asistencia.

Este modulo coordina la jornada del usuario. La interfaz decide cuando llamar
estas transiciones; el manager se encarga de relojes, pausas, bitacora local,
telemetria y callbacks para capturas.

Medicion del tiempo
-------------------
- El reloj suma deltas de un reloj monotono (no +1 por cada sleep(1)), por lo
  que no deriva aunque el hilo se retrase.
- Si entre dos ticks pasan mas de SUSPEND_GAP_SECONDS (suspension, hibernacion
  o app congelada), ese hueco NO se cuenta como trabajado: se registra un
  evento `suspend_detected` (inicio/fin/segundos) para revision de RR. HH.
- Un unico lock protege los contadores y el estado, que se modifican desde el
  hilo de la interfaz y desde el hilo del reloj. Cada hilo del reloj recibe su
  propio threading.Event de parada: detener/iniciar rapido no puede dejar dos
  hilos contando a la vez.

Recuperacion tras cierre imprevisto (RF-16)
-------------------------------------------
La jornada activa se persiste cada 10 s en %LOCALAPPDATA%\\VYNTRA\\jornadas,
identificada por `shift_id` y por la fecha de INICIO de la jornada (no por la
fecha actual), asi que una jornada iniciada antes de medianoche se recupera
aunque la app se reabra despues de medianoche.

- Reapertura dentro de RECOVERY_WINDOW_SECONDS (15 min) tras un cierre
  imprevisto: la jornada continua y el hueco se cuenta (evento
  `shift_recovered`).
- Reapertura posterior (o tras un cierre normal de la ventana): la jornada se
  restaura, pero el hueco no se cuenta como trabajado; se registra
  `recovery_gap` y se informa al usuario.
"""

from __future__ import annotations

import datetime
import getpass
import json
import os
import socket
import threading
import time
import uuid

import requests

from activity_tracker import ActivityTracker
from agent_runtime import data_dir, get_logger, local_now, parse_iso
from outbox import append_event

log = get_logger("shift")

SUSPEND_GAP_SECONDS = 120
RECOVERY_WINDOW_SECONDS = 15 * 60
PERIODIC_SAVE_SECONDS = 10
ACTIVITY_SNAPSHOT_SECONDS = 30
ACTIVE_STATES = ("TRABAJANDO", "BREAK", "LUNCH")
PERSISTED_SAMPLES = 20


def fmt_hms(segundos: int) -> str:
    segundos = max(0, int(segundos))
    h, r = divmod(segundos, 3600)
    m, s = divmod(r, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def _fmt_minutos(segundos: float) -> str:
    minutos = max(1, int(round(segundos / 60)))
    if minutos < 60:
        return f"{minutos} min"
    horas, resto = divmod(minutos, 60)
    return f"{horas} h {resto:02d} min"


class SystemClock:
    """Reloj del sistema. Las pruebas inyectan un reloj falso con la misma interfaz."""

    def monotonic(self) -> float:
        return time.monotonic()

    def time(self) -> float:
        return time.time()

    def now(self) -> datetime.datetime:
        return local_now()


def jornadas_dir() -> str:
    carpeta = os.path.join(data_dir(), "jornadas")
    os.makedirs(carpeta, exist_ok=True)
    return carpeta


def _ruta_por_fecha(fecha: datetime.date) -> str:
    return os.path.join(jornadas_dir(), f"jornada_{fecha:%Y%m%d}.json")


def _leer_json(ruta: str) -> dict | None:
    try:
        with open(ruta, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        log.warning("Bitacora de jornada ilegible %s: %s", ruta, exc)
        return None


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


def _estado_de(data: dict) -> str:
    return data.get("estado") or _inferir_estado(data)


def _es_activa(data: dict) -> bool:
    return _estado_de(data) in ACTIVE_STATES or data.get("horas_extra_estado") == "ACTIVA"


def _heartbeat(data: dict) -> float:
    try:
        value = float(data.get("last_heartbeat_epoch") or 0)
    except (TypeError, ValueError):
        value = 0.0
    if value:
        return value
    last = parse_iso(data.get("last_update"))
    return last.timestamp() if last else 0.0


def buscar_jornada_restaurable(now: datetime.datetime | None = None) -> tuple[str | None, dict | None]:
    """Busca la bitacora a restaurar: una jornada activa de hoy o de ayer (turno
    nocturno), o la jornada de hoy ya terminada."""
    now = now or local_now()
    hoy = now.date()
    candidatos = []
    for fecha in (hoy, hoy - datetime.timedelta(days=1)):
        ruta = _ruta_por_fecha(fecha)
        data = _leer_json(ruta)
        if data:
            candidatos.append((ruta, data, fecha))

    activos = [item for item in candidatos if _es_activa(item[1])]
    if activos:
        ruta, data, _ = max(activos, key=lambda item: _heartbeat(item[1]))
        return ruta, data

    for ruta, data, fecha in candidatos:
        if fecha == hoy and data.get("fecha") in (None, hoy.isoformat()):
            return ruta, data
        fin = parse_iso(data.get("fin_jornada"))
        if fin and fin.date() == hoy:
            return ruta, data
    return None, None


def persisted_shift_state(now: datetime.datetime | None = None) -> tuple[str, str]:
    """Estado persistido (estado, horas_extra_estado) sin crear un ShiftManager.

    Lo usa el actualizador al arrancar, antes del login, para no aplicar una
    actualizacion en medio de una jornada.
    """
    try:
        _, data = buscar_jornada_restaurable(now)
    except Exception:
        log.exception("No se pudo leer el estado persistido de la jornada")
        return "DESCONOCIDO", ""
    if not data:
        return "FUERA", "SIN_HORAS_EXTRA"
    return _estado_de(data), str(data.get("horas_extra_estado") or "SIN_HORAS_EXTRA")


class ShiftManager:
    """
    Estados:
      FUERA
      TRABAJANDO
      BREAK
      LUNCH
      TERMINADO
    """

    def __init__(self, cfg, on_state=None, on_tick=None, clock=None, threaded: bool = True, tracker=None):
        self.cfg = cfg
        self.on_state = on_state
        self.on_tick = on_tick
        self.on_notice = None
        self.clock = clock or SystemClock()
        self.threaded = threaded

        self._lock = threading.RLock()
        self._io_lock = threading.Lock()

        self.estado = "FUERA"
        self.eventos = []
        self.excepciones = []
        self.shift_id = ""
        self.fecha_jornada: datetime.date | None = None

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
        self.ultimo_error_codigo = ""
        self._cierre_snapshot = None
        self._clean_shutdown = False
        self.avisos: list[str] = []

        self.tracker = tracker if tracker is not None else ActivityTracker(cfg, on_update=self._on_tracker)
        if tracker is not None and getattr(tracker, "on_update", None) is None:
            tracker.on_update = self._on_tracker
        self.ultimo_snapshot = {}

        self._thread = None
        self._clock_stop: threading.Event | None = None
        self._last_mono = self.clock.monotonic()
        self._last_wall = self.clock.time()
        self._carry = 0.0
        self._last_periodic_save = self._last_mono
        self._last_activity_snapshot_sync = self._last_mono
        self._ruta_origen = None
        self._archivado_hecho = False

        self.on_shift_start = None
        self.on_shift_pause = None
        self.on_shift_resume = None
        self.on_shift_end = None

        self._cargar_jornada()

    # ---- transiciones -------------------------------------------------
    def iniciar_jornada(self):
        with self._lock:
            if self.estado not in ("FUERA", "TERMINADO"):
                return
            ahora = self.clock.now()
            nueva_fecha = ahora.date()
            if self.fecha_jornada != nueva_fecha:
                # Bitacora nueva: los eventos de la jornada anterior ya quedaron en su archivo.
                self.eventos = []
                self.excepciones = []
            self.estado = "TRABAJANDO"
            self.shift_id = str(uuid.uuid4())
            self.fecha_jornada = nueva_fecha
            self.inicio_jornada = ahora
            self.fin_jornada = None
            self._clean_shutdown = False
            self._reset_tracker()
            self._log("inicio_jornada")
            self._queue("shift_started")
            self.tracker.pausado = False
            self._iniciar_tracker()
            self._arrancar_reloj()
        self._safe(self.on_shift_start)
        self._notificar_estado()

    def finalizar_jornada(self):
        with self._lock:
            if self.estado in ("FUERA", "TERMINADO"):
                return
            self.estado = "TERMINADO"
            self.fin_jornada = self.clock.now()
            self.finalizar_horas_extra(notificar=False)
            self._log("fin_jornada")
            self._queue("shift_finished")
            self._detener_reloj()
            self.tracker.stop()

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
        self._safe(self.on_shift_end)
        self._notificar_estado()

    def shutdown_runtime(self, join_timeout: float = 2.0):
        """Detiene hilos sin cerrar la jornada para poder reanudar al abrir.

        Se marca como cierre normal: al reabrir, el tiempo con la app cerrada no
        se cuenta como trabajado.
        """
        with self._lock:
            self._clean_shutdown = True
            self._detener_reloj()
            thread = self._thread
            self.tracker.stop()
        self._safe(self.on_shift_end)
        if join_timeout and thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(join_timeout)
        tracker_thread = getattr(self.tracker, "_thread", None)
        if join_timeout and tracker_thread and tracker_thread.is_alive():
            tracker_thread.join(join_timeout)
        self._guardar()

    def iniciar_break(self):
        with self._lock:
            if self.estado != "TRABAJANDO" or self.break_consumido:
                return
            self.break_consumido = True
            self._queue("break_started")
            cambiado = self._pausar("BREAK", "inicio_break")
        if cambiado:
            self._safe(self.on_shift_pause)
            self._notificar_estado()

    def finalizar_break(self):
        with self._lock:
            if self.estado != "BREAK":
                return
            cambiado = self._reanudar("fin_break")
            self._queue("break_finished")
        if cambiado:
            self._safe(self.on_shift_resume)
            self._notificar_estado()

    def iniciar_lunch(self):
        with self._lock:
            if self.estado != "TRABAJANDO" or self.lunch_consumido:
                return
            self.lunch_consumido = True
            self._queue("lunch_started")
            cambiado = self._pausar("LUNCH", "inicio_lunch")
        if cambiado:
            self._safe(self.on_shift_pause)
            self._notificar_estado()

    def finalizar_lunch(self):
        with self._lock:
            if self.estado != "LUNCH":
                return
            cambiado = self._reanudar("fin_lunch")
            self._queue("lunch_finished")
        if cambiado:
            self._safe(self.on_shift_resume)
            self._notificar_estado()

    def reanudar(self):
        with self._lock:
            cambiado = self._reanudar("reanudar")
        if cambiado:
            self._safe(self.on_shift_resume)
            self._notificar_estado()

    def _pausar(self, nuevo_estado: str, accion: str) -> bool:
        if self.estado != "TRABAJANDO":
            return False
        self.estado = nuevo_estado
        self._log(accion)
        self.tracker.pausado = True
        return True

    def _reanudar(self, accion: str) -> bool:
        if self.estado not in ("BREAK", "LUNCH"):
            return False
        self.estado = "TRABAJANDO"
        self._log(accion)
        self.tracker.pausado = False
        return True

    # ---- codigos de autorizacion (validados siempre por el servidor) --
    def consumir_codigo_acceso(self, codigo: str, tipo: str) -> dict | None:
        """Valida y consume un codigo en el servidor. Nunca se aceptan codigos
        sin validacion del servidor (tampoco sin conexion).

        Hace una peticion de red: la interfaz debe llamarla desde un hilo de trabajo.
        """
        self.ultimo_error_codigo = ""
        codigo = (codigo or "").strip().upper()
        if not codigo:
            self.ultimo_error_codigo = "Ingresa el codigo de autorizacion."
            return None

        if codigo in self.horas_extra_codigos_usados:
            self.ultimo_error_codigo = "Este codigo ya fue usado en esta estacion."
            return None

        base_url = getattr(self.cfg, "evidence_backend_url", "").rstrip("/")
        device_token = getattr(self.cfg, "evidence_device_token", "")
        backend_enabled = bool(getattr(self.cfg, "evidence_backend_enabled", False))
        if not backend_enabled or not base_url or not device_token:
            self.ultimo_error_codigo = "La validacion con el servidor no esta configurada."
            return None

        try:
            response = requests.post(
                f"{base_url}/api/station/access-codes/consume",
                headers={"X-Device-Token": device_token},
                json={"code": codigo, "type": tipo},
                timeout=int(getattr(self.cfg, "evidence_request_timeout", 30)),
            )
        except requests.RequestException as exc:
            log.warning("No se pudo validar el codigo (%s): %s", tipo, exc)
            self.ultimo_error_codigo = (
                "Sin conexion con el servidor de VYNTRA. Los codigos solo se validan "
                "en linea; intenta de nuevo cuando tengas conexion."
            )
            return None

        if response.status_code >= 400:
            try:
                detail = response.json().get("detail")
            except (ValueError, AttributeError):
                detail = None
            self.ultimo_error_codigo = (
                detail if isinstance(detail, str) and detail else "Codigo invalido, vencido o ya utilizado."
            )
            return None

        try:
            payload = response.json()
        except ValueError:
            self.ultimo_error_codigo = "Respuesta invalida del servidor."
            return None

        authorization = payload.get("authorization") or {}
        if not payload.get("ok") or authorization.get("type") != tipo:
            self.ultimo_error_codigo = "El servidor no confirmo la autorizacion."
            return None
        return authorization

    # ---- restauracion por administrador ------------------------------
    def restaurar_jornada(self):
        with self._lock:
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
            self._clean_shutdown = False
            self._log("restaurar_jornada")
            self._queue("shift_restored_by_admin")
            self.tracker.pausado = False
            self._iniciar_tracker()
            self._arrancar_reloj()
        self._safe(self.on_shift_start)
        self._notificar_estado()

    def restaurar_jornada_con_codigo(self, codigo: str) -> bool:
        if self.estado != "TERMINADO":
            self.ultimo_error_codigo = "No hay una jornada terminada para reabrir."
            return False
        autorizacion = self.consumir_codigo_acceso(codigo, "station_reopen")
        if not autorizacion:
            return False
        self.restaurar_jornada()
        append_event(
            "station_restore_code_used",
            {
                "codigo": autorizacion.get("code"),
                "autorizacion_id": autorizacion.get("id"),
                "motivo": autorizacion.get("reason", ""),
                "empleado": getpass.getuser(),
                "equipo": socket.gethostname(),
                "timestamp": self.clock.now().isoformat(),
            },
        )
        return True

    def resetear_reloj(self):
        with self._lock:
            if self.estado not in ("TRABAJANDO", "BREAK", "LUNCH"):
                return
            self.seg_trabajado = 0
            self.seg_break = 0
            self.seg_lunch = 0
            self.inicio_jornada = self.clock.now()
            self._log("resetear_reloj")
            self._queue("shift_clock_reset")
            self._guardar()
        self._notificar_estado()

    def restaurar_break(self):
        with self._lock:
            if not self.break_consumido:
                return
            self.break_consumido = False
            self._log("restaurar_break")
            self._queue("break_restored_by_admin")
        self._notificar_estado()

    def restaurar_lunch(self):
        with self._lock:
            if not self.lunch_consumido:
                return
            self.lunch_consumido = False
            self._log("restaurar_lunch")
            self._queue("lunch_restored_by_admin")
        self._notificar_estado()

    def resume_runtime_if_needed(self):
        """Reactiva hilos y hooks despues de cargar una jornada en curso."""
        with self._lock:
            if self.estado not in ACTIVE_STATES:
                if self.horas_extra_estado != "ACTIVA":
                    return
                self.tracker.pausado = False
                self._iniciar_tracker()
                self._arrancar_reloj()
                pausar = False
            else:
                self.tracker.pausado = self.estado in ("BREAK", "LUNCH")
                self._iniciar_tracker()
                self._arrancar_reloj()
                pausar = self.estado in ("BREAK", "LUNCH")
        self._safe(self.on_shift_start)
        if pausar:
            self._safe(self.on_shift_pause)
        self._notificar_estado()

    # ---- reloj --------------------------------------------------------
    @property
    def reloj_activo(self) -> bool:
        return self._clock_stop is not None and not self._clock_stop.is_set()

    @property
    def _running(self) -> bool:  # compatibilidad con codigo anterior
        return self.reloj_activo

    @property
    def hilo_reloj_vivo(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def _debe_correr_reloj(self) -> bool:
        return self.estado in ACTIVE_STATES or self.horas_extra_estado == "ACTIVA"

    def _arrancar_reloj(self, preservar_referencia: bool = False):
        with self._lock:
            if self.reloj_activo and (not self.threaded or self.hilo_reloj_vivo):
                return
            if self._clock_stop is not None:
                self._clock_stop.set()
            stop_event = threading.Event()
            self._clock_stop = stop_event
            if not preservar_referencia:
                # Al (re)iniciar la jornada se mide desde ahora. Al reiniciar un
                # hilo caido se conserva la referencia para que el siguiente tick
                # cuente el tiempo intermedio (o lo trate como hueco si es largo).
                self._last_mono = self.clock.monotonic()
                self._last_wall = self.clock.time()
                self._carry = 0.0
                self._last_periodic_save = self._last_mono
                self._last_activity_snapshot_sync = self._last_mono
            if self.threaded:
                self._thread = threading.Thread(
                    target=self._loop, args=(stop_event,), name="vyntra-shift-clock", daemon=True
                )
                self._thread.start()

    def _detener_reloj(self):
        with self._lock:
            if self._clock_stop is not None:
                self._clock_stop.set()

    def restart_dead_threads(self) -> list[str]:
        """Reinicia hilos que deberian estar corriendo y murieron (healthcheck)."""
        reiniciados = []
        with self._lock:
            if not self._debe_correr_reloj():
                return reiniciados
            if self.threaded and (not self.reloj_activo or not self.hilo_reloj_vivo):
                self._clock_stop = None
                self._arrancar_reloj(preservar_referencia=True)
                reiniciados.append("shift_clock")
            tracker_vivo = getattr(self.tracker, "hilo_vivo", True)
            if not self.tracker.activo or not tracker_vivo:
                self.tracker.pausado = self.estado in ("BREAK", "LUNCH")
                self._iniciar_tracker(forzar=True)
                reiniciados.append("activity_tracker")
        return reiniciados

    def _loop(self, stop_event: threading.Event):
        while not stop_event.is_set():
            try:
                self._tick(stop_event)
            except Exception:
                log.exception("Error en el reloj de jornada")
            if stop_event.wait(1):
                return

    def _consumir_segundos(self, delta: float) -> int:
        total = max(0.0, delta) + self._carry
        whole = int(total)
        self._carry = total - whole
        return whole

    def _acumular(self, segundos: int):
        if segundos <= 0:
            return
        if self.estado == "TRABAJANDO":
            self.seg_trabajado += segundos
        elif self.estado == "BREAK":
            self.seg_break += segundos
        elif self.estado == "LUNCH":
            self.seg_lunch += segundos
        if self.horas_extra_estado == "ACTIVA":
            self.seg_horas_extra += segundos
            if self.horas_extra_asignadas_segundos > 0:
                self.seg_horas_extra = min(self.seg_horas_extra, self.horas_extra_asignadas_segundos)

    def _tick(self, stop_event: threading.Event | None = None):
        hueco = None
        finalizar_he = False
        with self._lock:
            if stop_event is not None and stop_event.is_set():
                return
            if stop_event is None and not self.reloj_activo:
                return
            now_mono = self.clock.monotonic()
            now_wall = self.clock.time()
            delta_mono = now_mono - self._last_mono
            delta_wall = now_wall - self._last_wall
            self._last_mono = now_mono
            self._last_wall = now_wall

            contar = 0.0
            if delta_mono > SUSPEND_GAP_SECONDS:
                hueco = (delta_mono, "monotonic")
                self._carry = 0.0
            elif delta_wall - delta_mono > SUSPEND_GAP_SECONDS:
                # El reloj monotono no avanzo durante la suspension (o se cambio
                # la hora del sistema): solo se cuenta el tiempo monotono.
                hueco = (delta_wall - delta_mono, "wall_clock")
                contar = delta_mono
            elif delta_mono > 0:
                contar = delta_mono
            self._acumular(self._consumir_segundos(contar))

            if (
                self.horas_extra_estado == "ACTIVA"
                and self.horas_extra_asignadas_segundos > 0
                and self.seg_horas_extra >= self.horas_extra_asignadas_segundos
            ):
                finalizar_he = True

            info = {
                "estado": self.estado,
                "trabajado": self.seg_trabajado,
                "break": self.seg_break,
                "lunch": self.seg_lunch,
                "horas_extra": self.seg_horas_extra,
                "horas_extra_estado": self.horas_extra_estado,
                "horas_extra_asignadas": self.horas_extra_asignadas_segundos,
                "hora": self.clock.now().strftime("%H:%M:%S"),
                "snapshot": self.ultimo_snapshot,
            }
            guardar = now_mono - self._last_periodic_save >= PERIODIC_SAVE_SECONDS
            if guardar:
                self._last_periodic_save = now_mono
            sincronizar = now_mono - self._last_activity_snapshot_sync >= ACTIVITY_SNAPSHOT_SECONDS
            if sincronizar:
                self._last_activity_snapshot_sync = now_mono

        if hueco:
            self._registrar_suspension(hueco[0], hueco[1])
        if finalizar_he:
            self.finalizar_horas_extra()
        if self.on_tick:
            self._safe(lambda: self.on_tick(info))
        if guardar:
            self._guardar()
        if sincronizar:
            self._queue("activity_snapshot")

    def _registrar_suspension(self, segundos: float, origen: str):
        fin = self.clock.now()
        inicio = fin - datetime.timedelta(seconds=segundos)
        with self._lock:
            payload = self.snapshot()
            payload.update(
                {
                    "gap_inicio": inicio.isoformat(),
                    "gap_fin": fin.isoformat(),
                    "gap_segundos": int(segundos),
                    "origen_deteccion": origen,
                    "contado_como_trabajo": False,
                    "requiere_revision": True,
                }
            )
            self._log("suspension_detectada")
        append_event("suspend_detected", payload)
        log.warning(
            "Suspension detectada (%s): %s s entre %s y %s; no se cuenta como trabajado",
            origen, int(segundos), inicio.isoformat(), fin.isoformat(),
        )
        self._avisar(
            f"Se detecto una suspension o congelamiento del equipo de {_fmt_minutos(segundos)} "
            f"({inicio:%H:%M} - {fin:%H:%M}). Ese tiempo no se conto como trabajado; "
            "RR. HH. podra revisarlo."
        )

    # ---- incidencias --------------------------------------------------
    def registrar_excepcion(self, tipo: str, detalle: dict):
        titulo = {
            "correccion_marcaje": "Correccion de marcaje",
            "permiso_vacaciones": "Permisos o vacaciones",
            "tiempo_perdido": "Tiempo perdido por sistema",
        }.get(tipo, "Incidencia")
        requested_at = self.clock.now().isoformat()
        with self._lock:
            registro = {
                "tipo": tipo,
                "incident_type": tipo,
                "titulo": titulo,
                "motivo": str(detalle.get("motivo") or "").strip(),
                "horas": str(detalle.get("horas") or "").strip(),
                "problema": str(detalle.get("problema") or "").strip(),
                "verificacion": str(detalle.get("verificacion") or "").strip(),
                "evidencia_tecnica": detalle.get("evidencia_tecnica") or {},
                "detalle": detalle,
                "estado_jornada": self.estado,
                "inicio_jornada": self.inicio_jornada.isoformat() if self.inicio_jornada else None,
                "fin_jornada": self.fin_jornada.isoformat() if self.fin_jornada else None,
                "seg_trabajado": self.seg_trabajado,
                "seg_break": self.seg_break,
                "seg_lunch": self.seg_lunch,
                "empleado": getpass.getuser(),
                "equipo": socket.gethostname(),
                "timestamp": requested_at,
                "requested_at": requested_at,
            }
            self.excepciones.append(registro)
        event = append_event("incident_submitted", registro)
        registro["source_event_id"] = event.get("id")
        self._guardar()
        return registro

    def solicitar_horas_extra(self, dia: str, hora_salida: str, motivo: str) -> dict:
        registro = {
            "dia": dia,
            "hora_salida": hora_salida,
            "motivo": motivo,
            "estado": "pendiente_autorizacion",
            "empleado": getpass.getuser(),
            "equipo": socket.gethostname(),
            "timestamp": self.clock.now().isoformat(),
        }
        with self._lock:
            self.horas_extra_solicitud = registro
        self._guardar()
        append_event("overtime_requested", registro)
        return registro

    def activar_horas_extra_con_codigo(self, codigo: str, origen: str = "codigo", asignacion: dict | None = None) -> bool:
        """Activa horas extra solo con un codigo validado por el servidor.

        Hace una peticion de red: la interfaz debe llamarla desde un hilo de trabajo.
        """
        codigo = (codigo or "").strip().upper()
        autorizacion = self.consumir_codigo_acceso(codigo, "overtime")
        if not autorizacion:
            return False
        with self._lock:
            if codigo in self.horas_extra_codigos_usados:
                self.ultimo_error_codigo = "Este codigo ya fue usado en esta estacion."
                return False
            self.ultimo_error_codigo = ""
            self.horas_extra_estado = "ACTIVA"
            self.horas_extra_codigo = codigo
            self.horas_extra_origen = origen
            self.horas_extra_inicio = self.clock.now()
            self.horas_extra_fin = None
            self.seg_horas_extra = 0
            try:
                minutos = int(
                    autorizacion.get("assigned_minutes")
                    or autorizacion.get("minutos_asignados")
                    or 60
                )
            except (TypeError, ValueError):
                minutos = 60
            self.horas_extra_asignadas_segundos = max(1, minutos) * 60
            self.horas_extra_asignacion = asignacion if asignacion else autorizacion
            self.horas_extra_codigos_usados.append(codigo)
            self._log("inicio_horas_extra")
            self._queue("overtime_started")
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
        with self._lock:
            self.horas_extra_estado = "PENDIENTE_ASIGNACION"
            self.horas_extra_asignacion = asignacion
        self._guardar()
        append_event("overtime_assigned", asignacion)
        self._notificar_estado()

    def finalizar_horas_extra(self, notificar: bool = True):
        with self._lock:
            if self.horas_extra_estado != "ACTIVA":
                return
            self.horas_extra_estado = "FINALIZADA"
            self.horas_extra_fin = self.clock.now()
            self._log("fin_horas_extra")
            self._queue("overtime_finished")
            if self.estado not in ACTIVE_STATES:
                self._detener_reloj()
            self._guardar()
        if notificar:
            self._notificar_estado()

    # ---- persistencia -------------------------------------------------
    def _log(self, accion: str):
        with self._lock:
            self.eventos.append(
                {
                    "accion": accion,
                    "estado": self.estado,
                    "timestamp": self.clock.now().isoformat(),
                }
            )
        self._guardar()

    def _queue(self, tipo: str) -> dict:
        """Encola un evento con el estado de la jornada y SOLO las muestras de
        actividad nuevas desde el envio anterior (envio incremental)."""
        muestras = self.tracker.tomar_muestras_pendientes()
        with self._lock:
            payload = self.snapshot(muestras=muestras)
        return append_event(tipo, payload)

    def _telemetria(self, muestras: list[dict] | None) -> dict:
        base = self.tracker.snapshot(muestras=muestras or []) if muestras is not None else dict(self.ultimo_snapshot or {})
        if muestras is None:
            base["muestras_recientes"] = []
        return base

    def snapshot(self, muestras: list[dict] | None = None) -> dict:
        """Estado de la jornada para eventos.

        `muestras`: muestras de actividad a incluir (solo las nuevas). Por defecto
        no se reenvian muestras ya enviadas.
        """
        with self._lock:
            return {
                "estado": self.estado,
                "shift_id": self.shift_id,
                "empleado": getpass.getuser(),
                "equipo": socket.gethostname(),
                # Fecha local de INICIO de la jornada: un turno nocturno que cruza
                # medianoche no se divide en dos jornadas en el servidor.
                "fecha": (self.fecha_jornada or self.clock.now().date()).isoformat(),
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
                "horas_extra_codigos_usados": list(self.horas_extra_codigos_usados),
                "break_consumido": self.break_consumido,
                "lunch_consumido": self.lunch_consumido,
                "telemetria": self._telemetria(muestras),
                "timestamp": self.clock.now().isoformat(),
            }

    def _ruta_bitacora(self) -> str:
        carpeta = jornadas_dir()
        if not self._archivado_hecho:
            self._archivado_hecho = True
            self._archivar_jornadas_antiguas(carpeta)
        fecha = self.fecha_jornada or self.clock.now().date()
        return _ruta_por_fecha(fecha)

    def _archivar_jornadas_antiguas(self, carpeta_jornadas: str):
        """Archiva jornadas con mas de 30 dias y limpia la carpeta."""
        try:
            limite = datetime.datetime.now() - datetime.timedelta(days=30)
            for archivo in os.listdir(carpeta_jornadas):
                if not (archivo.startswith("jornada_") and archivo.endswith(".json")):
                    continue
                try:
                    fecha_str = archivo.replace("jornada_", "").replace(".json", "")
                    fecha = datetime.datetime.strptime(fecha_str, "%Y%m%d")
                    if fecha < limite:
                        carpeta_archivo = os.path.join(carpeta_jornadas, "archivo")
                        os.makedirs(carpeta_archivo, exist_ok=True)
                        os.replace(
                            os.path.join(carpeta_jornadas, archivo),
                            os.path.join(carpeta_archivo, archivo),
                        )
                except (ValueError, OSError) as exc:
                    log.warning("No se pudo archivar %s: %s", archivo, exc)
        except OSError as exc:
            log.warning("No se pudo revisar la carpeta de jornadas: %s", exc)

    def _datos_persistencia(self) -> dict:
        telemetria = dict(self.ultimo_snapshot or {})
        if isinstance(telemetria.get("muestras_recientes"), list):
            telemetria["muestras_recientes"] = telemetria["muestras_recientes"][-PERSISTED_SAMPLES:]
        return {
            "version": 2,
            "shift_id": self.shift_id,
            "estado": self.estado,
            "empleado": getpass.getuser(),
            "equipo": socket.gethostname(),
            "fecha": (self.fecha_jornada or self.clock.now().date()).isoformat(),
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
            "horas_extra_codigos_usados": list(self.horas_extra_codigos_usados),
            "break_consumido": self.break_consumido,
            "lunch_consumido": self.lunch_consumido,
            "eventos": list(self.eventos),
            "excepciones": list(self.excepciones),
            "telemetria": telemetria,
            "cierre_snapshot": self._cierre_snapshot,
            "clean_shutdown": self._clean_shutdown,
            "last_update": self.clock.now().isoformat(),
            "last_heartbeat_epoch": self.clock.time(),
        }

    def _guardar(self):
        try:
            with self._lock:
                data = self._datos_persistencia()
                ruta = self._ruta_bitacora()
            tmp = f"{ruta}.tmp"
            with self._io_lock:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False, default=str)
                os.replace(tmp, ruta)
                origen = self._ruta_origen
                if origen and os.path.abspath(origen) != os.path.abspath(ruta) and os.path.exists(origen):
                    # Bitacora heredada (guardada con la fecha del dia y no la de
                    # inicio): se retira para que no se restaure dos veces.
                    os.replace(origen, f"{origen}.migrated")
                self._ruta_origen = None
        except Exception:
            log.exception("No se pudo guardar la bitacora de jornada")

    def _cargar_jornada(self):
        ruta, data = buscar_jornada_restaurable(self.clock.now())
        if not data:
            return
        self._ruta_origen = ruta

        self.estado = _estado_de(data)
        self.eventos = data.get("eventos", []) or []
        self.excepciones = data.get("excepciones", []) or []
        self.seg_trabajado = int(data.get("seg_trabajado", 0) or 0)
        self.seg_break = int(data.get("seg_break", 0) or 0)
        self.seg_lunch = int(data.get("seg_lunch", 0) or 0)
        self.seg_horas_extra = int(data.get("seg_horas_extra", 0) or 0)
        self.break_consumido = bool(data.get("break_consumido", False))
        self.lunch_consumido = bool(data.get("lunch_consumido", False))
        self.horas_extra_estado = data.get("horas_extra_estado", "SIN_HORAS_EXTRA")
        self.horas_extra_codigo = data.get("horas_extra_codigo", "")
        self.horas_extra_origen = data.get("horas_extra_origen", "")
        self.horas_extra_inicio = parse_iso(data.get("horas_extra_inicio"))
        self.horas_extra_fin = parse_iso(data.get("horas_extra_fin"))
        self.horas_extra_asignadas_segundos = int(
            data.get("horas_extra_asignadas_segundos", 0) or 0
        )
        self.horas_extra_solicitud = data.get("horas_extra_solicitud")
        self.horas_extra_asignacion = data.get("horas_extra_asignacion")
        self.horas_extra_codigos_usados = data.get("horas_extra_codigos_usados", []) or []
        self.ultimo_snapshot = data.get("telemetria", {}) or {}
        self.inicio_jornada = parse_iso(data.get("inicio_jornada"))
        self.fin_jornada = parse_iso(data.get("fin_jornada"))
        self._cierre_snapshot = data.get("cierre_snapshot")
        self.shift_id = str(data.get("shift_id") or "")

        fecha = None
        if data.get("shift_id") and data.get("fecha"):
            try:
                fecha = datetime.date.fromisoformat(str(data.get("fecha")))
            except ValueError:
                fecha = None
        if fecha is None and self.inicio_jornada is not None:
            fecha = self.inicio_jornada.date()
        if fecha is None:
            try:
                fecha = datetime.date.fromisoformat(str(data.get("fecha")))
            except (TypeError, ValueError):
                fecha = self.clock.now().date()
        self.fecha_jornada = fecha
        if not self.shift_id and _es_activa(data):
            self.shift_id = str(uuid.uuid4())

        if _es_activa(data):
            try:
                self.tracker.restore(self.ultimo_snapshot)
            except Exception:
                log.exception("No se pudo restaurar la telemetria")
            self._aplicar_recuperacion(data)

    def _aplicar_recuperacion(self, data: dict):
        """Aplica la ventana de recuperacion de 15 minutos (RF-16)."""
        ultimo = _heartbeat(data)
        ahora_wall = self.clock.time()
        hueco = max(0.0, ahora_wall - ultimo) if ultimo else 0.0
        cierre_normal = bool(data.get("clean_shutdown"))
        fin = self.clock.now()
        inicio = fin - datetime.timedelta(seconds=hueco)
        detalle = {
            "gap_inicio": inicio.isoformat(),
            "gap_fin": fin.isoformat(),
            "gap_segundos": int(hueco),
            "cierre_normal": cierre_normal,
            "ventana_recuperacion_segundos": RECOVERY_WINDOW_SECONDS,
        }

        with self._lock:
            self._clean_shutdown = False
            if hueco <= RECOVERY_WINDOW_SECONDS:
                contado = not cierre_normal
                if contado:
                    # Cierre imprevisto y reapertura dentro de la ventana: la
                    # jornada continua como si no se hubiera interrumpido.
                    self._acumular(int(hueco))
                self._log("recuperacion_jornada")
                payload = self.snapshot()
                payload.update(detalle)
                payload["contado_como_trabajo"] = contado
                tipo = "shift_recovered"
            else:
                self._log("recuperacion_con_hueco")
                payload = self.snapshot()
                payload.update(detalle)
                payload["contado_como_trabajo"] = False
                payload["requiere_revision"] = True
                tipo = "recovery_gap"
        # Se guarda de inmediato para que un segundo cierre no vuelva a contar el hueco.
        self._guardar()
        append_event(tipo, payload)
        log.info("Jornada recuperada (%s): hueco de %s s, cierre_normal=%s", tipo, int(hueco), cierre_normal)
        if tipo == "recovery_gap":
            self._avisar(
                f"Se restauro tu jornada. La estacion estuvo cerrada {_fmt_minutos(hueco)} "
                f"(desde las {inicio:%H:%M}); ese tiempo no se conto como trabajado. "
                "Si trabajaste en ese periodo, reportalo como falla tecnica para revision de RR. HH."
            )

    # ---- auxiliares ---------------------------------------------------
    def _reset_tracker(self):
        try:
            self.tracker.reset()
        except Exception:
            log.exception("No se pudo reiniciar la telemetria")

    def _iniciar_tracker(self, forzar: bool = False):
        if not self.threaded:
            return
        if forzar:
            self.tracker.stop()
        self.tracker.start()

    def _on_tracker(self, snap):
        self.ultimo_snapshot = snap

    def _avisar(self, mensaje: str):
        """Informa al usuario (o guarda el aviso hasta que la interfaz lo lea)."""
        if self.on_notice:
            self._safe(lambda: self.on_notice(mensaje))
        else:
            self.avisos.append(mensaje)

    def tomar_avisos(self) -> list[str]:
        avisos, self.avisos = self.avisos, []
        return avisos

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
            log.exception("Callback de jornada fallo")
