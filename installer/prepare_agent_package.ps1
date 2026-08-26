param(
    [Parameter(Mandatory = $true)]
    [string]$CompanyName,

    [Parameter(Mandatory = $true)]
    [string]$ContactEmail,

    [string]$DeviceToken = "",

    [string]$ApiUrl = "https://api.vyntralab.com",
    [string]$AgentVersion = "1.2.3",
    [string]$OutputDir = "release",
    [string]$PackageName = "",
    [string]$CertificateThumbprint = "",
    [string]$TimestampServer = "http://timestamp.digicert.com",
    [string]$SignToolPath = "signtool.exe",
    [switch]$Build
)

$ErrorActionPreference = "Stop"

function Assert-CleanToken {
    param([string]$Token)
    if ($Token.Trim() -and $Token -match "TOKEN_UNICO|CAMBIAR|placeholder") {
        throw "DeviceToken parece ser un placeholder. Usa el token real del dispositivo."
    }
}

function Safe-RemoveDirectory {
    param(
        [string]$Path,
        [string]$AllowedRoot
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $resolvedRoot = (Resolve-Path -LiteralPath $AllowedRoot).Path
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Ruta fuera del workspace: $resolvedPath"
    }
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Remove-Item -LiteralPath $resolvedPath -Recurse -Force
            return
        } catch {
            if ($attempt -eq 5) { throw }
            Start-Sleep -Seconds 2
        }
    }
}

Assert-CleanToken -Token $DeviceToken

$root = Split-Path -Parent $PSScriptRoot
$distAgent = Join-Path $root "dist\VYNTRAAgent"
$agentExe = Join-Path $distAgent "VYNTRAAgent.exe"

if ($Build -or -not (Test-Path -LiteralPath $agentExe)) {
    $buildArgs = @{
        CertificateThumbprint = $CertificateThumbprint
        TimestampServer = $TimestampServer
        SignToolPath = $SignToolPath
    }
    & (Join-Path $PSScriptRoot "build_agent.ps1") @buildArgs
}

if (-not (Test-Path -LiteralPath $agentExe)) {
    throw "No existe dist\VYNTRAAgent\VYNTRAAgent.exe. Ejecuta installer\build_agent.ps1 primero."
}

$safeCompany = ($CompanyName -replace "[^a-zA-Z0-9_-]+", "-").Trim("-")
if (-not $safeCompany) { $safeCompany = "VYNTRA" }
if (-not $PackageName) {
    $PackageName = "VYNTRAAgent-$safeCompany"
}

$outputRoot = Join-Path $root $OutputDir
$stageRoot = Join-Path $root ".installer_build"
$packageRoot = Join-Path $stageRoot $PackageName
$packageAgent = Join-Path $packageRoot "VYNTRAAgent"
$packageInstaller = Join-Path $packageRoot "installer"
$packageLegal = Join-Path $packageRoot "legal"
$zipPath = Join-Path $outputRoot "$PackageName.zip"

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
Safe-RemoveDirectory -Path $packageRoot -AllowedRoot $stageRoot
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
New-Item -ItemType Directory -Path $packageAgent -Force | Out-Null
New-Item -ItemType Directory -Path $packageInstaller -Force | Out-Null
New-Item -ItemType Directory -Path $packageLegal -Force | Out-Null

Copy-Item -Path (Join-Path $distAgent "*") -Destination $packageAgent -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install_agent_wizard.ps1") -Destination $packageInstaller -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install_agent_autostart.ps1") -Destination $packageInstaller -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "uninstall_agent_autostart.ps1") -Destination $packageInstaller -Force
Copy-Item -Path (Join-Path $root "docs\legal\*") -Destination $packageLegal -Recurse -Force

$forbiddenFiles = @("credentials.json", "credentials.previous.json", "token.json")
foreach ($name in $forbiddenFiles) {
    Get-ChildItem -LiteralPath $packageRoot -Recurse -Force -Filter $name -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
}

$configText = @"
[Server]
Url = $ApiUrl

