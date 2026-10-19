#!/usr/bin/env bash
# Build and package Markdown Picture QoL. Run from any working directory.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: ./rebuild.sh [--deps] [--fast] [--verbose] [--audit]
  --deps       Reinstall locked dependencies with npm ci (automatic if missing).
  --fast       Skip unit tests; packaging still typechecks and compiles.
  --verbose    Show npm diagnostic output.
  --audit      Enable npm audit during dependency installation (off by default).
  --no-audit   Disable npm audit (the default).
  -h, --help   Show this help.
Output: <name>-<version>.vsix in the repository root, from package.json.
Then run ./deploy.sh to install into VS Code.
HELP
}

do_deps=false
fast=false
verbose=false
audit=false
for arg in "$@"; do
  case "$arg" in
    --deps) do_deps=true ;;
    --fast) fast=true ;;
    --verbose|-v) verbose=true ;;
    --audit) audit=true ;;
    --no-audit) audit=false ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[rebuild] Unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[rebuild] $tool is required. Install Node.js 22 or newer and add it to PATH." >&2
    exit 1
  fi
done
# Keep npm's cache and logs in the repository.
export npm_config_cache="$PWD/.npm-cache"
if $verbose; then export npm_config_loglevel=verbose; fi
vsix="$(node -p 'const p = require("./package.json"); `${p.name}-${p.version}.vsix`')"

if $do_deps || [ ! -d node_modules ]; then
  echo "[rebuild] Installing locked dependencies"
  if $audit; then
    npm ci --audit --no-fund
  else
    npm ci --no-audit --no-fund
  fi
fi
if ! $fast; then
  echo "[rebuild] Running unit tests"
  npm test
fi
# vscode:prepublish performs the typecheck and compile, including in --fast mode.
echo "[rebuild] Packaging extension"
npm run package
if [ ! -f "$vsix" ]; then
  echo "[rebuild] Expected package was not created: $vsix" >&2
  exit 1
fi
echo "[rebuild] VSIX: $PWD/$vsix"
echo "[rebuild] Install with: ./deploy.sh"
