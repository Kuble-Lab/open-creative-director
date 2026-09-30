# Open Creative Director

**Your personal AI creative director — a chat app that plans and produces images, videos, voice and motion graphics on your machine.**

Deutsche Version: [README.de.md](README.de.md)

You describe what you want in plain language ("a 15-second vertical ad for my coffee brand, warm morning light"). The Creative Director — an LLM running through [OpenRouter](https://openrouter.ai) — plans the production and executes it with real generation tools: images with **GPT Image 2**, video with **Seedance 2.5**, speech with **ElevenLabs**, 30+ extra models (Kling, Veo, Sora, …) through **Higgsfield**, and HTML/GSAP **motion graphics** rendered on your own machines. Results appear inline in the chat and are stored locally.

Inspired by the Higgsfield "Supercomputer" concept — rebuilt as an open, local-first app.

![Open Creative Director — chat with a generated hero image, cost badges and the Director's quality check](docs/screenshots/chat.png)

## Features

- **Chat-driven production** — the Director asks the right questions, then generates. Tool calling, live streaming, cost transparency per generation.
- **Images** — GPT Image 2 generation and editing, reference images, SVG rasterization.
- **Video** — Seedance 2.5 text-to-video and image-to-video (4–30 s). Voice/character consistency via image, video and audio references. Final cuts via `concat_videos`: ffmpeg joins finished clips losslessly, no size limit (needs `ffmpeg` on the PATH).
- **Live production status** — running jobs show up in a live status bar with elapsed time, the Director posts results and failures into the chat by itself, and the thinking indicator shows what is currently executing.
- **Speech** — ElevenLabs text-to-speech for voice-overs and voice masters (optional).
- **Higgsfield integration** — connect your higgsfield.ai account with one click (no API key needed) and the Director gains 30+ image/video models, billed as Higgsfield credits on your plan (optional).
- **Motion graphics** — HTML/GSAP compositions rendered to MP4 on one or more render nodes (16:9, 9:16, 1:1) (optional).
- **Node view** — build reusable production flows on a canvas (batch runs, eight templates), publish them as a clean Design App and send results back to a chat.
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
| `FAL_KEY` | Optional | fal.ai models in the node view: the MiniMax H3 Max nodes (text/image/reference video, lip sync, camera moves, extend, insert scene, 3D to video, styles) and a free-form fal.ai model node. Billed per second by fal.ai | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) |
| Higgsfield account | Optional | 30+ extra image/video models for the Director | No key — click **Connect** in ⚙️ Settings and sign in to Higgsfield in the browser (OAuth login, tokens stay on the server). Behind a reverse proxy set `PUBLIC_BASE_URL` so the browser can reach the callback |
| ChatGPT subscription | Optional | Run the Director on GPT-5.6 models billed to your ChatGPT Plus/Pro plan instead of per-token | No key — log in to the [Codex CLI](https://github.com/openai/codex) with "Sign in with ChatGPT", then click **Import from Codex CLI login** in ⚙️ Settings. Unofficial route via the Codex backend (gray area in OpenAI's terms) — use at your own discretion |
| `RENDER_NODE_URL` + `RENDER_NODE_TOKEN` | Optional | HTML/GSAP motion-graphics rendering | Run your own render node (see below); multiple nodes manageable in ⚙️ Settings |
| `PUBLIC_BASE_URL` | Optional | Seedance audio/video references (they require publicly reachable HTTPS URLs); also the base of the Higgsfield login callback (`<PUBLIC_BASE_URL>/api/higgsfield/oauth/callback`) | Only needed when hosting publicly or behind a reverse proxy |
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
   ├─ higgsfield_* ── Higgsfield MCP client, OAuth login in the browser (optional)
   ├─ render_motion_graphics ── your HyperFrames render node(s) (optional)
   └─ Storage: sessions, assets, brandings, cast, projects — plain files under data/ and assets/
```

No database, no cloud storage: sessions, generated assets, brandings and settings are plain files on your disk. Delete the folder, everything is gone.

## Node view (workflows and Design Apps)

![Open Creative Director — node view with the template Still to vertical ad with voice-over: inputs, an LLM description step, Seedance animation, voice-over and a result node on the canvas](docs/screenshots/nodes.png)

Besides the chat, **🧩 Nodes** in the sidebar opens a canvas for building reusable production flows. Nodes for inputs (text, text list, images, videos, audio), LLM steps, image/video/audio generation, ffmpeg editing and results are wired together; every workflow keeps its media in its own hidden session, so nothing shows up in your chat list.

- **Canvas** — left-drag on the empty canvas draws a selection marquee (Shift adds), the toolbar switches between *Select (V)* and *Hand (H)*; you can also pan with Space + drag, the middle mouse button or two fingers on a trackpad, and zoom with Ctrl/Cmd + wheel or a pinch toward the cursor. Undo/redo, copy/paste, groups and notes work as expected.
- **Runs** — a node, the selection or the whole flow runs on the server. Results are cached by their inputs, so unchanged nodes are skipped. Paid nodes are marked with `$`, the run dialog shows the last known cost, and a paid run always asks for confirmation.
- **Batch** — a *Text list* (one item per line, or blocks separated by `---`) or a *Media list* makes the flow run once per item (up to 50). The counter under the list shows how many items are used.
- **fal.ai (MiniMax H3 Max)** — with a `FAL_KEY` the *fal.ai* category offers nodes for every queue endpoint of MiniMax H3 Max (H3 Max video and Turbo, reference video, lip sync, camera move, extend video, insert scene, 3D to video, five styles) plus a free-form *fal.ai model* node for any other endpoint. Media are uploaded to the fal storage, the job runs in the fal queue and the result is fetched in the background, so you can leave the page. Costs are list-price estimates (fal.ai reports no price); the nodes are experimental until they have been tested live. The realtime *director* endpoint is not offered.
- **Prompt node** — *Prompt* (first entry of the *Inputs* category) is a dedicated node with a large text field for writing a prompt on the canvas; wire it into one or more generation nodes so the graph shows which prompt goes where. The embedded prompt fields still work: the small button in their corner (and the one next to the field in the inspector) moves the text into a new Prompt node left of the node and connects it (one undo step). Dragging a connection from a node and dropping it on the empty canvas opens a quick pick at that spot with only the nodes that fit (Prompt first for text inputs); Esc or a click beside it cancels.
- **Port help** — hover a port (dot or label, inputs and outputs) for about a third of a second to see what it expects or delivers: name, type, required or optional, a short description, how many connections it takes and in which order they count. Esc, a click, a drag, scrolling or zooming hides it.
- **Several references** — inputs with a double ring (for example *Images* of the H3 Max reference node, *References* of Seedance) take several connections, shown as `n/max` next to the label. Either wire several image nodes to the same input, or wire one *Media list* to it: a list on such an input delivers all its files at once, while a list on a single input runs the node once per item. Draw further connections from the output of each source to the same input (dragging from the input itself detaches its last connection). In prompts, the references count in the order of the connections (H3 Max reference video: "Image 1", "Image 2", "Video 1" …); a media list counts with all of its files and each file counts toward the maximum, so the numbers after a list shift and the hover help then no longer shows positions. Dragging from a multi-input onto the empty canvas offers the *Media list* and the matching single input node first.
- **Motion graphics from HTML** — the *Motion graphics from HTML (render node)* node renders finished HTML/GSAP code, not an instruction. Code comes from a *Motion HTML writer* node in front of it (describe the animation there; attach the same files to both nodes and refer to them as `{{asset:1}}`, `{{asset:2}}` …) or is pasted into the field. To join videos use *Concatenate videos* instead. If the field holds plain text ("make it one video") or HTML without the `data-width` / `data-height` of the chosen format, the node is marked incomplete before the run and says what to change; for plain text the button *Convert to HTML with AI* adds a Prompt node and a Motion HTML writer to the left (your text becomes the prompt, the format and the files are copied, the field is cleared, one undo step). Nothing runs until you start it; the writer is a paid node and asks for confirmation as usual.
- **Assets** — every image/video/audio input takes an upload, a file from one of your chats, or an asset already produced in this workflow.
- **Templates** — *New from template* offers eight ready flows: Product hero (4 variants), Still to vertical ad with voice-over, Consistent character series (batch), Continuous shots via last frame, Motion title over footage, Masked edit, Clip in three national languages (Higgsfield dubbing with lip sync) and Talking portrait (ElevenLabs voice plus H3 Max lip sync on fal.ai). Templates whose provider is not configured are shown as unavailable; their texts come in English, German and Spanish.
- **Design App** — switch on *Design App* in the top bar, expose parameters of your nodes (the small toggle next to a field) and pick the result nodes. `#app=<workflow id>` then shows a clean form with a *Run* button, live status, a result gallery, downloads and *Send to chat*. The form values only apply to that run; the saved workflow is not changed.
- **Chat bridge** — *Send to chat* copies results into a chat of your choice as a visible message with the media attached, so the Director can continue from there.
- **Projects** — assign a workflow to a project (the same folders your chats use); the project name shows in the workflow list. Workflows are visible to the whole team; deleting one also deletes its media (the app asks for confirmation first).

## Motion-graphics render node (optional)

The `render_motion_graphics` tool sends HTML/GSAP compositions to a small render service (Node + [hyperframes](https://www.npmjs.com/package/hyperframes) + Chrome + ffmpeg) that can run on the same machine or any other computer — reachable directly or through an SSH tunnel. The service ships in this repo under [`render-node/`](render-node/README.md). Multiple nodes are load-balanced automatically (idle first, then shortest queue), and imported media stream to the node in chunks (up to 500 MB per render). Configure nodes in **⚙️ Settings → Render nodes**.

## Team mode (optional)

Out of the box the app is single-machine and open. There is no built-in admin account. To host it for a team, put it behind your own login (any auth proxy that can answer a whoami endpoint), set `AUTH_WHOAMI_URL`, and list admin emails in `ADMIN_EMAILS` — only those admins get the ⚙️ Settings (API keys, render nodes, admins, Higgsfield). Without `AUTH_WHOAMI_URL`, local access remains open. Costs are tracked per user.

## License

[MIT](LICENSE) © 2026 Kuble AG — built by the [Kuble](https://kuble.com) team with Claude Code and Codex.
