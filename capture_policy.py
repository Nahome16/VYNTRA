"""
capture_policy.py - Politica de captura minima del agente VYNTRA.

La lista de aplicaciones permitidas son las reglas de productividad que la
empresa configura en la plataforma web (descargadas por RulesDownloader).
Antes de guardar o transmitir cualquier dato, el titulo literal de la ventana
se sustituye por un identificador normalizado:

- Si una regla con `title_contains` coincide, el identificador es ese patron.
- Si solo coincide una regla por ejecutable, el identificador es LISTED_APP_TITLE.
- Si ninguna regla coincide, el identificador es UNLISTED_TITLE.

La evidencia visual solo se permite cuando la regla que prevalece clasifica la
aplicacion como productiva, es decir, sobre herramientas de trabajo.
El titulo literal solo se usa en memoria para hacer la comparacion.
"""

import threading

UNLISTED_TITLE = "(fuera de lista)"
LISTED_APP_TITLE = "(aplicacion permitida)"
MAX_IDENTIFIER_LENGTH = 120

_lock = threading.Lock()
_rules: list[dict] = []


def set_rules(rules) -> None:
    """Reemplaza la lista de reglas vigente (la llama RulesDownloader)."""
    clean = [rule for rule in (rules or []) if isinstance(rule, dict)]
    with _lock:
        _rules[:] = clean


def _rank(rule: dict) -> int:
    return int(rule.get("scope_score") or 0) + int(rule.get("priority") or 0)


def _evaluate(executable_name: str, window_title: str) -> tuple[str | None, str]:
    """Devuelve (identificador o None si esta fuera de lista, clasificacion que prevalece)."""
    executable = (executable_name or "").strip().lower()
    title_lower = (window_title or "").strip().lower()
    with _lock:
        rules = list(_rules)

    best_title = None
    best_any = None
    executable_match = False
    for rule in rules:
        rule_executable = str(rule.get("executable_name") or "").strip().lower()
        pattern = str(rule.get("title_contains") or "").strip()
        if not rule_executable and not pattern:
            continue
        if rule_executable and rule_executable != executable:
            continue
        if pattern and pattern.lower() not in title_lower:
            continue
        if pattern:
            if best_title is None or _rank(rule) > _rank(best_title):
                best_title = rule
        else:
            executable_match = True
        if best_any is None or _rank(rule) > _rank(best_any):
            best_any = rule

    classification = str(best_any.get("classification") or "") if best_any else ""
    if best_title is not None:
        return str(best_title.get("title_contains")).strip()[:MAX_IDENTIFIER_LENGTH], classification
    if executable_match:
        return LISTED_APP_TITLE, classification
    return None, classification


def normalize_title(executable_name: str, window_title: str) -> tuple[str, bool]:
    """Devuelve (identificador_normalizado, esta_en_lista)."""
    identifier, _ = _evaluate(executable_name, window_title)
    if identifier is None:
        return UNLISTED_TITLE, False
    return identifier, True


def evidence_allowed(executable_name: str, window_title: str) -> bool:
    """La evidencia visual solo se captura sobre aplicaciones clasificadas como productivas."""
    identifier, classification = _evaluate(executable_name, window_title)
    return identifier is not None and classification == "productive"
