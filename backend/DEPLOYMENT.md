# VYNTRA Production Deployment

Esta guia despliega VYNTRA Control en una VM Ubuntu 24.04 LTS con Docker:

- `web`: panel administrativo Next.js.
- `api`: backend FastAPI.
- `db`: PostgreSQL.
- `caddy`: proxy publico con HTTPS automatico.

## 1. Infraestructura minima

- Dominio administrado en Cloudflare u otro DNS.
- VPS Ubuntu 24.04 LTS.
- 2 vCPU.
- 4 GB RAM.
- 80 GB disco.
- Puertos abiertos: `22`, `80`, `443`.

## 2. DNS

Crear dos registros `A` apuntando a la IP publica de la VM:

```text
app.tudominio.com -> IP_PUBLICA_DE_LA_VM
api.tudominio.com -> IP_PUBLICA_DE_LA_VM
```

Al inicio usar `DNS only` si el DNS esta en Cloudflare. Cuando HTTPS ya este
funcionando se puede evaluar activar proxy.

## 3. Instalar Docker en la VM

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Cerrar sesion SSH y volver a entrar.

## 4. Subir el proyecto

Opcion recomendada:

```bash
sudo mkdir -p /opt/vyntra
sudo chown $USER:$USER /opt/vyntra
git clone https://github.com/Nahome16/VYNTRA.git /opt/vyntra
cd /opt/vyntra/backend
```

Si se sube por SCP, copiar el repositorio completo, no solo `backend`, porque
produccion tambien construye `../web`.

## 5. Crear secretos

Generar token de dispositivo:

```bash
python3 scripts/generate_device_token.py
```

Generar hashes PBKDF2 para el admin inicial y el empleado inicial:

```bash
python3 scripts/hash_password.py
```

Generar `JWT_SECRET`, `ADMIN_API_TOKEN` y `POSTGRES_PASSWORD` con valores
largos y aleatorios.

## 6. Configurar entorno

```bash
cd /opt/vyntra/backend
cp .env.production.example .env.production
nano .env.production
```

Valores obligatorios:

```text
APP_DOMAIN=app.tudominio.com
API_DOMAIN=api.tudominio.com
ACME_EMAIL=admin@tudominio.com
POSTGRES_PASSWORD=...
DATABASE_URL=postgresql+psycopg://vyntra:POSTGRES_PASSWORD@db:5432/vyntra
JWT_SECRET=...
ADMIN_API_TOKEN=...
CORS_ALLOWED_ORIGINS=https://app.tudominio.com
SMTP_HOST=smtp.tudominio.com
SMTP_PORT=587
SMTP_USERNAME=notificaciones@tudominio.com
SMTP_PASSWORD=...
SMTP_FROM_EMAIL=notificaciones@tudominio.com
SMTP_FROM_NAME=VYNTRA
SMTP_USE_TLS=true
SMTP_USE_SSL=false
APP_PUBLIC_URL=https://app.tudominio.com
BOOTSTRAP_ADMIN_EMAIL=admin@empresa.com
BOOTSTRAP_ADMIN_PASSWORD_HASH=...
BOOTSTRAP_SYSTEM_ADMIN_EMAIL=sistema@empresa.com
BOOTSTRAP_SYSTEM_ADMIN_PASSWORD_HASH=...
BOOTSTRAP_EMPLOYEE_LOGIN_EMAIL=empleado@empresa.com
BOOTSTRAP_EMPLOYEE_PASSWORD_HASH=...
BOOTSTRAP_DEVICE_NAME=first-device
BOOTSTRAP_DEVICE_TOKEN=...
```

Para el primer arranque, si se necesita crear la empresa/admin/dispositivo
inicial, usar:

```text
ALLOW_BOOTSTRAP=true
```

Despues de confirmar que el dispositivo inicial ya existe, cambiarlo a:

```text
ALLOW_BOOTSTRAP=false
```

## 7. Levantar produccion

```bash
cd /opt/vyntra/backend
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Si se quiere validar la configuracion con el ejemplo antes de crear secretos:

```bash
VYNTRA_ENV_FILE=.env.production.example docker compose -f docker-compose.prod.yml --env-file .env.production.example config
```

Ver logs:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

## 8. Probar

```bash
curl https://api.tudominio.com/health
```

Abrir:

```text
https://app.tudominio.com
```

Validar:

- Login administrativo.
- Dashboard.
- Empleados.
- Asistencia.
- Ajustes.
- Incidencias.
- Carga de evidencia desde un agente de prueba.

## 9. Nota sobre builds en redes con antivirus/proxy

Si el build local de Docker falla descargando paquetes con errores como
`CERTIFICATE_VERIFY_FAILED`, la causa normalmente es una red, antivirus o proxy
interceptando TLS. En una VM de produccion normal no deberia ocurrir.

Para validar localmente en esa red, configurar Docker para confiar en el
certificado raiz corporativo/de antivirus desde la configuracion del motor, sin
commitear certificados personales al repositorio.

## 10. Agente de escritorio

Crear una configuracion de produccion desde:

```text
installer/config.production.template.ini
```

Valores clave:

```text
[Server]
Url = https://api.tudominio.com

[EvidenceBackend]
Enabled = true
Url = https://api.tudominio.com
DeviceToken = TOKEN_UNICO_DEL_EQUIPO

[StationAuth]
AllowLocalFallback = false
```

Cada PC debe usar un `DeviceToken` unico.

## 11. Backups minimos

Base de datos:

```bash
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U vyntra vyntra > vyntra_backup.sql
```

Evidencias:

Respaldar el volumen `evidence_data` o migrar evidencias a storage externo.

## 12. Actualizar produccion

```bash
cd /opt/vyntra
git pull
cd backend
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```
