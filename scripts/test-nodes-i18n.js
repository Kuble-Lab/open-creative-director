'use strict';

// i18n of the node view: de/en/es parity, Swiss spelling, placeholder consistency, coverage of every
// registry type / category / port / param / option, and of every literal key used by public/nodes/*.js.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const registryModule = require('../lib/nodes/registry');
const graphLib = require('../public/nodes/graph');

const storage = new Map([['vcd-lang', 'de']]);
const window = {
  document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
  navigator: { language: 'de-CH' },
  localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) }
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), { window }, { filename: 'public/i18n.js' });
const beforeKeys = Object.keys(window.I18N.de).length;
vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window }, { filename: 'public/nodes/i18n-nodes.js' });

const languages = ['de', 'en', 'es'];
const nodeKeys = (lang) => Object.keys(window.I18N[lang]).filter((key) => key.startsWith('nodes.')).sort();

function testParity() {
  const base = nodeKeys('de');
  assert.ok(base.length > 300, `expected many node keys, got ${base.length}`);
  for (const lang of languages) {
    assert.deepEqual(nodeKeys(lang), base, `${lang} has a different node key set`);
    for (const key of base) {
      const value = window.I18N[lang][key];
      assert.equal(typeof value, 'string', `${lang}.${key} is not a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
      assert.equal(value.includes('ß'), false, `${lang}.${key} contains a sharp s`);
    }
  }
  // the node file only adds nodes.* keys and leaves the chat dictionaries untouched
  const total = Object.keys(window.I18N.de).length;
  assert.equal(total, beforeKeys + base.length, 'i18n-nodes.js must only add nodes.* keys');
  const placeholders = (text) => (text.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const key of base) {
    const expected = placeholders(window.I18N.de[key]);
    for (const lang of ['en', 'es']) assert.equal(placeholders(window.I18N[lang][key]), expected, `${lang}.${key} placeholders differ from de`);
  }
}

function testSwissSpelling() {
  for (const key of nodeKeys('de')) {
    const value = window.I18N.de[key];
    assert.equal(/[Ss]chließ|groß|weiß/.test(value), false, key);
  }
  assert.equal(window.I18N.de['nodes.common.close'], 'Schliessen');
  assert.equal(window.I18N.de['nodes.zoom.in'], 'Vergrössern');
}

const RAW_OPTION = /^[0-9.:]+[a-z]*$/i; // ratios, resolutions, numbers stay literal

function testRegistryCoverage() {
  const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
  const has = (key) => Object.prototype.hasOwnProperty.call(window.I18N.de, key);
  const missing = [];
  const need = (key) => {
    if (!has(key)) missing.push(key);
  };
  for (const category of payload.categories) need(`nodes.category.${category}`);
  for (const base of Object.keys(payload.portTypes)) need(`nodes.ptype.${base}`);
  for (const def of payload.nodeTypes) {
    need(`nodes.type.${def.type}.label`);
    const ports = [...def.inputs, ...def.outputs];
    for (const variant of Object.values(def.portVariants?.values || {})) ports.push(...(variant.inputs || []), ...(variant.outputs || []));
    for (const port of ports) need(`nodes.port.${port.id}`);
    for (const param of def.params) {
      need(`nodes.param.${param.id}`);
      if (param.kind === 'select' && Array.isArray(param.options)) {
        for (const option of param.options) {
          const value = option && typeof option === 'object' ? option.value : option;
          if (!RAW_OPTION.test(String(value))) need(`nodes.option.${value}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], `registry strings without translation: ${[...new Set(missing)].join(', ')}`);
  // WP38d: the wording of an option for one parameter, nodes.option.<param>.<value> (node-ui.js optionLabelOf): it must belong to a real
  // select param that offers this value, in every language
  const scoped = Object.keys(window.I18N.de).filter((key) => /^nodes\.option\.[a-z_]+\..+$/.test(key));
  assert.ok(scoped.includes('nodes.option.language.auto'), 'the language of the explainer nodes says "same as input"');
  for (const key of scoped) {
    const [, , param, ...rest] = key.split('.');
    const value = rest.join('.');
    const offered = payload.nodeTypes.some((def) => def.params.some((item) => item.id === param && item.kind === 'select' && (item.options || []).some((option) => String(option && typeof option === 'object' ? option.value : option) === value)));
    assert.ok(offered, `${key}: no select param ${param} offers the option ${value}`);
  }
  assert.ok(payload.nodeTypes.length >= 73);
}

function sourceFiles() {
  const dir = path.join(root, 'public', 'nodes');
  return fs.readdirSync(dir).filter((file) => file.endsWith('.js') && file !== 'i18n-nodes.js').map((file) => path.join(dir, file));
}

function testSourceKeys() {
  const missing = [];
  const used = new Set();
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/'(nodes\.[A-Za-z0-9_.-]+)'/g)) {
      used.add(match[1]);
      if (!window.I18N.de[match[1]]) missing.push(`${path.basename(file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `keys used in the sources but not defined: ${missing.join(', ')}`);
  assert.ok(used.size > 150, `expected to find many key literals, found ${used.size}`);

  // Keys built from a variable at run time.
  const dynamic = [];
  for (const code of ['unknown_node', 'same_node', 'no_output', 'no_input', 'incompatible', 'duplicate', 'cycle', 'too_many', 'same_side', 'none']) dynamic.push(`nodes.connect.${code}`);
  for (const color of graphLib.GROUP_COLORS) dynamic.push(`nodes.color.${color}`);
  for (const kind of ['image', 'video', 'audio', 'document']) dynamic.push(`nodes.asset.hint.${kind}`);
  for (const status of ['queued', 'running', 'waiting_job', 'cached', 'done', 'error', 'skipped', 'cancelled', 'stale', 'notrun', 'invalid', 'unavailable']) {
    dynamic.push(`nodes.status.${status}`);
    dynamic.push(`nodes.statusHint.${status}`);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'running', 'finished']) dynamic.push(`nodes.run.result.${status}`);
  for (const state of ['saved', 'saving', 'dirty', 'offline', 'conflict']) dynamic.push(`nodes.save.${state}`);
  for (const kind of ['image', 'video', 'audio']) {
    dynamic.push(`nodes.picker.title.${kind}`, `nodes.picker.none.${kind}`);
  }
  for (const mark of ['input', 'output', 'both']) dynamic.push(`nodes.app.mark.${mark}`);
  for (const cost of ['estimate', 'estimateRow', 'from', 'fromRow', 'free', 'unknown']) dynamic.push(`nodes.template.cost.${cost}`);
  for (const code of ['empty', 'too_many', 'unknown_type']) dynamic.push(`nodes.insert.${code}`);
  for (const kind of ['free', 'usd', 'credits', 'external', 'freecall']) dynamic.push(`nodes.help.cost.${kind}`);
  // every issue the engine reports (code in lib/nodes/engine.js and in the validate of the node types) has a text in the card
  const issueCodes = new Set();
  for (const file of ['lib/nodes/engine.js', 'lib/nodes/nodes-basic.js']) {
    for (const match of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/code: '([a-z_]+)'/g)) issueCodes.add(match[1]);
  }
  for (const code of ['missing_input', 'unknown_type', 'cycle', 'bad_port', 'too_many_edges', 'dangling', 'incompatible', 'invalid_param', 'invalid', 'validate_failed', 'no_asset', 'asset_lost']) {
    assert.ok(issueCodes.has(code), `the engine no longer reports ${code}: drop its text`);
  }
  for (const code of issueCodes) {
    if (code === 'ok') continue;
    dynamic.push(`nodes.issue.${code}`);
    if (code !== 'invalid' && code !== 'validate_failed' && code !== 'invalid_param') dynamic.push(`nodes.issue.${code}.app`);
  }
  for (const key of dynamic) assert.ok(window.I18N.de[key], `missing dynamic key ${key}`);
  // the stable upper-case codes of the engine that the page shows by their translation (a refused or failed run of single
  // items, an empty output behind a connection): a text in every language, and the figures of the message are placeholders
  const engineSource = fs.readFileSync(path.join(root, 'lib/nodes/engine.js'), 'utf8');
  for (const code of ['ITEMS_NO_LIST', 'ITEMS_OUT_OF_RANGE', 'OUTPUT_EMPTY', 'OUTPUT_EMPTY_OPTIONAL']) {
    assert.ok(engineSource.includes(`'${code}'`), `the engine no longer reports ${code}: drop its text`);
    for (const lang of ['de', 'en', 'es']) assert.ok(window.I18N[lang][`nodes.issue.${code}`], `${lang}: no text for ${code}`);
  }
  for (const lang of ['de', 'en', 'es']) {
    const text = window.I18N[lang]['nodes.issue.ITEMS_OUT_OF_RANGE'];
    assert.ok(text.includes('{item}') && text.includes('{length}'), `${lang}: ITEMS_OUT_OF_RANGE names the item and the length`);
    assert.ok(window.I18N[lang]['nodes.issue.OUTPUT_EMPTY_OPTIONAL'].includes('{port}'), `${lang}: OUTPUT_EMPTY_OPTIONAL names the input`);
  }

  // every connection error code the graph can produce has a message
  const codes = new Set();
  const graphSource = fs.readFileSync(path.join(root, 'public', 'nodes', 'graph.js'), 'utf8');
  for (const match of graphSource.matchAll(/code: '([a-z_]+)'/g)) codes.add(match[1]);
  for (const code of ['unknown_node', 'same_node', 'no_output', 'no_input', 'incompatible', 'duplicate', 'cycle', 'too_many']) {
    assert.ok(codes.has(code), `graph.js no longer emits ${code}`);
  }
  for (const code of codes) {
    if (['dangling', 'duplicate_id', 'unknown_type', 'bad_port'].includes(code)) continue; // validate() codes, not shown to users
    assert.ok(window.I18N.de[`nodes.connect.${code}`], `graph error code ${code} has no message`);
  }
}

// Ports of every registered node type, both sides, including the ports of portVariants: { type, dir, port, base }.
function allPorts(payload) {
  const found = new Map();
  const add = (def, dir, port) => {
    const key = `${def.type}|${dir}|${port.id}`;
    if (!found.has(key)) found.set(key, { type: def.type, category: def.category, dir, port: port.id, base: graphLib.parseType(port.type).base });
  };
  for (const def of payload.nodeTypes) {
    const variants = def.portVariants ? Object.values(def.portVariants.values).map((v) => ({ inputs: v.inputs || def.inputs, outputs: v.outputs || def.outputs })) : [{ inputs: def.inputs, outputs: def.outputs }];
    for (const variant of variants) {
      for (const port of variant.inputs) add(def, 'in', port);
      for (const port of variant.outputs) add(def, 'out', port);
    }
  }
  return [...found.values()];
}

function testPortDescriptions() {
  const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
  const ports = allPorts(payload);
  assert.ok(ports.length >= 190, `expected all ports of all node types, got ${ports.length}`);
  const tiers = { specific: 0, generic: 0, type: 0 };
  const languagesToCheck = ['de', 'en', 'es'];
  for (const port of ports) {
    const keys = graphLib.portDescriptionKeys(port.type, port.port, port.base, port.dir);
    const chain = graphLib.portDescriptionChain(keys);
    for (const lang of languagesToCheck) {
      const hit = chain.find((key) => typeof window.I18N[lang][key] === 'string' && window.I18N[lang][key].trim());
      assert.ok(hit, `${lang}: ${port.type} ${port.dir} port ${port.port} has no description`);
      const text = window.I18N[lang][hit];
      assert.ok(text.length >= 12 && text.length <= 360, `${lang}.${hit} has an odd length (${text.length})`);
      assert.equal(text.includes('ß'), false, `${lang}.${hit} contains a sharp s`);
      if (lang === 'de') tiers[chain.indexOf(hit) < 2 ? 'specific' : chain.indexOf(hit) < 4 ? 'generic' : 'type'] += 1;
    }
  }
  // generation, LLM, Higgsfield and fal nodes never fall back to the port type
  for (const port of ports.filter((p) => ['llm', 'image', 'video', 'audio', 'higgsfield', 'fal'].includes(p.category) || p.type.startsWith('hf.'))) {
    const chain = graphLib.portDescriptionChain(graphLib.portDescriptionKeys(port.type, port.port, port.base, port.dir));
    const hit = chain.find((key) => window.I18N.de[key]);
    assert.ok(chain.indexOf(hit) < 4, `${port.type}.${port.port} only has the type-level text`);
  }
  // every H3 Max / fal / Higgsfield / LLM / generation node port has a text of its own
  for (const port of ports.filter((p) => p.category === 'fal' || p.category === 'llm' || ['image.generate', 'image.edit', 'video.seedance', 'audio.tts', 'video.concat', 'video.motion_graphics'].includes(p.type))) {
    const keys = graphLib.portDescriptionKeys(port.type, port.port, port.base, port.dir);
    assert.ok(window.I18N.de[keys.key] || window.I18N.de[keys.dirKey], `${port.type}.${port.port} needs a specific text`);
  }
  assert.ok(tiers.specific > 100 && tiers.generic > 20, `unexpected tier split ${JSON.stringify(tiers)}`);

  // a port id used on both sides of a node must not resolve to a side-less specific key (input text on the output)
  for (const port of ports) {
    if (!ports.some((other) => other.type === port.type && other.port === port.port && other.dir !== port.dir)) continue;
    const keys = graphLib.portDescriptionKeys(port.type, port.port, port.base, port.dir);
    for (const lang of languagesToCheck) {
      assert.ok(!window.I18N[lang][keys.key] || window.I18N[lang][keys.dirKey], `${lang}: ${keys.key} is side-less but ${port.type}.${port.port} exists on both sides`);
    }
  }

  // generic texts for all port ids, and the last-resort texts for all seven base types on both sides
  const ids = new Set(ports.map((p) => p.port));
  assert.equal(ids.size, 93, 'the registry has 93 port ids (66 incl. depth of the depth map + the 15 of the explainer foundation: documents, info, pages, files, topic, focus, sources, brand, logo, script, narration, briefs, image_prompts, clip_prompts, presenter + the 9 of the explainer production: narration_context, context, stills, pages_info, scenes, music, intro, outro, subtitles + voice of the speaker voice, WP38f + own_text of the planner, WP40 + reference, the storyboard frame of explainer.scene, WP43)');
  for (const id of ids) assert.ok(window.I18N.de[`nodes.portdesc.${id}`], `generic description for port id ${id}`);
  for (const base of ['text', 'number', 'image', 'video', 'audio', 'document', 'model3d', 'any']) {
    for (const dir of ['in', 'out']) assert.ok(window.I18N.de[`nodes.portdesc.type.${base}.${dir}`], `type description ${base}.${dir}`);
  }

  // no orphaned nodes.portdesc keys: every key names a real type / port id / port type
  const typeIds = new Set(payload.nodeTypes.map((def) => def.type));
  const portsByType = new Map();
  for (const port of ports) {
    if (!portsByType.has(port.type)) portsByType.set(port.type, new Map());
    portsByType.get(port.type).set(`${port.port}`, new Set([...(portsByType.get(port.type).get(port.port) || []), port.dir]));
  }
  const orphans = [];
  for (const key of nodeKeys('de').filter((k) => k.startsWith('nodes.portdesc.'))) {
    const rest = key.slice('nodes.portdesc.'.length);
    let match = /^type\.(text|number|image|video|audio|document|model3d|any)\.(in|out)$/.exec(rest);
    if (match) continue;
    if (ids.has(rest)) continue; // generic
    match = /^([a-z0-9_]+)\.(in|out)$/.exec(rest);
    if (match && ids.has(match[1])) {
      assert.ok(ports.some((p) => p.port === match[1] && p.dir === match[2]), `${key}: no port with this id on that side`);
      continue;
    }
    // <nodeType>.<portId>[.<in|out>]
    const sideMatch = /^(.*)\.(in|out)$/.exec(rest);
    const candidates = [{ name: rest, side: null }];
    if (sideMatch) candidates.push({ name: sideMatch[1], side: sideMatch[2] });
    const ok = candidates.some(({ name, side }) => {
      const cut = name.lastIndexOf('.');
      const type = name.slice(0, cut);
      const id = name.slice(cut + 1);
      if (!typeIds.has(type) || !portsByType.get(type)?.has(id)) return false;
      return !side || portsByType.get(type).get(id).has(side);
    });
    if (!ok) orphans.push(key);
  }
  assert.deepEqual(orphans, [], `orphaned portdesc keys: ${orphans.join(', ')}`);

  // the facts and chrome keys the tooltip uses exist in all languages
  for (const key of ['required', 'optional', 'output', 'connectedTo', 'notConnected', 'more', 'fact.multi', 'fact.multiUnlimited', 'fact.multiListMedia', 'fact.multiListMediaMax', 'fact.multiListMax', 'fact.orderShift', 'fact.multiList', 'fact.singleMap', 'fact.listIn', 'fact.param', 'fact.listOut']) {
    for (const lang of languagesToCheck) assert.ok(window.I18N[lang][`nodes.porttip.${key}`], `${lang}: nodes.porttip.${key}`);
  }
  assert.ok(window.I18N.de['nodes.palette.filterMulti']);
  // the multi-input wording keeps the numbers of the definition
  assert.match(window.I18N.de['nodes.porttip.fact.multi'], /\{max\}.*\{count\}/);
  return tiers;
}

// Search synonyms (WP21): every video, lip sync, voice, audio and video-analysis type has a translated list in all
// three languages, with distinct phrases; the palette splits it at commas.
function testSearchKeywords() {
  const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
  const mediaBase = (type) => graphLib.parseType(type)?.base;
  const portsOf = (def) => {
    const lists = [def.inputs, def.outputs];
    for (const variant of Object.values(def.portVariants?.values || {})) lists.push(variant.inputs || [], variant.outputs || []);
    return lists.flat();
  };
  const explicit = ['audio.tts', 'hf.speech', 'hf.voice_change', 'hf.dubbing', 'fal.h3_lipsync', 'llm.video_describer', 'image.to_video', 'video.seedance'];
  const required = payload.nodeTypes.filter(
    (def) => explicit.includes(def.type) || ['audio', 'edit-audio'].includes(def.category) || portsOf(def).some((port) => ['video', 'audio'].includes(mediaBase(port.type)))
  );
  assert.ok(required.length >= 35, `expected many video / audio types, got ${required.length}`);
  const normal = graphLib.normalizeSearch;
  for (const def of required) {
    const key = `nodes.type.${def.type}.keywords`;
    for (const lang of languages) {
      const value = window.I18N[lang][key];
      assert.ok(typeof value === 'string' && value.trim(), `${lang}.${key} is missing`);
      const phrases = value.split(',').map((item) => item.trim());
      assert.ok(phrases.length >= 3, `${lang}.${key} needs at least three phrases`);
      assert.ok(phrases.every(Boolean), `${lang}.${key} has an empty phrase`);
      assert.equal(new Set(phrases.map(normal)).size, phrases.length, `${lang}.${key} repeats a phrase`);
      assert.equal(value.includes('ß'), false, `${lang}.${key} contains a sharp s`);
    }
  }
  // every keywords row belongs to a registry type
  const typeIds = new Set(payload.nodeTypes.map((def) => def.type));
  for (const key of nodeKeys('de').filter((item) => item.endsWith('.keywords'))) {
    assert.ok(typeIds.has(key.slice('nodes.type.'.length, -'.keywords'.length)), `${key} names no node type`);
  }
  // the examples of the order
  const de = (type) => window.I18N.de[`nodes.type.${type}.keywords`].split(',').map((item) => item.trim());
  for (const word of ['KI-Video', 'Video generieren', 'Text zu Video', 'Bild zu Video', 'Bild animieren', 'Clip', 'Film']) assert.ok(de('video.seedance').includes(word), `Seedance: ${word}`);
  for (const word of ['Lippen', 'lippensynchron', 'sprechendes Porträt', 'Avatar']) assert.ok(de('fal.h3_lipsync').includes(word), `lip sync: ${word}`);
  for (const word of ['Zeitlupe', 'Zeitraffer']) assert.ok(de('video.speed').includes(word), `speed: ${word}`);
  for (const word of ['Video analysieren', 'Video verstehen']) assert.ok(de('llm.video_describer').includes(word), `video describer: ${word}`);
  for (const word of ['Ken Burns', 'Diashow', 'Slideshow', 'Zoom', 'Schwenk', 'Standbild']) assert.ok(de('image.to_video').includes(word), `zoom: ${word}`);
  // the texts for the palette hint and the unavailable reasons exist and keep their placeholders
  for (const lang of languages) {
    assert.match(window.I18N[lang]['nodes.palette.moreModels'], /\{count\}/);
    assert.match(window.I18N[lang]['nodes.palette.moreModelsSearch'], /\{count\}/);
    for (const reason of ['openrouter', 'llm', 'higgsfield', 'fal', 'elevenlabs', 'rendernode', 'ffmpeg', 'libass', 'resvg', 'poppler', 'account']) {
      assert.ok(window.I18N[lang][`nodes.reason.${reason}`], `${lang}: nodes.reason.${reason}`);
    }
  }
}

function testHtmlWiring() {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="nodesBtn"'), 'view switch button missing in the header');
  assert.ok(html.indexOf('id="nodesBtn"') < html.indexOf('</header>'), 'the view switch sits in the header');
  assert.ok(html.includes('id="nodeApp"'), 'node view container missing');
  assert.ok(html.includes('nodes/nodes.css'), 'stylesheet missing');
  const order = ['i18n.js', 'app.js', 'nodes/i18n-nodes.js', 'nodes/motion-html.js', 'nodes/music-plan.js', 'nodes/graph.js', 'nodes/history.js', 'nodes/api.js', 'nodes/node-ui.js', 'nodes/port-tip.js', 'nodes/preview.js', 'nodes/canvas.js', 'nodes/templates-ui.js', 'nodes/node-help.js', 'nodes/palette.js', 'nodes/inspector.js', 'nodes/archive-ui.js', 'nodes/workflow-list.js', 'nodes/asset-picker.js', 'nodes/run.js', 'nodes/app-mode.js', 'nodes/main.js'];
  let last = -1;
  for (const file of order) {
    const index = html.indexOf(`<script src="${file}"></script>`);
    assert.ok(index > last, `script ${file} missing or out of order`);
    last = index;
  }
  for (const lang of languages) {
    assert.ok(window.I18N[lang]['mode.nodes'] && window.I18N[lang]['mode.nodesTitle'] && window.I18N[lang]['mode.chat'], `${lang} view switch keys`);
  }
  const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.ok(!/OCDNodes|nodeApp|nodesBtn/.test(appSource), 'app.js must stay unchanged and independent of the node view');
}

const tests = [testParity, testSwissSpelling, testRegistryCoverage, testSourceKeys, testPortDescriptions, testSearchKeywords, testHtmlWiring];
for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log(`nodes i18n ok: ${nodeKeys('de').length} Keys in DE/EN/ES`);
console.log('test-nodes-i18n.js: ok');
