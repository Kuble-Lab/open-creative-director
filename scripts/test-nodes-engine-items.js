'use strict';

// Cache per item of an implicit map and the run of single items (SPEC §9.6, §9.1 mode 'items'), with fake executors.
// No provider calls; backing sessions are real and removed.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRegistry } = require('../lib/nodes/registry');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { textValue, listValue } = require('../lib/nodes/types');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function node(id, type, params = {}) {
  return { id, type, typeVersion: 1, x: 0, y: 0, params };
}

function edges(...specs) {
  return specs.map((spec, index) => {
    const [from, to] = spec.split('>');
    const [fromNode, fromPort] = from.split('.');
    const [toNode, toPort] = to.split('.');
    return { id: `e${index + 1}`, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
  });
}

function buildEnvironment() {
  // every execution of a node: { node, item (ctx.itemIndex), input, out }
  const calls = [];
  let counter = 0;
  const failOn = { value: null };
  const registry = createRegistry();

  // a list of the words in `items` (comma separated)
  registry.register({
    type: 't.words',
    category: 'input',
    outputs: [{ id: 'items', type: 'text[]' }],
    params: [{ id: 'items', kind: 'text', default: 'a,b,c,d' }],
    execute: async (_ctx, _inputs, params) => ({
      variants: [{ items: listValue('text', params.items.split(',').filter(Boolean).map((word) => textValue(word))) }]
    })
  });
  registry.register({
    type: 't.single',
    category: 'input',
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'text', kind: 'text', default: 'x' }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ out: textValue(params.text) }] })
  });
  // The paid node of the tests: runs once per item. Its output carries a running number, so the test sees WHICH execution
  // made an item (the same key from an older run gives the older number). `refs` is a whole list that every item sees.
  registry.register({
    type: 't.scene',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }, { id: 'refs', type: 'text', multiple: true }],
    outputs: [{ id: 'out', type: 'text' }],
    params: [
      { id: 'style', kind: 'text', default: 'plain' },
      { id: 'count', kind: 'integer', default: 1, min: 1, max: 4 },
      { id: 'indexed', kind: 'boolean', default: false }
    ],
    paid: true,
    cost: { unit: 'usd', estimate: () => 0.5, history: false },
    itemIndexInKey: (params) => params.indexed === true,
    execute: async (ctx, inputs, params) => {
      await sleep(5);
      const word = inputs.in.value;
      if (failOn.value === word) throw new Error(`rejected ${word}`);
      counter += 1;
      const refs = (inputs.refs?.items || []).map((item) => item.value).join('+');
      calls.push({ node: ctx.nodeId, item: ctx.itemIndex, input: word });
      return {
        variants: [{ out: textValue(`${word}-${params.style}${params.indexed ? `@${ctx.itemIndex}` : ''}${refs ? `[${refs}]` : ''}#${counter}`) }],
        cost: { usd: 0.5 }
      };
    }
  });
  // a free follower that also runs once per item
  registry.register({
    type: 't.after',
    category: 'text',
    inputs: [{ id: 'in', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (ctx, inputs) => {
      calls.push({ node: ctx.nodeId, item: ctx.itemIndex, input: inputs.in.value });
      return { variants: [{ out: textValue(`<${inputs.in.value}>`) }] };
    }
  });
  // an output that stays empty when switched off, and two nodes behind it: one with an optional input, one with a required one
  registry.register({
    type: 't.switch',
    category: 'text',
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'on', kind: 'boolean', default: true }],
    emptyOutputs: (params) => (params.on ? [] : ['out']),
    execute: async (_ctx, _inputs, params) => ({ variants: [params.on ? { out: textValue('value') } : {}] })
  });
  // the same, but the person causes the empty output on purpose (a switch): no warning behind it
  registry.register({
    type: 't.switch_on_purpose',
    category: 'text',
    outputs: [{ id: 'out', type: 'text' }],
    params: [{ id: 'on', kind: 'boolean', default: true }],
    emptyOutputs: (params) => (params.on ? [] : ['out']),
    emptyOutputsSwitched: true,
    execute: async (_ctx, _inputs, params) => ({ variants: [params.on ? { out: textValue('value') } : {}] })
  });
  registry.register({
    type: 't.optional_in',
    category: 'text',
    inputs: [{ id: 'main', type: 'text', required: true }, { id: 'extra', type: 'text' }, { id: 'more', type: 'text', multiple: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (_ctx, inputs) => ({
      variants: [{ out: textValue(`${inputs.main.value}|${inputs.extra ? inputs.extra.value : 'no extra'}|${inputs.more ? inputs.more.items.length : 'no more'}`) }]
    })
  });
  registry.register({
    type: 't.required_in',
    category: 'text',
    inputs: [{ id: 'main', type: 'text', required: true }],
    outputs: [{ id: 'out', type: 'text' }],
    execute: async (_ctx, inputs) => ({ variants: [{ out: inputs.main }] })
  });
  return { registry, calls, failOn };
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-items-'));
  const bus = createEventBus();
  const created = [];
  const env = buildEnvironment();
  const wfStore = createWorkflowsStore({ dir, registry: env.registry, events: bus });
  const engine = createEngine({ store: wfStore, registry: env.registry, events: bus, getConfig: () => ({}), limits: { jobPollMs: 20, parallel: 3 } });

  async function makeWorkflow(nodes, edgeList = []) {
    const result = await wfStore.createWorkflow({ name: 'Items test', graph: { nodes, edges: edgeList } });
    created.push(result.workflow.id);
    return result.workflow;
  }
  async function run(workflowId, request) {
    const runId = await engine.start(workflowId, request);
    return engine.whenFinished(workflowId, runId);
  }
  async function setParams(workflowId, nodeId, params) {
    const current = await wfStore.readWorkflow(workflowId);
    const nodes = current.graph.nodes.map((item) => (item.id === nodeId ? { ...item, params: { ...item.params, ...params } } : item));
    await wfStore.saveGraph(workflowId, { baseRev: current.rev, graph: { ...current.graph, nodes } });
  }
  const results = async (id, nodeId) => (await wfStore.readResults(id)).nodes[nodeId];
  const selectedList = async (id, nodeId, port = 'out') => {
    const nodeResults = await results(id, nodeId);
    const entry = nodeResults.history.find((item) => item.id === nodeResults.selected.entry);
    return entry.variants[nodeResults.selected.variant][port].items.map((item) => item.value);
  };
  const usd = (record) => Math.round(record.cost.usd * 1e6) / 1e6;
  const reset = () => {
    env.calls.length = 0;
    env.failOn.value = null;
  };
  const ranItems = (nodeId) => env.calls.filter((call) => call.node === nodeId).map((call) => call.input);
  const strip = (value) => value.replace(/#\d+$/, '#');

  try {
    /* ----- one item changes: only this item runs and is booked ----- */
    {
      reset();
      const wf = await makeWorkflow(
        [node('l', 't.words', { items: 'a,b,c,d' }), node('m', 't.scene'), node('f', 't.after')],
        edges('l.items>m.in', 'm.out>f.in')
      );
      const first = await run(wf.id, { mode: 'all' });
      assert.equal(first.status, 'completed', JSON.stringify(first.nodes));
      assert.deepEqual(ranItems('m'), ['a', 'b', 'c', 'd']);
      assert.equal(usd(first), 2);
      const entry = (await results(wf.id, 'm')).history[0];
      assert.equal(entry.itemKeys.length, 4, 'a mapped entry stores the key of every item');
      assert.equal(new Set(entry.itemKeys).size, 4);
      assert.ok(entry.itemKeys.every((key) => /^sha256:[0-9a-f]{64}$/.test(key)));
      assert.equal(entry.itemKeys.includes(entry.cacheKey), false, 'an item key is not the key of the whole list');
      const before = await selectedList(wf.id, 'm');
      assert.deepEqual(before.map(strip), ['a-plain#', 'b-plain#', 'c-plain#', 'd-plain#']);
      assert.equal((await results(wf.id, 'f')).history[0].itemKeys.length, 4);

      // b becomes b2: the plan counts and prices one execution of the paid node
      await setParams(wf.id, 'l', { items: 'a,b2,c,d' });
      // while the list node itself is still stale the plan cannot know the new list (one more unknown, as before)
      const unknown = await engine.plan(wf.id, { mode: 'node', nodeIds: ['m'] });
      assert.equal(unknown.nodes.m.executions, null);
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      env.calls.length = 0;
      const plan = await engine.plan(wf.id, { mode: 'node', nodeIds: ['m'] });
      assert.equal(plan.nodes.m.status, 'stale');
      assert.equal(plan.nodes.m.executions, 1);
      assert.equal(plan.nodes.m.reusedItems, 3);
      assert.equal(plan.totals.paidNodes, 1);
      assert.equal(plan.totals.usd, 0.5, 'only the executions that really run are priced');
      // the plan of a node that is not mapped over a list is unchanged
      const planAll = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(planAll.nodes.l.executions, 1);

      env.calls.length = 0;
      const second = await run(wf.id, { mode: 'all' });
      assert.equal(second.status, 'completed', JSON.stringify(second.nodes));
      assert.deepEqual(ranItems('m'), ['b2'], 'only the changed item runs');
      assert.equal(usd(second), 0.5, 'only the new item is booked');
      assert.equal(ranItems('f').length, 1, 'the follower runs for the one new value only');
      assert.match(ranItems('f')[0], /^b2-plain#\d+$/);
      const after = await selectedList(wf.id, 'm');
      assert.equal(after.length, 4);
      assert.equal(after[0], before[0], 'unchanged items are the old results');
      assert.equal(after[2], before[2]);
      assert.equal(after[3], before[3]);
      assert.equal(strip(after[1]), 'b2-plain#');
      const newest = (await results(wf.id, 'm')).history[0];
      assert.equal(newest.itemKeys.length, 4);
      assert.equal(newest.cost.usd, 0.5);
      assert.equal((await results(wf.id, 'm')).history.length, 2, 'the run made a new history entry with the whole list');
      assert.deepEqual((await selectedList(wf.id, 'f')).map((value) => value.replace(/#\d+/, '#')), ['<a-plain#>', '<b2-plain#>', '<c-plain#>', '<d-plain#>']);

      // a parameter of the node changes every key: everything runs
      await setParams(wf.id, 'm', { style: 'bold' });
      env.calls.length = 0;
      const third = await run(wf.id, { mode: 'all' });
      assert.deepEqual(ranItems('m'), ['a', 'b2', 'c', 'd']);
      assert.equal(usd(third), 2);

      // the old list comes back: it is the whole-list cache of the first entry again (no run at all)
      await setParams(wf.id, 'm', { style: 'plain' });
      await setParams(wf.id, 'l', { items: 'a,b,c,d' });
      env.calls.length = 0;
      const back = await run(wf.id, { mode: 'all' });
      assert.equal(back.nodes.m.status, 'cached');
      assert.equal(env.calls.length, 0);
    }

    /* ----- an item moves in the list: found by its key, the rest of the cost is zero ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b,c' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      await setParams(wf.id, 'l', { items: 'c,a,b' });
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      env.calls.length = 0;
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.m.executions, 0, 'a reordered list needs no execution');
      const moved = await run(wf.id, { mode: 'all' });
      assert.equal(moved.status, 'completed');
      assert.equal(env.calls.length, 0);
      assert.equal(usd(moved), 0);
      assert.deepEqual((await selectedList(wf.id, 'm')).map(strip), ['c-plain#', 'a-plain#', 'b-plain#']);
      assert.equal((await results(wf.id, 'm')).history.length, 2, 'the new order is a new entry');
    }

    /* ----- a whole list that every item sees (multiple input) is part of every key ----- */
    {
      reset();
      const wf = await makeWorkflow(
        [node('l', 't.words', { items: 'a,b' }), node('r1', 't.single', { text: 'ref1' }), node('r2', 't.single', { text: 'ref2' }), node('m', 't.scene')],
        edges('l.items>m.in', 'r1.out>m.refs', 'r2.out>m.refs')
      );
      await run(wf.id, { mode: 'all' });
      assert.deepEqual((await selectedList(wf.id, 'm')).map(strip), ['a-plain[ref1+ref2]#', 'b-plain[ref1+ref2]#']);
      await setParams(wf.id, 'r2', { text: 'other' });
      env.calls.length = 0;
      await run(wf.id, { mode: 'all' });
      assert.deepEqual(ranItems('m'), ['a', 'b'], 'a change of a whole list that every item reads makes every item run');
    }

    /* ----- the position of the item is in the key where the result depends on it ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b,c' }), node('m', 't.scene', { indexed: true })], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      assert.deepEqual((await selectedList(wf.id, 'm')).map(strip), ['a-plain@0#', 'b-plain@1#', 'c-plain@2#']);
      // a new first item shifts the others: with the index in the key none of them is reused with its old position
      await setParams(wf.id, 'l', { items: 'z,a,b,c' });
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      env.calls.length = 0;
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.m.executions, 4);
      await run(wf.id, { mode: 'all' });
      assert.deepEqual(ranItems('m').sort(), ['a', 'b', 'c', 'z']);
      assert.deepEqual((await selectedList(wf.id, 'm')).map(strip), ['z-plain@0#', 'a-plain@1#', 'b-plain@2#', 'c-plain@3#']);
      // the same list without the index in the key reuses them (the control of the case above)
      const wf2 = await makeWorkflow([node('l', 't.words', { items: 'a,b,c' }), node('m', 't.scene', { indexed: false })], edges('l.items>m.in'));
      await run(wf2.id, { mode: 'all' });
      await setParams(wf2.id, 'l', { items: 'z,a,b,c' });
      env.calls.length = 0;
      await run(wf2.id, { mode: 'all' });
      assert.deepEqual(ranItems('m'), ['z']);
    }

    /* ----- order of the search: selected entry, history (newest first), partial ----- */
    {
      reset();
      const number = (value) => Number(value.split('#')[1]);
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' }); // E1
      await run(wf.id, { mode: 'node', nodeIds: ['m'], force: true }); // E2: every item made again
      const [e2, e1] = (await results(wf.id, 'm')).history;
      const read = (entry) => entry.variants[0].out.items.map((item) => number(item.value));
      const [a1, b1] = read(e1);
      const [a2, b2] = read(e2);
      assert.ok(a2 > a1 && b2 > b1 && a1 !== b1);
      // the user selects the OLDER entry; a list with a new second item takes `a` from the selected entry, not from the newest
      await wfStore.selectVariant(wf.id, 'm', { entry: e1.id, variant: 0 });
      await setParams(wf.id, 'l', { items: 'a,c' });
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      env.calls.length = 0;
      await run(wf.id, { mode: 'all' });
      assert.deepEqual(ranItems('m'), ['c']);
      const mixed = await selectedList(wf.id, 'm');
      assert.equal(number(mixed[0]), a1, 'the selected entry wins over a newer one with the same item');
      // the selected entry is now the new one (a from E1, c), which has no `b`: the history is searched, newest first (E2)
      await setParams(wf.id, 'l', { items: 'b' });
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      env.calls.length = 0;
      await run(wf.id, { mode: 'all' });
      assert.equal(env.calls.length, 0);
      assert.equal(number((await selectedList(wf.id, 'm'))[0]), b2, 'in the history the newest entry is taken');
      assert.notEqual(b2, b1);
    }
    {
      reset();
      // the third place: partial. A forced run of two items in which the second fails keeps the first (z#N) in `partial`;
      // the history has z too (from an earlier run, older number): the history is looked at first.
      const wf = await makeWorkflow([node('l', 't.words', { items: 'z' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      const old = (await selectedList(wf.id, 'm'))[0];
      await setParams(wf.id, 'l', { items: 'z,y' });
      env.failOn.value = 'y';
      env.calls.length = 0;
      const failed = await run(wf.id, { mode: 'all' });
      assert.equal(failed.nodes.m.status, 'error');
      assert.deepEqual(ranItems('m'), [], 'z comes from the history, y fails (before it is counted)');
      // partial holds nothing fresh (z was reused, y failed): nothing is stored
      assert.equal((await results(wf.id, 'm')).partial, undefined);
      // a forced run makes z again (z#new) and keeps it when y fails
      env.calls.length = 0;
      const forcedFail = await run(wf.id, { mode: 'node', nodeIds: ['m'], force: true });
      assert.equal(forcedFail.nodes.m.status, 'error');
      const partial = (await results(wf.id, 'm')).partial;
      assert.ok(partial && Array.isArray(partial.itemKeys) && partial.itemKeys.length === 2, 'the partial results know the key of every item');
      const kept = partial.items[0].variant.out.value;
      assert.notEqual(kept, old, 'the partial z is a newer execution than the one in the history');
      env.failOn.value = null;
      env.calls.length = 0;
      const ok = await run(wf.id, { mode: 'all' });
      assert.equal(ok.status, 'completed', JSON.stringify(ok.nodes));
      assert.deepEqual(ranItems('m'), ['y'], 'only the failed item is made now');
      assert.equal((await selectedList(wf.id, 'm'))[0], old, 'history before partial');
      assert.equal((await results(wf.id, 'm')).partial, undefined);

      // without a history entry the item comes from `partial`
      const wf2 = await makeWorkflow([node('l', 't.words', { items: 'p,q' }), node('m', 't.scene')], edges('l.items>m.in'));
      env.failOn.value = 'q';
      await run(wf2.id, { mode: 'all' });
      const partial2 = (await results(wf2.id, 'm')).partial;
      assert.deepEqual(Object.keys(partial2.items), ['0']);
      // the list changes (a new first item): `p` moves to place 1 and is still found by its key
      await setParams(wf2.id, 'l', { items: 'n,p' });
      await run(wf2.id, { mode: 'node', nodeIds: ['l'], force: true });
      env.failOn.value = null;
      env.calls.length = 0;
      const plan2 = await engine.plan(wf2.id, { mode: 'all' });
      assert.equal(plan2.nodes.m.reusedItems, 1);
      assert.equal(plan2.nodes.m.executions, 1);
      await run(wf2.id, { mode: 'all' });
      assert.deepEqual(ranItems('m'), ['n']);
    }

    /* ----- a forced run does not look into the cache ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b,c' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      env.calls.length = 0;
      const plan = await engine.plan(wf.id, { mode: 'node', nodeIds: ['m'], force: true });
      assert.equal(plan.nodes.m.status, 'forced');
      assert.equal(plan.nodes.m.executions, 3);
      assert.equal(plan.totals.usd, 1.5);
      const forced = await run(wf.id, { mode: 'node', nodeIds: ['m'], force: true });
      assert.equal(forced.status, 'completed');
      assert.deepEqual(ranItems('m').sort(), ['a', 'b', 'c']);
      assert.equal(usd(forced), 1.5);
    }

    /* ----- old entries without itemKeys stay valid and are used as a whole only ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b,c' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      await wfStore.updateResults(wf.id, (data) => {
        for (const entry of data.nodes.m.history) delete entry.itemKeys;
      });
      env.calls.length = 0;
      const same = await run(wf.id, { mode: 'all' });
      assert.equal(same.nodes.m.status, 'cached', 'an old entry is still found by the key of the whole list');
      assert.equal(env.calls.length, 0);
      await setParams(wf.id, 'l', { items: 'a,b,x' });
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.m.executions, 3, 'an old entry gives nothing per item');
      assert.equal(plan.nodes.m.reusedItems, undefined);
      await run(wf.id, { mode: 'all' });
      assert.deepEqual(ranItems('m').sort(), ['a', 'b', 'x']);
      assert.equal((await results(wf.id, 'm')).history[0].itemKeys.length, 3, 'the new entry has its keys');
      // an old partial result (the key of the whole list, items by place) is still read
      const wf2 = await makeWorkflow([node('l', 't.words', { items: 'a,b,c' }), node('m', 't.scene')], edges('l.items>m.in'));
      env.failOn.value = 'b';
      await run(wf2.id, { mode: 'all' });
      env.failOn.value = null;
      await wfStore.updateResults(wf2.id, (data) => {
        delete data.nodes.m.partial.itemKeys;
      });
      const planOld = await engine.plan(wf2.id, { mode: 'all' });
      assert.equal(planOld.nodes.m.reusedItems, 2);
      assert.equal(planOld.nodes.m.executions, 1);
      env.calls.length = 0;
      await run(wf2.id, { mode: 'all' });
      assert.deepEqual(ranItems('m'), ['b']);
    }

    /* ----- count is forced to 1 inside the key (a list run does not depend on the field) ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b' }), node('m', 't.scene', { count: 3 })], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      await setParams(wf.id, 'm', { count: 2 });
      env.calls.length = 0;
      const record = await run(wf.id, { mode: 'all' });
      assert.equal(record.status, 'completed');
      assert.equal(env.calls.length, 0, 'inside a map count is 1, so another count finds the same items');
    }

    /* ----- mode 'items' ----- */
    {
      reset();
      const wf = await makeWorkflow(
        [node('l', 't.words', { items: 'a,b,c,d' }), node('m', 't.scene'), node('f', 't.after')],
        edges('l.items>m.in', 'm.out>f.in')
      );
      await run(wf.id, { mode: 'all' });
      const before = await selectedList(wf.id, 'm');
      const fBefore = await selectedList(wf.id, 'f');
      env.calls.length = 0;

      const plan = await engine.plan(wf.id, { mode: 'items', nodeId: 'm', items: [3, 1, 1] });
      assert.equal(plan.mode, 'items');
      assert.deepEqual(plan.targets, ['m']);
      assert.equal(plan.nodes.m.status, 'forced');
      assert.equal(plan.nodes.m.executions, 2);
      assert.equal(plan.nodes.m.reusedItems, 2);
      assert.equal(plan.totals.usd, 1);
      assert.equal(plan.nodes.l.status, 'cached');
      assert.equal(plan.nodes.f, undefined, 'the followers are not part of the run');

      const events = [];
      const unsubscribe = bus.subscribe(wf.id, (event) => events.push(event));
      const record = await run(wf.id, { mode: 'items', nodeId: 'm', items: [3, 1, 1] });
      unsubscribe();
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.equal(record.mode, 'items');
      assert.deepEqual(record.targets, ['m']);
      assert.deepEqual(record.items, [1, 3]);
      assert.deepEqual(ranItems('m').sort(), ['b', 'd'], 'only the asked items run');
      assert.equal(usd(record), 1);
      assert.ok(events.some((event) => event.type === 'run_started' && event.mode === 'items'));
      const after = await selectedList(wf.id, 'm');
      assert.equal(after.length, 4);
      assert.equal(after[0], before[0]);
      assert.equal(after[2], before[2]);
      assert.notEqual(after[1], before[1], 'an asked item is a new result');
      assert.notEqual(after[3], before[3]);
      assert.equal(strip(after[1]), strip(before[1]), 'with the same inputs');
      const entries = (await results(wf.id, 'm')).history;
      assert.equal(entries.length, 2, 'the result is a new entry with the whole list');
      assert.equal(entries[0].variants[0].out.items.length, 4);
      assert.equal(entries[0].itemKeys.length, 4);
      assert.equal(entries[0].cost.usd, 1);

      // the next run of everything: the follower runs only for the two items that changed
      env.calls.length = 0;
      const next = await run(wf.id, { mode: 'all' });
      assert.equal(next.status, 'completed', JSON.stringify(next.nodes));
      assert.equal(next.nodes.m.status, 'cached');
      assert.equal(next.nodes.f.status, 'done');
      assert.equal(env.calls.filter((call) => call.node === 'm').length, 0);
      const fRan = env.calls.filter((call) => call.node === 'f');
      assert.deepEqual(fRan.map((call) => call.item).sort(), [1, 3], 'followers run for the affected items only');
      const fAfter = await selectedList(wf.id, 'f');
      assert.equal(fAfter[0], fBefore[0]);
      assert.equal(fAfter[2], fBefore[2]);
      assert.notEqual(fAfter[1], fBefore[1]);

      // errors: nothing starts, nothing is booked
      const runsBefore = (await wfStore.listRuns(wf.id)).length;
      const bad = async (request, reason) => {
        await assert.rejects(engine.start(wf.id, request), (err) => {
          assert.equal(err.code, 'INVALID_REQUEST', err.message);
          if (reason) assert.equal(err.reason, reason, err.message);
          return true;
        });
      };
      const badPlan = async (request) => assert.rejects(engine.plan(wf.id, request), { code: 'INVALID_REQUEST' });
      await badPlan({ mode: 'items', nodeId: 'm', items: [4] });
      await badPlan({ mode: 'items', nodeId: 'm', items: [] });
      await badPlan({ mode: 'items', nodeId: 'zzz', items: [0] });
      await bad({ mode: 'items', nodeId: 'm', items: [4] }, 'ITEMS_OUT_OF_RANGE');
      await bad({ mode: 'items', nodeId: 'm', items: [0, 99] }, 'ITEMS_OUT_OF_RANGE');
      await bad({ mode: 'items', nodeId: 'm', items: [-1] });
      await bad({ mode: 'items', nodeId: 'm', items: [1.5] });
      await bad({ mode: 'items', nodeId: 'm', items: ['1'] });
      await bad({ mode: 'items', nodeId: 'm', items: [] });
      await bad({ mode: 'items', nodeId: 'm' });
      await bad({ mode: 'items', nodeId: 'zzz', items: [0] });
      await bad({ mode: 'items', items: [0] });
      assert.equal((await wfStore.listRuns(wf.id)).length, runsBefore, 'a refused request leaves no run record');
      await assert.rejects(engine.start(wf.id, { mode: 'items', nodeId: 'm', items: Array.from({ length: 51 }, (_v, i) => i) }), { code: 'INVALID_REQUEST' });

      // a node that was never run has no list to take the other items from
      const fresh = await makeWorkflow([node('l', 't.words', { items: 'a,b' }), node('m', 't.scene')], edges('l.items>m.in'));
      await assert.rejects(engine.start(fresh.id, { mode: 'items', nodeId: 'm', items: [0] }), { code: 'INVALID_REQUEST', reason: 'ITEMS_NO_LIST' });
      // a node of another workflow is not known here
      await assert.rejects(engine.start(fresh.id, { mode: 'items', nodeId: 'f', items: [0] }), { code: 'INVALID_REQUEST', message: /unknown node f/ });

      // a list that got shorter since (an earlier node changed): the numbers fit the stored result, so the run starts, and the
      // node says so when its inputs are known; nothing of it is made
      await setParams(wf.id, 'l', { items: 'a,b' });
      env.calls.length = 0;
      const shorter = await run(wf.id, { mode: 'items', nodeId: 'm', items: [3] });
      assert.equal(shorter.status, 'failed');
      assert.equal(shorter.nodes.m.status, 'error');
      assert.equal(shorter.nodes.m.code, 'ITEMS_OUT_OF_RANGE');
      assert.match(shorter.nodes.m.message, /Item 4 does not exist: the list has 2 items/);
      assert.equal(ranItems('m').length, 0);
      assert.equal(usd(shorter), 0);
    }

    /* ----- a node that holds a list but does not run once per item cannot be asked for items ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      // `l` has a list result (from before the keys existed it would look the same) but it is no map: the plan says so, the start refuses
      const plan = await engine.plan(wf.id, { mode: 'items', nodeId: 'l', items: [0] });
      assert.equal(plan.nodes.l.status, 'invalid');
      assert.equal(plan.nodes.l.reasonCode, 'ITEMS_NO_LIST');
      assert.equal(plan.valid, true);
      await assert.rejects(engine.start(wf.id, { mode: 'items', nodeId: 'l', items: [0] }), { code: 'INVALID_REQUEST', reason: 'ITEMS_NO_LIST' });
    }

    /* ----- a finished paid node still tells what one execution costs (the scene table offers single items on it) ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b,c' }), node('m', 't.scene')], edges('l.items>m.in'));
      const before = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(before.nodes.m.itemEstimate, undefined, 'a node that has to run has its estimate, not an itemEstimate');
      await run(wf.id, { mode: 'all' });
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.m.status, 'cached');
      assert.equal(plan.nodes.m.estimate, null, 'nothing is estimated for a node that does not run');
      assert.deepEqual(plan.nodes.m.itemEstimate, { usd: 0.5 }, 'the price of one execution');
      assert.equal(plan.totals.usd, 0, 'it is not part of the total of the run');
      assert.equal(plan.totals.paidNodes, 0);
      assert.equal(plan.totals.unknownNodes, 0);
      // the plan of single items counts the asked ones only, with the same price
      const items = await engine.plan(wf.id, { mode: 'items', nodeId: 'm', items: [1] });
      assert.equal(items.totals.usd, 0.5);
      assert.deepEqual(items.nodes.m.estimate, { usd: 0.5 });
    }

    /* ----- the same item twice in a list: every one keeps its own result ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'x,x,x' }), node('m', 't.scene')], edges('l.items>m.in'));
      const first = await run(wf.id, { mode: 'all' });
      assert.equal(first.status, 'completed', JSON.stringify(first.nodes));
      assert.deepEqual(ranItems('m'), ['x', 'x', 'x'], 'three executions: the same prompt is asked for three variants');
      const before = await selectedList(wf.id, 'm');
      assert.equal(new Set(before).size, 3, 'three different results');
      // a new item at the end: the three x keep their own results, only y runs
      await setParams(wf.id, 'l', { items: 'x,x,x,y' });
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      const plan = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(plan.nodes.m.reusedItems, 3);
      assert.equal(plan.nodes.m.executions, 1);
      env.calls.length = 0;
      await run(wf.id, { mode: 'all' });
      assert.deepEqual(ranItems('m'), ['y']);
      const after = await selectedList(wf.id, 'm');
      assert.deepEqual(after.slice(0, 3), before, 'the three x are not replaced by copies of the first');
      // fewer of them: the first ones stay
      await setParams(wf.id, 'l', { items: 'x,x' });
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      env.calls.length = 0;
      await run(wf.id, { mode: 'all' });
      assert.equal(env.calls.length, 0, 'nothing runs for a shorter list');
      assert.deepEqual(await selectedList(wf.id, 'm'), before.slice(0, 2));
      // one more of them than stored: the extra one runs, the others keep their results
      await setParams(wf.id, 'l', { items: 'x,y,x,x,x' });
      await run(wf.id, { mode: 'node', nodeIds: ['l'], force: true });
      const planMore = await engine.plan(wf.id, { mode: 'all' });
      assert.equal(planMore.nodes.m.executions, 1, 'only the fourth x is new (y is in the history)');
      env.calls.length = 0;
      await run(wf.id, { mode: 'all' });
      assert.deepEqual(ranItems('m'), ['x']);
      const mixed = await selectedList(wf.id, 'm');
      assert.deepEqual([mixed[0], mixed[2], mixed[3]], [before[0], before[1], before[2]]);
      assert.equal(mixed[1], after[3], 'y comes from the history');
      assert.equal(new Set(mixed).size, 5);

      // a run of single items on repeated items: the asked one is made again, the others keep their own place
      reset();
      const wf2 = await makeWorkflow([node('l', 't.words', { items: 'x,x,x' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf2.id, { mode: 'all' });
      const old = await selectedList(wf2.id, 'm');
      env.calls.length = 0;
      const again = await run(wf2.id, { mode: 'items', nodeId: 'm', items: [1] });
      assert.equal(again.status, 'completed', JSON.stringify(again.nodes));
      assert.deepEqual(ranItems('m'), ['x']);
      const now = await selectedList(wf2.id, 'm');
      assert.equal(now[0], old[0]);
      assert.notEqual(now[1], old[1]);
      assert.equal(now[2], old[2], 'the third x is its own result, not a copy of the first');
    }

    /* ----- a failed run of single items: what it made and paid is not paid again by the same request ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b,c,d' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      const old = await selectedList(wf.id, 'm');
      env.calls.length = 0;
      env.failOn.value = 'd';
      const failed = await run(wf.id, { mode: 'items', nodeId: 'm', items: [1, 3] });
      assert.equal(failed.nodes.m.status, 'error');
      assert.deepEqual(ranItems('m'), ['b'], 'b was made, d failed');
      assert.equal(usd(failed), 0.5);
      const partial = (await results(wf.id, 'm')).partial;
      assert.deepEqual(partial.forcedItems, [1, 3], 'the partial results know which items were asked for');
      const paidB = partial.items[1].variant.out.value;
      assert.notEqual(paidB, old[1]);
      env.failOn.value = null;
      // the plan of the retry only counts d
      const plan = await engine.plan(wf.id, { mode: 'items', nodeId: 'm', items: [1, 3] });
      assert.equal(plan.nodes.m.executions, 1);
      assert.equal(plan.nodes.m.reusedItems, 3, 'a and c from the selected entry, b from the failed attempt');
      assert.equal(plan.totals.usd, 0.5);
      env.calls.length = 0;
      const retry = await run(wf.id, { mode: 'items', nodeId: 'm', items: [1, 3] });
      assert.equal(retry.status, 'completed', JSON.stringify(retry.nodes));
      assert.deepEqual(ranItems('m'), ['d'], 'only d is made and paid now');
      assert.equal(usd(retry), 0.5);
      const list = await selectedList(wf.id, 'm');
      assert.equal(list[1], paidB, 'the new b of the first attempt is the one in the result');
      assert.equal(list[0], old[0]);
      assert.equal(list[2], old[2]);
      assert.notEqual(list[3], old[3]);
      assert.equal((await results(wf.id, 'm')).partial, undefined);

      // a different request does not take it: a failed run of {1,3} is not the answer to a request for {1}
      env.failOn.value = 'd';
      await run(wf.id, { mode: 'items', nodeId: 'm', items: [1, 3] });
      env.failOn.value = null;
      env.calls.length = 0;
      const otherPlan = await engine.plan(wf.id, { mode: 'items', nodeId: 'm', items: [0] });
      assert.equal(otherPlan.nodes.m.executions, 1);
      // the partial of an ordinary forced run of the whole node is not taken for an asked item either
      await wfStore.updateResults(wf.id, (data) => {
        delete data.nodes.m.partial.forcedItems;
      });
      const noMark = await engine.plan(wf.id, { mode: 'items', nodeId: 'm', items: [1, 3] });
      assert.equal(noMark.nodes.m.executions, 2, 'without the mark of a run of single items the asked items are paid again');
    }

    /* ----- a selected entry from before the keys existed: single items are refused, not taken from another entry ----- */
    {
      reset();
      const wf = await makeWorkflow([node('l', 't.words', { items: 'a,b' }), node('m', 't.scene')], edges('l.items>m.in'));
      await run(wf.id, { mode: 'all' });
      await run(wf.id, { mode: 'node', nodeIds: ['m'], force: true });
      const entries = (await results(wf.id, 'm')).history;
      assert.equal(entries.length, 2);
      // the older entry has no keys and is the selected one; the newer one (not selected) has keys
      const older = entries[1];
      await wfStore.updateResults(wf.id, (data) => {
        const target = data.nodes.m.history.find((entry) => entry.id === older.id);
        delete target.itemKeys;
        data.nodes.m.selected = { entry: older.id, variant: 0 };
      });
      env.calls.length = 0;
      const plan = await engine.plan(wf.id, { mode: 'items', nodeId: 'm', items: [0] });
      assert.equal(plan.nodes.m.status, 'invalid');
      assert.equal(plan.nodes.m.reasonCode, 'ITEMS_NO_LIST');
      await assert.rejects(engine.start(wf.id, { mode: 'items', nodeId: 'm', items: [0] }), { code: 'INVALID_REQUEST', reason: 'ITEMS_NO_LIST' });
      assert.equal(env.calls.length, 0, 'nothing runs and nothing is paid');
    }

    /* ----- an optional input behind an output that stays empty works without it; a required one still refuses ----- */
    {
      reset();
      const wf = await makeWorkflow(
        [node('s', 't.switch', { on: false }), node('m', 't.single', { text: 'main' }), node('o', 't.optional_in'), node('r', 't.required_in')],
        edges('m.out>o.main', 's.out>o.extra', 's.out>o.more')
      );
      const plan = await engine.plan(wf.id, { mode: 'node', nodeIds: ['o'] });
      assert.equal(plan.valid, true, JSON.stringify(plan.issues));
      // an empty output of an ordinary node on an optional input is a possible mistake: one warning per connection, no error
      const warned = plan.issues.filter((issue) => issue.code === 'OUTPUT_EMPTY_OPTIONAL');
      assert.deepEqual(warned.map((issue) => [issue.nodeId, issue.port, issue.level, issue.data.input, issue.data.output]), [['o', 'extra', 'warning', 'extra', 'out'], ['o', 'more', 'warning', 'more', 'out']]);
      // switched off on purpose (def.emptyOutputsSwitched): no warning
      const quiet = await makeWorkflow(
        [node('s', 't.switch_on_purpose', { on: false }), node('m', 't.single', { text: 'main' }), node('o', 't.optional_in')],
        edges('m.out>o.main', 's.out>o.extra')
      );
      const quietPlan = await engine.plan(quiet.id, { mode: 'node', nodeIds: ['o'] });
      assert.equal(quietPlan.valid, true);
      assert.deepEqual(quietPlan.issues, [], 'no warning behind an output that was switched off on purpose');
      assert.equal((await run(quiet.id, { mode: 'node', nodeIds: ['o'] })).status, 'completed');
      const record = await run(wf.id, { mode: 'node', nodeIds: ['o'] });
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      const entry = (await results(wf.id, 'o')).history[0];
      assert.equal(entry.variants[0].out.value, 'main|no extra|no more', 'the node ran without the empty outputs');
      // switched on: the value arrives
      await setParams(wf.id, 's', { on: true });
      const filled = await run(wf.id, { mode: 'node', nodeIds: ['o'] });
      assert.equal(filled.status, 'completed');
      assert.equal((await results(wf.id, 'o')).history[0].variants[0].out.value, 'main|value|1');
      // a required input is still refused (announced by the plan, OUTPUT_EMPTY)
      await setParams(wf.id, 's', { on: false });
      const refused = await makeWorkflow([node('s', 't.switch', { on: false }), node('r', 't.required_in')], edges('s.out>r.main'));
      const refusedPlan = await engine.plan(refused.id, { mode: 'all' });
      assert.equal(refusedPlan.valid, false);
      assert.ok(refusedPlan.issues.some((issue) => issue.code === 'OUTPUT_EMPTY' && issue.nodeId === 'r'));
    }
  } finally {
    for (const id of created) await wfStore.deleteWorkflow(id).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
  console.log('test-nodes-engine-items.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
