# VYNTRA - Agente de escritorio

Agente local de marcaje, capturas y telemetria cruda con consentimiento explicito.

## Que hace el agente

- Solicita consentimiento al usuario la primera vez.
- Valida el login del empleado contra el backend cuando esta configurado.
- Autoservicio de credenciales contra el backend: activar cuenta con el
  codigo recibido por correo, cambiar contrasena (boton en la estacion de
  marcaje) y recuperarla con "Olvide mi contrasena". El agente nunca guarda
  ni conoce contrasenas.
- Permite iniciar jornada, break, lunch y finalizar jornada.
- Guarda bitacora local de la jornada.
- Toma capturas durante jornada activa.
- Registra telemetria cruda: proceso activo, titulo de ventana, inactividad, clics y cambios de ventana.
- Guarda eventos pendientes en `%LOCALAPPDATA%\VYNTRA\outbox.jsonl`.
- Restaura una jornada activa si la app se cierra y vuelve a abrir.

## Que NO hace

- No clasifica aplicaciones como productivas o no productivas.
- No trae listas locales de clasificacion dentro del instalador.
- No captura contrasenas ni contenido escrito con teclado.
- No activa camara ni microfono.

## Clasificacion de productividad

La clasificacion debe vivir en la plataforma web administrativa.

Flujo recomendado:

1. El agente sube datos crudos al backend.
2. La base de datos guarda procesos, titulos de ventana, timestamps, tiempo activo, tiempo idle y empleado/equipo.
3. El administrador define reglas por empresa, departamento o rol desde la plataforma web.
4. El backend aplica esas reglas para calcular productivo, no productivo o neutral.
5. Los dashboards muestran reportes a jefes, gerencia o RR. HH.

## Probar el sistema completo en desarrollo (sin Docker)

Tres terminales de PowerShell. El backend corre con SQLite, sin instalar nada
mas que las dependencias de Python y Node.

Terminal 1, backend (puerto 8000):

```powershell
cd backend; py -3.13 -m pip install -r requirements.txt; $env:DATABASE_URL="sqlite:///./vyntra_local.db"; $env:STORAGE_DIR="./data/evidence"; $env:BOOTSTRAP_DEVICE_TOKEN="vyntra_dev_device_token_local_001"; py -3.13 -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Terminal 2, panel web (puerto 3000):

```powershell
cd web; copy .env.example .env.local; npm.cmd install; npm.cmd run dev
```

Panel: `http://localhost:3000`, credenciales demo `admin@vyntra.local /
Vyntra2026`. Incluye selector de idioma (ES/EN) y modo nocturno en la barra
lateral.

Terminal 3, agente. Para que el agente use el backend local, en `config.ini`
la seccion `[EvidenceBackend]` debe quedar asi:

```ini
[EvidenceBackend]
Enabled = true
Url = http://127.0.0.1:8000
DeviceToken = vyntra_dev_device_token_local_001
```

```powershell
py -3.13 -m pip install -r requirements.txt
py -3.13 agent.py
```

Flujo de credenciales a probar: crear un usuario monitoreado en el panel
(Ajustes -> Usuarios monitoreados); sin SMTP configurado el panel muestra el
codigo de activacion una sola vez; en el agente usar "Activar cuenta" con ese
codigo y definir la contrasena; iniciar sesion; cambiarla con el boton
"Cambiar contrasena" de la estacion. Prueba automatizada de todo el flujo:

```powershell
cd backend; py -3.13 scripts/test_station_credentials.py
```

## Probar solo el agente

```powershell
py -3.13 agent.py
```

Tambien puedes usar:

```text
run_agent.bat
```

Para reiniciar consentimiento:

```text
reset_consent.bat
```

## Empaquetar

```powershell
py -3.13 -m pip install pyinstaller
py -3.13 -m PyInstaller vyntra_agent.spec --clean
```

El resultado esperado es `dist\VYNTRAAgent\`.
