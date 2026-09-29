# Node View — Implementation Notes

Status: v1 as built (2026-09-29). Companion to [SPEC.md](SPEC.md). The SPEC is the design that was implemented; this file records the architecture as it ended up, every relevant deviation from the SPEC, a recipe for adding node types, the tests, the decisions taken and the backlog. **Where the SPEC and the code disagree, the code wins.**

---

## 1. Architecture in short

```
Browser   public/nodes/*.js   (window.OCDNodes, classic scripts, no build)
  │  REST + SSE
server.js ─ registerNodeRoutes(app, deps)                         lib/nodes/routes.js
  │           └─ createEngine({ store, getConfig })                lib/nodes/engine.js
  ├─ workflows-store   data/workflows/<wfId>/{workflow.json, results.json, runs/<runId>.json}
  ├─ registry          nodes-basic · nodes-generate · nodes-edit   (declarative definitions + executors)
  ├─ events            per-workflow bus → SSE
  └─ reused unchanged  tools.executeTool · store (sessions, ledger) · poller · ffmpeg · OpenRouter / ChatGPT
                       Higgsfield · ElevenLabs · render nodes · cost journal
```

- **One hidden backing session per workflow** (`kind: 'workflow'`, title `Workflow: <name>`, same `folder` as the workflow). Every input and output is a ledger asset of that session; chat assets are copied in. `store.listSessions` skips such sessions unless `includeHidden: true`; the poller passes it, so async jobs complete exactly as in the chat. Deleting a workflow deletes its folder and the backing session including all assets; cost journal lines remain.
- **Executors are thin adapters** over existing code (`tools.executeTool`, `lib/nodes/llm.js`, `lib/ffmpeg.js`, resvg, the Higgsfield catalogue). Provider costs are journaled by those tools and show up in the normal cost summary under the backing session.
- **Two writers, two files.** The client owns `workflow.json` (autosave, optimistic `rev`); the engine owns `results.json` (history, selected variant) and `runs/`. Variant selection goes through `PATCH …/results/:nodeId`. Locks: `wf:<id>` for `workflow.json`, `wf-results:<id>` for `results.json` (`store.withLock` is not re-entrant, never nest them).
- **Registry-driven UI.** Cards, palette, inspector and pre-run validation are generated from `GET /api/nodes/registry`. A new node type needs no client code, only i18n rows.
- **Values.** `{type:'text'|'number', value}`, media `{type:'image'|'video'|'audio', sessionId, assetId, file, url, duration?}`, lists `{type:'list', of, items}`.
- **Language.** Errors of the node modules are English; errors that come from `lib/tools.js` stay German, as in the chat.
- **58 node types:** 13 basic, 19 generative, 26 editing (`registry.list()`).

### Backend (`lib/`, all new unless noted)

| File | Purpose |
| --- | --- |
| `lib/nodes/types.js` | Port types, `canConnect`, value constructors and guards, `adaptValue` (coercion, list wrapping, implicit-map detection), canonical JSON and fingerprints for cache keys. Pure. |
| `lib/nodes/registry.js` | Declarative registry: `createRegistry()` plus the default instance, definition validation, `portsFor`, `normalizeParams`, `checkParams`, `availability`, `publicRegistry()` (payload of `GET /api/nodes/registry`). Loads the three node modules at the bottom. |
| `lib/nodes/nodes-basic.js` | 13 basic types: inputs, text utilities, `util.pick`, `util.router`, `output.result`. |
| `lib/nodes/nodes-generate.js` | 19 provider-backed types: 5 LLM, image / video / audio generation, dynamic Higgsfield models, 5 experimental Higgsfield edit types. |
| `lib/nodes/nodes-edit.js` | 26 local types (ffmpeg, resvg): image / video / audio edits, `media.info`, `image.svg_rasterize`, `image.text_render`. Helpers `ffmpegNode()` and `runOp()` (probe, scratch dir, ffmpeg, ledger asset). |
| `lib/nodes/ffmpeg-ops.js` | Pure ffmpeg argument builders per edit op, `assembleArgs`, tolerant `probeMedia`. |
| `lib/nodes/llm.js` | Non-streaming text completion for the LLM nodes: OpenRouter `/chat/completions` or the ChatGPT subscription for `chatgpt/*`; journals `brain` costs. |
| `lib/nodes/higgsfield-catalog.js` | Read-only `models_explore` catalogue (cached 60 min), model → param schema (`describeModel`), credit estimates. |
| `lib/nodes/assets.js` | Value ↔ ledger helpers: `valueFromLedgerEntry`, `saveOutputFile`, `saveUploadFile`, `copyAsset`, scratch dirs, `assetRefFromParam` / `resolveAssetParam`. |
| `lib/nodes/jobs.js` | `waitForSessionJob`: watches `session.jobs` (the poller completes them), abort / timeout helpers. |
| `lib/nodes/events.js` | Per-workflow event bus feeding SSE (`subscribe`, `emit`, `createEventBus`). |
| `lib/nodes/workflows-store.js` | File store for `workflow.json` / `results.json` / `runs/*.json`, backing-session lifecycle, `rev` rules, import / export validation, graph helpers (`topoSort`, `ancestorsOf`, `descendantsOf`), folder sync, `markInterruptedRuns`. `defaultStore` lives in `data/workflows`. |
| `lib/nodes/engine.js` | `createEngine`: `plan`, `start`, `cancel`, `activeRun`, `whenFinished`; validation, cache, pool, lists, partial results, timeouts, events. |
| `lib/nodes/routes.js` | `registerNodeRoutes(app, deps)`: every REST and SSE route, streamed uploads, ZIP, send-to-chat. |
| `lib/nodes/templates.js`, `lib/nodes/templates/*.json` | Six starter workflows (export format plus `id`, `requires`, `i18n`), localisation, validation, availability. |
| `lib/svg-safe.js` | `assertNoExternalReferences(svg)`, the shared SVG guard (§2.4). |
| `lib/store.js` (changed) | `createSession({ folder, role, kind, title })`, session field `kind`, `listSessions({ includeHidden })`, folder rename / delete include hidden sessions, hook `onFolderChange(listener)`. |
| `lib/poller.js` (changed) | `pollOnce` lists with `includeHidden: true`. |
| `lib/tools.js` (changed) | New exports for the node view, `extra_params` for Higgsfield generation, private `submitHiggsfieldJob` / `importHiggsfieldMedia`, node-only tool `higgsfield_edit`, SVG guard in `storeImportedSessionAsset`. |
| `lib/brain.js` (changed) | `activeTurns` + `isTurnActive(sessionId)`; rejects tool calls whose name is not in the Director's `toolDefinitions()`. |
| `lib/ffmpeg.js` (changed) | `runProcess` exported, optional `signal` (SIGKILL + `AbortError`). |
| `lib/branding-import.js` (changed) | SVG guard in `rasteriseSvg`. |
| `server.js` (changed) | Creates the engine, registers the routes before the catch-all, calls `markInterruptedRuns()` on start. |

