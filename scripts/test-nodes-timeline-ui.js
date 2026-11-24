'use strict';

// Wiring of the timeline review in the node view (static checks, no browser):
//   - index.html loads the pure module before the overlay and the style sheet after nodes.css
//   - the overlay follows the rules of the repository (no innerHTML, no native dialogs) and exposes its API
//   - every class the overlay sets has a rule or is a plain hook on a button
//   - the public descriptor of a cutting node carries `timeline`, others do not
//   - card, inspector, run path and main.js are connected
//   - all texts of the overlay exist in three languages, the help names the feature in every block

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('public/index.html');
const pure = index.indexOf('nodes/timeline.js');
const overlay = index.indexOf('nodes/timeline-ui.js');
assert.ok(pure > 0 && overlay > pure, 'index.html loads timeline.js before timeline-ui.js');
assert.ok(overlay < index.indexOf('nodes/main.js'), 'the overlay is loaded before main.js');
assert.ok(index.indexOf('nodes/timeline.css') > index.indexOf('nodes/nodes.css'), 'timeline.css follows nodes.css');

const ui = read('public/nodes/timeline-ui.js');
assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML|outerHTML/, 'no HTML strings');
assert.doesNotMatch(ui, /\b(?:alert|confirm|prompt)\(/, 'no native dialogs');
assert.match(ui, /timelineUi\s*=/, 'exposes OCD.timelineUi');

const css = read('public/nodes/timeline.css') + read('public/nodes/nodes.css') + read('public/styles.css');
const hooks = new Set(['nv-tl-approve-kind', 'nv-tl-render', 'nv-tl-close', 'nv-tl-approve', 'nv-tl-send', 'nv-tl-again', 'nv-tl-prompt-toggle']);
const classes = [...new Set(ui.match(/nv-tl[\w-]*/g))];
assert.ok(classes.length > 40, `the overlay sets its classes (${classes.length})`);
for (const name of classes) {
  if (!hooks.has(name)) assert.ok(css.includes(`.${name}`), `a rule for .${name}`);
}
assert.ok(css.includes('.nv-node-timeline.is-empty'), 'the card button is hidden on nodes without a timeline');

const registry = require('../lib/nodes/registry');
const types = registry.list().map(registry.publicDescriptor);
const byType = new Map(types.map((entry) => [entry.type, entry]));
for (const type of ['music_video.edit', 'explainer.edit', 'event_video.cut', 'video.concat']) {
  assert.equal(byType.get(type) && byType.get(type).timeline, true, `${type} has a timeline`);
}
assert.equal(byType.get('music_video.plan').timeline, undefined, 'a planning node has none');

assert.match(read('public/nodes/node-ui.js'), /nv-node-timeline-open/, 'the card has the button');
assert.match(read('public/nodes/inspector.js'), /cb\.onTimeline/, 'the inspector has the button');
const run = read('public/nodes/run.js');
assert.match(run, /TIMELINE_REVIEW_OPEN/, 'the run path knows the stop');
assert.match(run, /timeline:review/, 'a stopped start opens the timeline');
const main = read('public/nodes/main.js');
assert.match(main, /timelineUi\.open\(/, 'main.js opens the overlay');
assert.match(main, /onTimeline/, 'main.js connects the inspector');

const { rows } = (() => {
  const source = read('public/nodes/i18n-nodes.js');
  const found = [...source.matchAll(/\['(nodes\.timeline\.[\w.]+)', '((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'\]/g)];
  return { rows: found };
})();
assert.ok(rows.length >= 80, `texts of the timeline (${rows.length})`);
for (const [, key, de, en, es] of rows) {
  assert.ok(de && en && es, `${key} in three languages`);
  assert.doesNotMatch(de, /ß/, `${key}: Swiss spelling`);
}

const help = read('public/help.html');
for (const word of ['Timeline-Abnahme', 'Timeline review', 'Revisión de la línea de tiempo']) {
  assert.ok(help.includes(`<strong>${word}:</strong>`), `help: ${word}`);
}

console.log('test-nodes-timeline-ui.js: ok');
