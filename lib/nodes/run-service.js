'use strict';

// Run service (WP26): the one place outside the node view that prepares and starts workflow runs. It does not depend
// on the chat: the Director tools use it, and so can any other access (a tool server). It contains no run logic of its
// own: plans, limits, budget and jobs come from the engine (lib/nodes/engine.js), workflows and sharing from the
// workflow store, templates from lib/nodes/templates.js, the rules of access from lib/access.js.
//
//   listRunnable(viewer, { query, lang, limit })        templates and the workflows the person may start
//   prepare(viewer, { templateId | workflowId, inputs, sourceSessionId, name, lang, requireStartable })
//                                                       a workflow ready to run (new from a template, or an existing
//                                                       one) with the inputs set; media come from sourceSessionId only.
//                                                       requireStartable: also returns the plan, and a workflow that cannot
//                                                       start (invalid, a step unavailable, a role rule) is refused and
//                                                       a workflow created for it removed again
//   estimate(viewer, workflowId)                        the plan: steps, paid steps, total, budget, what blocks a start
//   describeWorkflow(viewer, workflowId, { textChars }) one workflow the person may start: nodes, inputs, outputs, the
//                                                       cost and the results it holds now (read only; nothing is planned)
//   start(viewer, workflowId, { maxUsd, maxCredits, maxUnknownNodes, rev, requireFree })
//                                                       plan and budget are checked again; returns { runId }. A paid run
//                                                       starts only within the amounts the person accepted (dollars, credits
//                                                       and paid steps without a price; nothing given means 0). requireFree:
//                                                       the start without a click: a run that has paid steps by now is refused
//                                                       with COST_CHANGED, whatever amounts were given
//   discardPrepared(viewer, prepared)                   removes a workflow prepare created for a run that did not come about
//   findRun(viewer, workflowId, { since })              the run of a workflow that is active or started since a time
//   status(viewer, runId, { workflowId, textChars })    progress, cost and (when finished) the outputs
//   waitForRun(viewer, runId, { workflowId })           resolves with the status once the run has finished
//   cancel(viewer, runId, { workflowId })
//
// `viewer` is what lib/access.js viewerOf() returns (or viewerForUser(user) for callers that only know the address).
// Errors carry a `code` (and details as properties): the codes of the node view routes (WORKFLOW_NOT_FOUND, RUN_NOT_FOUND,
// FORBIDDEN_FOR_ROLE, BUDGET_EXHAUSTED, BUDGET_INSUFFICIENT, RUN_ACTIVE, INVALID_GRAPH, ...) and the new ones
// INVALID_INPUT, MISSING_INPUT, NODE_UNAVAILABLE, CONFIRMATION_REQUIRED and COST_CHANGED.

const sessionStore = require('../store');
const access = require('../access');
const teamGroups = require('../team-groups');
const nodeRegistry = require('./registry');
const assetsLib = require('./assets');
const templatesLib = require('./templates');
const workflowsStore = require('./workflows-store');
const { isPlainObject } = require('./types');

const LIMITS = Object.freeze({
  defaultList: 50,
  maxList: 100,
  maxTextChars: 20000, // one text input
  maxMediaFiles: 50, // files one prepare brings into the workflow (the size of a media list)
  maxTags: 50,
  previewChars: 400, // text shown for an input or an output
  maxIssues: 20
});

// The input nodes and the param a person fills in when a workflow has no app section (derived inputs).
const DERIVED_PARAM = Object.freeze({
  'input.prompt': 'prompt',
  'input.text': 'text',
  'input.number': 'value',
  'input.text_list': 'text',
  'input.image': 'asset',
  'input.video': 'asset',
  'input.audio': 'asset',
  'input.document': 'assets',
  'input.media_list': 'assets'
});
const MEDIA_KINDS = Object.freeze(['image', 'video', 'audio', 'document']);
const TERMINAL_NODE_STATES = new Set(['done', 'cached', 'error', 'skipped', 'cancelled']);
const REMEMBERED_RUNS = 200;
const COST_EPSILON = 1e-6;
// Blockers the engine decides itself at the start (an active run, the budget with its reservation).
const BENIGN_BLOCKERS = new Set(['RUN_ACTIVE', 'BUDGET_EXHAUSTED', 'BUDGET_INSUFFICIENT']);

function serviceError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const notFound = () => serviceError('WORKFLOW_NOT_FOUND', 'Workflow not found');

