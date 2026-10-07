param(
    [switch]$ShowMessage
)

$ErrorActionPreference = "Stop"
$runtimeRoot = Join-Path $env:LOCALAPPDATA "EveFrontierFitter"
$statePath = Join-Path $runtimeRoot "running-processes.json"
$logRoot = Join-Path $runtimeRoot "logs"
$stopLog = Join-Path $logRoot "stop.log"

function Write-StopLog {
    param([string]$Status, [string]$Message)
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $stopLog -Encoding UTF8 -Value "[$timestamp] [$Status] $Message"
}

function Show-StopMessage {
    param([string]$Message, [int]$Icon = 64)
    if (-not $ShowMessage) { return }
    $popup = New-Object -ComObject WScript.Shell
    $null = $popup.Popup($Message, 0, "EVE Frontier Fitter", $Icon)
}

function Get-ListeningProcessId {
    param([int]$Port)
    $pattern = "^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0):$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    foreach ($line in (& netstat.exe -ano -p tcp)) {
        if ($line -match $pattern) { return [int]$Matches[1] }
    }
    return $null
}

function Test-Frontend {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000" -TimeoutSec 2
        return $response.StatusCode -eq 200 -and $response.Content -match "FRONTIER FIT LAB"
    }
    catch { return $false }
}

function Test-Solver {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 2
        return $response.status -eq "ok" -and $response.solver -eq "ortools-cp-sat"
    }
    catch { return $false }
}

try {
    Write-StopLog -Status "START" -Message "Stop requested."
    $targetIds = [System.Collections.Generic.HashSet[int]]::new()
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        foreach ($processId in @($state.frontendPid, $state.solverPid)) {
            if ($processId) { $null = $targetIds.Add([int]$processId) }
        }
    }

    if (Test-Frontend) {
        $frontendPid = Get-ListeningProcessId -Port 3000
        if ($frontendPid) { $null = $targetIds.Add($frontendPid) }
    }
    if (Test-Solver) {
        $solverPid = Get-ListeningProcessId -Port 8765
        if ($solverPid) { $null = $targetIds.Add($solverPid) }
    }

    foreach ($processId in $targetIds) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        if ($process.ProcessName -notin @("node", "python", "python3")) {
            Write-StopLog -Status "SKIP" -Message "PID $processId is $($process.ProcessName), not a managed runtime."
            continue
        }
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Write-StopLog -Status "STOP" -Message "Stopped PID $processId ($($process.ProcessName))."
    }

    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    if ((Test-Frontend) -or (Test-Solver)) {
        throw "Services are still listening. Check $stopLog"
    }

    Write-StopLog -Status "DONE" -Message "Services stopped; browser tabs and local data were left unchanged."
    Show-StopMessage -Message "EVE Frontier Fitter services have stopped.`n`nThe browser tab stays open and can be closed manually. Local fitting data was not changed."
    Write-Host "EVE Frontier Fitter stopped. Browser tabs and local fitting data were not changed."
}
catch {
    $message = "Failed to stop EVE Frontier Fitter: $($_.Exception.Message)"
    Write-StopLog -Status "ERROR" -Message $message
    Show-StopMessage -Message "$message`n`nDetails: $stopLog" -Icon 16
    throw $message
}