[Agent]
Version = $AgentVersion

[AgentUpdate]
Enabled = true

[Interface]
Language = es

[Capture]
IntervalSeconds = 300
Directory = capturas

[General]
Empresa = $CompanyName
CorreoContacto = $ContactEmail

[Telemetria]
IdleUmbralSegundos = 60

[Admin]
PIN = DESHABILITADO

[GoogleDrive]
Enabled = false
FolderId =
CredentialsJson =

[EvidenceBackend]
Enabled = true
Url = $ApiUrl
DeviceToken = $($DeviceToken.Trim())
RetryLimit = 50
RequestTimeoutSeconds = 30
QueueDatabase =

[StationAuth]
AllowLocalFallback = false
"@
$configPath = Join-Path $packageAgent "config.ini"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $configText, $utf8NoBom)

$installPs1 = @'
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root "VYNTRAAgent"
$wizard = Join-Path $root "installer\install_agent_wizard.ps1"
Set-ExecutionPolicy -Scope Process Bypass -Force
& $wizard -SourceDir $source
'@
Set-Content -LiteralPath (Join-Path $packageRoot "Instalar VYNTRA.ps1") -Value $installPs1 -Encoding UTF8

$installCmd = @'
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalar VYNTRA.ps1"
endlocal
'@
Set-Content -LiteralPath (Join-Path $packageRoot "Instalar VYNTRA.cmd") -Value $installCmd -Encoding ASCII

$verifyPs1 = @'
$task = Get-ScheduledTask -TaskName "VYNTRA Agent" -ErrorAction SilentlyContinue
$installDir = Join-Path $env:LOCALAPPDATA "Programs\VYNTRAAgent"
$exe = Join-Path $installDir "VYNTRAAgent.exe"
Write-Host "Tarea programada:" ($(if ($task) { "OK" } else { "NO ENCONTRADA" }))
Write-Host "Ejecutable:" ($(if (Test-Path -LiteralPath $exe) { "OK - $exe" } else { "NO ENCONTRADO" }))
if ($task) { Get-ScheduledTaskInfo -TaskName "VYNTRA Agent" | Format-List }
'@
Set-Content -LiteralPath (Join-Path $packageRoot "Verificar instalacion.ps1") -Value $verifyPs1 -Encoding UTF8

$uninstallPs1 = @'
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$uninstaller = Join-Path $root "installer\uninstall_agent_autostart.ps1"
Set-ExecutionPolicy -Scope Process Bypass -Force
& $uninstaller -RemoveInstallDir
'@
Set-Content -LiteralPath (Join-Path $packageRoot "Desinstalar VYNTRA.ps1") -Value $uninstallPs1 -Encoding UTF8

$readme = @"
VYNTRA Agent - Instalacion de prueba

Empresa: $CompanyName
Backend: $ApiUrl

Pasos para instalar:
1. Extrae este ZIP en la PC del usuario monitoreado.
2. Ejecuta "Instalar VYNTRA.cmd".
3. Deja marcada la opcion "Iniciar agente al finalizar".
4. El empleado inicia sesion con las credenciales enviadas por correo.
5. El empleado acepta el consentimiento mostrado por VYNTRA.
6. En el panel web revisa Dispositivos: debe actualizar last_seen_at.

Notas:
- Este paquete es generico y puede instalarse en varias PCs de la empresa.
- En el primer inicio de sesion, VYNTRA registra automaticamente la PC y guarda un DeviceToken unico.
- No incluye credenciales de Google Drive ni secretos del panel.
- La carpeta legal incluye terminos y aviso de consentimiento en espanol e ingles.
- Para quitarlo, ejecuta "Desinstalar VYNTRA.ps1".
"@
Set-Content -LiteralPath (Join-Path $packageRoot "LEEME-INSTALACION.txt") -Value $readme -Encoding UTF8

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $zipPath -Force

Write-Host "Paquete listo:"
Write-Host $zipPath
Write-Host "Carpeta preparada:"
Write-Host $packageRoot
