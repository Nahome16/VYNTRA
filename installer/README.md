# VYNTRA Agent Installer Layout

Esta carpeta contiene los insumos para preparar el instalador del agente.

## Archivos importantes

- `config.production.template.ini`: plantilla para generar `config.ini` por cliente/equipo.
- `build_agent.ps1`: compila el agente con PyInstaller.
- `install_agent_wizard.ps1`: instalador visual para soporte o instalacion manual.
- `install_agent_autostart.ps1`: instala la carpeta compilada y registra el arranque automatico.
- `uninstall_agent_autostart.ps1`: elimina la tarea programada y, opcionalmente, la carpeta instalada.

## Flujo recomendado

1. Copiar `config.production.template.ini` como `config.ini` en la raiz del proyecto.
2. Cambiar:
   - `Empresa`
   - `CorreoContacto`
   - `EvidenceBackend.Url`
   - `EvidenceBackend.DeviceToken`
3. Compilar:

```powershell
.\installer\build_agent.ps1
```

4. Entregar al cliente la carpeta:

```text
dist\VYNTRAAgent
```

5. En cada PC, instalar el agente y registrar autoarranque con el asistente visual:

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
- credenciales de Google Drive

La evidencia debe subirse al backend VYNTRA usando `EvidenceBackend`.

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
