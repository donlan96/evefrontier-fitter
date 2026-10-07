$ErrorActionPreference = "Stop"

$runtimeRoot = Join-Path $env:LOCALAPPDATA "EveFrontierFitter"
$logRoot = Join-Path $runtimeRoot "logs"
$launcherLog = Join-Path $logRoot "launcher.log"
$frontendUrl = "http://localhost:3000"
$startScript = Join-Path $PSScriptRoot "start-local.ps1"
$popup = $null

function Write-LauncherLog {
    param(
        [string]$Status,
        [string]$Message
    )

    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $launcherLog -Encoding UTF8 -Value "[$timestamp] [$Status] $Message"
}

function Show-LauncherMessage {
    param(
        [string]$Message,
        [string]$Title,
        [int]$Seconds = 0,
        [int]$Icon = 64
    )

    if (-not $script:popup) {
        $script:popup = New-Object -ComObject WScript.Shell
    }
    $null = $script:popup.Popup($Message, $Seconds, $Title, $Icon)
}

function Open-FitterPage {
    $explorerPath = Join-Path $env:WINDIR "explorer.exe"
    if (Test-Path -LiteralPath $explorerPath) {
        Start-Process -FilePath $explorerPath -ArgumentList $frontendUrl
        return
    }
    Start-Process $frontendUrl
}

try {
    Write-LauncherLog -Status "START" -Message "Launcher requested."
    Show-LauncherMessage `
        -Message "配装工具正在后台启动。`n首次启动或更新后可能需要约 1 分钟，准备完成后会自动打开网页。" `
        -Title "舰装格局" `
        -Seconds 4

    & $startScript -NoBrowser
    Open-FitterPage
    Write-LauncherLog -Status "READY" -Message "Services are ready and the browser was requested."
}
catch {
    $detail = $_ | Out-String
    Write-LauncherLog -Status "ERROR" -Message $detail.Trim()
    Show-LauncherMessage `
        -Message "配装工具启动失败。`n`n$($_.Exception.Message)`n`n详细记录：$launcherLog" `
        -Title "舰装格局 - 启动失败" `
        -Icon 16
    exit 1
}
