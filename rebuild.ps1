<#
.SYNOPSIS
Build and package Markdown Picture QoL. PowerShell equivalent of rebuild.sh.
.DESCRIPTION
./rebuild.ps1 [-Deps] [-Fast] [-Verbose] [-Audit] [-NoAudit]
-Deps: npm ci (automatic if node_modules is missing).
-Fast: skip unit tests; packaging still typechecks and compiles.
-Verbose: show npm diagnostic output.
-Audit / -NoAudit: enable / disable npm audit on install (default: disabled).
Output: <name>-<version>.vsix in the repository root, from package.json.
#>
param(
    [switch]$Deps,
    [switch]$Fast,
    [switch]$Verbose,
    [switch]$Audit,
    [switch]$NoAudit,
    [Alias('h')][switch]$Help
)

if ($args.Count) { Write-Host "[rebuild] Unknown arguments: $args"; exit 2 }
if ($Help) { Get-Help $PSCommandPath -Detailed; exit 0 }
$ErrorActionPreference = 'Stop'
# Check native exit codes ourselves, consistently across PowerShell versions.
$PSNativeCommandUseErrorActionPreference = $false
$previousCache = $env:npm_config_cache
$previousLogLevel = $env:npm_config_loglevel

function Invoke-Npm([string[]]$CommandArgs) {
    # PS 5.1 can turn native stderr warnings into terminating errors under Stop.
    $ErrorActionPreference = 'Continue'
    & $script:npmCommand @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($CommandArgs -join ' ') failed (exit $LASTEXITCODE)." }
}

Push-Location $PSScriptRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js 22 or newer and add it to PATH.'
    }
    # Prefer npm.cmd on Windows to avoid requiring npm.ps1 execution permission.
    $script:npmCommand = $null
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $script:npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    }
    if (-not $script:npmCommand) { $script:npmCommand = Get-Command npm -ErrorAction Stop }
    $env:npm_config_cache = Join-Path $PSScriptRoot '.npm-cache'
    if ($Verbose) { $env:npm_config_loglevel = 'verbose' }
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
    $vsix = Join-Path $PSScriptRoot "$($manifest.name)-$($manifest.version).vsix"
    if ($Deps -or -not (Test-Path -LiteralPath 'node_modules' -PathType Container)) {
        Write-Host '[rebuild] Installing locked dependencies'
        $auditFlag = if ($Audit -and -not $NoAudit) { '--audit' } else { '--no-audit' }
        Invoke-Npm -CommandArgs @('ci', $auditFlag, '--no-fund')
    }
    if (-not $Fast) {
        Write-Host '[rebuild] Running unit tests'
        Invoke-Npm -CommandArgs @('test')
    }
    # vscode:prepublish typechecks and compiles, including in -Fast mode.
    Write-Host '[rebuild] Packaging extension'
    Invoke-Npm -CommandArgs @('run', 'package')
    if (-not (Test-Path -LiteralPath $vsix -PathType Leaf)) { throw "Expected package was not created: $vsix" }
    Write-Host "[rebuild] VSIX: $vsix"
    Write-Host '[rebuild] Install with: ./deploy.ps1'
} catch {
    Write-Host "[rebuild] ERROR: $_" -ForegroundColor Red
    exit 1
} finally {
    $env:npm_config_cache = $previousCache
    $env:npm_config_loglevel = $previousLogLevel
    Pop-Location
}
exit 0
