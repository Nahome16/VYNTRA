# VYNTRA Evidence Backend

Backend minimo para recibir evidencias del agente VYNTRA.

## Endpoints

- `GET /health`
- `POST /api/admin/login`
- `GET /api/admin/me`
- `POST /api/station/login`
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