function roleRestricted() {
  return new access.RoleRestrictedError(
    'higgsfield',
    'This workflow contains Higgsfield nodes, which are not available for your account',
    'Dieser Workflow enthält Higgsfield-Nodes, die für dein Konto nicht verfügbar sind.'
  );
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function cleanText(value, max) {
  return [...String(value)].slice(0, max).join('');
}

function preview(text, max = LIMITS.previewChars) {
  const chars = [...String(text)];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : String(text);
}

// The address the engine and the budget know the person by (the run user of the routes).
function userOf(viewer) {
  return viewer.active && viewer.email ? viewer.email : 'lokal';
}

// For callers that have the address only (the Director gets `user` from the request): the viewer of lib/access.js.
function viewerForUser(user) {
  return access.viewerOf({ kubleUser: user });
}

function assertViewer(viewer) {
  if (!viewer || typeof viewer !== 'object' || typeof viewer.active !== 'boolean') {
    throw new TypeError('run service: viewer must come from lib/access.js viewerOf');
  }
  // while a restriction is active an anonymous caller may be a participant whose login is not confirmed
  if (access.isUnconfirmed(viewer)) throw new access.LoginUnconfirmedError();
}

// May the person start this workflow? The rules of use (owner, sharing, teams), without the free pass of admins: the
// Director starts the workflows of the person and what is shared with them, not everything an admin could open.
function canRun(entry, viewer) {
  if (!viewer.active) return true;
  return access.canUse(entry, viewer.admin ? { ...viewer, admin: false, superadmin: false } : viewer);
}

/* ---------- inputs and outputs of a graph ---------- */

function nodeLabel(node, registry) {
  const def = registry.get(node.type);
  return String(node.params?.label || node.title || (def && def.label) || node.id).trim();
}

function paramHasValue(param, value) {
  if (param.kind === 'asset') return Boolean(assetsLib.assetRefFromParam(value, 'x'));
  if (param.kind === 'assets') return Array.isArray(value) && value.some((entry) => assetsLib.assetRefFromParam(entry, 'x'));
  if (['text', 'textarea', 'code', 'color'].includes(param.kind)) return typeof value === 'string' && value.trim() !== '';
  return value !== null && value !== undefined;
}

function staticOptions(param) {
  if (!Array.isArray(param.options)) return null;
  return param.options.map((option) => (option && typeof option === 'object' ? { value: option.value, label: option.label ?? String(option.value) } : { value: option, label: String(option) }));
}

// The fields a person (or a model) fills in: the app inputs of the graph, else the input nodes in canvas order.
// [{ id: '<node>.<param>', node, param, label, type, list, required, hasValue, ... }]; the underscore fields are internal.
function inputDescriptors(graph, app, registry) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let entries = (Array.isArray(app?.inputs) ? app.inputs : []).filter((entry) => isPlainObject(entry) && typeof entry.node === 'string' && typeof entry.param === 'string');
  let derived = false;
  if (!entries.length) {
    derived = true;
    entries = nodes
      .filter((node) => DERIVED_PARAM[node.type])
      .slice()
      .sort((a, b) => (a.y - b.y) || (a.x - b.x) || String(a.id).localeCompare(String(b.id)))
      .map((node) => ({ node: node.id, param: DERIVED_PARAM[node.type], label: '' }));
  }
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const node = byId.get(entry.node);
    const def = node ? registry.get(node.type) : null;
    const param = def ? def.params.find((item) => item.id === entry.param) : null;
    if (!node || !param || seen.has(`${node.id}.${param.id}`)) continue;
    seen.add(`${node.id}.${param.id}`);
    const current = registry.normalizeParams(def, node.params)[param.id];
    const hasValue = paramHasValue(param, current);
    const label = cleanText(entry.label || node.title || (derived ? def.label : param.label) || param.id, 120);
    const base = { id: `${node.id}.${param.id}`, node: node.id, param: param.id, label, list: false, hasValue, derived, _paramKind: param.kind };
    if (param.kind === 'asset' || param.kind === 'assets') {
      const kind = param.accept === 'kind' ? (MEDIA_KINDS.includes(node.params?.kind) ? node.params.kind : 'image') : param.accept;
      out.push({ ...base, type: MEDIA_KINDS.includes(kind) ? kind : 'image', list: param.kind === 'assets', required: !hasValue, _media: true, _max: param.max });
    } else if (['number', 'integer', 'slider'].includes(param.kind)) {
      out.push({ ...base, type: 'number', required: false, integer: param.kind === 'integer', ...(Number.isFinite(param.min) ? { min: param.min } : {}), ...(Number.isFinite(param.max) ? { max: param.max } : {}) });
    } else if (param.kind === 'boolean') {
      out.push({ ...base, type: 'boolean', required: false });
    } else if (param.kind === 'select') {
      const options = staticOptions(param);
      out.push({ ...base, type: 'select', required: false, ...(options ? { options: options.map((option) => option.value) } : {}) });
    } else if (param.kind === 'tags') {
      out.push({ ...base, type: 'tags', required: false });
    } else {
      // text, textarea, code, color: a blank text on an input node is missing, and so is a blank text that stands in for a required
      // input of its node (the idea of a music video: the node cannot run without it); a blank text elsewhere is the author's choice
      const standsIn = registry.portsFor(def, registry.normalizeParams(def, node.params)).inputs.some((port) => port.required && port.param === param.id);
      out.push({ ...base, type: 'text', required: (node.type.startsWith('input.') || standsIn) && !hasValue });
    }
  }
  return out;
}

function publicInput(descriptor) {
  const { _paramKind, _media, _max, ...rest } = descriptor;
  return rest;
}

// What a workflow hands back: the app outputs, else the output.result nodes in canvas order. [{ node, label }]
function outputDescriptors(graph, app, registry) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const fromApp = (Array.isArray(app?.outputs) ? app.outputs : [])
    .filter((entry) => isPlainObject(entry) && byId.has(entry.node))
    .map((entry) => ({ node: entry.node, label: cleanText(entry.label || nodeLabel(byId.get(entry.node), registry), 120) }));
  if (fromApp.length) return fromApp;
  return nodes
    .filter((node) => node.type === 'output.result')
    .slice()
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || String(a.id).localeCompare(String(b.id)))
    .map((node) => ({ node: node.id, label: cleanText(nodeLabel(node, registry), 120) }));
}

/* ---------- values given for the inputs ---------- */

function invalidInput(descriptor, reason, message, extra = {}) {
  return serviceError('INVALID_INPUT', `Input "${descriptor.label}" (${descriptor.id}): ${message}`, { input: descriptor.id, reason, ...extra });
}

function normalisedLabel(value) {
  return String(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// The descriptor a key of `inputs` names: its id first, then its label (unique, case-insensitive).
function matchInput(descriptors, key) {
  const exact = descriptors.find((descriptor) => descriptor.id === String(key).trim());
  if (exact) return exact;
  const wanted = normalisedLabel(key);
  const found = descriptors.filter((descriptor) => normalisedLabel(descriptor.label) === wanted);
  if (found.length === 1) return found[0];
  const valid = descriptors.map((descriptor) => `${descriptor.id} («${descriptor.label}»)`).join(', ');
  if (found.length > 1) {
    throw serviceError('INVALID_INPUT', `Input name "${key}" is ambiguous; use one of the ids: ${found.map((item) => item.id).join(', ')}`, { input: String(key), reason: 'ambiguous' });
  }
  throw serviceError('INVALID_INPUT', `Unknown input "${key}". Valid inputs: ${valid || 'none'}`, { input: String(key), reason: 'unknown_input' });
}

// Text, number, boolean, selection and tags: the value as the param stores it, or INVALID_INPUT.
function coerceValue(descriptor, raw) {
  switch (descriptor.type) {
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') throw invalidInput(descriptor, 'wrong_type', 'a text is expected');
      const text = String(raw);
      if ([...text].length > LIMITS.maxTextChars) throw invalidInput(descriptor, 'too_long', `at most ${LIMITS.maxTextChars} characters`);
      if (descriptor._paramKind === 'color' && [...text].length > 24) throw invalidInput(descriptor, 'too_long', 'a colour is at most 24 characters');
      return text;
    }
    case 'number': {
      const number = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof number !== 'number' || !Number.isFinite(number)) throw invalidInput(descriptor, 'wrong_type', 'a number is expected');
      if (descriptor.integer && !Number.isInteger(number)) throw invalidInput(descriptor, 'wrong_type', 'a whole number is expected');
      if ((descriptor.min !== undefined && number < descriptor.min) || (descriptor.max !== undefined && number > descriptor.max)) {
        throw invalidInput(descriptor, 'out_of_range', `the value must be between ${descriptor.min ?? '-∞'} and ${descriptor.max ?? '∞'}`, { min: descriptor.min ?? null, max: descriptor.max ?? null });
      }
      return number;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      throw invalidInput(descriptor, 'wrong_type', 'true or false is expected');
    }
    case 'select': {
      if (typeof raw !== 'string' && typeof raw !== 'number') throw invalidInput(descriptor, 'wrong_type', 'one of the options is expected');
      const value = String(raw);
      if (descriptor.options && !descriptor.options.some((option) => String(option) === value)) {
        throw invalidInput(descriptor, 'invalid_option', `"${cleanText(value, 60)}" is not an option. Options: ${descriptor.options.join(', ')}`, { options: descriptor.options });
      }
      if (!descriptor.options && (!value || [...value].length > 200)) throw invalidInput(descriptor, 'invalid_option', 'an option is expected');
      return value;
    }
    case 'tags': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
      if (!list || list.some((item) => typeof item !== 'string')) throw invalidInput(descriptor, 'wrong_type', 'a list of words is expected');
      return [...new Set(list.map((item) => cleanText(item.trim(), 100)).filter(Boolean))].slice(0, LIMITS.maxTags);
    }
    default:
      throw invalidInput(descriptor, 'wrong_type', 'this input cannot be set');
  }
}

