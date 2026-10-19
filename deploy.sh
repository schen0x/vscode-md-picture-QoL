#!/usr/bin/env bash
# Install one local VSIX into the available VS Code installations.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: ./deploy.sh [path/to/extension.vsix] [options]
Default package: <name>-<version>.vsix in this repository, from package.json.
  --code COMMAND          Deploy only to this VS Code CLI command or path.
                          Use code-insiders to explicitly target Insiders.
  --extensions-dir DIR    Override VS Code's extension directory.
  --user-data-dir DIR     Override VS Code's user data directory.
  --dry-run               Print the install command without running VS Code.
  -h, --help              Show this help.
Paths supplied as arguments are relative to your current working directory.
By default, deploy to both installed macOS apps: VS Code Stable and Insiders.
Missing apps are skipped. If neither app is found, fall back to code on PATH.
Installation replaces this extension's installed version (--force).
Default installation uses VS Code's normal user directories. To keep writes in
this repository, supply both directory overrides; see README.md.
HELP
}
STABLE_CANDIDATE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
INSIDER_CANDIDATE="/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
vsix=""
cli=""
dry_run=false
code_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --code|--extensions-dir|--user-data-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "[deploy] $1 requires a value." >&2; exit 2
      fi
      if [ "$1" = --code ]; then cli="$2"; else code_args+=("$1" "$2"); fi
      shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "[deploy] Unknown argument: $1 (see --help)" >&2; exit 2 ;;
    *)
      if [ -n "$vsix" ]; then echo "[deploy] Supply only one VSIX path." >&2; exit 2; fi
      vsix="$1"; shift ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "[deploy] Node.js is required to resolve the package path." >&2; exit 1
fi
if [ -z "$vsix" ]; then
  vsix="$(node -p 'const p = require(process.argv[1]); require("node:path").join(process.argv[2], `${p.name}-${p.version}.vsix`)' "$repo_root/package.json" "$repo_root")"
fi
if [ ! -f "$vsix" ] || [[ "$vsix" != *.[vV][sS][iI][xX] ]]; then
  echo "[deploy] VSIX not found or invalid: $vsix. Run ./rebuild.sh first." >&2; exit 1
fi
vsix="$(node -p 'require("node:path").resolve(process.argv[1])' -- "$vsix")"
code_args+=(--install-extension "$vsix" --force)
destinations=()
if [ -n "$cli" ]; then
  destinations+=("$cli")
else
  for candidate in "$STABLE_CANDIDATE" "$INSIDER_CANDIDATE"; do
    if [ -x "$candidate" ]; then destinations+=("$candidate"); fi
  done
  if [ "${#destinations[@]}" -eq 0 ]; then destinations+=(code); fi
fi
status=0
for cli in "${destinations[@]}"; do
  if $dry_run; then
    printf '[deploy] Command: '
    printf '%q ' "$cli" "${code_args[@]}"
    printf '\n'
    continue
  fi
  if ! command -v "$cli" >/dev/null 2>&1; then
    echo "[deploy] VS Code CLI not found: $cli. Add code to PATH or use --code PATH." >&2
    status=1
    continue
  fi
  echo "[deploy] Installing $vsix into: $cli"
  if "$cli" "${code_args[@]}"; then
    echo "[deploy] Installed in $cli. Run Developer: Reload Window there to activate."
  else
    echo "[deploy] Install failed: $cli" >&2
    status=1
  fi
done
exit "$status"
