"""
capture_policy.py - Politica de captura minima aplicada en el servidor.

Es la segunda barrera de la politica que el agente y la extension aplican en el
equipo: aunque un cliente desactualizado envie titulos de ventana, URL o
dominios literales, nada de eso se almacena. La lista de aplicaciones
permitidas son las reglas de productividad activas que aplican al empleado.

- Si una regla con `title_contains` coincide, el titulo se sustituye por ese patron.
- Si solo coincide una regla por ejecutable, se sustituye por LISTED_APP_TITLE.
- Si ninguna coincide, se sustituye por UNLISTED_TITLE o UNLISTED_SITE_TITLE.
"""

from copy import deepcopy
from dataclasses import dataclass

UNLISTED_TITLE = "(fuera de lista)"
UNLISTED_SITE_TITLE = "(sitio fuera de lista)"
LISTED_APP_TITLE = "(aplicacion permitida)"
MAX_IDENTIFIER_LENGTH = 120
BROWSER_EXECUTABLES = {"browser", "browser-extension"}
DROPPED_KEYS = {"url", "url_actual", "dominio"}


@dataclass(frozen=True)
class ScopedRule:
    executable_name: str
    title_contains: str
    rank: int


def normalize_window_title(rules: list[ScopedRule], executable_name: str, title: str) -> str:
    executable = (executable_name or "").strip().lower()
    title_lower = (title or "").strip().lower()
    best: ScopedRule | None = None
    executable_match = False
    for rule in rules:
        rule_executable = (rule.executable_name or "").strip().lower()
        pattern = (rule.title_contains or "").strip()
        if not rule_executable and not pattern:
            continue
        if rule_executable and rule_executable != executable:
            continue
        if not pattern:
            executable_match = True
            continue
        if pattern.lower() in title_lower and (best is None or rule.rank > best.rank):
            best = rule
    if best is not None:
        return best.title_contains.strip()[:MAX_IDENTIFIER_LENGTH]
    if executable_match:
        return LISTED_APP_TITLE
    if executable in BROWSER_EXECUTABLES:
        return UNLISTED_SITE_TITLE
    return UNLISTED_TITLE


def _normalize_resource(rules: list[ScopedRule], value, default_executable: str = ""):
    """Normaliza valores con forma 'proceso | titulo' o un titulo suelto."""
    if not isinstance(value, str):
        return value
    if " | " in value:
        executable, title = value.split(" | ", 1)
        return f"{executable} | {normalize_window_title(rules, executable, title)}"
    if default_executable:
        return normalize_window_title(rules, default_executable, value)
    return value


def _sanitize_sample(rules: list[ScopedRule], sample):
    if not isinstance(sample, dict):
        return sample
    clean = {key: value for key, value in sample.items() if key not in DROPPED_KEYS}
    executable = str(clean.get("proceso") or "")
    for key in ("titulo", "ventana"):
        if key in clean:
            clean[key] = normalize_window_title(rules, executable, str(clean.get(key) or ""))
    return clean


def _sanitize(rules: list[ScopedRule], node, browser_payload: bool):
    if isinstance(node, list):
        return [_sanitize(rules, item, browser_payload) for item in node]
    if not isinstance(node, dict):
        return node

    browser_payload = browser_payload or bool(node.get("browser_extension"))
    default_executable = "browser-extension" if browser_payload else ""
    clean = {}
    for key, value in node.items():
        if key in DROPPED_KEYS:
            continue
        if key == "muestras_recientes" and isinstance(value, list):
            clean[key] = [_sanitize_sample(rules, sample) for sample in value]
        elif key == "tiempo_por_recurso" and isinstance(value, dict):
            merged: dict[str, float] = {}
            for resource, seconds in value.items():
                normalized = _normalize_resource(rules, resource)
                try:
                    merged[normalized] = merged.get(normalized, 0) + seconds
                except TypeError:
                    merged[normalized] = seconds
            clean[key] = merged
        elif key in ("recurso_actual", "titulo_actual"):
            clean[key] = _normalize_resource(rules, value, default_executable)
        elif key == "ventana_activa":
            clean[key] = normalize_window_title(rules, str(node.get("app_activa") or ""), str(value or ""))
        elif key == "ventana" and "proceso" in node:
            clean[key] = normalize_window_title(rules, str(node.get("proceso") or ""), str(value or ""))
        else:
            clean[key] = _sanitize(rules, value, browser_payload)
    return clean


def sanitize_capture_payload(rules: list[ScopedRule], payload: dict) -> dict:
    """Devuelve una copia del evento sin titulos literales, URL ni dominios."""
    if not isinstance(payload, dict):
        return payload
    return _sanitize(rules, deepcopy(payload), False)
