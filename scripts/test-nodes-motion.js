'use strict';

// "Motion graphics from HTML" clarity (WP13): the HTML heuristic (public/nodes/motion-html.js), the validation of the
// video.motion_graphics node before a run (codes not_html / composition_size, plan reasonCode / reasonData), the
// German tool errors of render_motion_graphics, the translated issue texts and the one-step conversion of an
// instruction into Prompt -> Motion HTML writer -> Motion graphics (public/nodes/graph.js). Local only: no network,
// no provider, no render node.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const motionHtml = require('../public/nodes/motion-html');
const graphLib = require('../public/nodes/graph');
const historyLib = require('../public/nodes/history');
const registryModule = require('../lib/nodes/registry');
const engineLib = require('../lib/nodes/engine');
const tools = require('../lib/tools');
const generate = require('../lib/nodes/nodes-generate');

const root = path.join(__dirname, '..');
const payload = JSON.parse(JSON.stringify(registryModule.publicRegistry()));
// The Motion HTML writer needs an LLM provider (unavailable on a machine without one); the conversion is only offered
// while it is available, so the tests run against a registry in which it is.
const payloadUnavailable = JSON.parse(JSON.stringify(payload));
payloadUnavailable.nodeTypes.find((type) => type.type === 'llm.motion_html').available = 'OPENROUTER_API_KEY is not set and ChatGPT is not connected';
payload.nodeTypes.find((type) => type.type === 'llm.motion_html').available = true;
const reg = graphLib.indexRegistry(payload);
const regUnavailable = graphLib.indexRegistry(payloadUnavailable);
const registry = registryModule.registry;

const COMPOSITION = (w, h, extra = '') =>
  '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>' +
  `<style>body,html{margin:0;width:${w}px;height:${h}px;overflow:hidden}</style></head><body>` +
  `<div id="main-composition" data-composition-id="main" data-width="${w}" data-height="${h}" data-start="0" data-duration="6">` +
  `<h1 class="title">Summer Sale</h1>${extra}` +
  "<script>const tl = gsap.timeline({paused:true}); window.__timelines = window.__timelines || {}; window.__timelines['main'] = tl;</script>" +
  '</div></body></html>';

function build() {
  let graph = graphLib.emptyGraph();
  const add = (type, x, y, params) => {
    const out = graphLib.addNode(reg, graph, type, { x, y, params });
    graph = out.graph;
    return out.node.id;
  };
  const link = (from, to) => {
    const out = graphLib.connect(reg, graph, from, to);
    assert.ok(!out.error, `connect ${JSON.stringify(from)} -> ${JSON.stringify(to)}: ${out.error && out.error.code}`);
    graph = out.graph;
    return out.edge;
  };
  return { get graph() { return graph; }, set graph(value) { graph = value; }, add, link };
}

