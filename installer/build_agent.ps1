param(
    # Comando de Python como texto ("py -3.13"). Se divide en ejecutable +
    # argumentos (sin Invoke-Expression). Para rutas con espacios usa -PythonExe.
    [string]$Python = "py -3.13",
    [string]$PythonExe = "",
    [string]$CertificateThumbprint = "",
    [string]$TimestampServer = "http://timestamp.digicert.com",
    [string]$SignToolPath = "signtool.exe",
    # Build de release: exige certificado de code signing y verifica la firma.
    [switch]$Release
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($PythonExe) {
    $pythonCommand = $PythonExe
    $pythonBaseArgs = @()
} else {
    $pythonParts = @($Python.Trim() -split "\s+" | Where-Object { $_ })
    if ($pythonParts.Count -eq 0) { throw "Parametro -Python vacio." }
    $pythonCommand = $pythonParts[0]
    $pythonBaseArgs = @()
    if ($pythonParts.Count -gt 1) { $pythonBaseArgs = $pythonParts[1..($pythonParts.Count - 1)] }
}

function Invoke-Python {
    param([string[]]$Arguments)
    & $pythonCommand @pythonBaseArgs @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python fallo (codigo $LASTEXITCODE): $pythonCommand $($pythonBaseArgs -join ' ') $($Arguments -join ' ')"
    }
}

if ($Release) {
    if ([string]::IsNullOrWhiteSpace($CertificateThumbprint) -or $CertificateThumbprint -eq "CERT_THUMBPRINT") {
        throw "Build -Release requiere -CertificateThumbprint con el thumbprint real del certificado de code signing."
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
    if ($LASTEXITCODE -ne 0) {
        throw "signtool fallo (codigo $LASTEXITCODE) firmando $Path"
    }
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
    Invoke-Python @((Join-Path $PSScriptRoot "create_vyntra_icon.py"))
}

Write-Host "Installing/updating build dependencies..."
Invoke-Python @("-m", "pip", "install", "-r", "requirements.txt")
Invoke-Python @("-m", "pip", "install", "pyinstaller")

Write-Host "Compiling VYNTRA agent..."
Invoke-Python @("-m", "PyInstaller", "vyntra_agent.spec", "--clean", "--noconfirm")

$distAgent = Join-Path $root "dist\VYNTRAAgent"
$agentExe = Join-Path $distAgent "VYNTRAAgent.exe"
if (-not (Test-Path -LiteralPath $agentExe)) {
    throw "PyInstaller no genero $agentExe"
}

# El build nunca debe llevar config.ini, credenciales ni tokens del desarrollador.
$forbidden = @("config.ini", "credentials.json", "credentials.previous.json", "token.json", "rules_cache.json")
Get-ChildItem -LiteralPath $distAgent -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $forbidden -contains $_.Name } |
    ForEach-Object {
        Write-Warning "Eliminando archivo local no permitido en el build: $($_.FullName)"
        Remove-Item -LiteralPath $_.FullName -Force
    }

if ($CertificateThumbprint) {
    Write-Host "Signing agent binaries..."
    Get-ChildItem -LiteralPath $distAgent -Recurse -Include *.exe,*.dll,*.pyd |
        ForEach-Object { Invoke-CodeSign -Path $_.FullName }
}

if ($Release) {
    $signature = Get-AuthenticodeSignature -LiteralPath $agentExe
    if ($signature.Status -ne "Valid") {
        throw "La firma de VYNTRAAgent.exe no es valida ($($signature.Status)). Build de release cancelado."
    }
    $signer = [string]$signature.SignerCertificate.Thumbprint
    if ($signer.ToUpperInvariant() -ne ($CertificateThumbprint -replace "\s", "").ToUpperInvariant()) {
        throw "VYNTRAAgent.exe esta firmado por $signer y no por $CertificateThumbprint."
    }
    Write-Host "Firma verificada: $signer"
}

Write-Host "Build ready at dist\VYNTRAAgent"
Write-Host "To install auto-start on this PC, run:"
Write-Host ".\installer\install_agent_autostart.ps1"
