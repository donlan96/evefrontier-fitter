param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot "backend"
$runtimeRoot = Join-Path $env:LOCALAPPDATA "EveFrontierFitter"
$venvRoot = Join-Path $runtimeRoot "venv"
$pythonPath = Join-Path $venvRoot "Scripts\python.exe"
$logRoot = Join-Path $runtimeRoot "logs"
$statePath = Join-Path $runtimeRoot "running-processes.json"
$requirementsPath = Join-Path $backendRoot "requirements.txt"
$requirementsMarker = Join-Path $runtimeRoot "requirements.sha256"
$frontendUrl = "http://localhost:3000"
$solverUrl = "http://127.0.0.1:8765/api/health"

function Normalize-ProcessPath {
    $environment = [Environment]::GetEnvironmentVariables("Process")
    $pathKeys = @($environment.Keys | Where-Object { [string]$_ -ieq "Path" })
    if ($pathKeys.Count -le 1) { return }

    $preferredKey = @($pathKeys | Where-Object { [string]$_ -ceq "Path" } | Select-Object -First 1)
    if ($preferredKey.Count -eq 0) { $preferredKey = @($pathKeys[0]) }
    $pathValue = [string]$environment[$preferredKey[0]]
    foreach ($key in $pathKeys) {
        [Environment]::SetEnvironmentVariable([string]$key, $null, "Process")
    }
    [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
}

function Test-PythonRuntime {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        & $Path -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" *> $null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Test-Frontend {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $frontendUrl -TimeoutSec 2
        if ($response.StatusCode -ne 200 -or
            $response.Content -notmatch "FRONTIER FIT LAB" -or
            $response.Content -notmatch 'class="app"') {
            return $false
        }

        $stylesheetMatch = [regex]::Match(
            $response.Content,
            'href="([^"?]+\.css(?:\?[^\"]*)?)"'
        )
        $scriptMatch = [regex]::Match(
            $response.Content,
            '(?:src|href)="([^"?]+\.js(?:\?[^\"]*)?)"'
        )
        if (-not $stylesheetMatch.Success -or -not $scriptMatch.Success) {
            return $false
        }

        $baseUri = [uri]$frontendUrl
        $stylesheetUri = [uri]::new($baseUri, $stylesheetMatch.Groups[1].Value).AbsoluteUri
        $scriptUri = [uri]::new($baseUri, $scriptMatch.Groups[1].Value).AbsoluteUri
        $stylesheet = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $stylesheetUri -TimeoutSec 2
        $script = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $scriptUri -TimeoutSec 2
        $stylesheetType = [string]$stylesheet.Headers["Content-Type"]
        $scriptType = [string]$script.Headers["Content-Type"]

        return $stylesheet.StatusCode -eq 200 -and
            $stylesheetType -match "text/css" -and
            $script.StatusCode -eq 200 -and
            $scriptType -match "(?:java|ecma)script"
    }
    catch {
        return $false
    }
}

function Test-Solver {
    try {
        $response = Invoke-RestMethod -Uri $solverUrl -TimeoutSec 2
        return $response.status -eq "ok" -and $response.solver -eq "ortools-cp-sat"
    }
    catch {
        return $false
    }
}

function Get-ListeningProcessId {
    param([int]$Port)
    $pattern = "^\s*TCP\s+127\.0\.0\.1:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    foreach ($line in (& netstat.exe -ano -p tcp)) {
        if ($line -match $pattern) { return [int]$Matches[1] }
    }
    return $null
}

function Find-SystemPython {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command -and (Test-PythonRuntime $command.Source)) { return $command.Source }

    $installRoot = Join-Path $env:LOCALAPPDATA "Programs\Python"
    $candidate = Get-ChildItem -LiteralPath $installRoot -Directory -Filter "Python3*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "python.exe" } |
        Where-Object { Test-PythonRuntime $_ } |
        Select-Object -First 1
    if ($candidate) { return $candidate }

    $codexRuntimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes"
    return Get-ChildItem -LiteralPath $codexRuntimeRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName "dependencies\python\python.exe" } |
        Where-Object { Test-PythonRuntime $_ } |
        Select-Object -First 1
}

