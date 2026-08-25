# VYNTRA Production Operations

This checklist keeps the cloud deployment running without using a local PC as
an intermediary.

## 1. Deploy the latest code

Run on the VPS:

```bash
cd /opt/vyntra
git pull origin master

cd /opt/vyntra/backend
VYNTRA_ENV_FILE=.env.production docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build api web
curl -i https://api.vyntralab.com/health
```

Expected API response:

```json
{"ok":true,"environment":"production"}
```

## 2. Install production operations

Run once on the VPS:

```bash
cd /opt/vyntra/backend
chmod +x scripts/*.sh
./scripts/install_production_ops.sh
./scripts/check_production_env.sh
```

This creates:

- `/opt/vyntra/backups/postgres` for daily PostgreSQL backups.
- `/opt/vyntra/downloads` for installer files served by the panel.
- `/var/log/vyntra/backup.log` and `/var/log/vyntra/health.log`.
- `/etc/cron.d/vyntra-ops`.

## 3. Publish installer downloads

From the local PC, upload the final release files:

```powershell
scp "C:\Users\Yoga\OneDrive\Desktop\VYNTRA\release\VYNTRAAgent-InsureMeBetter-Windows-Setup-v1.2.2.exe" root@2.25.100.25:/opt/vyntra/downloads/
scp "C:\Users\Yoga\OneDrive\Desktop\VYNTRA\release\VYNTRAAgent-InsureMeBetter-Windows-Setup-v1.2.2.zip" root@2.25.100.25:/opt/vyntra/downloads/
scp "C:\Users\Yoga\OneDrive\Desktop\VYNTRA\release\VYNTRAAgent-InsureMeBetter-macOS-Builder-v1.2.2.zip" root@2.25.100.25:/opt/vyntra/downloads/
```

Then rebuild the API once so the read-only downloads mount is active:

```bash
cd /opt/vyntra/backend
VYNTRA_ENV_FILE=.env.production docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build api web
```

Panel users with device management permission can then open:

```text
https://app.vyntralab.com/descargas
```

Windows agents already enrolled with a valid `DeviceToken` also check:

```text
GET /api/agent/update
```

When a newer Windows ZIP is published, the agent downloads it with
`X-Device-Token`, validates SHA-256, preserves `config.ini` and local queues,
copies the new binaries and restarts itself.

For Smart App Control, sign every release binary before upload:

```powershell
.\installer\build_windows_exe_installer.ps1 `
  -CompanyName "InsureMeBetter" `
  -ContactEmail "rrhh@insuremebetter.com" `
  -PackageName "VYNTRAAgent-InsureMeBetter-Windows-Setup-v1.2.2" `
  -SetupName "VYNTRAAgent-InsureMeBetter-Windows-Setup-v1.2.2" `
  -BuildAgent `
  -CertificateThumbprint "CERT_THUMBPRINT"
```

## 4. Security before wider rollout

Confirm production values:

```bash
cd /opt/vyntra/backend
grep -E "ALLOW_BOOTSTRAP|ALLOW_LEGACY_ADMIN_TOKEN" .env.production
```

Both should be:

```env
ALLOW_BOOTSTRAP=false
ALLOW_LEGACY_ADMIN_TOKEN=false
```

Rotate secrets after any credential has been shared outside the server:

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `ADMIN_API_TOKEN`
- `JWT_SECRET`
- `SMTP_PASSWORD`

## 5. Manual checks

```bash
cd /opt/vyntra/backend
VYNTRA_ENV_FILE=.env.production docker compose -f docker-compose.prod.yml --env-file .env.production ps
./scripts/backup_postgres.sh
./scripts/healthcheck_vyntra.sh
./scripts/check_production_env.sh
tail -80 /var/log/vyntra/backup.log
tail -80 /var/log/vyntra/health.log
```