### Frontend (`public/`)

Scripts load after `app.js` in this order (`public/index.html`, checked by `test-nodes-i18n.js`): `i18n-nodes` → `graph` → `history` → `api` → `node-ui` → `preview` → `canvas` → `palette` → `inspector` → `workflow-list` → `asset-picker` → `run` → `app-mode` → `main`. `public/app.js` is **not** modified (a test guards this); `public/index.html` gained the stylesheet, `#nodesBtn`, `#nodeApp` and the scripts, `public/i18n.js` the keys `sidebar.nodes` / `sidebar.nodesTitle`.

| File | Purpose |
| --- | --- |
| `public/nodes/graph.js` | Pure, immutable graph model (UMD): registry index, ports, `checkConnection` / `connect`, cycles, clipboard, groups, notes, viewport maths, fuzzy search, palette filtering. |
| `public/nodes/history.js` | Pure undo / redo snapshot stack (UMD, limit 100, 500 ms coalescing). |
| `public/nodes/api.js` | REST + SSE wrapper with a typed error object (`status`, `code`, `rev`, `runId`, `issues`). |
| `public/nodes/node-ui.js` | Node cards, generic param widgets, in-app dialogs, toasts, menus, card slots for status / preview / cost. |
| `public/nodes/preview.js` | Result previews on cards (image, video, audio, text, number, list grid), thumbnails, downloads, media viewer. Uses `textContent` only. |
| `public/nodes/canvas.js` | Viewport, node / note / group layers, bezier edges, pointer interaction, minimap. Reports intent through callbacks. |
| `public/nodes/palette.js` | Command palette (search, category chips, type filter for drag-to-empty); adds one entry per Higgsfield model. |
| `public/nodes/inspector.js` | Right panel: generated param form, dynamic Higgsfield params, run info, history strip, Design App exposure. |
| `public/nodes/workflow-list.js` | Left drawer: list, search, new, "New from template" and import buttons, per-item menu (rename, duplicate, export, project, delete). |
| `public/nodes/asset-picker.js` | Picker (upload / from chats / this workflow) and the send-to-chat target chooser. |
| `public/nodes/run.js` | Pure SSE reducer and plan / result helpers (UMD), plus the browser controller for run controls, confirmation, cancel, variant selection. |
| `public/nodes/app-mode.js` | Design App view `#app=<id>`: generated form, batch counter, live status, result gallery. |
| `public/nodes/main.js` | Bootstrap, state, hash routing, autosave, undo / redo, clipboard, shortcuts, import / export, template dialog, project assignment, SSE wiring. Public hooks: `OCDNodes.editor`, `OCDNodes.bus`, `OCDNodes.extensions`. |
| `public/nodes/nodes.css`, `public/nodes/i18n-nodes.js` | Styles (prefix `nv-`, tokens `--nv-*`) and all `nodes.*` strings for de / en / es. |

Browser storage: `localStorage` `ocd-nodes-drawer`, `ocd-nodes-inspector`, `ocd-nodes-clipboard`, `ocd-nodes-last`; `sessionStorage` `ocd-nodes-return` (hash to go back to the chat).

---

## 2. As built vs. SPEC

### 2.1 Registry and node definitions