function Find-Node {
    $candidates = @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        ((Get-Command node.exe -ErrorAction SilentlyContinue).Source)
    )
    return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Find-Pnpm {
    $candidates = @(
        (Join-Path $env:APPDATA "npm\pnpm.cmd"),
        ((Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source)
    )
    return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Save-State {
    param([hashtable]$State)
    $State | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}

Normalize-ProcessPath
New-Item -ItemType Directory -Path $runtimeRoot, $logRoot -Force | Out-Null

# Daily re-entry should be immediate when both managed services are already healthy.
if ((Test-Frontend) -and (Test-Solver)) {
    $frontendListenerPid = Get-ListeningProcessId -Port 3000
    $solverListenerPid = Get-ListeningProcessId -Port 8765
    if ($frontendListenerPid -and $solverListenerPid) {
        Save-State -State @{
            frontendPid = $frontendListenerPid
            solverPid = $solverListenerPid
        }
        Write-Host "EVE Frontier Fitter is already ready: $frontendUrl"
        if (-not $NoBrowser) {
            Start-Process $frontendUrl
        }
        exit 0
    }
}

$venvBackupRoot = $null
$venvRecreated = $false
if (-not (Test-PythonRuntime $pythonPath)) {
    $systemPython = Find-SystemPython
    if (-not $systemPython) {
        throw "Python 3 was not found. Install Python 3.11 or newer."
    }
    Write-Host "Preparing or repairing the local solver environment..."
    if (Test-Path -LiteralPath $venvRoot) {
        $venvBackupRoot = "$venvRoot.broken-$PID"
        Move-Item -LiteralPath $venvRoot -Destination $venvBackupRoot
    }
    & $systemPython -m venv $venvRoot
    if ($LASTEXITCODE -ne 0 -or -not (Test-PythonRuntime $pythonPath)) {
        Remove-Item -LiteralPath $venvRoot -Recurse -Force -ErrorAction SilentlyContinue
        if ($venvBackupRoot -and (Test-Path -LiteralPath $venvBackupRoot)) {
            Move-Item -LiteralPath $venvBackupRoot -Destination $venvRoot
        }
        throw "Failed to create the Python solver environment."
    }
    $venvRecreated = $true
}

$requirementsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $requirementsPath).Hash
$installedHash = if (-not $venvRecreated -and (Test-Path -LiteralPath $requirementsMarker)) {
    (Get-Content -Raw -LiteralPath $requirementsMarker).Trim()
} else { "" }
if ($installedHash -ne $requirementsHash) {
    Write-Host "Checking local solver components..."
    & $pythonPath -m pip install -q -r $requirementsPath
    if ($LASTEXITCODE -ne 0) {
        if ($venvRecreated) {
            Remove-Item -LiteralPath $venvRoot -Recurse -Force -ErrorAction SilentlyContinue
            if ($venvBackupRoot -and (Test-Path -LiteralPath $venvBackupRoot)) {
                Move-Item -LiteralPath $venvBackupRoot -Destination $venvRoot
            }
        }
        throw "Failed to install Python solver components."
    }
    Set-Content -LiteralPath $requirementsMarker -Value $requirementsHash -Encoding ASCII
}
if ($venvBackupRoot -and (Test-Path -LiteralPath $venvBackupRoot)) {
    Remove-Item -LiteralPath $venvBackupRoot -Recurse -Force
}

$nodePath = Find-Node
if (-not $nodePath) {
    throw "Node.js was not found. Install Node.js 22.13 or newer."
}

$buildEntry = Join-Path $projectRoot "dist\server\index.js"
if (-not (Test-Path -LiteralPath $buildEntry)) {
    $pnpmPath = Find-Pnpm
    if (-not $pnpmPath) { throw "The production build and pnpm were not found." }
    Write-Host "First run: building the local web app..."
    Push-Location $projectRoot
    try {
        & $pnpmPath run build
        if ($LASTEXITCODE -ne 0) { throw "Failed to build the local web app." }
    }
    finally {
        Pop-Location
    }
}

$state = @{}
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue

$startedPids = @()
try {
    if (-not (Test-Solver)) {
        $solverOut = Join-Path $logRoot "solver.out.log"
        $solverError = Join-Path $logRoot "solver.error.log"
        Remove-Item -LiteralPath $solverOut, $solverError -Force -ErrorAction SilentlyContinue
        $solver = Start-Process `
            -FilePath $pythonPath `
            -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8765") `
            -WorkingDirectory $backendRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $solverOut `
            -RedirectStandardError $solverError `
            -PassThru
        $state.solverPid = $solver.Id
        $startedPids += $solver.Id
    }

    if (-not (Test-Frontend)) {
        $frontendOut = Join-Path $logRoot "frontend.out.log"
        $frontendError = Join-Path $logRoot "frontend.error.log"
        Remove-Item -LiteralPath $frontendOut, $frontendError -Force -ErrorAction SilentlyContinue
        $vinextCli = Join-Path $projectRoot "node_modules\vinext\dist\cli.js"
        if (-not (Test-Path -LiteralPath $vinextCli)) {
            throw "Web dependencies are incomplete. Run pnpm install in the project directory."
        }
        $frontend = Start-Process `
            -FilePath $nodePath `
            -ArgumentList @($vinextCli, "start", "--hostname", "127.0.0.1", "--port", "3000") `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $frontendOut `
            -RedirectStandardError $frontendError `
            -PassThru
        $state.frontendPid = $frontend.Id
        $startedPids += $frontend.Id
    }

    $deadline = (Get-Date).AddSeconds(45)
    do {
        $frontendReady = Test-Frontend
        $solverReady = Test-Solver
        if ($frontendReady -and $solverReady) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    if (-not $frontendReady -or -not $solverReady) {
        throw "Services did not become ready. Check logs in: $logRoot"
    }

    $frontendListenerPid = Get-ListeningProcessId -Port 3000
    $solverListenerPid = Get-ListeningProcessId -Port 8765
    if (-not $frontendListenerPid -or -not $solverListenerPid) {
        throw "Ready services did not expose their listening process IDs."
    }
    $state.frontendPid = $frontendListenerPid
    $state.solverPid = $solverListenerPid
    Save-State -State $state

    Write-Host "EVE Frontier Fitter is ready: $frontendUrl"
    if (-not $NoBrowser) {
        Start-Process $frontendUrl
    }
}
catch {
    foreach ($processId in $startedPids) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    throw
}
