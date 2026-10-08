param(
    [Parameter(Mandatory = $true)][string]$PythonExe,
    [Parameter(Mandatory = $true)][string]$IsccExe,
    [string]$NodeExe = ((Get-Command node.exe -ErrorAction Stop).Source),
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = $metadata.version
$buildRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot ('work\windows-package\' + $version + '-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))))
if (-not $buildRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build directory must remain inside the project.'
}
if (Test-Path -LiteralPath $buildRoot) { throw 'Build directory already exists; inspect it before reuse.' }
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$outputRoot = Join-Path $projectRoot 'outputs\releases'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

Push-Location $projectRoot
try {
    if (-not $SkipFrontendBuild) {
        & pnpm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    }
    $standalone = Join-Path $projectRoot 'dist\standalone'
    if (-not (Test-Path -LiteralPath (Join-Path $standalone 'server.js'))) { throw 'Standalone frontend output is missing.' }

    & $PythonExe -m PyInstaller --noconfirm --log-level WARN --distpath (Join-Path $buildRoot 'frozen') --workpath (Join-Path $buildRoot 'freeze-work') (Join-Path $PSScriptRoot 'EveFrontierFitter.spec')
    if ($LASTEXITCODE -ne 0) { throw 'Backend/launcher freezing failed.' }
    $payload = Join-Path $buildRoot 'frozen\EveFrontierFitter'
    Copy-Item -LiteralPath $standalone -Destination (Join-Path $payload 'web') -Recurse
    & $NodeExe (Join-Path $PSScriptRoot 'prepare-web-runtime.mjs') --web-dir (Join-Path $payload 'web')
    if ($LASTEXITCODE -ne 0) { throw 'Standalone runtime dependencies are incomplete.' }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json'), (Join-Path $projectRoot 'LICENSE'), (Join-Path $projectRoot 'README.md') -Destination $payload
    New-Item -ItemType Directory -Path (Join-Path $payload 'runtime'), (Join-Path $payload 'licenses') -Force | Out-Null

    $nodeVersion = (& $NodeExe --version).Trim()
    if ($nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Unexpected Node version.' }
    $nodeHashes = (Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/' + $nodeVersion + '/SHASUMS256.txt')).Content
    $nodeHashLine = @($nodeHashes -split "`n" | Where-Object { $_ -match '\s+win-x64/node\.exe\s*$' })
    if ($nodeHashLine.Count -ne 1) { throw 'Official Windows Node checksum not found.' }
    $expectedHash = ($nodeHashLine[0] -split '\s+')[0]
    $actualHash = (Get-FileHash -LiteralPath $NodeExe -Algorithm SHA256).Hash
    if ($actualHash -ine $expectedHash) { throw 'Node executable does not match its official checksum.' }
    Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $payload 'runtime\node.exe')
    Invoke-WebRequest -UseBasicParsing -Uri ('https://raw.githubusercontent.com/nodejs/node/' + $nodeVersion + '/LICENSE') -OutFile (Join-Path $payload 'licenses\NODE-LICENSE.txt')
    $notice = @(
        'Eve Frontier Fitter - Third-party notices',
        'Application source: MIT, Copyright 2026 donlan96.',
        ('Node.js ' + $nodeVersion + ': see licenses/NODE-LICENSE.txt.'),
        'Python: see _internal/licenses/python/LICENSE.txt.',
        'OR-Tools, FastAPI, Uvicorn and dependencies: licenses in _internal/*.dist-info/.',
        'vinext and frontend runtime dependencies: licenses in web/node_modules/.',
        'PyInstaller bootloader: GPL with the bootloader exception; see licenses/PYINSTALLER-COPYING.txt.',
        'EVE Frontier and third-party marks retain their respective rights.'
    )
    $notice | Set-Content -LiteralPath (Join-Path $payload 'THIRD_PARTY_NOTICES.txt') -Encoding UTF8
    & $PythonExe (Join-Path $PSScriptRoot 'copy-build-license.py') (Join-Path $payload 'licenses\PYINSTALLER-COPYING.txt')
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller license copy failed.' }

    # Inno's compressor may hit MAX_PATH on generated server chunk names.
    # A temporary unused drive shortens source paths without changing files.
    $compilerDrive = @('R','S','T','U','V','W','X','Y','Z') | Where-Object {
        -not (Get-PSDrive -Name $_ -ErrorAction SilentlyContinue) -and -not [IO.Directory]::Exists($_ + ':\')
    } | Select-Object -First 1
    if (-not $compilerDrive) { throw 'No unused drive letter is available for the compiler.' }
    $compilerDriveRoot = $compilerDrive + ':'
    & subst.exe $compilerDriveRoot $payload
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create temporary compiler path.' }
    try {
        & $IsccExe ('/DAppVersion=' + $version) ('/DPayloadDir=' + $compilerDriveRoot + '\') ('/DOutputDir=' + $outputRoot) (Join-Path $PSScriptRoot 'installer.iss')
        if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
    }
    finally {
        & subst.exe $compilerDriveRoot /D
    }
    $installer = Join-Path $outputRoot ('EveFrontierFitter-' + $version + '-Setup-x64.exe')
    $checksum = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    ($checksum + '  ' + [IO.Path]::GetFileName($installer)) | Set-Content -LiteralPath (Join-Path $outputRoot 'SHA256SUMS.txt') -Encoding ASCII
    [pscustomobject]@{Version=$version;Installer=$installer;Payload=$payload;Bytes=(Get-Item -LiteralPath $installer).Length;SHA256=$checksum;NodeVersion=$nodeVersion} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'build-manifest.json') -Encoding UTF8
    Get-Content -LiteralPath (Join-Path $outputRoot 'build-manifest.json')
}
finally {
    Pop-Location
}
