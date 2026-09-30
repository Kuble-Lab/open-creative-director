'use strict';

// Side menu: projects ordered like chats (by what was worked on last) and open projects that load their own chats.
// The ordering functions of public/app.js are run against a stub state; the server side (lastActivity of
// GET /api/folders, the folder filter of GET /api/sessions) is covered by test-api-handlers.js and test-session-meta.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has ${name}`);
  // the function ends at the first line that is exactly "}" after its start
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 3);
}

function load(state) {
  const sandbox = { state, result: null };
  vm.runInNewContext([fn('sessionFolder'), fn('folderInfo'), fn('folderActivity'), fn('existingFolders'), 'result = existingFolders();'].join('\n'), sandbox);
  return Array.from(sandbox.result);
}

const at = (n) => `2026-09-${String(n).padStart(2, '0')}T10:00:00.000Z`;

// newest chat first: Neu (20th) before Alt (10th); Leer has no chat and waits at the end, alphabetically
assert.deepEqual(
  load({
    folders: [{ name: 'Alt', lastActivity: at(10) }, { name: 'Neu', lastActivity: at(20) }, { name: 'Zeta', lastActivity: null }, { name: 'Leer', lastActivity: null }],
    sessions: []
  }),
  ['Neu', 'Alt', 'Leer', 'Zeta']
);

// a loaded chat that is newer than the folder's date lifts the project up
assert.deepEqual(
  load({
    folders: [{ name: 'Alt', lastActivity: at(10) }, { name: 'Neu', lastActivity: at(20) }],
    sessions: [{ id: 'a', folder: 'Alt', updatedAt: at(25) }]
  }),
  ['Alt', 'Neu']
);

// a project that only exists through its chats is listed too
assert.deepEqual(
  load({ folders: [], sessions: [{ id: 'b', folder: 'Nur-im-Chat', updatedAt: at(3) }, { id: 'c', folder: null, updatedAt: at(4) }] }),
  ['Nur-im-Chat']
);

// same date: alphabetical
assert.deepEqual(
  load({ folders: [{ name: 'B', lastActivity: at(5) }, { name: 'A', lastActivity: at(5) }], sessions: [] }),
  ['A', 'B']
);

// open projects fetch their own chats through the folder filter, once per load
assert.match(source, /loadFolderSessions\(folder\)/, 'an open project loads its own chats');
assert.match(source, /folder=\$\{encodeURIComponent\(folder\)\}/, 'through the folder filter of /api/sessions');
assert.match(source, /folderSessionsRequested\.clear\(\)/, 'the request memory is reset on every list load');
assert.match(source, /sessions\.length < chatCount/, 'only when the badge counts more chats than the list holds');

console.log('sidebar order ok');
