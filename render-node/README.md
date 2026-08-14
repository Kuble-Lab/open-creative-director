# Render node (motion graphics)

A small standalone service that renders HTML/GSAP compositions to MP4 for Open Creative Director's `render_motion_graphics` tool. Runs on the same machine as the app or on any other computer (Windows, macOS, Linux).

## Requirements

- Node.js ≥ 22
- Google Chrome (headless rendering via [hyperframes](https://www.npmjs.com/package/hyperframes))
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

## Protocol

`GET /health` → `{ok, queue, running, streamingUploads}` (no auth). All other endpoints require `Authorization: Bearer <TOKEN>`: `POST /render` submits a job (HTML plus assets — inline base64 up to 24 MB, or staged via `POST /uploads` + `PUT /uploads/:id/:filename` streaming up to 500 MB total), `GET /jobs/:id` reports status, `GET /jobs/:id/file` returns the finished MP4. The app's dispatcher detects `streamingUploads` automatically and load-balances across multiple registered nodes.
