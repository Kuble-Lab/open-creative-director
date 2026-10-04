'use strict';

// The play button next to every choice of a voice (WP38f, public/nodes/voice-preview.js and the select widget of public/nodes/node-ui.js),
// without a browser (scripts/support/fake-dom.js, a fake audio element and a fake fetch):
//   - the list tells what each voice is like (the labels behind the name, the description in the tooltip)
//   - the button: disabled with its reason while the list loads, without a key, for a voice that is not in the list, without budget
//   - a click plays the free sample (GET .../preview); only one sample plays at a time, a new one stops the old one, a click on the
//     playing button stops it; the same element is used (a phone needs the first play() inside the tap)
//   - a voice without a free sample: the price is in the tooltip beforehand, the click makes it (POST .../sample), a stored one is free
//   - a sample that is already loaded is not fetched again; a refused request shows its reason on the button
//   - the texts exist in German, English and Spanish

const assert = require('assert/strict');

const { loadPage } = require('./support/fake-dom');

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 6; i += 1) await tick();
}

class FakeAudio {
  constructor() {
    FakeAudio.instances.push(this);
    this.src = '';
    this.paused = true;
    this.plays = [];
    this.pauses = 0;
  }
  play() {
    this.paused = false;
    this.plays.push(this.src);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.pauses += 1;
  }
}
FakeAudio.instances = [];

const OPTIONS = [
  { value: '', label: 'Standard' },
  { value: 'lib1', label: 'Library', labels: { gender: 'female', accent: 'american', age: 'young', descriptive: 'calm', use_case: 'narration' }, description: 'Warm and calm.', preview: true },
  { value: 'lib2', label: 'Second', preview: true },
  { value: 'clone2', label: 'Silent clone' },
  { value: 'clone3', label: 'Stored clone' },
  { value: 'clone4', label: 'No key clone' }
];

function setup(lang, { options = OPTIONS, optionsError = null, info = {}, responses = {} } = {}) {
  FakeAudio.instances.length = 0;
  const requests = [];
  let created = 0;
  const fetchStub = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const custom = Object.entries(responses).find(([part]) => String(url).includes(part));
    if (custom) return custom[1](url, init);
    if (/\/sample\?/.test(url)) {
      const voice = /voices\/([^/]+)\/sample/.exec(url)[1];
      const body = { hasPreview: false, cached: false, usd: 0.0075, chars: 95, available: true, reason: null, ...(info[voice] || {}) };
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, headers: { get: (name) => (name === 'X-Sample-Cached' ? '0' : null) }, blob: async () => ({ size: 10 }), json: async () => ({}) };
  };
  const page = loadPage(lang, {
    scripts: ['voice-preview', 'node-ui'],
    api: {
      options: async (source) => {
        assert.equal(source, 'elevenlabs-voices');
        if (optionsError) throw Object.assign(new Error(optionsError.message), { status: optionsError.status });
        return { options };
      }
    },
    window: {
      Audio: FakeAudio,
      fetch: fetchStub,
      URL: { createObjectURL: () => `blob:sample-${(created += 1)}`, revokeObjectURL() {} }
    }
  });
  return { page, requests, ui: page.OCD.ui, voices: page.OCD.voicePreview };
}

const PARAM = { id: 'voice_id', kind: 'select', optionsSource: 'elevenlabs-voices', default: '21m00Tcm4TlvDq8ikWAM' };
function widgetFor(ui, value = '', model = 'eleven_v4') {
  const widget = ui.paramWidget(PARAM, value, { node: { id: 'n1', type: 'explainer.voice', params: { voice_id: value, model_id: model } }, onChange() {} });
  const select = widget.el.find((node) => node.tagName === 'SELECT')[0];
  const button = widget.el.find((node) => node.tagName === 'BUTTON')[0];
  return { widget, select, button };
}
const stateOf = (button) => button.attributes['data-state'];

