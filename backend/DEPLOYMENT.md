# VYNTRA Production Deployment

Esta guia asume una VM Ubuntu 24.04 LTS con Docker instalado.

## 1. Comprar infraestructura

Recomendado para primera produccion:

- Dominio y DNS: Cloudflare
- VPS: DigitalOcean, Hetzner o Hostinger VPS
- Sistema: Ubuntu 24.04 LTS
- RAM minima: 4 GB
- CPU minima: 2 vCPU
- Disco minimo: 80 GB

## 2. DNS

Crear un registro DNS:

```text
Tipo: A
Nombre: api
Valor: IP_PUBLICA_DE_LA_VM
Proxy Cloudflare: DNS only al inicio
```

Ejemplo:

```text
api.tudominio.com -> 123.123.123.123
```

## 3. Instalar Docker en la VM

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Cerrar sesion SSH y volver a entrar.

## 4. Subir backend

Copiar la carpeta `backend` a la VM.

Ejemplo con SCP desde tu PC:

```powershell
scp -r "C:\Users\Yoga\OneDrive\Desktop\VYNTRA\backend" usuario@IP_PUBLICA:/opt/vyntra-backend
```

## 5. Configurar entorno

En la VM:

```bash
cd /opt/vyntra-backend
cp .env.production.example .env.production
nano .env.production
```

Cambiar:

- `API_DOMAIN`
- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `BOOTSTRAP_DEVICE_NAME`
- `BOOTSTRAP_DEVICE_TOKEN`

Para generar token:

```bash
python3 scripts/generate_device_token.py
```

## 6. Levantar produccion

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Ver logs:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

Probar:

```bash
curl https://api.tudominio.com/health
```

## 7. Despues del primer arranque

Cuando el primer dispositivo ya exista:

```text
ALLOW_BOOTSTRAP=false
```

Luego:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

## 8. Firewall

Abrir solo:

- 22 SSH
- 80 HTTP
- 443 HTTPS

## 9. Backups minimos

Base de datos:

```bash
docker exec -t vyntra-backend-db-1 pg_dump -U vyntra vyntra > vyntra_backup.sql
```

Evidencias:

Respaldar el volumen `evidence_data` o migrar a storage S3-compatible.
