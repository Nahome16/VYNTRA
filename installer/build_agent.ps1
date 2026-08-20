param(
    [string]$Python = "py -3.13"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$rootConfig = Join-Path $root "config.ini"
$templateConfig = Join-Path $PSScriptRoot "config.production.template.ini"
$generatedBuildConfig = $false
if (-not (Test-Path -LiteralPath $rootConfig)) {
    Copy-Item -LiteralPath $templateConfig -Destination $rootConfig -Force
    $generatedBuildConfig = $true
    Write-Host "Created temporary build config.ini from production template."
}

try {
    Write-Host "Installing/updating build dependencies..."
    Invoke-Expression "$Python -m pip install -r requirements.txt"
    Invoke-Expression "$Python -m pip install pyinstaller"

    Write-Host "Compiling VYNTRA agent..."
    Invoke-Expression "$Python -m PyInstaller vyntra_agent.spec --clean"
} finally {
    if ($generatedBuildConfig -and (Test-Path -LiteralPath $rootConfig)) {
        Remove-Item -LiteralPath $rootConfig -Force
        Write-Host "Removed temporary build config.ini."
    }
}

Write-Host "Build ready at dist\VYNTRAAgent"
Write-Host "To install auto-start on this PC, run:"
Write-Host ".\installer\install_agent_autostart.ps1"