function testHeuristic() {
  const html = [
    '<div></div>',
    '<div id="main-composition" data-width="1920" data-height="1080"></div>',
    COMPOSITION(1920, 1080),
    '<!DOCTYPE html>\n<html><body>x</body></html>',
    '<img src="{{asset:1}}">',
    '<video src="{{asset:2}}" muted></video>',
    '<svg viewBox="0 0 10 10"><feGaussianBlur stdDeviation="2"/></svg>',
    '<my-element>x</my-element>',
    '```html\n<div class="a">x</div>\n```',
    '<foo>bar</foo>',
    'Titel: <b>fett</b>',
    '<br/>',
    '\n\n   <section>\n<p>x</p>\n</section>'
  ];
  for (const text of html) assert.equal(motionHtml.looksLikeHtml(text), true, `HTML: ${JSON.stringify(text.slice(0, 40))}`);

  const free = [
    '',
    '   ',
    'make it one video',
    'Bold lower-third title "Summer Sale" with a thin amber line, elegant and calm.',
    '# Title\n\n**bold** and *italic*, a [link](https://example.com) and `code`',
    '- one\n- two\n\n> quote',
    'if x<y and z>w then stop',
    'a < b and c > d',
    'I <3 motion',
    '{{asset:1}} then {{asset:2}} one after the other',
    'Verbinde die zwei Videos zu einem Video.',
    'x <unknowntag y> z'
  ];
  for (const text of free) assert.equal(motionHtml.looksLikeHtml(text), false, `free text: ${JSON.stringify(text.slice(0, 40))}`);
  assert.equal(motionHtml.looksLikeHtml(undefined), false);
  assert.equal(motionHtml.looksLikeHtml(null), false);
  assert.equal(motionHtml.looksLikeHtml(42), false);

  // the contract of the tool description: its root element (with concrete dimensions) is HTML and fits its format
  const description = tools.RENDER_MOTION_GRAPHICS_DEFINITION.function.description;
  const rootExample = /<div id="main-composition".*?<\/div>/.exec(description);
  assert.ok(rootExample, 'the contract names the root element');
  const filled = rootExample[0].replace('<W>', '1920').replace('<H>', '1080').replace('<SECONDS>', '5');
  assert.equal(motionHtml.looksLikeHtml(filled), true);
  assert.equal(motionHtml.checkComposition(filled, 'landscape'), null);
  // what a model typically answers, after the fence has been stripped exactly like llm.motion_html does
  const fenced = '```html\n' + COMPOSITION(1080, 1920) + '\n```';
  const stripped = generate.stripCodeFence(fenced);
  assert.equal(motionHtml.looksLikeHtml(stripped), true);
  assert.equal(motionHtml.checkComposition(stripped, 'portrait'), null);
  assert.equal(motionHtml.looksLikeHtml(generate.stripCodeFence('Here is the code:\n<div id="main-composition" data-width="1080" data-height="1080"></div>')), true);

  // the template chains a writer into the render node: its HTML field is empty and connected, never "free text"
  const template = JSON.parse(fs.readFileSync(path.join(root, 'lib', 'nodes', 'templates', 'motion-title.json'), 'utf8'));
  const renderNode = template.graph.nodes.find((node) => node.type === 'video.motion_graphics');
  assert.equal(renderNode.params.html, '');
  assert.ok(template.graph.edges.some((edge) => edge.to.node === renderNode.id && edge.to.port === 'html'));
  const issues = engineLib.validateGraph({ graph: template.graph }, registry, null);
  assert.deepEqual(issues.filter((issue) => issue.code === 'not_html' || issue.code === 'composition_size'), [], 'the template raises no motion issue');

  // checkComposition
  assert.equal(motionHtml.checkComposition(COMPOSITION(1920, 1080), 'landscape'), null);
  assert.equal(motionHtml.checkComposition(COMPOSITION(1080, 1920), 'portrait'), null);
  assert.equal(motionHtml.checkComposition(COMPOSITION(1080, 1080), 'square'), null);
  assert.deepEqual(motionHtml.checkComposition('make it one video', 'landscape'), { code: 'not_html', format: 'landscape', width: 1920, height: 1080 });
  assert.deepEqual(motionHtml.checkComposition('<div></div>', 'portrait'), {
    code: 'composition_size', format: 'portrait', width: 1080, height: 1920, foundWidth: null, foundHeight: null
  });
  assert.deepEqual(motionHtml.checkComposition(COMPOSITION(1920, 1080), 'square'), {
    code: 'composition_size', format: 'square', width: 1080, height: 1080, foundWidth: '1920', foundHeight: '1080'
  });
  assert.equal(motionHtml.checkComposition('<div data-width="1920"></div>', 'landscape').foundHeight, null);
  assert.equal(motionHtml.checkComposition(COMPOSITION(1920, 1080), 'nonsense'), null, 'an unknown format falls back to landscape');
  assert.deepEqual(motionHtml.formatSize('square'), { format: 'square', width: 1080, height: 1080 });
  assert.equal(tools.RENDER_FORMATS, motionHtml.FORMATS, 'one table of formats');
}

function validateNode(params, ports = {}) {
  const def = registry.get('video.motion_graphics');
  return def.validate(registry.normalizeParams(def, params), ports);
}

