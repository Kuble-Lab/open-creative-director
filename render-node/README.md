# Render node (motion graphics)

A small standalone service that renders HTML/GSAP compositions to MP4 for Open Creative Director's `render_motion_graphics` tool. Runs on the same machine as the app or on any other computer (Windows, macOS, Linux).

This folder serves two ways of rendering:

- **Render node (service, push).** `service.js` runs as a service; the app sends it jobs over HTTP (an address reachable from the app, often through an SSH tunnel). Set up by an admin: see *Setup* below.
- **Render agent (own computer, pull, WP46).** `agent.js` runs on a person's own computer, connects to the app itself over HTTPS and fetches the jobs it may render. Nobody needs to reach the computer. Set up by the person in the app: see *Agent mode* at the end.

## Requirements

- Node.js ≥ 22
- [hyperframes](https://www.npmjs.com/package/hyperframes) 0.8 (installed by `npm install`). On the first render it downloads the headless Chrome it needs (about 150 MB, into `.cache/hyperframes` in the home folder of the account the service runs as); to use an installed Chrome instead, set `HYPERFRAMES_BROWSER_PATH` in `service.env`
- `ffmpeg` on the PATH

## Setup

```bash
cd render-node
npm install
```

Create a `service.env` file next to `service.js`:

```env
PORT=4801
HOST=127.0.0.1
TOKEN=choose-a-long-random-token
```

Start it:

```bash
node service.js
```

Then register the node in the app under **⚙️ Settings → Render nodes** (URL `http://127.0.0.1:4801`, plus your token) — or via `RENDER_NODE_URL`/`RENDER_NODE_TOKEN` in the app's `.env`. For a node on another machine, keep `HOST=127.0.0.1` and connect it through an SSH tunnel rather than exposing the port.

For unattended operation, wrap `node service.js` in your platform's service manager (launchd, systemd, or a Windows Scheduled Task with a restart loop).

### Settings of the hyperframes CLI

The service starts `hyperframes render` with these defaults; a line in `service.env` changes any of them:

| Variable | Default | Why |
| --- | --- | --- |
| `PRODUCER_EXPERIMENTAL_FAST_CAPTURE` | `false` | hyperframes 0.8 turns an experimental frame capture on by default on macOS with a hardware GPU. In a test with 0.8.139 it timed out at the first frame of every scene instead of falling back; the screenshot capture rendered the same frames as 0.7, and faster. |
| `HYPERFRAMES_NO_UPDATE_CHECK`, `HYPERFRAMES_NO_AUTO_INSTALL` | `1` | A service neither checks for nor installs new versions on its own. |
| `HYPERFRAMES_NO_TELEMETRY` | `1` | No usage reports from a service. |

`HYPERFRAMES_SKIP_SKILLS=1` is always set: a render node installs no agent skills.

### Updating

Wait until `GET /health` shows `"queue":0,"running":false`, stop the service, run `npm install` in this folder and start the service again. The first render after an update downloads the browser version the new hyperframes needs, so it takes longer. To go back, install the old version (`npm install hyperframes@<version>`) and restart.

## Protocol

`GET /health` → `{ok, queue, running, streamingUploads}` (no auth). All other endpoints require `Authorization: Bearer <TOKEN>`: `POST /render` submits a job (HTML plus assets — inline base64 up to 24 MB, or staged via `POST /uploads` + `PUT /uploads/:id/:filename` streaming up to 500 MB total), `GET /jobs/:id` reports status, `GET /jobs/:id/file` returns the finished MP4. The app's dispatcher detects `streamingUploads` automatically and load-balances across multiple registered nodes.

## Agent mode (own computers, WP46)

In the app, **Menu → My computers → Create code** shows a code and a command. The command needs Node.js 22 or newer with npm; it fetches the package from the app with the code, writes it into `ocd-render-agent` in the home folder, pairs the computer, installs the dependencies and starts the agent:

```bash
curl -fsSL https://<app>/api/render-agent/install.sh | bash -s -- --server https://<app> --code XXXX-XXXX
```

```powershell
& ([scriptblock]::Create((irm 'https://<app>/api/render-agent/install.ps1'))) -Server 'https://<app>' -Code 'XXXX-XXXX'
```

Options of both installers: `--dir`/`-Dir` (another folder), `--name`/`-Name` (the name in the app), `--no-start`/`-NoStart`. The package is `setup.js` with these files embedded, each checked against its SHA-256: `agent.js`, `service.js` (the agent renders with its `defaultRenderExecutor`, the very function of the service), `template/hyperframes.json`, `README.md`, and `agent/package.json` with `agent/package-lock.json` as `package.json` and `package-lock.json`. `npm ci` installs HyperFrames at the exact version the app demands and, as optional dependencies, ffmpeg and ffprobe (`ffmpeg-static`, `@derhuerst/ffprobe-static`, GPL-3.0-or-later, downloaded from GitHub by their install scripts); if they cannot be installed, the agent uses `ffmpeg` and `ffprobe` from the PATH. `HYPERFRAMES_FFMPEG_PATH` and `HYPERFRAMES_FFPROBE_PATH` choose others.

In the folder of the agent:

| Command | What it does |
| --- | --- |
| `node agent.js` | Runs the agent in the foreground: connects, waits for jobs (long poll), renders one job at a time. Ctrl+C stops it and hands a running job back. |
| `node agent.js update` | Fetches the current package with the token of the computer (no new code) and installs it; only while the agent is stopped. |
| `node agent.js status` | Shows the app and the name the computer is paired with. |
| `node agent.js forget` | Deletes the token on this computer (remove the computer in the app as well). |
| `node agent.js pair --server <app> --code <code>` | Pairs again with a new code. |

Files: `agent.json` holds the address of the app and the token of the computer (mode 600; never printed); `agent.lock` keeps a second agent out of the same folder; a job is rendered in `agent-jobs/<job>/` and the folder is deleted afterwards. The agent prints one line per event (connected, rendering, done, failed, disconnected), in German, English or Spanish after the language of the system (`RENDER_AGENT_LANG=de|en|es` chooses). After network errors it tries again after 1, 2, 4 … up to 60 s. It stops when the computer was removed in the app (exit code 2) or when the app needs another version (exit code 3: run `node agent.js update`). On a Mac it keeps the computer awake while it renders (`caffeinate -i`); a closed MacBook lid still puts it to sleep, and on Windows and Linux nothing prevents sleep.

The agent only talks to the app it was paired with, over HTTPS (plain `http://` only for an address of the computer itself, or with `RENDER_AGENT_ALLOW_HTTP=1`). Before a page is rendered, the agent puts a Content-Security-Policy into it: scripts only from the page and from jsDelivr, unpkg and cdnjs; images, media, styles and fonts also from `https:`; no fetch, XHR, WebSocket or form to any other address. The browser of HyperFrames runs without a sandbox, so a computer renders only the jobs of its owner unless the owner shares it with their teams (or an admin shares their own for everybody).

To start the agent with the computer, wrap `node agent.js` in your platform's service manager (launchd, systemd, or a Windows Scheduled Task), as for the service.

The installers pair first, before `npm ci` and the browser, so the code (10 minutes) does not run out on a slow computer; the versions of ffmpeg reach the app with the first poll. `hyperframes browser ensure` stops after 4 minutes. On Linux `install.sh` stops before it uses the code when `unzip` is missing (the browser of HyperFrames needs it) and says how to install it. Pairing again into a folder whose `node_modules` came from the same lockfile leaves `npm ci` out (`node_modules/.ocd-lock-sha256`).

## Render servers in the cloud (WP54)

The app can rent render servers at Hetzner Cloud when jobs wait (see the README of the app, «Render-Server bei Hetzner»). The servers start from a snapshot that [`cloud-image.sh`](cloud-image.sh) prepares on a fresh Ubuntu 24.04 server (CPX42, as root):

```bash
curl -fsSL https://<app>/api/render-agent/cloud-image.sh | sudo bash -s -- --server https://<app> --code XXXX-XXXX
```

The code (from **My computers**, of an admin) is only used to fetch the package and is not used up. The script installs Node.js 22 from NodeSource, unzip, the libraries of Chrome and the fonts (fonts-liberation, fonts-noto-core, fonts-noto-color-emoji, fonts-dejavu-core), makes the system user `ocdrender` (home `/var/lib/ocdrender`; not `render`, a group of that name exists on Ubuntu), installs the agent into `/opt/ocd-render-agent` without pairing it (`setup.js --update`: `npm ci`, the browser, ffmpeg) and enables two units:

- `ocd-render-pair.service` (once, as root, while there is no `agent.json`): waits for `/etc/ocd-render/pairing.env`, which cloud-init writes from the `user_data` of the server (`OCD_SERVER`, `OCD_CODE`, `OCD_NAME`; read with sed, never run by a shell), fetches the current package with that code and runs `setup.js --server … --code … --no-start` as `ocdrender`, then deletes the file. `npm ci` runs only when the lockfile changed since the snapshot.
- `ocd-render-agent.service`: `node agent.js` as `ocdrender` once `agent.json` exists, and only when the first start succeeded (`Requires=ocd-render-pair.service`: the pairing comes before `npm ci`, so a failed first start leaves an `agent.json` behind; the app deletes such a server after 15 minutes, because its agent never asks for work); restarts on failure, but not after exit code 2 (removed in the app) or 3 (another version needed).

SSH accepts keys only (`/etc/ssh/sshd_config.d/10-ocd-render.conf`; Hetzner gives a server without a key a root password): to log in to a render server, enter the name of an SSH key of the Hetzner project in the settings. Then type `poweroff` on the server (not «Power off» in the Hetzner Console, which cuts the power: files written in the last seconds, such as the units, would be empty in the snapshot and systemd would treat the units as masked; the script ends with `sync` for that reason), take a snapshot, delete the server and enter the snapshot id in the app. The snapshot holds no token: every server pairs with its own code on its first start. Build a new snapshot when HyperFrames or Node.js change; an older one still works, it installs the new lockfile on every start (slower).
