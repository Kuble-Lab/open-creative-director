'use strict';

// Port types, compatibility, value helpers, registry framework and the basic node types (pure parts).

const assert = require('assert/strict');

const types = require('../lib/nodes/types');
const registryModule = require('../lib/nodes/registry');
const nodesBasic = require('../lib/nodes/nodes-basic');

const { canConnect, parseType, adaptValue, fingerprint, canonicalJson, textValue, numberValue, listValue } = types;

function asMedia(type, assetId, sessionId = 's1') {
  return { type, sessionId, assetId, file: `${assetId}.png`, url: `/assets/${sessionId}/${assetId}.png` };
}

function testTypes() {
  assert.deepEqual(parseType('image[]'), { base: 'image', list: true });
  assert.deepEqual(parseType('text'), { base: 'text', list: false });
  assert.equal(parseType('image[][]'), null);
  assert.equal(parseType('nonsense'), null);
  assert.equal(parseType(undefined), null);
  assert.equal(types.listOf('audio'), 'audio[]');

  // rules 1-2: same type, any
  for (const type of types.BASE_TYPES) assert.equal(canConnect(type, type), true, type);
  assert.equal(canConnect('any', 'video'), true);
  assert.equal(canConnect('audio', 'any'), true);
  // rule 3: number -> text only
  assert.equal(canConnect('number', 'text'), true);
  assert.equal(canConnect('text', 'number'), false);
  // rules 4-6: lists
  assert.equal(canConnect('image[]', 'image'), true);
  assert.equal(canConnect('image', 'image[]'), true);
  assert.equal(canConnect('image[]', 'image[]'), true);
  assert.equal(canConnect('number[]', 'text'), true);
  assert.equal(canConnect('text[]', 'number[]'), false);
  // rule 7: everything else
  assert.equal(canConnect('video', 'image'), false);
  assert.equal(canConnect('image', 'video'), false);
  assert.equal(canConnect('audio', 'text'), false);
  assert.equal(canConnect('image[]', 'video[]'), false);
  assert.equal(canConnect('bogus', 'text'), false);

  const { portTypes, compat } = types.describe();
  assert.equal(portTypes.image.color, '--nv-port-image');
  for (const from of types.BASE_TYPES) {
    for (const to of types.BASE_TYPES) assert.equal(compat[from][to], canConnect(from, to), `${from}->${to}`);
  }
  JSON.parse(JSON.stringify(types.describe()));
}

function testValues() {
  assert.equal(types.isValue(textValue('a')), true);
  assert.equal(types.isValue({ type: 'text', value: 3 }), false);
  assert.equal(types.isValue(numberValue(NaN)), false);
  assert.equal(types.isValue(asMedia('image', 'img-001')), true);
  assert.equal(types.isValue(listValue('text', [textValue('a')])), true);
  assert.equal(types.isValue({ type: 'video' }), false);
  assert.equal(types.valueType(listValue('image', [])), 'image[]');
  assert.equal(types.valueType(textValue('x')), 'text');

  // canonical JSON: key order does not matter, undefined is dropped
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), canonicalJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));

  // fingerprints (SPEC §9.3)
  assert.equal(fingerprint(numberValue(4)), 4);
  assert.match(fingerprint(textValue('hello')), /^t:[0-9a-f]{64}$/);
  assert.notEqual(fingerprint(textValue('a')), fingerprint(textValue('b')));
  assert.equal(fingerprint(asMedia('image', 'img-003', 'sess')), 'sess/img-003');
  assert.deepEqual(
    fingerprint(listValue('image', [asMedia('image', 'img-001'), asMedia('image', 'img-002')])),
    ['s1/img-001', 's1/img-002']
  );

  // adaptValue: coercion, wrapping, implicit map
  assert.deepEqual(adaptValue(numberValue(2.5), 'text'), { value: textValue('2.5'), map: false });
  assert.deepEqual(adaptValue(textValue('a'), 'text[]'), { value: listValue('text', [textValue('a')]), map: false });
  const list = listValue('text', [textValue('a'), textValue('b')]);
  assert.deepEqual(adaptValue(list, 'text'), { value: list, map: true });
  assert.deepEqual(adaptValue(list, 'text[]'), { value: list, map: false });
  assert.equal(adaptValue(listValue('number', [numberValue(1)]), 'text').value.items[0].value, '1');
  assert.ok(adaptValue(textValue('a'), 'image').error);
  assert.ok(adaptValue(asMedia('video', 'vid-001'), 'image').error);
  assert.deepEqual(adaptValue(asMedia('video', 'vid-001'), 'any'), { value: asMedia('video', 'vid-001'), map: false });
  assert.ok(adaptValue(textValue('a'), 'weird').error);
}

