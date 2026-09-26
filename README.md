# VYNTRA - Agente de escritorio

Agente local de marcaje, capturas y telemetria cruda con consentimiento explicito.

## Que hace el agente

- Solicita consentimiento al usuario la primera vez.
- Valida el login del empleado contra el backend (en un hilo de trabajo; la ventana no se congela).
- Obliga cambio de contrasena temporal y permite recuperacion con codigo cuando el backend esta configurado.
- Permite iniciar jornada, break, lunch y finalizar jornada.
- Permite solicitar horas extra, reportar fallas tecnicas y reabrir jornadas con codigos de un solo uso. Los codigos siempre se validan en el servidor; sin conexion se rechazan con un mensaje claro.
- Guarda bitacora local de la jornada.
- Toma capturas solo de la ventana activa, y solo cuando es una aplicacion clasificada como productiva por las reglas de la empresa. Nunca captura la pantalla completa, el escritorio, la barra de tareas ni las notificaciones.
- Registra telemetria: proceso activo, identificador normalizado de la ventana, inactividad, clics y cambios de ventana.
- Guarda eventos pendientes en `%LOCALAPPDATA%\VYNTRA\outbox.sqlite`.
- Restaura una jornada activa si la app se cierra y vuelve a abrir (ver "Recuperacion de jornada").

## Que NO hace

- No clasifica aplicaciones como productivas o no productivas.
- No trae listas locales de clasificacion dentro del instalador.
- No captura contrasenas ni contenido escrito con teclado.
- No activa camara ni microfono.
- No sube capturas a Google Drive (se elimino esa integracion).

## Datos locales (`%LOCALAPPDATA%\VYNTRA`)

