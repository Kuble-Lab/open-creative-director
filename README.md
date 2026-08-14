# Open Creative Director

**Your personal AI creative director — a chat app that plans and produces images, videos, voice and motion graphics on your machine.**

Deutsche Version: [README.de.md](README.de.md)

You describe what you want in plain language ("a 15-second vertical ad for my coffee brand, warm morning light"). The Creative Director — an LLM running through [OpenRouter](https://openrouter.ai) — plans the production and executes it with real generation tools: images with **GPT Image 2**, video with **Seedance 2.5**, speech with **ElevenLabs**, 30+ extra models (Kling, Veo, Sora, …) through **Higgsfield**, and HTML/GSAP **motion graphics** rendered on your own machines. Results appear inline in the chat and are stored locally.

Inspired by the Higgsfield "Supercomputer" concept — rebuilt as an open, local-first app.

![Open Creative Director — chat with a generated hero image, cost badges and the Director's quality check](docs/screenshots/chat.png)

## Features

- **Chat-driven production** — the Director asks the right questions, then generates. Tool calling, live streaming, cost transparency per generation.
- **Images** — GPT Image 2 generation and editing, reference images, SVG rasterization.
- **Video** — Seedance 2.5 text-to-video and image-to-video (4–30 s). Voice/character consistency via image, video and audio references.
- **Speech** — ElevenLabs text-to-speech for voice-overs and voice masters (optional).
- **Higgsfield integration** — connect your higgsfield.ai account with one click (no API key needed) and the Director gains 30+ image/video models, billed as Higgsfield credits on your plan (optional).
- **Motion graphics** — HTML/GSAP compositions rendered to MP4 on one or more render nodes (16:9, 9:16, 1:1) (optional).
- **Casting** — reusable characters per project: reference images plus a voice master keep faces and voices consistent across episodes.
- **Branding studio** — colors, typography, logos, imagery, tone. Import a design system from a ZIP (e.g. exported from claude.ai/design), export as ZIP.
- **Projects with production profiles** — briefing guidelines, context files, brandings, cast and a per-project memory the Director maintains itself.
- **Roles** — custom system prompts per chat, with an AI role generator.
- **Prompt presets** — a curated, collapsible menu of production-ready prompts (casting, series, branding, motion, social media, marketing) plus your own team-shared presets.
- **Three languages** — UI in English, German and Spanish.
- **Cost journal** — every generation and LLM call is logged with its cost.

## Quick start

Requirements: [Node.js](https://nodejs.org) ≥ 22, an [OpenRouter](https://openrouter.ai) API key. Optional: `ffmpeg` on your PATH (enables automatic visual consistency checks on finished videos).

```bash
git clone https://github.com/Kuble-Lab/open-creative-director.git
cd open-creative-director
npm install
cp .env.example .env    # then put your OpenRouter key into .env
npm start               # → http://localhost:3111
```

That's it. Everything else is optional and degrades gracefully.

> Prefer to let an AI agent do the setup? Copy the prompt from [INSTALL-PROMPT.md](INSTALL-PROMPT.md) into Claude Code, Codex or any coding agent.

## Which keys do I need?

| Key / setting | Required? | What it enables | Where to get it |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | **Yes** | The Director LLM, GPT Image 2 images, Seedance 2.5 video — all billed through one OpenRouter account | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `ELEVENLABS_API_KEY` | Optional | Text-to-speech (`generate_speech`, voice list) | [elevenlabs.io](https://elevenlabs.io) |
| Higgsfield account | Optional | 30+ extra image/video models for the Director | No key — click **Connect** in ⚙️ Settings and confirm in the browser (device flow, tokens stay on your machine) |
| `RENDER_NODE_URL` + `RENDER_NODE_TOKEN` | Optional | HTML/GSAP motion-graphics rendering | Run your own render node (see below); multiple nodes manageable in ⚙️ Settings |
| `PUBLIC_BASE_URL` | Optional | Seedance audio/video references (they require publicly reachable HTTPS URLs) | Only needed when hosting publicly |
| `AUTH_WHOAMI_URL` + `ADMIN_EMAILS` | Optional | Multi-user mode behind your own auth proxy | Only for team hosting — locally the app runs open |
| `GTS_API_TOKEN` + `GTS_BASE_URL` | Optional | Attach knowledge-base documents as chat context | Any compatible GTS endpoint; the example default points to `gts.kuble.com` |

Keys can also be entered at runtime in **⚙️ Settings** (stored server-side in `data/settings.json`, chmod 600, never in the repo) — they override `.env` without a restart.

## How it works

```
Browser (vanilla JS, SSE)
   │
Node/Express server (server.js)
   │
   ├─ Director LLM ── OpenRouter chat completions with tool calling
   ├─ generate_image / edit_image ── GPT Image 2 via OpenRouter
   ├─ generate_video ── Seedance 2.5 via OpenRouter (async jobs + poller)
   ├─ generate_speech / list_voices ── ElevenLabs (optional)
   ├─ higgsfield_* ── Higgsfield MCP client, device-flow auth (optional)
   ├─ render_motion_graphics ── your HyperFrames render node(s) (optional)
   └─ Storage: sessions, assets, brandings, cast, projects — plain files under data/ and assets/
```

No database, no cloud storage: sessions, generated assets, brandings and settings are plain files on your disk. Delete the folder, everything is gone.

## Motion-graphics render node (optional)

The `render_motion_graphics` tool sends HTML/GSAP compositions to a small render service (Node + [hyperframes](https://www.npmjs.com/package/hyperframes) + Chrome + ffmpeg) that can run on the same machine or any other computer — reachable directly or through an SSH tunnel. Multiple nodes are load-balanced automatically (idle first, then shortest queue). Configure nodes in **⚙️ Settings → Render nodes**.

## Team mode (optional)

Out of the box the app is single-machine and open. There is no built-in admin account. To host it for a team, put it behind your own login (any auth proxy that can answer a whoami endpoint), set `AUTH_WHOAMI_URL`, and list admin emails in `ADMIN_EMAILS` — only those admins get the ⚙️ Settings (API keys, render nodes, admins, Higgsfield). Without `AUTH_WHOAMI_URL`, local access remains open. Costs are tracked per user.

## License

[MIT](LICENSE) © 2026 Kuble AG — built by the [Kuble](https://kuble.com) team with Claude Code and Codex.