function testValidation() {
  const notHtml = validateNode({ html: 'make it one video' });
  assert.equal(notHtml.length, 1);
  assert.equal(notHtml[0].code, 'not_html');
  assert.equal(notHtml[0].port, 'html');
  assert.deepEqual(notHtml[0].data, { format: 'landscape', width: 1920, height: 1080 });
  assert.match(notHtml[0].message, /HTML code/);
  // it also holds with connected assets (the user's screenshot: two videos plus "make it one video")
  assert.equal(validateNode({ html: 'make it one video' }, { assets: { connected: true, count: 2 } })[0].code, 'not_html');
  // markdown is not HTML either
  assert.equal(validateNode({ html: '# Title\n**bold**' })[0].code, 'not_html');
  // a connected HTML port is checked at run time, not here
  assert.deepEqual(validateNode({ html: 'make it one video' }, { html: { connected: true, count: 1 } }), []);
  assert.deepEqual(validateNode({ html: '' }), [], 'an empty field is reported as a missing input by the engine');
  assert.deepEqual(validateNode({ html: '   \n ' }), []);

  // HTML without or with wrong dimensions
  const noSize = validateNode({ html: '<div>x</div>', format: 'portrait' });
  assert.equal(noSize.length, 1);
  assert.equal(noSize[0].code, 'composition_size');
  assert.deepEqual(noSize[0].data, { format: 'portrait', width: 1080, height: 1920, foundWidth: '?', foundHeight: '?' });
  assert.match(noSize[0].message, /data-width="1080" and data-height="1920"/);
  const wrong = validateNode({ html: COMPOSITION(1920, 1080), format: 'square' });
  assert.equal(wrong[0].code, 'composition_size');
  assert.deepEqual(wrong[0].data, { format: 'square', width: 1080, height: 1080, foundWidth: '1920', foundHeight: '1080' });
  // fitting compositions and real writer output are fine
  assert.deepEqual(validateNode({ html: COMPOSITION(1920, 1080) }), []);
  assert.deepEqual(validateNode({ html: COMPOSITION(1080, 1920), format: 'portrait' }), []);
  assert.deepEqual(validateNode({ html: COMPOSITION(1080, 1080, '<img src="{{asset:1}}">'), format: 'square' }, { assets: { connected: true, count: 1 } }), []);
  // the placeholder check still works next to the new ones
  const both = validateNode({ html: 'use {{asset:1}}' });
  assert.deepEqual(both.map((issue) => issue.code), ['not_html'], 'free text with placeholders and no assets: the not_html cause comes first and alone');
  // real HTML with placeholders but no assets still gets the placeholder hint
  assert.deepEqual(validateNode({ html: COMPOSITION(1920, 1080, '<img src="{{asset:1}}">') }).map((issue) => issue.code), ['invalid_param']);
  // the plan shows not_html (with its data) as the reason, so the card can show the text and the remedy
  const placeholderWorkflow = {
    graph: {
      nodes: [{ id: 'm2', type: 'video.motion_graphics', typeVersion: 1, x: 0, y: 0, params: { html: '{{asset:1}} then {{asset:2}} one after the other' } }],
      edges: [],
      groups: [],
      notes: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    }
  };
  const placeholderRequest = engineLib.normaliseRequest({ mode: 'all' }, placeholderWorkflow, registry);
  const placeholderPlan = engineLib.computePlan({ workflow: placeholderWorkflow, results: {}, request: placeholderRequest, registry, limits: engineLib.resolveLimits() });
  assert.equal(placeholderPlan.nodes.m2.reasonCode, 'not_html');

  // through the engine: level error, data kept, node invalid in the plan with reasonCode / reasonData
  const workflow = {
    graph: {
      nodes: [
        { id: 'v1', type: 'input.video', typeVersion: 1, x: 0, y: 0, params: {} },
        { id: 'm1', type: 'video.motion_graphics', typeVersion: 1, x: 400, y: 0, params: { html: 'make it one video' } }
      ],
      edges: [{ id: 'e1', from: { node: 'v1', port: 'video' }, to: { node: 'm1', port: 'assets' } }],
      groups: [],
      notes: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    }
  };
  const issues = engineLib.validateGraph(workflow, registry, null).filter((issue) => issue.nodeId === 'm1');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'error');
  assert.equal(issues[0].code, 'not_html');
  assert.equal(issues[0].data.width, 1920);
  const request = engineLib.normaliseRequest({ mode: 'all' }, workflow, registry);
  const plan = engineLib.computePlan({ workflow, results: {}, request, registry, limits: engineLib.resolveLimits() });
  assert.equal(plan.valid, false);
  assert.equal(plan.nodes.m1.status, 'invalid');
  assert.equal(plan.nodes.m1.reasonCode, 'not_html');
  assert.deepEqual(plan.nodes.m1.reasonData, { format: 'landscape', width: 1920, height: 1080 });
  assert.match(plan.nodes.m1.reason, /HTML code/);
  // other invalid nodes keep working without data
  const missing = { graph: { ...workflow.graph, nodes: [workflow.graph.nodes[1]].map((node) => ({ ...node, params: {} })), edges: [] } };
  const missingPlan = engineLib.computePlan({ workflow: missing, results: {}, request: engineLib.normaliseRequest({ mode: 'all' }, missing, registry), registry, limits: engineLib.resolveLimits() });
  assert.equal(missingPlan.nodes.m1.reasonCode, 'missing_input');
  assert.equal(missingPlan.nodes.m1.reasonData, undefined);
}