| Archivo / carpeta | Contenido |
| --- | --- |
| `outbox.sqlite` | Eventos pendientes / subidos / rechazados. Los subidos se depuran a los 7 dias y los rechazados a los 30. |
| `evidence_queue.sqlite` | Cola de subida de capturas. |
| `jornadas\jornada_AAAAMMDD.json` | Bitacora de la jornada, por fecha de INICIO y `shift_id`. |
| `rules_cache.json` | Cache de reglas de productividad (se revalida cada 30 min). |
| `logs\agent.log` | Log rotativo (1 MB x 5). |
| `updates\` | Paquetes, script y log (`update.log`) del actualizador. |

### Migracion del outbox

Al primer inicio de esta version, los eventos pendientes de `outbox.jsonl`, de sus rotaciones `outbox.jsonl.*.bak` y de los respaldos `outbox_<pid>.jsonl` se importan a `outbox.sqlite` (una sola vez, sin duplicados) y los archivos se renombran a `*.imported` como respaldo. Las versiones anteriores podian perder eventos pendientes al rotar el JSONL.

### Envio de eventos

- Lotes de hasta 100 eventos a `POST /api/agent/events`.
- Eventos rechazados por el servidor quedan como `rejected` y no bloquean la cola.
- Errores de red: reintento con espera exponencial con jitter.
- Cada `activity_snapshot` lleva solo las muestras de actividad nuevas desde el envio anterior (el backend deduplica muestras por dispositivo + inicio + app + titulo).
- Todas las fechas se envian en ISO 8601 con desfase horario local (p. ej. `2026-09-26T08:00:00-06:00`). `fecha` es la fecha local de inicio de la jornada.

### Capturas

- Se suben al backend desde un hilo dedicado (tambien las pendientes de sesiones anteriores). Los errores de red no consumen `RetryLimit`.
- Tras subirse, el archivo local se elimina (`[EvidenceBackend] DeleteAfterUpload = true`). En cualquier caso, las capturas locales con mas de 7 dias se purgan.

## Recuperacion de jornada (RF-16)

- El reloj usa deltas de reloj monotono. Si el equipo se suspende o la app se congela mas de 120 s, ese hueco no se cuenta como trabajado y se registra `suspend_detected` (inicio, fin y segundos) para revision de RR. HH.; el usuario ve un aviso.
- Si el agente se cierra de forma imprevista y se reabre dentro de 15 minutos, la jornada continua (`shift_recovered`).
- Si se reabre despues (o tras cerrar la ventana normalmente), la jornada se restaura, pero el tiempo cerrado no se cuenta: se registra `recovery_gap` y se informa al usuario.
- Una jornada iniciada antes de medianoche se restaura aunque la app se reabra despues de medianoche.
- El healthcheck reinicia hilos caidos y registra `thread_restarted`.

## DeviceToken

El token del dispositivo se guarda cifrado con DPAPI (usuario actual de Windows) como `DeviceTokenProtected`. Si `config.ini` trae `DeviceToken` en texto plano, se migra automaticamente al primer inicio y se elimina el texto plano. Un `config.ini` copiado a otro usuario o PC no puede descifrar el token: el agente vuelve a enrolar el equipo al iniciar sesion.

## Actualizaciones automaticas

- Solo se aplican con la jornada en `FUERA` o `TERMINADO` (nunca a mitad de jornada ni con horas extra activas).
- Solo se descargan del mismo origen que el backend configurado; no se siguen redirecciones y el `X-Device-Token` nunca se envia a otro host.
- Se verifica el SHA-256 del paquete y, antes de reemplazar archivos, la firma Authenticode de `VYNTRAAgent.exe`:
  - Con `[Update] SignerThumbprint` configurado (una o varias huellas separadas por coma), se exige `Status = Valid` y firmante coincidente; si no, la actualizacion se cancela.
  - Sin huella configurada, solo se registra una advertencia en `update.log` y se continua (para que los builds actuales sin firma sigan actualizando).
  - `config.ini` no se reemplaza en las actualizaciones: para activar/rotar la huella en equipos ya instalados hay que editar su `config.ini`.
- Los archivos se copian a una carpeta de staging, se respaldan los actuales y se revierte si la copia falla. El agente siempre se vuelve a abrir.
- El script se ejecuta con `-ExecutionPolicy RemoteSigned` (script local generado por el agente) en lugar de `Bypass`.

## Politica de captura minima

La lista de aplicaciones permitidas son las reglas de productividad que la empresa configura en la plataforma web; el agente las descarga desde `/api/agent/rules` (`capture_policy.py`). Antes de guardar o transmitir cualquier muestra, el titulo literal de la ventana se sustituye por un identificador normalizado:

- Si una regla con `title_contains` coincide, el identificador es ese patron (por ejemplo `Salesforce`).
- Si solo coincide una regla por ejecutable, el identificador es `(aplicacion permitida)`.
- Si ninguna regla coincide, el identificador es `(fuera de lista)` y no se captura evidencia.

Patrones con forma de dominio (con punto y sin espacios, como `salesforce.com` o `.salesforce.com`) deben aparecer en el titulo como dominio completo o subdominio (`app.salesforce.com`), nunca como parte de otro dominio (`evil-salesforce.com`). Los demas patrones se comparan como subcadena sin distinguir mayusculas. El nombre del proceso se envia tal cual, truncado a 80 caracteres.

El backend aplica la misma normalizacion como segunda barrera (`backend/app/capture_policy.py`). Para normalizar datos guardados antes de esta politica: `python backend/scripts/normalize_stored_titles.py --apply` (sin `--apply` solo simula).

## Clasificacion de productividad

La clasificacion debe vivir en la plataforma web administrativa.

Flujo recomendado:

1. El agente sube datos crudos al backend.
2. La base de datos guarda procesos, identificadores normalizados de ventana, timestamps, tiempo activo, tiempo idle y empleado/equipo.
3. El administrador define reglas por empresa, departamento o rol desde la plataforma web.
4. El backend aplica esas reglas para calcular productivo, no productivo o neutral.
5. Los dashboards muestran reportes a jefes, gerencia o RR. HH.

## Probar en desarrollo

```powershell
py -3.13 -m pip install -r requirements.txt
py -3.13 agent.py
```

Tambien puedes usar `run_agent.bat`.

Modo desarrollo (solo ejecutando desde codigo fuente, nunca en el `.exe`): `VYNTRA_DEV_MODE=1` habilita los usuarios de prueba locales y `[StationAuth] AllowLocalFallback`. Sin ese modo, un agente sin backend configurado rechaza el inicio de sesion.

```powershell
$env:VYNTRA_DEV_MODE = "1"; py -3.13 agent.py
```

Para volver a mostrar el aviso de consentimiento (no borra jornadas ni eventos):

```text
reset_consent.bat
```

## Pruebas

```powershell
py -3 -m pip install pytest
py -3 -m pytest
```

## Empaquetar

```powershell
.\installer\build_agent.ps1                                   # build de prueba
.\installer\build_agent.ps1 -Release -CertificateThumbprint <HUELLA>   # release firmado (falla sin certificado)
```

El resultado es `dist\VYNTRAAgent\`. El ejecutable ya no incluye `config.ini`: el paquete por empresa lo genera `installer\prepare_agent_package.ps1` desde `installer\config.production.template.ini` (ver `installer\README.md`).
