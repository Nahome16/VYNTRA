"""
capture_policy.py - Politica de captura minima del agente VYNTRA.

La lista de aplicaciones permitidas son las reglas de productividad que la
empresa configura en la plataforma web (descargadas por RulesDownloader).
Antes de guardar o transmitir cualquier dato, el titulo literal de la ventana
se sustituye por un identificador normalizado:

- Si una regla con `title_contains` coincide, el identificador es ese patron.
- Si solo coincide una regla por ejecutable, el identificador es LISTED_APP_TITLE.
- Si ninguna regla coincide, el identificador es UNLISTED_TITLE.

Coincidencia de patrones:

- Patrones con forma de dominio (con punto y sin espacios, p. ej.
  `salesforce.com` o `.salesforce.com`): en el agente de escritorio no se
  conoce el host, asi que se buscan en el titulo con limites de palabra: el
  dominio (o un subdominio suyo, `app.salesforce.com`) debe aparecer completo,
  no como parte de otro dominio (`evil-salesforce.com`,
  `salesforce.com.evil.net`).
- Resto de patrones: coincidencia por subcadena sin distinguir mayusculas.

La evidencia visual solo se permite cuando la regla que prevalece clasifica la
aplicacion como productiva, es decir, sobre herramientas de trabajo.
El titulo literal solo se usa en memoria para hacer la comparacion.

El nombre del proceso se envia tal cual (lo permite el protocolo), truncado a
MAX_PROCESS_NAME_LENGTH caracteres.
"""

import re
import threading

UNLISTED_TITLE = "(fuera de lista)"
LISTED_APP_TITLE = "(aplicacion permitida)"
MAX_IDENTIFIER_LENGTH = 120
MAX_PROCESS_NAME_LENGTH = 80

_lock = threading.Lock()
_rules: list[dict] = []

_DOMAIN_RE = re.compile(r"^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$", re.IGNORECASE)
_pattern_cache: dict[str, "re.Pattern[str]"] = {}


def set_rules(rules) -> None:
    """Reemplaza la lista de reglas vigente (la llama RulesDownloader)."""
    clean = [rule for rule in (rules or []) if isinstance(rule, dict)]
    with _lock:
        _rules[:] = clean


def get_rules() -> list[dict]:
    with _lock:
        return list(_rules)


def _rank(rule: dict) -> int:
    try:
        return int(rule.get("scope_score") or 0) + int(rule.get("priority") or 0)
    except (TypeError, ValueError):
        return 0


def is_domain_pattern(pattern: str) -> bool:
    """True si el patron parece un dominio: contiene un punto y no tiene espacios."""
    value = (pattern or "").strip()
    return bool(value) and " " not in value and bool(_DOMAIN_RE.match(value))


def _domain_regex(pattern: str) -> "re.Pattern[str]":
    domain = pattern.strip().lstrip(".").lower()
    cached = _pattern_cache.get(domain)
    if cached is None:
        # Antes: inicio, o un caracter que no forme parte de un nombre de host
        # (se permite "." para subdominios). Despues: fin, o algo que no
        # continue el nombre de host (ni letras/digitos/guion ni ".xyz").
        cached = re.compile(
            r"(?<![a-z0-9-])" + re.escape(domain) + r"(?![a-z0-9-])(?!\.[a-z0-9])",
            re.IGNORECASE,
        )
        _pattern_cache[domain] = cached
    return cached


def pattern_matches_title(pattern: str, window_title: str) -> bool:
    pattern = (pattern or "").strip()
    if not pattern:
        return True
    title = window_title or ""
    if is_domain_pattern(pattern):
        return bool(_domain_regex(pattern).search(title))
    return pattern.lower() in title.lower()


def normalize_process_name(executable_name: str) -> str:
    return (executable_name or "").strip()[:MAX_PROCESS_NAME_LENGTH]


def _evaluate(executable_name: str, window_title: str) -> tuple[str | None, str]:
    """Devuelve (identificador o None si esta fuera de lista, clasificacion que prevalece)."""
    executable = (executable_name or "").strip().lower()
    title = (window_title or "").strip()
    rules = get_rules()

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
        if pattern and not pattern_matches_title(pattern, title):
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
