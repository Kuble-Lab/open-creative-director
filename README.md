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
| Higgsfield account | Optional | 30+ extra image/video models for the Director | No key — click **Connect** in Menu → Settings and sign in to Higgsfield in the browser (OAuth login, tokens stay on the server). Behind a reverse proxy set `PUBLIC_BASE_URL` so the browser can reach the callback |
| ChatGPT subscription | Optional | Run the Director on GPT-5.6 models billed to your ChatGPT Plus/Pro plan instead of per-token | No key — log in to the [Codex CLI](https://github.com/openai/codex) with "Sign in with ChatGPT", then click **Import from Codex CLI login** in Menu → Settings. Unofficial route via the Codex backend (gray area in OpenAI's terms) — use at your own discretion |
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

Besides the chat, the **Chat | Nodes** switch in the header opens a canvas for building reusable production flows. Nodes for inputs (text, text list, images, videos, audio), LLM steps, image/video/audio generation, ffmpeg editing and results are wired together; every workflow keeps its media in its own hidden session, so nothing shows up in your chat list.

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

**Sharing with teams.** A new sharing mode `teams` (`sharedTeams`: up to 20 team ids) makes a chat or workflow available to all members of these teams at once — and only them. Internal people may pick any active team, participants only their own. Removing a person from a team or archiving the team ends the access at once.

**Interface of the teams.** *Admins:* Menu → *Manage teams* (or Menu → Settings → *People*, the teams come first) lists every team as a card: people, USD per person, amount spent. An opened team has its name, amount and description with *Archive* / *Reactivate* / *Delete*, a paste box and the table of members (last seen, spent, left, budget). *Change budget* sets an own amount for one person (marked *custom*, *Team amount* takes it back), *Reset* restarts the counting from now, *Remove* ends access and budget at once; reset, remove and delete need a second click. The paste box takes anything with addresses — an Excel column, one per line, separated by commas or semicolons, `Name <mail@example.com>` from a mail program — and previews *N new · M already in the team · K invalid* (the invalid pieces can be expanded) before one button adds the new ones in a single request (up to 500). The team list in the settings has the same paste box. When the allowlist sync failed, a warning appears above the list; the team is saved anyway. Superadmins get a *Team* filter and a *Teams and budget* table (budget, spent, left, reserved, spending in the period, jobs without price per person) in the monitoring. *Participants:* the menu shows the budget left with a bar, the amount and the spending, and the teams; a line above the chat says when the budget runs low or is used up, and paid actions that are refused (`402`) or not available (`403`) are explained in the interface language while chats and results stay readable. A paid node run shows the remaining budget and its estimate in the confirmation dialog and is not offered at all when the estimate exceeds what is left. The share dialog offers *Private*, *Teams* (only the person's own) and *Specific people* (only teammates); internal people and admins also get *Everyone internal*, guests can only keep things private. The help page (`public/help.html`) explains all of this in *Teams and trainings* and *Budget and participation*.

**Budget.** Every team has an amount in USD **per person** (0 to 10 000, whole cents). Per person it can be overridden (`budgetOverrideUsd`) or restarted (`resetBudget`: counting starts again from now). Someone in several teams has the highest amount and the latest start of their memberships; joining a new team starts a fresh count. The spent amount comes from the cost journal (`data/costs.jsonl`, every row carries the person) and is read incrementally, never as a whole. Costs the provider does not report count 0; admins see such jobs in the monitoring (`unknownCostJobs`).

Every place that can spend money asks the budget first, and answers `402` before anything starts:

- chat turns (before the stream, and before every tool round of a turn),
- the Director's tools `generate_image`, `edit_image`, `generate_video`, `generate_speech` and (node view) `fal_generate`,
- node runs: the plan estimate must fit and is reserved for the run; the plan (`POST /api/workflows/:id/runs/plan`) reports `budget` and `blocked` nodes,
- LLM nodes (`llm.completeText`); asynchronous jobs (video, fal) keep their reservation until the poller has booked the cost. Where a video job has no price in advance, the Director reserves a flat `BUDGET_ASYNC_HOLD_USD` (default 2, at most what is left) per job, and a participant may have at most `BUDGET_MAX_OPEN_JOBS` (default 2) provider jobs open at once (`429 BUDGET_JOBS_OPEN`). When a node run is cancelled or times out while a provider job is still running, the run's reservation moves to that job instead of being released.
- Speech (`generate_speech`) is priced per character (`ELEVENLABS_USD_PER_1K_CHARS`, default 0.30): the estimate is reserved, booked as a cost of type `speech` and shown in the monitoring.

Codes: `BUDGET_EXHAUSTED` (nothing left) and `BUDGET_INSUFFICIENT` (the price estimate exceeds what is left) — body with `budget`, `estimateUsd`, `remainingUsd` and a German `error` text. Chats, results and downloads stay available when the budget is used up. Reservations of parallel actions are kept in memory (restored for open jobs after a restart).

*Known limit:* where no price is known in advance (images; videos use the flat reservation above) only "something is left" is checked, so a few parallel jobs of one person can still overshoot the budget by their own price; the real cost is booked afterwards and the next action is refused.

**API** (admin only unless noted; `sync` is the state of the allowlist sync):

| Route | Purpose |
| --- | --- |
| `GET /api/teams`, `POST /api/teams` | List / create (`name`, `budgetUsd`, `description`) |
| `GET/PATCH/DELETE /api/teams/:id` | Detail with the budget of every person / rename, change amount, `archived` / delete |
| `POST /api/teams/:id/members` | `{ emails: [...] }` or `{ text }`: up to 500 at once, answers `added`, `already`, `invalid`, `duplicates` |
| `PATCH /api/teams/:id/members/:email` | `{ budgetOverrideUsd: number or null }` or `{ resetBudget: true }` |
| `DELETE /api/teams/:id/members/:email` | Remove a person |
| `GET /api/teams/mine` | Any logged-in person: the teams they may share with |
| `POST /api/users` | Also `{ emails: [...] }` / `{ text }` for the team list (same parser) |
| `GET /api/admin/monitoring?team=<id>` | Superadmins: usage and budget picture per team and person (`teams`, `options.teams`) |

Pasted lists (Excel columns, Outlook / Gmail recipient lists, CSV, one address per line) are read by one shared parser (`public/email-list.js`, in the browser and on the server): lower case, duplicates once, pieces that are not addresses reported as `invalid`.

Data: `data/teams.json` (chmod 600, written atomically), `data/folder-owners.json` (who created a project) and `data/access-sync.json`. Errors: `400` with `INVALID_TEAM`, `INVALID_BUDGET`, `TEAM_NAME_TAKEN`, `NO_EMAILS`, `INVALID_EMAILS`, `TOO_MANY_EMAILS`, `TEAM_FULL`, `SHARE_MODE_FORBIDDEN`, `UNKNOWN_TEAMS`; `404` with `TEAM_NOT_FOUND`, `MEMBER_NOT_FOUND`.

### Allowlist sync (optional)

Participants have addresses your login does not know. If your login keeps an allowlist file (`{ "default": {...}, "routes": [{ "path": "/training", "public": false, "extra_emails": [...] }] }`), set `ACCESS_ALLOWLIST_FILE` (path) and `ACCESS_ALLOWLIST_ROUTE` (route). After every change of a team the app then makes `extra_emails` of that route hold the manually maintained addresses plus everybody in an active team (addresses of `INTERNAL_EMAIL_DOMAINS` are not entered). Manual entries and other routes are never touched: only what the app added itself is removed again (remembered in `data/access-sync.json`, written before the list changes, with a copy next to the list; an unreadable record stops the sync with a warning). The file is written atomically (a symlink is followed; the owner is kept where the app may set it; a single file mounted into a container is written in place), keeps its permissions, and a copy `<file>.bak-<timestamp>` is made once before the first change; a missing route is created. A failure never blocks the team change — it shows up as a warning in `sync`. Both variables unset = nothing happens.

## Help and contributing

The help page (`public/help.html`, linked in the menu) documents every function in German, English and Spanish. Whoever changes a function updates all three language blocks; see [docs/agent-rules.md](docs/agent-rules.md).

## License

[MIT](LICENSE) © 2026 Kuble AG — built by the [Kuble](https://kuble.com) team with Claude Code and Codex.
