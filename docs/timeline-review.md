# Timeline review (clip approval before the cut)

Status: specification for the first version. Keep this file as the documentation of the feature and correct it where the code ends up different.

## Goal

A general feature of the node view: for every node that cuts single clips into a film, a **timeline** shows which clip is placed when and for how
long, with the sound of the film (song, voice or music) as a waveform underneath. A person plays each clip against exactly the piece of sound it is
cut to, **approves** it or writes **feedback in words**; the language model (default `anthropic/claude-fable-5.2`, the HUD planner default) rewrites
the prompt of that one clip and only that clip is made again. With the setting on, the cutting node **refuses to render the film until every clip
is approved**.

Version 1 only shows and reviews the plan. Clips cannot be moved or trimmed.

## Parts

### 1. Timeline model: `def.timeline` on cutting nodes

A node definition may have `timeline(context) -> model | null`. It is pure, reads only what the engine already resolved for the node (the stored
results of the upstream nodes, never a paid call) and returns:

```js
{
  duration,                 // seconds of the film
  audio: { port, item },    // which input of this node is the sound under the film (item: index in a list, or null); null without sound
  sections: [{ start, end, name }],            // optional
  lines: [{ start, end, text, voice }],        // optional: words with their singer/speaker where the plan knows them
  clips: [{
    key,            // stable within the plan, e.g. "duet:3", "story:12", "scene:s4", "clip:0"
    start, duration,
    kind,           // 'duet' | 'performance' | 'guest' | 'story' | 'still' | 'scene' | 'clip' | 'intro' | 'outro'
    label, text,    // short name and what is sung/said/shown (may be empty)
    port, item,     // the input port of THIS node and the index in its list that delivers the clip
    lipsync: bool   // true where the clip must match the sound (performance, duet, presenter)
  }]
}
```

First adapters:

- `music_video.edit`: from the `shots` JSON (`lib/music-video-plan.js` `parseShots`): `kind`, `start`, `duration`, `clip`, `section`, `line`,
  `voice`. `voice: 'duet'` reads from port `duet`, other performance from `performance`, story from `story`, still from `still_clips`. Sound: `song`.
  This also covers the HUD music video and the ad spot template, which cut with this node.
- `explainer.edit`: scenes in order from `shots`/`timing`; sound per scene is the voice (`audio` list), so `audio` is null and every clip carries
  `sound: { port: 'audio', item }` instead; the UI then draws the scene voices one after the other in the waveform row. `clips`, `intro`, `outro`
  where present.
- `video.concat`: the clips in edge order, starts from the real durations of the assets, no sound row (the clips play with their own sound).
- `event_video.cut`: add it if its plan gives clean clip times; otherwise leave it out and say so here.

Nodes that cut one recording (`video.rough_cut`, `video.social_clips`) are out of scope.

### 2. Timeline service: `lib/timeline/`

`lib/timeline/service.js` (used by the routes; keep it free of Express) builds the view for one cutting node of a workflow:

- runs `def.timeline` with the selected results of the upstream nodes (the same values the engine would resolve; reuse the engine/result-service
  helpers, do not copy the resolution logic),
- resolves for every clip the **asset** at `port`/`item` (id, url, real duration), `over` = real duration minus slot duration when positive by
  more than 0.3 s and `lipsync` is true (the model delivered a clip longer than its piece of sound), `missing` when there is no asset yet,
- finds the **producer**: the upstream node and item index that made the asset (follow the edge; through `input.media_list`/`util.pick` style
  pass-through only where it is unambiguous, otherwise `producer: null`), its current prompt text for that item (the first mapped text input, as
  `public/nodes/scene-table.js` `mainText` does it) and what feedback it can take (see 4),
- merges the **review state** (see 3).

It also lists the cutting nodes of a workflow that have a timeline.

### 3. Review state: `lib/timeline/review-store.js`

One JSON file per workflow next to its other data (same locking/atomic write pattern as the results store). Per cutting node and clip key:
`{ status: 'approved', assetId, by, at }` and the feedback history `[{ text, by, at, was, prompt }]` (at most 10 per clip). An approval is bound
to the asset: when the clip at that place is a different asset, the clip is open again. Deleting a workflow removes the file; duplicating does
not copy it.

### 4. Feedback

`feedback(viewer, workflowId, nodeId, clipKey, { text, rev })`:

1. The producer has a `notes` param with `items` (the explainer scene/voice nodes): write the note there for that item. No model call; the node
   already knows what to do with a note.
2. Otherwise the producer gets the clip's prompt from a mapped text input: ask the model to rewrite **that one prompt** (system prompt: keep the
   format, the subject tags and the timing lines of the prompt exactly, change only what the feedback asks; return only the new prompt; inputs:
   current prompt, the feedback, kind, sung/said line, duration, the prompts of the neighbours for continuity). Book the model cost like other
   brain calls of the node view (cost journal, participant budget). Store the result as an **item edit** on the producer node (see 5).
3. Otherwise feedback is not possible for this clip; the UI offers only "make again" (a plain re-roll) and approval.

The graph is saved through the normal save path with the browser revision (`rev`, conflict → 409 like other edits; refused while a run is
active). The answer carries the new prompt and the run request the UI should start: `{ mode: 'items', nodeId: <producer>, items: [index] }`.
The run itself goes through the **normal cost path** of the node view (estimate, cost dialog/auto approval). The service never starts a paid run.

