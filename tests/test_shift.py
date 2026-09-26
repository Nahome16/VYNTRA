import datetime
import json

import pytest
import requests

import outbox
import shift as shift_module
from shift import RECOVERY_WINDOW_SECONDS, ShiftManager

TZ = datetime.timezone(datetime.timedelta(hours=-6))


def _today_at(hour, minute=0):
    today = datetime.datetime.now(TZ).date()
    return datetime.datetime(today.year, today.month, today.day, hour, minute, tzinfo=TZ)


def _events(tipo=None):
    events = outbox.read_pending(limit=1000)
    return [event for event in events if tipo is None or event["tipo"] == tipo]


def _tick_seconds(manager, clock, seconds, step=1.0):
    elapsed = 0.0
    while elapsed < seconds:
        clock.advance(step)
        manager._tick()
        elapsed += step


@pytest.fixture
def clock(make_clock):
    return make_clock(_today_at(9))


def _manager(cfg, clock):
    return ShiftManager(cfg, clock=clock, threaded=False)


def test_clock_counts_monotonic_deltas_without_drift(fake_cfg, clock):
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    _tick_seconds(manager, clock, 10, step=1.0)
    assert manager.seg_trabajado == 10
    # Ticks irregulares (hilo retrasado) no pierden ni duplican tiempo.
    _tick_seconds(manager, clock, 5, step=0.5)
    clock.advance(2.5)
    manager._tick()
    assert manager.seg_trabajado == 17


def test_break_and_lunch_counters(fake_cfg, clock):
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    _tick_seconds(manager, clock, 3)
    manager.iniciar_break()
    _tick_seconds(manager, clock, 4)
    manager.finalizar_break()
    manager.iniciar_lunch()
    _tick_seconds(manager, clock, 5)
    manager.finalizar_lunch()
    assert (manager.seg_trabajado, manager.seg_break, manager.seg_lunch) == (3, 4, 5)


def test_suspend_gap_not_counted_and_reported(fake_cfg, clock):
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    _tick_seconds(manager, clock, 60)
    clock.advance(600)  # equipo suspendido 10 minutos
    manager._tick()
    _tick_seconds(manager, clock, 5)
    assert manager.seg_trabajado == 65
    events = _events("suspend_detected")
    assert len(events) == 1
    payload = events[0]["payload"]
    assert payload["gap_segundos"] == 600
    assert payload["contado_como_trabajo"] is False
    assert datetime.datetime.fromisoformat(payload["gap_inicio"]).tzinfo is not None
    assert manager.avisos, "el usuario debe ser informado"
    assert manager.estado == "TRABAJANDO"


def test_wall_clock_jump_without_monotonic_is_reported_not_counted(fake_cfg, clock):
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    clock.advance(1)
    manager._tick()
    clock.advance(900, mono=False)  # el monotono no avanzo durante la suspension
    clock.advance(1)
    manager._tick()
    assert manager.seg_trabajado == 2
    assert _events("suspend_detected")[0]["payload"]["origen_deteccion"] == "wall_clock"


def test_crash_recovery_within_15_minutes_continues_shift(fake_cfg, clock):
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    _tick_seconds(manager, clock, 60)
    manager._guardar()
    worked = manager.seg_trabajado
    shift_id = manager.shift_id

    # Cierre imprevisto (sin shutdown_runtime) y reapertura 5 minutos despues.
    clock.advance(300)
    reopened = _manager(fake_cfg, clock)
    assert reopened.estado == "TRABAJANDO"
    assert reopened.shift_id == shift_id
    assert reopened.seg_trabajado == worked + 300
    recovered = _events("shift_recovered")
    assert recovered and recovered[-1]["payload"]["contado_como_trabajo"] is True
    assert not _events("recovery_gap")
    assert not reopened.avisos

    # Un segundo cierre inmediato no vuelve a contar el mismo hueco.
    again = _manager(fake_cfg, clock)
    assert again.seg_trabajado == worked + 300


def test_recovery_after_15_minutes_registers_gap_and_informs(fake_cfg, clock):
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    _tick_seconds(manager, clock, 120)
    manager._guardar()
    worked = manager.seg_trabajado

    clock.advance(RECOVERY_WINDOW_SECONDS + 60)
    reopened = _manager(fake_cfg, clock)
    assert reopened.estado == "TRABAJANDO"
    assert reopened.seg_trabajado == worked
    gaps = _events("recovery_gap")
    assert len(gaps) == 1
    assert gaps[0]["payload"]["gap_segundos"] == RECOVERY_WINDOW_SECONDS + 60
    assert gaps[0]["payload"]["contado_como_trabajo"] is False
    assert reopened.tomar_avisos(), "se informa al usuario del hueco"


def test_clean_close_does_not_count_closed_time(fake_cfg, clock):
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    _tick_seconds(manager, clock, 30)
    manager.shutdown_runtime()
    worked = manager.seg_trabajado
    clock.advance(240)
    reopened = _manager(fake_cfg, clock)
    assert reopened.estado == "TRABAJANDO"
    assert reopened.seg_trabajado == worked
    assert _events("shift_recovered")[-1]["payload"]["contado_como_trabajo"] is False


