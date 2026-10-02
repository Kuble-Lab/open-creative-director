'use strict';

// Starter templates of the node view (SPEC §15): all of them load and validate against the registry, texts
// exist in de/en/es (Swiss spelling), `requires` covers the node types, the localized documents create
// workflows through the real routes, and the batch template maps a text list through the engine (with
// fake executors derived from the real node definitions, so no provider is contacted).

const assert = require('assert/strict');
const express = require('express');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const higgsfieldLib = require('../lib/higgsfield');
const falLib = require('../lib/fal');
const templates = require('../lib/nodes/templates');
const nodeRegistry = require('../lib/nodes/registry');
const { createRegistry } = nodeRegistry;
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore, validateDocument } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { registerNodeRoutes } = require('../lib/nodes/routes');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { textValue, listValue } = require('../lib/nodes/types');

const EXPECTED = [
  'dub-clip',
  'frame-chain',
  'hero-variants',
  'image-formats',
  'image-to-ad',
  'image-to-video',
  'masked-edit',
  'motion-title',
  'photo-slideshow',
  'series-shots',
  'song-from-idea',
  'storyboard-clips',
  'talking-portrait',
  'text-on-video',
  'video-to-post',
  'video-with-music'
];
// the ones that work without Higgsfield (credits): what participants and guests get
const FOR_PARTICIPANTS = EXPECTED.filter((id) => id !== 'dub-clip');
const FREE = ['image-formats', 'photo-slideshow', 'text-on-video'];

// requirement keys that a node type needs (mirrors the availability predicates of the node modules)
function requirementsOf(type) {
  const keys = [];
  if (type.startsWith('llm.')) keys.push('openrouter');
  else if (['image.generate', 'image.edit', 'image.relight', 'video.seedance'].includes(type)) keys.push('openrouter');
  else if (['audio.tts', 'audio.music', 'audio.music_plan'].includes(type)) keys.push('elevenlabs');
  else if (type.startsWith('fal.')) keys.push('fal');
  else if (type === 'video.motion_graphics') keys.push('rendernode');
  else if (type.startsWith('hf.') || ['image.higgsfield', 'video.higgsfield'].includes(type)) keys.push('higgsfield');
  const def = nodeRegistry.get(type);
  if (def && ['edit-image', 'edit-video', 'edit-audio'].includes(def.category)) keys.push('ffmpeg');
  if (['video.concat', 'llm.video_describer'].includes(type)) keys.push('ffmpeg');
  return keys;
}

