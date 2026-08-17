# VYNTRA Evidence Backend

Backend minimo para recibir evidencias del agente VYNTRA.

## Endpoints

- `GET /health`
- `POST /api/admin/login`
- `GET /api/admin/me`
- `POST /api/station/login`
- `POST /api/station/activate`
- `POST /api/station/password`
- `POST /api/station/password/forgot`
- `POST /api/settings/employees/{id}/activation`
- `POST /api/agent/events`
- `POST /api/evidence/upload`

Los endpoints administrativos aceptan sesion JWT:

```http
Authorization: Bearer token_admin
```

Durante la transicion local tambien se mantiene:

```http
X-Admin-Token: token_admin_temporal
```

Los endpoints del agente requieren el header:

```http
X-Device-Token: token_unico_del_equipo
```

`POST /api/station/login` valida el correo y contrasena del empleado contra
`employee_credentials`, registra el intento en `station_login_events` y asocia
el dispositivo al empleado autenticado.

## Activacion de cuentas y contrasenas (flujo nuevo)

Al crear un empleado en `POST /api/settings/employees` ya NO se genera ni se
devuelve una contrasena. En su lugar:

1. La cuenta queda en estado `pending_activation` y se emite un codigo de un
   solo uso (formato `ABCD-EFGH`, caduca en 72 h, maximo 5 intentos). Solo se
   guarda su SHA-256.
2. Si hay SMTP configurado (ver `.env.example`, seccion "Correo saliente"),
   el codigo se envia por correo al empleado en segundo plano.
3. Sin SMTP y fuera de produccion (`EXPOSE_ACTIVATION_CODE_WITHOUT_SMTP=true`),
   el codigo se devuelve UNA vez en la respuesta para poder probar el flujo.
4. El empleado activa su cuenta desde el agente de escritorio (boton
   "Activar cuenta"): `POST /api/station/activate` con correo, codigo y su
   contrasena personal. Nadie mas la conoce.
5. `POST /api/station/password` cambia la contrasena (boton "Cambiar
   contrasena" en la estacion) y `POST /api/station/password/forgot` envia un
   codigo de recuperacion sin intervencion del administrador.
6. `POST /api/settings/employees/{id}/activation` (admin) reenvia la
   invitacion e invalida los codigos anteriores.

Politica de contrasena: minimo 10 caracteres, 3 de 4 tipos de caracter, sin
contener el correo ni el nombre. Bloqueo temporal tras 8 intentos fallidos.
Todo queda en `audit_logs` y `station_login_events`; el cambio de contrasena
dispara un correo de aviso al titular.

Para probar el flujo completo hay un script de punta a punta (22 casos) que
requiere el backend corriendo en `http://127.0.0.1:8000` con el token de
dispositivo de desarrollo:

```powershell
py -3.13 scripts/test_station_credentials.py
```

Nota: el script da de alta correos `ana.lopez@` y `beto@vyntra.local`; usa una
base de datos limpia o cambia los correos si ya existen.

Credenciales demo locales:

```text
admin@vyntra.local / Vyntra2026
empleado@vyntra.local / Vyntra2026
```

Campos `multipart/form-data`:

- `file`: imagen `.webp`, `.png`, `.jpg` o `.jpeg`
- `employee`
- `equipment`
- `captured_at`
- `sha256`
- `file_size`
- `agent_version`
- `monitor_count`

## Levantar localmente con Docker

```powershell
cd backend
copy .env.example .env
docker compose up --build
```

La API queda en:

```text
http://localhost:8000
```

## Produccion

Antes de publicar:

1. Cambiar `POSTGRES_PASSWORD`.
2. Cambiar `BOOTSTRAP_DEVICE_TOKEN` por un token largo y aleatorio.
3. Poner `ALLOW_BOOTSTRAP=false` despues de crear dispositivos reales.
4. Publicar detras de HTTPS con Caddy, Nginx o un proxy equivalente.
5. Configurar backups de PostgreSQL y del volumen de evidencias.

Para generar un token de equipo:

```powershell
py -3.13 scripts/generate_device_token.py
```

Ver tambien:

```text
DEPLOYMENT.md
docker-compose.prod.yml
Caddyfile
SCHEMA.md
```

## Seed local

Para cargar datos demo:

```powershell
cd backend
$env:PYTHONPATH="."
py -3.13 scripts/seed_local.py
```
