'use strict';

// One song through the personal Suno connection of a person, for the workflow node "Create song (Suno)".
// The official Suno MCP is in beta and its tool schemas are not published: the field names are therefore read from the
// live tool list (tools/list) before anything is created, and a tool or field that is missing ends the run BEFORE credits are spent.
const crypto = require('node:crypto');

const BLOCKS = ['TITLE', 'STYLE', 'EXCLUDE', 'LYRICS'];
const LIMITS = { title: 200, style: 1000, exclude: 500, lyrics: 6000 };
const CLIP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AUDIO_HOSTS = ['suno.ai', 'suno.com'];
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;
// Field names per meaning, most likely first. The first one the live schema knows is used.
const FIELDS = {
  lyrics: ['lyrics', 'prompt', 'custom_lyrics'],
  style: ['style', 'tags', 'style_tags', 'styles'],
  title: ['title', 'name'],
  exclude: ['negative_tags', 'exclude', 'exclude_styles', 'excluded_styles', 'negative_style', 'negative_styles'],
  idempotency: ['idempotency_key']
};
const TOOLS = { create: 'audio-create', retrieve: 'audio-retrieve', download: 'audio-download' };

function fail(code, message) { return Object.assign(new Error(message), { code }); }

// The pack as the template writes it: the four headings on their own line, in any order, "## " and ":" allowed; a code fence around
// the lyrics is dropped. Text before the first heading is ignored. Without any heading the whole text counts as lyrics.
function parsePack(text) {
  const pack = { title: '', style: '', exclude: '', lyrics: '' };
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let current = null;
  let found = false;
  const parts = { title: [], style: [], exclude: [], lyrics: [] };
  for (const line of lines) {
    const head = /^\s*(?:#{1,6}\s*)?\**\s*(TITLE|STYLE|EXCLUDE|LYRICS)\s*\**\s*:?\s*(.*)$/.exec(line);
    if (head && BLOCKS.includes(head[1]) && (current !== 'lyrics' || !head[2])) {
      current = head[1].toLowerCase();
      found = true;
      if (head[2].trim()) parts[current].push(head[2]);
      continue;
    }
    if (current) parts[current].push(line);
  }
  if (!found) parts.lyrics = lines;
  for (const key of Object.keys(pack)) {
    let value = parts[key].join('\n').trim();
    value = value.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
    pack[key] = key === 'lyrics' ? value : value.replace(/\s*\n\s*/g, ' ').trim();
  }
  return pack;
}

function checkPack(pack) {
  if (!pack.lyrics) throw fail('SUNO_LYRICS_MISSING', 'The song pack has no LYRICS block.');
  if (!pack.style) throw fail('SUNO_STYLE_MISSING', 'The song pack has no STYLE block.');
  for (const [key, max] of Object.entries(LIMITS)) {
    if ([...pack[key]].length > max) throw fail('SUNO_FIELD_TOO_LONG', `${key.toUpperCase()}: at most ${max} characters are allowed (${[...pack[key]].length}).`);
  }
  return pack;
}

function parseResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const block of result?.content || []) {
    if (block?.type === 'text') { try { return JSON.parse(block.text); } catch (_) { /* next */ } }
  }
  throw fail('SUNO_UNREADABLE', 'Suno gave no readable answer. Nothing was created again.');
}

// Maps the pack onto the argument names of the live schema. `schema` null (the tool list could not be read): the names of the chat tools.
function createArguments(pack, schema, idempotencyKey) {
  const known = schema?.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : null;
  const pick = (kind) => (known ? FIELDS[kind].find((name) => known.includes(name)) : FIELDS[kind][0]);
  const args = {};
  const dropped = [];
  for (const kind of ['lyrics', 'style', 'title', 'exclude']) {
    if (!pack[kind]) continue;
    const name = kind === 'exclude' && !known ? null : pick(kind);
    if (name) args[name] = pack[kind];
    else if (kind === 'lyrics' || kind === 'style') throw fail('SUNO_SCHEMA', `Suno's create tool has no field for the ${kind}. Fields: ${(known || []).join(', ')}`);
    else dropped.push(kind);
  }
  const key = pick('idempotency');
  if (key && idempotencyKey) args[key] = idempotencyKey;
  for (const name of schema?.required || []) {
    if (!(name in args)) throw fail('SUNO_SCHEMA', `Suno's create tool requires the field "${name}", which this node does not know.`);
  }
  return { args, dropped };
}

