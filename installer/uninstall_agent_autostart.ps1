param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\VYNTRAAgent",
    [string]$TaskName = "VYNTRA Agent",
    [switch]$RemoveInstallDir
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tarea programada eliminada: $TaskName"
} else {
    Write-Host "No existe tarea programada: $TaskName"
}

if ($RemoveInstallDir -and (Test-Path -LiteralPath $InstallDir)) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Write-Host "Carpeta eliminada: $InstallDir"
}