async function testToolMessages() {
  const run = (args) => tools.executeTool({ sessionId: 'no-session', emit() {}, user: 'test' }, 'render_motion_graphics', args);
  await assert.rejects(run({ html: 'make it one video', label: 'x' }), (err) => {
    assert.match(err.message, /^Kein HTML:/);
    assert.match(err.message, /HTML\/GSAP-Komposition/);
    assert.match(err.message, /data-width="1920" data-height="1080"/);
    assert.match(err.message, /concat_videos/);
    assert.doesNotMatch(err.message, /[^\x20-\x7e]/, 'ASCII only (umlauts spelled out)');
    return true;
  });
  await assert.rejects(run({ html: 'make it one video', label: 'x', format: 'portrait' }), /data-width="1080" data-height="1920"/);
  await assert.rejects(run({ html: '<div></div>', label: 'x' }), (err) => {
    assert.match(err.message, /Composition-Masse/);
    assert.match(err.message, /Gefunden: \?x\?/);
    assert.match(err.message, /data-width="1920" und data-height="1080"/);
    assert.match(err.message, /id="main-composition"/);
    assert.doesNotMatch(err.message, /^Kein HTML/);
    return true;
  });
  await assert.rejects(run({ html: COMPOSITION(1920, 1080), label: 'x', format: 'square' }), /Gefunden: 1920x1080/);
}

function loadI18n() {
  const window = { I18N: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'i18n-nodes.js'), 'utf8'), { window, globalThis: window });
  return window.I18N;
}

