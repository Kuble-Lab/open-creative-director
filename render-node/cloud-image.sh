#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server at Hetzner Cloud for the snapshot of the render servers in the cloud of Open Creative
# Director (WP54, lib/cloud-render.js). Run it once as root on a new server (CPX42, Ubuntu 24.04), then switch the server off,
# take a snapshot and delete the server; the snapshot id goes into the settings of the app (Rendering → Render servers at
# Hetzner). The app gives the code in "My computers" (any code of an admin; it is only checked here, never used up):
#
#   curl -fsSL <app>/api/render-agent/cloud-image.sh | sudo bash -s -- --server <app> --code <code>
#
# render-node/cloud-snapshot.py does all of it (server, this script, a clean shutdown, the snapshot, deleting the server).
#
# What it does: fetches the package of the agent with the code (first, before the slow steps: the code lasts 10 minutes),
# installs Node.js 22 (NodeSource), unzip, the libraries of Chrome and the fonts, makes the user ocdrender (not "render": that
# group exists on Ubuntu), installs the agent into /opt/ocd-render-agent without pairing it (setup.js --update: npm ci, the
# browser of HyperFrames, ffmpeg), and installs two systemd units:
#
#   ocd-render-pair.service    on the first start of a server made from the snapshot: reads the pairing that cloud-init wrote
#                              from user_data (/etc/ocd-render/pairing.env), fetches the current package with that code and
#                              pairs (setup.js --no-start; npm ci only when the lockfile changed), then deletes the file
#   ocd-render-agent.service   the agent (node agent.js) as ocdrender, once agent.json exists and only when the first start
#                              succeeded (Requires=): setup.js pairs before npm ci, so a first start that fails later leaves
#                              an agent.json behind, and the agent must not run without its modules (the app deletes a server
#                              whose computer paired but never asks for work)
#
# No token is ever in the snapshot: agent.json is made on the first start of every server, with its own code.
set -euo pipefail

AGENT_DIR="/opt/ocd-render-agent"
AGENT_USER="ocdrender"
AGENT_HOME="/var/lib/ocdrender"
LIB_DIR="/usr/local/lib/ocd-render"

say() {
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
    de*) printf '%s\n' "$1" ;;
    es*) printf '%s\n' "$3" ;;
    *) printf '%s\n' "$2" ;;
  esac
}

fail() {
  say "$1" "$2" "$3" >&2
  exit 1
}

main() {
  local server="" code=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --server) server="${2:-}"; shift 2 ;;
      --code) code="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -z "$server" ] || [ -z "$code" ]; then
    fail "Aufruf: … | bash -s -- --server <Adresse der App> --code <Code>" \
         "Usage: … | bash -s -- --server <address of the app> --code <code>" \
         "Uso: … | bash -s -- --server <dirección de la app> --code <código>"
  fi
  server="${server%/}"
  [ "$(id -u)" = "0" ] || fail "Bitte als root ausführen." "Please run as root." "Ejecútalo como root."
  # shellcheck disable=SC1091
  if ! { [ -r /etc/os-release ] && . /etc/os-release && [ "${ID:-}" = "ubuntu" ]; }; then
    fail "Dieses Skript ist für Ubuntu 24.04." "This script is for Ubuntu 24.04." "Este script es para Ubuntu 24.04."
  fi
  if [ "${VERSION_ID:-}" != "24.04" ]; then
    say "Hinweis: gebaut für Ubuntu 24.04, hier ${VERSION_ID:-?}." "Note: made for Ubuntu 24.04, this is ${VERSION_ID:-?}." "Aviso: pensado para Ubuntu 24.04, aquí ${VERSION_ID:-?}."
  fi

  # 1. the package, while the code is fresh
  local setup="/root/ocd-render-setup.js"
  if ! curl -fsS --retry 3 -H "X-Render-Agent-Code: ${code}" -o "$setup" "${server}/api/render-agent/package"; then
    fail "Das Paket konnte nicht geladen werden. Ist der Code noch gültig (10 Minuten)?" \
         "The package could not be loaded. Is the code still valid (10 minutes)?" \
         "No se pudo descargar el paquete. ¿Sigue siendo válido el código (10 minutos)?"
  fi

  # 2. system packages: unzip (the browser of HyperFrames), the libraries of Chrome, fonts
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q </dev/null
  apt-get install -y -q --no-install-recommends ca-certificates curl gnupg unzip \
    fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core fontconfig \
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libexpat1 \
    libgbm1 libglib2.0-0t64 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 </dev/null

  # 3. Node.js 22 from NodeSource
  if ! node -v 2>/dev/null | grep -q '^v22\.'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x -o /root/nodesource_setup.sh
    bash /root/nodesource_setup.sh </dev/null
    apt-get install -y -q nodejs </dev/null
    rm -f /root/nodesource_setup.sh
  fi

  # 4. the user and the folder of the agent
  if ! id "$AGENT_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"
  fi
  install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 700 "$AGENT_DIR"
  install -m 644 "$setup" "${AGENT_HOME}/setup.js"
  rm -f "$setup"

  # 5. the agent without pairing: files, npm ci, the browser, ffmpeg
  runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" node "${AGENT_HOME}/setup.js" --update --snapshot-build --dir "$AGENT_DIR" </dev/null
  rm -f "${AGENT_HOME}/setup.js"

  # 6. the first start and the agent
  install -d -m 755 "$LIB_DIR"
  # the versions of this snapshot: the agent reports them (OCD_IMAGE_FILE), and the app says when the snapshot is outdated
  local hyperframes node_version
  hyperframes="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || ""))' "${AGENT_DIR}/node_modules/hyperframes/package.json" 2>/dev/null || true)"
  node_version="$(node -p 'process.versions.node')"
  printf '{"hyperframes":"%s","node":"%s","builtAt":"%s"}\n' "${hyperframes:-unknown}" "$node_version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${LIB_DIR}/image.json"
  chmod 644 "${LIB_DIR}/image.json"
  cat > "${LIB_DIR}/first-boot.sh" <<'FIRSTBOOT'
