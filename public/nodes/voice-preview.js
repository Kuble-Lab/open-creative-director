'use strict';

// Trial listening to the ElevenLabs voices (WP38f): a play button next to every place where a voice is chosen (node card, inspector,
// app view, branding editor). One shared audio element: only one sample plays at a time, a new one stops the old one. The element is
// shared on purpose: on phones (iOS) a play() has to start inside the tap, so the element is created and started in the click handler
// (a short silence while a sample is being made), and the real sound follows on the same element.
//   free sample   GET  api/elevenlabs/voices/:id/preview            (the voice has `preview: true` in its option)
//   made sample   POST api/elevenlabs/voices/:id/sample             (about one cent, once per voice, model and language)
//   price / state GET  api/elevenlabs/voices/:id/sample?model_id&lang
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});

  const T = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);
  const rel = (path) => (OCD.api && OCD.api.rel ? OCD.api.rel(path) : String(path).replace(/^\/+/, ''));
  const enc = encodeURIComponent;
  // 0.1 s of silence (WAV) that unlocks the audio element inside the tap
  const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  const MAX_BLOBS = 30;

  const hooks = { audio: null, fetch: null };
  const audioState = { element: null };
  const blobs = new Map(); // key -> object URL of a sample that was fetched
  const infos = new Map(); // key -> { info } or { pending: Promise }
  const listeners = new Set();
  let current = null; // { key, phase: 'loading' | 'playing', token }
  let lastError = null; // { key, message }
  let counter = 0;

  function emit() {
    for (const fn of [...listeners]) fn();
  }
  const fetcher = () => hooks.fetch || global.fetch.bind(global);

  function element() {
    if (audioState.element) return audioState.element;
    const make = hooks.audio || (() => new global.Audio());
    const audio = make();
    audio.onended = () => finish(null);
    audio.onerror = () => {
      if (current && current.phase === 'playing') finish(T('nodes.voice.playFailed'));
    };
    audioState.element = audio;
    return audio;
  }

  function finish(error, token) {
    if (token !== undefined && (!current || current.token !== token)) return;
    const key = current && current.key;
    current = null;
    lastError = error && key ? { key, message: error } : null;
    emit();
  }

  function stop() {
    counter += 1;
    if (audioState.element) {
      try {
        audioState.element.pause();
      } catch (_) {
        /* nothing is playing */
      }
    }
    current = null;
    emit();
  }

  const status = (key) => (current && current.key === key ? current.phase : 'idle');

  // The reason the server gave, in the interface language where it is a known one.
  async function failureOf(response) {
    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      /* not JSON */
    }
    const code = body && body.code;
    if (response.status === 402 || code === 'BUDGET_EXHAUSTED' || code === 'BUDGET_INSUFFICIENT') return { code, message: T('nodes.voice.noBudget') };
    if (response.status === 503) return { code, message: T('nodes.voice.noKey') };
    if (code === 'NO_PREVIEW') return { code, message: T('nodes.voice.noPreview') };
    if (response.status === 404) return { code, message: T('nodes.voice.unknown') };
    return { code, message: (body && body.error) || T('nodes.voice.playFailed') };
  }

  async function blobOf(key, response) {
    const blob = await response.blob();
    const url = global.URL.createObjectURL(blob);
    blobs.set(key, url);
    while (blobs.size > MAX_BLOBS) {
      const [oldKey, oldUrl] = blobs.entries().next().value;
      blobs.delete(oldKey);
      try {
        global.URL.revokeObjectURL(oldUrl);
      } catch (_) {
        /* already gone */
      }
    }
    return url;
  }

  // Starts a sample. source: { key, free: boolean, id, model, lang, onDone(result) }. Runs inside the click handler up to the first await.
  function play(source) {
    const audio = element();
    counter += 1;
    const token = counter;
    try {
      audio.pause();
    } catch (_) {
      /* nothing is playing */
    }
    current = { key: source.key, phase: 'loading', token };
    lastError = null;
    emit();
    const playing = (url) => {
      audio.src = url;
      const started = audio.play();
      return Promise.resolve(started).then(() => {
        if (current && current.token === token) {
          current.phase = 'playing';
          emit();
        }
      });
    };
    const fail = (error) => finish(error && error.message ? error.message : T('nodes.voice.playFailed'), token);
    const base = `api/elevenlabs/voices/${enc(source.id)}`;
    const cached = blobs.get(source.key);
    if (cached) {
      playing(cached).catch(fail);
      return;
    }
    // unlock the element inside the tap; the sample follows when it has arrived
    try {
      audio.src = SILENCE;
      const unlocked = audio.play();
      if (unlocked && unlocked.catch) unlocked.catch(() => {});
    } catch (_) {
      /* the sample is played anyway where the browser allows it */
    }
    const request = source.free
      ? fetcher()(rel(`${base}/preview`))
      : fetcher()(rel(`${base}/sample`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: source.model || undefined, lang: source.lang }) });
    request
      .then(async (response) => {
        if (current && current.token !== token) return null;
        if (!response.ok) {
          const failure = await failureOf(response);
          const error = new Error(failure.message);
          error.code = failure.code;
          throw error;
        }
        const madeNow = !source.free && response.headers && response.headers.get && response.headers.get('X-Sample-Cached') === '0';
        const url = await blobOf(source.key, response);
        if (madeNow) infos.delete(`${source.id}|${source.model}|${source.lang}`);
        if (!current || current.token !== token) return null;
        return playing(url);
      })
      .catch((error) => {
        if (source.free && error && error.code === 'NO_PREVIEW' && source.onNoPreview) source.onNoPreview();
        fail(error);
      });
  }

  // What a made sample of a voice costs now: { info } once it is known; fetched once per voice, model and language.
  function infoFor(id, model, lang, onChange) {
    const key = `${id}|${model}|${lang}`;
    const known = infos.get(key);
    if (known) return known.info || null;
    const pending = fetcher()(rel(`api/elevenlabs/voices/${enc(id)}/sample?model_id=${enc(model || '')}&lang=${enc(lang)}`))
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((info) => {
        infos.set(key, { info });
        if (!info) setTimeout(() => infos.delete(key), 30000);
        onChange();
      });
    infos.set(key, { pending });
    return null;
  }

  const interfaceLang = () => {
    const lang = typeof global.getLang === 'function' ? String(global.getLang() || '') : '';
    return ['de', 'en', 'es'].includes(lang.slice(0, 2)) ? lang.slice(0, 2) : 'en';
  };

  function formatUsd(usd) {
    const value = Number(usd);
    if (!Number.isFinite(value) || value <= 0) return '$0';
    return `$${value < 0.01 ? value.toFixed(3) : value.toFixed(2)}`;
  }

  /* ---------- what a voice is like ---------- */

  const LABEL_ORDER = ['gender', 'age', 'accent', 'descriptive', 'use_case', 'language'];
  const labelValues = (labels) => {
    if (!labels || typeof labels !== 'object') return [];
    const keys = [...LABEL_ORDER.filter((key) => key in labels), ...Object.keys(labels).filter((key) => !LABEL_ORDER.includes(key))];
    return keys.map((key) => ({ key, value: String(labels[key] ?? '').replace(/_/g, ' ').trim() })).filter((item) => item.value);
  };
  // "female · american · young": the short form behind the name in a list
  const summaryOf = (option) => labelValues(option && option.labels).slice(0, 4).map((item) => item.value).join(' · ');
  // The longer form for a tooltip: the description of the voice and every label
  function detailOf(option) {
    if (!option) return '';
    const lines = [];
    if (option.description) lines.push(option.description);
    const pairs = labelValues(option.labels);
    if (pairs.length) lines.push(pairs.map((item) => `${item.key.replace(/_/g, ' ')}: ${item.value}`).join(', '));
    return lines.join('\n');
  }
  const optionText = (option) => {
    const summary = summaryOf(option);
    return summary ? `${option.label} (${summary})` : option.label;
  };

  /* ---------- the button ---------- */

  function node(tag, attrs = {}) {
    const item = global.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') item.className = value;
      else if (key === 'text') item.textContent = value;
      else item.setAttribute(key, String(value));
    }
    return item;
  }

  // opts.voice() -> { value, option, state: 'loading' | 'ready' | 'error', noKey }, opts.model() -> speech model id, opts.onError(message)
  function button(opts) {
    const el = node('button', { type: 'button', class: 'nv-voice-play nv-nodrag', 'data-voice-play': '1' });
    let free = null; // set to false after a voice without a free sample was found out through the default entry

    const view = () => {
      const voice = opts.voice();
      const lang = interfaceLang();
      const model = (opts.model && opts.model()) || '';
      if (voice.state === 'loading') return { disabled: true, reason: T('nodes.voice.loading'), key: null };
      if (voice.state === 'error') return { disabled: true, reason: voice.noKey ? T('nodes.voice.noKey') : T('nodes.voice.listFailed'), key: null };
      if (voice.value === '__none__') return { disabled: true, reason: T('nodes.voice.choose'), key: null };
      const id = voice.value === '' ? 'default' : voice.value;
      if (voice.value !== '' && !voice.option) return { disabled: true, reason: T('nodes.voice.unknown'), key: null };
      const hasFree = voice.value === '' ? free !== false : Boolean(voice.option && voice.option.preview);
      const base = { id, model, lang };
      if (hasFree) return { ...base, free: true, key: `free|${id}`, tip: T('nodes.voice.play') };
      const key = `made|${id}|${model}|${lang}`;
      const info = infoFor(id, model, lang, () => paint());
      if (info && !info.available && !info.cached) {
        return { ...base, free: false, key, disabled: true, reason: info.reason === 'no_key' ? T('nodes.voice.noKey') : T('nodes.voice.noBudget') };
      }
      const tip = info && info.cached
        ? T('nodes.voice.playMadeStored')
        : T('nodes.voice.playMade', { price: info ? formatUsd(info.usd) : '$0.01' });
      return { ...base, free: false, key, tip };
    };

    let wasConnected = false;
    function paint() {
      // a button that left the page (its list was drawn again) stops listening
      if (el.isConnected) wasConnected = true;
      else if (wasConnected) {
        listeners.delete(paint);
        return;
      }
      const state = view();
      const phase = state.key ? status(state.key) : 'idle';
      const error = lastError && state.key && lastError.key === state.key ? lastError.message : '';
      el.disabled = Boolean(state.disabled);
      el.setAttribute('data-state', state.disabled ? 'disabled' : error ? 'error' : phase);
      el.setAttribute('aria-pressed', phase === 'playing' ? 'true' : 'false');
      el.textContent = phase === 'playing' ? '■' : phase === 'loading' ? '…' : '▶';
      const title = state.disabled ? state.reason : phase === 'playing' ? T('nodes.voice.stop') : phase === 'loading' ? T('nodes.voice.loading') : error || state.tip || '';
      el.setAttribute('title', title);
      el.setAttribute('aria-label', title);
    }

    el.addEventListener('click', (event) => {
      if (event && event.stopPropagation) event.stopPropagation();
      const state = view();
      if (state.disabled || !state.key) return;
      if (status(state.key) !== 'idle') {
        stop();
        return;
      }
      play({
        key: state.key,
        free: state.free,
        id: state.id,
        model: state.model,
        lang: state.lang,
        // the default voice has no free sample: the next click makes one
        onNoPreview: () => {
          free = false;
          paint();
        }
      });
    });
    listeners.add(paint);
    paint();
    return {
      el,
      refresh: paint,
      dispose: () => listeners.delete(paint)
    };
  }

  const api = {
    button,
    play,
    stop,
    status,
    summaryOf,
    detailOf,
    optionText,
    formatUsd,
    // for the tests: replace the audio element and the fetch, forget what was kept
    configure: (overrides = {}) => {
      if ('audio' in overrides) hooks.audio = overrides.audio;
      if ('fetch' in overrides) hooks.fetch = overrides.fetch;
    },
    reset: () => {
      stop();
      audioState.element = null;
      blobs.clear();
      infos.clear();
      listeners.clear();
      lastError = null;
    }
  };
  OCD.voicePreview = api;
  // the chat view (public/app.js) does not know the node view: it reaches the player under this name
  global.OCDVoicePreview = api;
})(window);
