'use strict';

const fsp = require('fs/promises');
const path = require('path');

const { PATHS } = require('./config');
const store = require('./store');
const access = require('./access');
const or = require('./openrouter');
const gts = require('./gts');
const brandings = require('./brandings');
const cast = require('./cast');
const roles = require('./roles');
const rendernode = require('./rendernode');
const higgsfield = require('./higgsfield');
const chatgpt = require('./chatgpt');
const chatgptFallback = require('./chatgpt-fallback');
const costs = require('./costs');
const budget = require('./budget');
const settings = require('./settings');
const videoModels = require('./video-models');
const videoRefusal = require('./video-refusal');
const resultMeta = require('./result-meta');
const { toolDefinitions, executeTool, shorten } = require('./tools');
const discovery = require('./discovery');
const ffmpeg = require('./ffmpeg');

const MAX_TOOL_ROUNDS = 8;
// Shown once per turn when the ChatGPT subscription failed and OpenRouter answered instead (the client translates by code).
const REPLACEMENT_NOTICE_CODE = 'CHATGPT_REPLACED';
const REPLACEMENT_NOTICE_DE = 'ChatGPT-Abo nicht erreichbar: Diese Antwort läuft über OpenRouter und wird berechnet.';
const MAX_CONTEXT_CHARS = 30000;
const chatgptImageSupport = new Map();
const BRAIN_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function isChatGPTModel(model) {
  return String(model || '').startsWith('chatgpt/');
}

async function readBasePrompt() {
  try {
    return await fsp.readFile(PATHS.systemPrompt, 'utf8');
  } catch (err) {
    console.warn('[brain] System-Prompt konnte nicht gelesen werden:', err.message);
    return 'You are an expert AI Creative Director.';
  }
}

function describeAssets(ledger) {
  ledger = Array.isArray(ledger) ? ledger : [];
  if (!ledger.length) return 'No assets in this session yet.';
  return ledger
    .map((entry) => {
      const state = entry.pending ? 'pending' : 'ready';
      return `- ${entry.id} (${entry.kind}, ${state}): ${shorten(entry.prompt, 140) || '-'}`;
    })
    .join('\n');
}

function describeJobs(jobs) {
  jobs = Array.isArray(jobs) ? jobs : [];
  if (!jobs.length) return 'No video jobs in this session yet.';
  return jobs
    .map((job) => {
      const extra = job.error ? ` | error: ${shorten(job.error, 120)}` : '';
      return `- ${job.assetId}: status ${job.status} (submitted ${job.submittedAt})${extra}`;
    })
    .join('\n');
}

function productionMemorySection(memory) {
  memory = Array.isArray(memory) ? memory : [];
  if (!memory.length) return '';
  const entries = memory.map((entry) => `- ${entry.ts}: ${entry.note}`).join('\n');
  return `## Production memory (persistent across sessions)\n\n${entries}`;
}

// Two variants. Without a remembered model the picker always opens; with one the job normally starts right away, so the
// rules about announcing and waiting for the picker must not be told as unconditional.
function videoPickerSection(preference) {
  if (preference) {
    return `## Video model selection

The user has chosen **${preference.name}** (${preference.model}) for every video in this chat. While that model fits the job and the budget, \`generate_video\` starts the paid job right away with it and shows no picker. Do NOT announce a model selection. After the call, name the model and the estimated price from the tool result in one short sentence.

- If the remembered model does not fit the values you passed (\`duration_seconds\`, \`resolution\`, \`mode\`, references) or the budget, the app opens the model picker instead (it says why) and your turn ends there. Then do not call \`generate_video\` again while the selection is waiting; the user's click starts the job and the app tells you when it finishes. Do not ask in text which model to use.
- Choose \`duration_seconds\`, \`resolution\` and \`mode\` deliberately: the price is calculated for exactly these values.
- Use \`generate_video\` for every normal video request. Other providers (Higgsfield) only when the user explicitly asks for them.

`;
  }
  return `## Video model selection

\`generate_video\` never starts a paid job by itself. The app shows the user a card with the compatible video models, the estimated price for exactly the values you pass (\`duration_seconds\`, \`resolution\`, \`mode\`, references), short strengths and weaknesses and a recommendation. Your turn ends there.

- In the same message, BEFORE the call, say in one short sentence that the model selection appears below. Do not ask in text which model to use: the card is the question.
- Do not call \`generate_video\` again while a selection is waiting. You get no result in this turn; the user's click starts the job and the app tells you when it finishes.
- Choose \`duration_seconds\`, \`resolution\` and \`mode\` deliberately: the card prices exactly these values.
- Use \`generate_video\` for every normal video request. Other providers (Higgsfield) only when the user explicitly asks for them.

`;
}

// videoPicker: { ask, preference } - whether the chat asks for the video model first (lib/video-models.js) and the model
// this chat remembered, if any.
function technicalSection(config, ledger, jobs, videoCapabilities, brainMemory, restricted = false, videoPicker = {}) {
  const askVideoModel = videoPicker.ask !== false;
  const rememberedModel = askVideoModel && videoPicker.preference ? videoPicker.preference : null;
  videoCapabilities = videoCapabilities || { resolutions: [], aspectRatios: [], durations: {}, frameImages: [] };
  const memory = productionMemorySection(brainMemory);
  const motionGraphicsTool = rendernode.enabled()
    ? '\n- `render_motion_graphics` - renders HTML/GSAP motion graphics on a dedicated render node (Mac mini M4) - seconds-fast, deterministic, perfect for title cards, end cards, animated statistics.'
    : '';
  const concatTool = ffmpeg.binaries().available
    ? '\n- `concat_videos` - joins finished session video clips into one final export locally, losslessly when compatible. Use it for final assemblies instead of render_motion_graphics.'
    : '';
  const concatInstruction = ffmpeg.binaries().available
    ? '\n\nFor final exports that only join finished video clips, use `concat_videos`. Do not send those clips to `render_motion_graphics`.'
    : '';
  const showHiggsfield = higgsfield.status().connected && !restricted;
  const higgsfieldTools = showHiggsfield
    ? `
- \`higgsfield_models\` - explores and validates Higgsfield model IDs, ratios, parameters and media roles.
- \`higgsfield_generate_image\` / \`higgsfield_generate_video\` - submit asynchronous Higgsfield generations.
- \`higgsfield_check_balance\` - shows Higgsfield credits and plan.`
    : '';
  const higgsfieldSection = showHiggsfield
    ? `

# HIGGSFIELD (verbunden)

Higgsfield provides additional image and video models such as Nano Banana, Kling, Veo, Sora and Soul. Before generating, use \`higgsfield_models\` to verify the exact model ID, supported aspect ratios, parameters and media roles. Use \`higgsfield_generate_video\` only when the user explicitly asks for Higgsfield; every normal video request goes through \`generate_video\`. Before expensive video jobs, check and mention the balance. Higgsfield is billed in credits on the connected plan, not in OpenRouter USD; clearly tell the user that each Higgsfield generation consumes Higgsfield credits. Higgsfield jobs are asynchronous and become session assets after completion.`
    : '';
  const text = `
---

# TECHNICAL RUNTIME CONTEXT (generated by the local app, not by the user)

You are running inside a local web app. You can act by calling tools.

## Available tools

- \`generate_image\` - creates a new still image with ${config.imageModel}.
- \`edit_image\` - creates a new image from existing session assets used as visual references (${config.imageModel}).
${askVideoModel
    ? '- `generate_video` - prepares a video request. The app then shows the user a model picker (price for exactly this job, strengths, weaknesses) and pauses; the paid job starts only after the user\'s click.'
    : `- \`generate_video\` - submits a video generation job to ${config.videoModel}.`}