#!/usr/bin/env bash
# First start of a render server made from the snapshot (WP54): the pairing comes from user_data (cloud-init writes
# /etc/ocd-render/pairing.env); the current package is fetched with that code and the server is paired. The file is deleted.
set -euo pipefail
DIR="/opt/ocd-render-agent"
FILE="/etc/ocd-render/pairing.env"
[ -f "${DIR}/agent.json" ] && exit 0
for _ in $(seq 1 150); do
  [ -f "$FILE" ] && break
  sleep 2
done
if [ ! -f "$FILE" ]; then
  echo "ocd-render: no pairing in user_data (${FILE})" >&2
  exit 1
fi
# read without a shell: KEY='value', values without quotes
value() { sed -n "s/^$1='\([^']*\)'\$/\1/p" "$FILE" | head -n 1; }
server="$(value OCD_SERVER)"
code="$(value OCD_CODE)"
name="$(value OCD_NAME)"
if [ -z "$server" ] || [ -z "$code" ]; then
  echo "ocd-render: the pairing in ${FILE} is incomplete" >&2
  exit 1
fi
setup="$(mktemp --suffix=.js /tmp/ocd-render-setup.XXXXXX)"
trap 'rm -f "$setup"' EXIT
curl -fsS --retry 10 --retry-delay 3 --retry-all-errors -H "X-Render-Agent-Code: ${code}" -o "$setup" "${server}/api/render-agent/package"
chmod 644 "$setup"
runuser -u ocdrender -- env HOME=/var/lib/ocdrender node "$setup" --server "$server" --code "$code" --dir "$DIR" --name "${name:-cloud}" --no-start </dev/null
rm -f "$FILE"
FIRSTBOOT
  chmod 755 "${LIB_DIR}/first-boot.sh"

  cat > /etc/systemd/system/ocd-render-pair.service <<UNIT
[Unit]
Description=Open Creative Director: pair this render server (first start)
After=network-online.target cloud-init.service
Wants=network-online.target
ConditionPathExists=!${AGENT_DIR}/agent.json

[Service]
Type=oneshot
# stays active after it succeeded, so the agent that requires it is never stopped with it
RemainAfterExit=yes
ExecStart=${LIB_DIR}/first-boot.sh
TimeoutStartSec=20min

[Install]
WantedBy=multi-user.target
UNIT

  cat > /etc/systemd/system/ocd-render-agent.service <<UNIT
[Unit]
Description=Open Creative Director: render agent
After=network-online.target ocd-render-pair.service
Wants=network-online.target
# not after a failed first start; on a later boot the pairing unit is skipped by its condition, and that counts as done
Requires=ocd-render-pair.service
ConditionPathExists=${AGENT_DIR}/agent.json

[Service]
User=${AGENT_USER}
Group=${AGENT_USER}
WorkingDirectory=${AGENT_DIR}
Environment=HOME=${AGENT_HOME}
Environment=OCD_IMAGE_FILE=${LIB_DIR}/image.json
ExecStart=/usr/bin/node ${AGENT_DIR}/agent.js
Restart=on-failure
RestartSec=5
# 2: removed in the app (the server is being deleted), 3: another version is needed
RestartPreventExitStatus=2 3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable ocd-render-pair.service ocd-render-agent.service

  # SSH only with a key (the SSH key of the settings): Hetzner gives a server without a key a root password, and cloud-init
  # would allow it in 50-cloud-init.conf; sshd takes the first value it reads, so this file comes first
  if [ -d /etc/ssh/sshd_config.d ]; then
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/10-ocd-render.conf
    chmod 644 /etc/ssh/sshd_config.d/10-ocd-render.conf
  fi

  # 7. clean for the snapshot: no pairing, no token, no state of this server
  rm -f "${AGENT_DIR}/agent.json" "${AGENT_DIR}/agent.lock" /etc/ocd-render/pairing.env
  rm -rf "${AGENT_DIR}/agent-jobs"
  apt-get clean
  cloud-init clean --logs >/dev/null 2>&1 || true
  truncate -s 0 /etc/machine-id
  if [ -d /var/lib/dbus ]; then ln -sf /etc/machine-id /var/lib/dbus/machine-id; fi
  # onto the disk now: «Power off» in the Hetzner Console (or the API action poweroff) cuts the power, and files written in
  # the last seconds (the units, first-boot.sh) would be empty in the snapshot, which systemd reads as masked units
  sync

  say "Fertig. Jetzt hier im Server poweroff eingeben (nicht «Power off» in der Console, das schneidet den Strom ab), dann in der Hetzner Console einen Snapshot dieses Servers erstellen, den Server löschen und die Snapshot-ID in der App eintragen." \
      "Done. Now type poweroff here on the server (not «Power off» in the Console, which cuts the power), then take a snapshot of this server in the Hetzner Console, delete the server and enter the snapshot id in the app." \
      "Listo. Ahora escribe poweroff aquí en el servidor (no «Power off» en la Console, que corta la corriente), luego crea un snapshot de este servidor en la Hetzner Console, elimina el servidor y escribe el ID del snapshot en la app."
}

main "$@"
