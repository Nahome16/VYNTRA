param(
    [string]$Python = "py -3.13",
    [string]$CertificateThumbprint = "",
    [string]$TimestampServer = "http://timestamp.digicert.com",
    [string]$SignToolPath = "signtool.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Invoke-CodeSign {
    param([string]$Path)
    if (-not $CertificateThumbprint) { return }
    if ($CertificateThumbprint -eq "CERT_THUMBPRINT") {
        throw "Reemplaza CERT_THUMBPRINT por el thumbprint real de tu certificado de code signing."
    }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $resolvedSignTool = Resolve-SignToolPath
    & $resolvedSignTool sign `
        /fd SHA256 `
        /tr $TimestampServer `
        /td SHA256 `
        /sha1 $CertificateThumbprint `
        $Path
}

function Resolve-SignToolPath {
    if ($SignToolPath -and $SignToolPath -ne "signtool.exe") {
        if (Test-Path -LiteralPath $SignToolPath) {
            return $SignToolPath
        }
        throw "No se encontro signtool.exe en: $SignToolPath"
    }

    $fromCommand = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
    if ($fromCommand) {
        return $fromCommand.Source
    }

    $kitsRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    $found = Get-ChildItem -LiteralPath $kitsRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($found) {
        return $found.FullName
    }

    throw "No se encontro signtool.exe. Instala Windows SDK Signing Tools o pasa -SignToolPath con la ruta completa."
}

$iconPath = Join-Path $root "assets\vyntra.ico"
if (-not (Test-Path -LiteralPath $iconPath)) {
    & $Python (Join-Path $PSScriptRoot "create_vyntra_icon.py")
}

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
    Invoke-Expression "$Python -m PyInstaller vyntra_agent.spec --clean --noconfirm"

    if ($CertificateThumbprint) {
        Write-Host "Signing agent binaries..."
        Get-ChildItem -LiteralPath (Join-Path $root "dist\VYNTRAAgent") -Recurse -Include *.exe,*.dll,*.pyd |
            ForEach-Object { Invoke-CodeSign -Path $_.FullName }
    }
} finally {
    if ($generatedBuildConfig -and (Test-Path -LiteralPath $rootConfig)) {
        Remove-Item -LiteralPath $rootConfig -Force
        Write-Host "Removed temporary build config.ini."
    }
}

Write-Host "Build ready at dist\VYNTRAAgent"
Write-Host "To install auto-start on this PC, run:"
Write-Host ".\installer\install_agent_autostart.ps1"