- \`generate_speech\` - creates an ElevenLabs MP3 as a casting voice master or Seedance audio reference.
- \`list_voices\` - lists the available ElevenLabs voices and IDs.
- \`import_gts_asset\` - imports an attached file from a GTS knowledge brain into this session.
- \`create_branding\` - creates a reusable brand system.
- \`update_branding\` - updates sections of a brand system.
- \`add_branding_asset\` - copies a session asset into a brand system.
- \`import_branding_asset\` - imports a brand-system asset into this session.
- \`create_cast_member\` - saves a recurring character in the current project's cast.
- \`update_cast_member\` - updates a cast member's soul, images or voice master.
- \`import_cast_asset\` - imports a cast image or voice master into this session for consistent generation.
- \`save_memory\` - saves a durable production learning across all projects and future sessions.
- \`save_project_memory\` - saves a durable rule or preference for every chat in the current project.
- \`list_workflows\` / \`run_workflow\` - list the workflow templates and the user's workflows, and prepare a run. The app shows a card; a run with paid steps starts only after the user's click and ends your turn.${motionGraphicsTool}${concatTool}${higgsfieldTools}${concatInstruction}

Write every \`prompt\` argument in English, regardless of the language you speak with the user.
Talk to the user in the user's language (default: German / Schweizer Hochdeutsch, never use the German sharp s (Eszett), always write ss).

## Video model capabilities (live)

- Supported resolutions: ${videoCapabilities.resolutions.join(', ')}
- Supported aspect ratios: ${videoCapabilities.aspectRatios.join(', ')}
- Supported duration: ${videoCapabilities.durations.min}-${videoCapabilities.durations.max} whole seconds
- Supported frame images: ${videoCapabilities.frameImages.join(', ')}

For image-to-video the aspect ratio is taken from the first frame - never pass \`aspect_ratio\`. 1080p is NOT supported.${askVideoModel ? '\nThese are the limits of the default model. The model picker only offers models that fit the values you pass, so stay inside these limits.' : ''}

${memory}

## Asset ID convention

Every generated or uploaded file is stored locally and gets a stable asset ID:
\`img-001\`, \`img-002\` ... for images, \`vid-001\` ... for videos, \`aud-001\` ... for audio, \`upload-001\` ... for files the user uploaded.
Always refer to assets by these IDs, in tool arguments and when talking to the user.

## Image review loop

${config.brainSeesImages === false
    ? `Your current brain model cannot see images. Uploaded and generated images are still
stored as assets and the image/video tools DO see them - always pass the asset IDs
(e.g. \`reference_asset_ids\`). Do not attempt to visually judge results yourself;
describe what was generated based on the tool results and ask the user for visual feedback.`
    : `After each successful image tool call, the app automatically shows you the generated image
in the next message. Judge it critically against your creative direction. If it is wrong,
fix it with another \`generate_image\` / \`edit_image\` call instead of shipping it.`}

After every image preview and every automatically supplied video frame set, briefly check the
result against the production profile, attached brand guidelines and the user's brief. Verify logo
accuracy, colours, mood and whether the announced timing is actually visible. Proactively tell the
user about deviations; for videos, include precise timestamps (for example: "Text appears only at
second 11"). If the review produces a transferable learning about what worked or failed and why,
save it immediately with a short, concrete note: use \`save_project_memory\` when it belongs to the current project, or \`save_memory\` when it applies across projects. Do not duplicate an existing memory entry.

${askVideoModel ? videoPickerSection(rememberedModel) : ''}## Generations are asynchronous

${!askVideoModel
    ? '`generate_video` and the Higgsfield generation tools only submit jobs. They return immediately with the asset ID.'
    : rememberedModel
      ? '`generate_video` normally starts the paid job right away with the model this chat remembered and returns the asset ID. Only if that model does not fit does it open the model picker and stop your turn; then do not call it again while the picker is waiting. Higgsfield video generation may only be used when the user explicitly requested Higgsfield.'
      : '`generate_video` first opens the required model picker and stops your turn. Do not call it again while the picker is waiting. Only the user\'s click starts the paid job; submitted jobs then return the asset ID. Higgsfield video generation may only be used when the user explicitly requested Higgsfield.'}
The clip is NOT available in the same turn. Tell the user briefly what is rendering
(and that it usually takes a few minutes). When a job finishes or fails, the app injects a
system message into this conversation - only then may you talk about the finished clip.

## Assets in this session

${describeAssets(ledger)}

## Video jobs in this session

${describeJobs(jobs)}

## Working style in this app

Keep answers short and conversational. Do not print long prompt dumps to the user;
put the craft into the tool arguments. Never claim an asset exists before the tool returned it.
Use \`save_project_memory\` for durable project-specific rules (series formats, recurring characters, style decisions). Use \`save_memory\` for durable learnings that apply across projects (general user preferences and technical pitfalls).
${higgsfieldSection}
`.trim();
  // Participants and guests have no GTS and no brandings: the tools are neither offered nor described.
  return restricted
    ? text.split('\n').filter((line) => !/^- `(import_gts_asset|create_branding|update_branding|add_branding_asset|import_branding_asset)`/.test(line)).join('\n')
    : text;
}