// Asset ids of a media input: one id (or { assetId }) for a single file, a list for a media list.
function assetIdsOf(descriptor, raw) {
  const items = Array.isArray(raw) ? raw : [raw];
  const ids = items.map((item) => (isPlainObject(item) ? item.assetId : item));
  if (!ids.length || ids.some((id) => !sessionStore.isValidId(id))) {
    throw invalidInput(descriptor, 'wrong_type', 'asset ids from the chat are expected');
  }
  if (!descriptor.list && ids.length !== 1) throw invalidInput(descriptor, 'too_many', 'exactly one asset is expected');
  const max = Math.min(LIMITS.maxMediaFiles, Number.isFinite(descriptor._max) ? descriptor._max : LIMITS.maxMediaFiles);
  if (ids.length > max) throw invalidInput(descriptor, 'too_many', `at most ${max} assets`);
  return ids;
}

/* ---------- plan of a run ---------- */

function describePlan({ workflow, plan, registry, active }) {
  const byId = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
  const steps = [];
  let runSteps = 0;
  let cachedSteps = 0;
  for (const nodeId of plan.order) {
    const entry = plan.nodes[nodeId];
    const node = byId.get(nodeId);
    if (!entry || !node) continue;
    const runs = entry.status === 'stale' || entry.status === 'forced';
    if (runs) runSteps += 1;
    if (entry.status === 'cached') cachedSteps += 1;
    const known = Boolean(entry.paid && entry.estimate && entry.executions !== null);
    steps.push({
      nodeId,
      type: node.type,
      label: cleanText(nodeLabel(node, registry), 120),
      status: entry.status,
      runs,
      paid: Boolean(entry.paid),
      executions: entry.executions,
      usd: runs && known && Number.isFinite(entry.estimate.usd) ? round4(entry.estimate.usd * entry.executions) : null,
      credits: runs && known && Number.isFinite(entry.estimate.credits) ? round4(entry.estimate.credits * entry.executions) : null,
      ...(entry.reason ? { reason: cleanText(entry.reason, 300) } : {}),
      ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {})
    });
  }
  const totals = {
    paidNodes: plan.totals.paidNodes,
    unknownNodes: plan.totals.unknownNodes,
    usd: round4(plan.totals.usd),
    credits: round4(plan.totals.credits),
    usdKnown: plan.totals.unknownNodes === 0,
    runSteps,
    localSteps: Math.max(0, runSteps - plan.totals.paidNodes),
    cachedSteps
  };
  const issues = plan.issues
    .slice(0, LIMITS.maxIssues)
    .map((issue) => ({ nodeId: issue.nodeId || null, level: issue.level, code: issue.code || null, message: cleanText(issue.message, 300) }));

  const blockers = [];
  const errors = plan.issues.filter((issue) => issue.level === 'error');
  if (errors.length) blockers.push({ code: 'INVALID_GRAPH', message: `Workflow is not valid: ${errors[0].message}`, issues: issues.filter((issue) => issue.level === 'error') });
  const unavailable = steps.filter((step) => step.status === 'unavailable');
  if (unavailable.length) {
    blockers.push({ code: 'NODE_UNAVAILABLE', message: `A step is not available: ${unavailable[0].label}${unavailable[0].reason ? ` (${unavailable[0].reason})` : ''}`, nodes: unavailable.map((step) => step.nodeId) });
  }
  if (Array.isArray(plan.blocked) && plan.blocked.length) {
    blockers.push({ code: 'FORBIDDEN_FOR_ROLE', feature: 'higgsfield', message: 'The workflow contains Higgsfield nodes, which are not available for this account', nodes: plan.blocked.map((item) => item.nodeId) });
  }
  if (plan.budget && plan.budget.code) {
    blockers.push({ code: plan.budget.code, message: plan.budget.code === 'BUDGET_EXHAUSTED' ? 'The budget is used up' : 'The budget does not cover this run', remainingUsd: plan.budget.remainingUsd, estimateUsd: plan.budget.estimateUsd });
  }
  if (active) blockers.push({ code: 'RUN_ACTIVE', message: 'A run is already active for this workflow', runId: active.runId || null });

  return {
    valid: plan.valid,
    paid: plan.totals.paidNodes > 0,
    upToDate: runSteps === 0 && plan.valid,
    totals,
    steps,
    issues,
    budget: plan.budget
      ? {
          limitUsd: plan.budget.limitUsd,
          spentUsd: plan.budget.spentUsd,
          reservedUsd: plan.budget.reservedUsd,
          remainingUsd: plan.budget.remainingUsd,
          estimateUsd: round4(plan.budget.estimateUsd),
          enough: plan.budget.enough,
          ...(plan.budget.code ? { code: plan.budget.code } : {})
        }
      : null,
    blockers,
    canStart: blockers.length === 0
  };
}

/* ---------- outputs of a finished run ---------- */

function leafValues(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.type === 'list' && Array.isArray(value.items)) {
    for (const item of value.items) leafValues(item, out);
  } else {
    out.push(value);
  }
  return out;
}

