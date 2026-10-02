'use strict';

// Undo/redo snapshot stack of the node view (public/nodes/history.js).

const assert = require('assert/strict');

const { createHistory, DEFAULT_LIMIT } = require('../public/nodes/history');

function testBasicUndoRedo() {
  const h = createHistory();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo(), null);
  h.reset({ n: 0 });
  assert.equal(h.size, 1);
  assert.equal(h.commit({ n: 1 }), true);
  assert.equal(h.commit({ n: 2 }), true);
  assert.equal(h.commit({ n: 2 }), false, 'identical snapshot is ignored');
  assert.equal(h.canUndo(), true);
  assert.deepEqual(h.undo(), { n: 1 });
  assert.deepEqual(h.undo(), { n: 0 });
  assert.equal(h.undo(), null, 'nothing below the initial state');
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), true);
  assert.deepEqual(h.redo(), { n: 1 });
  assert.deepEqual(h.redo(), { n: 2 });
  assert.equal(h.redo(), null);
  assert.deepEqual(h.current(), { n: 2 });
}

function testBranching() {
  const h = createHistory();
  h.reset({ n: 0 });
  h.commit({ n: 1 });
  h.commit({ n: 2 });
  h.undo();
  h.undo();
  assert.equal(h.canRedo(), true);
  h.commit({ n: 9 });
  assert.equal(h.canRedo(), false, 'a new action discards the redo branch');
  assert.deepEqual(h.undo(), { n: 0 });
  assert.deepEqual(h.redo(), { n: 9 });
}

function testSnapshotsAreCopies() {
  const h = createHistory();
  const state = { list: [1] };
  h.reset(state);
  state.list.push(2);
  h.commit(state);
  state.list.push(3);
  const back = h.undo();
  assert.deepEqual(back, { list: [1] }, 'history is not affected by later mutation');
  back.list.push(99);
  assert.deepEqual(h.current(), { list: [1] }, 'returned snapshots are copies');
}

function testLimit() {
  const h = createHistory({ limit: 5 });
  h.reset({ n: 0 });
  for (let i = 1; i <= 10; i += 1) h.commit({ n: i });
  assert.equal(h.size, 5);
  let steps = 0;
  let last = null;
  for (let value = h.undo(); value; value = h.undo()) {
    steps += 1;
    last = value;
  }
  assert.equal(steps, 4);
  assert.deepEqual(last, { n: 6 }, 'oldest entries were dropped');
  assert.equal(DEFAULT_LIMIT, 100);
  assert.equal(createHistory().size, 0);
}

function testCoalescing() {
  let clock = 1000;
  const h = createHistory({ now: () => clock, coalesceMs: 500 });
  h.reset({ text: '' });
  h.commit({ text: 'a' }, { coalesceKey: 'n1:prompt' });
  clock += 100;
  h.commit({ text: 'ab' }, { coalesceKey: 'n1:prompt' });
  clock += 100;
  h.commit({ text: 'abc' }, { coalesceKey: 'n1:prompt' });
  assert.equal(h.size, 2, 'rapid edits of one field are one undo step');
  assert.deepEqual(h.undo(), { text: '' });

  h.redo();
  clock += 2000;
  h.commit({ text: 'abcd' }, { coalesceKey: 'n1:prompt' });
  assert.equal(h.size, 3, 'a pause starts a new step');

  clock += 100;
  h.commit({ text: 'abcde' }, { coalesceKey: 'n2:prompt' });
  assert.equal(h.size, 4, 'another key never coalesces');

  clock += 100;
  h.commit({ text: 'x' });
  clock += 100;
  h.commit({ text: 'xy' }, { coalesceKey: 'k' });
  clock += 100;
  h.undo();
  clock += 100;
  h.commit({ text: 'z' }, { coalesceKey: 'k' });
  assert.deepEqual(h.undo(), { text: 'x' }, 'no coalescing across an undo');
}

function testClear() {
  const h = createHistory();
  h.reset({ a: 1 });
  h.commit({ a: 2 });
  h.clear();
  assert.equal(h.size, 0);
  assert.equal(h.canUndo(), false);
  assert.equal(h.current(), null);
  h.commit({ a: 3 });
  assert.equal(h.size, 1, 'commit on an empty history starts it');
  assert.equal(h.canUndo(), false);
}

const tests = [testBasicUndoRedo, testBranching, testSnapshotsAreCopies, testLimit, testCoalescing, testClear];
for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log(`history ok: ${tests.length} Gruppen`);
console.log('test-nodes-history.js: ok');