- **Hidden result port on `output.result`.** SPEC: no output. Built: one hidden output `result:any` (`hidden: true`) that stores the received list, because ZIP download, send-to-chat, thumbnails and Design App outputs read it from `results.json`. Validation rejects edges from hidden ports (`bad_port`); the client never draws them.
- **`portVariants`** (new optional field): `{ param, values: { <value>: { inputs?, outputs? } } }` switches ports by a param value. Used by `input.media_list` (`kind` → `image[]` / `video[]` / `audio[]`) and `hf.remove_background` (`kind` → image / video), because port types have no union. Resolve the ports of a concrete node with `registry.portsFor(def, params)` (the client mirrors it in `graph.portsFor`); `def.inputs` / `def.outputs` are only the defaults.
- **`createRegistry()` and `registerAll(registry)`.** `createRegistry()` builds isolated registries (tests); `registry.js` also exports the default instance and its bound methods. Node modules export `registerAll(registry)`; the default registry loads all three at the bottom of `registry.js`.
- **Multi-edge ports (`multiple: true`).** The executor receives one list value `{type:'list', of, items}` with all edges flattened in `graph.edges` order (a `T[]` edge contributes its items). Used by `text.join`, `util.router`, `output.result`, `image.edit.images`, `video.concat.clips` and others. A port-level `max` is enforced by the node's `validate` / `execute`, not by the engine.
- **Definition and param extras.** Definition: `async: true` (30-min instead of 12-min timeout), `timeoutMs`, `experimental`, `description`. Param: `optional` (blank number → `null`), `accept`, `showIf: { param, equals }`, `dynamic: 'higgsfield-model'`, `max` on `assets`. `validate(params, ports)` returns strings (errors) or `{ level: 'warning' | 'error', message }`. `available()` returns `true` or a reason string.
- **Unavailable and experimental nodes stay visible.** SPEC §5.8: the Higgsfield edit nodes appear only when Higgsfield is connected and `PUBLIC_BASE_URL` is set. Built: they are always registered; without those preconditions (and, for the ffmpeg-probing ones, ffmpeg) `available` is a reason string and the palette lists them dimmed with an "unavailable" badge; all `hf.*` carry an "experimental" badge.
- **Higgsfield generation nodes.** Category `higgsfield` (not `image` / `video`) for `image.higgsfield`, `video.higgsfield` and `hf.*`. The SPEC left the storage of dynamic params open: `aspect_ratio`, `resolution` (text) and, for video, `duration` (integer, optional) are real params; all other model parameters live as a JSON object string in param `extra_params` (kind `code`, default `"{}"`). `GET /api/nodes/higgsfield-models/:id` returns a `target` per param (`aspect_ratio`, `resolution`, `duration` or `extra_params`) telling the client where to write the value. If `extra_params` has keys but the model cannot be checked (`models_explore get`), the run aborts before anything is reserved or paid; unknown, reserved, already-set or mistyped keys are dropped and reported in `node_log`.
- **LLM nodes.** `model` defaults to `''`, meaning `config.defaultBrain` at run time. All LLM nodes are `paid: true` (USD; ChatGPT subscription = 0) so plan totals and the confirmation count them. OpenRouter requests send `usage: { include: true }`. `chatgpt/*` models use `chatgpt.streamResponses` (JSON via the system prompt, no temperature, journal cost 0 / `billing: 'Abo'`).
- **`llm.motion_html` / `video.motion_graphics`.** The HTML uses `{{asset:N}}` placeholders (1-based, edge order) that `video.motion_graphics` replaces with `<assetId><ext>`. Both `assets` ports are type `any` (no union types); the run checks that only image / video / audio arrive.
- **`count` on generative nodes.** A failing variant does not discard paid ones: the node fails only if every variant fails, otherwise the error is logged (`N of M variants failed: …`). Inside a list map `count` is forced to 1.
- **Editing nodes: parameters beyond the SPEC table.** `image.resize.transparent`, `image.pad.transparent`, `image.pad.mode` (`aspect` | `size`); `unit` (`px` | `percent`) and `anchor` (`top-left` | `center`) on `image.composite` and `video.overlay_image`; `audio.mix.volumes` is a comma-separated text param (`amix` keeps its default normalisation, older ffmpeg builds lack `normalize=0`); `video.trim` `end = 0` means "to the end"; `video.extract_frame` `last` = duration − 2 frames; `image.to_video` zooms a fixed 20 %, always writes even sizes, max 600 s. A mask in `image.composite` replaces the layer alpha (white = visible); blend modes other than `normal` are computed on the layer footprint only. Outputs: PNG, MP4 (H.264 + AAC), M4A. Local nodes write no cost-journal lines. `media.info` is in category `utility`.
- **List limits.** The engine maps at most 50 items (`limits.maxListItems`). A longer list on a scalar port fails at run time ("List has N items; the limit is 50"), although `input.text_list.max` and `text.split.max` accept up to 500. `input.media_list` caps at 50.

### 2.2 Engine