function testI18n() {
  const dict = loadI18n();
  const keys = [
    'nodes.issue.not_html',
    'nodes.issue.not_html.plain',
    'nodes.issue.not_html.app',
    'nodes.issue.composition_size',
    'nodes.motion.htmlPlaceholder',
    'nodes.motion.convert',
    'nodes.motion.convertTitle',
    'nodes.motion.converted',
    'nodes.motion.convertFailed',
    'nodes.type.video.motion_graphics.label',
    'nodes.portdesc.video.motion_graphics.html',
    'nodes.portdesc.video.motion_graphics.assets',
    'nodes.portdesc.llm.motion_html.brief',
    'nodes.portdesc.llm.motion_html.assets',
    'nodes.portdesc.llm.motion_html.html'
  ];
  for (const lang of ['de', 'en', 'es']) {
    for (const key of keys) {
      const value = dict[lang][key];
      assert.ok(typeof value === 'string' && value.trim(), `${lang}.${key} exists`);
      assert.ok(!value.includes('ß'), `${lang}.${key} has no sharp s`);
    }
    for (const key of keys.filter((k) => k.startsWith('nodes.portdesc.'))) {
      assert.ok(dict[lang][key].length >= 12 && dict[lang][key].length <= 360, `${lang}.${key} keeps the port tip short`);
    }
  }
  // the placeholders of the size text are the same in every language
  for (const lang of ['de', 'en', 'es']) {
    assert.deepEqual([...dict[lang]['nodes.issue.composition_size'].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), ['format', 'foundH', 'foundW', 'h', 'w'], lang);
  }
  // the wording of the request: the not_html text names both remedies
  assert.match(dict.de['nodes.issue.not_html'], /HTML-Code/);
  assert.match(dict.de['nodes.issue.not_html'], /Videos aneinanderhängen/);
  assert.match(dict.de['nodes.issue.not_html'], /Mit KI in HTML umwandeln/);
  assert.equal(dict.de['nodes.type.video.motion_graphics.label'], 'Motion Graphics aus HTML (Render-Node)');
  assert.equal(dict.en['nodes.type.video.motion_graphics.label'], 'Motion graphics from HTML (render node)');
  assert.match(dict.de['nodes.motion.htmlPlaceholder'], /Motion-HTML-Autor/);
  // the variants name no button: the editor without a possible conversion, and the Design App
  assert.doesNotMatch(dict.de['nodes.issue.not_html.plain'], /umwandeln/);
  assert.doesNotMatch(dict.de['nodes.issue.not_html.app'], /umwandeln/);
  // the port text names the input the way the interface labels it
  for (const lang of ['de', 'en', 'es']) {
    assert.ok(dict[lang]['nodes.portdesc.video.motion_graphics.assets'].includes(`«${dict[lang]['nodes.port.assets']}»`) || dict[lang]['nodes.portdesc.video.motion_graphics.assets'].includes(`“${dict[lang]['nodes.port.assets']}”`), `${lang}: the assets port tip uses the label of the input`);
  }
  // the port texts explain the relation and the placeholders
  assert.match(dict.de['nodes.portdesc.video.motion_graphics.html'], /Motion-HTML-Autor/);
  assert.match(dict.de['nodes.portdesc.video.motion_graphics.html'], /\{\{asset:1\}\}/);
  assert.match(dict.de['nodes.portdesc.llm.motion_html.html'], /Motion Graphics aus HTML/);
  // the node UI turns an issue into text: translated with placeholders, else the English message
  const sandbox = { window: { I18N: dict, t: null }, document: {}, requestAnimationFrame() {}, globalThis: null };
  sandbox.window.t = (key, vars) => {
    let value = dict.de[key];
    if (value === undefined) return key;
    for (const [name, replacement] of Object.entries(vars || {})) value = value.split(`{${name}}`).join(String(replacement));
    return value;
  };
  sandbox.window.OCDNodes = { graph: graphLib };
  sandbox.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'node-ui.js'), 'utf8'), { ...sandbox, window: sandbox.window, document: { createElement() { return {}; } } }, { filename: 'node-ui.js' });
  const ui = sandbox.window.OCDNodes.ui;
  assert.equal(ui.hasIssueText('not_html'), true);
  assert.equal(ui.hasIssueText('missing_input'), true, 'a missing input has a translated text since WP23');
  assert.equal(ui.hasIssueText('no_such_code'), false);
  assert.equal(ui.issueText({ code: 'no_such_code', message: 'something is off' }), 'something is off', 'no translation: the message stays');
  assert.equal(ui.issueText({ code: 'not_html', message: 'x', data: { format: 'landscape', width: 1920, height: 1080 } }), dict.de['nodes.issue.not_html']);
  const sized = ui.issueText({ code: 'composition_size', message: 'x', data: { format: 'portrait', width: 1080, height: 1920, foundWidth: '1920', foundHeight: '?' } });
  assert.match(sized, /data-width="1080"/);
  assert.match(sized, /data-height="1920"/);
  assert.match(sized, /1920×\?/);
  assert.equal(ui.issueText(null), '');
  const notHtmlIssue = { code: 'not_html', message: 'x', data: { format: 'landscape', width: 1920, height: 1080 } };
  assert.equal(ui.issueText(notHtmlIssue, 'plain'), dict.de['nodes.issue.not_html.plain']);
  assert.equal(ui.issueText(notHtmlIssue, 'app'), dict.de['nodes.issue.not_html.app']);
  const sizedIssue = { code: 'composition_size', message: 'x', data: { format: 'portrait', width: 1080, height: 1920, foundWidth: '1', foundHeight: '2' } };
  assert.equal(ui.issueText(sizedIssue, 'app'), ui.issueText(sizedIssue), 'no variant text: the normal one is used');
  // the empty HTML field of the Motion graphics node says what belongs there; other fields keep their default
  assert.equal(ui.promptFieldOptions({ type: 'video.motion_graphics' }, { id: 'html', kind: 'code' }, []).placeholder, dict.de['nodes.motion.htmlPlaceholder']);
  assert.equal(Object.keys(ui.promptFieldOptions({ type: 'other.node' }, { id: 'html', kind: 'code' }, [])).length, 0);
}