def test_night_shift_crossing_midnight_is_restored(fake_cfg, make_clock):
    start = _today_at(23, 55) - datetime.timedelta(days=1)
    clock = make_clock(start)
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    _tick_seconds(manager, clock, 60)
    manager._guardar()
    start_date = start.date().isoformat()
    assert manager.snapshot()["fecha"] == start_date

    # Pasa medianoche; la app se reabre dentro de la ventana de recuperacion.
    clock.advance(8 * 60)
    assert clock.now().date() != start.date()
    reopened = _manager(fake_cfg, clock)
    assert reopened.estado == "TRABAJANDO"
    assert reopened.shift_id == manager.shift_id
    snap = reopened.snapshot()
    assert snap["fecha"] == start_date, "la fecha de la jornada es la de inicio"
    _tick_seconds(reopened, clock, 5)
    reopened.finalizar_jornada()
    finished = _events("shift_finished")[-1]["payload"]
    assert finished["fecha"] == start_date
    assert datetime.datetime.fromisoformat(finished["fin_jornada"]).tzinfo is not None


def test_snapshot_timestamps_have_offset(fake_cfg, clock):
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    snap = manager.snapshot()
    for key in ("inicio_jornada", "timestamp"):
        assert datetime.datetime.fromisoformat(snap[key]).utcoffset() == datetime.timedelta(hours=-6)
    started = _events("shift_started")[0]
    assert datetime.datetime.fromisoformat(started["created_at"]).tzinfo is not None


def test_activity_samples_are_sent_as_delta(fake_cfg, clock, monkeypatch):
    import activity_tracker

    monkeypatch.setattr(activity_tracker, "get_idle_seconds", lambda: 0.0)
    monkeypatch.setattr(activity_tracker, "get_active_window", lambda: ("Reporte - Excel", "EXCEL.EXE"))
    manager = _manager(fake_cfg, clock)
    tracker = manager.tracker
    tracker._monotonic = clock.monotonic
    manager.iniciar_jornada()
    tracker._last_mono = clock.monotonic()

    for _ in range(3):
        clock.advance(3)
        tracker._tick()
    manager._queue("activity_snapshot")
    for _ in range(2):
        clock.advance(3)
        tracker._tick()
    manager._queue("activity_snapshot")
    manager._queue("activity_snapshot")

    snapshots = [e["payload"]["telemetria"]["muestras_recientes"] for e in _events("activity_snapshot")]
    assert [len(samples) for samples in snapshots] == [3, 2, 0]
    stamps = [sample["timestamp"] for samples in snapshots for sample in samples]
    assert len(stamps) == len(set(stamps))
    assert all(datetime.datetime.fromisoformat(stamp).tzinfo for stamp in stamps)
    # La ventana para la interfaz se conserva.
    assert len(tracker.snapshot()["muestras_recientes"]) == 5


def test_restart_does_not_leave_two_clock_threads(fake_cfg, clock):
    manager = ShiftManager(fake_cfg, clock=clock, threaded=True)
    manager.tracker.start = lambda: None  # sin hilos de telemetria en la prueba
    try:
        manager.iniciar_jornada()
        first_stop = manager._clock_stop
        manager.finalizar_jornada()
        manager.iniciar_jornada()
        assert first_stop.is_set()
        assert manager._clock_stop is not first_stop
        assert not manager._clock_stop.is_set()
        # El hilo viejo no cuenta tiempo aunque siga vivo unos instantes.
        before = manager.seg_trabajado
        manager._tick(first_stop)
        assert manager.seg_trabajado == before
    finally:
        manager.shutdown_runtime(join_timeout=2)


def test_overtime_code_rejected_offline_without_local_fallback(fake_cfg, clock, monkeypatch):
    fake_cfg.station_auth_allow_local_fallback = True
    manager = _manager(fake_cfg, clock)

    def offline(*_args, **_kwargs):
        raise requests.ConnectionError("sin red")

    monkeypatch.setattr(shift_module.requests, "post", offline)
    assert manager.activar_horas_extra_con_codigo("HE-120-ABCDEF") is False
    assert manager.horas_extra_estado != "ACTIVA"
    assert "conexion" in manager.ultimo_error_codigo.lower()
    assert not hasattr(ShiftManager, "resolver_codigo_horas_extra")


def test_persisted_state_for_updater(fake_cfg, clock):
    assert shift_module.persisted_shift_state(clock.now())[0] == "FUERA"
    manager = _manager(fake_cfg, clock)
    manager.iniciar_jornada()
    assert shift_module.persisted_shift_state(clock.now())[0] == "TRABAJANDO"
    manager.finalizar_jornada()
    assert shift_module.persisted_shift_state(clock.now())[0] == "TERMINADO"


def test_legacy_file_saved_with_today_date_is_migrated(fake_cfg, make_clock, isolated_appdata):
    clock = make_clock(_today_at(0, 5))
    yesterday = clock.now().date() - datetime.timedelta(days=1)
    folder = isolated_appdata / "VYNTRA" / "jornadas"
    folder.mkdir(parents=True)
    legacy = folder / f"jornada_{clock.now():%Y%m%d}.json"
    legacy.write_text(
        json.dumps(
            {
                "estado": "TRABAJANDO",
                "fecha": clock.now().date().isoformat(),
                "inicio_jornada": f"{yesterday.isoformat()}T22:00:00",
                "seg_trabajado": 7200,
                "last_update": (clock.now() - datetime.timedelta(seconds=30)).replace(tzinfo=None).isoformat(),
            }
        ),
        encoding="utf-8",
    )
    manager = _manager(fake_cfg, clock)
    assert manager.estado == "TRABAJANDO"
    assert manager.fecha_jornada == yesterday
    assert manager.shift_id
    assert manager.seg_trabajado >= 7200
    manager._guardar()
    assert (folder / f"jornada_{yesterday:%Y%m%d}.json").exists()
    assert not legacy.exists()