- **Cache key.** `sha256(canonicalJSON({ t: type, v: def.version, p: params, i: fingerprints }))`. The SPEC used the node's `typeVersion`; built uses the registry's `def.version`, so changing an executor invalidates cached results (**bump `version`** when the output for the same inputs changes). Params are normalised first (defaults, coercion, min / max clamp); `label` and `title` are excluded. The `typeVersion` stored in nodes is kept but not used for caching.
- **Cache hits prefer the selected entry.** Forced re-runs create several entries with the same key. `findCacheHit` returns the entry the user selected before a newer one, so runs and plans never swap a chosen older version or mark its successors stale.
- **Lists and partial results.** Implicit map as in the SPEC (zip by index, max 50, `count` = 1, `node_status.progress = {done, total}`). If a map fails or is cancelled, the finished items are kept: their cost is booked into the run and they are stored in `results.nodes[id].partial = { cacheKey, runId, createdAt, items: { "<index>": { variant } }, errors: [{ index, message }] }`. The node still ends as `error` (downstream `skipped`). The next run with the same cache key skips finished items (only missing ones are executed and paid); a forced run ignores `partial`; `partial` is deleted after a successful run. `plan.nodes[id].executions` counts only the items still to run, `reusedItems` says how many are reused. Partial items are not history entries and not visible in the UI (their assets stay in the backing session).
- **Scheduling details.** FIFO semaphore; a node's pool slot is released while `ctx.waitForJob` waits and re-acquired afterwards; `ctx.withLocalSlot(fn)` takes one of `limits.localJobs = 2` server-wide slots (all ffmpeg work). Timeouts 12 min (sync) / 30 min (`async: true`) → error code `NODE_TIMEOUT`. Env: `NODES_MAX_PARALLEL` (3), `NODES_MAX_ACTIVE_RUNS` (4). Kept: 50 run records, 30 history entries per node.
- **Cost preview.** No price table. `estimate` = `def.cost.estimate(params, …)` if defined; otherwise, for `usd` nodes, the newest actual cost of the same node type in this workflow (scaled by `count`); otherwise `null` ("unknown"). Higgsfield nodes estimate credits from the catalogue. Totals: `{ paidNodes, usd, credits, unknownNodes }`. The engine never writes cost lines: executors report `cost` and the underlying tools journal it; `run_cost` events carry the running totals.
- **Executor context** in addition to SPEC §9.5: `itemIndex` (inside a map), `withLocalSlot(fn)`, and `toolCtx.nodeView = true`. Executors receive normalised params and inputs already adapted to their port types (numbers stringified for text ports, lists wrapped or mapped); outputs are checked against port types and `isValue`.
- **Restart.** `markInterruptedRuns()` at start-up sets stale `running` records to `interrupted`.

### 2.3 Store, API and events

