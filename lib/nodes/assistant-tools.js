'use strict';

// Policy adapts the shared MCP definitions, never their business logic. Workflows stay pinned to the open editor.
const { createAppTools } = require('../app-tools');
const { ToolError, validateArguments, readWithSignal } = require('../mcp/tools');
const influencers = require('../influencers');
const { slugOf, youtubeId } = require('../influencer-site');
const assets = require('./assets');
const fsp = require('fs/promises');

const POLICY = Object.freeze(Object.fromEntries(Object.entries({
  get_guide: { mode: 'read' },
  get_workflow: { mode: 'read', pin: 'workflow_id' },
  list_node_types: { mode: 'read' },
  estimate_run: { mode: 'read', pin: 'workflow_id' },
  get_run: { mode: 'read' },
  get_workflow_results: { mode: 'read', pin: 'workflow_id' },
  get_workflow_costs: { mode: 'read', pin: 'workflow_id' },
  edit_workflow: { mode: 'edit', pin: 'workflow_id' },
  run_workflow: { mode: 'run', pin: 'workflow_id' },
  delete_result_entry: { mode: 'confirm', pin: 'workflow_id' },
  list_influencers: { mode: 'read' },
  get_influencer: { mode: 'read' },
  get_influencer_site: { mode: 'read' },
  create_influencer: { mode: 'confirm' },
  update_influencer: { mode: 'confirm' },
  update_influencer_site: { mode: 'confirm' },
  add_influencer_site_item: { mode: 'confirm', pin: 'workflow_id' },
  remove_influencer_site_item: { mode: 'confirm' },
  publish_influencer_site: { mode: 'confirm' },
  suno_status: { mode: 'read' }, suno_library: { mode: 'read' }, suno_audio: { mode: 'read' }
}).map(([name, policy]) => [name, Object.freeze(policy)])));
const EXCEPTIONS = Object.freeze({
  list_templates: 'The person chooses templates in the app list; the assistant works on the open workflow.',
  list_workflows: 'The person opens workflows in the app list; the assistant stays in the open workflow.',
  create_from_template: 'The person creates workflows from templates in the app list.',
  create_workflow: 'The person creates and opens workflows in the app list.',
  duplicate_workflow: 'The person duplicates workflows in the app list.',
  upload_asset: 'The person uploads files in the app; upload sessions belong to keys.',
  add_influencer_image: 'The person uploads reference images in the app; upload sessions belong to keys.',
  cancel_run: 'The person cancels the active run with the controls in the top bar.',
  resume_run: 'Only the person may approve a waiting run with the controls in the top bar.'
});
const ASSISTANT_ONLY = Object.freeze({ insert: 'The browser inserts a validated proposal into its canvas, including unsaved changes.' });
const fail = (code, message) => Object.assign(new ToolError(message), { code });
const short = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);

// The adapters for edit and run have different effects from the MCP calls: edits have app undo, runs only prepare a card.
// Keep the MCP annotations truthful; apply the effect invariants to the definitions actually offered by this access.
function offeredTool(tool) {
  const policy = POLICY[tool.name];
  const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema));
  const hidden = new Set(['confirm', 'consent', 'rev', 'max_usd', 'wait_seconds']);
  if (policy.pin) hidden.add(policy.pin);
  if (policy.mode === 'run') { hidden.add('inputs'); hidden.add('file_marks'); }
  for (const name of hidden) delete inputSchema.properties[name];
  inputSchema.required = (inputSchema.required || []).filter((name) => !hidden.has(name));
  const annotations = policy.mode === 'run' || policy.mode === 'edit'
    ? { ...tool.annotations, destructiveHint: false, openWorldHint: false } : tool.annotations;
  const description = policy.mode === 'run' ? 'Prepare a run of the open workflow. Nothing starts; the person starts it and approves its cost in the app.'
    : policy.mode === 'edit' ? 'Edit existing nodes and connections of the saved open workflow. Read its graph first. New nodes should be proposed with insert. The browser revision is supplied by the server.'
      : policy.mode === 'confirm' ? `Prepare ${tool.name} for the person's confirmation click. Nothing changes until that click. ${tool.description}` : tool.description;
  return Object.freeze({ ...tool, description, inputSchema, annotations });
}