function clipIds(result) {
  const ids = [];
  const add = (value) => { if (typeof value === 'string' && CLIP_ID.test(value) && !ids.includes(value)) ids.push(value); };
  for (const key of ['clip_ids', 'ids', 'song_ids']) for (const value of Array.isArray(result?.[key]) ? result[key] : []) add(value);
  for (const key of ['clips', 'songs', 'audios', 'data', 'results']) {
    for (const item of Array.isArray(result?.[key]) ? result[key] : []) add(item?.id || item?.clip_id);
  }
  add(result?.clip_id);
  if (!ids.length) add(result?.id);
  return ids;
}

function isAudioUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { return false; }
  return url.protocol === 'https:' && !url.username && !url.password;
}
function allowedHost(value, extra = []) {
  const host = new URL(value).hostname.toLowerCase();
  return [...AUDIO_HOSTS, ...extra].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
// The finished file of a clip or download answer: a named field first, then any https link to an mp3 or wav.
function audioUrl(result) {
  for (const key of ['download_url', 'audio_url', 'mp3_url', 'wav_url', 'url']) {
    if (typeof result?.[key] === 'string' && isAudioUrl(result[key])) return result[key];
  }
  for (const value of Object.values(result || {})) {
    if (typeof value === 'string' && isAudioUrl(value) && /\.(mp3|wav)(\?|$)/i.test(value)) return value;
  }
  return null;
}
function stateOf(result) {
  const status = String(result?.status || result?.state || '').toLowerCase();
  if (/error|fail|reject|cancel/.test(status)) return 'failed';
  if (/complete|success|succeeded|ready|done|finished/.test(status)) return 'done';
  return 'pending';
}

function idempotencyKey(owner, parts) {
  return crypto.createHash('sha256').update([owner, ...parts].join('\n')).digest('hex');
}

/*
 * Creates the song and returns one finished file per clip: [{ id, title, url, songUrl }].
 *   suno: the client of lib/suno.js (mcpCall, mcpTools, status); owner: the normalised e-mail of the person.
 *   allowDownloadCredit: Suno may ask for a download credit of the person; only then is the download confirmed.
 *   resume: clip ids of an earlier attempt of this node (nothing is created again).
 */
async function createSong({ suno, owner, pack, key, takes = 2, allowDownloadCredit = false, resume = null, signal, log = () => {}, onClips = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 10000, timeoutMs = 10 * 60 * 1000, now = Date.now } = {}) {
  if (!suno.status(owner).connected) throw fail('SUNO_NOT_CONNECTED', 'Connect your own Suno account first: account menu → Suno → Connect.');
  checkPack(pack);
  const call = async (name, args) => {
    if (signal?.aborted) throw fail('SUNO_CANCELLED', 'Cancelled.');
    try { return parseResult(await suno.mcpCall(owner, name, args)); }
    catch (err) { if (err.detail) log(`Suno (${name}): ${err.detail}`); throw err; }
  };
  let ids = Array.isArray(resume) ? resume.filter((id) => CLIP_ID.test(id)) : [];
  if (!ids.length) {
    let tools = null;
    try { tools = await suno.mcpTools(owner); } catch (err) { log('The tool list of Suno could not be read; the known field names are used.'); }
    if (tools) {
      for (const name of [TOOLS.create, TOOLS.retrieve]) {
        if (!tools.some((tool) => tool.name === name)) throw fail('SUNO_SCHEMA', `Suno offers no tool "${name}" for this account. Tools: ${tools.map((tool) => tool.name).join(', ')}`);
      }
    }
    const { args, dropped } = createArguments(pack, tools ? tools.find((tool) => tool.name === TOOLS.create).inputSchema : null, key);
    if (dropped.length) log(`Suno's create tool has no field for: ${dropped.join(', ')}. Left out.`);
    log(`Suno creates the song${pack.title ? ` “${pack.title}”` : ''} with your own Suno credits.`);
    ids = clipIds(await call(TOOLS.create, args));
    if (!ids.length) throw fail('SUNO_NO_CLIPS', 'Suno returned no song id. Look into your Suno library before you run this again.');
    await onClips(ids);
  }
  ids = ids.slice(0, Math.max(1, takes));
  const deadline = now() + timeoutMs;
  const songs = [];
  for (const id of ids) {
    let clip;
    for (;;) {
      clip = await call(TOOLS.retrieve, { id });
      const state = stateOf(clip);
      if (state === 'failed') throw fail('SUNO_FAILED', `Suno could not make the song ${id}.`);
      if (state === 'done') break;
      if (now() > deadline) throw fail('SUNO_TIMEOUT', `Suno is still working on the song ${id}. Run the node again later: it picks the same song up and creates nothing new.`);
      await sleep(pollMs);
    }
    let url = audioUrl(clip);
    if (!url) {
      for (;;) {
        let file = await call(TOOLS.download, { id, format: 'mp3' });
        if (file.status === 'requires_credit') {
          if (!allowDownloadCredit) throw fail('SUNO_DOWNLOAD_CREDIT', 'Suno asks for one of your download credits for this song. Switch on “Allow download credit” in the node and run it again; nothing is created again.');
          log('Suno asks for a download credit: confirmed, as allowed in the node.');
          file = await call(TOOLS.download, { id, format: 'mp3', confirm: true });
        }
        url = audioUrl(file);
        if (url) break;
        if (stateOf(file) === 'failed') throw fail('SUNO_FAILED', `Suno could not prepare the download of the song ${id}.`);
        if (now() > deadline) throw fail('SUNO_TIMEOUT', `Suno is still preparing the download of the song ${id}. Run the node again later.`);
        await sleep(pollMs);
      }
    }
    songs.push({ id, title: typeof clip.title === 'string' ? clip.title.slice(0, 200) : pack.title, url, songUrl: typeof clip.song_url === 'string' && isAudioUrl(clip.song_url) ? clip.song_url : null });
  }
  return songs;
}

// Loads the finished file. Only https, only hosts of Suno (plus SUNO_AUDIO_HOSTS), a size limit, and a real audio type.
async function fetchAudio(url, { fetchImpl = global.fetch, extraHosts = [], signal } = {}) {
  if (!isAudioUrl(url) || !allowedHost(url, extraHosts)) throw fail('SUNO_AUDIO_HOST', `The song file is on a host this app does not load from: ${isAudioUrl(url) ? new URL(url).hostname : 'no https link'}.`);
  const response = await fetchImpl(url, { redirect: 'follow', signal: signal || AbortSignal.timeout(120000) });
  if (!response.ok) throw fail('SUNO_AUDIO_FETCH', `The song file could not be loaded (${response.status}).`);
  if (response.url && !allowedHost(response.url, extraHosts)) throw fail('SUNO_AUDIO_HOST', 'The song file was redirected to a host this app does not load from.');
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  const ext = /wav/.test(type) || /\.wav(\?|$)/i.test(url) ? '.wav' : '.mp3';
  if (type && !/^audio\/|octet-stream/.test(type)) throw fail('SUNO_AUDIO_TYPE', `The song file is no audio file (${type.slice(0, 60)}).`);
  if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) throw fail('SUNO_AUDIO_SIZE', 'The song file is too large.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) throw fail('SUNO_AUDIO_SIZE', 'The song file is empty or too large.');
  return { buffer, ext };
}

module.exports = { parsePack, checkPack, createArguments, clipIds, audioUrl, stateOf, idempotencyKey, createSong, fetchAudio, LIMITS, TOOLS };
