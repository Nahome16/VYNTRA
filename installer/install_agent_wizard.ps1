param(
    [string]$SourceDir = "",
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\VYNTRAAgent",
    [string]$TaskName = "VYNTRA Agent"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$colors = @{
    Bg = [System.Drawing.Color]::FromArgb(244, 247, 252)
    Surface = [System.Drawing.Color]::White
    Ink = [System.Drawing.Color]::FromArgb(15, 23, 42)
    Muted = [System.Drawing.Color]::FromArgb(100, 116, 139)
    Line = [System.Drawing.Color]::FromArgb(203, 216, 234)
    Primary = [System.Drawing.Color]::FromArgb(37, 99, 235)
    PrimaryDark = [System.Drawing.Color]::FromArgb(30, 64, 175)
    Soft = [System.Drawing.Color]::FromArgb(239, 246, 255)
    Good = [System.Drawing.Color]::FromArgb(22, 163, 74)
    Danger = [System.Drawing.Color]::FromArgb(220, 38, 38)
}

function New-Font {
    param(
        [int]$Size = 9,
        [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular
    )
    return New-Object System.Drawing.Font("Segoe UI", $Size, $Style)
}

function Resolve-SourceDir {
    param([string]$Candidate)
    if ($Candidate) {
        return (Resolve-Path -LiteralPath $Candidate).Path
    }
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $defaultSource = Join-Path $repoRoot "dist\VYNTRAAgent"
    if (Test-Path -LiteralPath $defaultSource) {
        return (Resolve-Path -LiteralPath $defaultSource).Path
    }
    return $defaultSource
}

function Install-VyntraAgent {
    param(
        [string]$ResolvedSource,
        [string]$ResolvedInstallDir,
        [string]$ResolvedTaskName,
        [bool]$StartNow
    )

    $sourceExe = Join-Path $ResolvedSource "VYNTRAAgent.exe"
    if (-not (Test-Path -LiteralPath $sourceExe)) {
        throw "No se encontro VYNTRAAgent.exe en $ResolvedSource."
    }

    New-Item -ItemType Directory -Path $ResolvedInstallDir -Force | Out-Null
    Copy-Item -Path (Join-Path $ResolvedSource "*") -Destination $ResolvedInstallDir -Recurse -Force

    $exePath = Join-Path $ResolvedInstallDir "VYNTRAAgent.exe"
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "No se pudo instalar VYNTRAAgent.exe en $ResolvedInstallDir."
    }

    $principalUser = "$env:USERDOMAIN\$env:USERNAME"
    $action = New-ScheduledTaskAction -Execute $exePath -WorkingDirectory $ResolvedInstallDir
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
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $ResolvedTaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "Inicia VYNTRA Agent automaticamente al iniciar sesion." `
        -Force | Out-Null

    if ($StartNow) {
        Start-ScheduledTask -TaskName $ResolvedTaskName
    }

    return @{
        InstallDir = $ResolvedInstallDir
        TaskName = $ResolvedTaskName
        User = $principalUser
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "VYNTRA Agent - Instalador"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(720, 560)
$form.MinimumSize = New-Object System.Drawing.Size(680, 540)
$form.BackColor = $colors.Bg
$form.Font = New-Font 9

$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = 118
$header.BackColor = $colors.PrimaryDark
$form.Controls.Add($header)

$mark = New-Object System.Windows.Forms.Label
$mark.Text = "V"
$mark.TextAlign = "MiddleCenter"
$mark.Font = New-Font 22 ([System.Drawing.FontStyle]::Bold)
$mark.ForeColor = $colors.PrimaryDark
$mark.BackColor = [System.Drawing.Color]::White
$mark.Location = New-Object System.Drawing.Point(28, 28)
$mark.Size = New-Object System.Drawing.Size(52, 52)
$header.Controls.Add($mark)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Instalar VYNTRA Agent"
$title.Font = New-Font 18 ([System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::White
$title.BackColor = $colors.PrimaryDark
$title.Location = New-Object System.Drawing.Point(98, 26)
$title.Size = New-Object System.Drawing.Size(460, 32)
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Configura el agente de marcaje, monitoreo y autoarranque de Windows."
$subtitle.Font = New-Font 10
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(219, 234, 254)
$subtitle.BackColor = $colors.PrimaryDark
$subtitle.Location = New-Object System.Drawing.Point(100, 62)
$subtitle.Size = New-Object System.Drawing.Size(560, 24)
$header.Controls.Add($subtitle)

$card = New-Object System.Windows.Forms.Panel
$card.BackColor = $colors.Surface
$card.Location = New-Object System.Drawing.Point(28, 144)
$card.Size = New-Object System.Drawing.Size(650, 330)
$card.Anchor = "Top,Left,Right"
$card.BorderStyle = "FixedSingle"
$form.Controls.Add($card)

$sourceLabel = New-Object System.Windows.Forms.Label
$sourceLabel.Text = "Carpeta compilada"
$sourceLabel.Font = New-Font 9 ([System.Drawing.FontStyle]::Bold)
$sourceLabel.ForeColor = $colors.Ink
$sourceLabel.Location = New-Object System.Drawing.Point(24, 24)
$sourceLabel.Size = New-Object System.Drawing.Size(200, 22)
$card.Controls.Add($sourceLabel)

$sourceText = New-Object System.Windows.Forms.TextBox
$sourceText.Text = Resolve-SourceDir -Candidate $SourceDir
$sourceText.Location = New-Object System.Drawing.Point(24, 50)
$sourceText.Size = New-Object System.Drawing.Size(500, 26)
$sourceText.Anchor = "Top,Left,Right"
$card.Controls.Add($sourceText)

$browseButton = New-Object System.Windows.Forms.Button
$browseButton.Text = "Buscar"
$browseButton.Location = New-Object System.Drawing.Point(536, 49)
$browseButton.Size = New-Object System.Drawing.Size(86, 28)
$browseButton.Anchor = "Top,Right"
$card.Controls.Add($browseButton)

$installLabel = New-Object System.Windows.Forms.Label
$installLabel.Text = "Destino de instalacion"
$installLabel.Font = New-Font 9 ([System.Drawing.FontStyle]::Bold)
$installLabel.ForeColor = $colors.Ink
$installLabel.Location = New-Object System.Drawing.Point(24, 96)
$installLabel.Size = New-Object System.Drawing.Size(200, 22)
$card.Controls.Add($installLabel)

$installText = New-Object System.Windows.Forms.TextBox
$installText.Text = $InstallDir
$installText.Location = New-Object System.Drawing.Point(24, 122)
$installText.Size = New-Object System.Drawing.Size(598, 26)
$installText.Anchor = "Top,Left,Right"
$card.Controls.Add($installText)

$taskLabel = New-Object System.Windows.Forms.Label
$taskLabel.Text = "Nombre de tarea programada"
$taskLabel.Font = New-Font 9 ([System.Drawing.FontStyle]::Bold)
$taskLabel.ForeColor = $colors.Ink
$taskLabel.Location = New-Object System.Drawing.Point(24, 168)
$taskLabel.Size = New-Object System.Drawing.Size(240, 22)
$card.Controls.Add($taskLabel)

$taskText = New-Object System.Windows.Forms.TextBox
$taskText.Text = $TaskName
$taskText.Location = New-Object System.Drawing.Point(24, 194)
$taskText.Size = New-Object System.Drawing.Size(292, 26)
$card.Controls.Add($taskText)

$startCheck = New-Object System.Windows.Forms.CheckBox
$startCheck.Text = "Iniciar agente al finalizar"
$startCheck.Checked = $true
$startCheck.ForeColor = $colors.Ink
$startCheck.BackColor = $colors.Surface
$startCheck.Location = New-Object System.Drawing.Point(342, 196)
$startCheck.Size = New-Object System.Drawing.Size(210, 24)
$card.Controls.Add($startCheck)

$statusBox = New-Object System.Windows.Forms.Panel
$statusBox.BackColor = $colors.Soft
$statusBox.Location = New-Object System.Drawing.Point(24, 244)
$statusBox.Size = New-Object System.Drawing.Size(598, 58)
$statusBox.Anchor = "Top,Left,Right"
$card.Controls.Add($statusBox)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Listo para instalar. Verifica las rutas antes de continuar."
$statusLabel.ForeColor = $colors.Muted
$statusLabel.BackColor = $colors.Soft
$statusLabel.Location = New-Object System.Drawing.Point(14, 10)
$statusLabel.Size = New-Object System.Drawing.Size(560, 20)
$statusBox.Controls.Add($statusLabel)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(14, 34)
$progress.Size = New-Object System.Drawing.Size(570, 10)
$progress.Anchor = "Top,Left,Right"
$progress.Minimum = 0
$progress.Maximum = 100
$progress.Value = 0
$statusBox.Controls.Add($progress)

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = "Instalar"
$installButton.BackColor = $colors.Primary
$installButton.ForeColor = [System.Drawing.Color]::White
$installButton.FlatStyle = "Flat"
$installButton.Font = New-Font 10 ([System.Drawing.FontStyle]::Bold)
$installButton.Location = New-Object System.Drawing.Point(486, 494)
$installButton.Size = New-Object System.Drawing.Size(92, 34)
$installButton.Anchor = "Bottom,Right"
$form.Controls.Add($installButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Cerrar"
$closeButton.Location = New-Object System.Drawing.Point(586, 494)
$closeButton.Size = New-Object System.Drawing.Size(92, 34)
$closeButton.Anchor = "Bottom,Right"
$form.Controls.Add($closeButton)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = "VYNTRA instala el agente para el usuario actual y registra autoarranque al iniciar sesion."
$footer.ForeColor = $colors.Muted
$footer.Location = New-Object System.Drawing.Point(30, 500)
$footer.Size = New-Object System.Drawing.Size(430, 22)
$footer.Anchor = "Bottom,Left"
$form.Controls.Add($footer)

$browseButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Selecciona la carpeta dist\VYNTRAAgent"
    $dialog.SelectedPath = $sourceText.Text
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $sourceText.Text = $dialog.SelectedPath
    }
})

$closeButton.Add_Click({
    $form.Close()
})

$installButton.Add_Click({
    try {
        $installButton.Enabled = $false
        $progress.Value = 12
        $statusLabel.Text = "Validando archivos..."
        $form.Refresh()

        $source = (Resolve-Path -LiteralPath $sourceText.Text).Path
        $target = $installText.Text.Trim()
        $task = $taskText.Text.Trim()
        if (-not $target) { throw "Define una carpeta de destino." }
        if (-not $task) { throw "Define el nombre de la tarea programada." }

        $progress.Value = 34
        $statusLabel.Text = "Copiando agente y configuracion..."
        $form.Refresh()

        $result = Install-VyntraAgent `
            -ResolvedSource $source `
            -ResolvedInstallDir $target `
            -ResolvedTaskName $task `
            -StartNow $startCheck.Checked

        $progress.Value = 100
        $statusLabel.ForeColor = $colors.Good
        $statusLabel.Text = "Instalacion completada para $($result.User)."
        [System.Windows.Forms.MessageBox]::Show(
            "VYNTRA Agent quedo instalado en:`n$($result.InstallDir)`n`nTarea programada:`n$($result.TaskName)",
            "Instalacion completada",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    } catch {
        $progress.Value = 0
        $statusLabel.ForeColor = $colors.Danger
        $statusLabel.Text = $_.Exception.Message
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "No se pudo instalar",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } finally {
        $installButton.Enabled = $true
    }
})

[void]$form.ShowDialog()
