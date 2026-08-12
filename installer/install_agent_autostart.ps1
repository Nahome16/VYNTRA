param(
    [string]$SourceDir = "",
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\VYNTRAAgent",
    [string]$TaskName = "VYNTRA Agent",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Resolve-SourceDir {
    param([string]$Candidate)

    if ($Candidate) {
        return (Resolve-Path -LiteralPath $Candidate).Path
    }

    $repoRoot = Split-Path -Parent $PSScriptRoot
    $defaultSource = Join-Path $repoRoot "dist\VYNTRAAgent"
    return (Resolve-Path -LiteralPath $defaultSource).Path
}

$resolvedSource = Resolve-SourceDir -Candidate $SourceDir
$sourceExe = Join-Path $resolvedSource "VYNTRAAgent.exe"
if (-not (Test-Path -LiteralPath $sourceExe)) {
    throw "No se encontro VYNTRAAgent.exe en $resolvedSource. Compila primero con .\installer\build_agent.ps1"
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $resolvedSource "*") -Destination $InstallDir -Recurse -Force

$exePath = Join-Path $InstallDir "VYNTRAAgent.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
    throw "No se pudo instalar VYNTRAAgent.exe en $InstallDir"
}

$principalUser = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $exePath -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $principalUser
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal `
    -UserId $principalUser `
    -LogonType Interactive `
    -RunLevel LeastPrivilege

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Inicia VYNTRA Agent automaticamente al iniciar sesion." `
    -Force | Out-Null

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
}

Write-Host "VYNTRA Agent instalado en: $InstallDir"
Write-Host "Tarea programada creada: $TaskName"
Write-Host "Usuario: $principalUser"
