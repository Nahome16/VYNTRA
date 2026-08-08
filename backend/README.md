# VYNTRA Evidence Backend

Backend minimo para recibir evidencias del agente VYNTRA.

## Endpoints

- `GET /health`
- `POST /api/evidence/upload`

`POST /api/evidence/upload` requiere el header:

```http
X-Device-Token: token_unico_del_equipo
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