// Haengt die angehaengten GTS-Brains als Wissenskontext an. Ein nicht ladbares Brain
// darf den Chat-Turn nie scheitern lassen - es wird nur als Hinweis vermerkt.
function formatAssetKilobytes(bytes) {
  const kilobytes = Math.max(0, Number(bytes) || 0) / 1024;
  return `${Math.round(kilobytes * 10) / 10} kB`;
}

function assetInventory(assets) {
  const listed = Array.isArray(assets) ? assets.slice(0, 40) : [];
  if (!listed.length) return '';
  return `Attached files on this brain (importable via import_gts_asset): ${listed
    .map((asset) => `${asset.filename} (${asset.mimeType || 'application/octet-stream'}, ${formatAssetKilobytes(asset.size)})`)
    .join(', ')}`;
}

async function contextSection(contextBrains) {
  const list = Array.isArray(contextBrains) ? contextBrains.filter((b) => b && b.id) : [];
  if (!list.length) return '';

  const blocks = [];
  for (const ref of list) {
    try {
      const [brain, assets] = await Promise.all([
        gts.getBrain(ref.id),
        gts.listAssets(ref.id).catch(() => [])
      ]);
      let body = brain.body || '';
      if (body.length > MAX_CONTEXT_CHARS) body = `${body.slice(0, MAX_CONTEXT_CHARS)}\n\n[... gekuerzt]`;
      const inventory = assetInventory(assets);
      blocks.push(`## ${brain.title} (${brain.id})\n\n${body}${inventory ? `\n\n${inventory}` : ''}`);
    } catch (err) {
      console.warn(`[gts] Kontext ${ref.id} nicht ladbar:`, err.message);
      blocks.push(`## ${ref.title || ref.id} (${ref.id})\n\n[Kontext ${ref.id} konnte nicht geladen werden]`);
    }
  }

  return `
---

# ATTACHED KNOWLEDGE CONTEXT (GTS)

The user attached the following knowledge documents. Treat them as authoritative context
for this production (e.g. design systems, brand guidelines, product knowledge).

${blocks.join('\n\n')}
`.trim();
}

async function contextFilesSection(sessionId, folder = null, folderProfile = null) {
  let projectFiles = [];
  let sessionFiles = [];
  if (folder && folderProfile) {
    try {
      projectFiles = await store.readFolderContextFiles(folder);
    } catch (err) {
      console.warn(`[context-files] Projekt-Kontextdateien fuer ${folder} nicht ladbar:`, err.message);
    }
  }
  try {
    sessionFiles = await store.readContextFiles(sessionId);
  } catch (err) {
    console.warn(`[context-files] Kontextdateien fuer ${sessionId} nicht ladbar:`, err.message);
  }
  if (!projectFiles.length && !sessionFiles.length) return '';
  const blocks = [
    ...projectFiles.map((file) => `## ${file.name} (Projekt-Profil)\n\n${file.text}`),
    ...sessionFiles.map((file) => `## ${file.name}\n\n${file.text}`)
  ];
  return `---

# ATTACHED CONTEXT FILES

The user attached the following text documents as authoritative context for this production.
Files marked as Projekt-Profil apply to every chat in the project.

${blocks.join('\n\n')}`;
}

async function roleSection(roleId) {
  if (!roleId) return '';
  try {
    const role = await roles.getRole(roleId);
    if (!role) return '';
    return `---

# AKTIVE ROLLE: ${role.name}

Der User hat dir fuer diesen Chat folgende Rolle zugewiesen. Bleib in dieser Rolle, sie ergaenzt deine Faehigkeiten als Creative Director (alle Tools bleiben verfuegbar):

${role.prompt}`;
  } catch (err) {
    console.warn(`[roles] Rolle ${roleId} nicht ladbar:`, err.message);
    return '';
  }
}

function productionProfileSection(folder, profile) {
  const guidelines = typeof profile?.guidelines === 'string' ? profile.guidelines.trim() : '';
  const memory = Array.isArray(profile?.memory) ? profile.memory : [];
  if (!folder || (!guidelines && memory.length === 0)) return '';
  const memoryBlock = memory.length
    ? `\n\n## PROJEKT-MEMORY (verbindlich fuer dieses Projekt)\n\nDiese Regeln wurden vom Director selbst gespeichert und gelten verbindlich:\n\n${memory.map((entry) => `- ${String(entry.note || '').replace(/\s+/g, ' ').trim()}`).join('\n')}`
    : '';
  return `---

# Production profile (folder: ${folder})

${guidelines}${memoryBlock}`;
}

async function castSection(folder) {
  if (!folder) return '';
  let members;
  try {
    members = await cast.listMembers(folder);
  } catch (err) {
    console.warn(`[cast] Projekt-Cast fuer ${folder} nicht ladbar:`, err.message);
    return '';
  }
  if (!members.length) return '';
  const inventory = members.map((member) => {
    const voiceType = member.voice
      ? path.extname(member.voice).toLowerCase() === '.mp4' ? 'Video' : 'Audio'
      : '';
    return `## ${member.name} (ID ${member.id})\n\nSoul: ${member.soul || '-'}\n\nInventar: ${member.images.length} Bild(er)${member.images.length ? ` (${member.images.join(', ')})` : ''}; Voice: ${member.voice ? `${member.voice} (${voiceType})` : 'nicht vorhanden'}`;
  }).join('\n\n');
  return `---

# CAST (Projekt)

${inventory}

Verbindliche Regeln:
1. Fuer wiederkehrende Charaktere IMMER zuerst \`import_cast_asset\` aufrufen und danach dieselben Referenzen an \`generate_video\` geben: Bilder in \`reference_asset_ids\` fuer das Aussehen, den Voice-Clip in \`reference_video_asset_ids\` beziehungsweise \`reference_audio_asset_ids\` fuer die Stimme.
2. Wenn ein neuer Charakter etabliert wird (gutes Bild plus erster Clip mit passender Stimme), dem User anbieten, ihn mit \`create_cast_member\` zu speichern. Als Voice-Master den besten kurzen Clip mit klarer Sprechprobe verwenden.
3. Die Stimme bleibt am stabilsten, wenn der Voice-Master ein Video-Clip des sprechenden Charakters ist.`;
}

