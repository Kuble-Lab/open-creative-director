'use strict';

const assert = require('node:assert/strict');
const { rows } = require('../public/nodes/i18n-nodes');
const seen = new Set();
for (const row of rows) {
  assert.equal(seen.has(row[0]), false, `duplicate node translation: ${row[0]}`);
  seen.add(row[0]);
  assert.equal(row.length, 4, `${row[0]} supplies de/en/es`);
}
assert.equal(rows.find((row) => row[0] === 'nodes.port.last_frame')[1], 'Endbild');
console.log('test-node-i18n-unique.js: ok');