function get(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, out));
  return out;
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-templates-'));
  const createdSessions = [];
  const wfStore = createWorkflowsStore({ dir: tmpDir });
  const createdWorkflows = [];
  let server = null;

  try {
    /* ----- the templates exist, load and validate ----- */
    const all = templates.loadTemplates();
    assert.deepEqual(all.map((template) => template.id).sort(), EXPECTED);
    for (const template of all) {
      const result = templates.validateTemplate(template);
      assert.ok(result.graph.nodes.length >= 4, `${template.id} has a real graph`);
      assert.ok(result.app.enabled && result.app.inputs.length && result.app.outputs.length, `${template.id} ships a Design App`);
      assert.ok(result.graph.nodes.some((node) => node.type === 'output.result'), `${template.id} has an output node`);
      assert.ok(result.graph.notes.length >= 1, `${template.id} explains itself with a note`);
      assert.ok(template.description.length > 20);

      // every node type of the template is covered by `requires`
      const needed = new Set(result.graph.nodes.flatMap((node) => requirementsOf(node.type)));
      for (const key of needed) assert.ok(template.requires.includes(key), `${template.id}: requires must include ${key}`);
      for (const key of template.requires) assert.ok(needed.has(key), `${template.id}: requires lists ${key} but no node needs it`);

      // exposed media/text inputs must be inputs of the graph or generation params that exist
      for (const entry of result.app.inputs) {
        const node = result.graph.nodes.find((item) => item.id === entry.node);
        assert.ok(node, `${template.id}: app input node ${entry.node}`);
        const def = nodeRegistry.get(node.type);
        assert.ok(def.params.some((param) => param.id === entry.param), `${template.id}: ${node.type} has no param ${entry.param}`);
        assert.ok(entry.label.length > 2);
      }
      for (const entry of result.app.outputs) {
        assert.equal(result.graph.nodes.find((item) => item.id === entry.node).type, 'output.result');
      }
    }

    // specific graph shapes the spec promises
    const byId = Object.fromEntries(all.map((template) => [template.id, template]));
    const types = (id) => byId[id].graph.nodes.map((node) => node.type);
    assert.deepEqual(types('hero-variants'), ['input.text', 'llm.prompt_enhancer', 'image.generate', 'image.resize', 'output.result']);
    assert.equal(byId['hero-variants'].graph.nodes.find((node) => node.type === 'image.generate').params.count, 4);
    assert.ok(types('image-to-ad').includes('llm.image_describer') && types('image-to-ad').includes('audio.tts') && types('image-to-ad').includes('video.merge_audio'));
    assert.ok(types('series-shots').includes('input.text_list') && types('series-shots').includes('video.concat'));
    assert.ok(byId['series-shots'].graph.nodes.find((node) => node.type === 'input.text_list').params.text.split('\n').length === 3);
    assert.ok(types('frame-chain').filter((type) => type === 'video.seedance').length === 2 && types('frame-chain').includes('video.extract_frame'));
    assert.equal(byId['frame-chain'].graph.nodes.find((node) => node.type === 'video.extract_frame').params.position, 'last');
    assert.ok(types('motion-title').includes('llm.motion_html') && types('motion-title').includes('video.motion_graphics') && types('motion-title').includes('input.video'));
    assert.ok(types('masked-edit').includes('image.mask_apply') && types('masked-edit').includes('image.composite'));
    // dub-clip: one source video fans out to three dubbing nodes (deu, fra, ita) that all feed the result node
    assert.deepEqual(types('dub-clip'), ['input.video', 'hf.dubbing', 'hf.dubbing', 'hf.dubbing', 'output.result']);
    assert.deepEqual(byId['dub-clip'].graph.nodes.filter((node) => node.type === 'hf.dubbing').map((node) => node.params.target_language), ['deu', 'fra', 'ita']);
    assert.deepEqual(byId['dub-clip'].requires, ['higgsfield']);
    assert.deepEqual(byId['dub-clip'].graph.edges.filter((edge) => edge.from.node === 'n1').map((edge) => edge.to.node), ['n2', 'n3', 'n4']);
    assert.deepEqual(byId['dub-clip'].graph.edges.filter((edge) => edge.to.node === 'n5').map((edge) => edge.from.node), ['n2', 'n3', 'n4']);
    assert.equal(templates.resolveTemplate('dub-clip', { lang: 'de' }).name, 'Clip in drei Landessprachen');
    // talking-portrait: portrait + script -> ElevenLabs voice -> H3 Max lip sync on fal.ai -> result
    assert.deepEqual(types('talking-portrait'), ['input.image', 'input.text', 'audio.tts', 'fal.h3_lipsync', 'output.result']);
    assert.deepEqual(byId['talking-portrait'].requires, ['fal', 'elevenlabs']);
    assert.deepEqual(
      byId['talking-portrait'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      ['n2.text>n3.text', 'n1.image>n4.image', 'n3.audio>n4.audio', 'n4.video>n5.inputs']
    );
    assert.equal(byId['talking-portrait'].app.enabled, true);
    assert.deepEqual(byId['talking-portrait'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.asset', 'n2.text', 'n4.resolution']);
    assert.equal(templates.resolveTemplate('talking-portrait', { lang: 'de' }).name, 'Sprechendes Porträt (H3 Max Lip Sync)');
    assert.equal(templates.resolveTemplate('talking-portrait', { lang: 'en' }).name, 'Talking portrait (H3 Max lip sync)');
    assert.ok(/Retrato parlante/.test(templates.resolveTemplate('talking-portrait', { lang: 'es' }).name));
    // video-with-music: the video sets the length of the music, the music is mixed quietly under the original sound
    assert.deepEqual(types('video-with-music'), ['input.video', 'input.prompt', 'audio.music', 'video.merge_audio', 'output.result']);
    assert.deepEqual(byId['video-with-music'].requires, ['elevenlabs', 'ffmpeg']);
    assert.deepEqual(
      byId['video-with-music'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      ['n2.prompt>n3.prompt', 'n1.video>n3.match', 'n1.video>n4.video', 'n3.audio>n4.audio', 'n4.video>n5.inputs']
    );
    const mix = byId['video-with-music'].graph.nodes.find((node) => node.type === 'video.merge_audio').params;
    assert.equal(mix.mode, 'mix');
    assert.ok(mix.audio_volume < mix.video_volume, 'the music is quieter than the original sound');
    assert.deepEqual(byId['video-with-music'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.asset', 'n2.prompt', 'n3.instrumental', 'n4.audio_volume']);
    assert.equal(templates.resolveTemplate('video-with-music', { lang: 'de' }).name, 'Video mit Musik');
    // song-from-idea: idea -> song text -> music; the song text is the plan of the music node
    assert.deepEqual(types('song-from-idea'), ['input.prompt', 'audio.music_plan', 'audio.music', 'output.result']);
    assert.deepEqual(byId['song-from-idea'].requires, ['elevenlabs']);
    assert.deepEqual(
      byId['song-from-idea'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      ['n1.prompt>n2.prompt', 'n2.plan>n3.plan', 'n3.audio>n4.inputs']
    );
    assert.deepEqual(byId['song-from-idea'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.prompt', 'n2.length']);
    assert.equal(templates.resolveTemplate('song-from-idea', { lang: 'es' }).name, 'Canción a partir de una idea');
    // the note of the song template names the command by its words in every language
    const songNote = (lang) => (lang === 'en' ? byId['song-from-idea'].graph.notes[0].text : byId['song-from-idea'].i18n[lang]['note.t1']);
    assert.match(songNote('en'), /Use as text/);
    assert.match(songNote('de'), /Als Text übernehmen/);
    assert.match(songNote('es'), /Usar como texto/);
    // frame-chain: the clip edges into concat are in playback order
    const concatEdges = byId['frame-chain'].graph.edges.filter((edge) => edge.to.port === 'clips');
    assert.deepEqual(concatEdges.map((edge) => edge.from.node), ['n2', 'n5']);

    /* ----- localization: de/en/es complete, Swiss spelling ----- */
    for (const template of all) {
      const i18n = template.i18n || {};
      const en = templates.localizeTemplate(template, 'en');
      assert.equal(en.name, template.name);
      assert.equal(en.i18n, undefined, 'the i18n block is not part of the workflow document');
      const expectedKeys = new Set(['name', 'description', 'app.title', 'app.description']);
      for (const node of template.graph.nodes) if (node.title) expectedKeys.add(`node.${node.id}`);
      for (const note of template.graph.notes) expectedKeys.add(`note.${note.id}`);
      for (const group of template.graph.groups) expectedKeys.add(`group.${group.id}`);
      for (const entry of template.app.inputs) expectedKeys.add(`app.input.${entry.node}.${entry.param}`);
      for (const entry of template.app.outputs) expectedKeys.add(`app.output.${entry.node}`);
      for (const lang of ['de', 'es']) {
        const strings = i18n[lang];
        assert.ok(strings, `${template.id} has ${lang} texts`);
        for (const key of expectedKeys) assert.ok(typeof strings[key] === 'string' && strings[key].trim(), `${template.id}.${lang} misses ${key}`);
        for (const key of Object.keys(strings)) {
          const valid = expectedKeys.has(key) || /^param\.[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$/.test(key);
          assert.ok(valid, `${template.id}.${lang} has an unknown key ${key}`);
          if (key.startsWith('param.')) {
            const [, nodeId, paramId] = key.split('.');
            assert.equal(typeof template.graph.nodes.find((node) => node.id === nodeId).params[paramId], 'string', `${key} overrides a string param`);
          }
        }
        const localized = templates.localizeTemplate(template, lang);
        assert.notEqual(localized.name, template.name);
        validateDocument({ format: 'ocd.workflow', version: 1, name: localized.name, description: localized.description, graph: localized.graph, app: localized.app });
        for (const text of collectStrings(localized)) assert.equal(text.includes('ß'), false, `${template.id}.${lang}: no sharp s (${text.slice(0, 40)})`);
      }
      // unknown languages fall back to English
      assert.equal(templates.localizeTemplate(template, 'fr').name, template.name);
      assert.equal(templates.pickLang('DE-CH'), 'de');
    }

    /* ----- listing and availability ----- */
    {
      const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
      const listed = templates.listTemplates({ lang: 'de', checks: allOn });
      assert.deepEqual(listed.map((item) => item.id).sort(), EXPECTED);
      assert.ok(listed.every((item) => item.available && item.missing.length === 0));
      const noAudio = templates.listTemplates({ lang: 'en', checks: { ...allOn, elevenlabs: () => 'ELEVENLABS_API_KEY is not set' } });
      const ad = noAudio.find((item) => item.id === 'image-to-ad');
      assert.equal(ad.available, false);
      assert.deepEqual(ad.missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.ok(noAudio.filter((item) => !['image-to-ad', 'talking-portrait', 'video-with-music', 'song-from-idea'].includes(item.id)).every((item) => item.available));
      // the music templates need the ElevenLabs key, and ffmpeg where the video is mixed
      assert.deepEqual(noAudio.find((item) => item.id === 'song-from-idea').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.deepEqual(noAudio.find((item) => item.id === 'video-with-music').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.deepEqual(noAudio.find((item) => item.id === 'talking-portrait').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      // Higgsfield is a requirement of its own: a template with hf.* nodes is available exactly when Higgsfield is connected
      const noHiggsfield = templates.listTemplates({ lang: 'en', checks: { ...allOn, higgsfield: () => 'Higgsfield is not connected' } });
      const dub = noHiggsfield.find((item) => item.id === 'dub-clip');
      assert.equal(dub.available, false);
      assert.deepEqual(dub.missing, [{ key: 'higgsfield', reason: 'Higgsfield is not connected' }]);
      assert.deepEqual(dub.requires, ['higgsfield']);
      assert.ok(noHiggsfield.filter((item) => item.id !== 'dub-clip').every((item) => item.available));
      // fal.ai is a requirement of its own: available exactly when FAL_KEY is set
      const noFal = templates.listTemplates({ lang: 'en', checks: { ...allOn, fal: () => 'FAL_KEY is not set' } });
      const portrait = noFal.find((item) => item.id === 'talking-portrait');
      assert.equal(portrait.available, false);
      assert.deepEqual(portrait.missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }]);
      assert.deepEqual(portrait.requires, ['fal', 'elevenlabs']);
      assert.ok(noFal.filter((item) => item.id !== 'talking-portrait').every((item) => item.available));
      const originalHasKey = falLib.hasKey;
      try {
        falLib.hasKey = () => true;
        assert.equal(templates.REQUIREMENT_CHECKS.fal(), true);
        falLib.hasKey = () => false;
        assert.match(templates.REQUIREMENT_CHECKS.fal(), /FAL_KEY/);
      } finally {
        falLib.hasKey = originalHasKey;
      }
      // the real check follows the connection state (mocked: no provider is contacted)
      const originalStatus = higgsfieldLib.status;
      try {
        higgsfieldLib.status = () => ({ connected: true });
        assert.equal(templates.REQUIREMENT_CHECKS.higgsfield(), true);
        higgsfieldLib.status = () => ({ connected: false });
        assert.match(templates.REQUIREMENT_CHECKS.higgsfield(), /Higgsfield/);
      } finally {
        higgsfieldLib.status = originalStatus;
      }
      assert.equal(noAudio.find((item) => item.id === 'series-shots').batch, true);
      assert.equal(noAudio.find((item) => item.id === 'hero-variants').batch, false);
      assert.equal(templates.listTemplates({ lang: 'de', checks: allOn }).find((item) => item.id === 'hero-variants').name, 'Produkt-Hero, 4 Varianten');
      assert.equal(templates.resolveTemplate('nope'), null);
      assert.equal(templates.resolveTemplate('hero-variants', { lang: 'es' }).graph.nodes[0].title, 'Escena de producto');
      // the real checks answer true or a reason string
      for (const item of templates.listTemplates()) assert.ok(typeof item.available === 'boolean');
    }

    /* ----- order, new templates, participants, cost, flow ----- */
    {
      assert.deepEqual([...templates.ORDER].sort(), EXPECTED, 'ORDER lists every template once and nothing else');
      assert.deepEqual(all.map((template) => template.id), [...templates.ORDER], 'templates are loaded in the order of ORDER');
      assert.equal(new Set(templates.ORDER).size, templates.ORDER.length);

      // the new ones: shapes, cheap defaults, usable for participants (no Higgsfield, no credits)
      assert.deepEqual(types('image-to-video'), ['input.image', 'input.prompt', 'video.seedance', 'output.result']);
      assert.deepEqual(types('text-on-video'), ['input.video', 'input.text', 'image.text_render', 'video.overlay_image', 'output.result']);
      assert.deepEqual(types('storyboard-clips'), ['input.text', 'llm.chat', 'text.split', 'video.seedance', 'video.concat', 'output.result']);
      assert.deepEqual(types('image-formats'), ['input.image', 'image.resize', 'image.resize', 'image.resize', 'output.result']);
      assert.deepEqual(types('video-to-post'), ['input.video', 'llm.video_describer', 'input.text', 'text.template', 'llm.chat', 'output.result']);
      assert.deepEqual(types('photo-slideshow'), ['input.media_list', 'image.to_video', 'video.concat', 'output.result']);
      for (const id of ['image-to-video', 'storyboard-clips']) {
        for (const node of byId[id].graph.nodes.filter((item) => item.type === 'video.seedance')) {
          assert.ok(node.params.duration <= 4 && node.params.resolution === '480p', `${id}: a first run is short and small`);
        }
      }
      assert.ok(byId['storyboard-clips'].graph.nodes.find((node) => node.type === 'text.split').params.max <= 3, 'few shots by default');
      assert.deepEqual(
        byId['image-formats'].graph.nodes.filter((node) => node.type === 'image.resize').map((node) => `${node.params.width}x${node.params.height}`),
        ['1920x1080', '1080x1920', '1080x1080']
      );
      const noRestricted = all.filter((template) => !templates.usesRestrictedNodes(template.graph)).map((template) => template.id);
      assert.deepEqual(noRestricted.sort(), FOR_PARTICIPANTS);
      assert.ok(FOR_PARTICIPANTS.length - 7 >= 4, 'at least four of the new templates are for participants');
      assert.ok(FREE.length >= 2 && FREE.every((id) => FOR_PARTICIPANTS.includes(id)), 'at least two are free and local');
      assert.ok(templates.usesRestrictedNodes(byId['dub-clip'].graph), 'Higgsfield nodes are restricted');
      assert.ok(templates.usesRestrictedNodes(templates.resolveTemplate('dub-clip')), 'a document works as well as a graph');
      assert.equal(templates.usesRestrictedNodes({ nodes: [] }), false);
      // motion-title also serves as the lower third
      assert.match(byId['motion-title'].description, /lower third/i);
      assert.match(byId['motion-title'].graph.nodes[0].params.text, /Head of Marketing/);

      // the participant filter of the list; internal people (no filter) get everything
      const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
      assert.deepEqual(templates.listTemplates({ checks: allOn }).map((item) => item.id), [...templates.ORDER]);
      assert.deepEqual(templates.listTemplates({ checks: allOn, hideRestricted: true }).map((item) => item.id), FOR_PARTICIPANTS.slice().sort((a, b) => templates.ORDER.indexOf(a) - templates.ORDER.indexOf(b)));

      // the summary carries what the gallery needs
      const summary = Object.fromEntries(templates.listTemplates({ lang: 'de', checks: allOn }).map((item) => [item.id, item]));
      assert.deepEqual(summary['image-to-video'].nodeTypes, ['input.image', 'input.prompt', 'video.seedance', 'output.result']);
      assert.equal(summary['image-to-video'].nodeCount, 4);
      assert.deepEqual(summary['image-to-video'].flow, [[{ type: 'input.image', count: 1 }, { type: 'input.prompt', count: 1 }], [{ type: 'video.seedance', count: 1 }], [{ type: 'output.result', count: 1 }]]);
      assert.deepEqual(summary['dub-clip'].flow, [[{ type: 'input.video', count: 1 }], [{ type: 'hf.dubbing', count: 3 }], [{ type: 'output.result', count: 1 }]], 'equal types of one step are counted');
      assert.equal(summary['storyboard-clips'].batch, false, 'one idea goes in, the three shots are made inside: no Batch mark');
      assert.equal(summary['photo-slideshow'].batch, true);
      assert.equal(summary['image-formats'].batch, false);
      // the inputs stand together in the first step: "what you give -> what happens -> result"
      assert.deepEqual(summary['text-on-video'].flow[0].map((entry) => entry.type).sort(), ['input.text', 'input.video']);
      for (const id of EXPECTED) {
        const later = summary[id].flow.slice(1).flat().map((entry) => entry.type);
        assert.ok(!later.some((type) => type.startsWith('input.')), `${id}: every input stands in the first step`);
      }
      // the limit of the Concatenate node is named where the photos are uploaded
      const toolsLib = require('../lib/tools');
      for (const lang of ['en', 'de', 'es']) {
        const strings = templates.loadTemplates().find((item) => item.id === 'photo-slideshow').i18n[lang] || {};
        const texts = lang === 'en' ? [byId['photo-slideshow'].app.description, byId['photo-slideshow'].app.inputs[0].label] : [strings['app.description'], strings['app.input.n1.assets']];
        for (const text of texts) assert.match(text, new RegExp(`\\b${toolsLib.MAX_CONCAT_ASSETS}\\b`), `photo-slideshow ${lang}: the limit of ${toolsLib.MAX_CONCAT_ASSETS} photos is named`);
      }

      // cost: computed from the nodes, local = free, unknown is marked, never invented
      for (const id of EXPECTED) {
        const cost = summary[id].cost;
        assert.equal(cost.kind, FREE.includes(id) ? 'free' : 'unknown', `${id}: the shipped nodes have no price table`);
        assert.equal(cost.paidNodes > 0, !FREE.includes(id));
        assert.deepEqual(cost.providers.every((key) => templates.PAID_PROVIDERS.includes(key)), true);
        if (FREE.includes(id)) assert.deepEqual(cost.providers, [], `${id}: nothing is billed`);
      }
      assert.deepEqual(summary['image-to-ad'].cost.providers, ['openrouter', 'elevenlabs']);
      assert.deepEqual(summary['dub-clip'].cost.providers, ['higgsfield']);
      // music: the length comes through a connection (the video, the song text), so the price is unknown, never 0
      assert.deepEqual(summary['video-with-music'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 1, providers: ['elevenlabs'] });
      assert.deepEqual(summary['song-from-idea'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 1, providers: ['elevenlabs'] });

      const priced = createRegistry();
      nodesBasic.registerAll(priced);
      const paid = (type, estimate, unit = 'usd') =>
        priced.register({
          type,
          category: 'utility',
          label: type,
          inputs: [{ id: 'text', type: 'text' }],
          outputs: [{ id: 'text', type: 'text' }],
          params: [{ id: 'size', kind: 'integer', default: 2 }],
          paid: true,
          cost: { unit, estimate },
          execute: async () => ({ variants: [{ text: textValue('x') }] })
        });
      paid('test.priced', (params) => ({ usd: 0.1 * params.size }));
      paid('test.credits', () => ({ credits: 12 }), 'credits');
      paid('test.vague', null);
      const chain = (...nodeTypes) => ({
        id: 'cost-demo',
        requires: ['openrouter', 'ffmpeg', 'fal'],
        graph: {
          nodes: [{ id: 'n0', type: 'input.text', params: { text: 'hi' }, x: 0, y: 0 }, ...nodeTypes.map((type, index) => ({ id: `n${index + 1}`, type, params: {}, x: 0, y: 0 }))],
          edges: nodeTypes.map((_type, index) => ({ id: `e${index}`, from: { node: `n${index}`, port: index ? 'text' : 'text' }, to: { node: `n${index + 1}`, port: 'text' } }))
        }
      });
      assert.deepEqual(templates.costSummary(chain('text.split'), { registry: priced }), { kind: 'free', usd: 0, credits: 0, paidNodes: 0, providers: [] }, 'a local chain is free');
      assert.deepEqual(templates.costSummary(chain('test.priced'), { registry: priced }), { kind: 'estimate', usd: 0.2, credits: 0, paidNodes: 1, providers: ['openrouter', 'fal'] });
      assert.deepEqual(templates.costSummary(chain('test.priced', 'test.priced'), { registry: priced }).usd, 0.4, 'the estimates add up');
      assert.deepEqual(templates.costSummary(chain('test.credits'), { registry: priced }), { kind: 'estimate', usd: 0, credits: 12, paidNodes: 1, providers: ['openrouter', 'fal'] });
      const partial = templates.costSummary(chain('test.priced', 'test.vague'), { registry: priced });
      assert.equal(partial.kind, 'partial');
      assert.equal(partial.usd, 0.2, 'what is known is the lower bound');
      assert.equal(templates.costSummary(chain('test.vague'), { registry: priced }).kind, 'unknown');
      assert.equal(templates.costSummary(chain('test.vague'), { registry: priced }).usd, 0);

      // a split of fixed size: one idea in, the list is made inside. Every paid node behind it runs once per part, so
      // the price is multiplied (no Batch mark); a list INPUT counts one entry ("per row")
      const splitGraph = (source, max) => ({
        id: 'split-demo',
        requires: ['openrouter'],
        graph: {
          nodes: [
            { id: 'a', type: source, params: source === 'input.text' ? { text: 'x' } : { text: 'x\ny' }, x: 0, y: 0 },
            ...(source === 'input.text' ? [{ id: 's', type: 'text.split', params: { max }, x: 0, y: 0 }] : []),
            { id: 'p', type: 'test.priced', params: {}, x: 0, y: 0 }
          ],
          edges: source === 'input.text'
            ? [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 's', port: 'text' } }, { id: 'e2', from: { node: 's', port: 'items' }, to: { node: 'p', port: 'text' } }]
            : [{ id: 'e1', from: { node: 'a', port: 'items' }, to: { node: 'p', port: 'text' } }]
        }
      });
      assert.equal(templates.costSummary(splitGraph('input.text', 3), { registry: priced }).usd, 0.6, 'three shots are paid three times');
      assert.equal(templates.costSummary(splitGraph('input.text', 1), { registry: priced }).usd, 0.2);
      assert.equal(templates.costSummary(splitGraph('input.text_list'), { registry: priced }).usd, 0.2, 'a list input counts one entry');
      assert.equal(templates.costSummary(chain('test.priced'), { registry: priced }).usd, 0.2, 'no list: unchanged');
      assert.equal(templates.listTemplates({ lang: 'en' }).find((item) => item.id === 'storyboard-clips').batch, false);

      // the engine helper behind it: availability never hides a price
      const engineLib = require('../lib/nodes/engine');
      const gated = createRegistry();
      nodesBasic.registerAll(gated);
      gated.register({ ...priced.get('test.priced'), type: 'test.gated', available: () => 'KEY is not set' });
      assert.equal(engineLib.estimateGraph(chain('test.gated').graph, { registry: gated }).usd, 0.2);

      // reading order of a graph
      const flow = templates.flowOf({
        nodes: [{ id: 'a', type: 'input.text' }, { id: 'b', type: 'text.join' }, { id: 'c', type: 'output.result' }, { id: 'd', type: 'input.text' }, { id: 'x', type: 'input.image' }],
        edges: [
          { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'items' } },
          { id: 'e2', from: { node: 'b', port: 'text' }, to: { node: 'c', port: 'inputs' } },
          { id: 'e3', from: { node: 'd', port: 'text' }, to: { node: 'c', port: 'inputs' } }
        ]
      });
      // inputs all stand in the first step, even when they feed a later node
      assert.deepEqual(flow.map((step) => step.map((entry) => `${entry.count}x${entry.type}`)), [['2xinput.text', '1xinput.image'], ['1xtext.join'], ['1xoutput.result']]);
      // another node without a predecessor still moves up to just before its first consumer
      const lone = templates.flowOf({
        nodes: [{ id: 'a', type: 'input.text' }, { id: 'b', type: 'text.join' }, { id: 'c', type: 'text.join' }, { id: 'k', type: 'util.pick' }],
        edges: [
          { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'items' } },
          { id: 'e2', from: { node: 'b', port: 'text' }, to: { node: 'c', port: 'items' } },
          { id: 'e3', from: { node: 'k', port: 'out' }, to: { node: 'c', port: 'items' } }
        ]
      });
      assert.deepEqual(lone.map((step) => step.map((entry) => entry.type)), [['input.text'], ['text.join', 'util.pick'], ['text.join']]);
    }

    /* ----- creation through the real routes: every template becomes a workflow ----- */
    {
      const app = express();
      app.use(express.json({ limit: '10mb' }));
      const bus = createEventBus();
      const engine = createEngine({ store: wfStore, registry: nodeRegistry.registry, events: bus, getConfig: () => ({ imageModel: 'x' }) });
      registerNodeRoutes(app, { engine, store: wfStore, events: bus });
      server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const port = server.address().port;

      const listed = await get(port, 'GET', '/api/workflow-templates?lang=de');
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.json.templates.map((item) => item.id).sort(), EXPECTED);
      assert.ok(listed.json.templates.every((item) => item.name && item.description && Array.isArray(item.requires)));
      assert.ok(listed.json.templates.every((item) => Array.isArray(item.nodeTypes) && Array.isArray(item.flow) && item.cost && item.cost.kind), 'node types, flow and cost travel with the list');

      // one template as a localized document (what the editor inserts into an open workflow)
      const one = await get(port, 'GET', '/api/workflow-templates/photo-slideshow?lang=de');
      assert.equal(one.status, 200);
      assert.equal(one.json.document.name, 'Fotoshow (lokal)');
      assert.equal(one.json.document.graph.nodes.length, 4);
      assert.equal(one.json.document.graph.nodes[0].title, 'Fotos');
      assert.ok(one.json.document.app && one.json.document.app.enabled, 'the document keeps its app section');
      assert.equal(one.json.document.i18n, undefined);
      assert.equal((await get(port, 'GET', '/api/workflow-templates/photo-slideshow?lang=xx')).json.document.name, 'Photo slideshow (local)');
      assert.equal((await get(port, 'GET', '/api/workflow-templates/nope')).status, 404);
      assert.equal((await get(port, 'GET', '/api/workflow-templates/..%2F..%2Fpackage')).status, 404);

      for (const id of EXPECTED) {
        const created = await get(port, 'POST', '/api/workflows', { templateId: id, lang: 'de' });
        assert.equal(created.status, 201, `${id}: ${JSON.stringify(created.json)}`);
        createdWorkflows.push(created.json.workflow.id);
        createdSessions.push(created.json.workflow.sessionId);
        const wf = created.json.workflow;
        assert.equal(wf.name, templates.resolveTemplate(id, { lang: 'de' }).name);
        assert.equal(wf.app.enabled, true);
        assert.equal(wf.graph.nodes.length, byId[id].graph.nodes.length);
        // media inputs come without an asset; the copy is a fresh workflow with its own backing session
        assert.equal(wf.rev, 1);
        assert.equal((await store.readSession(wf.sessionId)).kind, 'workflow');
        const plan = await get(port, 'POST', `/api/workflows/${wf.id}/runs/plan`, { mode: 'all' });
        assert.equal(plan.status, 200, `${id} plan: ${JSON.stringify(plan.json)}`);
        assert.equal(Object.keys(plan.json.nodes).length, wf.graph.nodes.length, 'the plan covers every node');
      }
      assert.equal((await get(port, 'POST', '/api/workflows', { templateId: 'nope' })).status, 404);
      const named = await get(port, 'POST', '/api/workflows', { templateId: 'hero-variants', name: 'My hero' });
      createdWorkflows.push(named.json.workflow.id);
      createdSessions.push(named.json.workflow.sessionId);
      assert.equal(named.json.workflow.name, 'My hero', 'an explicit name wins over the template name');
    }

    /* ----- batch: a text list is mapped through the series-shots graph ----- */
    {
      // fake executors on the real definitions (same ports and params, no provider)
      const registry = createRegistry();
      nodesBasic.registerAll(registry);
      const seen = { edit: [], video: [], concat: [] };
      const fakeImage = (name) => ({ type: 'image', sessionId: 'fake-session', assetId: `img-${name}`, file: `${name}.png`, url: `/assets/fake-session/${name}.png` });
      const fakeVideo = (name) => ({ type: 'video', sessionId: 'fake-session', assetId: `vid-${name}`, file: `${name}.mp4`, url: `/assets/fake-session/${name}.mp4` });
      const fake = (type, execute) => {
        const def = nodeRegistry.get(type);
        registry.register({ ...def, available: () => true, validate: undefined, cost: undefined, execute });
      };
      registry.unregister('input.image');
      fake('input.image', async () => ({ variants: [{ image: fakeImage('ref') }] }));
      fake('image.edit', async (ctx, inputs) => {
        seen.edit.push(inputs.prompt.value);
        return { variants: [{ image: fakeImage(`edit${ctx.itemIndex}`) }] };
      });
      fake('video.seedance', async (ctx, inputs) => {
        seen.video.push(inputs.first_frame.assetId);
        return { variants: [{ video: fakeVideo(`clip${ctx.itemIndex}`) }] };
      });
      fake('video.concat', async (_ctx, inputs) => {
        const clips = inputs.clips.type === 'list' ? inputs.clips.items : [inputs.clips];
        seen.concat.push(clips.map((clip) => clip.assetId));
        return { variants: [{ video: fakeVideo('series') }] };
      });

      const bus = createEventBus();
      const localStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
      const engine = createEngine({ store: localStore, registry, events: bus, getConfig: () => ({ imageModel: 'x' }), limits: { jobPollMs: 20 } });
      const doc = templates.resolveTemplate('series-shots', { lang: 'en' });
      // the image input needs no upload for the fake executor, but validation wants a resolvable asset param
      const created = await localStore.createWorkflow({ document: doc });
      createdWorkflows.push(created.workflow.id);
      createdSessions.push(created.workflow.sessionId);
      const id = created.workflow.id;

      const runId = await engine.start(id, { mode: 'all', user: 'tester' });
      const record = await engine.whenFinished(id, runId);
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.equal(seen.edit.length, 3, 'one image edit per scene line');
      assert.deepEqual(seen.edit, [
        'The character walks through a sunlit market',
        'The character sits at a cafe window while it rains',
        'The character looks over the city from a rooftop at dusk'
      ]);
      assert.equal(seen.video.length, 3, 'one clip per still');
      assert.equal(seen.concat.length, 1, 'the clips are joined once');
      assert.equal(seen.concat[0].length, 3, 'concat receives all three clips');

      // overrides of the Design App: two scenes instead of three
      seen.edit.length = 0;
      seen.video.length = 0;
      seen.concat.length = 0;
      const second = await engine.start(id, { mode: 'all', user: 'tester', overrides: { n2: { text: 'one\ntwo' } } });
      const secondRecord = await engine.whenFinished(id, second);
      assert.equal(secondRecord.status, 'completed');
      assert.deepEqual(seen.edit, ['one', 'two']);
      assert.equal(seen.concat[0].length, 2);
      const saved = await localStore.readWorkflow(id);
      assert.equal(saved.graph.nodes.find((node) => node.id === 'n2').params.text.split('\n').length, 3, 'overrides never change the saved graph');
      const results = await localStore.readResults(id);
      const outVariant = results.nodes.n6.history[0].variants[0];
      assert.equal(outVariant.result.type === 'video' || outVariant.result.type === 'list', true);

      // a listed input: app override of one item runs the map once
      seen.edit.length = 0;
      const third = await engine.start(id, { mode: 'all', user: 'tester', overrides: { n2: { text: 'solo' } } });
      await engine.whenFinished(id, third);
      assert.deepEqual(seen.edit, ['solo']);
      void textValue;
      void listValue;
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const workflowId of createdWorkflows) await wfStore.deleteWorkflow(workflowId).catch(() => {});
    for (const sessionId of createdSessions) await store.deleteSession(sessionId).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-templates ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
