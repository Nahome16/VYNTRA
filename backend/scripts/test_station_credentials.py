# -*- coding: utf-8 -*-
"""Prueba de punta a punta del alta, activacion y cambio de contrasena."""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"
DEVICE = "vyntra_dev_device_token_local_001"
ok = fail = 0


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            return e.code, {"raw": raw[:200]}


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  OK    {label}")
    else:
        fail += 1
        print(f"  FALLA {label} {extra}")


dev = {"X-Device-Token": DEVICE}

print("1. Sesion de administrador")
st, r = call("POST", "/api/admin/login", {"email": "admin@vyntra.local", "password": "Vyntra2026"})
check("login admin", st == 200 and r.get("access_token"), st)
adm = {"Authorization": "Bearer " + r["access_token"]}

print("\n2. Alta de asistente monitoreado")
st, r = call("POST", "/api/settings/employees",
             {"full_name": "Ana Lopez", "email": "ana.lopez@vyntra.local"}, adm)
check("alta 200", st == 200, st)
check("NO devuelve contrasena", "password" not in json.dumps(r), r)
act = r.get("activation", {})
check("queda pendiente de activacion", act.get("status") == "pending_activation", act)
check("trae fecha de caducidad", bool(act.get("expires_at")), act)
code = act.get("code")
check("sin SMTP entrega el codigo una vez", bool(code), act)
email = "ana.lopez@vyntra.local"

print("\n3. No puede iniciar sesion sin activar")
st, r = call("POST", "/api/station/login", {"email": email, "password": "loquesea"}, dev)
check("login bloqueado con 403", st == 403, st)

print("\n4. Politica de contrasena")
st, r = call("POST", "/api/station/activate",
             {"email": email, "code": code, "new_password": "corta1"}, dev)
check("rechaza contrasena corta", st == 400, (st, r))
st, r = call("POST", "/api/station/activate",
             {"email": email, "code": code, "new_password": "anaanaanaana"}, dev)
check("rechaza contrasena que contiene el correo", st == 400, (st, r))

print("\n5. Codigo incorrecto")
st, r = call("POST", "/api/station/activate",
             {"email": email, "code": "AAAA-BBBB", "new_password": "Marzo2026$ok"}, dev)
check("rechaza codigo incorrecto", st == 400, (st, r))

print("\n6. Activacion valida")
st, r = call("POST", "/api/station/activate",
             {"email": email, "code": code, "new_password": "Marzo2026$ok"}, dev)
check("activa la cuenta", st == 200 and r.get("status") == "active", (st, r))

print("\n7. El codigo es de un solo uso")
st, r = call("POST", "/api/station/activate",
             {"email": email, "code": code, "new_password": "Otra2026$clave"}, dev)
check("no se puede reutilizar", st in (400, 429), (st, r))

print("\n8. Login con la contrasena elegida")
st, r = call("POST", "/api/station/login", {"email": email, "password": "Marzo2026$ok"}, dev)
check("login correcto", st == 200 and r.get("ok"), (st, r))
check("no exige cambio", r.get("credential", {}).get("must_change_password") is False, r.get("credential"))

print("\n9. Cambio de contrasena desde la estacion")
st, r = call("POST", "/api/station/password",
             {"email": email, "current_password": "malo", "new_password": "Nueva2026$xy"}, dev)
check("rechaza contrasena actual incorrecta", st == 401, st)
st, r = call("POST", "/api/station/password",
             {"email": email, "current_password": "Marzo2026$ok", "new_password": "Marzo2026$ok"}, dev)
check("rechaza repetir la misma", st == 400, (st, r))
st, r = call("POST", "/api/station/password",
             {"email": email, "current_password": "Marzo2026$ok", "new_password": "Nueva2026$xy"}, dev)
check("cambia la contrasena", st == 200, (st, r))
st, r = call("POST", "/api/station/login", {"email": email, "password": "Nueva2026$xy"}, dev)
check("login con la nueva", st == 200, st)
st, r = call("POST", "/api/station/login", {"email": email, "password": "Marzo2026$ok"}, dev)
check("la anterior ya no sirve", st == 401, st)

print("\n10. Recuperacion autoservicio")
st, r = call("POST", "/api/station/password/forgot", {"email": email}, dev)
check("responde ok", st == 200 and r.get("ok"), (st, r))
st, r2 = call("POST", "/api/station/password/forgot", {"email": "noexiste@vyntra.local"}, dev)
check("misma respuesta para correo inexistente", r2.get("message") == r.get("message"), r2)

print("\n11. Reenvio de activacion por el administrador")
st, r = call("POST", "/api/settings/employees", {"full_name": "Beto Cruz", "email": "beto@vyntra.local"}, adm)
emp_id = r.get("employee", {}).get("id")
st, r = call("POST", f"/api/settings/employees/{emp_id}/activation", None, adm)
check("reenvia y entrega codigo nuevo", st == 200 and r.get("code"), (st, r))

print(f"\n===== {ok} correctas, {fail} fallidas =====")
sys.exit(1 if fail else 0)