- **`rev` rules.** `PUT` needs an integer `baseRev` and answers `409 REV_CONFLICT { rev }` on mismatch. The `rev` (and `updatedAt` / `updatedBy`) advance, and `workflow_saved` is emitted, only when the content changed: graph without viewport, name, description or app. A viewport-only save leaves `rev` untouched, so panning never disturbs other tabs. `PATCH` never changes `rev`. `POST …/runs` accepts an optional `rev`: `409 REV_CONFLICT` if it differs, `400` if not an integer; the client always sends it after flushing autosave.
- **Rename only via `PATCH`.** The `PUT` route ignores `name` (the store's `saveGraph` would accept it when called directly), so a stale tab can no longer undo a rename. `PATCH { name?, folder? }` updates the backing session title / folder and emits `workflow_renamed { name, folder, updatedBy }`; the client applies name and folder from that event.
- **Validation strictness.** Autosave (`PUT`) validates structure only (ids, endpoints, self-loops, duplicates, cycles); ports and types are checked on import and by the engine. Unknown node types are kept. `PUT` without `app` keeps the stored app and prunes references to deleted nodes; with `app`, unknown params or outputs that are not `output.result` are rejected. Limits: 500 nodes, 2000 edges, 200 groups, 200 notes, 2 MB document, 120-character names.
- **Folders.** `renameFolder` / `deleteFolder` also update the hidden backing sessions and call `store.onFolderChange` listeners; the workflow store rewrites `workflow.json`'s own copy of `folder` (rename → new name, delete → `null`). Workflows do not count as chats, so a project holding only workflows can still be deleted.
- **Response shapes the SPEC left open.** options → `{ options: [{ value, label }] }`; `DELETE` → `{ ok: true, id }`; `GET …/assets` → `{ assets: [Value + prompt + createdAt] }`; `PATCH …/results/:nodeId` → `{ selected, history }`; `cancel` → `{ ok }` (`false` with HTTP 200 if not running); `PATCH /:id` → `{ id, name, folder, rev, updatedAt }`; `GET /api/workflow-templates` → `{ templates: […] }`. `GET /api/workflows/:id` returns `activeRun` as the run id string or `null`, while the SSE `snapshot` carries `{ runId, mode, nodes: { id: status } }`.
- **Routes beyond the SPEC.** `GET /api/workflows/:id/runs?limit=` (1–50, default 10) → `{ runs: [{ id, mode, targets, force, user, status, startedAt, finishedAt, cost, error }] }`; `?accept=image|video|audio` on uploads; `?lang=de|en|es` on templates; `POST /api/workflows` accepts `templateId` + `lang` (`document` wins over `templateId`).
- **Uploads.** Raw body, `Content-Type` = MIME, header `X-Filename` (URL-encoded allowed). Extension from a MIME map, otherwise from the file name (`.jpeg` → `.jpg`); whitelist png / jpg / webp / gif, mp4 / webm, mp3 / wav / m4a / aac. Streamed to a scratch dir inside the backing session (never buffered), max 500 MB; early `413` / `415` answers close the connection after the response. An SVG (max 10 MB, read into memory) is stored like in the chat (source plus a 1024 px PNG); the response is `{ value (the PNG), rasterized: true }` and the SVG source is not offered as a port value. An SVG that cannot be rasterised, or that references local files, gives `415` and leaves nothing in the ledger.
- **Import asset.** `{ sessionId, assetId }` from any session; not found → 404, pending → `409 ASSET_PENDING`, not image / video / audio → 415. An asset already in the workflow's own session is returned without a copy.
- **Send to chat.** `POST …/send-to-chat { sessionId, nodeId, entry?, variant?, port? }` copies up to 24 media files into the chat as uploads (more → `400`) and appends a user message with `uploadIds`; text results are quoted in the message. The message text itself is German (it is read by the Director) and not localised. **`409 CHAT_BUSY`** while a Director turn runs in the target chat (`brain.isTurnActive`) or while the last assistant message has tool calls without all their tool results; checked before copying and again inside `store.mutateSession`. Without it, a message inserted between `assistant(tool_calls)` and its `tool` replies breaks every later provider request of that chat.
- **ZIP.** `GET …/outputs.zip[?runId=]`: selected results of all `output.result` nodes (or the entries one run produced), ordered by canvas y then x, files named `NN-<label>[-k].ext`, text and number results as `.txt`, max 500 entries; `404 NOT_FOUND` without results.
- **SSE.** Same headers and `: ping` every 15 s as the chat stream; first frame `snapshot`, then `run_started`, `node_status`, `node_log`, `node_result`, `run_cost`, `run_finished`, `workflow_saved`, and the new `workflow_renamed`. After a reconnect the client re-reads `GET /api/workflows/:id`.

**Error codes** (`{ error, code, … }`; the extra field is in brackets):

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_ID`, `INVALID_WORKFLOW`, `INVALID_REQUEST`, `INVALID_GRAPH` (`issues`: `[{ nodeId, port?, level, code, message }]`) |
| 404 | `WORKFLOW_NOT_FOUND`, `RUN_NOT_FOUND`, `ENTRY_NOT_FOUND`, `NOT_FOUND` |
| 409 | `REV_CONFLICT` (`rev`), `RUN_ACTIVE` (`runId`), `CHAT_BUSY`, `ASSET_PENDING` |
| 413 | `TOO_LARGE` (upload > 500 MB, SVG > 10 MB, document > 2 MB) |
| 415 | `UNSUPPORTED_MEDIA` (unknown extension, wrong `?accept=`, SVG not rasterisable or with external references) |
| 429 | `RUN_LIMIT` |
| 502 / 503 | `UPSTREAM` (ElevenLabs voice list), `UNAVAILABLE` (no ElevenLabs key, no Higgsfield catalogue) |

`NODE_TIMEOUT` is an engine-internal code on the node error, not an HTTP status. Anything else answers `500` with its message.

### 2.4 Provider and Director safety

- **Node-only tools.** `higgsfield_edit` is in `EXECUTORS` but not in `toolDefinitions()`. `executeTool` refuses names in `NODE_ONLY_TOOLS` unless `ctx.nodeView === true`, which only the engine's `toolCtx` sets; `extra_params` for Higgsfield generation is honoured only with `ctx.nodeView`. Reason: the Director's closed tool schema is not enforced server-side, so a model (or a prompt injection) could invent such a call. `brain.js` additionally rejects tool calls whose name is not in `toolDefinitions()`, and `executeTool` looks tools up with `hasOwnProperty`.
- **Higgsfield edit MCP arguments are nested under `params`** (`mcpCall(tool, { params: { … } })`) because `docs/higgsfield-tools.json` demands it; the SPEC table showed them flat. The job id is taken from the response without the imported source media ids. The response format has not been verified against the live API (§5).
- **SVG guard (`lib/svg-safe.js`).** resvg reads absolute and relative file paths from `href`, `xlink:href` and `url()`, which would let an uploaded or generated SVG pull other images from the server's disk into the PNG. Allowed targets: in-document `#id`, `data:` URIs and `http(s)://` URLs (resvg never fetches remote resources, so web fonts or links in exported logos are simply ignored); everything else, i.e. local or relative paths, is rejected, as is any `<!ENTITY`. Used centrally in `tools.storeImportedSessionAsset` (node uploads **and** the Director's import tools for GTS, branding and cast assets: an SVG with disallowed references is kept without a PNG raster, a node upload answers `415`), in `image.svg_rasterize` (`checkSvgSafe`, plus a 2 MB cap) and in branding import (`rasteriseSvg`).

### 2.5 Frontend

- **Canvas input.** Left-drag on empty canvas draws a rectangle selection (Shift adds); there is no freehand lasso. Tools: *Select* (`V`) and *Hand* (`H`). Pan with Space + drag, middle mouse, the hand tool or two-finger scroll; zoom with Ctrl / Cmd + wheel or pinch, range 0.1–2.5. Dragging from a connected input port picks up that edge: drop on another port to re-route, on empty canvas to delete (SPEC §12.4). `F` fits the selection or everything, `Cmd/Ctrl+0` resets to 100 %.
- **Routing and the `#s=` hash.** `#w=` is the list, `#w=<id>` the editor, `#app=<id>` the Design App. `app.js` rewrites `#s=` after its own init; while the node view is active `history.replaceState` is wrapped to swallow such calls and to remember the chat hash for "← Chat" (`sessionStorage` `ocd-nodes-return`). Do not rely on `hashchange` alone.
- **Focus and `inert`.** The chat stays rendered under the overlay. Entering the node view sets `inert` on `body > .app`, blurs a focused chat element and focuses the canvas; a `focusin` guard redirects the late `focus()` that `app.js` fires on the composer; leaving removes `inert` and focuses `#input`. Without this, keys typed after a reload on `#w=<id>` went into the chat composer, and ⌘↵ (run selection) could send that text as a chat message.
- **Fit and side panels.** The first fit after opening a workflow uses `padding: 48` and waits until the side-panel grid animation has ended (max 700 ms). Below 1600 px the drawer and inspector are closed for that first fit unless the user pinned them (`ocd-nodes-drawer` / `ocd-nodes-inspector` = `1`); the inspector reopens on selection. In the list view the drawer is always open; in the editor it starts open from 1360 px width unless a saved choice says otherwise.
- **Persistence.** Autosave 800 ms after a change (1600 ms for viewport-only), flushed before runs and on leaving; `keepalive` is used only for bodies under 60,000 characters (browsers refuse larger ones). The workflow list reloads whenever the node view is activated and a workflow opened by hash is added to it. Node ids are never reused within a workflow (the `reserved` set), because `results.json` keeps ids of deleted nodes. Any foreign `workflow_saved` shows the conflict banner (reload / keep mine), even without local changes.
- **Dialogs.** No native `alert` / `confirm` / `prompt` (test-guarded). The paid-run confirmation focuses "Cancel" and Enter does not confirm. Deleting a workflow says that its files are deleted too.
- **Run UX.** The plan is re-fetched after a save that changed `rev` while no run is active, after a run ends and after a variant change. SSE is primary; a 4 s poll of `GET …/runs/:id` is the safety net. Cancel warns only if a paid provider job is in flight; submitted provider jobs still finish and cost money. Card previews show up to 12 list cells plus "+N". No per-run detail view, no "retry all failed".
- **Design App.** Form values are sent as `overrides` of a `mode: 'all'` run; the saved graph is never changed. `force` is set only when a fresh plan says everything is cached ("Run again"). Batch = a list input (`input.text_list` / `input.media_list`); the counter under the list mirrors the server's `parseTextList` (a test checks parity).
- **Templates.** Each `lib/nodes/templates/<id>.json` is an export document plus `id`, `requires` (subset of `openrouter`, `ffmpeg`, `elevenlabs`, `rendernode`) and an `i18n` block. English is the base text of the file; the block holds `de` and `es` overrides with keys `name`, `description`, `node.<id>` (title), `note.<id>`, `group.<id>`, `param.<node>.<param>`, `app.title`, `app.description`, `app.input.<node>.<param>`, `app.output.<node>`. Every template ships with an enabled Design App; `validateTemplate` checks types, ports, edges and the app section. Templates whose `requires` are not met are listed as unavailable with the missing reasons.
- **i18n.** All node-view strings live in `public/nodes/i18n-nodes.js` as rows `[key, de, en, es]` (Swiss spelling, no "ß" in any language). `test-nodes-i18n.js` requires a translation for every registry type, category, port, param and non-numeric select option.

---

## 3. How to add a node type

A node type is one registry definition plus i18n rows. The palette, card, inspector, validation, plan and run UX pick it up from `GET /api/nodes/registry`.

1. **Choose the module.** Pure logic → `lib/nodes/nodes-basic.js`; provider-backed → `nodes-generate.js` (via `tools.executeTool(ctx.toolCtx, …)` or `llm.js`); local ffmpeg / resvg → `nodes-edit.js`. For a new family create `lib/nodes/nodes-<name>.js`, export `registerAll(registry)` and add `require('./nodes-<name>').registerAll(defaultRegistry);` at the bottom of `lib/nodes/registry.js`. Higgsfield models need no code: they appear dynamically.
2. **Write the definition.**
   - `type`: `<family>.<name>`, matching `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` and unique. `category` is one of `input, llm, text, image, video, audio, edit-image, edit-video, edit-audio, higgsfield, utility, output` (a new category also needs an entry in `CATEGORIES`, `nodes.category.<id>` and a `--nv-cat-<id>` colour plus `[data-cat]` rule in `nodes.css`).
   - `version`: bump it whenever the output for identical inputs changes; it is part of the cache key.
   - `inputs` / `outputs`: `{ id, type, required?, multiple?, param?, hidden?, max? }`; port ids match `^[a-z][a-z0-9_]{0,31}$`; types are `text | number | image | video | audio | any`, each optionally as `T[]`. `param` names an inline fallback param for text / number ports. A scalar port fed by a `T[]` runs the node once per item, so executors never need to loop.
   - `params`: `{ id, kind, default, min?, max?, step?, options? | optionsSource?, optional?, inline?, showIf? }`; kinds `text, textarea, code, number, integer, slider, boolean, select, color, asset, assets, tags`; `optionsSource` is `brain-models`, `elevenlabs-voices`, `higgsfield-image-models` or `higgsfield-video-models` (more via `deps.optionSources` of `registerNodeRoutes`).
   - `paid: true` and `cost: { unit: 'usd' | 'credits', estimate? }` for anything that costs money (this triggers the confirmation and the plan totals); `available()` → `true` or a reason; `validate(params, ports)` for problems that should show before a run; `async: true` for provider jobs.
   - `execute(ctx, inputs, params)` → `{ variants: [{ <outputPortId>: Value }], cost?: { usd?, credits? } }`. Useful `ctx` members: `log(label)`, `signal`, `sessionId`, `toolCtx`, `waitForJob(job)` (returns asset ids), `saveOutputFile({ kind, ext, sourceFile, prompt, cost, duration })`, `withLocalSlot(fn)`, `itemIndex`. Call provider functions through their module object (`or.createImage(…)`, never destructured), otherwise tests cannot patch them. For an ffmpeg node add a pure builder to `ffmpeg-ops.js` and an `ffmpegNode({ … })` entry in `nodes-edit.js`.
3. **Add i18n rows** to `public/nodes/i18n-nodes.js`, format `[key, de, en, es]`, German with Swiss spelling:
   - `nodes.type.<type>.label` (always);
   - `nodes.port.<id>` for every port id that no other node uses yet;
   - `nodes.param.<id>` for every new param id;
   - `nodes.option.<value>` for every select option that is not a number, ratio or resolution (`/^[0-9.:]+[a-z]*$/i` stays literal).
4. **Test it.** Add cases to the matching script (pure logic / registry → `test-nodes-types.js`, mocked executors → `test-nodes-generate.js`, ffmpeg builders and real ops → `test-nodes-ffmpeg.js`, engine behaviour → `test-nodes-engine.js`), then run `node scripts/test-nodes-i18n.js`, which fails on any missing key. Some tests pin a module's type list (`test-nodes-types.js` the basic types, `test-nodes-generate.js` the generative ones) and `test-nodes-i18n.js` asserts at least 58 types: update those lists.

Mini example, a pure text node. Add it to the `definitions` array of `lib/nodes/nodes-basic.js` (`textValue` is already imported there):

```js
{
  type: 'text.uppercase',
  version: 1,
  category: 'text',
  label: 'Uppercase',
  keywords: ['upper', 'case', 'capital'],
  inputs: [{ id: 'text', type: 'text', required: true, param: 'text' }],
  outputs: [{ id: 'text', type: 'text' }],
  params: [{ id: 'text', kind: 'textarea', default: '', inline: true }],
  execute: async (_ctx, inputs) => ({ variants: [{ text: textValue(inputs.text.value.toUpperCase()) }] })
}
```

Its only missing translation is the type label (port `text` and param `text` already exist):

```js
['nodes.type.text.uppercase.label', 'Grossbuchstaben', 'Uppercase', 'Mayúsculas'],
```

Extend the `expected` list in `testBasicNodes` of `scripts/test-nodes-types.js` with `'text.uppercase'` and add an assertion next to the other `exec(…)` checks there, e.g. `assert.equal((await exec('text.uppercase', { text: textValue('a') }, {})).variants[0].text.value, 'A')`. A list wired into the `text` port makes the node run once per item and return a list, with no extra code.

---

## 4. Tests

Plain Node scripts (`assert/strict`), no network, no build. There is no test runner in the repo; run a script with `node scripts/<name>.js` or all of them with `for f in scripts/test-*.js; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`. Provider functions are patched on their module objects and restored in `finally`. Tests that need a backing session create real sessions in `projects/` and `assets/` and delete them in `finally`; workflow files go to a temp dir.

| Script | Purpose |
| --- | --- |
| `scripts/test-nodes-types.js` | Port types, compatibility rules, values, fingerprints, registry framework, the 13 basic nodes. |
| `scripts/test-nodes-store.js` | Backing-session support in `lib/store.js` and the poller, workflow store (CRUD, `rev` conflicts, import / export validation, results, runs), asset helpers. |
| `scripts/test-nodes-engine.js` | Engine with fake executors: topo order, pool limit, cache, force, plan, errors, cancel, lists, partial map results, overrides, job waiting. |
| `scripts/test-nodes-api.js` | Every route against a private express app (temp workflow dir, fake executors, real HTTP): status codes and shapes, streamed uploads and size cap, SVG guard, asset import, runs, SSE, ZIP, templates, send-to-chat incl. `CHAT_BUSY`, rename events, folder sync. |
| `scripts/test-nodes-generate.js` | Generative nodes, `llm.js`, Higgsfield catalogue, `extra_params`, node-only tools; all providers mocked. |
| `scripts/test-nodes-ffmpeg.js` | Pure ffmpeg builders (always) and real ffmpeg / resvg ops on generated inputs, abortable `runProcess`. Prints `SKIP ffmpeg fehlt` and exits 0 when ffmpeg / ffprobe are missing. |
| `scripts/test-nodes-graph.js` | Pure graph model of the client: connections, cycles, clipboard, groups, viewport maths, fuzzy search. |
| `scripts/test-nodes-history.js` | Undo / redo stack. |
| `scripts/test-nodes-i18n.js` | de / en / es parity, Swiss spelling, placeholders, coverage of every registry type / category / port / param / option and of every key literal used in `public/nodes/*.js`, script order in `index.html`, `app.js` untouched. |
| `scripts/test-nodes-run-client.js` | SSE reducer for every event type, result / cost helpers, plan description; static checks (no `innerHTML`, no native dialogs). |
| `scripts/test-nodes-templates.js` | All six templates validate against the registry, texts exist in de / en / es, they create workflows through the routes, the batch template maps a list through the engine. |
| `scripts/test-nodes-app.js` | Design App: batch-counter parity with the server list parser, app validation, a local batch run with `overrides` that leaves the saved graph unchanged, static browser-wiring checks. |

Also relevant: `scripts/test-i18n.js` (chat dictionaries and the two `sidebar.nodes*` keys). After node-view changes also run the existing regression scripts, e.g. `test-api-handlers.js`, `test-session-meta.js`, `test-folders.js`, `test-concat-videos.js`, `test-higgsfield.js`, `test-video-frames.js`.

**`scripts/test-minimal-config.js` is environment-dependent.** It asserts a bare configuration (for example that no render node is configured, `renderStatus.enabled === false`), but `server.js` reloads `.env` and the saved settings on `require`, so it fails on machines that configure optional integrations there (a render node, for instance). It already failed before the node view existed; do not read its result as a node-view regression.

There is no browser test in the repo. Focus and `inert`, the first fit and the list refresh were verified by hand with a headless-Chrome (DevTools protocol) harness that is not part of the repo; the static checks above cover script order, native dialogs, `innerHTML` and defined CSS classes.

---

## 5. Decisions (as of 2026-09-29)

- **Workflows are team-visible**, like chats. No per-user filtering; `createdBy` / `updatedBy`, run users and cost users come from `req.kubleUser` (`lokal` without an auth proxy).
- **Higgsfield edit nodes are experimental and untested against the live API.** They need Higgsfield connected **and** `PUBLIC_BASE_URL`; no `media_upload` path for local-only setups. One live verification (job id, result format) is still needed and costs credits.
- **No mask for OpenRouter images.** Inpainting stays approximate (template "Masked edit": `image.edit` → `image.mask_apply` → `image.composite`). Whether the endpoint accepts a mask or a transparent background is unverified.
- **Cost estimate = last actual cost** of the node type in the workflow; otherwise "unknown". No price table; Higgsfield shows a credit estimate from the catalogue.
- **ElevenLabs costs are not journaled**, as in the chat; the TTS node shows no cost.
- **Deleting a workflow deletes its backing session including all assets**, after an in-app confirmation. No archive; cost journal lines remain.
- **Canvas: left-drag = rectangle selection.** Hand tool (`H`) and select tool (`V`); Space, middle mouse and trackpad scroll pan. No setting to swap the defaults.

---

## 6. Backlog ("Later")

Features the SPEC (§3, §17) parked, with what they would need:

| Item | Needs |
| --- | --- |
| Mask painting (brush) | In-node paint editor that produces a PNG mask; uploaded masks already work. |
| Real inpainting | A mask-capable generation endpoint; today's approximation can shift geometry. |
| Segmentation / "select subject" | A reachable segmentation model. |
| Real relighting | A dedicated relight model; `image.relight` is a GPT Image 2 edit with a lighting prompt. |
| Seeds / deterministic re-runs | Seed parameters in the OpenRouter / Seedance wrappers. |
| Seedance last-frame conditioning | `buildVideoPayload` currently sends only `first_frame`; needs a `last_frame` port and payload support. |
| Lip sync, voice change, motion transfer, Higgsfield audio | MCP tools `dubbing`, `voice_change`, `motion_control`, `generate_audio` exist; wire them after the experimental edit nodes are verified. |
| 3D | Higgsfield `generate_3d` (GLB), a viewer (three.js from a CDN) and a GLB asset kind. |
| Real-time collaboration, canvas comments | Presence channel, conflict-free merge, comment store (today: optimistic `rev` and a conflict banner). |
| Public Design App links | Unauthenticated access model, rate and cost limits. |
| Director tool `run_workflow`, "create workflow from chat", "Open in node view" on chat asset cards | Stable app schemas, async result delivery into the chat turn, a cost-confirmation step, a small `app.js` change for the card button. |
| ZIP export with assets | Asset packing and re-import mapping (`archiver` and `yauzl` are installed). |
| Cartesian products, nested iterators | Only zip semantics of equal-length lists exist. |
| Speech-to-text for the video describer | It is visual only (three frames). |
| Cast and Branding input nodes | `cast.listMembers`, `cast.readMemberAsset`, `brandings` are available. |
| Interactive layer editor | `image.composite` is parametric, one layer per node. |

Open points from the implementation:

- Freehand lasso (selection is a rectangle).
- Level of detail at low zoom: smoothness was measured with 50 nodes only (no frame over 34 ms); the SPEC target of 200 nodes is unmeasured.
- Detail view for individual runs and "retry all failed"; the inspector shows the last 30 results and recent runs only.
- Show partial map items in the history (they exist only internally for reuse).
- The minimap can cover lower cards at 1280×720; template node positions were checked only visually in fit view.
- `OCDNodes.extensions.topbar` is reserved but not wired.
- `audio.mix` normalises volume (`normalize=0` needs ffmpeg ≥ 7.1); video compositing with a mask and video chroma key do not exist.
- Live verification of the Higgsfield edit tools (§5).
- Test gaps: no automated test that `brain.js` rejects unknown tool names (only the `executeTool` guard is tested); no browser tests in the repo.
- Open decision: priority of phase 2 (Director `run_workflow` vs. mask painter vs. Higgsfield lip-sync / voice nodes), SPEC §21 question 8.