function mergeContextBrains(sessionBrains, profileBrainIds) {
  const merged = [];
  const seen = new Set();
  for (const ref of Array.isArray(sessionBrains) ? sessionBrains : []) {
    if (!ref?.id || seen.has(ref.id)) continue;
    seen.add(ref.id);
    merged.push(ref);
  }
  for (const id of Array.isArray(profileBrainIds) ? profileBrainIds : []) {
    if (typeof id !== 'string' || !id.trim() || seen.has(id.trim())) continue;
    const cleanId = id.trim();
    seen.add(cleanId);
    merged.push({ id: cleanId, title: cleanId });
  }
  return merged;
}

function mergeBrandingIds(sessionBrandingIds, profileBrandingIds) {
  const merged = [];
  const seen = new Set();
  for (const rawId of [...(Array.isArray(sessionBrandingIds) ? sessionBrandingIds : []), ...(Array.isArray(profileBrandingIds) ? profileBrandingIds : [])]) {
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
    if (merged.length === 2) break;
  }
  return merged;
}

async function brandingsSection(brandingIds) {
  const summaries = [];
  for (const id of Array.isArray(brandingIds) ? brandingIds.slice(0, 2) : []) {
    try {
      summaries.push(await brandings.brandingSummary(id));
    } catch (_) {
      // Ein geloeschtes oder defektes Branding darf den Chat-Turn nicht blockieren.
    }
  }
  if (!summaries.length) return '';
  return `---

# ATTACHED BRAND SYSTEMS

Die folgenden Brandings sind verbindlich. Wende ihre Farben, Typografie, Voice und Formatvorgaben IMMER an. Verwende bestehende Dateien mit \`import_branding_asset\`, statt Logos, Outros, Sounds oder Referenzen neu zu generieren.

${summaries.join('\n\n---\n\n')}`;
}

