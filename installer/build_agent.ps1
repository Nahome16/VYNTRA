param(
    [string]$Python = "py -3.13"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Installing/updating build dependencies..."
Invoke-Expression "$Python -m pip install -r requirements.txt"
Invoke-Expression "$Python -m pip install pyinstaller"

Write-Host "Compiling VYNTRA agent..."
Invoke-Expression "$Python -m PyInstaller vyntra_agent.spec --clean"

Write-Host "Build ready at dist\VYNTRAAgent"
Write-Host "To install auto-start on this PC, run:"
Write-Host ".\installer\install_agent_autostart.ps1"
