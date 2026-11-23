'use strict';

const { emptyFallback } = require('./input-fallback');

// Edit service: changes the graph of a stored workflow without the node view (the agent access uses it). It follows the rules
// of the editor (public/nodes/graph.js checkConnection) and of the assistant (lib/nodes/assistant.js validateProposal): only node
// types the person may use and that are usable now, only params the type has, with values of the right kind, only connections
// between ports that exist and fit, no loop, a single input takes one connection. What is saved goes through the workflow store
// (saveGraph: the limits of a graph, the revision, the event for open editors). Nothing is run and nothing is charged.
//
//   catalog(viewer, { query, category, types, agent })   the node types the person can add: ports, and for `types` the params
//   describeGraph(workflow, { textChars })               nodes with params and ports, and the connections
//   edit(viewer, workflow, { rev, operations, agent, user })
//                                                        applies the operations in order, all or none; returns { rev, created, ... }
//
// Operations (`node` is the id of a node, or the `ref` of a node added earlier in the same call):
//   { op: 'add_node', type, ref?, params?, label?, x?, y? }
//   { op: 'remove_node', node }                          with its connections
//   { op: 'set_params', node, params }
//   { op: 'set_label', node, label }
//   { op: 'connect', from: { node, port }, to: { node, port }, replace? }   replace: a single input that is taken is rewired
//   { op: 'disconnect', edge } | { op: 'disconnect', from, to } | { op: 'disconnect', to }
//   { op: 'expose_input', node, param, label?, optional? }   the param becomes an input of the workflow (app inputs)
//   { op: 'unexpose_input', node, param }
//
// `agent: true` (the agent access): node types priced in credits (Higgsfield) are refused, as its runs are.
// Errors carry the code INVALID_EDIT (and `operation`, the number of the operation), RUN_ACTIVE or REV_CONFLICT.

const nodeRegistry = require('./registry');
const typesLib = require('./types');
const workflowsStore = require('./workflows-store');
const assetsLib = require('./assets');
const composerModel = require('../../public/nodes/composer-model');
const { isPlainObject } = typesLib;

const LIMITS = Object.freeze({
  operations: 60,
  textChars: 20000, // one text param
  colorChars: 32,
  optionChars: 200,
  tags: 50,
  tagChars: 100,
  labelChars: 120,
  catalogTypes: 300,
  detailTypes: 12,
  previewChars: 300
});
const REF_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const PORT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const NUMBER_KINDS = ['number', 'integer', 'slider'];
const TEXT_KINDS = ['text', 'textarea', 'code', 'color'];
const OPS = Object.freeze(['add_node', 'remove_node', 'set_params', 'set_label', 'connect', 'disconnect', 'expose_input', 'unexpose_input']);
// where new nodes land: a column to the right of what is there
const NEW_NODE_GAP = { x: 380, y: 260 };

function editError(message, extra = {}) {
  const err = new Error(message);
  err.code = 'INVALID_EDIT';
  Object.assign(err, extra);
  return err;
}

const chars = (value) => [...String(value)];
const clip = (value, max) => {
  const list = chars(value);
  return list.length > max ? `${list.slice(0, max).join('')}…` : String(value);
};

function staticOptions(param) {
  if (!Array.isArray(param.options)) return null;
  return param.options.map((option) => (option && typeof option === 'object' ? String(option.value) : String(option)));
}

function portBrief(port) {
  return {
    id: port.id,
    type: port.type,
    ...(port.required ? { required: true } : {}),
    ...(port.multiple ? { multiple: true } : {}),
    ...(port.multiple && Number.isFinite(port.max) ? { max: port.max } : {}),
    ...(port.param ? { or_param: port.param } : {})
  };
}

function paramBrief(param) {
  const options = param.kind === 'select' || (param.kind === 'integer' && Array.isArray(param.options)) ? staticOptions(param) : null;
  return {
    id: param.id,
    kind: param.kind,
    ...(typeof param.label === 'string' && param.label ? { label: param.label } : {}),
    ...(param.default !== undefined && param.default !== '' && !['asset', 'assets', 'marks', 'notes'].includes(param.kind) ? { default: param.default } : {}),
    ...(options ? { options: options.slice(0, 60) } : {}),
    ...(param.optionsSource ? { options_from: param.optionsSource } : {}),
    ...(Number.isFinite(param.min) ? { min: param.min } : {}),
    ...(Number.isFinite(param.max) ? { max: param.max } : {}),
    ...(param.optional ? { optional: true } : {}),
    ...(param.kind === 'composition' ? { format: composerModel.AGENT_FORMAT } : {}),
    ...(['asset', 'assets', 'marks', 'notes'].includes(param.kind) ? { settable: false } : {})
  };
}