A re-roll without feedback is the same run request with no edit.

### 5. Engine: item edits

`node.itemEdits = { [portId]: { [index]: { text, was } } }` on any node. The graph normaliser keeps unknown node fields;
`normalizeGraph` validates this field explicitly and rejects invalid data with `INVALID_WORKFLOW`: declared text inputs only (`text` or
`text[]`, including dynamic ports), at most 200 entries across the node, canonical non-negative safe integer indexes, `text` a string of at
most 8000 JavaScript characters and `was` a string. Unknown node types cannot carry non-empty item edits because their ports cannot be
validated. Empty port maps and an empty `itemEdits` object are omitted.

Only a **mapped scalar text input** applies edits: a `text` port fed by a list, after normal input coercion. Whole-list inputs (`text[]` or
`multiple`) and scalar values stay unchanged. An entry whose `was` equals the current upstream text of that item replaces it with `text`;
a stale entry (upstream changed) is ignored. Execution logs a stale edit once per engine instance, using a bounded deduplication set; plans
stay read-only and do not log it again. No prompt content is logged. The pure `applyItemEdits` helper exported by `lib/nodes/engine.js`
returns `{ value, edited, stale }` (the index lists identify applied and stale edits) without mutating the upstream list. Its implementation
is shared with the inspector in `public/nodes/item-edits.js`.

Because item keys are computed from the item's inputs, only the edited item runs again; planning/estimates use the same input resolver and
see the same replaced value. Nodes without edits keep their cache keys. Where the inspector already has a scene table, its main text shows
the edited prompt and a marker, or the upstream text and an outdated marker for a stale edit. Removing an edit uses the normal graph save
and undo path. No new table is forced onto other nodes.

### 6. The gate

Every node with `timeline` gets the param `review` (`off` | `required`, default `off`, not part of the cache key). With `required`, the engine
checks before executing the node that every clip of its timeline is approved for its current asset; otherwise the node stops with code
`TIMELINE_REVIEW_OPEN` (`data: { open, total }`), nothing downstream runs, and nothing is charged. The node view shows this state as "waiting
for review" with a button that opens the timeline, not as a red failure. Planning (estimate) reports the stop in advance where it can.
The app view and agents are unaffected while the param is `off`; templates stay `off`.

### 7. Routes (`lib/nodes/routes.js`, same access rules as editing/running the workflow)

- `GET  /api/workflows/:id/timeline` → the cutting nodes with a timeline
- `GET  /api/workflows/:id/timeline/:nodeId` → the view of 2
- `PUT  /api/workflows/:id/timeline/:nodeId/review` `{ keys: [...] | kind, status: 'approved' | 'open' }`
- `POST /api/workflows/:id/timeline/:nodeId/clips/:key/feedback` `{ text, rev }`

No new MCP tools in this version (note it in the PR as follow-up for parity).

### 8. Interface

`public/nodes/timeline.js` (pure, UMD like `scene-table.js`: layout of clips for a zoom level, status of a clip, counts, which clip is at a
time, peaks from PCM samples, keyboard actions) and `public/nodes/timeline-ui.js` (DOM). A full-size overlay of the node view, opened from a
button "Timeline" on the card and in the inspector of a cutting node (and from the waiting-for-review state).

Layout (reference picture: `docs/screenshots/timeline-review-draft.png`):

- header: workflow name, "n of m approved" with a bar, counts (feedback, being made again, open), "Approve all <kind>", the switch "Render the
  film only after approval" (the `review` param), and "Render film" (starts a normal run of the workflow; locked with the number of open clips
  while the gate is on),
- top left: player for the selected clip. Sound switch: film sound (the piece of the song/voice at the clip's place, the video muted) or the
  clip's own sound. Range switch: this clip, with neighbours, from here on. Space plays, arrow keys change the clip, `O` approves,
- top right: the clip (name, kind, place in the film, real length, model and cost of the producer where known, version count), the warning when
  the clip is longer than its piece of sound, the lines with times, the feedback field, "Approve", "Send feedback and make the clip again" (with
  the estimated price), "Make again", "Show prompt",
- bottom: overview of the whole film with the visible window, time ruler, sections, the clip track (colour by kind, status badge, hatched overhang
  for `over`), words row, waveform (decode the audio in the browser with Web Audio, peaks cached per asset), playhead. Zoom and filters (all, open,
  lip sync only).

Statuses: approved, feedback sent, being made again (a run with this item is active), open, missing (no clip yet).

Rules of the repository apply: all texts in `public/nodes/i18n-nodes.js` in DE/EN/ES (Swiss spelling, no sharp s), no `innerHTML` with data, no
native dialogs, help page `public/help.html` updated in all three language blocks (new section or extension of the node view section), README
mention where node view features are listed.

## Tests

Follow the existing style under `scripts/` (plain Node scripts picked up by `scripts/run-tests.js`):

- model adapters (music video with duet/performance/story/still, explainer, concat),
- service: asset resolution, `over`, producer and prompt, approval bound to the asset,
- review store,
- engine item edits: only the edited item runs again, stale edit ignored, estimate sees it,
- the gate: stops with `TIMELINE_REVIEW_OPEN`, runs when approved, off by default, cache key unchanged for existing nodes (the template digest
  tests must stay green without changing their expected digests),
- feedback with a model double: rewrite path, notes path, revision conflict, no paid run started,
- routes: access (outsider refused), shapes,
- pure UI module, i18n and help tests.
