# Node View — Specification

Status: implemented v1 (2026-09-29) — see [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md) for as-built deviations · Scope: analysis, architecture and work packages (this is the original design; where it differs from the code, the notes and the code win).

Open Creative Director (Open CD) gets a second way to work next to the chat: a **node view** in the style of Weavy / Figma Weave. Users build visual pipelines on an infinite canvas (inputs → LLM → image → video → edit → output), run single nodes or whole graphs, compare variants, and publish a simplified **Design App** so teammates or clients only swap inputs.

The node view is a new *front end over the existing generation stack*. It does not add providers or a second implementation of any generation logic.

---

## 1. Goals and non-goals

### Goals

1. An infinite canvas with typed, colour-coded ports, a searchable palette, multi-select, copy/paste, undo/redo, notes, groups, minimap, autosave, workflow list, import/export and templates.
2. Server-side execution: topological order, dependency resolution, hash-based caching, run modes node / selection / all, cancel, bounded concurrency, live status via SSE.
3. Every node executor is a thin adapter over an **existing** function (`lib/tools.js` executors, `lib/ffmpeg.js`, OpenRouter / ChatGPT, Higgsfield MCP, render nodes, ElevenLabs, resvg). Results are ordinary session assets; costs go to the existing cost journal (`data/costs.jsonl`).
4. A declarative node registry (ports, parameter schema, cost hints, availability, executor) so that new nodes need little code. Higgsfield models show up dynamically.
5. Variants and per-node run history with version selection; previews for image, video, audio and text inside the node.
6. Design App mode, lists/batch, starter templates, and a bridge to the chat world (import assets from chats, send results to a chat).
7. No new dependencies, no build step, no framework. Vanilla JS in the browser, CommonJS on the server.

### Non-goals (v1)

- Real-time multi-user co-editing (presence, cursors, CRDT). v1 uses optimistic concurrency (`rev`) only.
- Public, unauthenticated share links for Design Apps.
- New AI providers or models beyond what Open CD already reaches (OpenRouter, ChatGPT subscription, Higgsfield MCP, ElevenLabs, render nodes, local ffmpeg/resvg).
- Pixel-accurate mask inpainting, segmentation of images ("select subject"; naming an object in a video is the fal node `fal.video_segment`, see §3.3), true relighting models, editing 3D models (a 3D result of fal.ai is only shown and downloaded, see §3.3).
- A Director tool that runs or authors workflows (planned for phase 2, see §17).
- Replacing the chat. The chat stays the default view.

---

## 2. Verified integration facts (what the design is built on)

| Fact | Where | Consequence |
| --- | --- | --- |
| Every tool executor has the signature `executor(ctx, args)` with `ctx = { sessionId, config, emit, user }` and returns `{ toolResult, inject, asset? , job? }`. | `lib/tools.js` → `executeTool(ctx, name, args)`, `EXECUTORS` | Node executors call `tools.executeTool` directly and read `outcome.asset` / `outcome.job`. `toolResult`/`inject` (Director text) are ignored. |
| All tools resolve inputs as **asset IDs inside `ctx.sessionId`** (`store.readLedger`, `store.assetDataUrl`, `sessionAssetDir`). | `referencesFromAssetIds`, `buildVideoPayload`, `renderAssetsFromIds`, `concatVideoSources` | Each workflow owns one hidden **backing session**. All workflow inputs/outputs live in its ledger. Assets from chats are *copied* in. |
| Assets: `store.saveAsset`, `store.reserveAsset` (pending), `store.completeAsset`, `store.completeAssetFile` (moves a file from inside the session asset dir). IDs `img-001`, `vid-001`, `aud-001`, `upload-001`. URL `/assets/<sessionId>/<file>` (static, immutable). | `lib/store.js` | Assets are immutable once complete → `sessionId/assetId` is a valid cache fingerprint. |
| Async jobs are appended to `session.jobs`; `lib/poller.js` polls every 6 s (`POLL_INTERVAL_MS`), completes the asset, sets `job.status` to `completed`/`failed`, Higgsfield sets `job.resultAssetIds`. The poller discovers jobs via `store.listSessions({ limit: Infinity })`. | `poller.pollOnce`, `handleCompleted`, `handleHiggsfieldCompleted`, `handleFailed` | The engine waits for a job by polling the backing session (`store.readSession`). Hiding workflow sessions from the chat list must be opt-in so the poller still sees them. |
| Provider jobs cannot be cancelled (no cancel call in `lib/openrouter.js`, `lib/rendernode.js`, Higgsfield usage). | — | "Cancel" stops waiting and skips pending nodes; already submitted jobs finish remotely and still cost money. The UI says so. |
| Sessions are **not user-scoped** today: every user sees every chat. `req.kubleUser` (whoami middleware) is only used for cost attribution and admin checks (`isAdmin`). | `lib/whoami.js`, `server.js` | Workflows follow the same model: team-visible, `createdBy`/`updatedBy` recorded, costs attributed to the running user. |
| SSE pattern: `res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'})`, frames `data: <json>\n\n`, keep-alive `: ping\n\n` every 15 s; compression skips `text/event-stream`. | `server.js` → `POST /api/sessions/:id/message` | Reused 1:1 for `GET /api/workflows/:id/events`. |
| Catch-all `app.get('*')` serves `index.html`. | end of `server.js` | Node routes must be registered **before** it. |
| Non-streaming LLM call: `or.postJson('/chat/completions', payload)`; cost from `completion.usage.cost`, journaled as `type: 'brain'`. ChatGPT subscription route: `chatgpt.streamResponses({ model, instructions, input: chatgpt.messagesToInput(messages), tools: [] })` → `{ text, toolCalls, usage }`, journaled with `cost: 0, billing: 'Abo'`. Vision support check: `discovery.brainSupportsImages(model)`. | `server.js` `/api/roles/generate`, `lib/brain.js` `recordBrainUsage`, `lib/chatgpt.js`, `lib/discovery.js` | LLM nodes get a small adapter `lib/nodes/llm.js`. An answer without text is billed by the provider all the same: the adapter books the reported cost (journal, budget key, the flat amount `unknownCostUsd` for a participant without a reported cost; also when a `chatgpt/` call was replaced by OpenRouter) and then throws "The model returned an empty answer (finish_reason …, … output tokens, … of them reasoning)" with `usd`, `finishReason`, `completionTokens`, `reasoningTokens` and `model` on the error. The subscription (cost 0) is as before. |
| Cost journal accepts types `image, video, motion, brain, higgsfield` only; unknown fields are dropped. | `lib/costs.js` `VALID_TYPES`, `normaliseEntry` | No journal change. Workflow costs are grouped by the backing session, whose title is `Workflow: <name>` so `/api/costs/summary` stays readable. |
| ffmpeg: `ffmpeg.binaries()` (`FFMPEG_PATH`/`FFPROBE_PATH` overrides), `probeVideo(file)` (also works on still images: ffprobe reports a video stream), `concatVideos`, `PROCESS_TIMEOUT_MS`. `runProcess` is **not exported** and has no abort signal. | `lib/ffmpeg.js` | WP4 exports `runProcess` and adds an optional `signal`. |
| Three frames of a video as JPEG buffers: `poller.extractVideoFrames(videoPath)` (10 %, 50 %, 95 %). | `lib/poller.js` | Reused by the Video Describer node. |
| SVG → PNG via `@resvg/resvg-js` inside `storeImportedSessionAsset` (not exported). | `lib/tools.js` | WP3 exports it; image inputs get automatic SVG rasterisation without duplicating code. |
| Seedance capabilities come from `discovery.videoCapabilities(model)`; fallback lists `frameImages: ['first_frame','last_frame']`, but `buildVideoPayload` only sends `first_frame`. | `lib/discovery.js`, `lib/tools.js` | Last-frame conditioning is "later". |
| Higgsfield: `higgsfield.mcpCall(tool, args)`, `higgsfield.status().connected`, `extractJobIds`, `parseJobStatus`. `models_explore` returns JSON with `id, name, parameters[{name, required, type, options, min, max, default}], medias[{roles, max}], aspect_ratios, durations, duration_range, credits_per_unit, credit_unit`. References need `PUBLIC_BASE_URL` (`publicrefs.publishAsset` → `media_import_url`). The MCP catalogue snapshot in `docs/higgsfield-tools.json` also lists `remove_background`, `upscale_image`, `upscale_video`, `outpaint_image`, `reframe`, `motion_control`, `voice_change`, `dubbing`, `generate_audio`, `generate_3d`. | `lib/higgsfield.js`, `lib/tools.js` `runHiggsfieldGeneration`, `importHiggsfieldReferences` | Higgsfield models become palette entries dynamically. The edit tools are wired as *experimental* nodes (see §5.8). `runHiggsfieldGeneration` only forwards `aspect_ratio`, `resolution`, `duration`, references — model-specific params need a small extension. |
| Frontend: one classic script `public/app.js` (global functions such as `openLightbox`, `rel`, `api`), `public/i18n.js` exposes `window.I18N`, `t()`, `applyI18n()`; `t()` resolves at call time, so dictionaries can be extended by later scripts. Hash routing `#s=<sessionId>` only (`sessionIdFromHash`, `hashchange` handler ignores other keys). Dark theme tokens on `:root` in `public/styles.css` (`--bg`, `--bg-panel`, `--bg-raised`, `--bg-input`, `--line`, `--line-soft`, `--text`, `--text-dim`, `--text-faint`, `--accent`, `--accent-soft`, `--danger`, `--radius`, `--radius-sm`, `--font`). Modals use z-index 60, the lightbox 50, sidebar popovers up to 45. | `public/*` | The node view is a separate set of scripts under `public/nodes/`, mounted as a full-window layer with its own hash keys `#w=` / `#app=`. |
| `scripts/test-i18n.js` requires every `data-i18n*` key in `index.html` to exist in `public/i18n.js` (de) and all three languages to have identical key sets without "ß". | `scripts/test-i18n.js` | The single sidebar button key lives in `public/i18n.js`; everything else lives in `public/nodes/i18n-nodes.js` with its own parity test. |
| Tests are plain Node scripts (`node scripts/test-*.js`), use `assert/strict`, monkey-patch module exports (`or.createImage = async () => …`), write to the real `data/`, `projects/`, `assets/` folders and clean up. Route tests call handlers via `app._router.stack` (`scripts/test-api-handlers.js`). | `scripts/` | Same pattern for all node tests. |

---

## 3. Weavy feature mapping (now vs. later)

"Now" means: buildable in this project with the existing stack in work packages WP1–WP7. "Later" names the reason and what it would need.

### 3.1 Canvas and editing

| Weavy feature | Status | Notes |
| --- | --- | --- |
| Infinite canvas, pan, zoom, fit-to-view | Now | CSS-transformed world layer, SVG edges (§12). |
| Minimap | Now | Small `<canvas>` drawing node rectangles; click/drag to navigate. |
| Searchable node palette (double-click, `Tab`, `/`), categories | Now | Registry-driven, fuzzy search over label, category, keywords, Higgsfield model names. |
| Typed, coloured ports with type checking | Now | §6. |
| Drag an edge into empty space → palette filtered to compatible nodes → auto-connect | Now | §12.4. |
| Multi-select, lasso, move, delete, duplicate, copy/paste (also across workflows) | Now | Clipboard JSON in `localStorage` + system clipboard. |
| Undo/redo | Now | Snapshot stack (§12.6). |
| Keyboard shortcuts | Now | §12.5. |
| Sticky notes, groups/frames | Now | Graph-level `notes[]` and `groups[]`. |
| Autosave | Now | Debounced `PUT` with optimistic `rev`. |
| Workflow list, rename, duplicate, delete | Now | Left drawer. |
| Import/export (JSON, ZIP) | Now | Versioned format §7. Export with the input files as a ZIP and its import: §7.6. |
| Templates | Now | Six starter workflows (§15). |
| Real-time collaboration, comments on canvas | Later | Needs presence channel, conflict-free merge, comment store. |

### 3.2 Execution

| Weavy feature | Status | Notes |
| --- | --- | --- |
| Run one node incl. required predecessors | Now | Mode `node`; predecessors reuse cache. |
| Run selection / whole workflow | Now | Modes `selection`, `all`. |
| Cancel | Now (partial) | Stops waiting and skips pending nodes. Already submitted provider jobs continue remotely and are billed (no cancel API in the stack). |
| Status per node (queued / running / waiting / cached / done / error / skipped / cancelled) | Now | SSE `node_status`. |
| Caching of unchanged results, dirty propagation | Now | Cache key §9.3, plan endpoint paints "stale" badges. |
| Previews inside the node (image, video, audio, 3D model, text) | Now | Native `<img>`, `<video>`, `<audio>`, text block; a 3D model (GLB) in the bundled `<model-viewer>` (below). |
| Multiple results/variants per run | Now | `count` param (1–4) on generative nodes; Higgsfield multi-result jobs become variants. |
| Run history per node, choose version | Now | `results.json`, max 30 entries per node. |
| Cache per list item, make single items again | Now (WP35) | A node that runs once per item keeps a key per item (§9.3); the mode `items` (§9.1) and the scene table of the inspector (§12.2) make chosen items again without paying for the others. |
| Cost display | Now (actual) / estimate partly | Actual USD from OpenRouter usage; Higgsfield shows credit estimate from `credits_per_unit`; GPT Image / Seedance have no price table in the code → estimate = last actual cost of that node type in this workflow, else "unknown". Pre-run confirmation lists paid nodes. |
| Download (single, ZIP of outputs) | Now | Asset URL with `download`; ZIP via `archiver`. |
| Seeds / deterministic re-runs | Later | Not exposed by the current OpenRouter/Seedance wrappers. |

### 3.3 Node families

