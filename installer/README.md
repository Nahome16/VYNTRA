# VYNTRA Agent Installer Layout

Esta carpeta contiene los insumos para preparar el instalador del agente.

## Archivos importantes

- `config.production.template.ini`: plantilla para generar `config.ini` por cliente/equipo.
- `build_agent.ps1`: compila el agente con PyInstaller.
- `install_agent_wizard.ps1`: instalador visual para soporte o instalacion manual.
- `install_agent_autostart.ps1`: instala la carpeta compilada y registra el arranque automatico.
- `uninstall_agent_autostart.ps1`: elimina la tarea programada y, opcionalmente, la carpeta instalada.

## Flujo recomendado

1. Compilar. El ejecutable ya NO incluye `config.ini` (nunca se empaqueta el
   `config.ini` del desarrollador):

```powershell
.\installer\build_agent.ps1
# Release: exige certificado de code signing y verifica la firma resultante.
.\installer\build_agent.ps1 -Release -CertificateThumbprint "<HUELLA>"
```

`build_agent.ps1` ya no usa `Invoke-Expression`: el parametro `-Python` (por
defecto `py -3.13`) se divide en ejecutable y argumentos. Para una ruta con
espacios usa `-PythonExe "C:\ruta\python.exe"`.

2. Generar el paquete por empresa con `prepare_agent_package.ps1`, que escribe el
   `config.ini` de produccion a partir de `config.production.template.ini` (ver
   "Paquete final por equipo"). Si instalas manualmente desde
   `dist\VYNTRAAgent`, copia la plantilla como `config.ini` junto a
   `VYNTRAAgent.exe` y ajusta `Empresa`, `CorreoContacto` y `EvidenceBackend.Url`.

3. En cada PC, instalar el agente y registrar autoarranque con el asistente visual:

```powershell
.\installer\install_agent_wizard.ps1
```

Tambien se puede usar el modo tecnico/silencioso:

```powershell
.\installer\install_agent_autostart.ps1
```

Por defecto copia `dist\VYNTRAAgent` a:

```text
%LOCALAPPDATA%\Programs\VYNTRAAgent
```

Y crea una tarea programada llamada:

```text
VYNTRA Agent
```

La tarea inicia cuando el usuario abre sesion en Windows y reintenta hasta 3 veces si el proceso falla.

Para quitar el autoarranque:

```powershell
.\installer\uninstall_agent_autostart.ps1
```

Para quitar tambien la carpeta instalada:

```powershell
.\installer\uninstall_agent_autostart.ps1 -RemoveInstallDir
```

## Produccion

El instalador de produccion no debe incluir:

- `credentials.json`
- `token.json`
- el `config.ini` del equipo de desarrollo

La evidencia se sube al backend VYNTRA usando `EvidenceBackend` (la integracion
con Google Drive se elimino). El `DeviceToken` se cifra con DPAPI al primer
inicio (`DeviceTokenProtected`).

### Firma y actualizaciones

- `-Release` en `build_agent.ps1`, `prepare_agent_package.ps1` y
  `build_windows_exe_installer.ps1` falla si falta `-CertificateThumbprint`.
- `-UpdateSignerThumbprint "<HUELLA>[,<HUELLA2>]"` en `prepare_agent_package.ps1`
  (y `build_windows_exe_installer.ps1`) escribe `[Update] SignerThumbprint` en el
  `config.ini` del paquete: el actualizador exigira firma Authenticode valida de
  ese firmante antes de reemplazar archivos. Sin huella solo registra una
  advertencia en `%LOCALAPPDATA%\VYNTRA\updates\update.log` y continua.
- Las actualizaciones no reemplazan `config.ini`: en equipos ya instalados la
  huella se agrega editando su `config.ini`. Para rotar certificados, agrega la
  huella nueva (separada por coma) antes de publicar builds firmados con ella.

## Paquete final por equipo

Para entregar un ZIP listo para las PCs monitoreadas de una empresa, ejecuta:

```powershell
.\installer\prepare_agent_package.ps1 `
  -CompanyName "InsureMeBetter" `
  -ContactEmail "rrhh@insuremebetter.com" `
  -Build
```

El script genera:

```text
release\VYNTRAAgent-InsureMeBetter.zip
```

El ZIP incluye:

- `Instalar VYNTRA.cmd`: instalador simple para el usuario/soporte.
- `Instalar VYNTRA.ps1`: instalador PowerShell.
- `VYNTRAAgent\`: agente compilado con `config.ini` de produccion.
- `LEEME-INSTALACION.txt`: pasos para instalar y validar.

El paquete es generico por empresa. En el primer inicio de sesion, el agente
valida las credenciales del empleado contra el backend, registra la PC y guarda
un `DeviceToken` unico localmente en esa instalacion.

Si necesitas preparar un paquete tecnico ya enrolado para una PC especifica,
puedes pasar `-DeviceToken`, pero el flujo recomendado es enrolamiento automatico.

## Instalador `.exe` para Windows

Para generar un archivo `.exe` de instalacion como aplicacion de Windows:

```powershell
.\installer\build_windows_exe_installer.ps1 `
  -CompanyName "InsureMeBetter" `
  -ContactEmail "carlos@insuremebetter.com"
```

Para produccion, firmar el agente y el instalador con un certificado de code
signing confiable:

```powershell
.\installer\build_windows_exe_installer.ps1 `
  -CompanyName "InsureMeBetter" `
  -ContactEmail "carlos@insuremebetter.com" `
  -BuildAgent `
  -CertificateThumbprint "CERT_THUMBPRINT"
```

El resultado queda en:

```text
release\VYNTRAAgent-InsureMeBetter-Setup.exe
```

Este instalador es para Windows. macOS y Linux requieren agentes/instaladores
separados porque el agente actual usa APIs de Windows, tarea programada y
dependencias como `pywin32`.