function createEditService({ store = workflowsStore.defaultStore, registry = nodeRegistry.registry, engine = null } = {}) {
  const usableFor = (def, viewer, agent) => Boolean(def) && !nodeRegistry.blockedFor(def, viewer) && !(agent && nodeRegistry.isRestricted(def));

  const portsOf = (node) => {
    const def = registry.get(node.type);
    if (!def) return null;
    const params = registry.normalizeParams(def, node.params);
    return { def, params, ...registry.portsFor(def, params) };
  };
  const labelOf = (node, def) => String(node.params?.label || node.title || (def && def.label) || node.id).trim();

  /* ----- catalogue ----- */

  function catalog(viewer, { query, category, types, agent = false } = {}) {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const wanted = Array.isArray(types) && types.length ? new Set(types.slice(0, LIMITS.detailTypes).map(String)) : null;
    const out = [];
    let total = 0;
    for (const def of registry.list()) {
      if (!usableFor(def, viewer, agent)) continue;
      if (wanted && !wanted.has(def.type)) continue;
      if (category && def.category !== category) continue;
      if (needle && !`${def.type}\n${def.label}\n${def.keywords.join(' ')}\n${def.description || ''}`.toLowerCase().includes(needle)) continue;
      total += 1;
      if (out.length >= LIMITS.catalogTypes) continue;
      const available = registry.availability(def);
      const entry = {
        type: def.type,
        label: def.label,
        category: def.category,
        ...(def.description ? { description: clip(def.description, wanted ? 600 : 160) } : {}),
        paid: def.paid,
        ...(available === true ? {} : { available: false, reason: clip(available, 200) }),
        inputs: def.inputs.filter((port) => !port.hidden).map(portBrief),
        outputs: def.outputs.filter((port) => !port.hidden).map(portBrief)
      };
      if (wanted) {
        entry.params = def.params.map(paramBrief);
        if (def.portVariants) {
          entry.ports_depend_on = {
            param: def.portVariants.param,
            values: Object.fromEntries(
              Object.entries(def.portVariants.values).map(([value, variant]) => [
                value,
                { ...(variant.inputs ? { inputs: variant.inputs.map(portBrief) } : {}), ...(variant.outputs ? { outputs: variant.outputs.map(portBrief) } : {}) }
              ])
            )
          };
        }
      }
      out.push(entry);
    }
    return { nodeTypes: out, total, ...(wanted ? { unknown: [...wanted].filter((type) => !out.some((entry) => entry.type === type)) } : {}) };
  }

  /* ----- the graph as data ----- */

  function shownParam(param, value, textChars) {
    if (param.kind === 'asset') return assetsLib.assetRefFromParam(value, 'x') ? { file: value.assetId, type: value.type || null } : null;
    if (param.kind === 'assets') return (Array.isArray(value) ? value : []).filter((entry) => assetsLib.assetRefFromParam(entry, 'x')).map((entry) => ({ file: entry.assetId, type: entry.type || null }));
    if (param.kind === 'marks' || param.kind === 'notes') return undefined;
    if (TEXT_KINDS.includes(param.kind)) return clip(value ?? '', textChars);
    return value;
  }

  function describeGraph(workflow, { textChars } = {}) {
    const max = Number.isInteger(textChars) && textChars > 0 ? Math.min(textChars, LIMITS.textChars) : LIMITS.previewChars;
    const graph = workflow.graph;
    const exposed = new Set((Array.isArray(workflow.app?.inputs) ? workflow.app.inputs : []).map((entry) => `${entry?.node}.${entry?.param}`));
    const nodes = graph.nodes.map((node) => {
      const info = portsOf(node);
      if (!info) return { id: node.id, type: node.type, label: clip(labelOf(node, null), LIMITS.labelChars), unknown_type: true };
      const params = {};
      for (const param of info.def.params) {
        const value = shownParam(param, info.params[param.id], max);
        if (value !== undefined) params[param.id] = value;
      }
      return {
        id: node.id,
        type: node.type,
        label: clip(labelOf(node, info.def), LIMITS.labelChars),
        params,
        ...(info.def.params.some((param) => exposed.has(`${node.id}.${param.id}`)) ? { workflow_inputs: info.def.params.filter((param) => exposed.has(`${node.id}.${param.id}`)).map((param) => param.id) } : {}),
        inputs: info.inputs.filter((port) => !port.hidden).map((port) => ({
          ...portBrief(port),
          from: graph.edges.filter((edge) => edge.to.node === node.id && edge.to.port === port.id).map((edge) => `${edge.from.node}.${edge.from.port}`)
        })),
        outputs: info.outputs.filter((port) => !port.hidden).map(portBrief)
      };
    });
    const edges = graph.edges.map((edge) => ({ id: edge.id, from: `${edge.from.node}.${edge.from.port}`, to: `${edge.to.node}.${edge.to.port}` }));
    return { nodes, edges };
  }

  /* ----- params ----- */

  // The value of one param as it is stored, or an INVALID_EDIT error that says what is expected.
  function cleanParam(def, param, value, fail, notes) {
    const name = `param "${param.id}" of ${def.type}`;
    if (['asset', 'assets'].includes(param.kind)) {
      fail(`${name} holds files and cannot be set here. Make it an input of the workflow (expose_input) and give the file in "inputs" of run_workflow (asset_id from upload_asset).`);
    }
    if (['marks', 'notes'].includes(param.kind)) fail(`${name} cannot be set through this tool.`);
    if (NUMBER_KINDS.includes(param.kind)) {
      if (value === null && param.optional) return null;
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof number !== 'number' || !Number.isFinite(number)) fail(`${name} must be a number.`);
      if (param.kind === 'integer' && !Number.isInteger(number)) fail(`${name} must be a whole number.`);
      if ((Number.isFinite(param.min) && number < param.min) || (Number.isFinite(param.max) && number > param.max)) {
        fail(`${name} must be between ${Number.isFinite(param.min) ? param.min : '-∞'} and ${Number.isFinite(param.max) ? param.max : '∞'}.`);
      }
      return number;
    }
    if (param.kind === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      fail(`${name} must be true or false.`);
    }
    if (TEXT_KINDS.includes(param.kind)) {
      if (typeof value !== 'string' && typeof value !== 'number') fail(`${name} must be a text.`);
      const max = param.kind === 'color' ? LIMITS.colorChars : LIMITS.textChars;
      if (chars(value).length > max) fail(`${name} takes at most ${max} characters.`);
      return String(value);
    }
    if (param.kind === 'select') {
      if (typeof value !== 'string' && typeof value !== 'number') fail(`${name} must be one of its options.`);
      const chosen = String(value);
      if (chosen === '') return '';
      if (chars(chosen).length > LIMITS.optionChars) fail(`${name}: the option is too long.`);
      if (param.optionsSource) {
        notes.push(`${name}: the option "${clip(chosen, 60)}" comes from a list of the app (${param.optionsSource}) and was not checked; a value that is not offered fails when the workflow runs.`);
        return chosen;
      }
      const options = staticOptions(param);
      const hidden = Array.isArray(param.hiddenOptions) ? param.hiddenOptions : [];
      if (options && !options.includes(chosen) && !hidden.includes(chosen)) fail(`${name} has no option "${clip(chosen, 60)}". Options: ${options.slice(0, 40).join(', ')}.`);
      return chosen;
    }
    if (param.kind === 'composition') {
      // the layers of the Composer (see AGENT_FORMAT): a layer that cannot be one is refused, a value out of range is said and kept in range
      const problems = [];
      const clean = composerModel.normalizeComposition(value, problems);
      const refused = problems.filter((text) => /not an object|unknown type|not JSON|must be a list/.test(text));
      if (refused.length) fail(`${name}: ${refused.slice(0, 3).join('; ')}. ${composerModel.AGENT_FORMAT}`);
      for (const text of problems.slice(0, 5)) notes.push(`${name}: ${text}`);
      return clean;
    }
    if (param.kind === 'tags') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(`${name} must be a list of words.`);
      if (value.length > LIMITS.tags) fail(`${name} takes at most ${LIMITS.tags} words.`);
      return value.map((item) => clip(item.trim(), LIMITS.tagChars)).filter(Boolean);
    }
    return fail(`${name} cannot be set through this tool.`);
  }

  function cleanParams(def, raw, fail, notes) {
    if (raw === undefined || raw === null) return {};
    if (!isPlainObject(raw)) fail('"params" must be an object');
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const param = def.params.find((item) => item.id === key);
      if (!param) fail(`${def.type} has no param "${clip(key, 40)}". Params: ${def.params.map((item) => item.id).join(', ') || 'none'}.`);
      out[key] = cleanParam(def, param, value, fail, notes);
    }
    return out;
  }

  /* ----- edit ----- */

  async function edit(viewer, workflow, { rev, operations, agent = false, user = 'lokal' } = {}) {
    if (!Array.isArray(operations) || !operations.length) throw editError('"operations" must be a list with at least one operation');
    if (operations.length > LIMITS.operations) throw editError(`at most ${LIMITS.operations} operations in one call`);
    if (rev !== undefined && rev !== null && rev !== workflow.rev) {
      const err = new Error('Workflow was changed elsewhere');
      err.code = 'REV_CONFLICT';
      err.rev = workflow.rev;
      throw err;
    }
    const active = engine && (engine.activeRun(workflow.id) || engine.isBusy?.(workflow.id));
    if (active) {
      const err = new Error('A run is active for this workflow; wait for it or cancel it first');
      err.code = 'RUN_ACTIVE';
      err.runId = active.runId || null;
      throw err;
    }

    let nodes = workflow.graph.nodes.map((node) => ({ ...node, params: { ...(isPlainObject(node.params) ? node.params : {}) } }));
    let edges = workflow.graph.edges.map((edge) => ({ ...edge, from: { ...edge.from }, to: { ...edge.to } }));
    let appInputs = (Array.isArray(workflow.app?.inputs) ? workflow.app.inputs : []).map((entry) => ({ ...entry }));
    let appChanged = false;
    const refs = new Map(); // ref -> node id
    const touched = new Set();
    const created = {};
    const removedNodes = [];
    const removedEdges = [];
    const addedEdges = [];
    const notes = [];
    const ids = new Set([...nodes.map((node) => node.id), ...edges.map((edge) => edge.id), ...(workflow.graph.groups || []).map((item) => item.id), ...(workflow.graph.notes || []).map((item) => item.id)]);
    const freshId = (prefix) => {
      for (let index = 1; ; index += 1) {
        const id = `${prefix}${index}`;
        if (!ids.has(id)) {
          ids.add(id);
          return id;
        }
      }
    };
    const right = nodes.length ? Math.max(...nodes.map((node) => Number(node.x) || 0)) + NEW_NODE_GAP.x : 0;
    const top = nodes.length ? Math.min(...nodes.map((node) => Number(node.y) || 0)) : 0;
    let placed = 0;

    operations.forEach((operation, index) => {
      const number = index + 1;
      const kind = isPlainObject(operation) ? operation.op : undefined;
      const fail = (message) => {
        throw editError(`Operation ${number}${typeof kind === 'string' ? ` (${clip(kind, 20)})` : ''}: ${message}`, { operation: number });
      };
      if (!isPlainObject(operation)) fail('must be an object with "op"');
      if (!OPS.includes(kind)) fail(`unknown "op". Use one of: ${OPS.join(', ')}.`);
      const findNode = (value, what = '"node"') => {
        if (typeof value !== 'string' || !value) fail(`${what} must be the id of a node (or the ref of a node added in this call)`);
        const id = refs.get(value) || value;
        const found = nodes.find((node) => node.id === id);
        if (!found) fail(`there is no node ${JSON.stringify(clip(value, 40))} in this workflow. Nodes: ${nodes.slice(0, 60).map((node) => node.id).join(', ') || 'none'}.`);
        return found;
      };
      const endpoint = (value, direction) => {
        if (!isPlainObject(value)) fail(`"${direction}" must be an object like {"node": "n1", "port": "text"}`);
        const node = findNode(value.node, `"${direction}.node"`);
        if (typeof value.port !== 'string' || !PORT_PATTERN.test(value.port)) fail(`"${direction}.port" must be the id of a port`);
        const info = portsOf(node);
        if (!info) fail(`node ${node.id} has a type this server does not know (${node.type})`);
        const ports = (direction === 'from' ? info.outputs : info.inputs).filter((port) => !port.hidden);
        const port = ports.find((item) => item.id === value.port);
        if (!port) fail(`node ${node.id} (${node.type}) has no ${direction === 'from' ? 'output' : 'input'} "${value.port}" (it has: ${ports.map((item) => `${item.id}:${item.type}`).join(', ') || 'none'})`);
        return { node, info, port };
      };

      if (kind === 'add_node') {
        if (typeof operation.type !== 'string' || !operation.type) fail('"type" is missing');
        const def = registry.get(operation.type);
        if (!def) fail(`the node type "${clip(operation.type, 60)}" does not exist. Call list_node_types.`);
        if (!usableFor(def, viewer, agent)) fail(`the node type "${def.type}" is not available for this account${agent && nodeRegistry.isRestricted(def) ? ' through agent access' : ''}.`);
        const available = registry.availability(def);
        if (available !== true) fail(`the node type "${def.type}" cannot be used right now (${clip(available, 200)}).`);
        if (nodes.length >= workflowsStore.LIMITS.maxNodes) fail(`a workflow has at most ${workflowsStore.LIMITS.maxNodes} nodes`);
        if (operation.ref !== undefined && operation.ref !== null) {
          if (typeof operation.ref !== 'string' || !REF_PATTERN.test(operation.ref)) fail('"ref" must be 1 to 32 letters, digits, _ or -');
          if (refs.has(operation.ref) || ids.has(operation.ref)) fail(`the ref "${operation.ref}" is already used (as a ref or as an id in this workflow)`);
        }
        const params = { ...registry.initialParams(def), ...cleanParams(def, operation.params, fail, notes) };
        const id = freshId('n');
        const hasSpot = Number.isFinite(operation.x) && Number.isFinite(operation.y);
        const node = { id, type: def.type, typeVersion: def.version || 1, x: hasSpot ? operation.x : right, y: hasSpot ? operation.y : top + placed * NEW_NODE_GAP.y, params };
        if (!hasSpot) placed += 1;
        if (operation.label !== undefined && operation.label !== null) {
          if (typeof operation.label !== 'string') fail('"label" must be a text');
          const title = clip(operation.label.trim(), LIMITS.labelChars);
          if (title) node.title = title;
        }
        nodes = [...nodes, node];
        if (operation.ref) refs.set(operation.ref, id);
        created[operation.ref || id] = id;
        touched.add(id);
        return;
      }

      if (kind === 'remove_node') {
        const node = findNode(operation.node);
        nodes = nodes.filter((item) => item.id !== node.id);
        for (const edge of edges.filter((item) => item.from.node === node.id || item.to.node === node.id)) {
          removedEdges.push(edge.id);
          touched.add(edge.from.node);
          touched.add(edge.to.node);
        }
        edges = edges.filter((item) => item.from.node !== node.id && item.to.node !== node.id);
        if (appInputs.some((entry) => entry.node === node.id)) notes.push(`node ${node.id} held inputs of the workflow; they are gone with it.`);
        appInputs = appInputs.filter((entry) => entry.node !== node.id);
        removedNodes.push(node.id);
        touched.delete(node.id);
        return;
      }

      if (kind === 'set_params') {
        const node = findNode(operation.node);
        const def = registry.get(node.type);
        if (!def) fail(`node ${node.id} has a type this server does not know (${node.type})`);
        if (!isPlainObject(operation.params) || !Object.keys(operation.params).length) fail('"params" must be an object with at least one param');
        const patch = cleanParams(def, operation.params, fail, notes);
        nodes = nodes.map((item) => (item.id === node.id ? { ...item, params: { ...item.params, ...patch } } : item));
        touched.add(node.id);
        return;
      }

      if (kind === 'set_label') {
        const node = findNode(operation.node);
        if (typeof operation.label !== 'string') fail('"label" must be a text (an empty text removes the label)');
        const title = clip(operation.label.trim(), LIMITS.labelChars);
        nodes = nodes.map((item) => {
          if (item.id !== node.id) return item;
          const next = { ...item };
          if (title) next.title = title;
          else delete next.title;
          return next;
        });
        return;
      }

      if (kind === 'connect') {
        const from = endpoint(operation.from, 'from');
        const to = endpoint(operation.to, 'to');
        if (from.node.id === to.node.id) fail('a node cannot be connected to itself');
        if (!typesLib.canConnect(from.port.type, to.port.type)) {
          fail(`output "${from.port.id}" of ${from.node.id} (${from.port.type}) does not fit input "${to.port.id}" of ${to.node.id} (${to.port.type})`);
        }
        let empty = [];
        try {
          empty = typeof from.info.def.emptyOutputs === 'function' ? from.info.def.emptyOutputs(from.info.params) || [] : [];
        } catch (_) {
          empty = [];
        }
        if (empty.includes(from.port.id) && to.port.required && emptyFallback(to.port, to.info.params) === undefined) fail(`node ${from.node.id} produces no "${from.port.id}" with its options`);
        if (edges.some((edge) => edge.from.node === from.node.id && edge.from.port === from.port.id && edge.to.node === to.node.id && edge.to.port === to.port.id)) {
          fail('this connection exists already');
        }
        const incoming = edges.filter((edge) => edge.to.node === to.node.id && edge.to.port === to.port.id);
        if (!to.port.multiple && incoming.length) {
          if (operation.replace !== true) {
            fail(`input "${to.port.id}" of ${to.node.id} takes one connection and is connected to ${incoming.map((edge) => `${edge.from.node}.${edge.from.port}`).join(', ')}. Give "replace": true to rewire it, or disconnect it first.`);
          }
          for (const edge of incoming) {
            removedEdges.push(edge.id);
            touched.add(edge.from.node);
          }
          edges = edges.filter((edge) => !incoming.includes(edge));
        } else if (to.port.multiple && Number.isFinite(to.port.max) && incoming.length >= to.port.max) {
          fail(`input "${to.port.id}" of ${to.node.id} takes at most ${to.port.max} connections and is full`);
        }
        // a loop: the target already leads to the source
        const next = new Map();
        for (const edge of edges) {
          if (!next.has(edge.from.node)) next.set(edge.from.node, []);
          next.get(edge.from.node).push(edge.to.node);
        }
        const seen = new Set([to.node.id]);
        const queue = [to.node.id];
        while (queue.length) {
          for (const follower of next.get(queue.shift()) || []) {
            if (follower === from.node.id) fail('this connection would close a loop (a node would depend on its own result)');
            if (!seen.has(follower)) {
              seen.add(follower);
              queue.push(follower);
            }
          }
        }
        if (edges.length >= workflowsStore.LIMITS.maxEdges) fail(`a workflow has at most ${workflowsStore.LIMITS.maxEdges} connections`);
        const edge = { id: freshId('e'), from: { node: from.node.id, port: from.port.id }, to: { node: to.node.id, port: to.port.id } };
        edges = [...edges, edge];
        addedEdges.push(edge.id);
        touched.add(from.node.id);
        touched.add(to.node.id);
        return;
      }

      if (kind === 'disconnect') {
        const side = (value, direction) => {
          if (!isPlainObject(value)) fail(`"${direction}" must be an object like {"node": "n1", "port": "text"}`);
          const node = findNode(value.node, `"${direction}.node"`);
          if (typeof value.port !== 'string' || !PORT_PATTERN.test(value.port)) fail(`"${direction}.port" must be the id of a port`);
          return { node: node.id, port: value.port };
        };
        let gone;
        if (operation.edge !== undefined && operation.edge !== null) {
          gone = edges.filter((edge) => edge.id === operation.edge);
          if (!gone.length) fail(`there is no connection with the id ${JSON.stringify(clip(String(operation.edge), 40))}`);
        } else {
          const from = operation.from !== undefined && operation.from !== null ? side(operation.from, 'from') : null;
          const to = operation.to !== undefined && operation.to !== null ? side(operation.to, 'to') : null;
          if (!from && !to) fail('give "edge" (the id of a connection), or "from" and "to", or "to" alone (everything into that input)');
          gone = edges.filter((edge) => (!from || (edge.from.node === from.node && edge.from.port === from.port)) && (!to || (edge.to.node === to.node && edge.to.port === to.port)));
          if (!gone.length) fail('there is no such connection');
        }
        for (const edge of gone) {
          removedEdges.push(edge.id);
          touched.add(edge.from.node);
          touched.add(edge.to.node);
        }
        edges = edges.filter((edge) => !gone.includes(edge));
        return;
      }

      // expose_input, unexpose_input
      const node = findNode(operation.node);
      const def = registry.get(node.type);
      if (!def) fail(`node ${node.id} has a type this server does not know (${node.type})`);
      const param = def.params.find((item) => item.id === operation.param);
      if (!param) fail(`${def.type} has no param ${JSON.stringify(clip(String(operation.param), 40))}. Params: ${def.params.map((item) => item.id).join(', ') || 'none'}.`);
      const has = appInputs.some((entry) => entry.node === node.id && entry.param === param.id);
      if (kind === 'unexpose_input') {
        if (!has) fail(`${node.id}.${param.id} is not an input of the workflow`);
        appInputs = appInputs.filter((entry) => !(entry.node === node.id && entry.param === param.id));
        appChanged = true;
        return;
      }
      if (['marks', 'notes', 'composition'].includes(param.kind)) fail(`param "${param.id}" cannot be an input of the workflow`);
      if (operation.label !== undefined && operation.label !== null && typeof operation.label !== 'string') fail('"label" must be a text');
      if (appInputs.length >= 100 && !has) fail('a workflow has at most 100 inputs');
      const entry = { node: node.id, param: param.id, label: clip(String(operation.label || '').trim(), LIMITS.labelChars), ...(operation.optional === true ? { optional: true } : {}) };
      // a workflow without app inputs takes its input nodes as inputs; they are kept when the first one is added by hand
      if (!appInputs.length) {
        const { inputDescriptors } = require('./run-service');
        appInputs = inputDescriptors({ nodes, edges }, null, registry)
          .filter((descriptor) => !(descriptor.node === node.id && descriptor.param === param.id))
          .map((descriptor) => ({ node: descriptor.node, param: descriptor.param, label: descriptor.label }));
      }
      appInputs = has ? appInputs.map((item) => (item.node === node.id && item.param === param.id ? { ...item, ...entry } : item)) : [...appInputs, entry];
      appChanged = true;
    });

    // what a change of params did to the ports: every connection of a changed node must still fit
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const info = new Map();
    const infoOf = (id) => {
      if (!info.has(id)) info.set(id, portsOf(byId.get(id)));
      return info.get(id);
    };
    const single = new Map();
    for (const edge of edges) {
      if (!touched.has(edge.from.node) && !touched.has(edge.to.node)) continue;
      const from = infoOf(edge.from.node);
      const to = infoOf(edge.to.node);
      if (!from || !to) continue; // a node of a type this server does not know keeps its connections
      const out = from.outputs.find((port) => port.id === edge.from.port && !port.hidden);
      const into = to.inputs.find((port) => port.id === edge.to.port && !port.hidden);
      const where = `the connection ${edge.id} (${edge.from.node}.${edge.from.port} to ${edge.to.node}.${edge.to.port})`;
      if (!out || !into) throw editError(`After these changes ${where} would end at a port that does not exist any more. Disconnect it in the same call.`, { edge: edge.id });
      if (!typesLib.canConnect(out.type, into.type)) throw editError(`After these changes ${where} would not fit any more (${out.type} into ${into.type}). Disconnect it in the same call.`, { edge: edge.id });
      if (!into.multiple) {
        const key = `${edge.to.node}.${edge.to.port}`;
        if (single.has(key)) throw editError(`After these changes input "${edge.to.port}" of ${edge.to.node} would have two connections but takes one.`, { edge: edge.id });
        single.set(key, edge.id);
      }
    }

    const graph = { ...workflow.graph, nodes, edges };
    const saved = await store.saveGraph(workflow.id, {
      baseRev: workflow.rev,
      graph,
      assertWritable: () => {
        if (engine && (engine.activeRun(workflow.id) || engine.isBusy?.(workflow.id))) {
          const err = new Error('A run is active for this workflow.');
          err.code = 'RUN_ACTIVE';
          throw err;
        }
      },
      ...(appChanged ? { app: { ...(isPlainObject(workflow.app) ? workflow.app : {}), inputs: appInputs } } : {}),
      user
    });
    return {
      workflowId: workflow.id,
      rev: saved.rev,
      changed: saved.rev !== workflow.rev,
      created,
      removedNodes,
      removedEdges: [...new Set(removedEdges)],
      addedEdges,
      notes: [...new Set(notes)].slice(0, 20)
    };
  }

  return { catalog, describeGraph, edit, limits: LIMITS };
}

module.exports = { LIMITS, OPS, createEditService };