// `viewer` (lib/access.js) decides which global memory notes reach the prompt; without one only notes nobody owns do
// once the user management is active, and everything in the local mode.
//
// Participants and guests get no custom role, no GTS context, no brandings and no cast of projects they do not own.
async function buildSystemPrompt(sessionId, config, jobs, contextBrains, folderProfile = null, folder = null, brandingIds = [], roleId = null, viewer = access.viewerOf(null), { ownsFolder = false, videoPreference = null } = {}) {
  const restricted = access.isRestricted(viewer);
  const [base, activeRole, ledger, context, fileContext, brandingContext, castContext, videoCapabilities, brainMemory] = await Promise.all([
    readBasePrompt(),
    restricted ? '' : roleSection(roleId),
    store.readLedger(sessionId),
    restricted ? '' : contextSection(contextBrains),
    contextFilesSection(sessionId, folder, restricted && !ownsFolder ? null : folderProfile),
    restricted ? '' : brandingsSection(brandingIds),
    !restricted || ownsFolder ? castSection(folder) : '',
    discovery.videoCapabilities(config.videoModel),
    store.readBrainMemory({ viewer })
  ]);
  return [
    base,
    activeRole,
    technicalSection(config, ledger, jobs, videoCapabilities, brainMemory, restricted, {
      ask: settings.getPreference('askVideoModel'),
      preference: videoPreference
    }),
    productionProfileSection(folder, folderProfile),
    brandingContext,
    castContext,
    context,
    fileContext
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Text-only-Brains vertragen keine image_url-Parts: Bildteile durch Hinweis ersetzen.
function stripImageParts(content) {
  if (!Array.isArray(content)) return content;
  const texts = [];
  let imageCount = 0;
  for (const part of content) {
    if (part?.type === 'text' && part.text) texts.push(part.text);
    else if (part?.type === 'image_url' || part?.type === 'image_ref') imageCount += 1;
  }
  if (imageCount > 0) {
    texts.push(
      `[${imageCount} Bild(er) liegen lokal vor. Dein Modell kann keine Bilder sehen - nutze die Asset-IDs (z.B. in reference_asset_ids), die Bild-Tools sehen die Bilder.]`
    );
  }
  return texts.join('\n') || '';
}

// Strip local-only fields before talking to the API.
// Nur die juengsten eingebetteten Bilder gehen an die API - alles Aeltere wird durch einen
// Platzhalter ersetzt. Ohne dieses Limit waechst der Request mit jeder Vorschau/jedem Frame-Set
// und OpenRouter lehnt ihn irgendwann mit 503 «Worker exceeded resource limits» ab.
const MAX_API_IMAGES = 6;

function countDataImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((p) => p?.type === 'image_url' && String(p.image_url?.url || '').startsWith('data:')).length;
}

function replaceDataImages(content) {
  if (!Array.isArray(content)) return content;
  return content.map((p) => {
    if (p?.type === 'image_url' && String(p.image_url?.url || '').startsWith('data:')) {
      return { type: 'text', text: '[Aeltere Bild-Vorschau aus Platzgruenden entfernt - das Asset ist weiterhin in der Session verfuegbar.]' };
    }
    return p;
  });
}

// image_ref-Teile (Dateiverweise) kurz vor dem API-Call zu Bilddaten machen - und nur
// so viele, wie das Budget zulaesst. Aeltere bleiben ein Hinweistext, genau wie es
// replaceDataImages mit eingebetteten Bildern macht.
async function resolveImageRefs(sessionId, messages) {
  let budget = MAX_API_IMAGES;
  const out = new Array(messages.length);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!Array.isArray(message?.content) || !message.content.some((p) => p?.type === 'image_ref')) {
      out[i] = message;
      continue;
    }
    const parts = [];
    for (const part of message.content) {
      if (part?.type !== 'image_ref') {
        parts.push(part);
        continue;
      }
      if (budget <= 0) {
        parts.push({ type: 'text', text: '[Aeltere Bild-Vorschau aus Platzgruenden entfernt - das Asset ist weiterhin in der Session verfuegbar.]' });
        continue;
      }
      try {
        const buffer = await store.readInlineImage(sessionId, part.file);
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${part.mime || 'image/png'};base64,${buffer.toString('base64')}` }
        });
        budget -= 1;
      } catch (err) {
        parts.push({ type: 'text', text: `[Bild-Vorschau ${part.file} ist nicht mehr lesbar: ${err.message}]` });
      }
    }
    out[i] = { ...message, content: parts };
  }
  return out;
}

function toApiMessages(messages, brainSeesImages) {
  let imageBudget = MAX_API_IMAGES;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    let content = m.content === undefined ? '' : m.content;
    if (!brainSeesImages) {
      content = stripImageParts(content);
    } else {
      const imageCount = countDataImages(content);
      if (imageCount > 0) {
        if (imageBudget >= imageCount) imageBudget -= imageCount;
        else content = replaceDataImages(content);
      }
    }
    const apiMessage = { role: m.role, content };
    if (m.tool_calls) apiMessage.tool_calls = m.tool_calls;
    if (m.tool_call_id) apiMessage.tool_call_id = m.tool_call_id;
    if (m.name) apiMessage.name = m.name;
    out.unshift(apiMessage);
  }
  return out;
}

function messagesContainImages(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => (
    Array.isArray(message?.content) && message.content.some((part) => (
      part?.type === 'image_url' || part?.type === 'input_image' || part?.type === 'image_ref'
    ))
  ));
}

function extFromDataUrl(dataUrl, filename) {
  const match = /^data:([^;,]+)[;,]/.exec(String(dataUrl || ''));
  const mime = match ? match[1].toLowerCase() : 'image/png';
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/wave': '.wav',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'font/ttf': '.ttf',
    'font/otf': '.otf',
    'font/woff': '.woff',
    'font/woff2': '.woff2'
  };
  let ext = map[mime];
  if (!ext) {
    const fromName = /\.([a-z0-9]{1,10})$/i.exec(String(filename || ''));
    const nameExt = fromName ? `.${fromName[1].toLowerCase()}` : '';
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic', '.heif', '.mp3', '.wav', '.m4a', '.aac', '.mp4', '.webm', '.ttf', '.otf', '.woff', '.woff2']);
    ext = allowed.has(nameExt) ? nameExt : mime.startsWith('image/') ? '.png' : '.bin';
  }
  return { ext, mime };
}

function bufferFromDataUrl(dataUrl) {
  const idx = String(dataUrl).indexOf(',');
  if (idx < 0) throw new Error('Ungueltige Data-URL');
  return Buffer.from(String(dataUrl).slice(idx + 1), 'base64');
}

async function normaliseImageUpload(dataUrl, filename) {
  const original = extFromDataUrl(dataUrl, filename);
  const buffer = bufferFromDataUrl(dataUrl);
  if (!original.mime.startsWith('image/') || BRAIN_IMAGE_MIMES.has(original.mime)) {
    return { ...original, buffer, dataUrl, converted: false };
  }
  try {
    const png = await ffmpeg.convertImageBufferToPng(buffer, { inputExtension: original.ext });
    return {
      ext: '.png',
      mime: 'image/png',
      buffer: png,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      converted: true,
      originalMime: original.mime
    };
  } catch (err) {
    throw new Error(
      `Das Bildformat ${original.mime} wird von OpenRouter nicht unterstuetzt und konnte nicht in PNG umgewandelt werden: ${err.message}`
    );
  }
}

function isInvalidProviderImageError(err) {
  if (err?.status !== 400) return false;
  const detail = `${err.message || ''}\n${err.body || ''}`;
  return /does not represent a valid image|supported image formats|nicht unterstuetztes oder ungueltiges Format/i.test(detail);
}

/* ---------- streaming ---------- */

// Consumes the chat SSE stream, emits text deltas, returns text + tool calls.
async function consumeChatStream(res, emit) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const toolCalls = [];
  let finishReason = null;
  let usage = null;

  function upsertToolCall(delta) {
    const index = typeof delta.index === 'number' ? delta.index : toolCalls.length;
    if (!toolCalls[index]) {
      toolCalls[index] = { id: delta.id || `call_${index}`, type: 'function', function: { name: '', arguments: '' } };
    }
    const target = toolCalls[index];
    if (delta.id) target.id = delta.id;
    if (delta.function?.name) target.function.name = delta.function.name;
    if (typeof delta.function?.arguments === 'string') target.function.arguments += delta.function.arguments;
  }

  function handlePayload(payload) {
    if (payload === '[DONE]') return true;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (_) {
      return false;
    }
    if (parsed.error) {
      throw new Error(parsed.error.message || 'Fehler im Chat-Stream');
    }
    if (parsed.usage && typeof parsed.usage === 'object') usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) return false;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      text += delta.content;
      emit({ type: 'text_delta', delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) upsertToolCall(tc);
    }
    return false;
  }

  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
      buffer = buffer.slice(newlineIdx + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      if (handlePayload(line.slice(5).trim())) {
        done = true;
        break;
      }
    }
  }
  try {
    reader.cancel();
  } catch (_) {
    /* ignore */
  }

  return { text, toolCalls: toolCalls.filter(Boolean), finishReason, usage };
}

/* ---------- turn orchestration ---------- */

async function runTurnUnguarded({
  sessionId,
  text,
  brainModel,
  attachments,
  config,
  emit,
  user = 'lokal',
  renderMode = false,
  brandingWizard = false
}) {
  // User management: who is asking. Participants and guests may not use the ChatGPT subscription, and a participant
  // needs budget left before anything is stored or sent (the same check runs again before every model round).
  const viewer = access.viewerOf({ kubleUser: user });
  if (!access.modelAllowed(viewer, brainModel)) {
    throw new access.RoleRestrictedError('chatgpt', 'The ChatGPT subscription is not available for your account', 'Das ChatGPT-Abo ist für dein Konto nicht verfügbar.');
  }
  // config.restrictedBrainModels: participants and guests use only the listed brain models (the route already swaps
  // another model for the default; this is the lock for every other way in).
  if (!access.brainModelAllowed(viewer, brainModel, config?.restrictedBrainModels)) {
    throw new access.RoleRestrictedError('models', 'This model is not available for your account', 'Dieses Modell ist für dein Konto nicht freigegeben.');
  }
  await budget.begin(viewer, { label: 'chat' });
  const uploads = [];
  for (const att of Array.isArray(attachments) ? attachments : []) {
    if (!att?.dataUrl) continue;
    const normalised = await normaliseImageUpload(att.dataUrl, att.name);
    const { ext, mime, buffer, dataUrl, converted, originalMime } = normalised;
    const asset = await store.saveAsset(sessionId, {
      kind: 'upload',
      buffer,
      ext,
      prompt: att.name ? `Upload: ${att.name}` : 'Upload',
      cost: null
    });
    uploads.push({ asset, mime, dataUrl, name: att.name || asset.file, converted, originalMime });
    emit({ type: 'asset', asset: { id: asset.id, url: asset.url, kind: 'upload', prompt: asset.prompt, cost: null } });
  }

  const userText = String(text || '').trim();
  const userContent = [];
  const noteLines = [];
  for (const up of uploads) {
    if (up.mime.startsWith('image/')) {
      userContent.push({ type: 'image_url', image_url: { url: up.dataUrl } });
      noteLines.push(
        `Hochgeladenes Bild gespeichert als Asset ${up.asset.id} (${up.name})` +
        (up.converted ? `; ${up.originalMime} wurde fuer Brain und Video-Tools in PNG umgewandelt` : '')
      );
    } else {
      const kindLabel = up.mime.startsWith('audio/') ? 'Audio-Datei' : up.mime.startsWith('video/') ? 'Video-Datei' : up.mime.startsWith('font/') ? 'Font-Datei' : 'Datei';
      noteLines.push(`Hochgeladene ${kindLabel} gespeichert als Asset ${up.asset.id} (${up.name}) - nutzbar z.B. via add_branding_asset (target=sound bzw. font).`);
    }
  }
  const combinedText = [userText, ...noteLines].filter(Boolean).join('\n');
  userContent.unshift({ type: 'text', text: combinedText || '(kein Text)' });

  const userMessage = {
    role: 'user',
    content: uploads.length > 0 ? userContent : combinedText || '(kein Text)',
    ts: new Date().toISOString()
  };
  if (uploads.length > 0) userMessage.uploadIds = uploads.map((u) => u.asset.id);
  const renderModeMessage = renderMode
    ? {
        role: 'user',
        hidden: true,
        content:
          '[System] Der User hat den HyperFrames-Modus aktiviert: Setze diese Anfrage mit dem Tool render_motion_graphics um (HTML/GSAP Motion Graphics auf dem Render-Node), nicht mit generate_video.',
        ts: new Date().toISOString()
      }
    : null;
  const brandingWizardMessage = brandingWizard
    ? {
        role: 'user',
        hidden: true,
        content: `[System] Der User hat den Branding-Wizard gestartet. Beginne ein gefuehrtes Branding-Interview und arbeite strikt Schritt fuer Schritt. Warte nach JEDEM Schritt IMMER auf die Antwort des Users; ueberspringe nichts ohne Rueckfrage und erledige nie mehrere Schritte ungefragt in einem Zug.

1. Frage nach Marke, Werten und Zielgruppe.
2. Erstelle danach mit create_branding das Branding.
3. Schlage eine Farbpalette vor und biete optional eine Swatch-Vorschau via generate_image an; speichere die bestaetigten Farben mit update_branding.
4. Klaere Typografie und speichere Rollen, Familien, Schnitte und Nutzung.
5. Frage nach einem Logo-Upload oder biete Logo-Konzepte an. Sichere bestaetigte Session-Assets mit add_branding_asset target=logo.
6. Entwickle oder generiere Bildwelt-Referenzen und sichere sie mit add_branding_asset target=imagery.
7. Klaere Voice und Tonalitaet inklusive Sprache, Dos und Don'ts.
8. Definiere Format-Presets fuer Social und Ads. Sinnvolle Defaults: Instagram Post 1:1, Story/Reel 9:16, YouTube 16:9, X/LinkedIn 16:9, Banner 21:9.
9. Biete ein animiertes Logo-Outro an. Nutze bei Zustimmung generate_video oder render_motion_graphics und sichere das Ergebnis mit add_branding_asset target=outro.
10. Frage nach Sound. Sichere einen Upload mit add_branding_asset target=sound.
11. Gib eine kompakte Zusammenfassung und weise auf den ZIP-Export hin.

Nutze update_branding nach jeder bestaetigten Entscheidung. Sprich Schweizer Hochdeutsch und schreibe immer ss statt Eszett.

Kosten-Transparenz ist Pflicht: Nenne VOR jeder kostenpflichtigen Bild-Generierung die ungefaehren Kosten (Bild ca. $0.03-0.20). Fuer Video und Outro nennst du keine eigene Pauschale, weil der Preis je Modell sehr verschieden ist: Den Preis fuer genau diesen Auftrag zeigt die Karte der Modellwahl; hat der User fuer den Chat ein Modell gemerkt, steht die Schaetzung im Tool-Result. Gibt es weder Karte noch Schaetzung, sag, dass der Preis erst nach Abschluss feststeht. Nach Abschluss nennst du die effektiven Kosten aus dem Tool-Result.`,
        ts: new Date().toISOString()
      }
    : null;

  const session = await store.mutateSession(sessionId, (s) => {
    s.messages.push(userMessage);
    if (renderModeMessage) s.messages.push(renderModeMessage);
    if (brandingWizardMessage) s.messages.push(brandingWizardMessage);
    if (!s.title || s.title === 'Neuer Chat' || s.title === 'Neues Projekt') {
      const base = userText || (uploads.length ? `${uploads.length} Bild-Upload(s)` : '');
      if (base) s.title = shorten(base, 48);
    }
    return {
      title: s.title,
      folder: typeof s.folder === 'string' && s.folder.trim() ? s.folder.trim() : null,
      messages: s.messages.slice(),
      jobs: s.jobs.slice(),
      contextBrains: Array.isArray(s.contextBrains) ? s.contextBrains.slice() : [],
      brandings: Array.isArray(s.brandings) ? s.brandings.slice() : [],
      role: s.role || null,
      videoPreference: videoModels.publicPreference(s, viewer)
    };
  });

  const usesChatGPT = isChatGPTModel(brainModel);
  let brainSeesImages = usesChatGPT
    ? chatgptImageSupport.get(brainModel) !== false
    : await discovery.brainSupportsImages(brainModel);
  if (!brainSeesImages) console.log(`[brain] ${brainModel} ist text-only - Bilder werden dem Brain als Asset-Hinweis uebergeben.`);

  const history = session.messages.slice();
  let folderProfile = null;
  let ownsFolder = false;
  if (session.folder) {
    try {
      ownsFolder = Boolean(viewer.email) && (await store.folderOwner(session.folder)) === viewer.email;
      folderProfile = await store.visibleFolderProfile(await store.readFolderProfile(session.folder), viewer, { ownsFolder });
    } catch (_) {
      folderProfile = null;
    }
  }
  const effectiveContextBrains = mergeContextBrains(session.contextBrains, folderProfile?.contextBrains);
  const effectiveBrandings = mergeBrandingIds(session.brandings, folderProfile?.brandings);
  async function currentSystemPrompt(seesImages = brainSeesImages) {
    return buildSystemPrompt(
      sessionId,
      { ...config, brainSeesImages: seesImages },
      session.jobs,
      effectiveContextBrains,
      folderProfile,
      session.folder,
      effectiveBrandings,
      session.role,
      viewer,
      { ownsFolder, videoPreference: session.videoPreference }
    );
  }

  let systemPrompt = await currentSystemPrompt();
  const availableTools = toolDefinitions(viewer);
  const availableToolNames = new Set(availableTools.map((tool) => tool.function?.name).filter(Boolean));

  async function persist(messages) {
    await store.mutateSession(sessionId, (s) => {
      s.messages.push(...messages);
    });
  }

  // `served`: who answered this step. After a replacement through OpenRouter that is the openai/... model, billed
  // with the cost OpenRouter reports, exactly like any other OpenRouter answer.
  async function recordBrainUsage(usage, served = { model: brainModel, subscription: usesChatGPT }) {
    if (!served.subscription && typeof usage?.cost !== 'number') return;
    try {
      await costs.recordCost({
        ts: new Date().toISOString(),
        sessionId,
        type: 'brain',
        model: served.model,
        cost: served.subscription ? 0 : usage.cost,
        user,
        ...(served.subscription ? { billing: 'Abo', usage } : {})
      });
    } catch (err) {
      console.warn('[costs] Brain-Kosten konnten nicht erfasst werden:', err.message);
    }
  }

  // One model call over OpenRouter: the regular route, and the replacement for a subscription call that failed.
  // A replacement model decides for itself whether it sees images; it never changes what the turn assumes about the
  // subscription model.
  async function openRouterRound(model, messages, tools, { replacement = false } = {}) {
    let seesImages = replacement ? await discovery.brainSupportsImages(model) : brainSeesImages;
    let promptText = replacement && seesImages !== brainSeesImages ? await currentSystemPrompt(seesImages) : systemPrompt;
    const apiMessages = toApiMessages(messages, seesImages);
    const request = async (mappedMessages) => {
      const res = await or.chatStream({
        model,
        messages: [{ role: 'system', content: promptText }, ...mappedMessages],
        ...(tools.length ? { tools, tool_choice: 'auto' } : {})
      });
      return consumeChatStream(res, emit);
    };
    try {
      return await request(apiMessages);
    } catch (err) {
      if (!seesImages || !messagesContainImages(apiMessages) || !isInvalidProviderImageError(err)) throw err;
      seesImages = false;
      promptText = await currentSystemPrompt(false);
      if (!replacement) {
        brainSeesImages = false;
        systemPrompt = promptText;
      }
      console.warn(`[brain] ${model}: ungueltiges Bildformat beim Provider - wiederhole den Call mit Asset-Hinweisen.`);
      return request(toApiMessages(messages, false));
    }
  }

  const chatgptToolCalls = (calls) => calls.map((call) => ({
    id: call.call_id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments }
  }));

  // One model call through the ChatGPT subscription.
  async function subscriptionRound(messages, tools) {
    const apiMessages = toApiMessages(messages, brainSeesImages);
    const request = (mappedMessages) => chatgpt.streamResponses({
      model: brainModel,
      instructions: systemPrompt,
      input: chatgpt.messagesToInput(mappedMessages),
      tools: chatgpt.toolsToResponses(tools),
      onDelta: (delta) => emit({ type: 'text_delta', delta })
    });

    const hasImages = messagesContainImages(apiMessages);
    try {
      const result = await request(apiMessages);
      if (hasImages) chatgptImageSupport.set(brainModel, true);
      return { ...result, toolCalls: chatgptToolCalls(result.toolCalls) };
    } catch (err) {
      if (err.status !== 400 || !hasImages || !brainSeesImages) throw err;
      chatgptImageSupport.set(brainModel, false);
      brainSeesImages = false;
      systemPrompt = await currentSystemPrompt();
      console.log(`[brain] ${brainModel} akzeptiert keine Bilder - wiederhole den Call mit Asset-Hinweisen.`);
      const fallback = await request(toApiMessages(messages, false));
      return { ...fallback, toolCalls: chatgptToolCalls(fallback.toolCalls) };
    }
  }

  // The notice about a replacement is shown once per turn (live), and stored on the first answer it applies to.
  let replacementAnnounced = false;
  function announceReplacement(info) {
    if (replacementAnnounced) return;
    replacementAnnounced = true;
    emit({ type: 'notice', code: REPLACEMENT_NOTICE_CODE, message: REPLACEMENT_NOTICE_DE, model: info.to });
  }
  let replacementStored = false;
  function markReplacement(message, served) {
    if (!served?.replaced || replacementStored) return message;
    replacementStored = true;
    return { ...message, subscriptionFallback: { from: brainModel, model: served.model } };
  }

  // One model call of the tool loop. A subscription model that fails before anything arrived is repeated through
  // OpenRouter for this step only (lib/chatgpt-fallback.js); the history is the same neutral list of messages for
  // both routes, so tools of earlier steps are never run again.
  async function streamBrainRound(rawMessages, tools = []) {
    const messages = await resolveImageRefs(sessionId, rawMessages);
    if (!usesChatGPT) {
      return { ...(await openRouterRound(brainModel, messages, tools)), served: { model: brainModel, subscription: false, replaced: false } };
    }
    const outcome = await chatgptFallback.run({
      model: brainModel,
      subscription: () => subscriptionRound(messages, tools),
      replacement: (openRouterModel) => openRouterRound(openRouterModel, messages, tools, { replacement: true }),
      onReplaced: announceReplacement
    });
    return { ...outcome.result, served: { model: outcome.model, subscription: !outcome.replaced, replaced: outcome.replaced } };
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (round > 0) await budget.begin(viewer, { label: 'chat' }); // tools of the earlier round may have used the rest
    emit({ type: 'status', phase: 'thinking' });
    const { text: answer, toolCalls, usage, served } = await streamBrainRound(history, availableTools);
    await recordBrainUsage(usage, served);

    const assistantMessage = markReplacement({
      role: 'assistant',
      content: answer || (toolCalls.length ? null : ''),
      ts: new Date().toISOString()
    }, served);
    if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
    history.push(assistantMessage);
    await persist([assistantMessage]);

    if (toolCalls.length === 0) return;

    // Tool results must stay contiguous after the assistant message; the injected
    // image previews are appended only once every tool result of this round exists.
    const toolMessages = [];
    const injectedMessages = [];
    // A tool that waits for the user (the video model picker, the card of a paid workflow run) ends the turn after its result is stored.
    let haltAfterTools = false;

    for (const call of toolCalls) {
      const name = call.function?.name || '';
      emit({ type: 'status', phase: 'tool', toolName: name || 'tool' });
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (_) {
        args = {};
      }

      let resultText;
      let inject = [];
      let uiAssets = null;
      let uiJob = null;
      let videoModelChoiceId = null;
      let workflowRunId = null;
      let errorCode = null;
      try {
        if (!availableToolNames.has(name)) throw new Error(`Tool ${name || '(leer)'} ist nicht verfuegbar`);
        const outcome = await executeTool({ sessionId, config, emit, user, viewer, pickVideoModel: true }, name, args);
        resultText = outcome.toolResult;
        inject = outcome.inject || [];
        if (outcome.asset) {
          // The model and its readable name travel with the card so it shows them at once, not only after a reload.
          uiAssets = [{
            id: outcome.asset.id,
            url: outcome.asset.url,
            kind: outcome.asset.kind,
            prompt: outcome.asset.prompt,
            cost: outcome.asset.cost,
            ...(outcome.asset.costEstimated === true ? { costEstimated: true } : {}),
            ...resultMeta.describe(outcome.asset)
          }];
        }
        if (outcome.job) uiJob = { jobId: outcome.job.jobId, assetId: outcome.job.assetId, prompt: outcome.job.prompt };
        if (outcome.halt) haltAfterTools = true;
        videoModelChoiceId = outcome.videoModelChoiceId || null;
        workflowRunId = outcome.workflowRunId || null;
      } catch (err) {
        // runGenerateVideo has already turned a refusal into the error with the model; another provider's error stays as it is.
        const refusal = err instanceof videoRefusal.VideoRefusalError ? err : null;
        if (refusal) {
          // The image was refused at the start (real person): the Director learns what to do next, the chat shows the
          // sentence in the interface language (by code), never the raw provider answer.
          resultText = refusal.directorText;
          errorCode = refusal.code;
          emit({ type: 'error', message: refusal.messageDe, code: refusal.code, fatal: false });
        } else {
          resultText = `Fehler bei ${name}: ${err.message}`;
          emit({ type: 'error', message: resultText, fatal: false });
        }
      }

      const toolMessage = {
        role: 'tool',
        tool_call_id: call.id,
        name: name || 'tool',
        content: resultText,
        ts: new Date().toISOString()
      };
      if (uiAssets) toolMessage.assets = uiAssets;
      if (uiJob) toolMessage.job = uiJob;
      if (videoModelChoiceId) toolMessage.videoModelChoiceId = videoModelChoiceId;
      if (workflowRunId) toolMessage.workflowRunId = workflowRunId;
      if (errorCode) toolMessage.errorCode = errorCode;
      toolMessages.push(toolMessage);
      injectedMessages.push(...inject.map((m) => ({ ...m, ts: new Date().toISOString() })));
    }

    const roundMessages = [...toolMessages, ...injectedMessages];
    history.push(...roundMessages);
    await persist(roundMessages);
    if (haltAfterTools) return;
    emit({ type: 'status', phase: 'thinking' });
  }

  const limitNote = {
    role: 'user',
    hidden: true,
    content: '[System] Maximale Anzahl Tool-Runden fuer diese Nachricht erreicht. Fasse kurz zusammen und warte auf den User.',
    ts: new Date().toISOString()
  };
  history.push(limitNote);
  await persist([limitNote]);

  await budget.begin(viewer, { label: 'chat' });
  emit({ type: 'status', phase: 'thinking' });
  const { text: finalText, usage, served: finalServed } = await streamBrainRound(history);
  await recordBrainUsage(usage, finalServed);
  const finalMessage = markReplacement({ role: 'assistant', content: finalText || '', ts: new Date().toISOString() }, finalServed);
  await persist([finalMessage]);
}

// Sessions with a running director turn. The node view checks this before it appends a
// message, because a message between assistant(tool_calls) and its tool results breaks the chat.
const activeTurns = new Map();

function isTurnActive(sessionId) {
  return activeTurns.has(sessionId);
}

async function runTurn(options) {
  const sessionId = options && options.sessionId;
  activeTurns.set(sessionId, (activeTurns.get(sessionId) || 0) + 1);
  try {
    return await runTurnUnguarded(options);
  } finally {
    const left = (activeTurns.get(sessionId) || 1) - 1;
    if (left > 0) activeTurns.set(sessionId, left);
    else activeTurns.delete(sessionId);
  }
}

module.exports = {
  readBasePrompt,
  runTurn,
  isTurnActive,
  buildSystemPrompt,
  consumeChatStream,
  contextSection,
  contextFilesSection,
  roleSection,
  mergeContextBrains,
  mergeBrandingIds,
  brandingsSection,
  castSection,
  toApiMessages,
  resolveImageRefs,
  isChatGPTModel,
  messagesContainImages,
  normaliseImageUpload,
  isInvalidProviderImageError,
  chatgptImageSupport
};
