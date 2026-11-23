'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const run = require('../public/nodes/run');
const { rows } = require('../public/nodes/i18n-nodes');

const css = fs.readFileSync(path.join(__dirname, '../public/nodes/nodes.css'), 'utf8');
const base = css.match(/^\.nv-node-msg\s*\{([^}]+)\}/m)?.[1];
const error = css.match(/^\.nv-node\[data-status='error'\] \.nv-node-msg\s*\{([^}]+)\}/m)?.[1];
assert.ok(base, 'base message rule exists');
assert.ok(error, 'error message rule exists');
assert.doesNotMatch(base, /224\s*,\s*104\s*,\s*95|#f0a39c/i);
assert.match(base, /border:\s*1px solid var\(--line\)/);
assert.match(base, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\)/);
assert.match(base, /color:\s*var\(--text-dim\)/);
assert.match(error, /border-color:\s*rgba\(224,\s*104,\s*95,\s*0\.4\)/);
assert.match(error, /background:\s*rgba\(224,\s*104,\s*95,\s*0\.09\)/);
assert.match(error, /color:\s*#f0a39c/i);

// slotFor is enclosed in the DOM controller. Exercise its pure status/text inputs.
const T = (key, data) => rows.find((row) => row[0] === key)[1].replace(/\{(\w+)\}/g, (_, k) => data[k]);
for (const phase of ['rendering', 'completed']) {
  const render = { phase, names: ['Mac mini M4 Pro'], done: phase === 'completed' ? 1 : 0, total: 1 };
  const state = run.reduce(run.createRunState(), { type: 'node_status', runId: 'r', nodeId: 'n', status: 'running', render });
  const shown = run.displayStatus({ run: state.nodes.n });
  assert.equal(shown.status, 'running');
  assert.notEqual(shown.status, 'error');
  assert.ok(run.renderText(state.nodes.n.render, T, shown.status).includes('Mac mini M4 Pro'));
}
console.log('test-nodes-msg-style.js: ok');
