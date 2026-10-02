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
- **Video model choice** — before a video starts, the Director shows a card in the chat with the OpenRouter video models that fit the job (length, resolution, format, first frame, references): estimated price for exactly this job, strengths and weaknesses, a recommendation. Only the click starts the paid generation; cancelling charges nothing. People with a budget see what is left, options over it are disabled, and the server checks it again and reserves the estimate. “Do not ask again in this chat” remembers the model for you in this chat (in a shared chat everyone else still gets the card; reset above the input field). Admins can switch the question off in Settings → Services (*Ask for the model before every video*); the configured default model then starts right away.
- **Live production status** — running jobs show up in a live status bar with elapsed time, the Director posts results and failures into the chat by itself, and the thinking indicator shows what is currently executing.
- **Speech** — ElevenLabs text-to-speech for voice-overs and voice masters (optional).
- **Higgsfield integration** — connect your higgsfield.ai account with one click (no API key needed) and the Director gains 30+ image/video models, billed as Higgsfield credits on your plan (optional).
- **Motion graphics** — HTML/GSAP compositions rendered to MP4 on one or more render nodes (16:9, 9:16, 1:1) (optional).
- **Node view** — build reusable production flows on a canvas (batch runs, ready-made templates), publish them as a clean Design App and send results back to a chat.
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
| `ELEVENLABS_API_KEY` | Optional | Text-to-speech (`generate_speech`, voice list) and, in the node view, music and song text (`audio.music`, `audio.music_plan`). The ElevenLabs Music API needs a **paid ElevenLabs plan**; without one the music node stops with a clear message and nothing is charged | [elevenlabs.io](https://elevenlabs.io) |
| `FAL_KEY` | Optional | fal.ai models in the node view: the MiniMax H3 Max nodes (text/image/reference video, lip sync, camera moves, extend, insert scene, 3D to video, styles), image to 3D (Tripo, Hunyuan, Meshy, SAM 3D) and a free-form fal.ai model node. Billed per second or per generation by fal.ai | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) |
| Higgsfield account | Optional | 30+ extra image/video models for the Director | No key — click **Connect** in Menu → Settings and sign in to Higgsfield in the browser (OAuth login, tokens stay on the server). Behind a reverse proxy set `PUBLIC_BASE_URL` so the browser can reach the callback |
| ChatGPT subscription | Optional | Run the Director on GPT-5.6 models billed to your ChatGPT Plus/Pro plan instead of per-token | No key — log in to the [Codex CLI](https://github.com/openai/codex) with "Sign in with ChatGPT", then click **Import from Codex CLI login** in Menu → Settings. Unofficial route via the Codex backend (gray area in OpenAI's terms) — use at your own discretion. If the subscription cannot be reached (login expired, usage limit, outage) and an OpenRouter key is set, that one model call is repeated through OpenRouter as `openai/<model>`: a notice in the chat says so, it is billed to your OpenRouter account, and the subscription is skipped for 10 minutes |
| `RENDER_NODE_URL` + `RENDER_NODE_TOKEN` | Optional | HTML/GSAP motion-graphics rendering | Run your own render node (see below); multiple nodes manageable in Menu → Settings |
| `PUBLIC_BASE_URL` | Optional | Seedance audio/video references (they require publicly reachable HTTPS URLs); also the base of the Higgsfield login callback (`<PUBLIC_BASE_URL>/api/higgsfield/oauth/callback`) | Only needed when hosting publicly or behind a reverse proxy |
| `AUTH_WHOAMI_URL` + `ADMIN_EMAILS` | Optional | User management behind your own login: private chats/workflows, sharing, admins, team list (`SUPERADMIN_EMAILS`, `AUTH_LOGOUT_URL` optional) | Only for team hosting — locally the app runs open. See [User management](#user-management-optional) |
| `GTS_API_TOKEN` + `GTS_BASE_URL` | Optional | Attach knowledge-base documents as chat context | Any compatible GTS endpoint; the example default points to `gts.kuble.com` |

Keys can also be entered at runtime in **Menu → Settings** (stored server-side in `data/settings.json`, chmod 600, never in the repo) — they override `.env` without a restart.

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

Besides the chat, the **Chat | Nodes** switch in the header opens a canvas for building reusable production flows. Nodes for inputs (text, text list, images, videos, audio), LLM steps, image/video/audio generation, ffmpeg editing and results are wired together; every workflow keeps its media in its own hidden session, so nothing shows up in your chat list. The image and video nodes let you choose the model in the node (see `imageModels` below); “Videos side by side” puts 2 to 4 videos on one canvas to compare them (local, free), “Remove background (fal)” cuts out an image and “Image to 3D (fal)” turns an image into a 3D model (GLB).

- **Canvas** — left-drag on the empty canvas draws a selection marquee (Shift adds), the toolbar switches between *Select (V)* and *Hand (H)*; you can also pan with Space + drag, the middle mouse button or two fingers on a trackpad, and zoom with Ctrl/Cmd + wheel or a pinch toward the cursor. Undo/redo, copy/paste, groups and notes work as expected.
- **Runs** — a node, the selection or the whole flow runs on the server. Results are cached by their inputs, so unchanged nodes are skipped. Paid nodes are marked with `$`, the run dialog shows the last known cost, and a paid run always asks for confirmation.
- **Batch** — a *Text list* (one item per line, or blocks separated by `---`) or a *Media list* makes the flow run once per item (up to 50). The counter under the list shows how many items are used.
- **fal.ai (MiniMax H3 Max)** — with a `FAL_KEY` the *fal.ai* category offers nodes for every queue endpoint of MiniMax H3 Max (H3 Max video and Turbo, reference video, lip sync, camera move, extend video, insert scene, 3D to video, five styles) plus a free-form *fal.ai model* node for any other endpoint. Media are uploaded to the fal storage, the job runs in the fal queue and the result is fetched in the background, so you can leave the page. Costs are list-price estimates (fal.ai reports no price); the nodes are experimental until they have been tested live. The realtime *director* endpoint is not offered.
- **Image to 3D (fal.ai)** — the node *Image to 3D* turns an image into a 3D model (GLB) with one of four models of your choice: Tripo H3.1, Hunyuan 3D Pro 3.1, Meshy 7.1 or SAM 3D Objects (experimental; you name the object). The front image is required; up to three more views (left, back, right) improve the back of the model where the model takes them (Tripo needs them in that order without a gap, SAM 3D takes none). The model list shows what each model is good at, how many views it takes and the price from; texture, PBR materials and detail level cost extra with some models and the estimate follows your choices. The result is the GLB file plus, where the provider renders one, a preview image. It is shown in the card, the large view and the Design App with the bundled `<model-viewer>` (drag to rotate, wheel or pinch to zoom, no augmented reality); you download the GLB from the download icon or the result menu. Only GLB is stored, nothing uploads a 3D file, and a 3D model cannot be sent to the chat (its preview image can). SAM 3D renders no preview image: connecting its *Preview* output to another node is reported before the run, so nothing is paid first. The node is open to participants and counts against their budget, like *Remove background (fal)*. When fal.ai finishes a job and bills it but no usable GLB comes out (for example SAM 3D delivers only a splat), the list price goes into the cost journal under the name `betreiber` with the note “Kein Ergebnis (Listenpreis)”: the monitoring shows what the operator paid, a participant's budget is not charged. Prices are list prices of 2026-10-02; **check the terms of each provider (Tripo, Tencent Hunyuan, Meshy, Meta SAM) before you use a generated model commercially.**
- **Music and song text (ElevenLabs)** — *Generate music* makes music from a description or from a song text with structure; with a video on its *Length like video* input the music is as long as the video (rounded up, 3 to 600 seconds), otherwise *Length* decides, and a song text sets the length through its sections. *Song text and structure* writes such a song text from an idea. It is plain text you can edit: `+` lines are wanted styles, `-` lines unwanted ones, `[Verse 1 | 20 s]` starts a section (20 s, 20s or 0:20, 3 to 120 seconds, the song 10 minutes at most), every other line is a song line (30 per section, 200 characters each; with the newer models *music_v2* and *music_v2_5* the section name counts as one of the 30 lines, so 29 song lines); `\+`, `\-`, `\[` at the start of a line stand for the character itself. The inspector checks the text while you type and names the line of a problem. To change the text, right-click *Song text and structure* and choose *Use as text*: a Prompt node with the text appears and takes over the connections of that output (one undo step, nothing runs). *Use as text* works for any node with exactly one text result, language-model nodes included. Vocals work in English, Spanish, German and Japanese; ElevenLabs rejects artist names and protected lyrics and the node shows its suggestion. The music is a paid node (the estimate is by the minute, see `ELEVENLABS_MUSIC_USD_PER_MIN` below, and unknown while the length comes through a connection); the song text costs no credits but counts against the limits of your plan and is marked as free. *Text to speech* is a paid node as well, with an estimate by character. Participants may use both and pay from the budget of their team. Guests have no team and a budget of 0: they can use the song text, but the music stops with a budget error.
- **Prompt node** — *Prompt* (first entry of the *Inputs* category) is a dedicated node with a large text field for writing a prompt on the canvas; wire it into one or more generation nodes so the graph shows which prompt goes where. The embedded prompt fields still work: the small button in their corner (and the one next to the field in the inspector) moves the text into a new Prompt node left of the node and connects it (one undo step). Dragging a connection from a node and dropping it on the empty canvas opens a quick pick at that spot with only the nodes that fit (Prompt first for text inputs); Esc or a click beside it cancels.
- **Port help** — hover a port (dot or label, inputs and outputs) for about a third of a second to see what it expects or delivers: name, type, required or optional, a short description, how many connections it takes and in which order they count. Esc, a click, a drag, scrolling or zooming hides it.
- **Several references** — inputs with a double ring (for example *Images* of the H3 Max reference node, *References* of Seedance) take several connections, shown as `n/max` next to the label. Either wire several image nodes to the same input, or wire one *Media list* to it: a list on such an input delivers all its files at once, while a list on a single input runs the node once per item. Draw further connections from the output of each source to the same input (dragging from the input itself detaches its last connection). In prompts, the references count in the order of the connections (H3 Max reference video: "Image 1", "Image 2", "Video 1" …); a media list counts with all of its files and each file counts toward the maximum, so the numbers after a list shift and the hover help then no longer shows positions. Dragging from a multi-input onto the empty canvas offers the *Media list* and the matching single input node first.
- **Motion graphics from HTML** — the *Motion graphics from HTML (render node)* node renders finished HTML/GSAP code, not an instruction. Code comes from a *Motion HTML writer* node in front of it (describe the animation there; attach the same files to both nodes and refer to them as `{{asset:1}}`, `{{asset:2}}` …) or is pasted into the field. To join videos use *Concatenate videos* instead. If the field holds plain text ("make it one video") or HTML without the `data-width` / `data-height` of the chosen format, the node is marked incomplete before the run and says what to change; for plain text the button *Convert to HTML with AI* adds a Prompt node and a Motion HTML writer to the left (your text becomes the prompt, the format and the files are copied, the field is cleared, one undo step). Nothing runs until you start it; the writer is a paid node and asks for confirmation as usual.
- **Assets** — every image/video/audio input takes an upload, a file from one of your chats, or an asset already produced in this workflow.
- **Export and import** — the workflow menu offers *Export (JSON)* (graph and app only) and *Export with files (ZIP)*, which adds the input images, videos and audio of the nodes (generated results stay out; the results ZIP covers those). Before the ZIP download the size is shown; above 500 MB or 200 files a hint says that an import with the default limits fails (the export itself still works). *Import* takes `.json` and `.zip`, recognised by extension and content. A ZIP shows an upload card with progress and is checked completely before anything is created (500 MB, 200 files, only images, video and audio, no unsafe paths); on any error nothing is left behind. After every import a note says how many files came along, for example “3 of 4 files imported, 1 missing”. A JSON import on the same server takes back the files you are allowed to see (your own or shared workflows); everything else stays marked missing and is uploaded again in the node.
- **Templates** — *New from template* offers ready flows, for example: Product hero (4 variants), Still to vertical ad with voice-over, Consistent character series (batch), Continuous shots via last frame, Motion title over footage, Masked edit, Clip in three national languages (Higgsfield dubbing with lip sync), Talking portrait (ElevenLabs voice plus H3 Max lip sync on fal.ai), Photo to 3D model (background removal, then Tripo on fal.ai), Video with music (music as long as the video, mixed quietly under the original sound) and Song from an idea (song text, then music). Templates whose provider is not configured are shown as unavailable; their texts come in English, German and Spanish.
- **Design App** — switch on *Design App* in the top bar, expose parameters of your nodes (the small toggle next to a field) and pick the result nodes. `#app=<workflow id>` then shows a clean form with a *Run* button, live status, a result gallery, downloads and *Send to chat*. The form values only apply to that run; the saved workflow is not changed.
- **Chat bridge** — *Send to chat* first shows what will be sent (media with a small preview, texts with their first characters; extra texts of a media result start unchecked), then copies the result into a chat of your choice. There it appears as a card with the workflow, the node, a player or thumbnail, collapsible texts and a link back to the workflow. The Director sees the files with their asset IDs and can continue from there; nothing starts automatically.
- **Projects** — assign a workflow to a project (the same folders your chats use); the project name shows in the workflow list. Who can see a workflow depends on the [user management](#user-management-optional) (open for everybody when it is off); deleting one also deletes its media (the app asks for confirmation first).

## Motion-graphics render node (optional)

The `render_motion_graphics` tool sends HTML/GSAP compositions to a small render service (Node + [hyperframes](https://www.npmjs.com/package/hyperframes) + Chrome + ffmpeg) that can run on the same machine or any other computer — reachable directly or through an SSH tunnel. The service ships in this repo under [`render-node/`](render-node/README.md). Multiple nodes are load-balanced automatically (idle first, then shortest queue), and imported media stream to the node in chunks (up to 500 MB per render). Configure nodes in **Menu → Settings → Render nodes**.

## User management (optional)

Out of the box the app is single-machine and open: everybody may do everything, nothing has an owner. **User management is active if and only if `AUTH_WHOAMI_URL` is set.** The login itself stays outside the app: put it behind your own login (any auth proxy that can answer a whoami endpoint `{ "logged_in": true, "email": "…" }` for the caller's cookie). The app never asks for a password.

| Setting | Meaning |
| --- | --- |
| `AUTH_WHOAMI_URL` | Whoami endpoint of your login. Setting it turns user management on. Unset = the local mode, exactly as before |
| `ADMIN_EMAILS` | Comma-separated admins (more can be added in Menu → Settings). No built-in default |
| `SUPERADMIN_EMAILS` | Comma-separated superadmins, any domain. Environment only, never editable in the app. They are admins as well and may open the monitoring page |
| `AUTH_LOGOUT_URL` | Optional sign-out link for the account menu (`https://…` or an absolute path). Without it there is no sign-out entry |
| `INTERNAL_EMAIL_DOMAINS` | Comma-separated e-mail domains of your own organisation (e.g. `example.com`). Their addresses are *internal people*. Only relevant with [teams](#teams-with-a-usd-budget-optional): a logged-in address that is neither internal nor in a team is a guest. Unset = everybody logged in counts as internal (the behaviour before teams), except addresses that are or were in a team (also archived or removed): those count as guests. The app warns at startup and in the teams settings while it is unset |
| `ACCESS_ALLOWLIST_FILE` + `ACCESS_ALLOWLIST_ROUTE` | Optional [allowlist sync](#allowlist-sync-optional): path of the JSON file of your login and the route to maintain (e.g. `/training`). Both or none |

Rules in the active mode:

- **Who is who.** The caller is the e-mail address the whoami endpoint returns. A request without a valid address (whoami failed, direct access to the app's port) is anonymous: it sees and uses only what has no owner, and what it creates gets no owner either.
- **Unconfirmed login (fail closed).** As soon as a restriction is active, an anonymous request may be a participant whose login could not be confirmed (whoami timeout, network error, 5xx). A restriction is active when the teams file knows any address (also of removed people), the teams file is unreadable, or `INTERNAL_EMAIL_DOMAINS` is set. Then every `/api` route answers `401` with the code `LOGIN_UNCONFIRMED` (German, English and Spanish text), except the public ones (`GET /api/me`, `/api/nodes/registry`, `/api/workflow-templates`, `/api/roles/default`) and `GET /api/config` (filtered like for guests). The static files and the app shell stay reachable; both views show a banner with a reload button, and the page reloads by itself once the login is confirmed again. A failed whoami call is remembered for 2 s only (a clear answer for 10 s), and no paid action starts for such a request. Without a restriction (no teams ever, no domain list) and in the local mode nothing changes.
- **New chats and node workflows start private** (owner and admins). The owner can share them with the whole team or with selected people from the team list. People a chat is shared with can open it, keep chatting, edit and run a workflow, use its Design App and download its files; only the owner and admins can rename, move, delete or re-share it.
- **Existing data stays open.** Chats and workflows without an owner (created before user management was switched on) remain visible and usable for everybody, including renaming and deleting, exactly as before. Only admins change their sharing; the admin who does becomes the owner.
- **Foreign private entries do not exist for you.** Every route answers 404 (not 403) for a chat or workflow you may not see, and the same holds for its files (`/assets/…`), downloads (ZIP), exports, event streams and runs. Taking a share back ends open event streams.
- **Projects** (folders) show only entries you may see; a project with only other people's private entries is hidden. Renaming or deleting a project that holds other people's entries, or one with a production profile, context files, memory or cast, needs an admin. Project names are unique across the app: a name taken by a project you cannot see is answered with a neutral "not available".
- **The Director's memory follows the chat.** Notes saved with `save_memory` belong to the person who was chatting and only reach that person's chats (notes from before user management stay global). Notes saved with `save_project_memory` are only shown, and only reach the prompt, for people who may use the chat they came from (sharing the chat shares them; admins see all). Chat tools that change brandings (`create_branding`, `update_branding`, `add_branding_asset`) are admin-only like branding import/delete. Known limit: the cast tools (`create_cast_member`, `update_cast_member`, `import_cast_asset`) stay available to everybody who may use the project, because they are the only way to fill the cast (participants and guests only in projects they created themselves); only deleting a member is admin-only.
- **Admin-only** (the rest is open to everybody who is logged in): Menu → Settings and API keys, admin and user management, render nodes, Higgsfield and ChatGPT connections, roles, custom prompt presets, branding import/delete, project profiles (guidelines, context files, memory, cast).
- **Team list.** The people you can share with: admins, people an admin added in Menu → Settings (`data/users.json`) and everybody who has used the app once (recorded automatically with *first/last seen* in `data/team-seen.json`). It is not an access list — access stays with your login. Admins can remove entries; a removed person is not recorded again until an admin adds them back.
- **Costs** are recorded per person; admins see all costs, everybody else only their own.
- **Monitoring** (superadmins only, everybody else gets a 404): `/monitoring.html` and `GET /api/admin/monitoring` (`?days=7|30|90|all&user=…&provider=…`, CSV: `/api/admin/monitoring/export`) show usage and costs per person, provider and day, runs, jobs and failed requests.

What people see in the interface (nothing of this appears in the local mode):

- **Menu** (top right, in the chat and in the node view): initials chip, e-mail address, role (person, admin, superadmin), the person's own costs of the month, settings (admins), *Help*, a link to the monitoring page for superadmins, the language and a *Sign out* entry if `AUTH_LOGOUT_URL` is set. In the local mode the same menu sits behind a three-dots button and has costs, settings, help and language. A person who is not identified sees a note that only entries without an owner are available.
- **Sidebar and header.** Somebody else's chat shows its owner next to the date (full address as tooltip) and an *Internal*, team-name or *n people* badge when it is shared. In the header the breadcrumb *Project / chat title* shows the owner (*by name*) only in somebody else's chat; owners who are admins carry an *ADMIN* badge. *Shared* is a status with a green dot, *Shared with you* in somebody else's chat; whoever may not manage the sharing sees the status without a button. Chats and workflows that existed before user management show neither a badge nor an owner.
- **Share button** (chats in the header and sidebar menu, workflows in the node view header and list menu; only for the owner and admins): private, *everyone internal*, *teams* or selected people (the modes depend on the account, see *Interface of the teams* below). For an entry without an owner the dialog says so; saving makes the admin the owner. If the owner takes the sharing back while somebody has the entry open, it closes with a short message (also for open event streams).
- **Design App links.** Copying the app link of a private workflow reminds you that others can only open it after it has been shared.
- **Admin-only parts** (custom prompt presets, new roles, branding import/delete, project profile editing) are hidden for everybody else; the project profile opens read-only. Menu → Settings show a *Team list* with first/last seen (add or remove people) and, for superadmins, a link to the monitoring page.

## Teams with a USD budget (optional)

Teams are for trainings and courses: people from outside your organisation get access to the app, a fixed USD budget and a deliberately narrow view. They need the user management (`AUTH_WHOAMI_URL`); in the local mode the team routes answer `400 USER_MANAGEMENT_INACTIVE` and nothing changes. Without teams and without `INTERNAL_EMAIL_DOMAINS` the app behaves exactly as described above.

**Roles.** Admins create teams in the interface (Menu → *Manage teams*, or Menu → Settings → *People*; see *Interface of the teams* below) or through the API (`/api/teams`, admin only) and add people by e-mail address.

| Role | Who | Sees and may do |
| --- | --- | --- |
| Admin / superadmin | `ADMIN_EMAILS`, `SUPERADMIN_EMAILS`, admins added in Menu → Settings | Everything, no budget |
| Internal person | Address of `INTERNAL_EMAIL_DOMAINS` (or, unset, any logged-in address that is not and never was in a team) that is in no team | As before: existing data, all tools, no budget |
| Participant | Member of at least one active team (also with an internal address) | Own chats, workflows and projects and what is shared with their team; the budget of their team; no internal resources |
| Guest | Logged in, not internal, in no team | Like a participant with a budget of 0 (free things only) |
| Anonymous | No valid login | As before |

**What a participant does not get.** Existing data without an owner and every private entry of others (404), the internal knowledge base (GTS), brandings, team roles and custom prompt templates, the project profile (guidelines, context files, brandings) of projects they did not create, the names of render nodes, the ChatGPT subscription models, all Higgsfield tools and nodes (operator credits) and the cloned ElevenLabs voices (library voices only). They can share only with teams they are in or with people of their own teams, never with "everybody internal". Guests can only keep things private. Answers say why: `403 FORBIDDEN_FOR_ROLE` with the `feature` (`gts`, `higgsfield`, `chatgpt` …).

**Expensive Director models (optional).** `config.json` accepts `restrictedBrainModels`, a list of model ids (for example `["openai/gpt-5.6-luna", "google/gemini-3.1-pro"]`). When it is set, participants and guests see and use only these Director models: in the chat menu, as default model (the configured `defaultBrain` if it is on the list, else the first entry) and in the LLM nodes. The server enforces it: a chat request for another model is answered by the default model of the list (with a notice), and an LLM node that names another model is refused with `403 FORBIDDEN_FOR_ROLE` (`feature`: `models`). Empty or missing: nothing changes. The ChatGPT subscription models stay unavailable for them in any case; internal people and admins are not affected. There is no settings screen for it, the file is enough.


**Image models in the node view (optional).** `config.json` accepts `imageModels`, a list of OpenRouter image model ids (default: `["openai/gpt-image-2", "google/gemini-3-pro-image"]`, GPT Image 2 and Nano Banana Pro). The nodes *Generate image* and *Edit image* offer exactly these models plus the entry "Default" (the model in `imageModel`, which always counts as listed and keeps old workflows working). The choice is made per node. The list shows what each model takes (reference images) and, where a price is known, what an image costs; the estimate of the chosen model feeds the plan and the budget of participants. A workflow that names a model outside the list is refused when it runs (`IMAGE_MODEL_NOT_ALLOWED`), so a shared or imported workflow cannot spend on an arbitrary model. The same list applies to everybody, as in the chat. Missing or invalid: the default list.

**Sharing with teams.** A new sharing mode `teams` (`sharedTeams`: up to 20 team ids) makes a chat or workflow available to all members of these teams at once — and only them. Internal people may pick any active team, participants only their own. Removing a person from a team or archiving the team ends the access at once.

**Interface of the teams.** *Admins:* Menu → *Manage teams* (or Menu → Settings → *People*, the teams come first) lists every team as a card: people, USD per person, amount spent. An opened team has its name, amount and description with *Archive* / *Reactivate* / *Delete*, a paste box and the table of members (last seen, spent, left, budget). *Change budget* sets an own amount for one person (marked *custom*, *Team amount* takes it back), *Reset* restarts the counting from now, *Remove* ends access and budget at once; reset, remove and delete need a second click. The paste box takes anything with addresses — an Excel column, one per line, separated by commas or semicolons, `Name <mail@example.com>` from a mail program — and previews *N new · M already in the team · K invalid* (the invalid pieces can be expanded) before one button adds the new ones in a single request (up to 500). The team list in the settings has the same paste box. When the allowlist sync failed, a warning appears above the list; the team is saved anyway. Superadmins get a *Team* filter and a *Teams and budget* table (budget, spent, left, reserved, spending in the period, jobs without price per person) in the monitoring. *Participants:* the menu shows the budget left with a bar, the amount and the spending, and the teams; a line above the chat says when the budget runs low or is used up, and paid actions that are refused (`402`) or not available (`403`) are explained in the interface language while chats and results stay readable. A paid node run shows the remaining budget and its estimate in the confirmation dialog and is not offered at all when the estimate exceeds what is left. The share dialog offers *Private*, *Teams* (only the person's own) and *Specific people* (only teammates); internal people and admins also get *Everyone internal*, guests can only keep things private. The help page (`public/help.html`) explains all of this in *Teams and trainings* and *Budget and participation*.

**Budget.** Every team has an amount in USD **per person** (0 to 10 000, whole cents). Per person it can be overridden (`budgetOverrideUsd`) or restarted (`resetBudget`: counting starts again from now). Someone in several teams has the highest amount and the latest start of their memberships; joining a new team starts a fresh count. The spent amount comes from the cost journal (`data/costs.jsonl`, every row carries the person) and is read incrementally, never as a whole. Costs the provider does not report count 0; admins see such jobs in the monitoring (`unknownCostJobs`).

Every place that can spend money asks the budget first, and answers `402` before anything starts:

- chat turns (before the stream, and before every tool round of a turn),
- the Director's tools `generate_image`, `edit_image`, `generate_video`, `generate_speech` and (node view) `fal_generate`,
- node runs: the plan estimate must fit and is reserved for the run; the plan (`POST /api/workflows/:id/runs/plan`) reports `budget` and `blocked` nodes,
- the assistant of the node view (`POST /api/workflows/:id/assistant`, one `llm.completeText` call, a second one only to repair an invalid proposal; the real cost is booked on the person, 5 cents are reserved while a question runs and charged when the provider reports no cost; at most 30 questions per person in 10 minutes);
- LLM nodes (`llm.completeText`); asynchronous jobs (video, fal) keep their reservation until the poller has booked the cost. A video started from the model card reserves the estimated price of the chosen model (the upper end of the estimate). Where a video job has no price in advance, the Director reserves a flat `BUDGET_ASYNC_HOLD_USD` (default 2, at most what is left) per job, and a participant may have at most `BUDGET_MAX_OPEN_JOBS` (default 2) provider jobs open at once (`429 BUDGET_JOBS_OPEN`). When a node run is cancelled or times out while a provider job is still running, the run's reservation moves to that job instead of being released.
- Speech (`generate_speech`) is priced per character (`ELEVENLABS_USD_PER_1K_CHARS`, default 0.30): the estimate is reserved, booked as a cost of type `speech` (for every person, internal ones too) and shown in the monitoring.
- Music (`generate_music`, node view only) is priced by the minute (`ELEVENLABS_MUSIC_USD_PER_MIN`, default 0.20, an estimate; the ElevenLabs Music API needs a paid ElevenLabs plan): the estimate is reserved, booked as a cost of type `music` and shown in the monitoring. A guest has no budget, so the music stops with `BUDGET_EXHAUSTED`. The song text (`plan_music`) is not booked.

Codes: `BUDGET_EXHAUSTED` (nothing left) and `BUDGET_INSUFFICIENT` (the price estimate exceeds what is left) — body with `budget`, `estimateUsd`, `remainingUsd` and a German `error` text. Chats, results and downloads stay available when the budget is used up. Reservations of parallel actions are kept in memory (restored for open jobs after a restart).

*Known limit:* where no price is known in advance (images; videos use the flat reservation above) only "something is left" is checked, so a few parallel jobs of one person can still overshoot the budget by their own price; the real cost is booked afterwards and the next action is refused.

**Chats and workflows by team (admins).** Admins see every chat and workflow. A switch “Projects | Teams” above the chat list and the workflow list of the node view groups them by team (default: “Projects”, the choice is remembered per view in the browser). Each team is a collapsible group with its number of chats or workflows and people; archived teams follow collapsed, everything without a team (owners without a team, guests, old data without an owner) comes last as “Internal”; every entry names its owner. Everybody else gets no switch and no team information (the server refuses the group routes with `403`). Which team an entry belongs to: new chats and workflows store `teamId`, the active team of the creator (the one joined last if there are several); only the server sets it, no request body can (also not on import, where a `teamId` in the file is dropped, and not on duplicating: that stores the team of whoever duplicates). Entries without `teamId` belong to the owner's team at the time of creation: the membership with the latest `addedAt` that is not later than `createdAt` (archived teams count), else the earliest later one, else “Internal”. A stored team that was deleted sends the entry to “Internal”; removing a person from a team drops the derived assignment of their older entries but keeps the stored one. The groups are complete however the chat list pages (they come from the in-memory index of the session files, no file is read again). The keyboard focus stays on the group head or the “Load more” button when a group is opened, closed or extended, and an answer for a group that was read before a chat was deleted is dropped and read again. In the team view the sidebar heading reads “Chats”.

**API** (admin only unless noted; `sync` is the state of the allowlist sync):

| Route | Purpose |
| --- | --- |
| `GET /api/teams`, `POST /api/teams` | List / create (`name`, `budgetUsd`, `description`) |
| `GET/PATCH/DELETE /api/teams/:id` | Detail with the budget of every person / rename, change amount, `archived` / delete |
| `POST /api/teams/:id/members` | `{ emails: [...] }` or `{ text }`: up to 500 at once, answers `added`, `already`, `invalid`, `duplicates` |
| `PATCH /api/teams/:id/members/:email` | `{ budgetOverrideUsd: number or null }` or `{ resetBudget: true }` |
| `DELETE /api/teams/:id/members/:email` | Remove a person |
| `GET /api/teams/mine` | Any logged-in person: the teams they may share with |
| `GET /api/sessions/team-groups` | The groups of the chat list: `{ groups: [{ id, name, archived, internal, count, people, lastActivity }], total }`, active teams by latest activity, archived ones, then `id: "none"` (internal) |
| `GET /api/sessions?team=<id\|none>&limit=&offset=` | The chats of one group, paged; every chat carries `team: { id, name, archived }` or `null`. With `q=…&teams=1` the flat search result carries the team as well |
| `GET /api/workflows` | Admins in addition get `team` per workflow and `teamGroups` (same head data); the list is not paged, the client groups it |
| `POST /api/users` | Also `{ emails: [...] }` / `{ text }` for the team list (same parser) |
| `GET /api/admin/monitoring?team=<id>` | Superadmins: usage and budget picture per team and person (`teams`, `options.teams`) |

Pasted lists (Excel columns, Outlook / Gmail recipient lists, CSV, one address per line) are read by one shared parser (`public/email-list.js`, in the browser and on the server): lower case, duplicates once, pieces that are not addresses reported as `invalid`.

Data: `data/teams.json` (chmod 600, written atomically), `data/folder-owners.json` (who created a project) and `data/access-sync.json`. Errors: `400` with `INVALID_TEAM`, `INVALID_BUDGET`, `TEAM_NAME_TAKEN`, `NO_EMAILS`, `INVALID_EMAILS`, `TOO_MANY_EMAILS`, `TEAM_FULL`, `SHARE_MODE_FORBIDDEN`, `UNKNOWN_TEAMS`; `404` with `TEAM_NOT_FOUND`, `MEMBER_NOT_FOUND`.

### Allowlist sync (optional)

Participants have addresses your login does not know. If your login keeps an allowlist file (`{ "default": {...}, "routes": [{ "path": "/training", "public": false, "extra_emails": [...] }] }`), set `ACCESS_ALLOWLIST_FILE` (path) and `ACCESS_ALLOWLIST_ROUTE` (route). After every change of a team the app then makes `extra_emails` of that route hold the manually maintained addresses plus everybody in an active team (addresses of `INTERNAL_EMAIL_DOMAINS` are not entered). Manual entries and other routes are never touched: only what the app added itself is removed again (remembered in `data/access-sync.json`, written before the list changes, with a copy next to the list; an unreadable record stops the sync with a warning). The file is written atomically (a symlink is followed; the owner is kept where the app may set it; a single file mounted into a container is written in place), keeps its permissions, and a copy `<file>.bak-<timestamp>` is made once before the first change; a missing route is created. A failure never blocks the team change — it shows up as a warning in `sync`. Both variables unset = nothing happens.

## Tests

```bash
npm test                          # every scripts/test-*.js, one after another
npm test -- nodes-generate        # only tests whose file name contains the text
npm test -- --timeout=600         # seconds per test (default 240)
npm test -- --jobs=4              # several at once (faster; tests share data/ and projects/, so they can collide)
```

`scripts/run-tests.js` starts each `scripts/test-*.js` as its own process and prints `PASS` or `FAIL` with the duration, then `n/m passed` (exit code 1 if anything failed). A test passes only if it exits with 0 **and** its last output line is `<file name>: ok`; a test that just stops early (for example a promise that never settles) is reported as `FAIL ... silent end`. Every new test therefore ends with `console.log('test-<name>.js: ok')`, after its last check. Some tests skip their browser part when Chrome or `render-node/` is missing, and `test-minimal-config.js` depends on your local `.env`.

## Help and contributing

The help page (`public/help.html`, linked in the menu) documents every function in German, English and Spanish. Whoever changes a function updates all three language blocks; see [docs/agent-rules.md](docs/agent-rules.md).

## Third-party software

- **`<model-viewer>`** 4.3.1 (Google, [Apache-2.0](public/vendor/model-viewer/LICENSE), includes three.js) shows 3D results. It is shipped in [`public/vendor/model-viewer/`](public/vendor/model-viewer/SOURCE.txt) (version, source and integrity value of the npm registry are noted there), loaded only when a 3D model is shown, and is no entry of `package.json`. The decoders for compressed models (Draco, KTX2, Meshopt) are **not** shipped: an ordinary GLB, as the image-to-3D nodes deliver it, makes no request to another address, but a compressed model makes `<model-viewer>` load its decoder from Google (`www.gstatic.com`). The bundle names one more address as the default for Lottie textures (`cdn.jsdelivr.net`); no GLB uses it, and the app points that setting at itself before the viewer starts. A GLB that points at images or data outside its own file is not stored (the result fails with a message), so the statement holds for every model the nodes deliver.

## License

[MIT](LICENSE) © 2026 Kuble AG — built by the [Kuble](https://kuble.com) team with Claude Code and Codex.