function assertParity(tools) {
  const names = new Set(tools.map((tool) => tool.name));
  const instruction = 'add it to POLICY or to EXCEPTIONS with a reason in lib/nodes/assistant-tools.js';
  for (const tool of tools) {
    const policy = Object.hasOwn(POLICY, tool.name) ? POLICY[tool.name] : null;
    if (Boolean(policy) === Object.hasOwn(EXCEPTIONS, tool.name)) throw new Error(`${tool.name}: ${instruction} (exactly one entry).`);
    if (!policy) continue;
    if (tool.right === 'start' && policy.mode === 'read') throw new Error(`${tool.name}: a start tool cannot be read.`);
    const offered = offeredTool(tool);
    if ((offered.annotations?.destructiveHint || offered.annotations?.openWorldHint) && policy.mode !== 'confirm') throw new Error(`${tool.name}: destructive or open-world tools require confirm.`);
    if (!['read', 'edit', 'run', 'confirm'].includes(policy.mode)) throw new Error(`${tool.name}: invalid mode.`);
    if (policy.mode === 'edit' && tool.name !== 'edit_workflow') throw new Error(`${tool.name}: only edit_workflow may edit.`);
    if (policy.mode === 'run' && tool.name !== 'run_workflow') throw new Error(`${tool.name}: only run_workflow may prepare a run.`);
  }
  for (const name of [...Object.keys(POLICY), ...Object.keys(EXCEPTIONS)]) if (!names.has(name)) throw new Error(`${name}: remove the stale policy entry or restore the MCP tool.`);
  for (const [name, reason] of Object.entries(EXCEPTIONS)) if (typeof reason !== 'string' || !reason.trim().endsWith('.') || reason.trim().length < 12) throw new Error(`${name}: explain the exception in an English sentence.`);
  for (const [name, reason] of Object.entries(ASSISTANT_ONLY)) if (!reason.trim()) throw new Error(`${name}: explain the assistant-only capability.`);
  return true;
}

// Human-readable edit facts contain ids and labels, never parameter values or model-authored descriptions.
function editChanges(operations, before, after, result, registry) {
  const old = new Map(before.nodes.map((node) => [node.id, node]));
  const fresh = new Map(after.nodes.map((node) => [node.id, node]));
  const resolve = (id) => result.created_nodes?.[id] || id;
  const named = new Set(operations.filter((op) => op.op === 'add_node' && op.ref).map((op) => op.ref));
  const anonymous = Object.entries(result.created_nodes || {}).filter(([key]) => !named.has(key)).map(([, id]) => id);
  const addedByOperation = new Map();
  for (const [index, op] of operations.entries()) {
    if (op.op !== 'add_node') continue;
    const id = op.ref ? result.created_nodes?.[op.ref] : anonymous.shift();
    if (!id) continue;
    addedByOperation.set(index, id);
    // A node added and removed in the same atomic call has no final graph entry, but its validated type is known.
    if (!fresh.has(id)) fresh.set(id, { id, type: op.type, label: short(op.label || registry?.get(op.type)?.label || op.type) });
  }
  const node = (id, prior = false) => {
    id = resolve(id);
    const found = (prior ? old.get(id) || fresh.get(id) : fresh.get(id) || old.get(id));
    return found ? { id, type: found.type, label: short(found.label || id) } : { id, label: short(id) };
  };
  const endpoint = (end, prior) => {
    // describeGraph uses "node.port" strings, while operations use endpoint objects.
    if (typeof end === 'string') { const [id, port] = end.split('.'); end = { node: id, port }; }
    const { id, label } = node(end.node, prior);
    return { node: { id, label }, port: end.port };
  };
  return operations.map((op, index) => {
    const item = { op: op.op };
    if (op.node) item.node = node(op.node, op.op === 'remove_node');
    if (op.op === 'add_node') {
      const added = addedByOperation.get(index);
      if (added) item.node = node(added);
    }
    if (op.params) item.params = Object.keys(op.params);
    const edge = op.edge && before.edges.find((entry) => entry.id === op.edge);
    if (op.from || edge?.from) item.from = endpoint(op.from || edge.from, op.op === 'disconnect');
    if (op.to || edge?.to) item.to = endpoint(op.to || edge.to, op.op === 'disconnect');
    if (op.param) item.param = op.param;
    return item;
  });
}

