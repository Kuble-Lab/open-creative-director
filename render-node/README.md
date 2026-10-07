# Render node (motion graphics)

A small standalone service that renders HTML/GSAP compositions to MP4 for Open Creative Director's `render_motion_graphics` tool. Runs on the same machine as the app or on any other computer (Windows, macOS, Linux).

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