// What this run paid for each file: a file belongs to the first step (by time) whose result holds it, later steps only pass
// it on. The cost of a step that ran in this run is shared by the files it made; a step that was taken from the cache cost
// nothing now. Returns Map 'sessionId/assetId' -> usd. A file without a share is unknown, not 0.
function fileCosts(run, results) {
  const entries = [];
  for (const [nodeId, state] of Object.entries(run.nodes || {})) {
    if (!state || !state.entry || (state.status !== 'done' && state.status !== 'cached')) continue;
    const entry = (results.nodes?.[nodeId]?.history || []).find((item) => item.id === state.entry);
    if (!entry) continue;
    const files = new Set();
    for (const variant of entry.variants || []) {
      for (const value of Object.values(variant || {})) {
        for (const leaf of leafValues(value, [])) {
          if (['image', 'video', 'audio', 'model3d'].includes(leaf.type) && sessionStore.isValidId(leaf.sessionId) && sessionStore.isValidId(leaf.assetId)) files.add(`${leaf.sessionId}/${leaf.assetId}`);
        }
      }
    }
    entries.push({ state, entry, files });
  }
  entries.sort((a, b) => String(a.entry.createdAt).localeCompare(String(b.entry.createdAt)));
  const owner = new Map();
  for (const item of entries) {
    item.own = [];
    for (const file of item.files) {
      if (owner.has(file)) continue;
      owner.set(file, item);
      item.own.push(file);
    }
  }
  const costs = new Map();
  for (const item of entries) {
    const usd = item.entry.cost?.usd;
    if (item.state.status !== 'done' || !Number.isFinite(usd) || usd <= 0 || !item.own.length) continue;
    for (const file of item.own) costs.set(file, round4(usd / item.own.length));
  }
  return costs;
}

