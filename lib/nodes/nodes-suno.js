'use strict';

// "Create song (Suno)": the song pack (TITLE, STYLE, EXCLUDE, LYRICS) becomes a finished song in the session, made through the
// PERSONAL Suno connection of the person who starts the run (account menu → Suno). Suno bills its own credits; the app charges nothing.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const access = require('../access');
const { PATHS } = require('../config');
const { defaultSuno } = require('../suno');
const song = require('../suno-song');
const assets = require('./assets');
const { textValue } = require('./types');

const TYPE = 'suno.song';
const TIMEOUT_MS = 12 * 60 * 1000;

function ownerOf(ctx) {
  const viewer = access.viewerOf({ kubleUser: ctx.user });
  const email = access.normalizeEmail(viewer?.email);
  if (!viewer?.active || !viewer?.identified || !email) throw Object.assign(new Error('Suno needs your personal login.'), { code: 'SUNO_LOGIN' });
  return email;
}

// The clip ids of a creation are remembered under its key (owner, pack and version): a run that failed after Suno had started the song
// (a timeout, a download credit that was not allowed) picks the same song up and never spends credits twice.
function memory(directory) {
  const file = (key) => path.join(directory, `${key}.json`);
  return {
    read(key) {
      try { const ids = JSON.parse(fs.readFileSync(file(key), 'utf8')).ids; return Array.isArray(ids) ? ids : null; }
      catch (_) { return null; }
    },
    write(key, ids) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file(key), JSON.stringify({ ids, at: new Date().toISOString() }), { mode: 0o600 });
    }
  };
}

// The songs of a pack as variants [{ audio, lyrics }], with the memory of what was already created. Shared with "Music for the spot"
// (ad.music), whose jingle is a song pack too. params: { takes, version, allow_download_credit }.
function createSongMaker({ suno = defaultSuno, directory = path.join(PATHS.root, 'data', 'suno', 'songs'), fetchImpl, sleep, pollMs, env = process.env } = {}) {
  const remembered = memory(directory);
  return async function makeSongs(ctx, packText, params) {
    const owner = ownerOf(ctx);
    const pack = song.checkPack(song.parsePack(packText));
    // Not the node or the workflow: the same pack of the same person is one song wherever it is asked for.
    const key = song.idempotencyKey(owner, [pack.title, pack.style, pack.exclude, pack.lyrics, String(params.version)]);
    const songs = await song.createSong({
      suno, owner, pack, key, takes: params.takes, allowDownloadCredit: params.allow_download_credit === true,
      resume: remembered.read(key), onClips: (ids) => remembered.write(key, ids), signal: ctx.signal, log: ctx.log,
      timeoutMs: TIMEOUT_MS - 90 * 1000, ...(sleep ? { sleep } : {}), ...(pollMs ? { pollMs } : {})
    });
    const extraHosts = String(env.SUNO_AUDIO_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
    const scratch = await assets.createScratchDir(ctx.sessionId);
    try {
      const variants = [];
      for (const item of songs) {
        const { buffer, ext } = await song.fetchAudio(item.url, { ...(fetchImpl ? { fetchImpl } : {}), extraHosts });
        const file = path.join(scratch, `${crypto.randomUUID()}${ext}`);
        await fsp.writeFile(file, buffer);
        const audio = await assets.saveOutputFile(ctx.sessionId, { kind: 'audio', ext, sourceFile: file, prompt: `Suno: ${item.title || pack.title || 'song'}` });
        if (item.songUrl) ctx.log(`Suno: ${item.songUrl}`);
        variants.push({ audio, lyrics: textValue(pack.lyrics) });
      }
      return variants;
    } finally {
      await assets.removeScratchDir(scratch);
    }
  };
}

function createDefinition(options = {}) {
  const makeSongs = createSongMaker(options);
  return {
    type: TYPE,
    category: 'audio',
    provider: 'suno',
    label: 'Create song (Suno)',
    keywords: ['suno', 'song', 'music', 'lyrics', 'singer', 'vocals', 'song pack', 'audio'],
    description:
      'Makes a finished song with Suno from a song pack: a text with the blocks TITLE, STYLE, EXCLUDE and LYRICS (the output of the template ' +
      '"Suno song pack"). Runs through YOUR OWN Suno account (account menu → Suno → Connect) and uses your Suno credits; the app charges nothing. ' +
      'Suno makes two takes per creation: both arrive as variants. Output "lyrics" is the sung text for "Lyrics timing". ' +
      'The same pack is never created twice: raise "version" for a new song from the same pack. Fetching the file costs one Suno download credit ' +
      'when Suno asks for it: switch "Allow download credit" off to stop instead.',
    inputs: [{ id: 'pack', type: 'text', required: true, param: 'pack' }],
    outputs: [{ id: 'audio', type: 'audio' }, { id: 'lyrics', type: 'text' }],
    params: [
      { id: 'pack', kind: 'textarea', default: '', inline: true },
      { id: 'takes', kind: 'integer', min: 1, max: 2, default: 2 },
      { id: 'version', kind: 'integer', min: 1, max: 99, default: 1 },
      // on by default and on the card: Suno hands out the file only against a download credit, so without it the node could only stop
      { id: 'allow_download_credit', kind: 'boolean', default: true, inline: true }
    ],
    timeoutMs: TIMEOUT_MS,
    validate: (params, ports) => {
      if (ports.pack?.connected) return [];
      const text = String(params.pack || '').trim();
      if (!text) return [{ code: 'SUNO_PACK_MISSING', port: 'pack', message: 'pack: connect or write a song pack (TITLE, STYLE, EXCLUDE, LYRICS)' }];
      try { song.checkPack(song.parsePack(text)); return []; }
      catch (err) { return [{ code: err.code || 'SUNO_PACK', port: 'pack', message: `pack: ${err.message}` }]; }
    },
    execute: async (ctx, inputs, params) => ({ variants: await makeSongs(ctx, inputs.pack ? inputs.pack.value : params.pack, params) })
  };
}

function registerAll(registry) { registry.register(createDefinition()); }
module.exports = { registerAll, createDefinition, createSongMaker, TIMEOUT_MS, TYPE };
