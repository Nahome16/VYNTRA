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

$script:Language = "es"
$strings = @{
    en = @{
        WindowTitle = "VYNTRA Agent - Installer"
        Title = "Install VYNTRA Agent"
        Subtitle = "Configure the work clock, monitoring and Windows autostart agent."
        Language = "Language"
        Source = "Compiled folder"
        Browse = "Browse"
        Destination = "Install destination"
        Task = "Scheduled task name"
        Start = "Start agent when finished"
        Ready = "Ready to install. Review the paths before continuing."
        Install = "Install"
        Close = "Close"
        Footer = "VYNTRA installs the agent for the current user and registers autostart at sign-in."
        BrowseDescription = "Select the dist\VYNTRAAgent folder"
        Validating = "Validating files..."
        MissingDestination = "Define an install destination."
        MissingTask = "Define the scheduled task name."
        Copying = "Copying agent and configuration..."
        Completed = "Installation completed for {0}."
        CompletedTitle = "Installation completed"
        CompletedBody = "VYNTRA Agent was installed at:`n{0}`n`nScheduled task:`n{1}"
        FailedTitle = "Could not install"
        HelpMissing = "The legal documents folder was not found in this package."
    }
}

function T {
    param([string]$Key)
    if ($script:Language -eq "en" -and $strings.en.ContainsKey($Key)) {
        return $strings.en[$Key]
    }
    $es = @{
        WindowTitle = "VYNTRA Agent - Instalador"
        Title = "Instalar VYNTRA Agent"
        Subtitle = "Configura el agente de marcaje, monitoreo y autoarranque de Windows."
        Language = "Idioma"
        Source = "Carpeta compilada"
        Browse = "Buscar"
        Destination = "Destino de instalacion"
        Task = "Nombre de tarea programada"
        Start = "Iniciar agente al finalizar"
        Ready = "Listo para instalar. Verifica las rutas antes de continuar."
        Install = "Instalar"
        Close = "Cerrar"
        Footer = "VYNTRA instala el agente para el usuario actual y registra autoarranque al iniciar sesion."
        BrowseDescription = "Selecciona la carpeta dist\VYNTRAAgent"
        Validating = "Validando archivos..."
        MissingDestination = "Define una carpeta de destino."
        MissingTask = "Define el nombre de la tarea programada."
        Copying = "Copiando agente y configuracion..."
        Completed = "Instalacion completada para {0}."
        CompletedTitle = "Instalacion completada"
        CompletedBody = "VYNTRA Agent quedo instalado en:`n{0}`n`nTarea programada:`n{1}"
        FailedTitle = "No se pudo instalar"
        HelpMissing = "No se encontro la carpeta de documentos legales en este paquete."
    }
    return $es[$Key]
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
        [string]$SelectedLanguage,
        [bool]$StartNow
    )

    $sourceExe = Join-Path $ResolvedSource "VYNTRAAgent.exe"
    if (-not (Test-Path -LiteralPath $sourceExe)) {
        throw "No se encontro VYNTRAAgent.exe en $ResolvedSource."
    }

    New-Item -ItemType Directory -Path $ResolvedInstallDir -Force | Out-Null
    Copy-Item -Path (Join-Path $ResolvedSource "*") -Destination $ResolvedInstallDir -Recurse -Force
    $sourceRoot = Split-Path -Parent $ResolvedSource
    $legalSource = Join-Path $sourceRoot "legal"
    if (-not (Test-Path -LiteralPath $legalSource)) {
        $repoRoot = Split-Path -Parent $PSScriptRoot
        $legalSource = Join-Path $repoRoot "docs\legal"
    }
    if (Test-Path -LiteralPath $legalSource) {
        Copy-Item -Path $legalSource -Destination (Join-Path $ResolvedInstallDir "legal") -Recurse -Force
    }

    $exePath = Join-Path $ResolvedInstallDir "VYNTRAAgent.exe"
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "No se pudo instalar VYNTRAAgent.exe en $ResolvedInstallDir."
    }

    $configPath = Join-Path $ResolvedInstallDir "config.ini"
    if (Test-Path -LiteralPath $configPath) {
        $language = if ($SelectedLanguage -eq "en") { "en" } else { "es" }
        $configText = Get-Content -LiteralPath $configPath -Raw
        if ($configText -match "(?m)^\[Interface\]") {
            if ($configText -match "(?m)^\s*Language\s*=") {
                $configText = [regex]::Replace($configText, "(?m)^\s*Language\s*=.*$", "Language = $language")
            } else {
                $configText = [regex]::Replace($configText, "(?m)^\[Interface\]\s*$", "[Interface]`r`nLanguage = $language")
            }
        } else {
            $configText = $configText.TrimEnd() + "`r`n`r`n[Interface]`r`nLanguage = $language`r`n"
        }
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($configPath, $configText, $utf8NoBom)
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
$form.Text = T "WindowTitle"
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
$title.Text = T "Title"
$title.Font = New-Font 18 ([System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::White
$title.BackColor = $colors.PrimaryDark
$title.Location = New-Object System.Drawing.Point(98, 26)
$title.Size = New-Object System.Drawing.Size(460, 32)
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = T "Subtitle"
$subtitle.Font = New-Font 10
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(219, 234, 254)
$subtitle.BackColor = $colors.PrimaryDark
$subtitle.Location = New-Object System.Drawing.Point(100, 62)
$subtitle.Size = New-Object System.Drawing.Size(560, 24)
$header.Controls.Add($subtitle)

$languageLabel = New-Object System.Windows.Forms.Label
$languageLabel.Text = T "Language"
$languageLabel.Font = New-Font 8 ([System.Drawing.FontStyle]::Bold)
$languageLabel.ForeColor = [System.Drawing.Color]::FromArgb(219, 234, 254)
$languageLabel.BackColor = $colors.PrimaryDark
$languageLabel.Location = New-Object System.Drawing.Point(554, 24)
$languageLabel.Size = New-Object System.Drawing.Size(74, 18)
$header.Controls.Add($languageLabel)

$languageSelect = New-Object System.Windows.Forms.ComboBox
$languageSelect.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
[void]$languageSelect.Items.Add("ES")
[void]$languageSelect.Items.Add("EN")
$languageSelect.SelectedItem = "ES"
$languageSelect.Location = New-Object System.Drawing.Point(554, 45)
$languageSelect.Size = New-Object System.Drawing.Size(72, 26)
$header.Controls.Add($languageSelect)

$helpButton = New-Object System.Windows.Forms.Button
$helpButton.Text = "?"
$helpButton.Font = New-Font 10 ([System.Drawing.FontStyle]::Bold)
$helpButton.Location = New-Object System.Drawing.Point(640, 43)
$helpButton.Size = New-Object System.Drawing.Size(38, 30)
$header.Controls.Add($helpButton)

$card = New-Object System.Windows.Forms.Panel
$card.BackColor = $colors.Surface
$card.Location = New-Object System.Drawing.Point(28, 144)
$card.Size = New-Object System.Drawing.Size(650, 330)
$card.Anchor = "Top,Left,Right"
$card.BorderStyle = "FixedSingle"
$form.Controls.Add($card)

$sourceLabel = New-Object System.Windows.Forms.Label
$sourceLabel.Text = T "Source"
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
$browseButton.Text = T "Browse"
$browseButton.Location = New-Object System.Drawing.Point(536, 49)
$browseButton.Size = New-Object System.Drawing.Size(86, 28)
$browseButton.Anchor = "Top,Right"
$card.Controls.Add($browseButton)

$installLabel = New-Object System.Windows.Forms.Label
$installLabel.Text = T "Destination"
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
$taskLabel.Text = T "Task"
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
$startCheck.Text = T "Start"
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
$statusLabel.Text = T "Ready"
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
$installButton.Text = T "Install"
$installButton.BackColor = $colors.Primary
$installButton.ForeColor = [System.Drawing.Color]::White
$installButton.FlatStyle = "Flat"
$installButton.Font = New-Font 10 ([System.Drawing.FontStyle]::Bold)
$installButton.Location = New-Object System.Drawing.Point(486, 494)
$installButton.Size = New-Object System.Drawing.Size(92, 34)
$installButton.Anchor = "Bottom,Right"
$form.Controls.Add($installButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = T "Close"
$closeButton.Location = New-Object System.Drawing.Point(586, 494)
$closeButton.Size = New-Object System.Drawing.Size(92, 34)
$closeButton.Anchor = "Bottom,Right"
$form.Controls.Add($closeButton)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = T "Footer"
$footer.ForeColor = $colors.Muted
$footer.Location = New-Object System.Drawing.Point(30, 500)
$footer.Size = New-Object System.Drawing.Size(430, 22)
$footer.Anchor = "Bottom,Left"
$form.Controls.Add($footer)

function Apply-Language {
    $form.Text = T "WindowTitle"
    $title.Text = T "Title"
    $subtitle.Text = T "Subtitle"
    $languageLabel.Text = T "Language"
    $sourceLabel.Text = T "Source"
    $browseButton.Text = T "Browse"
    $installLabel.Text = T "Destination"
    $taskLabel.Text = T "Task"
    $startCheck.Text = T "Start"
    $statusLabel.Text = T "Ready"
    $installButton.Text = T "Install"
    $closeButton.Text = T "Close"
    $footer.Text = T "Footer"
}

$languageSelect.Add_SelectedIndexChanged({
    $script:Language = if ($languageSelect.SelectedItem -eq "EN") { "en" } else { "es" }
    Apply-Language
})

$helpButton.Add_Click({
    try {
        $source = (Resolve-Path -LiteralPath $sourceText.Text).Path
        $packageRoot = Split-Path -Parent $source
        $legalFolder = Join-Path $packageRoot "legal"
        if (-not (Test-Path -LiteralPath $legalFolder)) {
            $repoRoot = Split-Path -Parent $PSScriptRoot
            $legalFolder = Join-Path $repoRoot "docs\legal"
        }
        if (-not (Test-Path -LiteralPath $legalFolder)) {
            [System.Windows.Forms.MessageBox]::Show(
                (T "HelpMissing"),
                "VYNTRA",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            ) | Out-Null
            return
        }
        Invoke-Item -LiteralPath $legalFolder
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "VYNTRA",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    }
})

$browseButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = T "BrowseDescription"
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
        $statusLabel.Text = T "Validating"
        $form.Refresh()

        $source = (Resolve-Path -LiteralPath $sourceText.Text).Path
        $target = $installText.Text.Trim()
        $task = $taskText.Text.Trim()
        if (-not $target) { throw (T "MissingDestination") }
        if (-not $task) { throw (T "MissingTask") }

        $progress.Value = 34
        $statusLabel.Text = T "Copying"
        $form.Refresh()

        $result = Install-VyntraAgent `
            -ResolvedSource $source `
            -ResolvedInstallDir $target `
            -ResolvedTaskName $task `
            -SelectedLanguage $script:Language `
            -StartNow $startCheck.Checked

        $progress.Value = 100
        $statusLabel.ForeColor = $colors.Good
        $statusLabel.Text = [string]::Format((T "Completed"), $result.User)
        [System.Windows.Forms.MessageBox]::Show(
            ([string]::Format((T "CompletedBody"), $result.InstallDir, $result.TaskName)),
            (T "CompletedTitle"),
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    } catch {
        $progress.Value = 0
        $statusLabel.ForeColor = $colors.Danger
        $statusLabel.Text = $_.Exception.Message
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            (T "FailedTitle"),
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } finally {
        $installButton.Enabled = $true
    }
})

[void]$form.ShowDialog()