// Media (with the reference into the backing session), texts and numbers of one variant of a result.
function itemsOfVariant(variant, textChars = LIMITS.previewChars, costs = new Map()) {
  const items = [];
  const seen = new Set();
  for (const [portId, value] of Object.entries(variant || {})) {
    for (const leaf of leafValues(value, [])) {
      if (['image', 'video', 'audio', 'model3d'].includes(leaf.type) && sessionStore.isValidId(leaf.sessionId) && sessionStore.isValidId(leaf.assetId)) {
        const key = `${leaf.sessionId}/${leaf.assetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          type: leaf.type,
          port: portId,
          assetId: leaf.assetId,
          sessionId: leaf.sessionId,
          url: typeof leaf.url === 'string' ? leaf.url : null,
          ...(Number.isFinite(leaf.duration) ? { duration: leaf.duration } : {}),
          costUsd: costs.has(key) ? costs.get(key) : null,
          // the chat takes no 3D model (the preview image is an image item of its own)
          sendToChat: leaf.type !== 'model3d'
        });
      } else if (leaf.type === 'text' && typeof leaf.value === 'string' && leaf.value.trim()) {
        items.push({ type: 'text', port: portId, text: preview(leaf.value.trim(), textChars), length: [...leaf.value.trim()].length });
      } else if (leaf.type === 'number' && Number.isFinite(leaf.value)) {
        items.push({ type: 'number', port: portId, value: leaf.value });
      }
    }
  }
  return items;
}

/* ---------- search ---------- */

// Does a query fit the text of a template? The phrase as typed, else all of its words (three letters or more) in any order: a model
// that searches for "video song" finds "Musikvideo aus Song".
function matchesQuery(haystack, needle) {
  if (haystack.includes(needle)) return true;
  const words = needle.split(/\s+/).filter((word) => word.length >= 3);
  return words.length > 1 && words.every((word) => haystack.includes(word));
}

/* ---------- the service ---------- */

function createRunService({
  engine,
  store = workflowsStore.defaultStore,
  registry = nodeRegistry.registry,
  sessions = sessionStore,
  assets = assetsLib,
  templates = {
    list: (options) => templatesLib.listTemplates(options),
    resolve: (id, options) => templatesLib.resolveTemplate(id, options)
  },
  teamFor = (viewer) => teamGroups.teamForNew(viewer)
} = {}) {
  if (!engine) throw new Error('createRunService needs an engine');
  const runWorkflows = new Map(); // runId -> workflowId of the runs started here (a short cut for status and cancel)
  const createdHere = new Map(); // workflowId -> user of the workflows prepare created from a template (discardPrepared)

  const isRestricted = (viewer) => access.isRestricted(viewer);

  // The error of a blocker of the plan (the same codes as the node view).
  function blockerError(blocker) {
    if (blocker.code === 'FORBIDDEN_FOR_ROLE') return roleRestricted();
    const { code, message, ...details } = blocker;
    return serviceError(code, message, details);
  }

  function assertWorkflowId(id) {
    if (!sessions.isValidId(id)) throw serviceError('INVALID_ID', 'Invalid workflow id');
    return id;
  }

  // The workflow of an id for a person who may start it; 404 for everybody else (a stranger's workflow does not exist
  // for them). With `forRun`, participants and guests get no workflow with Higgsfield nodes.
  async function loadWorkflow(viewer, id, { forRun = true } = {}) {
    assertViewer(viewer);
    assertWorkflowId(id);
    const workflow = await store.readWorkflow(id);
    if (!canRun(workflow, viewer)) throw notFound();
    if (forRun && isRestricted(viewer) && templatesLib.usesRestrictedNodes(workflow.graph, { registry })) throw roleRestricted();
    return workflow;
  }

  // A chat (or workflow session) the person may use, else the same 404 as for a missing one.
  async function assertSessionAccess(viewer, sessionId) {
    if (!sessions.isValidId(sessionId)) throw serviceError('INVALID_ID', 'Invalid session id');
    let sharing;
    try {
      sharing = await sessions.readSessionAccess(sessionId);
    } catch (err) {
      if (err.code === 'ENOENT') throw serviceError('NOT_FOUND', 'Chat not found');
      throw err;
    }
    if (viewer.active && !access.canUse(sharing, viewer)) throw serviceError('NOT_FOUND', 'Chat not found');
  }

  function costOf(graph, requires) {
    try {
      return templatesLib.costSummary({ graph, requires }, { registry });
    } catch (_) {
      return { kind: 'unknown', usd: 0, credits: 0, paidNodes: 1, providers: [] };
    }
  }

  // The cost of a template or workflow for the list: free, an estimate, a partial one (what is known) or unknown. `usd`
  // is null whenever there is no dollar figure (unknown, or a price in credits only): never a made-up 0.
  function publicCost(cost) {
    const known = cost.kind === 'estimate' || cost.kind === 'partial';
    const usd = cost.kind === 'free' ? 0 : known && (cost.usd > 0 || !cost.credits) ? cost.usd : null;
    return { kind: cost.kind, paid: cost.paidNodes > 0, usd, ...(cost.credits ? { credits: cost.credits } : {}) };
  }

  /* ----- list ----- */

  async function listRunnable(viewer, { query, lang, limit } = {}) {
    assertViewer(viewer);
    const language = templatesLib.pickLang(lang);
    const needle = typeof query === 'string' && query.trim() ? query.trim().toLowerCase() : null;
    const max = Math.min(LIMITS.maxList, Number.isInteger(limit) && limit > 0 ? limit : LIMITS.defaultList);
    const restricted = isRestricted(viewer);
    const items = [];

    // templates first: they are few and must not be pushed out by a long list of workflows
    const listed = await templates.list({ lang: language, registry, hideRestricted: restricted });
    for (const entry of listed) {
      if (needle && !matchesQuery(`${entry.id}\n${entry.name}\n${entry.description}`.toLowerCase(), needle)) continue;
      if (items.length >= max) break;
      const doc = await templates.resolve(entry.id, { lang: language });
      if (!doc) continue;
      items.push({
        kind: 'template',
        id: entry.id,
        name: entry.name,
        description: cleanText(entry.description || '', 500),
        origin: 'template',
        nodeCount: entry.nodeCount,
        inputs: inputDescriptors(doc.graph, doc.app, registry).map(publicInput),
        outputs: outputDescriptors(doc.graph, doc.app, registry),
        paid: entry.cost.paidNodes > 0,
        cost: publicCost(entry.cost),
        usesHiggsfield: templatesLib.usesRestrictedNodes(doc.graph, { registry }),
        available: entry.available,
        ...(entry.available ? {} : { missing: entry.missing.map((item) => item.key) })
      });
    }
    const templateCount = items.length;

    let truncated = false;
    const workflows = await store.listWorkflows({ q: query, includeSharing: viewer.active });
    for (const summary of workflows) {
      if (viewer.active && !canRun(summary, viewer)) continue;
      if (items.length >= max) {
        truncated = true;
        break;
      }
      let workflow;
      try {
        workflow = await store.readWorkflow(summary.id);
      } catch (_) {
        continue;
      }
      if (restricted && templatesLib.usesRestrictedNodes(workflow.graph, { registry })) continue;
      const cost = costOf(workflow.graph, []);
      items.push({
        kind: 'workflow',
        id: workflow.id,
        name: workflow.name,
        description: cleanText(workflow.description || '', 500),
        origin: !viewer.active || !workflow.owner || access.normalizeEmail(workflow.owner) === viewer.email ? 'own' : 'shared',
        nodeCount: workflow.graph.nodes.length,
        inputs: inputDescriptors(workflow.graph, workflow.app, registry).map(publicInput),
        outputs: outputDescriptors(workflow.graph, workflow.app, registry),
        paid: cost.paidNodes > 0,
        cost: publicCost(cost),
        usesHiggsfield: templatesLib.usesRestrictedNodes(workflow.graph, { registry }),
        available: true,
        updatedAt: workflow.updatedAt
      });
    }
    return { items, templates: templateCount, workflows: items.length - templateCount, truncated };
  }

  /* ----- one workflow ----- */

  // The results a workflow holds now: for each output the selected (else the newest) entry. Nothing is planned or started.
  async function describeWorkflow(viewer, workflowId, { textChars } = {}) {
    const workflow = await loadWorkflow(viewer, workflowId, { forRun: false });
    const chars = Number.isInteger(textChars) && textChars > 0 ? Math.min(textChars, LIMITS.maxTextChars) : LIMITS.previewChars;
    const results = await store.readResults(workflow.id);
    const lastResults = [];
    for (const output of outputDescriptors(workflow.graph, workflow.app, registry)) {
      const nodeResults = results.nodes?.[output.node];
      const history = nodeResults && Array.isArray(nodeResults.history) ? nodeResults.history : [];
      const entry = (nodeResults && nodeResults.selected && history.find((item) => item.id === nodeResults.selected.entry)) || history[0];
      if (!entry) continue;
      const variantIndex = nodeResults.selected?.entry === entry.id ? nodeResults.selected.variant || 0 : 0;
      const variant = entry.variants?.[variantIndex] || entry.variants?.[0];
      if (!variant) continue;
      lastResults.push({ nodeId: output.node, label: output.label, createdAt: entry.createdAt || null, items: itemsOfVariant(variant, chars) });
    }
    const cost = costOf(workflow.graph, []);
    const active = engine.activeRun(workflow.id);
    return {
      id: workflow.id,
      name: workflow.name,
      description: cleanText(workflow.description || '', 500),
      origin: !viewer.active || !workflow.owner || access.normalizeEmail(workflow.owner) === viewer.email ? 'own' : 'shared',
      rev: workflow.rev,
      updatedAt: workflow.updatedAt,
      nodes: workflow.graph.nodes.map((node) => ({ id: node.id, type: node.type, label: cleanText(nodeLabel(node, registry), 120) })),
      edgeCount: workflow.graph.edges.length,
      inputs: inputDescriptors(workflow.graph, workflow.app, registry).map(publicInput),
      outputs: outputDescriptors(workflow.graph, workflow.app, registry),
      paid: cost.paidNodes > 0,
      cost: publicCost(cost),
      usesHiggsfield: templatesLib.usesRestrictedNodes(workflow.graph, { registry }),
      activeRun: active ? { runId: active.runId || null } : null,
      lastResults
    };
  }

  /* ----- prepare ----- */

  // Copies the chosen assets into the backing session (a file of that session itself is used as it is).
  async function mediaValues(entries, sourceSessionId, targetSessionId) {
    const values = new Map();
    for (const { assetId, entry } of entries) {
      if (values.has(assetId)) continue;
      try {
        values.set(
          assetId,
          sourceSessionId === targetSessionId ? assets.valueFromLedgerEntry(targetSessionId, entry) : await assets.copyAsset(sourceSessionId, assetId, targetSessionId)
        );
      } catch (err) {
        throw serviceError('INVALID_INPUT', `The file ${assetId} could not be used: ${cleanText(err.message, 200)}`, { input: assetId, reason: 'asset_unavailable' });
      }
    }
    return values;
  }

  // Sets the values on the workflow in one save (media are copied into its session first).
  async function applyInputs(workflowId, resolved, sourceSessionId, user) {
    if (!resolved.length) return { saved: null, undo: async () => {} };
    const current = await store.readWorkflow(workflowId);
    const mediaEntries = resolved.flatMap((item) => item.assets || []);
    const copies = mediaEntries.length ? await mediaValues(mediaEntries, sourceSessionId, current.sessionId) : new Map();
    const nodes = current.graph.nodes.map((node) => {
      const mine = resolved.filter((item) => item.descriptor.node === node.id);
      if (!mine.length) return node;
      const params = { ...node.params };
      for (const item of mine) {
        if (item.assets) {
          const list = item.assets.map(({ assetId }) => copies.get(assetId));
          params[item.descriptor.param] = item.descriptor.list ? list : list[0];
        } else {
          params[item.descriptor.param] = item.value;
        }
      }
      return { ...node, params };
    });
    const saved = await store.saveGraph(workflowId, { baseRev: current.rev, graph: { ...current.graph, nodes }, user });
    // puts the workflow back as it was, unless somebody changed it since
    const undo = async () => {
      const now = await store.readWorkflow(workflowId);
      if (now.rev !== saved.rev) return;
      await store.saveGraph(workflowId, { baseRev: now.rev, graph: current.graph, user });
    };
    return { saved, undo };
  }

  // The inputs of a stored workflow as the card and the Director see them: label, type and the value now in place.
  // Files the person put in are shown with their address in the chat they came from: the address in the session behind the
  // workflow would be a broken image for the other people of a shared chat (and show the id of that session). A file that was
  // in the workflow before has no address in the chat: it is shown without one.
  function describeInputs(workflow, resolved, sourceSessionId) {
    const given = new Set(resolved.map((item) => item.descriptor.id));
    return inputDescriptors(workflow.graph, workflow.app, registry).map((descriptor) => {
      const node = workflow.graph.nodes.find((item) => item.id === descriptor.node);
      const def = registry.get(node.type);
      const value = registry.normalizeParams(def, node.params)[descriptor.param];
      const fromChat = resolved.find((item) => item.descriptor.id === descriptor.id && item.assets);
      const mediaValue = (entry, index) => {
        if (!assetsLib.assetRefFromParam(entry, 'x')) return null;
        const source = fromChat && fromChat.assets[index];
        return {
          type: entry.type || descriptor.type,
          assetId: entry.assetId,
          sessionId: entry.sessionId || workflow.sessionId,
          url: source && sourceSessionId ? sessionStore.assetUrl(sourceSessionId, source.entry.file) : null
        };
      };
      let shown;
      if (descriptor._media) shown = descriptor.list ? (Array.isArray(value) ? value.map((entry, index) => mediaValue(entry, index)).filter(Boolean) : []) : mediaValue(value, 0);
      else if (descriptor.type === 'text') shown = { text: preview(value || ''), length: [...String(value || '')].length };
      else shown = value;
      return { ...publicInput(descriptor), applied: given.has(descriptor.id), value: shown };
    });
  }

  async function prepare(viewer, { templateId, workflowId, inputs, sourceSessionId, name, lang, requireStartable = false } = {}) {
    assertViewer(viewer);
    const hasTemplate = templateId !== undefined && templateId !== null && templateId !== '';
    const hasWorkflow = workflowId !== undefined && workflowId !== null && workflowId !== '';
    if (hasTemplate === hasWorkflow) throw serviceError('INVALID_REQUEST', 'Give either templateId or workflowId');
    if (inputs !== undefined && inputs !== null && !isPlainObject(inputs)) throw serviceError('INVALID_REQUEST', 'inputs must be an object');
    if (name !== undefined && name !== null && typeof name !== 'string') throw serviceError('INVALID_REQUEST', 'name must be a string');
    const given = Object.entries(inputs || {});
    if (sourceSessionId !== undefined && sourceSessionId !== null) await assertSessionAccess(viewer, sourceSessionId);

    // 1 what is to be run
    let source;
    if (hasTemplate) {
      if (typeof templateId !== 'string') throw serviceError('INVALID_REQUEST', 'templateId must be a string');
      const document = await templates.resolve(templateId, { lang: templatesLib.pickLang(lang) });
      if (!document) throw serviceError('NOT_FOUND', 'Template not found');
      if (isRestricted(viewer) && templatesLib.usesRestrictedNodes(document.graph, { registry })) {
        throw new access.RoleRestrictedError('templates', 'This template is not available for your account', 'Diese Vorlage ist für dein Konto nicht verfügbar.');
      }
      source = { document, graph: document.graph, app: document.app };
    } else {
      if (typeof workflowId !== 'string') throw serviceError('INVALID_REQUEST', 'workflowId must be a string');
      const workflow = await loadWorkflow(viewer, workflowId);
      const active = engine.activeRun(workflowId);
      if (active) throw serviceError('RUN_ACTIVE', 'A run is active for this workflow; wait for it or cancel it first', { runId: active.runId || null });
      source = { workflow, graph: workflow.graph, app: workflow.app };
    }

    // 2 the inputs: every check happens before a workflow is created or changed
    const descriptors = inputDescriptors(source.graph, source.app, registry);
    const resolved = [];
    let ledger = null;
    let files = 0;
    for (const [key, raw] of given) {
      const descriptor = matchInput(descriptors, key);
      if (resolved.some((item) => item.descriptor.id === descriptor.id)) {
        throw serviceError('INVALID_INPUT', `Input "${descriptor.label}" is given twice`, { input: descriptor.id, reason: 'duplicate' });
      }
      if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '' && descriptor.required)) continue; // nothing given: stays as it is
      if (!descriptor._media) {
        resolved.push({ descriptor, value: coerceValue(descriptor, raw) });
        continue;
      }
      if (!sessions.isValidId(sourceSessionId)) {
        throw invalidInput(descriptor, 'no_source', 'files can only be taken from a chat; sourceSessionId is missing');
      }
      const ids = assetIdsOf(descriptor, raw);
      files += ids.length;
      if (files > LIMITS.maxMediaFiles) throw invalidInput(descriptor, 'too_many', `at most ${LIMITS.maxMediaFiles} files in total`);
      if (!ledger) ledger = await sessions.readLedger(sourceSessionId);
      const entries = ids.map((assetId) => {
        const entry = ledger.find((item) => item.id === assetId);
        if (!entry) throw invalidInput(descriptor, 'asset_not_found', `the file ${assetId} does not exist in this chat`, { assetId });
        if (entry.pending) throw invalidInput(descriptor, 'asset_pending', `the file ${assetId} is not finished yet`, { assetId });
        const type = assets.typeFromLedgerEntry(entry);
        if (!type) throw invalidInput(descriptor, 'wrong_type', `the file ${assetId} cannot be used as image, video or audio`, { assetId });
        if (type !== descriptor.type) throw invalidInput(descriptor, 'wrong_type', `the file ${assetId} is ${type}, expected ${descriptor.type}`, { assetId, expected: descriptor.type, actual: type });
        return { assetId, entry };
      });
      resolved.push({ descriptor, assets: entries });
    }
    const missing = descriptors.filter((descriptor) => descriptor.required && !descriptor.hasValue && !resolved.some((item) => item.descriptor.id === descriptor.id));
    if (missing.length) {
      throw serviceError('MISSING_INPUT', `Missing inputs: ${missing.map((item) => `${item.label} (${item.id})`).join(', ')}`, {
        missing: missing.map((item) => ({ id: item.id, label: item.label, type: item.type, list: item.list }))
      });
    }

    // 3 the workflow
    const user = userOf(viewer);
    let created = null;
    let id;
    if (hasTemplate) {
      created = await store.createWorkflow({
        document: source.document,
        ...(name && name.trim() ? { name } : {}),
        user,
        owner: access.ownerForNew(viewer),
        teamId: teamFor(viewer)
      });
      id = created.workflow.id;
    } else {
      id = workflowId;
    }
    let applied;
    try {
      applied = await applyInputs(id, resolved, sourceSessionId, user);
    } catch (err) {
      if (created) await store.deleteWorkflow(id).catch(() => {});
      throw err;
    }
    if (created) {
      createdHere.set(id, user);
      if (createdHere.size > REMEMBERED_RUNS) createdHere.delete(createdHere.keys().next().value);
    }
    const workflow = await store.readWorkflow(id);
    let plan = null;
    if (requireStartable) {
      try {
        plan = await estimate(viewer, id);
        // the budget and an active run are shown to the person (the card says so); everything else can never start
        const blocker = plan.blockers.find((item) => !BENIGN_BLOCKERS.has(item.code));
        if (blocker) throw blockerError(blocker);
      } catch (err) {
        // a workflow that was created for this is removed again; the inputs set in an existing one are taken back
        if (created) {
          createdHere.delete(id);
          await store.deleteWorkflow(id).catch(() => {});
        } else {
          await applied.undo().catch(() => {});
        }
        throw err;
      }
    }
    return {
      workflowId: id,
      name: workflow.name,
      origin: hasTemplate ? 'template' : 'workflow',
      ...(hasTemplate ? { templateId } : {}),
      created: Boolean(created),
      rev: workflow.rev,
      sessionId: workflow.sessionId,
      nodeCount: workflow.graph.nodes.length,
      inputs: describeInputs(workflow, resolved, sourceSessionId),
      inputsSet: resolved.length > 0,
      outputs: outputDescriptors(workflow.graph, workflow.app, registry),
      ...(plan ? { plan } : {})
    };
  }

  // A workflow that prepare created for a run that did not come about (the start was refused) is removed again, so a new
  // try does not pile up more. Only workflows created here, by the same person, that have no run.
  async function discardPrepared(viewer, prepared) {
    assertViewer(viewer);
    const id = prepared && prepared.created ? prepared.workflowId : null;
    if (!id || !sessions.isValidId(id) || createdHere.get(id) !== userOf(viewer)) return false;
    if ((await store.listRuns(id)).length) return false;
    createdHere.delete(id);
    await store.deleteWorkflow(id);
    return true;
  }

  /* ----- plan and start ----- */

  async function estimate(viewer, workflowId) {
    const workflow = await loadWorkflow(viewer, workflowId);
    const plan = await engine.plan(workflow.id, { mode: 'all', user: userOf(viewer) });
    const described = describePlan({ workflow, plan, registry, active: engine.activeRun(workflow.id) });
    return { workflowId: workflow.id, name: workflow.name, rev: workflow.rev, sessionId: workflow.sessionId, nodeCount: workflow.graph.nodes.length, ...described };
  }

  // maxUsd, maxCredits: the highest totals the person has seen and accepted (the paid steps with a known price); nothing
  // given counts as 0. A run that is paid does not start without one of them. maxUnknownNodes: how many paid steps without
  // a price they accepted (default none). rev: the revision of the workflow they looked at; a changed workflow is not started.
  // requireFree: the run starts without a click, so it must be free; once it has paid steps, no amount makes it start.
  async function start(viewer, workflowId, { maxUsd, maxCredits, maxUnknownNodes = 0, rev, requireFree = false } = {}) {
    const amount = (value) => value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (!amount(maxUsd)) throw serviceError('INVALID_REQUEST', 'maxUsd must be a number of at least 0');
    if (!amount(maxCredits)) throw serviceError('INVALID_REQUEST', 'maxCredits must be a number of at least 0');
    if (!Number.isInteger(maxUnknownNodes) || maxUnknownNodes < 0) throw serviceError('INVALID_REQUEST', 'maxUnknownNodes must be a whole number of at least 0');
    if (rev !== undefined && rev !== null && !Number.isInteger(rev)) throw serviceError('INVALID_REQUEST', 'rev must be an integer');
    const view = await estimate(viewer, workflowId);
    const usdLimit = typeof maxUsd === 'number' ? maxUsd : 0;
    const creditLimit = typeof maxCredits === 'number' ? maxCredits : 0;
    const confirmed = typeof maxUsd === 'number' || typeof maxCredits === 'number';
    const changed = (message) =>
      serviceError('COST_CHANGED', message, {
        estimateUsd: view.totals.usd,
        estimateCredits: view.totals.credits,
        maxUsd: usdLimit,
        maxCredits: creditLimit,
        unknownNodes: view.totals.unknownNodes,
        maxUnknownNodes
      });
    if (requireFree && view.paid) throw changed('The run has paid steps; it does not start without a click on the amount');
    if (view.paid && !confirmed) {
      throw serviceError('CONFIRMATION_REQUIRED', 'This run has paid steps; it starts only with the amount the person has accepted (maxUsd, maxCredits)', {
        estimateUsd: view.totals.usd,
        estimateCredits: view.totals.credits,
        unknownNodes: view.totals.unknownNodes
      });
    }
    if (view.totals.usd > usdLimit + COST_EPSILON || view.totals.credits > creditLimit + COST_EPSILON || view.totals.unknownNodes > maxUnknownNodes) {
      throw changed('The cost of the run is higher than the amount that was accepted');
    }
    // what the engine checks itself (a run that is active, the budget with its reservation) is left to it
    const blocker = view.blockers.find((item) => !BENIGN_BLOCKERS.has(item.code));
    if (blocker) throw blockerError(blocker);
    const runId = await engine.start(view.workflowId, { mode: 'all', user: userOf(viewer), ...(Number.isInteger(rev) ? { rev } : {}) });
    runWorkflows.set(runId, view.workflowId);
    if (runWorkflows.size > REMEMBERED_RUNS) runWorkflows.delete(runWorkflows.keys().next().value);
    return {
      runId,
      workflowId: view.workflowId,
      name: view.name,
      rev: view.rev,
      paid: view.paid,
      totals: view.totals
    };
  }

  // The run of a workflow that is active now or was started at or after `since` (a start whose result was not stored: the
  // run exists, the caller lost its id). null when there is none.
  async function findRun(viewer, workflowId, { since } = {}) {
    const workflow = await loadWorkflow(viewer, workflowId, { forRun: false });
    const active = engine.activeRun(workflow.id);
    if (active && active.runId) return { runId: active.runId, workflowId: workflow.id };
    const from = Date.parse(since);
    if (!Number.isFinite(from)) return null;
    const run = (await store.listRuns(workflow.id)).find((item) => Date.parse(item.startedAt) >= from);
    return run ? { runId: run.id, workflowId: workflow.id } : null;
  }

  /* ----- status and cancel ----- */

  async function runWorkflowId(runId, hint) {
    if (!sessions.isValidId(runId)) throw serviceError('INVALID_ID', 'Invalid run id');
    if (hint !== undefined && hint !== null) return assertWorkflowId(hint);
    return runWorkflows.get(runId) || (await store.findRunWorkflow(runId)) || null;
  }

  async function loadRun(viewer, runId, hint) {
    assertViewer(viewer);
    const workflowId = await runWorkflowId(runId, hint);
    if (!workflowId) throw serviceError('RUN_NOT_FOUND', 'Run not found');
    let workflow;
    try {
      workflow = await loadWorkflow(viewer, workflowId, { forRun: false });
    } catch (err) {
      // a run of a workflow the person may not use does not exist for them
      if (err.code === 'WORKFLOW_NOT_FOUND') throw serviceError('RUN_NOT_FOUND', 'Run not found');
      throw err;
    }
    const run = await store.readRun(workflowId, runId);
    return { workflow, run };
  }

  // textChars: how much of a text output is returned (default: a short preview, at most maxTextChars).
  async function status(viewer, runId, { workflowId, textChars } = {}) {
    const { workflow, run } = await loadRun(viewer, runId, workflowId);
    const chars = Number.isInteger(textChars) && textChars > 0 ? Math.min(textChars, LIMITS.maxTextChars) : LIMITS.previewChars;
    const live = engine.activeRun(workflow.id);
    const nodeStates = { ...Object.fromEntries(Object.entries(run.nodes || {}).map(([id, entry]) => [id, entry.status])) };
    if (live && live.runId === run.id) Object.assign(nodeStates, live.nodes);
    const byId = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
    const nodes = Object.entries(nodeStates).map(([nodeId, state]) => {
      const node = byId.get(nodeId);
      const stored = run.nodes?.[nodeId] || {};
      return {
        nodeId,
        label: node ? cleanText(nodeLabel(node, registry), 120) : nodeId,
        type: node ? node.type : null,
        status: state,
        ...(stored.message ? { message: cleanText(stored.message, 300) } : {}),
        ...(stored.code ? { code: stored.code } : {})
      };
    });
    const finished = run.status !== 'running';
    const started = Date.parse(run.startedAt);
    const ended = finished && run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
    const result = {
      runId: run.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: run.status,
      finished,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || null,
      durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
      step: { done: nodes.filter((item) => TERMINAL_NODE_STATES.has(item.status)).length, total: nodes.length },
      running: nodes.filter((item) => item.status === 'running' || item.status === 'waiting_job').map((item) => item.label),
      nodes,
      cost: { usd: Number.isFinite(run.cost?.usd) ? run.cost.usd : 0, credits: Number.isFinite(run.cost?.credits) ? run.cost.credits : 0 },
      error: run.error ? cleanText(run.error, 500) : null,
      failures: nodes.filter((item) => item.status === 'error').map((item) => ({ nodeId: item.nodeId, label: item.label, message: item.message || null, code: item.code || null }))
    };
    if (run.status === 'completed') result.outputs = await outputsOf(workflow, run, chars);
    return result;
  }

  // Waits (without polling) until the run has finished, then returns its status. A run that is not active in this engine
  // (finished, or interrupted by a restart) returns at once.
  async function waitForRun(viewer, runId, options = {}) {
    const { workflow, run } = await loadRun(viewer, runId, options.workflowId);
    const live = engine.activeRun(workflow.id);
    if (run.status === 'running' && live && live.runId === run.id) await engine.whenFinished(workflow.id, run.id);
    return status(viewer, runId, { ...options, workflowId: workflow.id });
  }

  // The results of the output nodes this run produced (or kept): media with their reference into the backing session,
  // texts and numbers, and the cost of the result.
  async function outputsOf(workflow, run, textChars) {
    const results = await store.readResults(workflow.id);
    const costs = fileCosts(run, results);
    const outputs = [];
    for (const output of outputDescriptors(workflow.graph, workflow.app, registry)) {
      const entryId = run.nodes?.[output.node]?.entry;
      const nodeResults = results.nodes?.[output.node];
      const entry = entryId && nodeResults ? (nodeResults.history || []).find((item) => item.id === entryId) : null;
      if (!entry) continue;
      const variantIndex = nodeResults.selected?.entry === entry.id ? nodeResults.selected.variant || 0 : 0;
      const variant = entry.variants?.[variantIndex] || entry.variants?.[0];
      if (!variant) continue;
      outputs.push({
        nodeId: output.node,
        label: output.label,
        entryId: entry.id,
        items: itemsOfVariant(variant, textChars, costs),
        costUsd: Number.isFinite(entry.cost?.usd) ? entry.cost.usd : null
      });
    }
    return outputs;
  }

  async function cancel(viewer, runId, { workflowId } = {}) {
    const { workflow, run } = await loadRun(viewer, runId, workflowId);
    const requested = run.status === 'running' ? engine.cancel(workflow.id, run.id) : false;
    return { runId: run.id, workflowId: workflow.id, cancelled: requested, status: run.status };
  }

  return { listRunnable, describeWorkflow, prepare, estimate, start, status, waitForRun, cancel, discardPrepared, findRun, registry, limits: LIMITS };
}

/* ---------- the instance of the server ---------- */

// server.js creates the service with the engine of the node routes and installs it; the Director tools (and any other
// access) take it from here, so there is exactly one engine and one list of active runs.
let installed = null;

function installRunService(service) {
  installed = service || null;
  return installed;
}

function runService() {
  if (!installed) throw serviceError('UNAVAILABLE', 'The run service is not available');
  return installed;
}

module.exports = {
  LIMITS,
  createRunService,
  installRunService,
  runService,
  viewerForUser,
  inputDescriptors,
  outputDescriptors
};
