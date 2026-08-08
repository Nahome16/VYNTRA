# VYNTRA Agent Installer Layout

Esta carpeta contiene los insumos para preparar el instalador del agente.

## Archivos importantes

- `config.production.template.ini`: plantilla para generar `config.ini` por cliente/equipo.
- `build_agent.ps1`: compila el agente con PyInstaller.

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

## Produccion

El instalador de produccion no debe incluir:

- `credentials.json`
- `token.json`
- credenciales de Google Drive

La evidencia debe subirse al backend VYNTRA usando `EvidenceBackend`.