function createAssistantTools({ service, actions, workflowId, viewer, rev, publicBase = '', signal, ...deps }) {
  const svc = typeof service === 'function' ? service : () => service;
  const { tools: shared, context } = createAppTools({ service, viewer, publicBase, signal, ...deps });
  assertParity(shared);
  const tools = shared.filter((tool) => Object.hasOwn(POLICY, tool.name)).map(offeredTool);
  let currentRev = rev;
  let editBlocked = false;
  const state = { steps: [], edit: null, run: null, confirm: [] };
  let changes = [];

  async function prepareFacts(name, args) {
    if (name === 'delete_result_entry') {
      const found = await svc().workflowResults(viewer, workflowId, { nodeId: args.node_id, historyLimit: 20 });
      const node = found.nodes.find((item) => item.nodeId === args.node_id);
      if (!node?.history.some((entry) => entry.entryId === args.entry_id)) throw fail('ENTRY_NOT_FOUND', 'The result entry was not found. Read get_workflow_results first.');
      return { nodeLabel: short(node.label), entryId: args.entry_id };
    }
    if (name === 'create_influencer') {
      // No write and no consent assertion during preparation. Ownership/quota is checked again on execution.
      if (!args.name.trim() || !args.full.trim()) throw fail('INFLUENCER_INVALID', 'Name and identity text are required.');
      if (viewer.active && !viewer.email) throw fail('INFLUENCER_FORBIDDEN', 'A confirmed person is required.');
      if (viewer.email && await influencers.countOwnedBy(viewer.email) >= influencers.MAX_OWNED_INFLUENCERS) throw fail('INFLUENCER_LIMIT', 'The influencer ownership limit has been reached.');
      return { name: short(args.name) };
    }
    const figure = await influencers.readEditableInfluencer(args.influencer_id, viewer);
    const facts = { influencerName: short(figure.name) };
    if (name.includes('_site')) {
      const host = deps.websiteHost || require('../rtk-host').defaultHost;
      if (!host.enabled()) throw fail('SITE_DISABLED', 'The website host is not configured.');
      if (name === 'publish_influencer_site' && !host.status().connected) throw fail('HOST_NOT_CONNECTED', 'Connect the website host in the app first.');
      const site = figure.site || {};
      facts.slug = short(site.slug || slugOf(figure.name));
      facts.visibility = short(site.visibility || 'public');
      if (site.url) facts.siteUrl = short(site.url);
      if (name === 'remove_influencer_site_item') {
        const item = site.items?.find((item) => item.id === args.item_id);
        if (!item) throw fail('SITE_NOT_FOUND', 'The page item was not found.');
        facts.itemTitle = short(item.title);
      }
      if (name === 'update_influencer_site' && args.items) {
        const ids = site.items || [];
        if (args.items.length !== ids.length || new Set(args.items.map((item) => item.id)).size !== ids.length || args.items.some((item) => !ids.some((old) => old.id === item.id))) throw fail('SITE_INVALID', 'Provide every existing item id exactly once.');
      }
      if (name === 'add_influencer_site_item') {
        if ((args.youtube !== undefined && args.asset_id !== undefined) || (args.youtube === undefined && !args.asset_id)) throw fail('SITE_INVALID', 'Provide exactly one source: youtube or asset_id.');
        if (args.youtube !== undefined) {
          if (!youtubeId(args.youtube)) throw fail('SITE_INVALID', 'The YouTube URL is invalid.');
        } else {
          const graph = await svc().describeWorkflow(viewer, workflowId);
          // Read the authoritative backing session only after the service permission check.
          const store = deps.workflowStore || require('./workflows-store').defaultStore;
          const workflow = await store.readWorkflow(graph.id);
          const sessionStore = deps.sessions || require('../store');
          const entry = (await sessionStore.readLedger(workflow.sessionId)).find((item) => item.id === args.asset_id);
          // Pure validation: valueFromAsset may convert a HEIC photo, which belongs to execution after the click.
          const asset = assets.valueFromLedgerEntry(workflow.sessionId, entry);
          if (!['image', 'video'].includes(asset.type)) throw fail('SITE_INVALID', 'Only image or video assets can be added to a page.');
          const stat = await fsp.stat(assets.assetFilePath(asset));
          if (!stat.isFile()) throw fail('SITE_NOT_FOUND', 'The asset file was not found.');
        }
      }
    }
    return facts;
  }

  async function execute(name, rawArgs) {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw fail('UNKNOWN_TOOL', 'Unknown assistant tool. Use a name from the offered tools.');
    const problems = validateArguments(tool.inputSchema, rawArgs);
    if (problems.length) throw fail('INVALID_ARGUMENTS', problems.join('; '));
    const args = { ...rawArgs };
    const policy = POLICY[name];
    if (policy.pin && (name !== 'add_influencer_site_item' || args.youtube === undefined)) args[policy.pin] = workflowId;
    if (context.signal?.aborted) throw fail('ASSISTANT_DEADLINE', 'The question deadline was reached; no new action was taken.');
    if (policy.mode === 'edit') {
      if (!Number.isInteger(currentRev) || editBlocked) throw fail('UNSAVED_CHANGES', 'Save the canvas and resolve any revision conflict first. Nothing was overwritten.');
      const before = await readWithSignal(context, () => svc().describeGraph(viewer, workflowId));
      if (signal?.aborted) throw fail('ASSISTANT_DEADLINE', 'The question deadline was reached.');
      let result;
      try { result = await tool.handler({ ...args, rev: currentRev }, context); } catch (err) {
        if (err.code === 'REV_CONFLICT' || err.code === 'RUN_ACTIVE') editBlocked = true;
        throw err;
      }
      const baseRev = currentRev;
      currentRev = result.rev;
      if (result.changed) {
        // Record the saved revision before any optional follow-up read can fail.
        if (!state.edit) state.edit = { baseRev, rev: result.rev, changes: [] };
        state.edit.rev = result.rev;
        let after = before;
        try { after = await readWithSignal(context, () => svc().describeGraph(viewer, workflowId)); } catch (_) { /* The saved edit is still reported. */ }
        changes.push(...editChanges(args.operations, before, after, result, svc().registry));
        state.edit.changes = changes.slice(0, 40);
        if (changes.length > 40) state.edit.more = changes.length - 40;
      }
      return result;
    }
    if (policy.mode === 'run') {
      const graph = await svc().describeGraph(viewer, workflowId);
      const mode = args.mode || 'all';
      const ids = new Set(graph.nodes.map((node) => node.id));
      if (['node', 'selection'].includes(mode) && (!args.node_ids?.length || (mode === 'node' && args.node_ids.length !== 1))) throw fail('INVALID_ARGUMENTS', 'node and selection need target node_ids (one for node).');
      if (mode === 'items' && (!args.node_id || !args.items?.length)) throw fail('INVALID_ARGUMENTS', 'items needs node_id and non-empty items.');
      if ((args.node_ids || []).some((id) => !ids.has(id)) || (args.node_id && !ids.has(args.node_id))) throw fail('INVALID_ARGUMENTS', 'An unknown node id was given. Read the open workflow graph first.');
      if ((mode === 'all' && (args.node_ids || args.node_id || args.items)) || (['node', 'selection'].includes(mode) && (args.node_id || args.items)) || (mode === 'items' && args.node_ids)) throw fail('INVALID_ARGUMENTS', 'Target arguments do not match the run mode.');
      const options = { mode, ...(args.node_ids ? { nodeIds: args.node_ids } : {}), ...(args.node_id ? { nodeId: args.node_id } : {}), ...(args.items ? { items: args.items } : {}), force: args.force === true };
      const view = await svc().estimate(viewer, workflowId, options);
      const targets = view.steps.filter((step) => step.runs).map((step) => ({ id: step.nodeId, label: short(step.label) }));
      if (signal?.aborted) throw fail('ASSISTANT_DEADLINE', 'The question deadline was reached.');
      state.run = { ...options, nodes: targets, estimate: { paid: view.paid, usd: view.totals.usd, credits: view.totals.credits, unknownNodes: view.totals.unknownNodes, willRun: view.totals.runSteps } };
      return { prepared: true, run: state.run, problems: view.blockers, message: 'Prepared only. The person starts this run by clicking in the app and sees the cost there. Nothing has started.' };
    }
    if (policy.mode === 'confirm') {
      if (state.confirm.length >= 3) throw fail('ACTION_LIMIT', 'At most three confirmations may be prepared per answer.');
      const facts = await prepareFacts(name, args);
      if (signal?.aborted) throw fail('ASSISTANT_DEADLINE', 'The question deadline was reached.');
      const action = actions.issue({ viewer, workflowId, tool: name, args, facts });
      state.confirm.push(action);
      return { prepared: true, ...action, message: 'Prepared only. Nothing has changed. The person must click to execute this action.' };
    }
    if (name === 'get_run') {
      // A run id never grants access to another workflow, even one the person also owns.
      const run = await svc().status(viewer, args.run_id, { workflowId });
      if (run.workflowId !== workflowId) throw fail('RUN_NOT_FOUND', 'This run does not belong to the open workflow.');
    }
    return tool.handler(args, context);
  }

  return {
    tools, state,
    async call(name, args) {
      try {
        const result = await (POLICY[name]?.mode === 'edit' ? execute(name, args) : readWithSignal(context, () => execute(name, args)));
        state.steps.push({ tool: name, ok: true });
        return { ok: true, result };
      } catch (err) {
        state.steps.push({ tool: tools.some((tool) => tool.name === name) ? name : 'unknown', ok: false });
        return { ok: false, error: { code: err.code || 'TOOL_ERROR', message: err.message || 'The tool failed.' } };
      }
    },
    async executeAction(entry) {
      const tool = shared.find((item) => item.name === entry.tool);
      if (POLICY[entry.tool]?.mode !== 'confirm') throw fail('ACTION_EXPIRED', 'This action is unavailable.');
      // All original service checks run again in the shared handler; browser/model cannot supply these flags.
      const args = { ...entry.args };
      if (Object.hasOwn(tool.inputSchema.properties, 'confirm')) args.confirm = true;
      if (Object.hasOwn(tool.inputSchema.properties, 'consent')) args.consent = true;
      return tool.handler(args, context);
    }
  };
}
module.exports = { POLICY, EXCEPTIONS, ASSISTANT_ONLY, assertParity, createAssistantTools, editChanges };
