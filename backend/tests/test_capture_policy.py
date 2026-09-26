from app.capture_policy import (
    LISTED_APP_TITLE,
    UNLISTED_SITE_TITLE,
    UNLISTED_TITLE,
    ScopedRule,
    normalize_window_title,
    sanitize_capture_payload,
)

RULES = [
    ScopedRule(executable_name="excel.exe", title_contains="Presupuesto", rank=100),
    ScopedRule(executable_name="excel.exe", title_contains="Presupuesto 2026", rank=3100),
    ScopedRule(executable_name="slack.exe", title_contains="", rank=100),
    ScopedRule(executable_name="", title_contains="Jira", rank=100),
]


def test_title_rule_returns_pattern_with_highest_rank():
    assert normalize_window_title(RULES, "EXCEL.EXE", "Presupuesto 2026 - ventas.xlsx") == "Presupuesto 2026"
    assert normalize_window_title(RULES, "excel.exe", "Presupuesto Q1.xlsx") == "Presupuesto"


def test_executable_only_rule_hides_title():
    assert normalize_window_title(RULES, "slack.exe", "DM con Juan - secreto") == LISTED_APP_TITLE


def test_unlisted_titles_are_replaced():
    assert normalize_window_title(RULES, "notepad.exe", "diario personal.txt") == UNLISTED_TITLE
    assert normalize_window_title(RULES, "browser", "Banco - cuenta 1234") == UNLISTED_SITE_TITLE
    assert normalize_window_title(RULES, "chrome.exe", "Tablero Jira - sprint") == "Jira"


def test_sanitize_drops_urls_and_normalizes_nested_titles():
    payload = {
        "estado": "TRABAJANDO",
        "url_actual": "https://banco.example/cuenta",
        "telemetria": {
            "dominio": "banco.example",
            "recurso_actual": "notepad.exe | diario personal.txt",
            "tiempo_por_recurso": {
                "excel.exe | Presupuesto 2026.xlsx": 10,
                "excel.exe | Presupuesto 2026 v2.xlsx": 5,
                "notepad.exe | carta.txt": 3,
            },
            "muestras_recientes": [
                {
                    "timestamp": "2026-09-26T08:00:00",
                    "proceso": "excel.exe",
                    "titulo": "Presupuesto 2026 - privado.xlsx",
                    "url": "https://x.example",
                },
                {"timestamp": "2026-09-26T08:00:10", "proceso": "notepad.exe", "titulo": "claves.txt"},
            ],
        },
        "evidencia_tecnica": {"app_activa": "slack.exe", "ventana_activa": "DM con Ana"},
    }
    original = repr(payload)
    clean = sanitize_capture_payload(RULES, payload)

    assert repr(payload) == original, "sanitize must not mutate its input"
    assert "url_actual" not in clean
    assert "dominio" not in clean["telemetria"]
    samples = clean["telemetria"]["muestras_recientes"]
    assert samples[0]["titulo"] == "Presupuesto 2026"
    assert "url" not in samples[0]
    assert samples[1]["titulo"] == UNLISTED_TITLE
    assert clean["telemetria"]["recurso_actual"] == f"notepad.exe | {UNLISTED_TITLE}"
    assert clean["telemetria"]["tiempo_por_recurso"] == {
        "excel.exe | Presupuesto 2026": 15,
        f"notepad.exe | {UNLISTED_TITLE}": 3,
    }
    assert clean["evidencia_tecnica"]["ventana_activa"] == LISTED_APP_TITLE
    serialized = repr(clean)
    for secret in ("privado", "claves", "banco.example", "DM con Ana", "diario personal"):
        assert secret not in serialized


def test_browser_extension_payload_uses_site_placeholder():
    clean = sanitize_capture_payload(RULES, {"browser_extension": True, "titulo_actual": "Mi banco"})
    assert clean["titulo_actual"] == UNLISTED_SITE_TITLE
