#!/usr/bin/env bash
# Installs the render agent of Open Creative Director on this computer (macOS, Linux) and pairs it (WP46).
# The app shows the command with a pairing code under "My computers":
#
#   curl -fsSL <app>/api/render-agent/install.sh | bash -s -- --server <app> --code <code> [--dir <folder>] [--name <name>]
#
# Needs Node.js 22 or newer (with npm) and curl. Fetches the package (setup.js) with the code and runs it: it installs the
# agent into ~/ocd-render-agent, pairs the computer and starts the agent in the foreground.
set -euo pipefail
OCD_SETUP_DIR=""

say() {
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
    de*) printf '%s\n' "$1" ;;
    es*) printf '%s\n' "$3" ;;
    *) printf '%s\n' "$2" ;;
  esac
}

main() {
  local server="" code="" dir="${HOME}/ocd-render-agent" name="" start="yes"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --server) server="${2:-}"; shift 2 ;;
      --code) code="${2:-}"; shift 2 ;;
      --dir) dir="${2:-}"; shift 2 ;;
      --name) name="${2:-}"; shift 2 ;;
      --no-start) start="no"; shift ;;
      *) shift ;;
    esac
  done
  if [ -z "$server" ] || [ -z "$code" ]; then
    say "Aufruf: … | bash -s -- --server <Adresse der App> --code <Code>" \
        "Usage: … | bash -s -- --server <address of the app> --code <code>" \
        "Uso: … | bash -s -- --server <dirección de la app> --code <código>" >&2
    exit 2
  fi
  server="${server%/}"

  if ! command -v node >/dev/null 2>&1; then
    say "Node.js fehlt. Der Render-Agent braucht Node.js 22 oder neuer: https://nodejs.org/" \
        "Node.js is missing. The render agent needs Node.js 22 or newer: https://nodejs.org/" \
        "Falta Node.js. El agente de render necesita Node.js 22 o posterior: https://nodejs.org/" >&2
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 22 ]; then
    say "Node.js $(node -v) ist zu alt. Der Render-Agent braucht Node.js 22 oder neuer: https://nodejs.org/" \
        "Node.js $(node -v) is too old. The render agent needs Node.js 22 or newer: https://nodejs.org/" \
        "Node.js $(node -v) es demasiado antiguo. El agente de render necesita Node.js 22 o posterior: https://nodejs.org/" >&2
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    say "npm fehlt (es gehört zu Node.js): https://nodejs.org/" \
        "npm is missing (it comes with Node.js): https://nodejs.org/" \
        "Falta npm (viene con Node.js): https://nodejs.org/" >&2
    exit 1
  fi

  OCD_SETUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ocd-render-agent.XXXXXX")"
  trap 'rm -rf "${OCD_SETUP_DIR:-}"' EXIT
  local tmp="$OCD_SETUP_DIR"
  if ! curl -fsS -H "X-Render-Agent-Code: ${code}" -o "${tmp}/setup.js" "${server}/api/render-agent/package"; then
    say "Das Paket konnte nicht geladen werden. Ist der Code noch gültig (10 Minuten)? Sonst in der App einen neuen holen." \
        "The package could not be loaded. Is the code still valid (10 minutes)? Otherwise get a new one in the app." \
        "No se pudo descargar el paquete. ¿Sigue siendo válido el código (10 minutos)? Si no, pide uno nuevo en la app." >&2
    exit 1
  fi

  local args=(--server "$server" --code "$code" --dir "$dir")
  if [ -n "$name" ]; then args+=(--name "$name"); fi
  if [ "$start" = "no" ]; then args+=(--no-start); fi
  node "${tmp}/setup.js" "${args[@]}" </dev/null
}

main "$@"