function testConversion() {
  const b = build();
  const video1 = b.add('input.video', 0, 0);
  const image1 = b.add('input.image', 0, 200);
  const video2 = b.add('input.video', 0, 400);
  const motion = b.add('video.motion_graphics', 900, 200, { html: 'make it one video', format: 'portrait', quality: 'high', label: 'Clip' });
  const other = b.add('output.result', 1400, 200);
  b.link({ node: video1, port: 'video' }, { node: motion, port: 'assets' });
  b.link({ node: image1, port: 'image' }, { node: motion, port: 'assets' });
  b.link({ node: video2, port: 'video' }, { node: motion, port: 'assets' });
  b.link({ node: motion, port: 'video' }, { node: other, port: 'inputs' });
  const before = b.graph;

  assert.equal(graphLib.motionHtmlConversionIssue(reg, before, motion), null);
  assert.equal(graphLib.canConvertMotionHtml(reg, before, motion), true);

  const result = graphLib.convertMotionHtmlToWriter(reg, before, motion);
  assert.ok(!result.error, JSON.stringify(result.error));
  const graph = result.graph;
  assert.equal(graph.nodes.length, before.nodes.length + 2);
  assert.equal(result.prompt.type, 'input.prompt');
  assert.equal(result.writer.type, 'llm.motion_html');
  assert.equal(result.prompt.params.prompt, 'make it one video', 'the old field text becomes the prompt');
  assert.equal(result.writer.params.format, 'portrait', 'the format moves to the writer');
  assert.equal(result.writer.params.duration, 6, 'other writer params keep their defaults');
  assert.equal(graphLib.getNode(graph, motion).params.html, '', 'the HTML field is cleared');
  assert.equal(graphLib.getNode(graph, motion).params.format, 'portrait', 'the node keeps its own format');
  assert.equal(graphLib.getNode(graph, motion).params.quality, 'high');
  assert.deepEqual(graphLib.validate(reg, graph), []);

  // edges: prompt -> brief, html -> html, assets copied in the same order
  const into = (nodeId, portId) => graphLib.incomingEdges(graph, nodeId, portId).map((edge) => `${edge.from.node}.${edge.from.port}`);
  assert.deepEqual(into(result.writer.id, 'brief'), [`${result.prompt.id}.prompt`]);
  assert.deepEqual(into(result.writer.id, 'assets'), [`${video1}.video`, `${image1}.image`, `${video2}.video`], 'assets keep their order');
  assert.deepEqual(into(motion, 'html'), [`${result.writer.id}.html`]);
  assert.deepEqual(into(motion, 'assets'), [`${video1}.video`, `${image1}.image`, `${video2}.video`], 'the node keeps its own assets');
  assert.equal(graph.edges.length, before.edges.length + 5, 'brief, 3 assets and html were added');
  assert.deepEqual(result.edges.map((edge) => edge.id), [...new Set(result.edges.map((edge) => edge.id))], 'unique edge ids');
  assert.equal(into(other, 'inputs')[0], `${motion}.video`, 'the downstream edge is untouched');

  // placement: prompt left of writer left of the node, same height, no overlap with anything
  assert.ok(result.prompt.x + 340 <= result.writer.x, 'prompt ends before the writer');
  assert.ok(result.writer.x + 340 <= graphLib.getNode(graph, motion).x, 'writer ends before the motion node');
  assert.equal(result.prompt.y, result.writer.y);
  for (const added of [result.prompt, result.writer]) {
    const rect = graphLib.nodeRect(added);
    for (const node of before.nodes) {
      assert.equal(graphLib.rectsIntersect({ x: rect.x, y: rect.y, w: 340, h: 260 }, graphLib.nodeRect(node)), false, `${added.type} does not cover ${node.id}`);
    }
  }
  // the engine accepts the result: the motion node has no motion issue any more
  const issues = engineLib.validateGraph({ graph }, registry, null).filter((issue) => issue.nodeId === motion);
  assert.deepEqual(issues.map((issue) => issue.code), [], 'no issue on the motion node after the conversion');

  // an occupied spot is avoided
  const c = build();
  const target = c.add('video.motion_graphics', 900, 200, { html: 'join them' });
  const blocker = c.add('input.text', 250, 200);
  const blocker2 = c.add('input.text', 560, 200);
  const nudged = graphLib.convertMotionHtmlToWriter(reg, c.graph, target);
  for (const added of [nudged.prompt, nudged.writer]) {
    for (const id of [blocker, blocker2]) {
      assert.equal(graphLib.rectsIntersect({ x: added.x, y: added.y, w: 340, h: 260 }, graphLib.nodeRect(graphLib.getNode(c.graph, id))), false, `${added.type} keeps clear of ${id}`);
    }
  }
  // explicit ids and position
  const custom = graphLib.convertMotionHtmlToWriter(reg, c.graph, target, { promptId: 'p9', writerId: 'w9', edgeIds: { brief: 'eb', html: 'eh' }, position: { x: -800, y: 16 } });
  assert.deepEqual([custom.prompt.id, custom.writer.id, custom.edges.map((edge) => edge.id)], ['p9', 'w9', ['eb', 'eh']]);
  assert.deepEqual([custom.prompt.x, custom.prompt.y], [-800, 16]);
  assert.equal(custom.writer.x, -800 + 340 + 56);

  // refusals leave the graph untouched
  const refuse = (graphIn, id, reason) => {
    const out = graphLib.convertMotionHtmlToWriter(reg, graphIn, id);
    assert.equal(out.error && out.error.reason, reason);
    assert.equal(out.graph, graphIn, 'a refused conversion returns the graph unchanged');
    assert.equal(graphLib.canConvertMotionHtml(reg, graphIn, id), false);
  };
  refuse(graph, motion, 'connected');
  refuse(before, 'zz', 'unknown_node');
  refuse(before, video1, 'not_motion_node');
  const d = build();
  const empty = d.add('video.motion_graphics', 500, 0, { html: '   ' });
  refuse(d.graph, empty, 'empty');
  const real = d.add('video.motion_graphics', 500, 400, { html: COMPOSITION(1920, 1080) });
  refuse(d.graph, real, 'is_html');
  // an unavailable writer (no LLM provider): the button would leave a chain that cannot run, so nothing is offered
  assert.equal(graphLib.motionHtmlConversionIssue(regUnavailable, before, motion), 'writer_unavailable');
  assert.equal(graphLib.canConvertMotionHtml(regUnavailable, before, motion), false);
  const unavailable = graphLib.convertMotionHtmlToWriter(regUnavailable, before, motion);
  assert.equal(unavailable.error && unavailable.error.reason, 'writer_unavailable');
  assert.equal(unavailable.graph, before, 'nothing changes without an available writer');
  const noWriter = { ...reg, types: new Map([...reg.types].filter(([type]) => type !== 'llm.motion_html')) };
  assert.equal(graphLib.motionHtmlConversionIssue(noWriter, before, motion), 'no_writer_type');
  const noPrompt = { ...reg, types: new Map([...reg.types].filter(([type]) => type !== 'input.prompt')) };
  assert.equal(graphLib.motionHtmlConversionIssue(noPrompt, before, motion), 'no_writer_type');
  // without assets the writer just gets its brief
  const titleCard = d.add('video.motion_graphics', 500, 800, { html: 'title card' });
  const plain = graphLib.convertMotionHtmlToWriter(reg, d.graph, titleCard);
  assert.ok(!plain.error);
  assert.equal(graphLib.incomingEdges(plain.graph, plain.writer.id, 'assets').length, 0);
  assert.equal(plain.edges.length, 2);

  // one undo step restores everything
  const history = historyLib.createHistory({ now: () => 0 });
  history.reset(graphLib.content(before));
  history.commit(graphLib.content(graph), { label: 'convert-motion-html' });
  assert.equal(history.size, 2, 'the conversion is a single history entry');
  const undone = graphLib.withContent(graph, history.undo());
  assert.equal(undone.nodes.length, before.nodes.length);
  assert.equal(graphLib.getNode(undone, motion).params.html, 'make it one video', 'undo restores the text in the field');
  assert.equal(undone.edges.length, before.edges.length);
  assert.equal(graphLib.sameContent(undone, before), true);
}

