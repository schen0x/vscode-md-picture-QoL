<#
.SYNOPSIS
Install one local VSIX into the selected VS Code installation.
.DESCRIPTION
./deploy.ps1 [path/to/extension.vsix] [-Code command] [-DryRun]
Default package: <name>-<version>.vsix in this repository, from package.json.
-Code: VS Code CLI command or path (default: code); use code-insiders for Insiders.
-ExtensionsDir / -UserDataDir: override VS Code directories (see README.md).
-DryRun: print the command without running VS Code.
Argument paths are relative to your current working directory.
Installation replaces this extension's installed version (--force).
Default installation uses VS Code's normal user directories. Supply both directory
overrides to keep writes in this repository.
#>
param(
    [Parameter(Position = 0)][string]$VsixPath,
    [string]$Code = 'code',
    [string]$ExtensionsDir,
    [string]$UserDataDir,
    [switch]$DryRun,
    [Alias('h')][switch]$Help
)

if ($args.Count) { Write-Host "[deploy] Unknown arguments: $args"; exit 2 }
if ($Help) { Get-Help $PSCommandPath -Detailed; exit 0 }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
try {
    if (-not $VsixPath) {
        $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
        $VsixPath = Join-Path $PSScriptRoot "$($manifest.name)-$($manifest.version).vsix"
    }
    if (-not (Test-Path -LiteralPath $VsixPath -PathType Leaf) -or [IO.Path]::GetExtension($VsixPath) -ine '.vsix') {
        throw "VSIX not found or invalid: $VsixPath. Run ./rebuild.ps1 first."
    }
    $VsixPath = (Resolve-Path -LiteralPath $VsixPath).ProviderPath
    $codeArgs = @()
    if ($ExtensionsDir) { $codeArgs += @('--extensions-dir', $ExtensionsDir) }
    if ($UserDataDir) { $codeArgs += @('--user-data-dir', $UserDataDir) }
    $codeArgs += @('--install-extension', $VsixPath, '--force')
    if ($DryRun) {
        $quoted = @(@($Code) + $codeArgs | ForEach-Object { "'" + $_.Replace("'", "''") + "'" })
        Write-Host "[deploy] Command: & $($quoted -join ' ')"
    } else {
        $codeCommand = Get-Command $Code -ErrorAction SilentlyContinue
        if (-not $codeCommand) { throw "VS Code CLI not found: $Code. Add code to PATH or use -Code PATH." }
        Write-Host "[deploy] Installing: $VsixPath"
        $ErrorActionPreference = 'Continue'
        & $codeCommand @codeArgs
        $installExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($installExit -ne 0) { throw "Install failed (exit $installExit)." }
        Write-Host '[deploy] Installed. Run Developer: Reload Window in the selected VS Code to activate.'
    }
} catch {
    Write-Host "[deploy] ERROR: $_" -ForegroundColor Red
    exit 1
}
exit 0