function testRegistry() {
  const registry = registryModule.createRegistry();
  const base = {
    type: 'x.thing',
    category: 'utility',
    label: 'Thing',
    inputs: [{ id: 'in', type: 'text', required: true, param: 'note' }],
    outputs: [{ id: 'out', type: 'text' }],
    params: [
      { id: 'note', kind: 'text', default: 'n' },
      { id: 'n', kind: 'integer', min: 1, max: 4, default: 2 },
      { id: 'ratio', kind: 'number', optional: true, default: null },
      { id: 'flag', kind: 'boolean' },
      { id: 'mode', kind: 'select', options: ['a', 'b'], default: 'a' }
    ],
    paid: true,
    cost: { unit: 'usd', estimate: () => 1 },
    available: () => 'OPENROUTER_API_KEY missing',
    validate: () => [],
    execute: async () => ({ variants: [{ out: textValue('x') }] })
  };
  const def = registry.register(base);
  assert.equal(def.version, 1);
  assert.equal(registry.get('x.thing'), def);
  assert.equal(registry.get('missing.type'), null);
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.register(base), /already registered/);
  assert.throws(() => registry.register({ ...base, type: 'bad' }), /bad type id/);
  assert.throws(() => registry.register({ ...base, type: 'x.b', category: 'nope' }), /unknown category/);
  assert.throws(() => registry.register({ ...base, type: 'x.b', execute: undefined }), /execute must be a function/);
  assert.throws(() => registry.register({ ...base, type: 'x.b', inputs: [{ id: 'in', type: 'blob' }] }), /unknown type/);
  assert.throws(() => registry.register({ ...base, type: 'x.b', inputs: [{ id: 'in', type: 'text', param: 'zzz' }] }), /unknown param/);
  assert.throws(() => registry.register({ ...base, type: 'x.b', outputs: [{ id: 'o', type: 'text' }, { id: 'o', type: 'text' }] }), /duplicate/);
  assert.throws(() => registry.register({ ...base, type: 'x.b', params: [{ id: 'p', kind: 'weird' }] }), /unknown kind/);
  // `suggest`: which node type the "put a node in front" button offers for an input (WP23)
  assert.throws(() => registry.register({ ...base, type: 'x.b', inputs: [{ id: 'in', type: 'text', suggest: 'Not A Type' }] }), /bad suggest hint/);
  assert.throws(() => registry.register({ ...base, type: 'x.b', inputs: [{ id: 'in', type: 'text', suggest: 5 }] }), /bad suggest hint/);
  assert.throws(() => registry.register({ ...base, type: 'x.b', outputs: [{ id: 'o', type: 'text', suggest: 'x.thing' }] }), /bad suggest hint/);
  const hinted = registry.register({ ...base, type: 'x.hinted', inputs: [{ id: 'in', type: 'text', suggest: 'x.thing' }] });
  assert.equal(registry.publicDescriptor(hinted).inputs[0].suggest, 'x.thing');
  // `min`: connections a multiple input needs at run time ("insert with inputs" supplies that many sources)
  assert.throws(() => registry.register({ ...base, type: 'x.c', inputs: [{ id: 'in', type: 'text', min: 2 }] }), /bad min/, 'only multiple inputs');
  assert.throws(() => registry.register({ ...base, type: 'x.c', inputs: [{ id: 'in', type: 'text', multiple: true, min: 0 }] }), /bad min/);
  assert.throws(() => registry.register({ ...base, type: 'x.c', inputs: [{ id: 'in', type: 'text', multiple: true, max: 2, min: 3 }] }), /bad min/, 'not above the maximum');
  assert.throws(() => registry.register({ ...base, type: 'x.c', outputs: [{ id: 'o', type: 'text', multiple: true, min: 1 }] }), /bad min/);
  const minimal = registry.register({ ...base, type: 'x.minimal', inputs: [{ id: 'in', type: 'text', multiple: true, min: 2, max: 5 }] });
  assert.equal(registry.publicDescriptor(minimal).inputs[0].min, 2);
  assert.equal(registryModule.get('video.concat').inputs[0].min, 2, 'Concatenate videos needs two clips');
  // provider: who bills a paid node (a label in the help); explicit wins, else derived from unit and category
  assert.equal(registryModule.providerOf({ paid: false, category: 'utility' }), null);
  assert.equal(registryModule.providerOf({ paid: true, category: 'llm' }), 'llm', 'a language model: OpenRouter or the ChatGPT subscription');
  assert.equal(registryModule.providerOf({ paid: true, category: 'image' }), 'openrouter');
  assert.equal(registryModule.providerOf({ paid: true, cost: { unit: 'credits' } }), 'higgsfield');
  assert.equal(registryModule.providerOf({ paid: true, category: 'fal' }), 'fal');
  assert.equal(registryModule.providerOf({ paid: true, category: 'audio', provider: 'elevenlabs' }), 'elevenlabs');

  assert.equal(registry.availability(def), 'OPENROUTER_API_KEY missing');
  const descriptor = registry.publicDescriptor(def);
  assert.equal(descriptor.available, 'OPENROUTER_API_KEY missing');
  assert.equal(descriptor.execute, undefined);
  assert.equal(descriptor.validate, undefined);
  assert.equal(descriptor.cost.hasEstimate, true);
  assert.equal(descriptor.cost.estimate, undefined);
  assert.equal(descriptor.paid, true);
  JSON.parse(JSON.stringify(descriptor));

  // normalizeParams: defaults, coercion, clamping, optional numbers
  assert.deepEqual(registry.normalizeParams(def, {}), { note: 'n', n: 2, ratio: null, flag: false, mode: 'a' });
  const normalised = registry.normalizeParams(def, { n: '9', ratio: '', flag: 'true', mode: 'zzz', extra: 1 });
  assert.equal(normalised.n, 4);
  assert.equal(normalised.ratio, null);
  assert.equal(normalised.flag, true);
  assert.equal(normalised.extra, 1);
  assert.equal(registry.normalizeParams(def, { n: 'abc' }).n, 2);
  assert.equal(registry.normalizeParams(def, { ratio: '0.5' }).ratio, 0.5);
  assert.deepEqual(registry.checkParams(def, normalised), ['param mode: "zzz" is not a valid option']);
  assert.deepEqual(registry.checkParams(def, registry.normalizeParams(def, {})), []);

  // a throwing availability check is reported, not thrown
  const throwing = registry.register({ ...base, type: 'x.throws', available: () => { throw new Error('kaput'); } });
  assert.match(registry.availability(throwing), /availability check failed: kaput/);
  const free = registry.register({ ...base, type: 'x.free', available: undefined });
  assert.equal(registry.availability(free), true);

  // portVariants switch ports by param
  const variant = registry.register({
    type: 'x.variant',
    category: 'input',
    params: [{ id: 'kind', kind: 'select', options: ['image', 'video'], default: 'image' }],
    outputs: [{ id: 'items', type: 'image[]' }],
    portVariants: { param: 'kind', values: { video: { outputs: [{ id: 'items', type: 'video[]' }] } } },
    execute: async () => ({ variants: [{}] })
  });
  assert.equal(registry.portsFor(variant, { kind: 'video' }).outputs[0].type, 'video[]');
  assert.equal(registry.portsFor(variant, {}).outputs[0].type, 'image[]');
  assert.throws(
    () => registry.register({ ...base, type: 'x.badvariant', portVariants: { param: 'nope', values: {} } }),
    /portVariants.param/
  );

  assert.equal(registry.unregister('x.free'), true);
  assert.equal(registry.get('x.free'), null);

  const payload = registry.publicRegistry();
  assert.equal(payload.version, registryModule.REGISTRY_VERSION);
  assert.ok(payload.portTypes.text && payload.compat.number.text === true);
  assert.deepEqual(payload.categories, registryModule.CATEGORIES);
  JSON.parse(JSON.stringify(payload));
}

