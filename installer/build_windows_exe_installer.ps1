param(
    [Parameter(Mandatory = $true)]
    [string]$CompanyName,

    [Parameter(Mandatory = $true)]
    [string]$ContactEmail,

    [string]$PackageName = "",
    [string]$SetupName = "",
    [string]$ApiUrl = "https://api.vyntralab.com",
    [string]$CertificateThumbprint = "",
    [string]$TimestampServer = "http://timestamp.digicert.com",
    [string]$SignToolPath = "signtool.exe",
    [switch]$BuildAgent
)

$ErrorActionPreference = "Stop"

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

$root = Split-Path -Parent $PSScriptRoot
$safeCompany = ($CompanyName -replace "[^a-zA-Z0-9_-]+", "-").Trim("-")
if (-not $safeCompany) { $safeCompany = "VYNTRA" }
if (-not $PackageName) { $PackageName = "VYNTRAAgent-$safeCompany-Generico" }
if (-not $SetupName) { $SetupName = "VYNTRAAgent-$safeCompany-Setup" }

$releaseDir = Join-Path $root "release"
$zipPath = Join-Path $releaseDir "$PackageName.zip"
$setupPath = Join-Path $releaseDir "$SetupName.exe"
$stageRoot = Join-Path $root ".installer_exe_build"
$stageDir = Join-Path $stageRoot $SetupName
$payloadZip = Join-Path $stageDir "payload.zip"
$bootstrap = Join-Path $PSScriptRoot "windows_setup_bootstrap.py"
$iconPath = Join-Path $root "assets\vyntra.ico"
$iconBuilder = Join-Path $PSScriptRoot "create_vyntra_icon.py"
$buildDir = Join-Path $stageDir "build"
$distDir = Join-Path $stageDir "dist"
$builtExe = Join-Path $distDir "$SetupName.exe"
$pythonCommand = "py"
$pythonArgs = @("-3.13")

if (-not (Test-Path -LiteralPath $iconPath)) {
    & $pythonCommand @pythonArgs $iconBuilder
}

if ($BuildAgent -or -not (Test-Path -LiteralPath $zipPath)) {
    & (Join-Path $PSScriptRoot "prepare_agent_package.ps1") `
        -CompanyName $CompanyName `
        -ContactEmail $ContactEmail `
        -ApiUrl $ApiUrl `
        -PackageName $PackageName `
        -CertificateThumbprint $CertificateThumbprint `
        -TimestampServer $TimestampServer `
        -SignToolPath $SignToolPath `
        -Build:$BuildAgent
}

if (-not (Test-Path -LiteralPath $zipPath)) {
    throw "No existe el paquete ZIP requerido: $zipPath"
}
if (-not (Test-Path -LiteralPath $bootstrap)) {
    throw "No existe el bootstrap del instalador: $bootstrap"
}

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
Safe-RemoveDirectory -Path $stageDir -AllowedRoot $stageRoot
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
Copy-Item -LiteralPath $zipPath -Destination $payloadZip -Force

& $pythonCommand @pythonArgs -m pip install pyinstaller

if (Test-Path -LiteralPath $setupPath) {
    Remove-Item -LiteralPath $setupPath -Force
}

$addData = "$payloadZip;."
$pyInstallerArgs = @(
    "-3.13",
    "-m",
    "PyInstaller",
    $bootstrap,
    "--onefile",
    "--windowed",
    "--noconfirm",
    "--clean",
    "--name",
    $SetupName,
    "--distpath",
    $distDir,
    "--workpath",
    $buildDir,
    "--specpath",
    $stageDir,
    "--add-data",
    $addData,
    "--icon",
    $iconPath
)
& $pythonCommand @pyInstallerArgs

if (-not (Test-Path -LiteralPath $builtExe)) {
    throw "PyInstaller no genero el instalador esperado: $builtExe"
}

Invoke-CodeSign -Path $builtExe
Copy-Item -LiteralPath $builtExe -Destination $setupPath -Force
Invoke-CodeSign -Path $setupPath

Write-Host "Instalador .exe listo:"
Write-Host $setupPath