function testWiring() {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const motion = html.indexOf('<script src="nodes/motion-html.js"></script>');
  assert.ok(motion > html.indexOf('nodes/i18n-nodes.js') && motion < html.indexOf('<script src="nodes/graph.js"></script>'), 'motion-html.js loads before graph.js');
  // the browser build of graph.js reads the helper from the shared namespace
  const source = fs.readFileSync(path.join(root, 'public', 'nodes', 'graph.js'), 'utf8');
  assert.match(source, /factory\(root\.OCDNodes\.motionHtml\)/);
  const browser = { window: {}, self: null };
  browser.self = browser.window;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'nodes', 'motion-html.js'), 'utf8'), browser);
  vm.runInNewContext(source, browser);
  assert.equal(typeof browser.window.OCDNodes.graph.convertMotionHtmlToWriter, 'function');
  assert.equal(browser.window.OCDNodes.motionHtml.looksLikeHtml('<div></div>'), true);
  // the card action and the inspector button are wired
  const main = fs.readFileSync(path.join(root, 'public', 'nodes', 'main.js'), 'utf8');
  assert.match(main, /convertMotionHtmlToWriter/);
  assert.match(main, /fixId === 'motion-html'/);
  assert.match(main, /onConvertMotionHtml: convertMotionHtml/);
  const run = fs.readFileSync(path.join(root, 'public', 'nodes', 'run.js'), 'utf8');
  assert.match(run, /fix = \{ id: 'motion-html'/);
  assert.match(run, /canConvertMotionHtml/);
  assert.match(main, /syncAppRemaps\(\);\s*pruneApp\(\)/, 'undo / redo carry the Design App exposure of a conversion along');
  for (const [fn, next] of [['extractPrompt', 'convertMotionHtml'], ['convertMotionHtml', 'renameNode']]) {
    const body = main.slice(main.indexOf(`function ${fn}(`), main.indexOf(`function ${next}(`));
    assert.match(body, /state\.appRemaps\.push\(/, `${fn} remembers the moved Design App exposure for undo / redo`);
  }
  const appMode = fs.readFileSync(path.join(root, 'public', 'nodes', 'app-mode.js'), 'utf8');
  assert.match(appMode, /ui\.issueText\(issue, 'app'\)/, 'the Design App uses its own wording');
  assert.match(run, /fix: null,/, 'the slot resets the remedy (canvas.setSlot merges patches)');
  // no innerHTML, no native dialogs in the new code
  for (const file of ['motion-html.js', 'graph.js', 'node-ui.js', 'run.js', 'main.js', 'inspector.js']) {
    const text = fs.readFileSync(path.join(root, 'public', 'nodes', file), 'utf8');
    assert.doesNotMatch(text, /innerHTML|\balert\(|\bconfirm\(|\bprompt\(/, `${file} uses no innerHTML or native dialogs`);
  }
}

async function main() {
  testHeuristic();
  console.log('ok testHeuristic');
  testValidation();
  console.log('ok testValidation');
  await testToolMessages();
  console.log('ok testToolMessages');
  testI18n();
  console.log('ok testI18n');
  testConversion();
  console.log('ok testConversion');
  testWiring();
  console.log('ok testWiring');
  console.log('test-nodes-motion.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