| Weavy node family | Status | Backing / notes |
| --- | --- | --- |
| Inputs: text, number, image, video, audio, lists | Now | Upload into backing session, or copy from any chat session. |
| Any LLM | Now | OpenRouter models from `config.brainModels` + ChatGPT subscription models when connected. |
| Prompt enhancer, image describer, video describer, prompt concatenation/template | Now | LLM adapter; video describer uses `poller.extractVideoFrames` (visual only, no speech transcription). |
| Image generation (many models) | Now | GPT Image 2 (`generate_image`), all Higgsfield image models (dynamic). |
| Image editing with references | Now | GPT Image 2 edit (`edit_image`), Higgsfield models with references (needs `PUBLIC_BASE_URL`). |
| Video generation t2v / i2v | Now | Seedance 2.5 (`generate_video`), Higgsfield video models (Kling, Veo, Sora, …). |
| Motion graphics | Now | `render_motion_graphics` on render nodes; optional LLM "HTML writer" node. |
| Audio / TTS | Now | ElevenLabs (`generate_speech`). Higgsfield `generate_audio`, `voice_change`, `dubbing` → later. |
| Crop, resize, levels/colour, blur, sharpen, invert, flip/rotate | Now | ffmpeg filters (`crop`, `scale`, `eq`, `colorlevels`, `gblur`, `unsharp`, `negate`, `transpose`). |
| Compositing / layers | Now (parametric) | ffmpeg `overlay` + `blend`; one layer per node, chain for stacks. An interactive drag-and-drop layer editor is later. |
| Masks: apply mask, chroma-key mask | Now | ffmpeg `alphamerge`, `colorkey`. |
| Mask painting (brush) | Later | Needs an in-node paint editor producing a PNG mask (~medium UI work). Uploaded masks work now. |
| Inpainting (mask-constrained generation) | Later (approximation now) | OpenRouter `/images` payload in the code has no mask field; whether GPT Image 2 via OpenRouter accepts one is unverified (open question). Approximation now: `image.edit` on the whole image, then `image.mask_apply` + `image.composite` to paste only the masked region back onto the original (template "Masked edit"). Not pixel-stable if the model shifts geometry. |
| Relight | Now (approximate) | `image.relight` = GPT Image 2 edit with a lighting prompt preset. It regenerates the image; no dedicated relight model (IC-Light etc.) is reachable. |
| AI upscaling | Now (experimental) / non-AI now | Higgsfield `upscale_image` / `upscale_video` (requires Higgsfield + `PUBLIC_BASE_URL`, response format to be verified live). Non-AI Lanczos resize via ffmpeg now. |
| Background removal | Now (experimental) / chroma key now | Higgsfield `remove_background` (image and video, same preconditions). Chroma key for solid backgrounds via ffmpeg now. GPT Image transparent background via OpenRouter: unverified (open question). |
| Outpaint / reframe | Now (experimental) / approximate now | Higgsfield `outpaint_image`, `reframe` (video). Approximation: `image.pad` + `image.edit` "fill the empty border". |
| Frame extraction, trim, merge audio, concat, speed, extract audio, image-to-video (Ken Burns) | Now | ffmpeg; concat reuses `concat_videos`. |
| Segmentation / "select subject" masks | Now for video (experimental), later for images | Node `fal.video_segment` ("Segment video", fal.ai, SAM 3 on `fal-ai/sam-3/video`): `video` in (required), `video` out; params `object` (text, inline; commas for several objects), `output` (`cutout` = `apply_mask` true and `VP9 (.webm)`, a WebM with an alpha channel; `mask` = `apply_mask` false and `X264 (.mp4)`, black and white, the object white; `cutout_black` = `apply_mask` true and `X264 (.mp4)`, the object on black), `max_seconds` (integer 1–60, default 10), `threshold` (0.1–0.9, default 0.5 = `detection_threshold`); `point_prompts` and `box_prompts` are not used. The video is prepared with ffmpeg first (`lib/nodes/video-prep.js`): the first `max_seconds`, at most 30 frames per second (a lower rate stays), at most 1920 px on the long side, H.264 yuv420p, no sound; a video that fits (MP4/H.264 within all limits) goes up unchanged; without ffmpeg the node is unavailable (`ffmpeg/ffprobe not found`) and, if run anyway, stops (`SEGMENT_FFMPEG_MISSING`) before anything is uploaded or charged. Price: 0.005 USD per 16 frames of the input (fal pricing API, 2026-10-03), a started block counts as a whole; the run books `ceil(frames / 16) x 0.005` from the exact frame count (ffprobe `-count_frames`) of the file that is sent. The plan shows an upper bound, `ceil(min(duration, max_seconds) x 30 / 16) x 0.005`, with `duration` of the connected video where the plan knows it (`ctx.inputs` of the estimate, §9.4) and `max_seconds` otherwise; `cost.history` is off. Upload: a prepared file is no ledger asset (it would show up in the workflow), so the node uploads it itself with `fal.uploadFile` from a scratch folder of its own session and passes the address as `input.video_url`; it repeats the checks `fal_generate` makes for an upload (this workflow's session, extension in `FAL_UPLOAD_MIME`, size limit, key, cancellation) and deletes the folder in a `finally`. A video that needed no preparation is passed as a normal `media` entry. Result: `application/octet-stream` named `output.mp4` / `output.webm`; the poller names the stored file by its first bytes (`videoExtensionOf` in `lib/poller.js`: EBML `1A 45 DF A3` = `.webm`, an `ftyp` box = `.mp4`) and never re-encodes it, so the alpha of the WebM stays. Chrome and Firefox show that alpha, Safari does not (the preview says so there, §5.7a). ffmpeg reads the alpha channel of VP8 / VP9 only with the decoder `libvpx-vp9` / `libvpx`; `runOp` names it before `-i` (§5.7a, WP33b), so the ops that reshape exactly one video keep the transparency and write WebM (list in §5.7a), and the other ffmpeg nodes write MP4 without it. Open to participants like the other fal nodes. |
| Video over video, cutout over a background | Now | Node `video.overlay_video` (§5.7) lays a layer video (alpha used where there is one, or a chroma key) over a background video; template `video-cutout-overlay` (§15) chains it behind `fal.video_segment`. |
| Edit an existing video with reference images | Now (experimental) | Node `fal.video_edit` ("Edit video with references", fal.ai; WP40): inputs `video` (required), `images` (multiple, at most 4) and `prompt` (text, inline param `prompt`), output `video` (as long as the input video). Param `model`: `kling_o3` (default; `fal-ai/kling-video/o3/{standard,pro,4k}/video-to-video/edit` by `quality`; input `{ prompt, video_url, keep_audio, elements \| image_urls }`, `elements` = one `{ frontal_image_url, reference_image_urls: [the same image] }` per image for `image_role: elements` (default), `image_urls` for `style`), `wan_replace` (`fal-ai/wan/v2.2-14b/animate/replace`; `{ video_url, image_url, resolution }`, exactly 1 image, no prompt: the field is hidden and a connected text only warns) and `gemini_omni` (`google/gemini-omni-flash/v1.1/edit`; exactly `{ video_url, prompt, resolution }`, no images, no switch for the sound). Params: `quality` (standard, pro, 4k), `image_role` (elements, style), `keep_audio` (default true; Kling only), `resolution` (360p, 720p default, 1080p, 4k; Gemini Omni), `wan_resolution` (480p default, 580p, 720p), `cut_to_limit` (default false). The prompt is written in the language of the person: "Bild N" / "Image N" / "Imagen N" (any case) become `@ElementN` (role `elements`) or `@ImageN` (role `style`), "Video" / "Vídeo" (a capital V anywhere, any case after an article such as "the", "el", "del", "im"; "Video 1" at the end of a phrase; not "video game" or "Video-Ende") becomes `@Video1`; a number beyond the connected images is refused; Gemini Omni sends the prompt as it is. Checks before the run, each an error with a stable code (`VIDEO_EDIT_*`, translated, with the remedy; `validate` reports the ones that need only the connections): Kling O3 3 to 15 s, MP4 or MOV, 720 to 3840 px on both sides, at most 200 MB (and the upload limit of 90 MB), at most 4 images, people/objects at least 300 x 300 px, a prompt; Gemini Omni 1 to 10 s, no images, a prompt; Wan Replace exactly 1 image. `cut_to_limit` cuts a video that is too long to the limit of the model (first 15 s / 10 s, with sound, re-encoded to an MP4 in a scratch folder of the session and uploaded by the node, like the prepared video of `fal.video_segment`). Price per second of the video that is sent (`PRICES.videoEdit`, list prices of 2026-10-04): Kling 0.14 (standard, pro) / 0.42 (4k), Wan 0.08, Gemini Omni 0.03 / 0.10 / 0.15 / 0.30 by `resolution`; the plan multiplies it by the known length (`cost.estimate(params, ctx)` with `ctx.inputs.video`, `history: false`), or shows the upper bound of the model where the length is not known (Kling 15.05 s, Gemini 10.05 s; Wan: unknown); the run needs the length (`VIDEO_EDIT_LENGTH_UNKNOWN` without it; `available` asks for ffmpeg and ffprobe) and books that estimate (`pricing: null`). Not `fal.h3_reference`, which makes a new clip. Open to participants. |
| Lip sync, motion transfer, voice change | Later | Higgsfield `dubbing`, `motion_control`, `voice_change` exist in the catalogue; wire after the experimental edit nodes are verified. |
| 3D | Now (SAM 3D experimental) | Port type `model3d` (GLB only, compatible with itself and `any`) and the node `fal.image_to_3d` ("Image to 3D", fal.ai: Tripo H3.1, Hunyuan 3D Pro 3.1, Meshy 7.1, SAM 3D Objects): front image plus optional left / back / right views (limits per model), outputs `model` (`model3d`) and `preview` (an image of the model: the render of the provider, else, for SAM 3D or when that render cannot be fetched, one the app draws from the stored GLB in a child process, `lib/glb-preview.js`: PNG with a transparent background, seen from the front like the first view of `<model-viewer>`, fitted into the square; textures through ffmpeg or the built-in PNG reader). The node is no longer marked experimental (all four models ran live on 2026-10-03); SAM 3D stays marked in the model list. The viewer is `<model-viewer>`, shipped in `public/vendor/model-viewer/` (no CDN, no `package.json` entry) and loaded the first time a model is shown; a normal GLB makes no request to another address. A connection from an output a node never fills with its options is refused before the run with the code `OUTPUT_EMPTY` (a node def lists such outputs in `emptyOutputs(params)`; no node does today); the run reports the same code if an optional output turns out empty, for example the preview of a model the app cannot draw (the model itself stays, a render that fails never fails the job). A result is stored only as a GLB without external files (`MESH_FILE_NOT_GLB`, `MESH_FILE_EXTERNAL`, `MESH_NO_GLB`, `MESH_SPLAT_ONLY`). A model cannot be sent to the chat (the preview image can); the ZIP of the outputs contains it. Higgsfield `generate_3d` is not wired. |
| Music video from a song | Now | Template `music-video` (§15) on four nodes: `audio.beats` and `audio.lyrics_timing` (§5.6), `music_video.plan` and `music_video.edit` (§5.9). The song is analysed (tempo, beats, sections), ElevenLabs gives the times of the sung lines, the cuts are computed from both, a language model writes a prompt per scene, the images come from `image.edit`, the story clips from `fal.h3_video` (H3 Max turbo: Seedance refuses images that may show a real person) and the singer clips from `fal.h3_lipsync`, and the clips are cut to the beat with the song underneath. The cut can burn the lyrics in as karaoke captions (`captions`, §5.9), the template ships them on. The cheaper template `music-video-stills` (§15) makes the story scenes with the local zoom `image.to_video` instead of `fal.h3_video`: only the images and the lip sync are paid. |
| Captions, sound wave | Now | `video.captions` ("Burn in captions") burns the sung words into a video as karaoke, single words or lines, from the lyric times of `audio.lyrics_timing`; `video.soundwave` ("Sound wave") lays a moving wave (`showwaves`, or the spectrum as bars) over a video. Both local and free (§5.7, §5.10). Captions need an ffmpeg with libass. Chinese and Japanese are wrapped between characters with the rules of kinsoku, Hebrew and Arabic stay in logical order (karaoke is replaced by single words there), and a missing font is named in the log (§5.10). |
| Explainer video | Now | Templates `explainer-video`, `explainer-video-topic` and `explainer-video-presenter` (§15) on `explainer.plan` (§5.11) and the three nodes of §5.12: `explainer.voice` (ElevenLabs with word times), `explainer.scene` (Claude Opus 5.5 writes one motion-graphics scene on the cues of the voice, the render node draws it, two frames are checked, a retry continues the conversation, a fixed fallback ends it) and `explainer.edit` (local ffmpeg: voices on exact frames, crossfade, music with ducking, captions, SRT). Run only the planner first, edit the script, then run everything. The style Typography (WP40, `visual_mode: typography`, Inter Tight as the default font, templates `typography-video` and `typography-video-text`, the input `own_text` of the planner) is described in §5.12. |
| Output / export | Now | `output.result` node: marks app outputs, download, ZIP, send to chat. |

### 3.4 Design App, batch, chat

| Feature | Status | Notes |
| --- | --- | --- |
| Design App (exposed inputs/params, run button, outputs) | Now | `#app=<id>` view (§14). Same login as the main app. Public links later. |
| Lists / batch (series production) | Now | Implicit map over list inputs (§9.6), list inputs in the app. Cartesian products / nested iterators later. |
| Use chat/project assets as inputs | Now | Asset picker copies into the backing session. |
| Send results to a chat | Now | Copies asset into the chat session and appends a visible user message with `uploadIds`. |
| Cast / Branding input nodes | Later | Feasible (`cast.listMembers`, `cast.readMemberAsset`, `brandings`) but out of v1 scope. |
| Director tool `run_workflow` / "create workflow from chat" | Later | Needs stable app schemas, async result delivery into the chat turn and a cost-confirmation step. The engine API is designed for it (§17). |

---

## 4. Architecture overview

```
Browser
  public/app.js (chat, unchanged)          public/nodes/*.js (node view, new)
        │                                           │  REST + SSE (EventSource)
Node/Express server.js ── registerNodeRoutes(app, deps)   (lib/nodes/routes.js)
        │
        ├─ lib/nodes/workflows-store.js   workflow.json / results.json / runs/*.json
        ├─ lib/nodes/engine.js            plan, topo sort, cache, pool, cancel, events
        ├─ lib/nodes/events.js            per-workflow EventEmitter bus → SSE
        ├─ lib/nodes/registry.js          node types (declarative) + availability
        │     ├─ nodes-basic.js           inputs, text, utility, output
        │     ├─ nodes-generate.js        LLM, GPT Image 2, Seedance, Higgsfield, ElevenLabs, render node
        │     └─ nodes-edit.js            ffmpeg / resvg editing
        ├─ lib/nodes/llm.js               OpenRouter / ChatGPT text completion adapter
        ├─ lib/nodes/higgsfield-catalog.js models_explore cache → dynamic params
        ├─ lib/nodes/ffmpeg-ops.js        pure ffmpeg argument builders
        ├─ lib/nodes/assets.js            value <-> ledger helpers, copy/import, save output file
        └─ lib/nodes/jobs.js              waitForSessionJob (reads session.jobs written by poller)
              │
              ▼   existing, reused
        lib/tools.js executeTool · lib/store.js · lib/poller.js · lib/ffmpeg.js · lib/openrouter.js
        lib/chatgpt.js · lib/higgsfield.js · lib/elevenlabs.js · lib/rendernode.js · lib/costs.js
```

Key decision: **one hidden backing session per workflow.** It makes every existing tool work unchanged (they only know `ctx.sessionId`), lets the existing poller finish async jobs, keeps assets in the existing `assets/<sessionId>/` layout and groups costs per workflow in the existing cost summary. The alternative (teaching every tool a new asset namespace) would touch all executors.

---

## 5. Node type catalogue

Notation: ports `id:type` (`[]` = list, `*` = accepts multiple edges, `?` = optional). Params list `id (kind, default)`. "Backing" names the existing file and function the executor adapts. Cost: `usd` = actual cost journaled from provider usage; `credits` = Higgsfield credits (journal records 0); `local` = no provider cost; `free` = a provider is called but charges nothing (`audio.music_plan`).

Availability predicates reuse existing checks: `or.hasKey()`, `elevenlabs.hasKey()`, `higgsfield.status().connected`, `rendernode.enabled()`, `ffmpeg.binaries().available`, `publicBaseUrl()` (from `lib/config.js`), `chatgpt.status().connected`.

### 5.1 Inputs (WP1)

| ID | Ports in → out | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `input.text` | → `text:text` | `text` (textarea, "") | none | – |
| `input.number` | → `value:number` | `value` (number, 0), `min`, `max`, `step` | none | – |
| `input.text_list` | → `items:text[]` | `text` (textarea; one item per line, or blocks separated by a line `---`), `max` (integer, 50) | none | – |
| `input.image` | → `image:image` | `asset` (asset picker: upload / from chat) | upload route + `lib/nodes/assets.js` (`store.saveAsset` / `reserveAsset`+`completeAssetFile`); SVG uploads are rasterised via `tools.storeImportedSessionAsset` (exported in WP3; until then SVG upload is rejected) | – |
| `input.video` | → `video:video` | `asset` | same | – |
| `input.audio` | → `audio:audio` | `asset` | same | – |
| `input.media_list` | → `items:image[]` (param `kind` switches to `video[]`/`audio[]`) | `kind` (select image/video/audio), `assets` (multi picker, max 50) | same | – |
| `input.document` | → `documents:document[]` | `assets` (multi picker, accept `document`, max 10): PDF, TXT, MD | upload route + `assets.saveUploadFile`, which checks the content (`documents.checkDocumentFile`: at most 50 MB, a PDF starts with `%PDF-`, a text file is UTF-8; the page count of a PDF is stored in the ledger when `pdfinfo` is there). MCP `upload_asset` takes the same files | – |

### 5.2 Text and utility (WP1)

| ID | Ports | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `text.template` | `a?:text`, `b?:text`, `c?:text`, `d?:text`, `e?:text` → `text:text` | `template` (textarea, `"{{a}} {{b}}"`) | pure; unknown placeholders stay literal; numbers are stringified | – |
| `text.join` | `items*:text` (or `text[]`) → `text:text` | `separator` (text, `"\n"`) | pure | – |
| `text.split` | `text:text` → `items:text[]` | `separator` (text, newline), `trim` (bool, true), `max` (int, 50) | pure | – |
| `util.pick` | `items:any[]` → `item:any` | `index` (int, 0; negative counts from the end) | pure | – |
| `util.router` | `inputs*:any` → `out:any` | `index` (int, 0) | pure (Weavy "router/switch") | – |
| `output.result` | `inputs*:any` → (none) | `label` (text) | pure; marks outputs for app mode, ZIP download, send-to-chat | – |

Notes and groups are not nodes; they are `graph.notes[]` / `graph.groups[]` (§7).

### 5.3 LLM (WP3)

| ID | Ports | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `llm.chat` | `prompt?:text` (→ param), `system?:text`, `images*?:image` (max 8) → `text:text` | `model` (select, options source `brain-models`, default `config.defaultBrain`), `system` (textarea), `prompt` (textarea), `temperature` (number 0–2, blank = provider default; ignored on ChatGPT route), `max_tokens` (int, blank), `json` (bool → `response_format: {type:'json_object'}` with 400-fallback exactly like `/api/roles/generate`), `count` (1–4) | `lib/nodes/llm.js completeText()` → `or.postJson('/chat/completions')` or `chatgpt.streamResponses` for `chatgpt/*`; images as data URLs via `store.assetDataUrl`; rejects images when `discovery.brainSupportsImages(model)` is false | usd (`type:'brain'`), Abo = 0 |
| `llm.prompt_enhancer` | `prompt:text`, `images*?:image` → `text:text` | `model`, `target` (select image/video/speech/motion), `notes` (textarea) | `llm.chat` with fixed system prompt: rewrite into one production-ready **English** prompt (tools require English prompts), no preamble | usd |
| `llm.image_describer` | `image:image` → `text:text` | `model`, `focus` (select: full / subject / style / composition), `language` (select en/de/es, default en) | `llm.js` + `store.assetDataUrl` | usd |
| `llm.video_describer` | `video:video` → `text:text` | `model`, `focus` | `poller.extractVideoFrames(path)` (3 JPEG frames) + `llm.js`. Requires ffmpeg. Visual only. | usd |
| `llm.motion_html` | `brief:text`, `assets*?:image\|video` (max 10) → `html:text` | `model`, `format` (landscape/portrait/square), `duration` (int s, 6) | `llm.js`; system prompt = the description of `RENDER_MOTION_GRAPHICS_DEFINITION` (exported from `lib/tools.js` in WP3) plus the asset filename list | usd |

### 5.4 Image generation (WP3)

| ID | Ports | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `image.generate` | `prompt?:text` → `image:image` | `model` (select, options source `image-models`, default `''` = `config.imageModel`), `prompt` (textarea), `aspect_ratio` (select `IMAGE_RATIOS`, "1:1"), `count` (1–4) | `tools.executeTool(ctx,'generate_image',{prompt, aspect_ratio})` with a copy of the tool context whose `config.imageModel` is the chosen model (WP28, `lib/image-models.js`); a model outside `config.imageModels` fails with `IMAGE_MODEL_NOT_ALLOWED` | usd (journaled by `storeImageResult`); estimate per model (list price where known, else the last cost of this model, else unknown; `cost.history:false`), handed to the tool as `toolCtx.imageEstimateUsd` for the budget |
| `image.edit` | `prompt?:text`, `images*:image` (1–8, limit follows `model`: `limitBy {param:model, capability:references}`) → `image:image` | `model` (select, options source `image-edit-models`), `prompt`, `aspect_ratio` (select incl. `auto` = omit), `count` | `executeTool('edit_image', {prompt, reference_asset_ids, aspect_ratio?})` | usd |
| `image.relight` | `image:image`, `notes?:text` → `image:image` | `light` (select: golden hour, soft studio, hard noon sun, overcast, neon night, candle, custom), `custom` (text), `strength` (select subtle/strong), `count` | `edit_image` with a prompt preset ("Relight this exact scene… keep composition, identity and all objects unchanged") | usd |
| `image.higgsfield` | `prompt?:text`, `refs*?:image` (max = model `medias[].max`, ≤12) → `image:image` | `model` (select, options source `higgsfield-image-models`), `prompt`, `aspect_ratio` (from model), `resolution` (from model), dynamic model params (§10.2) | `executeTool('higgsfield_generate_image', {model, prompt, aspect_ratio, resolution, reference_asset_ids, extra_params})` → job → `waitForSessionJob`; all `resultAssetIds` become variants | credits (estimate from `credits_per_unit`) |
| `image.svg_rasterize` | `svg:text` → `image:image` | `width` (int, 1024) | `@resvg/resvg-js` exactly as in `storeImportedSessionAsset` | local |
| `image.text_render` | `text?:text` → `image:image` (transparent PNG) | `text`, `font_family` (text, "Helvetica"), `font_size` (int 96), `font_weight` (select 400/600/800), `color` (colour), `width`/`height` (int), `align` (select), `line_height` | builds an SVG and rasterises it with resvg (system fonts). Used for titles in compositing. | local |

### 5.5 Video generation (WP3)

| ID | Ports | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `video.seedance` | `prompt?:text`, `first_frame?:image`, `refs*?:image` (≤30), `ref_videos*?:video` (≤10), `ref_audios*?:audio` (≤10) → `video:video` | `prompt`, `duration` (int 4–30, 5), `aspect_ratio` (select `VIDEO_RATIOS`, t2v only; hidden when `first_frame` is connected), `resolution` (480p/720p) | `executeTool('generate_video', {prompt, mode, first_frame_asset_id, reference_asset_ids, reference_video_asset_ids, reference_audio_asset_ids, duration_seconds, aspect_ratio, resolution})`; mode = `image_to_video` iff `first_frame` connected; wait job. Video/audio references require `PUBLIC_BASE_URL` (tool throws otherwise; node shows it as a validation warning before run). | usd (journaled by poller) |
| `video.generate` | `prompt?:text`, `first_frame?:image`, `last_frame*?:image` (≤1, limit follows `model`: `limitBy {param:model, capability:last_frame}`, 0 = takes no connection), `refs*?:image` (≤30, `references`), `ref_videos*?:video` (≤10, `videos`), `ref_audios*?:audio` (≤10, `audio`) → `video:video` | `model` (select, options source `video-models`, default `''` = `config.videoModel`), `prompt`, `duration` (int 1–30, 5), `aspect_ratio` (t2v only), `resolution` (select `auto`/480p/720p/1080p) | `executeTool('generate_video', …)` with the tool context of the chosen model (`config.videoModel`, `videoOption`, `videoEstimateUsd`); `last_frame_asset_id` is accepted in the node view only; wait job. The models are those of the chat picker (configured model + curated list, `lib/video-node-models.js`); duration and resolution are the ones the model really offers (`effectiveDuration`, `effectiveResolution`), a model that does not offer them refuses the node. | usd (journaled by poller); plan = upper end of the chat estimate (`priceEstimate`), unknown = null |
| `video.higgsfield` | `prompt?:text`, `refs*?:image` (≤12) → `video:video` | `model` (options source `higgsfield-video-models`), `prompt`, `aspect_ratio`, `duration`, `resolution`, dynamic params | `executeTool('higgsfield_generate_video', …)` + wait | credits |
| `video.motion_graphics` | `html?:text`, `assets*?:image\|video\|audio` (≤10) → `video:video` | `html` (code), `format` (landscape/portrait/square), `quality` (draft/standard/high), `label` (text) | `executeTool('render_motion_graphics', {html, label, quality, format, asset_ids})` + wait. Placeholders `{{asset:1}}…{{asset:10}}` in the HTML are replaced with the filenames `<assetId><ext>` that `renderAssetsFromIds` copies beside `index.html`. | local |
| `video.concat` | `clips*:video` (2–20, edge order = playback order) or `clips:video[]` → `video:video` | `label` | `executeTool('concat_videos', {asset_ids, label})` (sync) | local |

### 5.6 Audio (WP3)

| ID | Ports | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `audio.tts` | `text?:text`, `voice?:text` → `audio:audio` | `text` (≤2500 chars), `voice_id` (options source `elevenlabs-voices`, default `21m00Tcm4TlvDq8ikWAM`), `model_id` (select, options source `elevenlabs-tts-models`, default `eleven_v4`, no "default" entry in the list; the value is never checked against the list, so a workflow saved with another model runs with it) | `executeTool('generate_speech', {text, voice_id, model_id})`. The voice is the input `voice` (WP38f: the speaker voice of a branding) when it is connected and not empty, else `voice_id` (`chooseSpeechVoice` in `nodes-generate.js`; a restricted account may only use library voices, else `voice_id` counts and the log says so); the input has no `param`, so an unconnected node has the same cache key as before and an empty output simply falls back to the parameter. A model that ElevenLabs refuses (unknown, not for speech, not open to the account) ends the node with `ELEVENLABS_MODEL_REJECTED` (`data.model`) | usd (paid: estimate by character and model, `ELEVENLABS_USD_PER_1K_CHARS` is the price of a full-price model, the Turbo and Flash models count half; unknown while the text comes through a connection) |
| `audio.music` | `prompt?:text`, `plan?:text`, `match?:video` → `audio:audio` | `prompt` (text), `plan` (text, song text with structure), `length` (3–600 s, default 30), `instrumental` (off), `model` (`music_v2_5` default, `music_v2`, `music_v1`) | `executeTool('generate_music', {prompt, length_seconds, instrumental, model_id})` or `{plan_text, model_id}`. A plan (field or connection) wins: the length comes from its sections, the description, `length`, `instrumental` and `match` have no effect (warning `MUSIC_PLAN_WINS`). For `music_v2` and `music_v2_5` a named section has at most 29 song lines (the `[Name]` line counts as one of the 30 of a chunk text) and a nameless section must not start with a `[` line. The wait for a song is 90 s plus its length, at most 300 s (fetch of Node ends a request without an answer after 300 s by itself); longer waits end with `ELEVENLABS_TIMEOUT`. Without a plan `match` sets the length (ffprobe, rounded up, 3–600 s). | usd (paid: estimate by the minute, `ELEVENLABS_MUSIC_USD_PER_MIN` default 0.20; unknown while plan or video come through a connection) |
| `audio.music_plan` | `prompt:text` → `plan:text` | `prompt`, `length` (3–600 s, default 60), `model` | `executeTool('plan_music', {prompt, length_seconds, model_id})`; the answer is turned into the readable plan text (`public/nodes/music-plan.js`) | `free` (ElevenLabs is called, no credits; not `local`) |
| `audio.beats` | `audio:audio`, `plan?:text` → `analysis:text`, `bpm:number` | none | `lib/music-analysis.js analyseFile()` (no library): ffmpeg decodes to mono 22.05 kHz PCM; onset envelope from log-compressed band spectra (FFT 512, hop 256); tempo by autocorrelation (60–180 BPM, prior around 100 BPM or the hint of a song plan, such as «82 BPM»); beats by dynamic programming after Ellis (2007); BPM from the slope of the beats; sections from a song plan (its lengths, each boundary moved to the nearest change in the sound) or from jumps in loudness and timbre (3 to 10 parts, «Teil 1» …). At most 20 minutes (longer files are cut), at least half a second (`BEATS_AUDIO_TOO_SHORT`). `analysis` is JSON `{ version, duration, bpm, tempoConfidence, beats[], sections[{ name, start, end }], energy[], sectionSource, warnings[] }`; `warnings` (`NO_PULSE`, `PLAN_LENGTH_MISMATCH`) are also written to the node log. | local (`ffmpeg`) |
| `audio.lyrics_timing` | `audio:audio`, `lyrics?:text` (param `lyrics`) → `timing:text`, `lyrics:text` | `lyrics` (textarea), `method` (`auto` default, `align`, `transcribe`) | `executeTool('lyrics_timing', { audio_asset_id, text, method, duration_seconds })`: a tool of the node view only (`NODE_ONLY_TOOLS`, in `PAID_TOOLS`, so a participant's budget is asked first). `auto` aligns when the text has sung lines (`lyricsTiming.sungLines`: `[Section]` lines, `(not sung)` lines and the `+` / `-` style lines of a song plan drop out), else it recognises the words. Align: `elevenlabs.forcedAlignment` (`POST /v1/forced-alignment`); transcribe: `elevenlabs.speechToText` (Scribe with word times, the lines are made from the pauses). `lib/lyrics-timing.js` cleans what comes back: the entries for blanks and line breaks, a first word that reaches from the intro, held notes (a line ends `MAX_LINE_HOLD_SEC` = 2 s after its last word began), words of the text that were not heard (they get an estimated time). `timing` is JSON `{ version: 1, source: 'align' \| 'transcribe', duration, words[{ text, start, end, line }], lines[{ text, start, end }], … }`, `lyrics` the readable lines `m:ss.s–m:ss.s text`. mp3, wav, m4a or aac, at most 20 minutes and 150 MB; the length is measured with ffprobe, the figure of the caller is not believed. Codes: `TIMING_NO_LYRICS` (method `align` without text, also a validation error of the node), `TIMING_AUDIO_TOO_LONG` (`{ minutes }`), `TIMING_BAD_ARGUMENT`. | usd: `tools.lyricsTimingUsd(seconds)` = hours × `ELEVENLABS_TIMING_USD_PER_HOUR` (default 0.22, the list price of speech to text with Scribe v2; the alignment costs the same). `cost.history: false`; the plan prices the node only when the song reaches it with a `duration` (`context.inputs.audio`: a song from `audio.music` or any node that ran before has one, an uploaded file does not), otherwise it is an unknown step; the tool itself reserves ten minutes when the length is unknown, never more than 20. Booked by the measured length as type `speech`, model `elevenlabs/forced-alignment` or `elevenlabs/<speech to text model>`, billing «Schaetzung (Dauer)», for everybody |

### 5.7 Editing — local ffmpeg / resvg (WP4)

All require `ffmpeg.binaries().available`. Image ops output PNG (alpha preserved), video ops output MP4 (H.264 `yuv420p` + AAC, `-movflags +faststart`; the ops that keep an alpha channel output WebM, §5.7a), audio ops output M4A (AAC). Every op runs through `ffmpeg.runProcess` with `timeoutMs = ffmpeg.PROCESS_TIMEOUT_MS` and the run's abort `signal`, in a scratch dir `fsp.mkdtemp(path.join(store.sessionAssetDir(sessionId), '.nodes-'))`, then `store.reserveAsset` + `store.completeAssetFile` (same pattern as `runConcatVideos`). Argument builders are pure functions in `lib/nodes/ffmpeg-ops.js`.

| ID | Ports | Params | ffmpeg |
| --- | --- | --- | --- |
| `image.crop` | `image` → `image` | `mode` (pixels / aspect), `x`,`y`,`width`,`height`, `aspect` (select), `anchor` (center, top, …) | `crop=w:h:x:y` |
| `image.resize` | `image` → `image` | `width`,`height` (0 = keep ratio), `fit` (contain/cover/stretch), `background` (colour or transparent for contain) | `scale=…:flags=lanczos` (+`pad` / `crop`) |
| `image.adjust` | `image` → `image` | `brightness` (−1..1, 0), `contrast` (0..3, 1), `saturation` (0..3, 1), `gamma` (0.1..3, 1), `hue` (−180..180, 0) | `eq=…`, `hue=h=…` |
| `image.levels` | `image` → `image` | `in_black`,`in_white`,`out_black`,`out_white` (0..1) | `colorlevels` |
| `image.blur` | `image` → `image` | `radius` (0..50, 8) | `gblur=sigma=…` |
| `image.sharpen` | `image` → `image` | `amount` (0..3, 1) | `unsharp=5:5:amount` |
| `image.invert` | `image` → `image` | `alpha` (bool, false) | `negate` |
| `image.transform` | `image` → `image` | `flip` (none/h/v/both), `rotate` (0/90/180/270) | `hflip`,`vflip`,`transpose` |
| `image.pad` | `image` → `image` | `aspect` or `width`/`height`, `color` / transparent, `position` | `pad` |
| `image.composite` | `background:image`, `layer:image`, `mask?:image` → `image` | `x`,`y` (px or %), `scale` (%), `opacity` (0..1), `blend` (normal/multiply/screen/overlay/darken/lighten) | `overlay` (+`colorchannelmixer=aa=` for opacity, `blend=all_mode=` for modes, `alphamerge` with mask) |
| `image.mask_apply` | `image`, `mask:image` → `image` (RGBA) | `invert` (bool), `feather` (px) | `alphamerge` (+`gblur` on mask) |
| `image.chroma_key` | `image` → `image` (RGBA), `mask:image` | `color` (colour, #00ff00), `similarity` (0.01..1), `blend` | `colorkey` / `chromakey`, `alphaextract` for the mask output |
| `image.to_video` | `image`, `audio?:audio`, `depth?:image`, `duration?:number` → `video` | `duration` (s, 5; a connected `duration` port wins), `match_audio` (bool: use the audio length from `probeMedia`), `fps` (30), `zoom` (`none`, `in`, `out`, `pan_left`, `pan_right`, `pan_up`, `pan_down`, `alternate`, `varied`, `parallax_left`, `parallax_right`, `parallax_in`; `zoompan`, §5.10), `parallax_strength` (0–100 %, 30) | `-loop 1`, `zoompan`, for the parallax `geq` + `displace`, optional audio mux (`-shortest`) |
| `video.extract_frame` | `video` → `image` | `position` (first / middle / last / time), `time` (s) | `-ss` + `-frames:v 1` PNG (last = duration − 1 frame via `probeVideo`) |
| `video.trim` | `video` → `video` | `start`, `end` (s), `accurate` (bool, true = re-encode) | `-ss/-to` |
| `video.resize` | `video` → `video` | `width`,`height`,`fit` | `scale`/`pad`/`crop` |
| `video.adjust` | `video` → `video` | as `image.adjust` | `eq`, `hue` |
| `video.speed` | `video` → `video` | `factor` (0.25..4) | `setpts`, chained `atempo` |
| `video.overlay_image` | `video`, `image` → `video` | `x`,`y`,`scale`,`opacity`, `start`,`end` (s) | `overlay=enable='between(t,…)'` |
| `video.overlay_video` | `background:video` (required), `layer:video` (required) → `video` (MP4) | `x`,`y` (px or %, default 50 % centred), `unit` (px / percent, percent), `anchor` (top-left / center, center), `scale` (% of the width of the background, 100), `opacity` (0..1, 1), `start` (s, 0: the second of the background at which the layer appears), `end` (s, 0 = until its own end), `loop_layer` (bool, false), `length` (`background` default / `layer` / `shortest`), `audio` (`background` default / `layer` / `mix` / `none`), `key` (`none` default / `chroma`), `key_color` (#00ff00), `key_similarity` (0.01..1, 0.3), `key_blend` (0..1, 0.1) | layer `[format=rgba,colorkey=…,]scale=W:H,format=yuva420p[,colorchannelmixer=aa=…],setpts=PTS-STARTPTS+start/TB`; `overlay=x:y:eof_action=repeat[:shortest=1][:enable='between(t,start,end)' or 'lt(t,own end)']:format=auto`; `tpad=stop_mode=clone` when the result is longer than the background; sound `apad`, `adelay`, `atrim`, `amix`; the result is cut by `-t` |
| `video.merge_audio` | `video`, `audio` → `video` | `mode` (replace / mix), `audio_volume`, `video_volume`, `length` (shortest / video) | `-map`, `amix`, `volume`, `apad` |
| `video.grid` | `videos*:video` (2–4), `labels?:text` → `video` | `layout` (auto / side_by_side / stacked / grid; auto = side by side, 2 × 2 for four), `length` (longest: shorter videos keep their last frame / shortest), `audio` (none / first_video), `labels` (one line per video; a connected text wins), `label_position` (bottom / top), `font_size` (0 = automatic), `match` (auto / height / width), `size` (px, 0 = the smallest video), `gap` (px), `background` | `color` source + `overlay` per video (`eof_action=repeat`), `scale` with the ratio kept, `apad`; labels are pills drawn with resvg like `image.text_render`. Local, no cost |
| `video.captions` | `video:video` (required), `timing:text` (required) → `video` | `style` (`karaoke` default, `words`, `lines`), `position` (`bottom` default, `middle`, `top`), `text_size` (number, 0–15 % of the picture height, 0 = automatic), `color` (#ffffff), `highlight_color` (#ffd400), `outline_color` (#000000), `outline` (0–25 % of the text size, 8), `font` (`dejavu-sans` default, `dejavu-serif`, `liberation-sans`, `liberation-serif`, `noto-sans`, `noto-serif`), `uppercase` (bool), `offset` (−600..600 s) | the script is made by `captionsLib.buildAss()` (§5.10) for the size and the length of the video, written into the scratch dir of the run and drawn by `ass=filename=…` (libass); the picture is encoded again, the sound is copied where it is AAC or MP3. A timing without lines leaves nothing to draw: the video passes through. `available()` is `libassAvailable()` (the node is listed as unavailable without libass, reason `ffmpeg has no libass (filter "ass")`), `validate` and the run refuse with `CAPTIONS_NO_LIBASS` (validate error, so the engine does not start the run); an unreadable timing is `CAPTIONS_TIMING_INVALID`. |
| `video.soundwave` | `video:video` (required), `audio?:audio` → `video` | `mode` (`cline` default, `line`, `p2p`, `point`, `bars`), `position` (`bottom` default, `middle`, `top`), `height` (slider 2–100 % of the picture height, 20; as wide as the picture), `color` (#ffffff), `opacity` (0–1, 1) | `showwaves=s=WxH:mode=…:scale=sqrt:draw=full` (or `showfreqs=…:mode=bar` for `bars`) on the mono sound of the audio input or of the video, `overlay` on the picture (`eof_action=pass`, so it ends with the video). A video without sound needs the audio input, which then also becomes the sound of the result (`apad` and `-shortest`); a video with sound keeps it (copied where it is AAC or MP3). |
| `video.extract_audio` | `video` → `audio` | – | `-vn -c:a aac` |
| `audio.trim` | `audio` → `audio` | `start`,`end`,`fade_in`,`fade_out` | `atrim`, `afade` |
| `audio.mix` | `tracks*:audio` (2–8) → `audio` | `volumes` (list), `length` (longest/shortest/first) | `amix`, `volume` |
| `media.info` | `media:any` → `duration:number`, `width:number`, `height:number` | – | `ffmpeg.probeVideo` for video/image; for audio a new tiny `probeMedia` (same ffprobe call, tolerant of missing video stream) in `lib/nodes/ffmpeg-ops.js` |

### 5.7a Transparency through the ffmpeg nodes (WP33b)

`fal.video_segment` with `output: cutout` gives a WebM (VP9) with an alpha channel, and `video.overlay_video` is made to lay it over another video. For the transparency to survive the nodes in between, the ffmpeg layer follows these rules (code: `lib/ffmpeg.js`, `lib/nodes/ffmpeg-ops.js`, `runOp` and `applyAlpha` in `lib/nodes/nodes-edit.js`).

- **Detection.** `probeMedia` (and `ffmpeg.normaliseProbe`) return `video.alpha`: `true` for VP8 or VP9 with the stream tag `alpha_mode` = `1` (the key is read in any case: ffprobe writes `ALPHA_MODE` for some files), for a pixel format that starts with `yuva`, `rgba`, `bgra`, `argb`, `abgr`, `ya8`, `ya16` or `gbrap` (this includes ProRes 4444 with alpha, `yuva444p*`), `false` otherwise (`pal8` and every format without an alpha plane included). The pixel format of the native VP9 decoder is `yuv420p` even for a WebM with alpha: only the tag tells.
- **Decoder.** `ffmpeg.hasDecoder(name)` and `ffmpeg.hasEncoder(name)` read `ffmpeg -decoders` / `-encoders` once per binary, like `hasFilter`. `ffmpeg.alphaDecoderOptions(video)` gives `['-c:v', 'libvpx-vp9']` (VP9) or `['-c:v', 'libvpx']` (VP8) for a stream with alpha and nothing for any other stream (ProRes, PNG and the rest read their alpha with the native decoder). `applyAlpha` puts the option in front of the other options of that input. When the decoder is missing the alpha cannot be read: the node logs `The transparency is lost: …`, writes MP4 and goes on. The plans that run their own processes (`execute`: the cut of the music video and of the explainer video) get no decoder option; they write MP4.
- **Ops that keep alpha** (`ops.ALPHA_KEEPING_OPS`): `video.trim`, `video.speed`, `video.resize`, `video.adjust`, `video.concat` (when every clip has alpha). Their builders mark the output `alpha: true` when the input has alpha; `applyAlpha` turns the mark into `container: 'webm'` when `ffmpeg.alphaVideoAvailable()` (the encoders `libvpx-vp9` and `libopus`), else the output is an MP4 and the node logs the line above. File name and ledger extension follow the real format (`ops.outputExt(output)`). The WebM is written with `-c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 32 -row-mt 1 -deadline good -cpu-used 4` and `-c:a libopus -b:a 128k` (`-an` without sound; no `-movflags`). Details per op: the trim is always re-encoded with alpha (`accurate: false` would copy into a container that cannot hold it); `video.resize` pads transparently with alpha (`pad=…:color=black@0`, whatever `background` says); `eq`, `hue` and `setpts` pass the alpha plane through; `video.concat` (tool `concat_videos`, `lib/tools.js`) decodes every clip with `libvpx-vp9`, puts it on a transparent canvas of the size and rate of the first clip, joins the clips with `concat` and writes the WebM (`ffmpeg.alphaConcatArgs`); with clips of which not all have alpha the result is an MP4 as before, and with all of them but without the encoders the tool answers `alphaLost` and the node logs the line.
- **Ops that write MP4** (the transparency is gone, no log line): `image.to_video` (no video input), `video.overlay_image`, `video.overlay_video`, `video.merge_audio`, `video.captions`, `video.soundwave`, `video.grid`, `explainer.edit`, `music_video.edit`. `video.extract_frame` writes a PNG, which keeps the alpha (the decoder option applies).
- **Unchanged without alpha.** An op whose inputs have no alpha gets exactly the arguments the builder makes, as before WP33b: `applyAlpha` does not touch a spec without an alpha input (`scripts/support/video-op-args-before-wp33b.json` holds arguments written by the code of the day before; a test compares them).
- **Marking and preview.** A result with alpha is marked in the ledger entry (`alpha: true`, `extra.alpha` of `store.completeAssetFile`) and its value carries `alpha: true`: for the results of the ops above (the output probe), for the concatenation and for a stored WebM result of fal (`webmHasAlpha` in `lib/poller.js` probes only `.webm`; a failing probe means no mark). The node view puts the class `nv-alpha` on the video (card, large view, thumbnail, app view): a chequerboard of two dark greys behind it (`--nv-checker-a/b`; the interface has only a dark theme; the selectors `.nv-thumb.nv-alpha` and `.nv-appleaf-frame .nv-media.nv-alpha` are as specific as the rules that give those two places their own background). In Safari and in every browser on an iPhone or iPad (all WebKit; an iPad that says it is a Mac is recognised by its touch points), which play the WebM without the transparency, the card, the large view and the app view show the line `nodes.preview.alphaSafari`. Images and uploads are marked since WP33c (the next paragraph).

**Marking in the store, images and uploads (WP33c).** Every file that `store.saveAsset`, `completeAsset` or `completeAssetFile` writes is looked at once (`lib/alpha.js`, after the session lock is released): a PNG or WebP image whose header says it has an alpha channel (PNG colour type 4 or 6 or a `tRNS` chunk before the data; WebP `VP8X` alpha flag or the alpha bit of `VP8L`) is checked with ffmpeg for a pixel that is not opaque (`format=rgba,alphaextract,signalstats`, the lowest alpha must be below 255, 15 s at most), because many generators write RGBA PNGs without any transparency; without ffmpeg, or without those two filters, the header decides, and an ffmpeg that fails gives no mark. A WebM, MKV or MOV video goes through ffprobe and `streamHasAlpha`. MP4, JPEG, GIF and everything else is not looked at (no read, no process). A caller that has already looked passes `extra.alpha` (`true` or `false`; `saveOutputFile` takes `alpha` the same way), the ffmpeg ops, `concat_videos` and the poller do; a copy between sessions keeps a mark. Existing assets are not marked (no migration); a failure never stops the saving. The node view shows the chequerboard behind such images and videos in the card, the thumbnail, the large view, the app view, the asset field of a node and the asset picker; it sits behind the picture itself (the media element takes the shape of its picture, so the margins that `object-fit: contain` leaves in a bigger frame stay plain). The Safari note stays with videos. Edge cases of the overlay nodes: a background with an odd width or height gets `pad=ceil(iw/2)*2:ceil(ih/2)*2` after the last overlay (`video.overlay_image` and `video.overlay_video`; transparent where the background has alpha), because libx264 stops on an odd size, and with even sizes the arguments are unchanged; `video.overlay_video` writes a log line when `start` is at or after the end of the background and `length` is `background` or `shortest` (the layer would never be seen).

`video.overlay_video` in detail. Background and layer are probed; the length of the result is `seconds`: `background` = the length of the background, `layer` = until the layer is gone (`start` + its length, or `end` when that comes first; a looped layer without `end` has no end of its own and the background decides), `shortest` = the shorter of that and the background. The result is cut by `-t seconds`; a background that is shorter than that holds its last frame (`tpad=stop_mode=clone`), its sound is padded with silence (`apad`). The layer is scaled to `scale` % of the width of the background (even sides, its ratio kept), turned into `yuva420p`, given its opacity (`colorchannelmixer=aa=`) and shifted to `start` (`setpts=PTS-STARTPTS+start/TB`); with `key: chroma` it is first turned into `rgba` and `colorkey` takes the colour out. It is laid with `overlay=eof_action=repeat` and an `enable` that ends it at `end` or at the end of its own run; `eof_action=pass` would drop the last frame too early. `loop_layer` loops the input (`-stream_loop -1`) and adds `shortest=1`, so the end of the background ends the result. Sound: `background` (padded), `layer` (cut at `end`, delayed by `start`, padded), `mix` (`amix=duration=longest:normalize=0` and a limiter, both padded: amix would halve each track, also where the other one is silent, so the background keeps its level; `video.merge_audio` keeps the default of before) or `none` (`-an`); a track that is not there is left out and a line in the log says so (`The layer has no sound`, `The background video has no sound`).

### 5.8 Higgsfield edit tools — experimental (WP3, sub-step)

Shown only when Higgsfield is connected **and** `PUBLIC_BASE_URL` is set (sources are published via `publicrefs.publishAsset` and imported with `media_import_url`, identical to `importHiggsfieldReferences`). Schemas come from `docs/higgsfield-tools.json`; the response shape (job id) is assumed to match generation (`higgsfield.extractJobIds`) and **must be verified once live by the user** (costs credits). Palette label carries an "experimental" badge.

| ID | Ports | Params | MCP tool | Output kind |
| --- | --- | --- | --- | --- |
| `hf.remove_background` | `media:image\|video` → same type | – | `remove_background {media_id, media_type}` | image/video |
| `hf.upscale_image` | `image` → `image` | `resolution` (2k/4k) | `upscale_image {image_id, width, height, resolution}` (width/height via `probeVideo`) | image |
| `hf.upscale_video` | `video` → `video` | `provider` (topaz/bytedance), `resolution` | `upscale_video` | video |
| `hf.outpaint_image` | `image` → `image` | `aspect_ratio` | `outpaint_image {image_id, aspect_ratio}` | image |
| `hf.reframe_video` | `video` → `video` | `aspect_ratio`, `resolution` | `reframe {aspect_ratio, medias:[{value, role:'video'}], …}` | video |

Implementation: a generic `runHiggsfieldEdit(ctx, { tool, params, sourceAssetIds, kind })` in `lib/tools.js`, sharing the job persistence with `runHiggsfieldGeneration` (extract a private helper `submitHiggsfieldJob`). It is added to `EXECUTORS` as `higgsfield_edit` but **not** to `toolDefinitions()` — the Director does not see it. The existing poller completes these jobs unchanged (they carry `provider: 'higgsfield'`, `kind`).

---

### 5.9 Music video (WP34)

Four nodes and one template (§15) turn a song into a music video cut to the beat. `audio.beats` and `audio.lyrics_timing` are in §5.6. The song-specific work sits in pure modules that are tested on their own (`lib/music-analysis.js`, `lib/lyrics-timing.js`, `lib/music-video-plan.js`, `lib/music-video-edit.js`); `lib/nodes/nodes-music-video.js` is only the adapter between them and the engine (inputs, files, costs, error codes). The lists between the nodes follow the scenes, one entry per scene of their kind, and a list may be empty (§9.6).

| ID | Ports | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `music_video.plan` | `analysis:text` (required), `timing?:text`, `brief:text` (required, param `brief`), `characters?:text` (param `characters`), `song:audio` (required) → `shots:text`, `story_prompts:text[]`, `story_motion:text[]`, `performance_prompts:text[]`, `performance_audio:audio[]` | `model` (as the LLM nodes), `brief`, `characters`, `style` (textareas), `shots_per_minute` (slider 6–30, 14), `performance_share` (slider 0–1, step 0.05, 0.3), `cut_on` (`lines` default, `beats`, `sections`), `clip_seconds` (integer 2–10, 5), `aspect_ratio` (`16:9` default, `9:16`, `1:1`) | `planLib.planScenes()` makes the cuts deterministically (a model writes words, not seconds): contiguous scenes from 0 to the end of the song, each 1.5 s up to `clip_seconds` (longer where 50 scenes would otherwise not cover the song), at most 50 (`MAX_SCENES`, the limit of a list); the edges of the singer windows and the section boundaries are always cuts, with `cut_on: lines` the start of every lyric line is one too, and the other cuts are spaced evenly and moved to the nearest beat (not with `sections`). The scenes for the singer are windows of sung lines of 5 to 10 s (`PERFORMANCE_MIN_SEC` 5.05, because the lip sync takes 5 s at least; `PERFORMANCE_MAX_SEC` 10), at least 70 % sung, taken from the chorus and the loud parts and spread over the song: `max(1, round(share × scenes))`, none when there are no lines or the share is 0. One request to the model for all scenes (`json: true`, `planLib.systemPrompt()`, the brief, style, characters and one row per scene); the answer is checked scene by scene (`readContent`), a second request names what was wrong (scenes left out, a story scene without a motion), what is still missing gets plain prompts from brief and lyric line (`fallbackContent`); a failed second request keeps the first answer, an abort is passed on. The slice of the song of each singer scene is cut exactly (ffmpeg, WAV, to the sample, `editLib.sliceAudioArgs`) and stored as an audio asset with its duration. `shots` is JSON `{ version, duration, bpm, aspect_ratio, cut_on, brief, story, performance, shots[{ index, start, end, duration, kind: 'story' \| 'performance', clip, section, line, prompt, motion, character }] }`; `clip` is the position in the list of its kind. The four lists keep the order of the scenes of their kind, and are empty (not missing) when there is no such scene. Warnings (log and `MUSICVIDEO_NO_TIMING` validation warning): no lyric times → cut on the beats, no singer scene. Codes: `MUSICVIDEO_ANALYSIS_INVALID`. | usd (the tokens of the model; no estimate: `cost.unit: 'usd'` without `estimate`, the plan shows the last cost of the node) |
| `music_video.edit` | `song:audio` (required), `shots:text` (required), `story*:video` (required, ≤50), `performance*?:video` (≤50), `captions?:text` (the lyric times) → `video:video` | `transition` (`cut` default, `crossfade`, `flash`), `resolution` (`720p` default, `1080p`: the short side), `fps` (`24`, `25` default, `30`), `fit` (`crop` default, `pad`), `fade_out` (0–10 s, 1), `captions` (`off` default, `karaoke`, `words`, `lines`), `captions_position` (`bottom` default, `middle`, `top`; shown when `captions` is on) | `editLib.buildEditPlan()` through `runOp()` of `nodes-edit.js` (scratch dir, abort signal; `lib/music-video-render.js` starts the ffmpeg processes). The number of clips must equal the plan: `MUSICVIDEO_STORY_MISMATCH` and `MUSICVIDEO_PERFORMANCE_MISMATCH` (`{ expected, got }`) are thrown before anything is cut, an unreadable plan is `MUSICVIDEO_SHOTS_INVALID`. Every scene gets exactly its frames (the boundaries are rounded to frames once and a scene is the difference of two boundaries, so nothing drifts against the song); a story clip longer than its scene is cut off, a slightly shorter one is slowed down (to 0.8 at most, `MIN_SPEED`), what is still missing holds the last frame; the clip of the singer is never slowed down (it would lose the lips), it starts with its scene, where its song slice starts, and is cut off or held. The song lies underneath from the start of the first to the end of the last scene, with a fade-out. `crossfade`: the next scene fades in over the first 0.25 s of its time and the previous clip runs on under it, so the boundary stays on the beat; `flash`: the next scene comes in from white (0.15 s). The format comes from the plan (`aspect_ratio`) and `resolution`. Memory: every scene is a filter chain with a decoder of its own, so one process needs memory in proportion to its scenes (50 test clips of 5 s in one process: 1.4 GB at 720p and 1.8 GB at 1080p, the encoder on three threads as on two CPUs). Up to `BATCH_SCENES` (3) scenes one process makes the film; more scenes are cut in batches, so that no process opens more than three clips (three scenes, or under a crossfade two scenes and the clip before them): one process per batch, one after the other, writes its finished frames raw to a pipe, and a single encoder process takes them, fades out, lays the song underneath and encodes the film once (no intermediate files, no second encoding). The same 50 clips then need 0.35 to 0.4 GB at 720p and 0.6 to 0.75 GB at 1080p (all processes together), in about the same time (a cut as long as in one process, a crossfade 7 to 12 % longer). A batch that delivers other than exactly the bytes of its frames stops the job (raw frames carry no times, a missing frame would shift everything after it); an abort or a time-out ends every process. Under a crossfade the first scene of a batch fades in from the end of the scene before it, which a second decoder of that clip delivers through the same chain, so the film is frame for frame the one a single process makes. Captions (WP35): with `captions` not `off` and the lyric times connected, `editLib.captionScript()` makes the script for the size and the length of the film (`captionsLib.buildAss()`, §5.10) with the times of the song moved by the start of the film (`bounds[0] / fps`); it is written into the scratch dir and drawn by the ENCODER only (`ass=filename=…` in `endOfGraph`, before the fade-out): once, also when the scenes are cut in batches (the batch processes make raw frames only). A song without words (timing without lines) makes no script and no filter; libass is only needed when there is something to draw, but `validate` asks for it as soon as `captions` is on (`CAPTIONS_NO_LIBASS`, an error, so the run is refused before anything is paid), with the warning `MUSICVIDEO_NO_CAPTIONS_TIMING` when no times are connected, and the run throws `CAPTIONS_TIMING_INVALID` for times it cannot read. |

### 5.10 Captions and sound wave (WP35)

`lib/captions-ass.js` is a pure module (no ffmpeg, no files): `buildAss({ timing, width, height, style, position, sizePercent, color, highlightColor, outlineColor, outlinePercent, font, uppercase, offset, leadIn, hold, maxChars, duration })` returns `{ text, events, lines, fontSize, maxChars, options }`. `readTiming()` reads the JSON of `audio.lyrics_timing` (`lines[{ text, start, end, words?[{ text, start, end }] }]`; words without lines are made into lines). The script is written for libass: `PlayResX/PlayResY` are the size of the video (so a size in pixels is a size in the picture), `YCbCr Matrix: None`, `WrapStyle: 0` with explicit `\N` rows (a line is wrapped by a balanced division at `maxChars`, which follows from the width and the font size; a line of one word is never split). The font size is a share of the picture height (`text_size`, automatic 6 %, times `min(1, width / height)` so that a portrait video does not get text wider than itself); the outline is a share of the font size. Karaoke is `\kf` in hundredths of a second: SecondaryColour is the unsung, PrimaryColour the sung colour, a gap between words is `{\k<gap>\kf<length>}` in one block (libass adds them up; checked against libass 0.17.3), a word fills until the start of the next one, the last word until the end of its line; a line without word times gets evenly spread ones. A line is shown from 0.4 s before its first word until 0.4 s after its last one (`LEAD_IN_SEC`, `HOLD_SEC`), lines that follow each other closely share the time between them instead of overlapping (so one row of text never stands over another). `{ } \` and line breaks of the text are escaped (`\{`, `\}`, `\N`; ASS has no escape for the backslash, so it becomes the look-alike U+2216). Times are `H:MM:SS.cc`, colours `&HAABBGGRR` (alpha inverted).

`assFilter(file)` is `ass=filename=<file>` with the two levels of escaping of a filter graph (option value: `\ ' :`, graph: `\ ' [ ] , ; =`); the same escaping is tested without libass by reading a file back with `movie=filename=`. `lib/ffmpeg.js` reads `ffmpeg -hide_banner -filters` once (`listFilters()`, cached per binary; `hasFilter(name)`; `resetFilterCache()` for tests) and the nodes ask `hasFilter('ass')`: a minimal or static build often has no libass (the ffmpeg of the development machine had none), the ffmpeg of a distribution has it. The picture needs a font that fontconfig finds (`fonts-dejavu-core` for the default); the six fonts are DejaVu, Liberation and Noto in Sans and Serif.

`video.soundwave` (`ffmpeg-ops.js buildSoundwave()`) needs no libass: the wave is a video made by `showwaves` or `showfreqs` and laid on the picture with `overlay`.

**Scripts other than Latin (WP35, rest).** A row is limited in *columns*: a wide or fullwidth character (Chinese, Japanese, fullwidth forms, Hangul syllables) counts 2, a combining mark 0 (`columns()`); an automatic limit counts a column as wide as an average Latin letter, so a line that is mostly wide characters gets 1.36 times as many columns as it would with Latin letters (an explicit `maxChars` is a limit in columns and is not scaled). A word without spaces (Chinese, Japanese) is cut between characters (`splitWord()`; a run of Latin letters or digits stays together, so does Hangul unless it is longer than a whole row), and where a line has such characters the rules of kinsoku hold: no row starts with one of `、。，．）」』】〉》！？…ー`, closing marks of the fullwidth forms, small kana, iteration marks or an ASCII closing mark, and none ends with `（「『【〈《` or another opening bracket (`NO_START`, `NO_END`; the break moves back to an earlier place that is allowed; a row that cannot be made legal is broken anyway). Between two words of the timing no space is put where both have such a character at the edge between them (東京 + 駅); next to a Latin word or a number the space of the source stays (「I love 東京 so much」); a word that is cut fills its pieces one after the other, each for its share of the time of the word by width. Hebrew and Arabic stay in logical order in the script; libass puts them in order on the screen, but only when the style has the encoding `-1` (it detects the direction of a line; with the default `1` it lays the words out from the left), so a script with such text sets it. The `\kf` fill of libass runs from the left edge of every word whatever its direction (checked against libass 0.17.3: in a Hebrew word the fill starts at the wrong side, while the words themselves come in the right order), so where a line has right-to-left text `karaoke` is replaced by `words` for the whole script (one style holds for all of it) and the result carries a note for the log (`notes`; `style` is the style that was used, `rtl` says whether a line has such text). `buildAss()` also returns `scripts` (`ja`, `zh`, `ko`, `ar`, `he`: those that occur; Han letters without kana or Hangul count as Chinese). `lib/captions-fonts.js` asks fontconfig (`fc-list :lang=xx family`) for each of them and returns a warning for the log where there is no font, naming `fonts-noto-cjk` (Japanese, Chinese, Korean) or `fonts-noto-core` (Arabic, Hebrew), or that `fc-list` is not available; `video.captions`, `music_video.edit` and `explainer.edit` put the notes and the warnings in their log and go on (the captions are made, the missing font shows as boxes). The word times of `lib/explainer-cues.js` split the spoken text at spaces, so a Chinese or Japanese scene has one long word; this is not changed here (open point).

**Movement of a still image (WP35, rest).** `image.to_video` (`ffmpeg-ops.js buildImageToVideo()`) moves a picture with `zoompan` on a picture scaled up to twice its size (so the integer crop offsets do not stutter). `in` zooms from 1 to 1.2 and `out` from 1.2 to 1 (unchanged from before); `pan_left`, `pan_right`, `pan_up`, `pan_down` hold the zoom at 1.15 and move the section evenly over the whole length (x or y as `(iw-iw/zoom)*on/N`, `N` = frames - 1); `alternate` takes `in` for an even and `out` for an odd position of the item in a list, `varied` takes `in`, `pan_right`, `out`, `pan_left` in turn by that position (`ctx.itemIndex`, 0 outside a list, passed by `ffmpegNode` to `build`). A motion that depends on the position says so (`itemIndexInKey(params)` on the definition), so the position is part of the cache key per item (§9.3): an item that moves to another place gets its motion again. The parallax motions (`parallax_left`, `parallax_right`, `parallax_in`) need the optional input `depth` (a grayscale picture, bright = near): `geq` makes two displacement maps from it at a quarter of the size (128 = no displacement; the shift of a pixel is its depth, 0 to 1, times the progress of the clip, times up to 5 % of the width at a strength of 100 %, at most 120 pixels; `parallax_in` shifts away from the centre, so the nearer, the more it magnifies), `displace` with `edge=smear` on planar RGB moves the picture by them, and a base movement after it keeps the smeared edges out of sight (for `parallax_left` and `parallax_right` a pan of zoom 1.15 whose window stops short of the border strip that the strongest shift can smear, the same for every strength; for `parallax_in` a slow zoom to 1.08, since its displacement points inwards at the borders); `parallax_strength` (0–100 %, 30) scales the shift. Without a depth picture the parallax falls back to the pan or zoom of the same direction (`parallax_left` → `pan_left`, `parallax_right` → `pan_right`, `parallax_in` → `in`), the log says so, and the validation shows the warning `PARALLAX_NO_DEPTH`. `fal.depth_map` (Depth Anything V2 on fal.ai; `image` → `depth`; param `enabled`, default on) makes the depth picture; the model page shows no usable figure (0 per compute second), the price API of fal gives the list price 0.00125 USD per compute second (read 2026-10-04), and the app does not get the compute time, so what is booked is the estimate of 0.01 USD per image (`estimate: true`; it covers up to 8 compute seconds); switched off (`enabled: false`) it sends nothing, costs nothing and its output stays empty, which an optional input accepts (§9.6). The template `music-video-stills` uses `varied` and has the switch `parallax` (`n14.enabled`, off by default).

### 5.11 Explainer video foundation (WP37a)

Documents, research, branding and a planner that writes the script of an explainer video. It ends at the script; voice, scenes and cut are WP37b (§5.12). The work sits in pure modules (`lib/documents.js`, `lib/explainer-plan.js`); `lib/nodes/nodes-documents.js` and `lib/nodes/nodes-explainer.js` are the adapters (inputs, files, costs, error codes). The lists between the nodes follow the scenes and are index-paired like the music video (§9.6): `narration` and `briefs` have one entry for every scene (the sources card has an empty narration, `shots.scenes[i].spoken` is false), so they can meet in one node; `image_prompts` and `clip_prompts` hold only the scenes of that kind, `shots.scenes[i].image` / `.clip` give the place of a scene in them.

| ID | Ports | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `input.document` | → `documents:document[]` | see §5.1 | see §5.1 | – |
| `doc.read` | `documents:document[]` (required) → `text:text`, `info:text`, `pages:image[]`, `files:document[]` | `max_pages` (integer 1–300, 150; a budget for all documents together), `page_images` (`none` default, `first` = 3 pages, `all`), `language` (`neutral` = `[p. 3]`, `de`, `en`, `es` for the page marks) | `documents.readDocument`: `pdftotext -enc UTF-8` (reading order, no `-layout`) and `pdftoppm` (Poppler); TXT/MD in sections of about 6000 characters that act as pages (`pages_are_sections` in the info). Header per document `=== D1: name (N pages) ===`. `info` = JSON `{ documents:[{ index, name, type, title, pages, pages_read, chars, chars_per_page, scanned, truncated, bytes }], total_pages, total_chars, scanned, max_pages }`; `scanned` = fewer than 200 characters per page on average. `available()` is false without Poppler (`POPPLER_BIN_DIR` overrides the search folder) | local, free |
| `llm.research` | `topic:text` (required, param `topic`), `focus?:text` → `notes:text`, `sources:text` | `model` (`brain-models`, default empty = Opus 5.5 if allowed), `topic`, `focus`, `max_results` (1–20, 8), `language` (`auto` = same as input, `en`, `de`, `es`; default `en`, a new node starts with `auto`), `include_domains`, `exclude_domains` (comma or line lists) | `llm.completeText` with the OpenRouter plugin `{ id:'web', max_results, include_domains, exclude_domains }`; the sources are the `url_citation` annotations of `choices[0].message.annotations`. Markdown links in the answer become `[n]`; where there are none the annotation `end_index` places `[n]`; sources the answer did not use go in a line "Further evidence". `sources` = one `[n] Title — URL (retrieved DATE)` per line. Refuses `chatgpt/*` (`RESEARCH_NEEDS_OPENROUTER`), an empty topic (`RESEARCH_NO_TOPIC`) | usd, booked from the response; no estimate (depends on the search), `history:false` |
| `input.branding` | → `brand:text`, `logo:image`, `voice:text` | `branding` (select, options source `brandings`) | `lib/brandings.js`: a short profile (colours, fonts, tone, rules, at most 8000 characters of guidelines) and the first raster file as logo; without a branding a neutral profile and no logo (`emptyOutputs` → `logo`, `voice`). `voice` (WP38f) is the voice ID of `branding.speaker` as text, left out (an optional input behind it runs without it) for a branding without a speaker voice and without a branding; it is never part of the profile (`brandProfile` stays byte for byte as it was, so the keys of the planner and of every scene do not change). `BRANDING_NOT_FOUND` for a name that does not exist. Participants and guests get `RoleRestrictedError('brandings')`. **A changed branding is noticed (WP38g):** the node has a cache stamp (§9.3) that is the hash of everything it gives out (profile text, the SHA-256 of the logo bytes, the voice ID; not the name of the voice, not the font bytes), so a changed tone, colour, font, guideline, logo or speaker voice makes it run again, and what depends on the changed output follows through the keys of its inputs (profile text → the planner and all after it, logo → the scenes, voice → the speaker and the cut). No branding chosen and no right to brandings: no stamp (the key is the old one); a branding that is gone: a stamp of its own. The logo keeps its asset: when the bytes are the same as the logo of an earlier result of this node (`ctx.earlierVariants()`; the hash is taken from the file, so entries from before need no stored hash), that asset value (same `sessionId`, same `assetId`) is returned and no new file is written; this also holds for a forced run. An entry from before the stamp is taken when its profile text, the hash of its logo file and its voice are those of the branding now (`cacheStampAdopts` as a function): a deploy changes nothing for a branding nobody changed, and a branding that was changed before the deploy runs once. | – |
| `explainer.plan` | `documents?:document[]`, `text?:text`, `own_text?:text` (WP40), `topic?:text` (param `topic`), `notes?:text`, `sources?:text`, `brand?:text`, `brief?:text` (param `brief`) → `script:text`, `narration:text[]`, `briefs:text[]`, `image_prompts:text[]`, `clip_prompts:text[]`, `shots:text`, `sources:text`, `presenter:text[]` | `model`, `topic`, `brief`, `length_seconds` (30–300, 120), `language` (`auto` = same as input, `en`, `de`, `es`; default `en`, a new node starts with `auto`), `audience`, `tone` (factual/friendly/promotional), `visual_mode` (`motion`, `mix`, `ai_video`, `typography` (WP40)), `format` (landscape/portrait), `max_still_share` (slider 0–0.5, 0.35), `presenter` (`off`, `intro_outro`), `verify` (true), `script` (textarea, "") | `explainerPlan.buildScript(raw, input)` validates and completes the model's answer (`{ script, issues, hasErrors }`); see the notes. A blank `model` is Opus 5.5 when the person may use it and OpenRouter is set up, else the default model of the app or of the person's list (log line). With `verify` a second request checks every statement against the document text or the research notes; the script is `verified` only when the check answered for every scene (see below). If `script` is set the node validates and outputs it without a model call (cost 0); `verified` survives only while the text is the one that was checked (`verified_hash`) | usd; estimate from a token estimate (`estimateUsd`), `null` (unknown) while the price of the model, the pages or an upstream node is not known; `history:false` |

Language "same as input" (WP38d). `language` of `llm.research` and `explainer.plan` has the option `auto` (label «Wie die Eingabe» / "Same as input" / «Igual que la entrada», the wording of one parameter: `nodes.option.language.auto`, looked up before `nodes.option.auto`). The node resolves it before the prompt, without a model call: `lib/language-detect.js` counts stop words (lists of words that belong to only one of de, en and es) and special characters (ä ö ü and the sharp s; ñ ¿ ¡ and á í ó ú; once per word, not again in a stop word, in a word with a capital only from two such words on and with no stop word of another language), ignoring addresses, the marks of "Read documents" and short words in capitals (UN, LA). A source is *clear* with at least 2 points and twice the points of the next language. The sources are asked in this order and the first clear one decides: topic, brief (`focus` for the research), the text input, then research notes, list of sources and titles of the documents (`llm.research`: topic, focus). Only when none is clear, the first with points for one language only (*weak*, which needs a stop word) decides; with no point at all the language is `en`. The same input always gives the same language, so the cache key (which holds the inputs) stays valid. The resolved code is used for the prompt, the words per minute and the target of words (`lib/explainer-plan.js`), the word for "page", the sources line of the research and the field `language` of the script (always `de`, `en` or `es`, never `auto`; the later nodes read it). The log says "Language: German (from the topic)" (also "..., few hints" for a weak result and "no hint in the input: English is the default"). A named language is used as before and not logged. A script in the parameter `script` keeps its own `language` (log "from the script"). The default of the parameter stays `en`: a saved node without the value, and one with `en`, keep their language and their cache key; only new nodes start with `auto` (`initial` of the param: `initialParams` in `lib/nodes/registry.js` and in `public/nodes/graph.js` for the palette and, with `fresh`, for the assistant; copies and templates keep what they have). The run service, the chat tools and the MCP tools take `auto` like any other option.

Script format (`script`, version 1): `{ version, title, language, format, visual_mode, audience, summary, scenes[], sources[], presenter, verified, verified_hash?, unverified_scenes?, removed_claims[], downgrades[], warnings[] }` with

- `scenes[]`: `{ id, kind (motion|still|clip), role (hook|point|example|summary|sources), narration, est_seconds, on_screen{ title, bullets[], numbers[{ value, label }], quote{ text, source }|null }, elements[{ id, type (title|bullet|number|chart|flow|timeline|compare|quote|figure|icon|image), content, anchor }], figure{ document (0-based), page, bbox:[x,y,w,h] in percent of the page }|null, image_prompt|null, clip_prompt|null, source_refs[] }`. The sources card has `role: "sources"`, `kind: "motion"` and an empty narration; its bullets are ONE line for every document with all the pages that are cited (`Title (S. 1, 2, 3)`, in the order of the sources; the title is cut to 9 words, the list of pages never) and one line for every other source (a numbered source of the research), at most 6 lines (`sourceCardLines`). `anchor` is a word or phrase that occurs literally in the narration of the scene. `bbox` exists only inside `figure`.
- `sources[]`: `{ ref ("[1]" or "S. 3" / "p. 3", "D2 p. 7" with several documents), title, url, document|null, page|null }`.
- `presenter`: `{ intro, outro }` or `null`.
- `verified`: `true` only when the check pass answered for every scene except the sources card; `verified_hash` is a fingerprint of the narration and the text on screen at that moment, `unverified_scenes[]` names the scenes a partial check skipped (then `verified` is false). `removed_claims[{ scene, claim, action (removed|softened), reason }]`. A check that would leave fewer than 3 scenes is not applied (the script stays as planned, `verified: false`, a log line says so). A script put into the parameter `script` keeps `verified` only if its text still matches `verified_hash`.
- `downgrades[{ scene, from, to, reason }]`, `warnings[]` (what the app corrected). There is no length or tone field at the top level (they are parameters of the node); the sum of the `est_seconds` is `shots.duration`. Error codes: `EXPLAINER_NO_MATERIAL`, `EXPLAINER_SCRIPT_INVALID`, `EXPLAINER_PLAN_INVALID`, `POPPLER_MISSING`, `DOCUMENT_ENCRYPTED`, `DOCUMENT_TIMEOUT`, `DOCUMENT_UNREADABLE`.

### 5.12 Explainer video production (WP37b)

Voice, scenes and cut: three nodes and three templates (§15) turn the script of §5.11 into a finished film. The rules sit in pure modules (`lib/explainer-cues.js` the timing, `lib/explainer-scene.js` the scene prompts, the checks and the fallback, `lib/explainer-edit.js` the timeline and the sound graph); `lib/nodes/nodes-explainer-video.js` is the adapter (inputs, files, the model, the render node, ffmpeg, costs, error codes). The lists follow the scenes and meet by index (§9.6); a scene finds its picture, its figure and its logo by the **id of the scene** (the brief starts with `Scene s3 ...`; `shots.scenes[]` with the same id names the index of the still and the figure), never by position.

| ID | Ports | Params | Backing | Cost |
| --- | --- | --- | --- | --- |
| `explainer.voice` | `narration:text` (required), `context?:text`, `voice?:text` → `audio:audio`, `timing:text`, `duration:number` | `voice_id` (`elevenlabs-voices`, default voice of the app), `model_id` (`elevenlabs-tts-models`, `eleven_v4`), `use_context` (true) | the node-only paid tool `generate_speech_timed` (`lib/tools.js`: same checks, price, booking and role limits as `generate_speech`; `elevenlabs.ttsWithTimestamps` = `POST /v1/text-to-speech/{voice}/with-timestamps`). The voice is the input `voice` (WP38f: the speaker voice of a branding) when it is connected and not empty, else `voice_id` (`chooseSpeechVoice` in `nodes-generate.js`; a restricted account may only use library voices, else `voice_id` counts and the log says so); the input has no `param`, so an unconnected node has the same cache key as before and an empty output simply falls back to the parameter. `context` is the JSON `{ previous_text, next_text }` of `explainer.plan` (`narration_context`: the spoken text of the scenes before and after); it goes along while `use_context` is on, and a refusal of the fields (HTTP 400/422 that names `previous_text` or `next_text`) is answered once with a call without them (the refused call costs nothing and is not booked; the log says so). `timing` is the JSON of `audio.lyrics_timing` (`version 1`, `words[{ text, start, end, line }]`, `lines[]`, `duration`) built from the times of the characters (`cues.wordsFromAlignment`); without alignment the word times are estimated from the text (log line). The length is measured with ffprobe (`EXPLAINER_VOICE_EMPTY` when there is none). A scene without narration makes no call and gives 4 s of silence (WAV, free) with no words | usd per scene = all characters of all scenes of the connected list ÷ their number, by the price of the model; unknown before the plan has run; `history: false`. Booked as type `speech` |
| `explainer.scene` | `brief:text` (required), `timing:text` (required), `brand?:text`, `logo?:image`, `stills?:image[]`, `pages?:image[]`, `shots?:text`, `pages_info?:text` → `video:video` | `model` (`brain-models`, default empty = Opus 5.5), `format` (`landscape`, `portrait`; must be the format of the plan: `EXPLAINER_FORMAT_MISMATCH`), `quality` (`draft`, `standard`, `high`), `vision_check` (true), `max_retries` (0–4, 2), `fallback` (true) | Per scene: (1) cues from the word times (`explainer-cues`: the start of the anchor word minus 0.15 s, at least 0.2 s, in order; a title that is the FIRST element opens the scene at 0.2 s whatever its anchor, the other elements keep their times, a short note says so when the title comes more than 0.3 s earlier than its word would have put it), the length is the voice plus 0.4 s rounded up to whole frames (`sceneDuration`; at 30 fps), (2) Opus writes ONE HTML composition (`max_tokens` 9000; the system prompt carries the contract, the building blocks, the layout rules, the cues, the brand and the attached files; attached pictures also go to the model as images), (3) `explainerScene.checkCode` (structure like `checkComposition` in `public/nodes/motion-html.js`, the forbidden calls, no navigation (`location`, `top`/`parent`/`opener`, links, forms, `open(`, `.click()`/`.submit()`, addresses set by script, markup built in code, names written as strings), no web address except a file of the GSAP package written exactly, fonts at most 2 files of 400 KB, HTML under 2 MB: the fonts are left out where the document would reach 2 MB) and then `withCsp` (the policy `default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/; ...; form-action 'none'; base-uri 'none'` as a `<meta>` in the first `<head>` before any script: a head is made where there is none or where something comes before it), `data-duration` is forced to `durationAttr` = (frames − 0.02) / 30 so that the render node makes exactly N frames; the order of the app's changes to the HTML is `fixDuration` → `withSourceLine` → `withCsp` → fonts embedded (`checkCode` has looked at the raw answer of the model before), (4) `tools.executeTool(toolCtx, 'render_motion_graphics', ...)` renders it on the render node (one job per scene, wait up to 8 min plus 1 min for every job of the server that was sent before and is not done; a stop of the run ends the scene before a job is sent), (5) two frames at `min(50 %, last cue)` and at duration − 0.15 s go to the model with the cues; the answer `{ ok, blockers[], minor[] }`; only blockers lead to a new try, `minor` is logged, (6) a new try continues the conversation (`history`: the HTML so far, then the problem and "give back the whole corrected HTML"), (7) after the last try the fixed fallback HTML (`fallbackHtml`: title, at most 3 bullets or numbers, brand colours, the still as background; its text column ends at 78 % of the height, above the free band) when `fallback` is on, else `EXPLAINER_SCENE_FAILED`. An unreadable verdict is accepted (log). A scene planned as `clip` is not drawn: a plain stand-in of the background colour with the exact length (the cut replaces it). The result is silenced with `-an -c:v copy`. Figures: `figure{ document, page, bbox }` is cut out of `pages[image_offset(document) + page − 1]` (`pages_info` = the `info` of `doc.read`) with a margin of 2 % (`figureCropFilter`), stills by `shots.scenes[].image`; what is missing leaves the scene without it (log). The source line is the app's, not the model's: `sourceLine(refs, documents)` builds the text from `source_refs` and the titles of the documents (the pages of one document together, in the order of first appearance: `Title, S. 1, 2`, a range stays `4-5`; documents joined with ` · `; notes `[n]` as they are; at most 140 characters, cut at a separator with `…`) and `withSourceLine` puts `<div id="oc-source">` as the FIRST child of `#main-composition` (else before the last `</body>`, else at the end): absolute, `left`/`right` 6 % of the width, `bottom` 1.5 % of the height (16 px landscape, 29 px portrait), right-aligned, one line with an ellipsis, 26 px (`SOURCE_FONT_PX`), `line-height:1.2`, the muted colour and the body font of the brand, `z-index:2147483647`, `pointer-events:none`, static; the text goes through `esc()` and `{` is written as `&#123;` (a `{{asset:N}}` in a source title must not reach the render node), the font and the colour are cleaned of characters that could leave the attribute. No references: no element. The writer is told to keep the lower 20 % of the frame (portrait 16 %: `FREE_BAND_PERCENT`) free of text and important content (the captions are burnt in there later, 65 px at 6 % of the height from the bottom), that decorative shapes may reach into it, and to write no source line; the model never sees the text of the line. Brand fonts are embedded for internal accounts only. Codes: `EXPLAINER_TIMING_INVALID`, `EXPLAINER_SHOTS_INVALID`, `EXPLAINER_FORMAT_MISMATCH`, `EXPLAINER_SCENE_FAILED`, `EXPLAINER_SCENE_RENDER_FAILED`. `available()`: a render node is configured and ffmpeg is there | usd per scene: 0.10 (0.07 without `vision_check`, scaled by the price of another model; unknown for a model whose price is not known); `history: false`. The run books the real tokens of every call (`usage.cost`) |
| `explainer.edit` | `scenes:video[]`, `audio:audio[]`, `timing:text[]` (all required), `shots:text` (required), `clips?:video[]`, `music?:audio`, `intro?:video`, `outro?:video` → `video:video`, `subtitles:text`, `captions:text` | `transition` (`cut`, `crossfade`; crossfade), `resolution` (1080p), `fps` (30), `captions` (`off`, `lines`, `words`; lines), `captions_position`, `music_level` (`quiet` 0.12, `medium` 0.25, `loud` 0.45), `ducking` (true), `fade_out` (0–10 s, 1), `fit` (`crop`) | `explainer-edit.planTimeline` (everything in whole frames: starts, the part of each scene that is kept, the fades; a crossfade is 8 frames at 30 fps and makes the film shorter by the overlap; a hard cut next to intro or outro is a 1-frame fade) and `explainer-edit.soundtrackArgs` (each voice on the exact frame of its scene: `atrim`/`apad`/`concat` at 48 kHz; mono voice and music are widened with `pan` so that they keep their level; music loops and is lowered under the voice by `asplit` + `sidechaincompress`; `amix`, `volume=2`, `alimiter`) make a soundtrack that goes into `music-video-edit.buildEditPlan` as the "song" and runs through `nodes-edit.runOp` / `renderLib.renderPlan` (batches of scenes, one encoder). The sound is brought to -16 LUFS before the cut: `loudnessProbeArgs` (ffmpeg `loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`, null output; the block on stderr is read by `readLoudness` as `input_i`, null for a missing value or `-inf`) → `gainFor` (target - measured, at least -12 and at most +20 dB, steps of 0.1 dB) → `normalizeArgs` (`volume=<gain>dB,alimiter=limit=0.84:attack=5:release=50:level=disabled`: the limiter keeps the peaks under 0.84, about -1.5 dBFS, without a flat cut) into a second WAV in the folder of the node, which goes into the cut instead of the soundtrack; the log line is `sound: +7.0 dB to -16 LUFS`. No result of the measurement (no sound) or a failing call leaves the sound as it is (a log line says why); only a stop of the run ends the node. Clip scenes (`shots.scenes[].kind == 'clip'`) take the next of `clips` (trimmed, slowed down to 0.8 at most, the last frame held). Captions come from `captions-ass.buildAss` with the merged word times shifted by the start of each scene (libass is needed: `CAPTIONS_NO_LIBASS` is a validation error); `subtitles` is an SRT file with the same lines; `captions` is the merged timing JSON. The log names the real length and warns when it is more than 15 % away from the target, and when a voice is longer than the frames its scene keeps (the soundtrack would cut it off: scene, both lengths). Codes: `EXPLAINER_EDIT_MISMATCH` (`{ scenes, audio, timing, shots }`), `EXPLAINER_SHOTS_INVALID`, `EXPLAINER_EDIT_NO_VIDEO`, `EXPLAINER_EDIT_NO_AUDIO` | local, free |

The planner got `clips` (boolean, true; shown for the modes `mix` and `ai_video`): off, no scene is planned as a clip (the workflows of §15 have no clip chain). `explainer.plan` calibrates the length by **spoken words** (`explainerPlan.spokenWords`: "2026" counts 4, "55" 3, "m³" 2, "%" 1), outputs `narration_context` (`text[]`, JSON `{ previous_text, next_text }` per scene) and takes `info:text` (the `info` of `doc.read`: the titles of the documents for the sources card). `doc.read` gives `images` and `image_offset` per document and `page_images` in the info. `llm.completeText` takes `history` (§ the engine notes).

Style Typography and own text (WP40). `visual_mode: typography` is the fourth value of the same parameter (labels «Typografie» / "Typography" / «Tipografía»; `max_still_share` shows only for `mix`, `clips` for `mix` and `ai_video`, so for `typography` neither). **Planner.** The prompt has the rules of the style (every scene `motion`, `image_prompt` and `clip_prompt` null, short rhythmic sentences, per scene `typography: { keywords, layout, camera }`, no bullets); `buildScript` reads the field (`readTypography`), turns a still or a clip into `motion` with the `downgrades` reason `visual_mode_typography`, empties both prompts and runs `finishTypography` over the scenes: keywords must be spoken (at most 4; `KEYWORD_NOT_SPOKEN`, `TOO_MANY_KEYWORDS`, `KEYWORD_AUTO` when the app chooses a word or a number), the layout is one of `stack, column, blocks, compare, curve, number` (`LAYOUT_INVALID`, `LAYOUT_NO_NUMBER`, `LAYOUT_REPEATED`; the replacement is the least used layout that is not the one before), the camera is empty in the first scene; all are warnings, corrected in place, never sent back to the model. The sources card has an empty `typography`. In the other modes the scenes have no `typography` field and every prompt, brief, list and fixed scene is byte for byte what it was (`scripts/support/explainer-prompts-before-wp40.json`). The brief has `Style: typography` after its first line and, per scene, `Layout: <name> (<help>)`, `Stress (huge, accent colour): a | b` and `Camera: …`; `shots.scenes[i].typography` and `shots.visual_mode` carry the same; `shots.counts.images` and `.clips` are 0 and `image_prompts` and `clip_prompts` are empty lists (nodes behind them run on nothing and cost nothing). **Own text.** The input `own_text` (text, optional) makes the text the narration (`verbatim`): the system prompt asks the model to cut the text into scenes without writing a word, the user prompt carries it in a data block `narration-text`; `buildScript` aligns the narration of the scenes with the original token by token (letters and numbers, NFC and NFKC, case ignored; `alignNarration`) and puts the original text back with its punctuation, quotes and sharp s; when a word was changed, dropped, added or reordered it reports the error `VERBATIM_CHANGED` (one repair) and cuts the text itself at sentence ends (`splitNarration`, about 10 s a scene). The script gets `verbatim: true`, `length_seconds` of the text, no check against sources (no `verify` call, `verified: false`), `LENGTH_OFF` is not an error and fewer than three scenes only a warning; the text may be 480 s of speech at most (`EXPLAINER_TEXT_TOO_LONG` before any call); the language follows the text (`auto`); the German sharp s of the text is not replaced by «ss». An edited script (`script`) is checked with the text left out. A topic, notes, sources or documents may go along. **Scene.** `explainer.scene` takes the style from the line `Style:` of the brief (or `shots.visual_mode`) and uses `writerSystemPrompt({ style: 'typography' })`, `writerUserPrompt({ words, style })` (every word of `timing` with its start, at most 120) and `checkSystemPrompt({ style })`; the frame times of the check are after the middle word has landed and 0.15 s before the end, and the request says what the voice has said by then. Limits of the style: `MIN_FONT_PX` (54) for spoken words, `MIN_LABEL_PX` (28) for captions, at most 12 words that are not spoken (`TYPOGRAPHY_LABEL_WORDS`), at most 40 words in view (`TYPOGRAPHY_VISIBLE_WORDS`); `MAX_SCREEN_WORDS` is not used. The look has its own rubric (wanted: cropping, overlay, multiply, 3D, a moving camera, vignette and grain; blockers: unreadable current word, accidental collision, empty frame, wrong order, wrong word). The estimate of a scene is `TYPOGRAPHY_SCENE_USD` 0.28 USD with the look at the frames and 0.25 without (measured in a live test on 2026-10-04 with 3 scenes: the node booked 0.8409 USD; the first guess, 1.3 times the ordinary 0.10, was 0.13). **Part C (2026-10-04).** An empty answer of OpenRouter is booked (`lib/nodes/llm.js`, see §5.3), and `explainer.scene` counts the `usd` of a failed try and of a failed look in its cost; its log line names `finish_reason` and the tokens, and a good try logs its output and thinking tokens. A try that ended empty at the token limit (`finishReason` `length`) gives the next try `MAX_TOKENS_RETRY` (16000) instead of `MAX_TOKENS` (9000); any other empty answer keeps the limit. A try that ends empty at the raised limit as well ends the tries (no third try with the same limit): the fixed scene stands in after the tries that were made, or the node stops with `EXPLAINER_SCENE_FAILED`. The fixed scene of the style is `typographyFallbackHtml` (when the scene has words): the spoken words appear at their start (`data-at` and the same time on the timeline) in lines of three to five words, the line before moves up and fades, key words (`typography.keywords` of the shot list or the `Stress` line of the brief) are large and in the accent colour; the lower band stays free; in the other styles, and for a scene without words, `fallbackHtml` is as before byte for byte. **Default font.** `lib/fonts/inter-tight/InterTight-latin-variable.woff2` (44 916 bytes, SIL OFL 1.1, `OFL.txt` next to it) is read by the node when the style is `typography` and the branding gives fewer than two embedded fonts or none for a family; it counts against `MAX_FONT_FILES` (2) and `MAX_FONT_BYTES` (400 KB), is declared `font-weight:100 900` (`fontFaces` accepts `weight` `"100 900"` besides a single weight) and the colours are `typographyTokens` (paper ground, ink, one accent, a second colour, muted caption colour of contrast 4.5 or more). No system font is named in the prompt. `cacheStamp` of the node adds `typography: { font: <sha256 of the file> }` to the stamp of the brand fonts in this style and leaves it as it was otherwise, so a changed font file draws the scenes again and the keys of the other modes stay as they were.

## 6. Port types and compatibility

### 6.1 Types

| Type | Value shape | Colour token |
| --- | --- | --- |
| `text` | `{ type:'text', value:string }` | `--nv-port-text: #8fb3ff` |
| `number` | `{ type:'number', value:number }` | `--nv-port-number: #7fd1e0` |
| `image` | `{ type:'image', sessionId, assetId, file, url }` (raster: png/jpg/webp; gif treated as image for display only) | `--nv-port-image: #d8a25f` (= `--accent`) |
| `video` | `{ type:'video', sessionId, assetId, file, url, duration? }` (mp4/webm) | `--nv-port-video: #c49bff` |
| `audio` | `{ type:'audio', sessionId, assetId, file, url, duration? }` (mp3/wav/m4a/aac) | `--nv-port-audio: #5fd3a2` |
| `model3d` | `{ type:'model3d', sessionId, assetId, file, url }` (glb only; compatible with `model3d` and `any`, with nothing else) | `--nv-port-model3d` |
| `document` | `{ type:'document', sessionId, assetId, file, url, name, bytes?, pages? }` (pdf, txt, md; `name` is the name the person gave the file). Compatible with `document` and `any` only. The node card shows a chip with name, pages and size, not a player | `--nv-port-document: #b9cf6e` |
| `any` | any of the above | `--nv-port-any: #9aa1ab` |
| `T[]` | `{ type:'list', of:T, items:[Value…] }` | same colour, square port glyph |

Ledger → type mapping (`lib/nodes/assets.js valueFromLedgerEntry`): kind `image` → image; `video` → video; `audio` → audio; `upload` by extension (`.png .jpg .jpeg .webp .gif` → image, `.mp4 .webm` → video, `.mp3 .wav .m4a .aac` → audio, `.svg` → rejected for `image` ports with the message to use the PNG variant).

### 6.2 Compatibility (`lib/nodes/types.js canConnect(fromType, toType)`)

1. Same type → OK.
2. `any` on either side → OK (executor validates at run time).
3. `number` → `text` → OK (stringified). `text` → `number` → not allowed (use a param).
4. `T[]` → `T` → OK: **implicit map** (node runs once per item, §9.6).
5. `T` → `T[]` → OK: wrapped into a one-item list.
6. `T[]` → `T[]` → OK.
7. Everything else (e.g. `video` → `image`, `image` → `video`) → rejected; the palette suggests the bridging node (`video.extract_frame`, `image.to_video`).
8. A port with `multiple: true` accepts several edges (order = order in `graph.edges`, shown as index badges, each on its own curve and never covering another badge of the input, and as a numbered row of the sources under the input on the card; the order is changed by dragging an entry of the row, with the arrow keys or from the context menu of an entry or an edge, as one undo step); otherwise a new edge replaces the old one. The order is part of the cache key (§9.3), so a new order makes the node stale. Behind the first list connection the position is unknown (a list counts with all of its items) and is shown as "…".
9. Cycles are rejected at connect time (client) and at validate time (server).

The same `types.js` data is served to the client in `GET /api/nodes/registry` (`portTypes`, `compat` matrix) so client and server never diverge.

---

## 7. Data model

### 7.1 Workflow document (`data/workflows/<wfId>/workflow.json`)

```json
{
  "format": "ocd.workflow",
  "version": 1,
  "id": "wf-mt3k2p-a1b2c3",
  "name": "Coffee hero → vertical ad",
  "description": "",
  "folder": "Northlight Roasters",
  "sessionId": "mt3k2p9-4f1e2a",
  "rev": 17,
  "createdAt": "2026-09-29T10:12:00.000Z",
  "updatedAt": "2026-09-29T10:40:12.000Z",
  "createdBy": "lokal",
  "updatedBy": "lokal",
  "graph": {
    "nodes": [
      { "id": "n1", "type": "input.text", "typeVersion": 1, "x": 80, "y": 120,
        "params": { "text": "Specialty coffee cup, Scandinavian cafe, warm morning light" } },
      { "id": "n2", "type": "llm.prompt_enhancer", "typeVersion": 1, "x": 420, "y": 120,
        "params": { "model": "anthropic/claude-opus-4.6", "target": "image", "notes": "" } },
      { "id": "n3", "type": "image.generate", "typeVersion": 1, "x": 760, "y": 80,
        "params": { "prompt": "", "aspect_ratio": "9:16", "count": 4 }, "title": "Hero still" },
      { "id": "n4", "type": "video.seedance", "typeVersion": 1, "x": 1100, "y": 80,
        "params": { "prompt": "Slow push-in, steam rising, light flickers through leaves", "duration": 6, "resolution": "720p" } },
      { "id": "n5", "type": "output.result", "typeVersion": 1, "x": 1440, "y": 120,
        "params": { "label": "Final clip" } }
    ],
    "edges": [
      { "id": "e1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } },
      { "id": "e2", "from": { "node": "n2", "port": "text" }, "to": { "node": "n3", "port": "prompt" } },
      { "id": "e3", "from": { "node": "n3", "port": "image" }, "to": { "node": "n4", "port": "first_frame" } },
      { "id": "e4", "from": { "node": "n4", "port": "video" }, "to": { "node": "n5", "port": "inputs" } }
    ],
    "groups": [ { "id": "g1", "title": "Look development", "x": 40, "y": 40, "w": 1020, "h": 420, "color": "amber" } ],
    "notes":  [ { "id": "t1", "x": 80, "y": 520, "w": 260, "h": 120, "text": "Pick the best of 4 stills before running the video." } ],
    "viewport": { "x": 0, "y": 0, "zoom": 0.8 }
  },
  "app": {
    "enabled": true,
    "title": "Vertical coffee ad",
    "description": "Describe the scene, get a 6 s clip.",
    "inputs":  [ { "node": "n1", "param": "text", "label": "Scene" },
                 { "node": "n4", "param": "duration", "label": "Length (s)" } ],
    "outputs": [ { "node": "n5", "label": "Clip" } ]
  }
}
```

Rules: node IDs `n<k>`, edge IDs `e<k>`, group `g<k>`, note `t<k>` (unique per workflow, `[A-Za-z0-9_-]{1,32}`). `typeVersion` allows registry-level param migrations. Unknown node types are kept on import and rendered as "unknown node" (not executable). `viewport` is saved but does not bump undo history.

### 7.2 Results (`data/workflows/<wfId>/results.json`, engine-owned)

```json
{
  "version": 1,
  "nodes": {
    "n3": {
      "selected": { "entry": "h-mt3l0a-01", "variant": 2 },
      "history": [
        {
          "id": "h-mt3l0a-01",
          "runId": "r-mt3l0a-9c1d",
          "createdAt": "2026-09-29T10:31:02.000Z",
          "user": "lokal",
          "cacheKey": "sha256:7f1c…",
          "params": { "prompt": "", "aspect_ratio": "9:16", "count": 4 },
          "variants": [
            { "image": { "type": "image", "sessionId": "mt3k2p9-4f1e2a", "assetId": "img-004", "file": "img-004.png", "url": "/assets/mt3k2p9-4f1e2a/img-004.png" } },
            { "image": { "type": "image", "sessionId": "mt3k2p9-4f1e2a", "assetId": "img-005", "file": "img-005.png", "url": "/assets/mt3k2p9-4f1e2a/img-005.png" } }
          ],
          "cost": { "usd": 0.0188, "credits": null },
          "durationMs": 21450
        }
      ]
    }
  }
}
```

- A **variant** is one complete output set (`{ portId: Value }`). `count: 4` → 4 variants in one history entry. Downstream nodes receive the *selected* variant.
- History is capped at 30 entries per node (oldest dropped from the list; assets stay in the ledger).
- Results can be deleted per entry or for a whole node (`DELETE …/results/:nodeId[/entries/:entryId]`, WP38e). The selected entry that goes gives way to the newest one left (variant 0), none left means `selected: null`. A deleted entry never serves as a cache hit (whole node or per item); the items a failed run kept in `partial` that are copies of its items go with it. A file of a deleted entry is deleted only if it lies in the workflow's own session and nothing else needs it: no other entry of any node, no `partial`, no parameter of an input node, no app or note that names it, no open provider job with published reference copies, no stored chat that points at it; otherwise the file stays and only the entry goes. See IMPLEMENTATION-NOTES, "Deleting results (WP38e)".
- Client autosave never writes this file; variant selection goes through `PATCH …/results/:nodeId`. This split avoids write races between autosave and a running engine.

### 7.3 Run record (`data/workflows/<wfId>/runs/<runId>.json`, last 50 kept)

```json
{ "id": "r-mt3l0a-9c1d", "workflowId": "wf-…", "mode": "node", "targets": ["n3"], "force": true,
  "user": "lokal", "status": "completed", "startedAt": "…", "finishedAt": "…",
  "nodes": { "n1": {"status":"cached"}, "n2": {"status":"cached"}, "n3": {"status":"done","entry":"h-mt3l0a-01"} },
  "cost": { "usd": 0.0188, "credits": 0 }, "overrides": {}, "error": null }
```

Run status: `running | completed | failed | cancelled | interrupted` (`interrupted` = server restarted mid-run; set on startup for stale `running` records).

### 7.4 Backing session

Created with `store.createSession({ folder, kind: 'workflow', title: 'Workflow: <name>' })` (WP1 extends `createSession`). It holds the ledger, jobs and poller messages. It is hidden from `GET /api/sessions` (WP1: `store.listSessions` skips `kind === 'workflow'` unless `includeHidden: true`; `poller.pollOnce` passes `includeHidden: true`). Its title follows workflow renames. Deleting a workflow deletes the backing session (`store.deleteSession`) after confirmation; cost journal lines remain.

### 7.5 Export / import

`GET /api/workflows/:id/export` returns `{ format:'ocd.workflow', version:1, exportedAt, name, description, graph, app }` (no `id`, `sessionId`, `rev`, results). Media input nodes keep their `asset` reference but it is marked `missing` after import into another workflow; the node shows "re-upload". Import (`POST /api/workflows/import`) validates `format`, runs `migrations[version]` (none yet), rejects cycles and dangling edges, keeps unknown node types, and creates a new workflow + backing session. Max import size 2 MB. The answer of the import carries `files` (§7.6): on the same server the files of the media inputs are copied again when the importing person may see their source.

### 7.6 Workflows with files (ZIP)

Implemented in `lib/nodes/workflow-archive.js` (plan, directory, checks, unpacking) and `lib/nodes/routes.js`.

**Export.** `GET /api/workflows/:id/export-info` answers `{ fileCount, referenceCount, missingCount, totalBytes, estimatedZipBytes, limits: { maxZipBytes, maxFiles }, exceedsImportSize, exceedsImportFiles }` (same access as the JSON export). `GET /api/workflows/:id/export.zip` streams `<name>.ocd-workflow.zip`: `workflow.json` (the document of the JSON export plus `files`, the directory `[{ node, param: 'asset'|'assets', index?, path, type, name, size }]`; an input without a file has `missing: true` and no `path`) and `files/NNN-name.ext` (one entry per distinct input asset, stored without compression). Only the media inputs of the nodes are packed, never results; files that are missing, pending, not media or from another session stay `missing`.

**Import.** `POST /api/workflows/import-zip?folder=&name=` with the raw ZIP as body (`Content-Type: application/zip`, `application/x-zip-compressed` or `application/octet-stream`; any other type, above all JSON, which the body parser of the app reads first, is refused with 415 `reason: CONTENT_TYPE` before a staging folder exists), streamed to a staging folder (`.import-zip-*` in the assets folder, always removed). Limits: ZIP 500 MB, each file 500 MB unpacked, all files together twice that, 200 files, `workflow.json` 2 MB, SVG 10 MB. The ZIP is checked completely first (names without `..` / absolute paths / backslashes, no links, no encryption, no duplicates, only entries named in the directory, the unpacked size counted while unpacking, types by the rules of an upload and matching the node they feed (a video does not go into an image node), a deflated file larger than 1 MB unpacked may not grow by more than 100 times, `workflow.json` validated as in the JSON import); only then the workflow is created (owner, team and folder as in the JSON import), the files are stored in its backing session (`assets.saveUploadFile`, SVG rasterised) and the nodes are linked. A failure after the workflow exists removes it again. Answer 201: `{ workflow, results, files }`.

**Files message.** Every import answers `files: { code, total, imported, missing, message }`; `code` is `IMPORT_FILES_NONE` | `IMPORT_FILES_ALL` | `IMPORT_FILES_PARTIAL` | `IMPORT_FILES_MISSING`, `message` the German sentence ("3 von 4 Dateien übernommen, 1 fehlt.", `null` for `NONE`).

**JSON import on the same server.** For every media reference the server checks the importing person (`requireSessionAccess` as in `import-asset`, never anything the file says): the source session must be visible to them, the asset must exist and be finished; then `assets.copyAsset` brings it into the new backing session. The file type must also fit the node (`input.image` takes images, `input.media_list` the type of its `kind`). Otherwise the reference stays `missing`.

**Errors** (`{ error, code, reason?, params? }`, `error` is a German sentence, the client translates by `code` and `reason`): `TOO_LARGE` 413 (`reason`: `archive`, `file`, `unpacked`, `workflow`, `svg`; `params.limitBytes`, `params.limitMb`), `TOO_MANY_FILES` 413 (`params.maxFiles`), `INVALID_ARCHIVE` 400 (`reason`: `NOT_A_ZIP`, `NO_WORKFLOW_JSON`, `BAD_DIRECTORY`, `UNSAFE_PATH`, `LINK_ENTRY`, `DUPLICATE_ENTRY`, `UNLISTED_ENTRY`, `MISSING_ENTRY`, `SIZE_MISMATCH`, `CORRUPT_ENTRY`, `UNSUPPORTED_COMPRESSION`, `EMPTY_FILE`, `RATIO`; `params.path`), `INVALID_WORKFLOW` 400 (`reason`: `NOT_JSON`, `INVALID_DOCUMENT`; `params.detail`), `UNSUPPORTED_MEDIA` 415 (`reason`: `TYPE`, `MISMATCH`, `CONTENT_TYPE`, `UNREADABLE`; `params.path`), `IMPORT_FAILED` 500; plus the usual `NOT_FOUND` (project) and `INVALID_REQUEST`.

---

## 8. Registry format

`lib/nodes/registry.js` holds `register(def)`, `get(type)`, `list()`, `publicDescriptor(def)`. A definition:

```js
register({
  type: 'image.generate',
  version: 1,
  category: 'image',            // input | llm | text | image | video | audio | edit-image | edit-video | edit-audio | higgsfield | utility | output
  label: 'Generate image (GPT Image 2)',   // English fallback; client uses i18n key nodes.type.<type>.label
  keywords: ['gpt', 'image', 'text to image'],
  inputs: [
    { id: 'prompt', type: 'text', required: true, param: 'prompt' }   // param = inline fallback when unconnected
  ],
  outputs: [ { id: 'image', type: 'image' } ],
  params: [
    { id: 'prompt', kind: 'textarea', default: '', inline: true },       // inline = shown on the node card
    { id: 'aspect_ratio', kind: 'select', options: IMAGE_RATIOS, default: '1:1' },
    { id: 'count', kind: 'integer', min: 1, max: 4, default: 1 }
  ],
  paid: true,                                  // triggers pre-run confirmation
  cost: { unit: 'usd', estimate: (params, ctx) => null },   // null = unknown → UI shows last actual
  available: () => (or.hasKey() ? true : 'OPENROUTER_API_KEY missing'),
  validate: (params, inputs) => [],            // warnings/errors shown before run (e.g. PUBLIC_BASE_URL)
  execute: async (ctx, inputs, params) => ({ variants: [ { image: value } ], cost: { usd: 0.0047 } })
});
```

Param kinds: `text`, `textarea`, `code` (monospace, for HTML), `number`, `integer`, `slider` (`min`,`max`,`step`), `boolean`, `select` (`options` static or `optionsSource`: `brain-models`, `elevenlabs-voices`, `elevenlabs-tts-models`, `higgsfield-image-models`, `higgsfield-video-models`), `color`, `asset` (media picker), `assets` (multi), `tags` (string array). Optional `showIf` for conditional UI: `{ param, equals }`, `{ param, empty }` (the field holds no text), `{ port, connected }`, `{ ports: [...], connected }` and `{ all: [...] }` when several must hold (e.g. hide `aspect_ratio` on Seedance when `first_frame` is connected; hide `length` of `audio.music` while a plan, in the field or through a connection, or a video sets the length).

`cost.estimate(params, ctx)` gets `ctx = { workflow, results, lastCost, nodeId, connected, config, inputs }`: `connected` is the set of input ports with a connection, `inputs` the values the node would receive now. `inputs` is filled only while everything before the node is up to date (otherwise `{}`), so an estimate never takes the earlier result of a node that is about to run again for the real one (`fal.video_segment` reads the length of its video from it). `cost.history: false` keeps the plan from guessing the price from the last run of the node type.

`publicDescriptor` strips `execute`/`validate`/`estimate` functions and adds `available: true | reason`. The client auto-generates node cards and the inspector from this descriptor; most nodes need no client code.

---

## 9. Engine

`lib/nodes/engine.js` exports `createEngine({ store: workflowsStore, registry, events, getConfig, limits })` → `{ plan(workflowId, opts), start(workflowId, opts) → runId, cancel(workflowId, runId), activeRun(workflowId) }`.

### 9.1 Run request

`{ mode: 'all' | 'node' | 'selection' | 'items', nodeIds?: string[], nodeId?: string, items?: number[], force?: boolean, overrides?: { [nodeId]: { [paramId]: value } }, user }`.

- `all`: targets = every executable node.
- `node` / `selection`: targets = `nodeIds`.
- `items`: `{ mode: 'items', nodeId, items: [0, 2] }` makes single items of the list result of one node again (numbers from 0, once each, at most 50; the scene table of §12.2 sends it). The target is `nodeId`, its items are forced, all other items come from the selected result (§9.3), and the result is a new history entry with the whole list. The run holds the target and its predecessors only; the nodes after it are not part of it, they run with the next run, and thanks to their cache per item only the affected items run there. The asked items are made again even if the same item was made before; the exception is a failed run of the same request: what it finished and paid for is kept in `partial` (`forcedItems` = the numbers it asked for) and a repeated request takes it from there instead of paying twice. Refused before anything starts: `ITEMS_NO_LIST` (the node has no list result, does not run once per item, or its selected entry has no `itemKeys` because it was made before WP35: the other items would come from some other entry of the history, so the whole list has to be made once first), `ITEMS_OUT_OF_RANGE` (a number beyond the list), `INVALID_REQUEST` (no `nodeId`, no numbers, not whole numbers, more than 50). Rights, budget and the rules for participants are those of every run; the run record has `items`.
- Required set = targets ∪ all ancestors (walk incoming edges).
- `force` applies **only to targets**: they execute even on a cache hit (new history entry = new variants). Ancestors always reuse cache. UI default: ▶ on a node = `mode:'node', force:true`; "Run all" = `force:false`.
- `overrides` are merged over saved params for this run only (Design App, batch). They are part of the cache key; the graph is not modified.

### 9.2 Algorithm

1. Load `workflow.json` + `results.json`; `validateGraph` (types known, required inputs connected or inline param set, edge types compatible, no cycles via Kahn). Validation errors fail the run before any provider call.
2. Topologically sort the required set (Kahn; ties by `y` then `x` for stable order).
3. Ready-queue scheduling with a pool of `limits.parallel` (default 3; env `NODES_MAX_PARALLEL`). A node is ready when all its upstream nodes in the required set are `done` or `cached`.
4. For each ready node: resolve inputs from upstream **selected** variants (fresh results of this run replace the selection first), apply `number→text` coercion and list wrapping, compute the cache key (§9.3).
5. If not forced and some history entry has the same `cacheKey` → select it (keep the user's variant if it is the same entry), emit `cached`.
6. Else `available()` must be true (else error `unavailable: <reason>`), then `execute(ctx, inputs, params)` inside a per-node timeout (sync executors 12 min, async waits 30 min). Append history entry, set `selected = { entry, variant: 0 }`, persist `results.json` under a per-workflow lock (`store.withLock('wf:' + id, …)` — the existing mutex is keyed by any string).
7. On executor error: node `error` (message ≤ 500 chars), all descendants in the required set `skipped` (`blocked by n3`), independent branches continue. Run status `failed` if any node errored, else `completed`.
8. Emit `run_finished`, write the run record, prune old run records.

### 9.3 Cache key

`sha256(canonicalJSON({ t: type, v: typeVersion, p: effectiveParams, i: inputFingerprints }))`, with keys sorted recursively.

- `effectiveParams` = saved params ∪ overrides, minus UI-only params (`label`, `title`).
- Fingerprints: text → `'t:' + sha256(value)`; number → value; media → `'<sessionId>/<assetId>'` (assets are immutable); list → array of item fingerprints.
- Consequence: changing a param, an upstream result, or the selected upstream variant changes the key → the node is stale. Re-running an input node with identical params is a cache hit.
- **Cache stamp (WP38g).** A node that reads state of the app that is neither a parameter nor an input (a branding, the default model of the settings, the font files of a branding) says so with `def.cacheStamp(params, ctx)`: async, cheap, never a paid call, it returns any JSON value or `undefined` ("nothing to add"). `ctx` is `{ user, config, sessionId, workflowId, nodeId, inputs, log }` (`inputs`: what the node receives now). The value is hashed (`st:<sha256>`) and becomes `s` in the body of the key and of the key of every item: `sha256(canonicalJSON({ t, v, p, i, s }))`. Without a hook, or when the hook returns nothing, there is no `s` and every key is the same, byte for byte, as before (`test-nodes-stamps.js` pins keys measured before the change). A stamp that cannot be made counts as a stamp of its own (`{ failed: true }`: the node runs and says why) instead of reusing a result for state nobody could read. An entry stores the stamp it was made with (`stamp`). Used by plan, run, the budget reservation of a run (`planWithStamps` in `lib/nodes/engine.js`: a stamp may read an input, so the plan is computed again until it has every stamp it asks for) and the items. `cacheStampAdopts` says what happens to an entry from before the node had a stamp (its key has no `s`): `true` takes the entry that the key without stamp finds, once and only while no entry of the node has a stamp, and gives it the key, the stamp and the item keys of now (a deploy does not make paid work run again for state nobody changed); a function `(entry, { stamp, params, ctx })` takes it when it says that the entry was made for the state of now (async); absent: not taken, the node runs once more (right for free nodes). The same applies to the items of a list node: the items of such an old entry, and the items a failed run kept before the stamp (`partial` without `stamp`), are found with the keys they were made with (no `s`) while no entry of the node carries a stamp, so the first change of one item of a list after a deploy makes only that item run. Kept items hold the `stamp` they were made with. An optional `def.cacheStampOutputs(raw, { params, ctx, nodeResults })` of a free node returns `{ outputs, unknown }` (what the node gives, and the outputs that exist only after the run) so that the plan knows what the nodes behind it receive: after a changed branding the plan shows only what really changes (`input.branding`: profile text and voice from the stamp, the logo asset of an earlier result with the same bytes; a new logo file is `unknown`, so only what depends on it is out of date). The plan marks such a node with `stamped: true`, so the page may show an input node as out of date. Nodes with a stamp: `input.branding` (content of the branding, see its row), `explainer.scene` (the SHA-256 of the font files that the brand profile names with an asset, read from the branding of the app when the scene is drawn: a font file replaced under its name renews the scenes; nothing to add without font files or for a participant; `cacheStampAdopts: true`), and every node that uses the default model of the settings when its own `model` is empty: `llm.chat`, `llm.prompt_enhancer`, `llm.image_describer`, `llm.video_describer`, `llm.motion_html`, `music_video.plan` (`config.defaultBrain`), `image.generate`, `image.edit` (`config.imageModel` when `model` is empty), `image.relight` (always `config.imageModel`), `video.generate` (`config.videoModel` when `model` is empty), `video.seedance` (always `config.videoModel`), and `explainer.plan` (the kinds of pictures it may plan: whether there is an image model and a fal.ai key, and `config.defaultBrain` when OpenRouter is missing and no model is named); all with `cacheStampAdopts: true`. The stamp is the setting only, never what a person may use (a participant and the operator share the results of a workflow). A node that names its model has no stamp (the model is a parameter), so its key is the old one. Audited and without need of a stamp: `llm.research` (it needs OpenRouter, so it never takes the fallback), `explainer.voice` and, as a known exception, `explainer.scene` for the fallback model (it has a stamp for the fonts; the settings are not in it) (model and voice are chosen from the parameters, the inputs or fixed constants of the code; the fallback `config.defaultBrain` is used only when the account cannot use the constant), the Higgsfield and fal nodes (model and options are parameters), `input.document` and `doc.read` (uploaded files are immutable assets), `video.captions` (fonts are files of the app, changed only by a deploy). Not read by any node: cast and characters, prompt templates, folder profiles, context files, project memory.
- **Per item (WP35).** A node that runs once per item of a list (§9.6) also has a key for each item. A history entry of such a node stores `itemKeys[]` (one per item, in the order of the list; `partial` stores them too). The key of an item is computed like the key above, over type, version, the params of one execution (`count` = 1) and the fingerprints of the inputs as this one execution sees them: a mapped input counts only with its item, a single value and a whole list (a `multiple` input such as `stills` or `pages` of `explainer.scene`) count completely, unless the node reduces them (see "Reduced inputs" below). A node whose result depends on `ctx.itemIndex` says so (`def.itemIndexInKey(params)`, for example `image.to_video` with `alternate` or `varied`); only then is the position of the item part of its key; log lines that carry the number (the label of `explainer.scene`) leave it out. Items with the same key (the same prompt twice, for variants) are told apart by their number among them: the n-th item with a key takes the n-th item with that key of a stored entry, so repeated items keep their own results; an entry that has fewer of them leaves the rest to run. When the node runs, each item is looked for by its key first in the selected entry, then in the rest of the history (newest first), then in `partial` (the items a failed or cancelled run kept; the items of a run of single items that were asked for only count for the same request, see §9.1); a found item does not run and costs nothing (log: "Reused 4 of 6 unchanged items"), only the others run and are booked. A forced run (`force`, targets) skips this and makes every item again. A history entry without `itemKeys` (made before) stays valid as a whole and is not used per item. The plan (§9.4) counts and prices only the items that really run (`executions`). **Reduced inputs (WP35c).** A node that reads only a part of an input that every item gets whole says so with `def.itemKeyInputs(index, inputs, params)`: it gets the inputs of the item (as the execution sees them: the element of a mapped input, the whole of the others) and returns the inputs as the key should see them (the same shape; a port may be left out or hold a value made for the key). The node reads the same values through the same function in `execute`, so the key holds exactly what the execution uses (a wrong reuse is worse than a run that was not needed, so anything that may be read counts). A hook that returns nothing usable or throws counts all inputs; a node without the hook keeps its keys byte for byte. `explainer.scene` takes from the shot list the entry with the id of the brief plus every field of the list except `scenes`, the still that entry names (`image`, only for a `still` scene), the page image of its figure (not for a `clip` scene), from the info text the documents up to the last one the figure or the source line names (and whether the info text and the page images are there), the brand and the logo completely, brief and timing of the item, and the params; a changed shot, still, page image or document runs only the scenes that read it. `explainer.voice` leaves the text around the scene out of the key where it is not read (`use_context` off, or a scene without narration); where it is read, the key is the same as before. A history entry whose keys an older version wrote is renewed when it is the whole-list hit of a run (its inputs are known then): its `itemKeys` are replaced by the current ones. An entry or a `partial` that has the same whole-list key as the current run was made with the same inputs and parameters, so its items are in the same places: when its stored keys are those of an older version, the item is taken by its position (this also holds for a run of single items on such an entry, and for the scenes that a failed run kept).

### 9.4 Plan (dirty propagation, cost preview)

`plan(workflowId, { mode, nodeIds, force, overrides })` walks the same topo order without executing: a node is `stale` if any upstream node in the plan is stale, or if its key (computed from current upstream selections) matches no history entry. Result per node: `{ status: 'cached' | 'stale' | 'forced' | 'unavailable' | 'invalid', paid, estimate: { usd, credits } | null, lastCost, reason? }`, plus totals. The client calls it (debounced 1 s after each successful autosave) to paint stale badges, and before a run to show the confirmation "N paid nodes will run (≈ $X known, Y credits est., Z unknown)".

With `force: true` and `mode: 'all'` every node is `forced` and the totals are the price of running everything again: the node view's "Run all again" asks this plan, shows the total (and the number of paid nodes without a known price) and starts `{ mode: 'all', force: true }` only after the person confirms; the budget checks of every run apply (§9.1 and the account rules). The plan entry of a node with a cache stamp carries `stamped: true`.

### 9.5 Executor context

```js
ctx = {
  workflowId, runId, nodeId, sessionId, user, config,   // config = server runtime (imageModel, videoModel, brainModels, defaultBrain)
  signal,                                               // AbortSignal of the run
  toolCtx: { sessionId, config, user, emit },           // for tools.executeTool; emit maps tool events to node_log
  log(label),                                           // → SSE node_log
  earlierVariants(),                                    // the variants of the earlier results of this node, newest first (WP38g: input.branding finds its logo asset again)
  waitForJob(job),                                      // lib/nodes/jobs.js waitForSessionJob(sessionId, job.jobId, { signal, timeoutMs })
  saveOutputFile({ kind, ext, sourceFile, prompt, cost, duration })   // lib/nodes/assets.js → reserveAsset + completeAssetFile
}
```

`waitForSessionJob` polls `store.readSession(sessionId).jobs` every 2 s: `completed` → returns `resultAssetIds || [assetId]`; `failed` → throws `job.error`; aborted → throws `AbortError`; timeout → throws. It never calls providers itself; the existing poller does. Asset costs are read from the ledger (`entry.cost`) after completion.

### 9.6 Lists (batch)

If a non-list input port receives a `T[]`, the node maps over the items: one execution per item, outputs collected into lists in item order. Multiple list inputs are zipped by index (length mismatch → validation error). Inside a map `count` is forced to 1. Max 50 items per map (`limits.maxListItems`). Items execute through the same pool; the history entry stores one variant whose ports hold lists. Per-item progress is emitted as `node_status` with `progress: { done, total }`. An empty list runs the node zero times and gives empty lists on its list outputs; on a `multiple` port it adds no files. The music video relies on both when the plan has no singer scene (the lip sync step has nothing to do and the cut receives no singer clips). An **optional** input does without an output that stays empty: a mapped node leaves out an output that none of its items delivered, and the check of the graph accepts a connection from an output that is empty on purpose (`emptyOutputs(params)` of the definition, for example `fal.depth_map` switched off) to an optional input only (`OUTPUT_EMPTY` for a required one). Items are cached one by one (§9.3), and `{ mode: 'items' }` (§9.1) makes chosen items again.

### 9.7 Cancel

`cancel()` aborts the run's `AbortController`. Pending nodes → `cancelled`; running local ffmpeg processes are killed (WP4 adds `signal` to `runProcess`); waiting nodes stop waiting. Submitted provider jobs keep running remotely; their assets still arrive in the backing session ledger (visible in the asset picker) but are not attached to a history entry. The UI warns about this before cancelling when async nodes are running.

### 9.8 Concurrency and limits

- One active run per workflow (second start → HTTP 409 with the active `runId`).
- Max 4 active runs server-wide (env `NODES_MAX_ACTIVE_RUNS`) → 429.
- Global semaphore of 2 concurrent local ffmpeg jobs across all runs.
- A server restart marks `running` run records as `interrupted`.

---

## 10. Dynamic Higgsfield models

### 10.1 Catalogue

`lib/nodes/higgsfield-catalog.js`: `listModels(type)` calls `higgsfield.mcpCall('models_explore', { action: 'list', type, limit: 100, after })` (read-only, no credits), follows `next_page_token`, parses JSON, caches per process for 60 minutes (manual refresh flag). `getModel(id)` uses `{ action: 'get', model_id }` with the same cache. When Higgsfield is disconnected both return `[]`.

### 10.2 Model → param schema

- `aspect_ratios[]` → `select aspect_ratio`; `durations[]` → `select duration`; `duration_range` → `integer duration` with min/max; `parameters[]`: `string` + `options` → `select`, `string` → `text`, `number` → `number` (min/max/default), `bool` → `boolean`, `string_array` → `tags`; `required: 'required'` → required flag.
- `medias[]` → `refs` port max (sum of `max`, capped at 12). Role selection stays with `referenceRoleFromModel` in `lib/tools.js`.
- `credits_per_unit` × (1 image | duration seconds) → credit estimate.

The palette shows one entry per model (label = model `name`, category "Higgsfield", keywords = provider + tags); inserting it creates an `image.higgsfield` / `video.higgsfield` node with `params.model` preset. The inspector fetches `GET /api/nodes/higgsfield-models/:id` to render the dynamic params. If a model disappears, the node shows "model unavailable" but keeps its params.

### 10.3 Required change in `lib/tools.js` (WP3)

`runHiggsfieldGeneration` accepts an optional `args.extra_params` object. Each key must exist in the model's `parameters[]` (fetched via `models_explore get`, already done for roles) and must not be one of `model, prompt, medias, use_unlim`; values are type-checked; everything else is dropped with a correction note. The Director's tool schema is **not** changed (`additionalProperties: false` stays), so only node executors can pass `extra_params`.

---

## 11. REST and SSE API

All routes live in `lib/nodes/routes.js` as `registerNodeRoutes(app, { runtime, publicRuntimeConfig, engine })`, called in `server.js` before `app.get('*')`. IDs are validated with `store.isValidId`. Errors use the existing `{ error }` shape. `req.kubleUser` is recorded as user.

### 11.1 Registry and options

| Method | Route | Response |
| --- | --- | --- |
| GET | `/api/nodes/registry` | `{ version, portTypes, compat, categories, nodeTypes: [publicDescriptor…] }` |
| GET | `/api/nodes/options/:source` | `brain-models` → `publicRuntimeConfig().brainModels`; `elevenlabs-voices` → `elevenlabs.listVoices()` mapped to `{value,label}` plus `labels`, `description` and `preview: true` where ElevenLabs keeps a free sample (the address of the sample stays on the server; 503 without key; participants and guests only get `category: premade`); `elevenlabs-tts-models` → `elevenlabs.listModels()` mapped to `{value: model_id, label: name}` (the speech models of the account, kept for an hour; where the call cannot be made or fails the built-in list comes back, so never an error and no key needed; the same for everybody); `higgsfield-image-models` / `higgsfield-video-models` → catalogue list |
| GET | `/api/elevenlabs/voices/:voiceId/preview` | The free sample of a voice (WP38f, `lib/voice-preview.js`): audio, `Cache-Control: private, max-age=3600`. `:voiceId` is looked up in `elevenlabs.listVoices()` (`default` = the default voice of the app); only the `preview_url` of that voice is fetched (`elevenlabs.fetchPreview`: https, a public host without address literal or credentials, no redirect, no API key, 15 s, at most 2 MB, audio only), never an address of the client. The file is kept in memory (24 MB in all, 6 h, renewed when the address changes, one fetch for requests at the same time). `404` for an unknown voice, an invalid id, and a cloned voice for a participant, guest or unconfirmed caller; `404 NO_PREVIEW` (`reason`) for a voice without a sample; `502` without detail; `503` without a key. Rule `open` / participants `filtered`. |
| GET | `/api/elevenlabs/voices/:voiceId/sample` | What a made sample of the voice costs and whether it can be made: `{ hasPreview, cached, usd, chars, model, lang, available, reason }`; query `model_id` (default model of the app, only `[A-Za-z0-9._-]{1,64}`) and `lang` (`de`, `en`, `es`, else `en`); `reason` is `no_key` or `budget` (the remaining budget of a participant does not cover `usd`); `cached` samples are always available. Same voice rules as `preview`. |
| POST | `/api/elevenlabs/voices/:voiceId/sample` | Body `{ model_id?, lang? }`. Makes the sample of a voice WITHOUT a free sample once and answers with the audio (`X-Sample-Cached: 0 | 1`, `X-Sample-Cost-Usd`): a fixed sentence of about 100 characters in the language of the page, spoken with the model that is chosen (`SAMPLE_TEXTS` in `lib/voice-preview.js`). The estimate (`tools.speechEstimateUsd`, about 0.008 USD for Eleven v4) is reserved with `budget.begin` (a participant's budget must cover it: `402 BUDGET_*`), booked as a cost of type `speech` (`sessionId` `voice-preview`, on the person) and the file is stored under `data/voice-samples/` per voice, model and language, so it is paid once (requests at the same time make one). `409 PREVIEW_AVAILABLE` for a voice that has a free sample, `404` as for `preview`. |
| PATCH | `/api/brandings/:id` | Admins only (WP38f). Body `{ speaker: { voiceId, name } }` sets the speaker voice of a branding, `{ speaker: null }` removes it; any other field is `400` (the rest of a branding is changed through the Director's `update_branding`, which takes `speaker` as well). `lib/brandings.js` `normaliseSpeaker`: `voiceId` is `[A-Za-z0-9_-]{1,100}`, `name` at most 200 characters, an empty `voiceId` is no voice, the field is removed for no voice (a branding without it is the plain old shape, valid without migration). The list `GET /api/brandings` carries `speaker` only where there is one. Rule `admin`. |
| GET | `/api/nodes/higgsfield-models/:modelId` | model details + derived param schema |

### 11.2 Workflows

| Method | Route | Body → Response |
| --- | --- | --- |
| GET | `/api/workflows` | `?q=` → `{ workflows: [{ id, name, folder, updatedAt, updatedBy, nodeCount, app: {enabled}, thumbnail? }] }` (thumbnail = URL of the latest image result of an `output.result` or last image node) |
| POST | `/api/workflows` | `{ name, folder?, templateId?, document? }` → 201 `{ workflow, results }` |
| GET | `/api/workflows/:id` | `{ workflow, results, activeRun: runId \| null }` |
| PUT | `/api/workflows/:id` | `{ baseRev, graph, name?, description?, app? }` → `{ rev, updatedAt }`; 409 `{ error, rev }` if `baseRev !== rev` |
| PATCH | `/api/workflows/:id` | `{ name?, folder? }` (also renames backing session title) |
| DELETE | `/api/workflows/:id` | deletes folder + backing session; 409 while a run is active |
| POST | `/api/workflows/:id/duplicate` | new workflow (graph + app, new backing session, no results) |
| GET | `/api/workflows/:id/export` | JSON attachment `<name>.ocd-workflow.json` |
| GET | `/api/workflows/:id/export-info` | Size figures for the ZIP export (§7.6) |
| GET | `/api/workflows/:id/export.zip` | ZIP attachment `<name>.ocd-workflow.zip` with the input files (§7.6) |
| POST | `/api/workflows/import` | `{ document }` → 201 `{ workflow, results, files }` |
| POST | `/api/workflows/import-zip` | Raw ZIP body, `?folder=&name=` → 201 `{ workflow, results, files }` (§7.6) |
| GET | `/api/workflow-templates` | `[{ id, name, description, requires: ['openrouter','ffmpeg',…], available }]` |

### 11.3 Assets

| Method | Route | Notes |
| --- | --- | --- |
| POST | `/api/workflows/:id/uploads` | Raw body (`Content-Type` = file MIME, header `X-Filename`), streamed to a temp file inside the backing session asset dir, max 500 MB, extension whitelist as `extFromDataUrl` in `lib/brain.js`; SVG → additionally rasterised PNG (via `tools.storeImportedSessionAsset`). Response `{ value }` (§6.1). `express.json` does not touch non-JSON bodies, so no parser change is needed. |
| POST | `/api/workflows/:id/import-asset` | `{ sessionId, assetId }` → copies a completed asset from any chat session (`fsp.copyFile` into a temp file + `reserveAsset`/`completeAssetFile`) → `{ value }` |
| GET | `/api/workflows/:id/assets` | ledger of the backing session (for the picker "this workflow") |
| POST | `/api/workflows/:id/send-to-chat` | `{ nodeId, entry?, variant?, port?, sessionId }` → copies the asset(s) into the chat session and appends `{ role:'user', content:'[Workflow «<name>»] <assetIds>', uploadIds:[…], ts }` via `store.mutateSession`. The chat renders it with the existing upload preview (`renderDetail` → `uploadIds`); the Director sees it on the next turn. |
| GET | `/api/workflows/:id/outputs.zip` | `?runId=` (default: current selections of all `output.result` inputs) → ZIP via `archiver` |

### 11.4 Runs and events

| Method | Route | Notes |
| --- | --- | --- |
| POST | `/api/workflows/:id/runs/plan` | run request (§9.1) → plan (§9.4) |
| POST | `/api/workflows/:id/assistant` | `{ question, canvas, history?, lang?, model? }` → `{ answer, mentions, insert?, … }`: explains nodes, proposes nodes and connections (checked on the server), never runs anything; `model` is one of the language models the person may use in the chat (`GET /api/config`, `brainModels`), any other gives `403 FORBIDDEN_FOR_ROLE`, none: the model of a new chat; the budget of a participant reserves the estimated price of the question for the model that is used (also the default one), at least 5 cents; a model without a known price: the highest known price of the models the person may choose (at least 5 cents), a subscription model: nothing (the budget only concerns restricted people, who get no subscription model); see IMPLEMENTATION-NOTES, "Assistant" (server part and panel) |
| POST | `/api/workflows/:id/runs` | run request + `rev` (must equal saved rev; client flushes autosave first) → 202 `{ runId }`; 409 active run or rev mismatch; 429 limit |
| GET | `/api/workflows/:id/runs/:runId` | run record |
| POST | `/api/workflows/:id/runs/:runId/cancel` | `{ ok }` |
| PATCH | `/api/workflows/:id/results/:nodeId` | `{ entry, variant }` → updated node results (select version) |
| DELETE | `/api/workflows/:id/results/:nodeId/entries/:entryId` | delete one history entry (WP38e) → `{ ok, nodeId, removed, node: { selected, history }, files: { deleted, kept } }`; same permission as choosing a variant; 404 `ENTRY_NOT_FOUND`; 409 `RUN_ACTIVE` while a run of the workflow is active |
| DELETE | `/api/workflows/:id/results/:nodeId` | delete all results of the node (same answer, `node` is `{ selected: null, history: [] }`); 404 when the node has none |
| GET | `/api/workflows/:id/events` | SSE stream |

SSE events (`data: <json>\n\n`, `: ping` every 15 s, same headers as the chat stream). On connect the server first sends `snapshot`.

| Event | Payload |
| --- | --- |
| `snapshot` | `{ activeRun: { runId, mode, nodes: {id: status} } \| null }` |
| `run_started` | `{ runId, mode, targets, plan: {nodeId: 'cached'\|'stale'\|'forced'} }` |
| `node_status` | `{ runId, nodeId, status: 'queued'\|'running'\|'waiting_job'\|'cached'\|'done'\|'error'\|'skipped'\|'cancelled', message?, progress?: {done,total} }` |
| `node_log` | `{ runId, nodeId, label }` (mapped from tool `tool_start`, job submission etc.) |
| `node_result` | `{ runId, nodeId, entry }` (full history entry) |
| `run_cost` | `{ runId, usd, credits }` |
| `run_finished` | `{ runId, status, error? }` |
| `workflow_saved` | `{ rev, updatedBy }` (another tab/user saved → client offers reload) |
| `results_changed` | `{ nodeId, updatedBy }` (results of a node were deleted → the other tabs read the results and the plan again) |

Client uses `EventSource` (auto-reconnect); after a reconnect it calls `GET /api/workflows/:id` to reconcile.

---

## 12. Frontend architecture

### 12.1 Files (all new, classic scripts, no build)

| File | Responsibility |
| --- | --- |
| `public/nodes/nodes.css` | All node-view styles, prefix `nv-`. Uses existing `:root` tokens plus `--nv-*` tokens (§12.8). |
| `public/nodes/i18n-nodes.js` | `Object.assign(window.I18N.de/en/es, {...})` with keys prefixed `nodes.` |
| `public/nodes/edge-geometry.js` | Pure UMD maths of the edge curve and the placement of the number badges of a multi-input. |
| `public/nodes/graph.js` | Pure model: create/validate graph, add/remove/move nodes, connect/disconnect with `canConnect` + cycle check, groups/notes, clipboard serialise/paste with id remap, stale propagation helper, compatible-node filtering for the palette. UMD-style: `module.exports` in Node, `window.OCDNodes.graph` in the browser. |
| `public/nodes/history.js` | Pure undo/redo snapshot stack (UMD). |
| `public/nodes/api.js` | REST helpers (own `request()`, same error shape as `app.js api()`), upload with progress (`XMLHttpRequest`), `EventSource` wrapper. |
| `public/nodes/canvas.js` | Viewport (pan/zoom/fit), world layer, SVG edge layer, pointer handling (drag nodes, marquee, edge drag), minimap. |
| `public/nodes/node-ui.js` | Builds node cards from registry descriptors: header, ports, inline params, preview slot, status, cost badge. |
| `public/nodes/inspector.js` | Right panel: full param form (auto-generated), validation warnings, history/variant strip, actions. |
| `public/nodes/palette.js` | Search palette (categories, fuzzy search, type filter, keyboard navigation). |
| `public/nodes/workflow-list.js` | Left drawer: list, search, new, templates, rename, duplicate, delete, import/export (JSON and ZIP with files). |
| `public/nodes/archive-ui.js` | Export and import with files in the browser: JSON or ZIP by extension and first bytes, size note before a ZIP download (`export-info`), upload card with progress, the "x of y files imported" note after an import and the texts for the error codes of the import routes. |
| `public/nodes/run.js` (WP6) | Run controls, plan/confirm dialog, SSE event reducer → per-node status. Reducer is pure (UMD) for tests. |
| `public/nodes/preview.js` (WP6) | Media previews in nodes, media viewer overlay (image zoom, video, audio), downloads. |
| `public/nodes/asset-picker.js` (WP7) | Upload / "from chats" / "this workflow" picker. |
| `public/nodes/app-mode.js` (WP7) | Design App builder panel and `#app=` view. |
| `public/nodes/main.js` | Bootstrap: hash routing, view mount/unmount, state container, autosave, keyboard shortcuts, wiring of all modules. |

`public/index.html` changes (WP5): a sidebar button `<button id="nodesBtn" class="sidebar-brandings" type="button" data-i18n="sidebar.nodes" data-i18n-title="sidebar.nodesTitle">🧩 Nodes</button>` above Brandings; `<div id="nodeApp" class="nv-app hidden"></div>` before the lightbox; `<link rel="stylesheet" href="nodes/nodes.css">`; scripts after `app.js` in dependency order. The keys `sidebar.nodes`, `sidebar.nodesTitle` go into `public/i18n.js` (de/en/es) because `scripts/test-i18n.js` checks `index.html` keys there. `public/app.js` is **not** modified.

### 12.2 Layout and navigation

- `#nodeApp` is a fixed full-window layer (`position: fixed; inset: 0; z-index: 40`) — below the lightbox (50) and modals (60) so existing overlays (settings, costs, lightbox) still work on top of it.
- Routes (own `hashchange` listener in `main.js`; `app.js` ignores these keys): `#w=` (workflow list, empty canvas), `#w=<wfId>` (editor), `#app=<wfId>` (Design App). "← Chat" restores the previous `#s=<sessionId>` (kept in `sessionStorage`).
- Editor layout: top bar 48 px (back to chat, editable workflow name, save state "Saved / Saving… / Conflict", Run all ▶, Run selection, Cancel, last-run cost, App toggle, ⋯ menu), left drawer 240 px (workflow list, collapsible), canvas, right inspector 320 px (collapsible, opens on selection), bottom-left zoom controls + minimap.
- **Scene table (WP35, rest).** In the inspector of a node whose selected result holds a list (not an input or output node) a table follows the run section: one row per item with its number, a preview (an image or video as a tile that opens the viewer at that item, audio with a player, text shortened), the main text of the item (the first text input of the node: from the upstream result at the item's number, a single text for all items, else a setting of the entry such as `prompt`; the brief of an `explainer.scene` is shown by its title, else its narration or first bullet, not by its technical first line; the text is read from what is connected now, so after a change of the upstream node it may differ from what the item was made with until the next run) and its length where the value has one. Each row has "Neu erzeugen" / "Make again" and shows what one item costs or "gratis" (the table is used on a finished node, which the plan calls `cached`; the plan then gives the price of one execution as `itemEstimate` for such a paid node, which is not counted in the totals of the run); ticked rows are made again together with "Ausgewählte neu erzeugen". Both send `{ mode: 'items', nodeId, items }` through the same `startRun` as every run: plan, the confirmation of the cost for paid nodes (the sum of the items that really run), budget and rights. The buttons work only where the selected entry has the key of every item (`itemKeys`, §9.3); an older result or a node that makes its list as a whole shows the rows with a note instead. Scenes are not swapped or moved. At phone width a row keeps number, preview and text in two lines and the button gets the full width. Files: `public/nodes/scene-table.js` (pure data), `inspector.js` (`renderScenes`), `run.js` (`inspectorApi.scenes`, `runItems`), `nodes.css` (`.nv-scene*`).
- Look: same dark palette as the chat (`docs/screenshots/chat.png`): `--bg` canvas with a subtle dot grid (`--line-soft`), node cards `--bg-panel` with `--line` border and `--radius`, selected = `--accent` outline, headers in the small uppercase letter-spaced style of "CREATIVE DIRECTOR", amber primary buttons like "Send".

### 12.3 State and rendering

A single state object in `main.js`: `{ registry, workflow, rev, results, selection:Set, viewport, plan, run: { runId, nodeStatus:{} }, saveState, clipboard }`. Mutations go through `graph.js` functions returning a new graph; `main.js` then calls `canvas.render(changedIds)`. Rendering is DOM-diffing by id: node cards are created once and patched (position via `transform`, params, status classes, preview); edges are recomputed per frame only for nodes being dragged. Target: smooth at 200 nodes. Text from LLM outputs and user input is always set via `textContent` (never `innerHTML`).

### 12.4 Interactions

- Left-drag on empty canvas = marquee select (Shift adds). Pan = Space+drag, middle-drag, or two-finger trackpad scroll; zoom = Ctrl/Cmd+wheel or pinch, range 0.1–2.5, zoom to cursor.
- Drag node header to move (all selected move together); snap to 8 px grid with Alt to disable.
- Drag from an output port: temporary bezier follows the cursor; compatible input ports highlight, incompatible ones dim. Drop on a port → connect. Drop on empty canvas → palette opens at the cursor, filtered to node types with a compatible input; choosing one places it there and auto-connects the first compatible port. Same in reverse from an input port.
- Dragging from a connected input port detaches that edge (re-route or drop to delete).
- Double-click canvas / `Tab` / `/` → palette. Double-click node title → rename.
- Drag files from the desktop onto the canvas → creates the matching input node and uploads.
- Right-click node → context menu (run, run from here, duplicate, delete, send to chat, copy asset URL). **Use as text** (WP30) is there for a node whose selected result has exactly one plain text (any category except inputs and outputs): `graph.adoptTextAsPrompt` puts the text into a new `input.prompt` below the node and moves the connections that leave this output to it (same targets, same order, same edge ids); one undo step, nothing runs, the new node is selected. With several text results (several text outputs, a list of texts) or an empty text the entry is shown disabled with the reason as a hint line; nodes without a text result do not show it. The inspector offers the same command next to Open / Download.

### 12.5 Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Tab`, `/`, double-click | Open palette |
| `Delete` / `Backspace` | Delete selection |
| `Cmd/Ctrl+C`, `X`, `V` | Copy, cut, paste (at cursor) |
| `Cmd/Ctrl+D` | Duplicate |
| `Cmd/Ctrl+A` | Select all |
| `Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z` (`Ctrl+Y`) | Undo, redo |
| `Cmd/Ctrl+Enter` | Run selection (force targets) |
| `Shift+Cmd/Ctrl+Enter` | Run all |
| `Esc` | Close palette/menus, clear selection; during a run it does **not** cancel |
| `F` / `Shift+1` | Fit to view (selection if any) |
| `Cmd/Ctrl+0` | Zoom 100 % |
| `Cmd/Ctrl+G` | Group selection |
| `N` | New sticky note at cursor |
| Arrow keys (+Shift) | Nudge 1 px (10 px) |

Shortcuts are ignored while focus is in an input, textarea or contenteditable.

### 12.6 Undo/redo model

Snapshot stack of `graph` (nodes, edges, groups, notes — not viewport, not results), max 100 entries. A snapshot is pushed after each committed action: add/delete/connect/disconnect, move (on pointer-up), paste/duplicate, group/ungroup, param change (coalesced per node+param with 500 ms debounce). Undo/redo restore the snapshot, re-render and trigger autosave. Variant selection is not undoable (server-side result state).

### 12.7 Autosave

Debounced 800 ms after any graph change and immediately before a run: `PUT /api/workflows/:id { baseRev, graph, name, app }`. On success store the new `rev` and request `plan`. On 409 show a banner "Changed elsewhere — Reload / Overwrite" (Overwrite = refetch rev, re-PUT). On network error retry with backoff and show "Offline — not saved". `beforeunload` warns when unsaved.

### 12.8 i18n and CSS tokens

- i18n prefix `nodes.`: e.g. `nodes.toolbar.runAll`, `nodes.status.running`, `nodes.category.image`, `nodes.type.image.generate.label`, `nodes.param.aspect_ratio`, `nodes.error.unavailable`. Every registry type and category must have a label key in de/en/es (test). Dynamic Higgsfield model names are shown raw. Swiss spelling rule (no "ß") applies to all languages.
- New tokens in `nodes.css` (`.nv-app` scope, derived from `:root`): `--nv-grid: var(--line-soft)`, `--nv-node-bg: var(--bg-panel)`, `--nv-node-head: var(--bg-raised)`, `--nv-node-border: var(--line)`, `--nv-selected: var(--accent)`, `--nv-port-text`, `--nv-port-number`, `--nv-port-image`, `--nv-port-video`, `--nv-port-audio`, `--nv-port-any`, `--nv-status-running: var(--accent)`, `--nv-status-done: #5fd3a2`, `--nv-status-error: var(--danger)`, `--nv-status-stale: #e5c07b`.

---

## 13. Execution UX (WP6)

- Status on each card: dot + label (queued / running with elapsed time / waiting for provider / cached / done / error / skipped / cancelled); running cards get an animated amber border; errors show the message on the card and in the inspector with "Retry".
- Stale badge from the plan ("will re-run"); cached badge after runs.
- Previews: image (`<img>`, click → viewer), video (`<video muted loop playsinline controls>` with poster = first frame when available), audio (`<audio controls>`), text (scrollable, max 8 lines, copy button), lists (grid of up to 12 thumbnails + "+N"), numbers (value).
- Variants: pager "2 / 4" on the card; inspector shows the history strip (entries newest first, variants as thumbnails, cost, time, user); clicking selects (`PATCH results`) and downstream nodes become stale.
- Costs: badge per node (last actual USD or "≈ N credits"), run total in the top bar, confirmation dialog for paid runs (plan totals, unknowns, Higgsfield credits hint, note that cancel does not refund).
- Downloads: per output (`<a download>` on the asset URL), "Download outputs (ZIP)" in the ⋯ menu.
- Run controls: Run all / Run selection / ▶ per node / "Run from here" (node + descendants: `mode:'selection'` with node and all descendants) / Cancel with warning when provider jobs are in flight.

---

## 14. Design App mode (WP7)

- Builder: in the editor's App panel the user toggles "Expose" next to any param in the inspector (adds `{ node, param, label }` to `workflow.app.inputs`) and next to `output.result` nodes (outputs). Media input nodes can be exposed as a whole (upload field). `input.text_list` / `input.media_list` exposure enables batch.
- `#app=<wfId>` renders a clean page (same theme, no canvas): title, description, auto-generated form fields (same param widgets as the inspector), Run button, result gallery (outputs of the run, with variants, download, "Send to chat"), run status line and cost.
- Run = `POST /runs { mode:'all', overrides }` where overrides are the form values; uploads go to the backing session first. Results land in the normal `results.json`, so the builder sees them too.
- Access = same login as the whole app (whoami); anyone who can open Open CD can use the app. Public links are later.
- Validation: exposed params must exist; app outputs must reference `output.result` nodes (checked on save and in tests).

---

## 15. Templates (WP7)

JSON files in `lib/nodes/templates/<id>.json` (same format as export plus `id`, `requires`). Each is validated by a test against the registry. `available` = all `requires` satisfied.

| ID | Name | Graph | Requires |
| --- | --- | --- | --- |
| `hero-variants` | Product hero, 4 variants | text → prompt enhancer → image.generate (count 4) → image.resize → output | openrouter, ffmpeg |
| `video-cutout-overlay` | Cut out an object and place it over another video | `input.video` → `fal.video_segment` (`output: cutout`, object `person`) → `video.overlay_video` (layer; the background is a second `input.video`) → `output.result`. App: video with the object, background video, object. The description names the price of the segmentation (0.005 USD per 16 frames, about 0.075 USD for 10 s at 24 fps) and that Safari does not show the transparency of the intermediate result | fal, ffmpeg |
| `replace-people-in-video` | Replace people in a video | `input.video` + two `input.image` → `fal.video_edit` (Kling O3, `image_role: elements`, prompt with "Image 1" / "Image 2" and "Video", `cut_to_limit` off) → `output.result`. App: video, the two photos, the prompt. The description, the note and the app text say to use only people who have agreed to appear, and the description names the price (0.14 USD per second of the video, about 2.10 USD for 15 s) | fal |
| `image-to-ad` | Still to vertical ad with voice-over | image input + text → image describer → template → Seedance i2v; text → TTS → video.merge_audio → output | openrouter, elevenlabs, ffmpeg |
| `series-shots` | Consistent character series (batch) | reference image + text_list of scene prompts → image.edit (map) → Seedance i2v (map) → video.concat → output | openrouter, ffmpeg |
| `frame-chain` | Continuous shots via last frame | Seedance t2v → extract_frame(last) → Seedance i2v → concat → output | openrouter, ffmpeg |
| `motion-title` | Motion title over footage | text brief → llm.motion_html → video.motion_graphics (with video asset) → output | openrouter, rendernode |
| `masked-edit` | Masked edit (approximate inpainting) | image + mask upload + prompt → image.edit → image.mask_apply → image.composite onto original → output | openrouter, ffmpeg |
| `video-with-music` | Video with music | video + prompt → `audio.music` (`match` = the video, instrumental) → `video.merge_audio` (mix, music 0.3, original 1) → output. App: video, description, vocals off/on, volume of the music | elevenlabs, ffmpeg |
| `song-from-idea` | Song from an idea | prompt → `audio.music_plan` → `audio.music` (`plan`) → output. App: idea, length of the song text. To edit the text, "Use as text" on the plan node | elevenlabs |
| `music-video` | Music video from a song | song + photo → `audio.beats` and `audio.lyrics_timing` (optional lyrics) → `music_video.plan` (idea required) → two `text.template` (keep the person of the photo) → `image.edit` ×2 (story and singer images, the photo as reference) → `fal.h3_video` (model turbo, 768P, 5 s, 0.04 USD a second = 0.20 USD a clip; first frame = story image, prompt = the motion of the scene; not `video.generate`, because Seedance stops the run with `VIDEO_REAL_PERSON` on images of the person of the photo; switch to the model max or to 1080P for more quality) and `fal.h3_lipsync` (singer image + the song slice) → `music_video.edit` (song, plan, both clip lists, and the lyric times of `audio.lyrics_timing` on its input `captions`) → output. All the lists run through the implicit map. App: song, photo, idea (`n5.brief`, the run does not start without it), lyrics, main person, scenes per minute, share of singer scenes, transition, captions (`n12.captions`: off / karaoke / words / lines; the cut ships `captions: karaoke`, `captions_position: bottom`, so the sung words are burnt in as karaoke captions - on a server whose ffmpeg has no libass the run is refused with `CAPTIONS_NO_LIBASS` until the person sets the captions to off). About 13 scenes per minute with an image and a clip each: a 2-minute song costs about 11 USD with the preset settings (24 story clips at 0.20 = 4.80, 28 images at about 0.13 = 3.75, four singer scenes of about 7 s in 768P about 2.40, plan and times a few cents), roughly 5 to 20 depending on the number of scenes, the image model and the video settings. The prices of the steps after the plan are unknown before it has run (the number of scenes comes from it): the gallery counts a node behind a list that another node makes as unknown (`costSummary`, also `fal.h3_video` with its price table), so the template shows as unknown and the card of the chat asks to accept unknown steps; the plan prices the story clips as clips × 0.20 USD once the plan node has run; once everything before the lip sync is up to date, it is priced from the length of the song slices (`fal.h3_lipsync` estimates from `context.inputs.audio`) | openrouter, elevenlabs, fal, ffmpeg |
| `music-video-stills` | Music video from a song (moving images) | the same chain as `music-video` (same inputs, same app inputs, same cut with captions), but the story scenes are not made into AI clips: `image.to_video` (zoom `varied`, 5 s = the clip length of the plan, 25 fps = the fps of the cut, no audio) takes each story image of `image.edit`, so `fal.h3_video` and the motion text of the plan (`story_motion`) are not used. The singer scenes keep `fal.h3_lipsync`. Only the images and the lip sync are paid: a 2-minute song costs about 6 USD with the preset settings (28 images at about 0.13 = 3.75, four singer scenes of about 7.5 s in 768P at 0.08 USD a second = 2.40, plan and times a few cents), roughly 3 to 10 depending on the number of scenes and the image model, against about 11 USD with video clips; the description of the template names it and the template test computes it from the price tables. The motion is `varied`: the story scenes take zoom in, pan right, zoom out, pan left in turn by their position (§5.10), and the optional parallax (switch `n14.enabled`, off by default, then free) makes a depth map of every story image with `fal.depth_map` for a more spatial picture; a scene longer than the clip length holds the last frame of its motion, a shorter one uses the start of it. The gallery counts it as unknown like `music-video` (the number of scenes comes from the plan), six paid steps (the depth maps among them, which cost nothing while their switch is off). | openrouter, elevenlabs, fal, ffmpeg |
| `explainer-script` | Explainer video: script from a PDF | `input.document` → `doc.read` → `explainer.plan` (text and the PDFs as files) → two `output.result` (script, sources). App: file, what matters most, language (starts with `auto`, same as input), length. Requires openrouter, poppler. The description names the order of magnitude (about 0.50 to 0.90 USD for 20 pages and 2 minutes); the plan shows no price until the document has been read. Description and note end with: use only PDFs you have the rights to; figures from the PDF can appear in the video made from the script (en, de, es; WP33c). | openrouter, poppler |
| `explainer-script-topic` | Explainer video: script for a topic | `input.prompt` → `llm.research` (notes and sources) → `explainer.plan` → two `output.result`. App: topic, what matters most, language (starts with `auto`, same as input), length. The description names about 0.30 to 0.50 USD for 2 minutes | openrouter |
| `explainer-video` | Explainer video from a PDF | `input.document` → `doc.read` (`page_images: all`) + `input.branding` → `explainer.plan` (`clips: false`) → `explainer.voice` (narration with `narration_context`), `image.generate` (the prompts of the stills) → `explainer.scene` (brief, timing, brand, stills, `pages`, `shots`, `pages_info`) → `explainer.edit` (scenes, voices, timing, shots, `music` from `audio.music`: instrumental, 120 s, about 0.40 USD) → three `output.result` (video, subtitles, script). App: file, branding, what matters most, language, length, voice, captions. The note and the description say: run only the planner first, read the script, edit it in `script` and run everything; about 2.50 to 3.50 USD for 20 pages and 2 minutes (script 0.50–0.90, voice about 0.15, scenes about 0.10 each, music about 0.40, a few cents per still). The logo of the branding is not wired (a branding that is not chosen has no logo, and an input that waits for it stops the plan with `OUTPUT_EMPTY`); the note says how to wire it. Description and note end with: use only PDFs you have the rights to; figures from the PDF appear in the video (en, de, es; WP33c). | openrouter, poppler, elevenlabs, rendernode, ffmpeg |
| `explainer-video-topic` | Explainer video for a topic | `input.prompt` ×2 → `llm.research` → `input.branding` → `explainer.plan` → the same chain as above → four `output.result` (video, subtitles, script, sources). About 2 to 3 USD for 2 minutes (with the music) | openrouter, elevenlabs, rendernode, ffmpeg |
| `explainer-video-presenter` | Explainer video with a presenter (portrait) | the topic chain in `portrait` (`image.generate` with 9:16, `explainer.scene` `format: portrait`) with `presenter: intro_outro`: `presenter` (the two lines) → a second `explainer.voice` (`use_context: false`) → `fal.h3_lipsync` (photo of the presenter + voice, 768P) → two `util.pick` (index 0 and −1 of the two clips) → `intro` and `outro` of `explainer.edit`. App: topic, what matters most, photo, branding, languages, length, two voices. The note and the description name the consent of the person in the photo and about 4 to 5 USD for 2 minutes (the music included) | openrouter, elevenlabs, rendernode, ffmpeg, fal |
| `typography-video` | Typography video for a topic | `input.prompt` ×2 → `llm.research` → `input.branding` → `explainer.plan` (`visual_mode: typography`, `clips: false`, 90 s, `language: auto`) → `explainer.voice` → `explainer.scene` (`vision_check`) → `explainer.edit` (+ `audio.music`, instrumental, 90 s) → four `output.result`; no picture and no clip node, no fal.ai or Poppler. About 3.80 to 4 USD for 90 s (an estimate from one test run: research and script 0.30 to 0.50, voice about 0.10, about 11 scenes at 0.28, music 0.30; the music 0.30 is the only price known beforehand). |
| `typography-video-text` | Typography video from your own text | `input.prompt` (the text) → the input `own_text` of `explainer.plan`, `input.prompt` (wishes) → `brief`, `input.branding`, the same chain as above; no research, three `output.result` (video, subtitles, script). About 3.70 USD for 90 s of text (an estimate from one test run: script about 0.20 at 0.06 for 75 words, voice about 0.10, about 11 scenes at 0.28, music 0.30). |

WP38f: in all three explainer templates the output `voice` of `input.branding` (`n3`) is connected to the input `voice` of every `explainer.voice` (`n5`, and `n12` of the presenter version). The description and the note end with: the voice comes from the branding if it has a speaker voice, otherwise the voice chosen in the node applies (en, de, es); the Design App labels of the voices add "(if the branding has none)".

---

## 16. Auth and scoping

- With user management (`AUTH_WHOAMI_URL` set, see the README) workflows follow the same rules as chats: new workflows are private to their owner and can be shared with the team or selected people (`owner`, `shareMode`, `sharedWith` in `workflow.json`, kept in step on the backing session); workflows without an owner stay open to everybody; a workflow somebody may not use answers 404 on every route, its files and its event stream. Without `AUTH_WHOAMI_URL` (local mode) nothing is filtered. `createdBy`, `updatedBy`, run `user` and cost journal `user` come from `req.kubleUser` (`lokal` without `AUTH_WHOAMI_URL`).
- No admin requirement for building or running (same as chat). Settings (keys, nodes, Higgsfield) stay admin-only as today.
- Input validation: all IDs via `store.isValidId`; uploads: extension whitelist, 500 MB cap, temp file inside the session asset dir; import: 2 MB, schema validation; HTML for motion graphics is only sent to render nodes, never rendered in the app DOM; LLM text is rendered with `textContent`.
- `PUBLIC_BASE_URL` requirements are surfaced as node validation warnings, not as runtime surprises.

---

## 17. Chat bridge

Now (WP7): asset picker "From chats" (lists sessions via `GET /api/sessions`, assets via `GET /api/sessions/:id`) → `import-asset`; "Send to chat" on outputs (§11.3); workflows can be assigned to a project (`folder`) so the backing session shares the project context.

Later (phase 2): Director tool `run_workflow { workflow_id, inputs }` (uses the Design App schema as the tool's argument schema, starts a run, returns immediately, posts results into the chat via the job-update message path), "Build a workflow from this chat" (Director emits a workflow document), "Open in node view" button on chat asset cards (needs a small `app.js` change in `mediaCard`), cast and branding input nodes.

---

## 18. Test strategy

- Plain Node scripts under `scripts/`, `assert/strict`, no network: provider functions are monkey-patched on their module objects (`or.createImage`, `or.createVideo`, `or.postJson`, `higgsfield.mcpCall`, `elevenlabs.tts`, `elevenlabs.listVoices`, `rendernode.submit`, `chatgpt.streamResponses`, `discovery.brainSupportsImages`, `costs.recordCost`), and restored in `finally`.
- Async jobs are simulated by mutating the backing session (`store.mutateSession` → job `completed`, `store.completeAsset`) while `waitForSessionJob` polls with a short interval (tests pass `intervalMs: 20`).
- ffmpeg tests run real ffmpeg on generated inputs (`-f lavfi -i testsrc`, `color`, `sine`) when `ffmpeg.binaries().available`; otherwise they print `SKIP ffmpeg fehlt` and exit 0. Pure argument builders are always tested.
- Frontend pure modules (`graph.js`, `history.js`, `run.js` reducer, `i18n-nodes.js`) are loaded with `require()` (UMD) or `vm.runInNewContext` as in `scripts/test-i18n.js`.
- Route tests call handlers through `app._router.stack` like `scripts/test-api-handlers.js`; SSE route tested with a fake `res` that records `write` calls.
- Every test creates its own workflows/sessions and deletes them in `finally` (tests write to the real `data/`, `projects/`, `assets/` like the existing ones).
- Regression suite after every package: `node scripts/test-api-handlers.js`, `node scripts/test-session-meta.js`, `node scripts/test-folders.js`, `node scripts/test-i18n.js`, `node scripts/test-concat-videos.js`, `node scripts/test-higgsfield.js`, `node scripts/test-video-frames.js`.

---

## 19. Work packages

Strictly sequential; one implementation agent (Claude Sonnet 5.5) per package. Each package may only create/modify the files listed. Never touch `render-node/jobs/` or `render-node/package-lock.json`. No commits unless the orchestrator asks.

### WP1 — Engine and data foundation (backend, no HTTP)

Scope: port types + compatibility, registry framework, basic nodes (§5.1, §5.2), workflow store (workflow/results/runs files, rev, export/import validation), backing-session support in `lib/store.js`, poller include flag, engine (plan, topo, cache, force, overrides, lists, errors, cancel, pool, events), job waiting, asset helpers.

Files: create `lib/nodes/types.js`, `lib/nodes/registry.js`, `lib/nodes/nodes-basic.js`, `lib/nodes/engine.js`, `lib/nodes/events.js`, `lib/nodes/workflows-store.js`, `lib/nodes/assets.js`, `lib/nodes/jobs.js`, `scripts/test-nodes-types.js`, `scripts/test-nodes-engine.js`, `scripts/test-nodes-store.js`; modify `lib/store.js` (`createSession({ folder, role, kind, title })`, session field `kind`, `listSessions({ includeHidden })` skipping `kind === 'workflow'` by default), `lib/poller.js` (`pollOnce` → `listSessions({ limit: Infinity, includeHidden: true })`).

Read first: `lib/store.js` (`createSession`, `listSessions`, `withLock`, `mutateSession`, `saveAsset`, `reserveAsset`, `completeAssetFile`, `readLedger`, `assetUrl`, `isValidId`), `lib/poller.js` (`pollOnce`, `handleCompleted`), `lib/tools.js` (`executeTool`, `runConcatVideos` for the reserve/complete pattern), this spec §6, §7, §8, §9.

Acceptance: engine runs a graph of fake executors in correct topo order with max parallelism respected; cache hit skips execution; `force` re-executes only targets; changing a param or upstream selection makes descendants stale in `plan`; error blocks descendants and lets independent branches finish; cancel marks pending nodes `cancelled` and aborts a waiting executor; list input maps per item with zip semantics; overrides change the key but not the saved graph; `waitForSessionJob` resolves on `completed` (returns `resultAssetIds`), rejects on `failed`/abort; workflow CRUD with rev conflict; import rejects cycles/dangling edges and keeps unknown types; `GET /api/sessions` no longer lists workflow sessions while the poller still sees them; all regression tests pass.

Tests: `node scripts/test-nodes-types.js`, `node scripts/test-nodes-engine.js`, `node scripts/test-nodes-store.js`, plus the regression suite (§18).

### WP2 — REST/SSE API, uploads, asset import

Scope: all routes of §11 except `outputs.zip`, `send-to-chat` and `workflow-templates` (WP6/WP7), SSE with snapshot/ping, raw streamed uploads with size cap, import-asset from chat sessions, startup marking of interrupted runs, backing-session title sync on rename.

Files: create `lib/nodes/routes.js`, `scripts/test-nodes-api.js`; modify `server.js` (require + `registerNodeRoutes(app, { runtime, publicRuntimeConfig, engine })` before `app.get('*')`, engine creation, interrupted-run sweep in `startServer`), `lib/nodes/workflows-store.js` / `lib/nodes/assets.js` only if needed for route helpers.

Read first: `server.js` (`fail`, `requireSessionId`, `POST /api/sessions/:id/message` SSE block, `publicRuntimeConfig`, `startServer`, catch-all), `scripts/test-api-handlers.js` (`routeHandler`, `invoke`), `lib/brain.js` (`extFromDataUrl` whitelist), spec §11.

Acceptance: every route returns the documented shapes and status codes (400 invalid id, 404 unknown workflow, 409 rev/active run, 413 upload too large, 429 run limit); upload stores a ledger asset and returns a typed value; SVG upload returns 415 until WP3 exports `storeImportedSessionAsset`; import-asset copies a completed chat asset and rejects pending ones; SSE handler writes correct headers, a `snapshot` first, forwards bus events and cleans up on close; `GET /api/nodes/registry` lists WP1 node types with availability.

Tests: `node scripts/test-nodes-api.js` + regression suite.

### WP3 — Generative nodes (LLM, image, video, audio, Higgsfield)

Scope: §5.3–§5.6, dynamic Higgsfield catalogue (§10), `extra_params`, experimental Higgsfield edit nodes (§5.8), option sources, SVG raster in uploads.

Files: create `lib/nodes/llm.js`, `lib/nodes/nodes-generate.js`, `lib/nodes/higgsfield-catalog.js`, `scripts/test-nodes-generate.js`; modify `lib/nodes/registry.js` (load module), `lib/nodes/routes.js` (options sources, higgsfield model route, SVG upload), `lib/tools.js` (export `storeImportedSessionAsset`, `RENDER_MOTION_GRAPHICS_DEFINITION`, `IMAGE_RATIOS`, `VIDEO_RATIOS`, `VIDEO_RESOLUTIONS`; `extra_params` in `runHiggsfieldGeneration`; extract `submitHiggsfieldJob`; add `higgsfield_edit` executor to `EXECUTORS` only).

Read first: `lib/tools.js` (`runGenerateImage`, `runEditImage`, `storeImageResult`, `runGenerateVideo`, `buildVideoPayload`, `runGenerateSpeech`, `runRenderMotionGraphics`, `renderAssetsFromIds`, `runConcatVideos`, `runHiggsfieldGeneration`, `importHiggsfieldReferences`, `referenceRoleFromModel`, `EXECUTORS`, `toolDefinitions`), `server.js` `/api/roles/generate` (non-stream LLM + cost), `lib/brain.js` `recordBrainUsage`, `lib/chatgpt.js` (`streamResponses`, `messagesToInput`), `lib/discovery.js` (`brainSupportsImages`, `videoCapabilities`), `lib/poller.js` (`extractVideoFrames`, `handleHiggsfieldCompleted`), `docs/higgsfield-tools.json` (models_explore output schema, edit tool schemas), `scripts/test-higgsfield.js`, spec §5, §10.

Acceptance (all with mocks): image.generate with `count: 3` yields 3 variants and 3 cost journal calls; image.edit passes reference ids; Seedance node chooses `image_to_video` when `first_frame` is connected, waits for the simulated job and returns the completed asset; Higgsfield node forwards whitelisted `extra_params` and drops unknown ones, turns `resultAssetIds` into variants; motion node replaces `{{asset:N}}` placeholders; LLM node routes `chatgpt/*` to `streamResponses`, others to `postJson`, rejects images for non-vision models, journals `brain` cost; video describer sends 3 frames; catalogue maps model params to the param schema and caches; experimental edit nodes are unavailable without Higgsfield or `PUBLIC_BASE_URL`; Director `toolDefinitions()` is unchanged (snapshot compare of tool names); `scripts/test-higgsfield.js` still passes.

Tests: `node scripts/test-nodes-generate.js`, `node scripts/test-higgsfield.js`, `node scripts/test-video-media-references.js`, `node scripts/test-render-motion-assets.js` + regression suite.

### WP4 — Editing nodes (ffmpeg / resvg)

Scope: §5.7 and `image.svg_rasterize`, `image.text_render`.

Files: create `lib/nodes/ffmpeg-ops.js`, `lib/nodes/nodes-edit.js`, `scripts/test-nodes-ffmpeg.js`; modify `lib/ffmpeg.js` (export `runProcess`, optional `signal` that kills the child), `lib/nodes/registry.js` (load module).

Read first: `lib/ffmpeg.js` (`runProcess`, `binaries`, `probeVideo`, `reencodeConcatArgs` style), `lib/tools.js` (`runConcatVideos` scratch-dir + `completeAssetFile` pattern, `storeImportedSessionAsset` resvg call), `lib/poller.js` (`extractVideoFrames` arguments), `scripts/test-concat-videos.js` (binary stubs), spec §5.7.

Acceptance: pure builders produce the documented filter strings for every op (asserted without ffmpeg); with ffmpeg present each op transforms a generated test input and ffprobe confirms dimensions/duration/alpha where relevant; abort kills a long ffmpeg process; ops are unavailable without ffmpeg; outputs are ledger assets of the right kind; concat regression passes.

Tests: `node scripts/test-nodes-ffmpeg.js`, `node scripts/test-concat-videos.js`, `node scripts/test-video-frames.js` + regression suite.

### WP5 — Frontend editor core

Scope: §12.1–§12.8 without run UX: node view mount and routing, workflow list drawer, canvas (pan/zoom/fit/grid/minimap), node cards from registry, ports and edge drawing with type checks, palette incl. drag-to-empty auto-connect, inspector with auto-generated params (option sources), selection/marquee, move/delete/duplicate/copy/paste, notes, groups, undo/redo, shortcuts, autosave with conflict banner, import/export, uploads via input nodes (basic picker: upload only), i18n de/en/es, styling in the existing look.

Files: create `public/nodes/nodes.css`, `public/nodes/i18n-nodes.js`, `public/nodes/graph.js`, `public/nodes/history.js`, `public/nodes/api.js`, `public/nodes/canvas.js`, `public/nodes/node-ui.js`, `public/nodes/inspector.js`, `public/nodes/palette.js`, `public/nodes/workflow-list.js`, `public/nodes/main.js`, `scripts/test-nodes-graph.js`, `scripts/test-nodes-history.js`, `scripts/test-nodes-i18n.js`; modify `public/index.html` (button, container, stylesheet, scripts), `public/i18n.js` (`sidebar.nodes`, `sidebar.nodesTitle` in de/en/es only).

Read first: `docs/screenshots/chat.png`, `public/styles.css` (`:root` tokens, `.sidebar-brandings`, `.modal`, `.lightbox`, buttons), `public/index.html` (sidebar-foot, script order), `public/i18n.js` (`t`, `applyI18n`, dictionaries), `public/app.js` (`api`, `rel`, `openLightbox`, `sessionIdFromHash`, `hashchange` handler), `scripts/test-i18n.js`, spec §6, §7.1, §12, `GET /api/nodes/registry` shape (§11.1).

Acceptance: `#w=` opens the node view, "← Chat" returns to the last chat; create a workflow, add nodes via palette (search + categories), connect compatible ports, incompatible drops are refused; drag-to-empty opens a filtered palette and auto-connects; marquee, move, delete, duplicate, copy/paste across two workflows, notes and groups work; undo/redo restores every action; reload shows the same graph (autosave); a second tab saving triggers the conflict banner; export → import round-trips; all visible strings translated in de/en/es; chat view unchanged; manual check at 1440×900 and 1280×720 with 50 nodes stays smooth.

Tests: `node scripts/test-nodes-graph.js`, `node scripts/test-nodes-history.js`, `node scripts/test-nodes-i18n.js`, `node scripts/test-i18n.js` + regression suite; manual smoke via `npm start`.

### WP6 — Execution UX, previews, history, costs, downloads

Scope: §13: run controls (node ▶, selection, all, run from here, cancel), plan-based stale badges and paid-run confirmation, SSE client and status reducer, in-node previews, media viewer, variant pager and history strip with selection, cost badges and totals, downloads and outputs ZIP route.

Files: create `public/nodes/run.js`, `public/nodes/preview.js`, `scripts/test-nodes-run-client.js`; modify `public/nodes/main.js`, `public/nodes/node-ui.js`, `public/nodes/inspector.js`, `public/nodes/nodes.css`, `public/nodes/i18n-nodes.js`, `lib/nodes/routes.js` (`outputs.zip` via `archiver`), `scripts/test-nodes-api.js` (ZIP case).

Read first: spec §9.4, §11.4, §13; `public/nodes/main.js`, `node-ui.js`, `inspector.js` from WP5; `public/app.js` (`mediaCard`, `formatCost`, `openLightbox`); `server.js` branding export (`archiver` usage in `GET /api/brandings/:id/export`).

Acceptance: running a mocked or cheap workflow shows live statuses, cached badges and results without reload; reconnecting SSE mid-run restores state; variants can be paged and selected, making descendants stale; paid runs require confirmation with plan totals; cancel warns about in-flight provider jobs; downloads and ZIP work; reducer tests cover every event type.

Tests: `node scripts/test-nodes-run-client.js`, `node scripts/test-nodes-api.js`, `node scripts/test-nodes-i18n.js` + regression suite; manual run of `hero-variants`-like graph with a real key only if the user approves the cost.

### WP7 — Design App, templates, batch UI, chat bridge, docs

Scope: §14, §15, §17 (now-part): app builder + `#app=` view with batch inputs, six templates with validation and "New from template", asset picker (upload / from chats / this workflow), send-to-chat route and UI, workflow ↔ project assignment, README sections (EN/DE) describing the node view.

Files: create `public/nodes/app-mode.js`, `public/nodes/asset-picker.js`, `lib/nodes/templates.js`, `lib/nodes/templates/hero-variants.json`, `image-to-ad.json`, `series-shots.json`, `frame-chain.json`, `motion-title.json`, `masked-edit.json`, `scripts/test-nodes-templates.js`, `scripts/test-nodes-app.js`; modify `lib/nodes/routes.js` (`workflow-templates`, `send-to-chat`, template creation in `POST /api/workflows`), `public/nodes/main.js`, `inspector.js`, `workflow-list.js`, `node-ui.js`, `nodes.css`, `i18n-nodes.js`, `README.md`, `README.de.md`.

Read first: spec §14, §15, §17, §11.2–§11.3; `lib/store.js` (`mutateSession`), `public/app.js` `renderDetail` (how `uploadIds` render), `server.js` `GET /api/sessions/:id`, WP5/WP6 frontend modules.

Acceptance: every template validates (known types, compatible edges, no cycles, app references valid) and loads; app view runs with overrides and shows outputs; a text list with 3 items produces 3 results in the app; picker imports an asset from a chat; send-to-chat shows the asset as an upload bubble in the target chat and the Director receives the text note; README sections exist in EN and DE.

Tests: `node scripts/test-nodes-templates.js`, `node scripts/test-nodes-app.js`, `node scripts/test-nodes-api.js`, `node scripts/test-nodes-i18n.js` + regression suite.

---

## 20. Risks

1. **Cost surprises** (batch × video generation). Mitigation: plan endpoint, mandatory confirmation for paid runs, list cap 50, cancel warning; Higgsfield credits shown as estimates.
2. **Backing sessions leaking into chat features** (sidebar, search, poller messages). Mitigation: opt-in `includeHidden`, title prefix `Workflow:`, tests on both `GET /api/sessions` and the poller.
3. **Unverified provider behaviour** for Higgsfield edit tools, masks and transparent backgrounds. Mitigation: experimental badge, capability gating, open questions below.
4. **Frontend size** (WP5 is the largest package). Mitigation: pure modules first (`graph.js`, `history.js`), registry-driven UI, no per-node client code.

## 21. Open questions

1. Should workflows stay team-visible like chats, or be private per user when `AUTH_WHOAMI_URL` is set? — Decided (2026-09-29): team-visible. **Superseded (2026-09-30): with `AUTH_WHOAMI_URL` new chats and workflows start private and can be shared (team or selected people); existing ones without an owner stay visible to all.** `createdBy` / `updatedBy` are still recorded.
2. Higgsfield edit tools (`remove_background`, `upscale_*`, `outpaint_image`, `reframe`): one live verification of the response/job format is needed (costs credits). Should local users get a `media_upload` (presigned PUT) path so references work without `PUBLIC_BASE_URL`? — **Decided (2026-09-29): shipped as experimental nodes, untested against the live API; no `media_upload` path** (they need Higgsfield and `PUBLIC_BASE_URL`). The live verification itself is **open** (costs credits). **Update (2026-09-29, phase 2c): the `media_upload` (presigned PUT) path now exists**; the Higgsfield nodes no longer need `PUBLIC_BASE_URL` (IMPLEMENTATION-NOTES §2.6).
3. Does OpenRouter's `/images` endpoint accept a mask or `background: transparent` for GPT Image 2? If yes, true inpainting and transparent generation move from "later" to "now". — **Decided (2026-09-29): no mask for OpenRouter images** in v1; inpainting stays the approximation of the "Masked edit" template. Whether the endpoint accepts a mask or a transparent background remains **open** (unverified).
4. Is "last actual cost" an acceptable pre-run estimate for GPT Image 2 and Seedance, or should a small price table be maintained in `config.json`? — **Decided (2026-09-29): last actual cost** (per node type in the workflow), otherwise "unknown"; no price table.
5. ElevenLabs costs are not journaled today — keep it that way for nodes? — **Decided (2026-09-29): keep it**; ElevenLabs costs are not journaled.
6. Deleting a workflow deletes its generated assets (backing session). Acceptable, or archive instead? — **Decided (2026-09-29): acceptable**; deleting removes the backing session including all assets, after an in-app confirmation.
7. Canvas control default: marquee on left-drag (Figma) vs. pan on left-drag (Weavy)? Spec uses marquee; a setting could switch. — **Decided (2026-09-29): marquee on left-drag**; the hand tool (`H`) / select tool (`V`) toggle serves as the switch, Space, middle mouse and trackpad scroll pan. No separate setting.
8. Priority of phase 2: Director `run_workflow` tool vs. mask painter vs. Higgsfield lip-sync/voice nodes. — **Decided (2026-09-29): Higgsfield lip-sync / voice / motion nodes first.** Built as phase 2c (experimental nodes `hf.dubbing`, `hf.voice_change`, `hf.motion_control`, `hf.speech`, an audio input for `video.higgsfield`, the `media_upload` path and the template `dub-clip`; see IMPLEMENTATION-NOTES §2.6). The Director `run_workflow` tool and the mask painter follow later.
