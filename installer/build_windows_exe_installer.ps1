param(
    [Parameter(Mandatory = $true)]
    [string]$CompanyName,

    [Parameter(Mandatory = $true)]
    [string]$ContactEmail,

    [string]$PackageName = "",
    [string]$SetupName = "",
    [string]$ApiUrl = "https://api.vyntralab.com",
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

Copy-Item -LiteralPath $builtExe -Destination $setupPath -Force

Write-Host "Instalador .exe listo:"
Write-Host $setupPath