async function testBasicNodes() {
  const registry = registryModule.registry;
  const expected = [
    'input.prompt', 'input.text', 'input.number', 'input.text_list', 'input.image', 'input.video', 'input.audio', 'input.media_list',
    'text.template', 'text.join', 'text.split', 'util.pick', 'util.router', 'output.result'
  ];
  for (const type of expected) {
    const def = registry.get(type);
    assert.ok(def, `${type} registered`);
    assert.equal(registry.availability(def), true);
    assert.equal(def.paid, false);
  }
  // the basic module registers exactly these types; the default registry also carries the later packages' nodes
  const basicOnly = registryModule.createRegistry();
  nodesBasic.registerAll(basicOnly);
  assert.deepEqual(basicOnly.list().map((def) => def.type).sort(), expected.slice().sort());
  for (const type of expected) assert.ok(registry.get(type));

  const ctx = { sessionId: 'unused', log: () => {} };
  const exec = (type, inputs, params) =>
    registry.get(type).execute(ctx, inputs, registry.normalizeParams(registry.get(type), params));

  // text list parsing
  assert.deepEqual(nodesBasic.parseTextList('a\n\n b \nc'), ['a', 'b', 'c']);
  assert.deepEqual(nodesBasic.parseTextList('one\nline two\n---\nthree\n---\n\n'), ['one\nline two', 'three']);
  assert.deepEqual(nodesBasic.parseTextList('a\nb\nc', 2), ['a', 'b']);
  const list = await exec('input.text_list', {}, { text: 'x\ny\nz', max: 2 });
  assert.deepEqual(list.variants[0].items.items.map((item) => item.value), ['x', 'y']);
  assert.equal(list.variants[0].items.of, 'text');

  assert.equal((await exec('input.text', {}, { text: 'hi' })).variants[0].text.value, 'hi');
  // the Prompt node: same value as input.text on an output port named prompt, listed first in the inputs
  const promptDef = registry.get('input.prompt');
  assert.deepEqual(promptDef.outputs, [{ id: 'prompt', type: 'text' }]);
  assert.deepEqual(promptDef.inputs, []);
  assert.equal(promptDef.params.find((param) => param.id === 'prompt').kind, 'textarea');
  assert.equal(promptDef.params.find((param) => param.id === 'prompt').inline, true);
  assert.equal(registry.list().findIndex((def) => def.type === 'input.prompt') < registry.list().findIndex((def) => def.type === 'input.text'), true, 'Prompt is registered before Text input');
  assert.deepEqual((await exec('input.prompt', {}, { prompt: 'a red fox' })).variants[0].prompt, textValue('a red fox'));
  assert.deepEqual((await exec('input.prompt', {}, {})).variants[0].prompt, textValue(''));
  assert.deepEqual((await exec('input.number', {}, { value: '3.5' })).variants[0].value, numberValue(3.5));
  const numberDef = registry.get('input.number');
  assert.deepEqual(numberDef.validate(registry.normalizeParams(numberDef, { value: 5, min: 6 })), ['value is below min (6)']);
  assert.deepEqual(numberDef.validate(registry.normalizeParams(numberDef, { value: 5 })), []);

  // template
  const template = await exec('text.template', { a: textValue('A'), c: textValue('C') }, { template: '[{{a}}][{{ b }}][{{c}}][{{unknown}}]' });
  assert.equal(template.variants[0].text.value, '[A][][C][{{unknown}}]');

  // join / split
  const items = listValue('text', [textValue('a'), textValue('b')]);
  assert.equal((await exec('text.join', { items }, { separator: ', ' })).variants[0].text.value, 'a, b');
  assert.equal((await exec('text.join', { items }, { separator: '\\n' })).variants[0].text.value, 'a\nb');
  const split = await exec('text.split', { text: textValue(' one ;two;; three ') }, { separator: ';', max: 2 });
  assert.deepEqual(split.variants[0].items.items.map((item) => item.value), ['one', 'two']);
  const lines = await exec('text.split', { text: textValue('a\r\nb\n\nc') }, {});
  assert.deepEqual(lines.variants[0].items.items.map((item) => item.value), ['a', 'b', 'c']);

  // pick / router
  const three = listValue('text', ['a', 'b', 'c'].map(textValue));
  assert.equal((await exec('util.pick', { items: three }, { index: 1 })).variants[0].item.value, 'b');
  assert.equal((await exec('util.pick', { items: three }, { index: -1 })).variants[0].item.value, 'c');
  await assert.rejects(exec('util.pick', { items: three }, { index: 3 }), /out of range/);
  await assert.rejects(exec('util.pick', { items: three }, { index: -4 }), /out of range/);
  assert.equal((await exec('util.router', { inputs: three }, { index: 2 })).variants[0].out.value, 'c');
  await assert.rejects(exec('util.router', { inputs: three }, { index: 5 }), /out of range/);
  await assert.rejects(exec('util.router', {}, { index: 0 }), /out of range/);

  // output.result stores what it received
  const result = await exec('output.result', { inputs: three }, { label: 'L' });
  assert.equal(result.variants[0].result.items.length, 3);
  assert.equal((await exec('output.result', {}, {})).variants[0].result.items.length, 0);

  // media inputs need an asset
  const image = registry.get('input.image');
  assert.deepEqual(image.validate({ asset: null }), [{ code: 'no_asset', message: 'image: no asset selected' }]);
  assert.deepEqual(image.validate({ asset: { assetId: 'upload-001', missing: true } }), [{ code: 'asset_lost', message: 'image: asset is missing, upload it again' }]);
  assert.deepEqual(image.validate({ asset: { assetId: 'upload-001' } }), []);
  await assert.rejects(exec('input.image', {}, { asset: null }), /No asset selected/);
  await assert.rejects(exec('input.image', {}, { asset: { assetId: 'upload-001', missing: true } }), /missing/);

  // input.media_list ports follow `kind`
  const mediaList = registry.get('input.media_list');
  assert.equal(registry.portsFor(mediaList, { kind: 'video' }).outputs[0].type, 'video[]');
  assert.equal(registry.portsFor(mediaList, { kind: 'audio' }).outputs[0].type, 'audio[]');
  assert.equal(registry.portsFor(mediaList, { kind: 'image' }).outputs[0].type, 'image[]');

  // output.result exposes a hidden passthrough only
  const output = registry.get('output.result');
  assert.equal(output.outputs.length, 1);
  assert.equal(output.outputs[0].hidden, true);
  assert.equal(output.inputs[0].multiple, true);

  const payload = registry.publicRegistry();
  // basic nodes are always available; provider-backed nodes report true or the reason they are not
  assert.ok(payload.nodeTypes.every((descriptor) => typeof descriptor.label === 'string'));
  assert.ok(payload.nodeTypes.filter((descriptor) => expected.includes(descriptor.type)).every((descriptor) => descriptor.available === true));
  assert.ok(payload.nodeTypes.every((descriptor) => descriptor.available === true || typeof descriptor.available === 'string'));
}

async function main() {
  testTypes();
  testValues();
  testRegistry();
  await testBasicNodes();
  console.log('test-nodes-types.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