async function main() {
  /* ---------- the list and the button ---------- */
  {
    const { ui, voices, requests } = setup('en');
    const { widget, select, button } = widgetFor(ui, 'lib1');
    assert.equal(widget.el.tagName, 'DIV');
    assert.ok(widget.el.classes.has('nv-voice-pick'), 'list and button side by side');
    assert.ok(button && select, 'a list and a play button');
    // while the list loads
    assert.equal(button.disabled, true);
    assert.equal(button.attributes.title, 'Loading …');
    await settle();
    // the entries tell what the voice is like
    const texts = select.children.map((option) => option.textContent);
    assert.ok(texts.includes('Library (female · young · american · calm)'), texts.join(' | '));
    assert.ok(texts.includes('Second'), 'a voice without labels stays as it is');
    const library = select.children.find((option) => option.attributes.value === 'lib1');
    assert.match(library.attributes.title, /Warm and calm\./);
    assert.match(library.attributes.title, /gender: female, age: young, accent: american, descriptive: calm, use case: narration/);
    assert.match(select.attributes.title, /Warm and calm\./, 'the tooltip of the list is that of the chosen voice');
    assert.equal(voices.summaryOf(OPTIONS[1]), 'female · young · american · calm');
    // ready: free sample, the first click starts it
    assert.equal(button.disabled, false);
    assert.equal(button.attributes.title, 'Play a sample');
    assert.equal(button.textContent, '▶');
    button.fire('click');
    assert.equal(stateOf(button), 'loading', 'the click answers at once');
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(FakeAudio.instances[0].plays.length, 1, 'the element is started inside the tap');
    await settle();
    assert.equal(requests[0].url, 'api/elevenlabs/voices/lib1/preview');
    assert.equal(requests[0].method, 'GET');
    const audio = FakeAudio.instances[0];
    assert.equal(audio.plays[audio.plays.length - 1], 'blob:sample-1');
    assert.equal(stateOf(button), 'playing');
    assert.equal(button.textContent, '■');
    assert.equal(button.attributes['aria-pressed'], 'true');
    // a click on the playing button stops it
    button.fire('click');
    assert.equal(audio.paused, true);
    assert.equal(stateOf(button), 'idle');
    assert.equal(button.textContent, '▶');
    // again: the loaded sample is not fetched again
    button.fire('click');
    await settle();
    assert.equal(requests.filter((request) => /preview/.test(request.url)).length, 1, 'one request for the same sample');
    assert.equal(audio.plays[audio.plays.length - 1], 'blob:sample-1');
    assert.equal(FakeAudio.instances.length, 1, 'one audio element for the whole page');
    // the end of the sample
    audio.onended();
    assert.equal(stateOf(button), 'idle');
    voices.reset();
  }

  /* ---------- only one sample at a time ---------- */
  {
    const { ui, voices } = setup('de');
    const first = widgetFor(ui, 'lib1');
    const second = widgetFor(ui, 'lib2');
    await settle();
    first.button.fire('click');
    await settle();
    assert.equal(stateOf(first.button), 'playing');
    second.button.fire('click');
    assert.equal(stateOf(first.button), 'idle', 'the new sample stops the old one at once');
    assert.equal(stateOf(second.button), 'loading');
    await settle();
    assert.equal(stateOf(second.button), 'playing');
    assert.equal(FakeAudio.instances[0].pauses >= 1, true);
    assert.equal(first.button.textContent, '▶');
    // changing the voice with the list: the button follows
    second.select.value = 'lib1';
    second.select.fire('change');
    assert.equal(second.button.attributes.title, 'Hörprobe abspielen');
    voices.stop();
    assert.equal(stateOf(second.button), 'idle');
    voices.reset();
  }

  /* ---------- the reasons ---------- */
  {
    // not in the list
    const unknown = setup('en');
    const a = widgetFor(unknown.ui, 'gone-voice');
    await settle();
    assert.equal(a.button.disabled, true);
    assert.match(a.button.attributes.title, /not in the list/);
    unknown.voices.reset();
    // no key (the list answers 503)
    const noKey = setup('en', { optionsError: { message: 'ElevenLabs API key is not configured', status: 503 } });
    const b = widgetFor(noKey.ui, 'lib1');
    await settle();
    assert.equal(b.button.disabled, true);
    assert.match(b.button.attributes.title, /Without an ElevenLabs key there is no sample/);
    b.button.fire('click');
    assert.equal(noKey.requests.length, 0, 'a disabled button asks for nothing');
    noKey.voices.reset();
    // the list does not load for another reason
    const broken = setup('es', { optionsError: { message: 'boom', status: 502 } });
    const c = widgetFor(broken.ui, 'lib1');
    await settle();
    assert.equal(c.button.disabled, true);
    assert.equal(c.button.attributes.title, 'No se pudo cargar la lista de voces.');
    broken.voices.reset();
  }

  /* ---------- a voice without a free sample ---------- */
  {
    const { ui, voices, requests } = setup('en', {
      info: { clone2: { usd: 0.0075 }, clone3: { cached: true, usd: 0.0075 }, clone4: { available: false, reason: 'no_key' } },
      responses: {}
    });
    const price = widgetFor(ui, 'clone2');
    const stored = widgetFor(ui, 'clone3');
    const nokey = widgetFor(ui, 'clone4');
    await settle();
    assert.ok(requests.some((request) => /voices\/clone2\/sample\?model_id=eleven_v4&lang=en/.test(request.url)), 'the price is asked for the model of the node and the language of the page');
    // the price is in the tooltip before the click
    assert.equal(price.button.disabled, false);
    assert.match(price.button.attributes.title, /about \$0\.008, only once per voice, model and language/);
    assert.match(stored.button.attributes.title, /already|made already/);
    assert.equal(nokey.button.disabled, true);
    assert.match(nokey.button.attributes.title, /Without an ElevenLabs key/);
    // the click makes it
    price.button.fire('click');
    await settle();
    const made = requests.find((request) => request.method === 'POST');
    assert.equal(made.url, 'api/elevenlabs/voices/clone2/sample');
    assert.deepEqual(made.body, { model_id: 'eleven_v4', lang: 'en' });
    assert.equal(stateOf(price.button), 'playing');
    voices.reset();
    // no budget: disabled with its reason
    const poor = setup('de', { info: { clone2: { available: false, reason: 'budget' } } });
    const d = widgetFor(poor.ui, 'clone2');
    await settle();
    assert.equal(d.button.disabled, true);
    assert.equal(d.button.attributes.title, 'Das Budget reicht für eine erzeugte Probe nicht.');
    poor.voices.reset();
    // a stored sample plays even where the budget is gone
    const kept = setup('en', { info: { clone2: { available: false, reason: 'budget', cached: true } } });
    const e = widgetFor(kept.ui, 'clone2');
    await settle();
    assert.equal(e.button.disabled, false);
    kept.voices.reset();
    // the price of a half-price model follows the model of the node
    const turbo = setup('en');
    const f = widgetFor(turbo.ui, 'clone2', 'eleven_v4_turbo');
    await settle();
    assert.ok(turbo.requests.some((request) => /model_id=eleven_v4_turbo/.test(request.url)));
    assert.equal(f.button.disabled, false);
    turbo.voices.reset();
  }

  /* ---------- a refused request ---------- */
  {
    const refuse = (status, body) => async () => ({ ok: false, status, json: async () => body });
    const budget = setup('en', { responses: { 'voices/lib1/preview': refuse(402, { code: 'BUDGET_EXHAUSTED', error: 'x' }) } });
    const a = widgetFor(budget.ui, 'lib1');
    await settle();
    a.button.fire('click');
    await settle();
    assert.equal(stateOf(a.button), 'error');
    assert.equal(a.button.attributes.title, 'The budget does not cover a made sample.');
    budget.voices.reset();
    const gone = setup('en', { responses: { 'voices/lib1/preview': refuse(404, { code: 'NOT_FOUND', error: 'Voice not found' }) } });
    const b = widgetFor(gone.ui, 'lib1');
    await settle();
    b.button.fire('click');
    await settle();
    assert.equal(stateOf(b.button), 'error');
    assert.match(b.button.attributes.title, /not in the list/);
    gone.voices.reset();
  }

  /* ---------- the default entry ---------- */
  {
    const { ui, voices, requests } = setup('en');
    const { button } = widgetFor(ui, '');
    await settle();
    assert.equal(button.disabled, false, 'the entry "default" can be heard');
    button.fire('click');
    await settle();
    assert.equal(requests[requests.length - 1].url, 'api/elevenlabs/voices/default/preview');
    voices.reset();
    // without a free sample the next click makes one
    const quiet = setup('en', { responses: { 'voices/default/preview': async () => ({ ok: false, status: 404, json: async () => ({ code: 'NO_PREVIEW' }) }) } });
    const other = widgetFor(quiet.ui, '');
    await settle();
    other.button.fire('click');
    await settle();
    assert.match(other.button.attributes.title, /No free sample|no free sample/);
    other.button.fire('click');
    await settle();
    assert.equal(quiet.requests.filter((request) => request.method === 'POST').length, 1);
    assert.equal(quiet.requests.find((request) => request.method === 'POST').url, 'api/elevenlabs/voices/default/sample');
    quiet.voices.reset();
  }

  /* ---------- the texts ---------- */
  {
    const { page } = setup('de');
    const keys = ['play', 'stop', 'loading', 'choose', 'playMade', 'playMadeStored', 'noKey', 'noBudget', 'noPreview', 'unknown', 'listFailed', 'playFailed'];
    for (const lang of ['de', 'en', 'es']) {
      const dictionary = page.window.I18N[lang];
      for (const key of keys) {
        const text = dictionary[`nodes.voice.${key}`];
        assert.ok(text && text.length > 3, `${lang} nodes.voice.${key}`);
        assert.ok(!text.includes('ß'), `${lang} nodes.voice.${key}: no sharp s`);
      }
      assert.ok(dictionary['nodes.voice.playMade'].includes('{price}'), `${lang}: the price`);
      for (const key of ['branding.speaker.label', 'branding.speaker.none', 'branding.speaker.saved', 'branding.speaker.removed', 'branding.speaker.hint', 'nodes.port.voice', 'nodes.portdesc.voice']) {
        assert.ok(dictionary[key], `${lang} ${key}`);
      }
    }
  }
}

main()
  .then(() => console.log('test-voice-preview-ui.js: ok'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
