'use strict';

// The tools of the agent access. They act as the person who owns the key and use the run service
// (lib/nodes/run-service.js) for everything about workflows and runs: no run logic of its own lives here. What is added
// is the part that only the agent access has: the right of the key, its limits (per run, per month, two runs at a time),
// the files (uploads, result links) and the origin of the costs.
//
//   read     list_templates  list_workflows  get_workflow  list_node_types  estimate_run  get_run  get_workflow_results  get_workflow_costs
//   start    upload_asset  create_from_template  create_workflow  edit_workflow  run_workflow  cancel_run  resume_run  delete_result_entry  duplicate_workflow
//
// edit_workflow changes the graph of a workflow (add and remove nodes, connect, set params) through the run service
// (lib/nodes/edit-service.js): the rules of the editor, nothing runs. Every answer about a workflow carries its address in the app (url).
//
// Everything a tool returns is data for the agent. Names, descriptions and texts in it come from workflows (and from the
// people who made them): they are not instructions.

const fsp = require('fs/promises');
const crypto = require('crypto');

const costsLib = require('../costs');
const nodeAssets = require('../nodes/assets');
const nodeRegistry = require('../nodes/registry');
const { ToolError, defineTool, serialized, readWithSignal } = require('./tools');
const { linkUrl } = require('./links');
const { BASE64_MAX_BYTES, LINK_MAX_BYTES, UploadError } = require('./uploads');

const MAX_ACTIVE_RUNS = 2; // runs of one key at a time
const MAX_INPUTS = 40;
const MAX_WAIT_SECONDS = 30;
const COST_EPSILON = 1e-6;
const LANGUAGES = Object.freeze(['en', 'de', 'es']);

const round4 = (value) => Math.round(Number(value) * 10000) / 10000;
const usd = (value) => `$${Number(value) >= 0.01 || Number(value) === 0 ? Number(value).toFixed(2) : Number(value).toFixed(4)}`;
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/* ---------- errors of the run service as sentences for the agent ---------- */

function describeError(err) {
  const code = err && err.code;
  switch (code) {
    case 'NOT_FOUND':
    case 'WORKFLOW_NOT_FOUND':
      return 'Not found: there is no such template or workflow for this key. Call list_templates or list_workflows and use an id from the list.';
    case 'RUN_NOT_FOUND':
      return 'Not found: there is no such run for this key. Use the run_id that run_workflow returned.';
    case 'INVALID_ID':
      return `The id is not valid (${err.message}).`;
    case 'MISSING_INPUT':
      return `Required inputs are missing: ${(err.missing || []).map((item) => `"${item.label}" (${item.id}, ${item.type}${item.list ? ' list' : ''})`).join(', ')}. Give them in "inputs" (key = id or label).`;
    case 'INVALID_INPUT':
      if (err.reason === 'no_source') return `${err.message.replace(/files can only be taken from a chat; sourceSessionId is missing/, 'no file has been uploaded with this key yet')}. Call upload_asset first and give the asset_id.`;
      if (err.reason === 'asset_not_found') return `${err.message.replace('does not exist in this chat', 'was not uploaded with this key')}. Use the asset_id that upload_asset returned.`;
      return `An input is not valid: ${err.message}`;
    case 'ENTRY_NOT_FOUND':
      return 'The result entry was not found. Read get_workflow_results and use its entry_id.';
    case 'INVALID_REQUEST':
      if (err.message === 'Run is not awaiting approval') return 'The run is not waiting for approval.';
      return `The request is not valid: ${err.message}`;
    case 'NODE_UNAVAILABLE':
    case 'INVALID_GRAPH':
      return `The workflow cannot run: ${err.message}`;
    case 'FORBIDDEN_FOR_ROLE':
      return err.feature === 'higgsfield' ? 'The workflow contains Higgsfield steps, which are not available through agent access.' : `This account cannot use ${err.feature || 'this resource'} through agent access: ${err.message}`;
    case 'COST_CHANGED':
      return `The cost of the run changed (now about ${usd(err.estimateUsd ?? 0)}) and is higher than the amount that was accepted. Call estimate_run and run_workflow again with a new max_usd. Nothing was started.`;
    case 'CONFIRMATION_REQUIRED':
      return 'The run has paid steps and needs max_usd. Nothing was started.';
    case 'RUN_ACTIVE':
      return 'A run of this workflow is already active. Wait for it (get_run) or cancel it (cancel_run).';
    case 'RUN_LIMIT':
      return 'The app is running as many runs as it allows at the moment. Try again in a few minutes.';
    case 'REV_CONFLICT':
      return `The workflow was changed in the meantime${Number.isInteger(err.rev) ? ` (it is at rev ${err.rev} now)` : ''}. Read it again (get_workflow, estimate_run) and repeat the call.`;
    case 'INVALID_EDIT':
      return `The workflow was not changed. ${err.message}`;
    case 'INVALID_WORKFLOW':
      return `The workflow was not changed: ${err.message}`;
    case 'BUDGET_EXHAUSTED':
    case 'BUDGET_INSUFFICIENT':
    case 'BUDGET_JOBS_OPEN':
      return `The budget of the person this key belongs to does not allow this: ${err.message} Nothing was started.`;
    case 'LOGIN_UNCONFIRMED':
      return 'The person behind this key could not be confirmed right now. Try again later.';
    case 'UNAVAILABLE':
      return 'The run service is not available at the moment.';
    case 'UNSUPPORTED_MEDIA':
      return `${err.message}`;
    default:
      return null;
  }
}

/* ---------- small views ---------- */

function briefInput(input) {
  return {
    id: input.id,
    label: input.label,
    type: input.type,
    ...(input.list ? { list: true } : {}),
    required: Boolean(input.required),
    ...(input.hasValue !== undefined ? { has_value: Boolean(input.hasValue) } : {}),
    ...(input.options ? { options: input.options } : {}),
    ...(input.min !== undefined ? { min: input.min } : {}),
    ...(input.max !== undefined ? { max: input.max } : {}),
    ...(input.integer ? { integer: true } : {})
  };
}

function briefCost(cost, usesHiggsfield) {
  const out = { kind: cost.kind, paid: Boolean(cost.paid), estimate_usd: cost.usd };
  if (cost.kind === 'partial') out.note = 'estimate_usd is what is known; other paid steps have no price yet, so agent access will not start a run of it';
  if (cost.kind === 'unknown') out.note = 'the price of the paid steps is not known; agent access will not start a run of it';
  if (usesHiggsfield) {
    out.runnable_by_agent = false;
    out.note = 'contains Higgsfield steps, which are not available through agent access';
  }
  return out;
}

function briefItem(item) {
  return {
    id: item.id,
    ...(item.kind === 'template' ? {} : { origin: item.origin }),
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    inputs: item.inputs.map(briefInput),
    outputs: item.outputs.map((output) => output.label),
    cost: briefCost(item.cost, item.usesHiggsfield),
    ...(item.available === false ? { available: false, missing: item.missing } : {}),
    ...(item.updatedAt ? { updated_at: item.updatedAt } : {})
  };
}

const schemaId = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
// The engine validates the combinations and target ids; keep the same request for plan and start.
const runProperties = {
  mode: { type: 'string', enum: ['all', 'node', 'selection', 'items'], description: 'Default all. Use node or selection to run only target nodes and their predecessors; items remakes chosen list items.' },
  node_ids: { type: 'array', items: schemaId, description: 'Target node ids for node or selection (usually one for node).' },
  node_id: { ...schemaId, description: 'The node whose list items should be remade (mode items).' },
  items: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'List item indices to remake, starting at 0 (mode items).' },
  force: { type: 'boolean', description: 'Recompute target nodes even with cached results, for example after an app code change. No effect for items.' }
};
const runOptions = (args) => ({ mode: args.mode || 'all', nodeIds: args.node_ids, nodeId: args.node_id, items: args.items, force: args.force });
const partialRunDescription = ' Use mode node or selection to recompute one node instead of everything; force also recomputes a cached target, for example after an app code change. Use mode items for individual list items.';

const schemaEndpoint = {
  type: 'object',
  properties: { node: { type: 'string', minLength: 1, maxLength: 32, description: 'Id of a node, or the ref of a node added in this call.' }, port: { type: 'string', minLength: 1, maxLength: 32, description: 'Id of the port.' } },
  required: ['node', 'port'],
  additionalProperties: false
};
const NODE_CATEGORIES = Object.freeze(['input', 'llm', 'text', 'image', 'video', 'audio', 'edit-image', 'edit-video', 'edit-audio', 'magnific', 'fal', 'utility', 'output']);

// The address of a workflow in the app (the node view opens it).
const workflowUrl = (context, id) => linkUrl(context.publicBase, `/#w=${encodeURIComponent(id)}`);

function createWorkflowTools({ service, accounting, uploads, fileLinks, uploadLinks, costs = costsLib, assets = nodeAssets } = {}) {
  const svc = typeof service === 'function' ? service : () => service;

  const isHiggsfieldStep = (step) => Boolean(step && nodeRegistry.isRestricted(svc().registry.get(step.type)));

  // Result files as links; text and numbers as they are.
  async function withLinks(items, context) {
    const out = [];
    for (const item of items || []) {
      if (item.type === 'text') {
        out.push({ type: 'text', text: item.text, length: item.length });
      } else if (item.type === 'number') {
        out.push({ type: 'number', value: item.value });
      } else {
        let signed = null;
        if (context.app !== true) {
          try {
            const value = await assets.valueFromAsset(item.sessionId, item.assetId);
            signed = fileLinks.sign({ sessionId: item.sessionId, file: value.file });
          } catch (_) {
            signed = null;
          }
        }
        out.push({
          type: item.type,
          asset_id: item.assetId,
          ...(signed ? { url: linkUrl(context.publicBase, `/mcp/files/${signed.token}`), expires_at: signed.expiresAt } : context.app === true ? {} : { available: false }),
          ...(item.duration !== undefined ? { duration_seconds: item.duration } : {}),
          ...(Number.isFinite(item.costUsd) ? { cost_usd: item.costUsd } : {})
        });
      }
    }
    return out;
  }

  async function resultsWithLinks(groups, context) {
    const out = [];
    for (const group of groups || []) out.push({ label: group.label, items: await withLinks(group.items, context) });
    return out;
  }

  /* ----- the plan and the limits of the key ----- */

  // The sentences why a run may not start with this key (empty: it may). maxUsd: the amount the agent accepts (optional).
  // authenticate supplies effective limits, including current participant ceilings. The service/engine keeps the
  // independent team budget authoritative; a key never adds credit or grants access to internal resources.
  async function checkRun(view, key, maxUsd = null) {
    const problems = [];
    const add = (code, message) => problems.push({ code, message });
    if (key.right !== 'start') add('READ_ONLY', 'This key may only read; starting a run needs a key with the right "read and start".');
    const higgsfield = view.steps.filter(isHiggsfieldStep);
    if (higgsfield.length) add('HIGGSFIELD_BLOCKED', `The workflow contains Higgsfield steps (${higgsfield.map((step) => `"${step.label}"`).join(', ')}). Higgsfield is not available through agent access.`);
    if (view.totals.credits > COST_EPSILON && !higgsfield.length) {
      add('CREDITS_BLOCKED', 'Steps of this workflow are priced in credits. Agent access starts only runs priced in USD.');
    }
    for (const blocker of view.blockers) {
      if (blocker.code === 'FORBIDDEN_FOR_ROLE') {
        if (!higgsfield.length) add('FORBIDDEN_FOR_ROLE', `This account cannot use ${blocker.feature || 'this resource'}: ${blocker.message}`);
      } else if (blocker.code === 'BUDGET_EXHAUSTED' || blocker.code === 'BUDGET_INSUFFICIENT') {
        add(blocker.code, `The budget of the person this key belongs to does not cover the run (${blocker.message}; ${usd(blocker.remainingUsd ?? 0)} left, estimate ${usd(blocker.estimateUsd ?? view.totals.usd)}).`);
      } else if (blocker.code === 'RUN_ACTIVE') {
        add('RUN_ACTIVE', 'A run of this workflow is already active. Wait for it (get_run) or cancel it (cancel_run).');
      } else {
        add(blocker.code, `The workflow cannot run: ${blocker.message}`);
      }
    }
    if (view.totals.unknownNodes > 0) {
      const names = view.steps.filter((step) => step.runs && step.paid && step.usd === null).map((step) => `"${step.label}"`);
      add('UNKNOWN_COST', `${view.totals.unknownNodes} paid step(s) have no known price${names.length ? ` (${names.join(', ')})` : ''}. Agent access starts only runs whose cost is known.`);
    }
    const estimate = view.totals.usd;
    if (maxUsd !== null && estimate > maxUsd + COST_EPSILON) {
      add('OVER_MAX_USD', `The estimate is ${usd(estimate)}, more than the max_usd of ${usd(maxUsd)}. Raise max_usd (at least ${usd(estimate)}) if that is acceptable.`);
    }
    if (estimate > key.maxRunUsd + COST_EPSILON) {
      add('OVER_RUN_LIMIT', `The estimate is ${usd(estimate)}, more than the limit of ${usd(key.maxRunUsd)} per run set for this key. The owner can raise the limit in the app.`);
    }
    const usage = await accounting.monthUsage(key.id);
    if (estimate > 0 && usage.spentUsd + usage.reservedUsd + estimate > key.maxMonthUsd + COST_EPSILON) {
      add(
        'OVER_MONTH_LIMIT',
        `The run (estimate ${usd(estimate)}) would exceed the limit of ${usd(key.maxMonthUsd)} per month set for this key: ${usd(usage.spentUsd)} booked this month, ${usd(usage.reservedUsd)} reserved for runs in progress.`
      );
    }
    if (accounting.activeCount(key.id) >= MAX_ACTIVE_RUNS) {
      add('TOO_MANY_RUNS', `This key already has ${MAX_ACTIVE_RUNS} runs in progress. Wait for one to finish (get_run) or cancel one (cancel_run).`);
    }
    return { problems, usage };
  }

  function planSummary(view) {
    return {
      mode: view.mode,
      node_ids: view.targets,
      valid: view.valid,
      paid: view.paid,
      estimate_usd: view.totals.usd,
      estimate_complete: view.totals.usdKnown,
      steps_to_run: view.totals.runSteps,
      steps_cached: view.totals.cachedSteps,
      paid_steps: view.steps.filter((step) => step.runs && step.paid).map((step) => ({ node_id: step.nodeId, label: step.label, type: step.type, estimate_usd: step.usd })),
      steps: view.steps.filter((step) => step.runs).map((step) => ({ node_id: step.nodeId, label: step.label, type: step.type, paid: step.paid, estimate_usd: step.usd })),
      up_to_date: view.upToDate
    };
  }

  function agentSummary(key, check, view) {
    return {
      right: key.right,
      max_run_usd: key.maxRunUsd,
      month_limit_usd: key.maxMonthUsd,
      month_booked_usd: round4(check.usage.spentUsd),
      month_reserved_usd: round4(check.usage.reservedUsd),
      runs_in_progress: accounting.activeCount(key.id),
      can_start: check.problems.length === 0,
      ...(check.problems.length ? { problems: check.problems.map((problem) => problem.message) } : {}),
      suggested_max_usd: Math.ceil(view.totals.usd * 100 - 1e-9) / 100
    };
  }

  const problemsText = (problems, extra = '') => `The run was not started. ${problems.map((problem) => problem.message).join(' ')}${extra} Nothing was charged.`;

  /* ----- tools ----- */

  const listTemplates = defineTool({
    name: 'list_templates',
    title: 'List templates',
    description:
      'Lists the workflow templates you can start from, with their inputs (id, label, type), their outputs and what a run costs (estimate in USD, or the reason it is not known). ' +
      'Use create_from_template with a template id to get a workflow of your own.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 80, description: 'Only templates whose name or description contains this text.' },
        language: { type: 'string', enum: LANGUAGES, description: 'Language of the names and labels (default en).' }
      },
      additionalProperties: false
    },
    right: 'read',
    handler: async (args, { viewer }) => {
      const list = await svc().listRunnable(viewer, { ...(args.query ? { query: args.query } : {}), lang: args.language || 'en', limit: 100 });
      const templates = list.items.filter((item) => item.kind === 'template').map((item) => briefItem(item));
      return { templates, count: templates.length };
    }
  });

  const listWorkflows = defineTool({
    name: 'list_workflows',
    title: 'List workflows',
    description:
      'Lists the workflows of the person this key belongs to and the workflows shared with them (origin "own" or "shared"), with inputs, outputs and the cost of a run. ' +
      'Use the id with get_workflow, estimate_run or run_workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 80, description: 'Only workflows whose name or description contains this text.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'At most this many (default 50).' }
      },
      additionalProperties: false
    },
    right: 'read',
    handler: async (args, context) => {
      const list = await svc().listRunnable(context.viewer, { ...(args.query ? { query: args.query } : {}), lang: 'en', limit: 100 });
      const limit = args.limit || 50;
      const all = list.items.filter((item) => item.kind === 'workflow');
      return { workflows: all.slice(0, limit).map((item) => ({ ...briefItem(item), url: workflowUrl(context, item.id) })), count: Math.min(all.length, limit), more: all.length > limit || list.truncated };
    }
  });

  const getWorkflow = defineTool({
    name: 'get_workflow',
    title: 'Get a workflow',
    description:
      'Shows one workflow: its address in the app (url), its steps (nodes), the inputs you can set, the outputs it makes and the results it holds now (as download links, valid for 24 hours). ' +
      'With include_graph the answer also has the graph: every node with its params and ports and what each input is connected to, and the connections (edges). Read it before edit_workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { ...schemaId, description: 'The id from list_workflows or create_from_template.' },
        include_graph: { type: 'boolean', description: 'Also return the graph (nodes with params and ports, edges).' },
        text_chars: { type: 'integer', minimum: 1, maximum: 20000, description: 'With include_graph: how much of a text param to return (default 300 characters).' }
      },
      required: ['workflow_id'],
      additionalProperties: false
    },
    right: 'read',
    handler: async (args, context) => {
      const found = await svc().describeWorkflow(context.viewer, args.workflow_id);
      const graph = args.include_graph ? await svc().describeGraph(context.viewer, args.workflow_id, { ...(args.text_chars ? { textChars: args.text_chars } : {}) }) : null;
      return {
        id: found.id,
        url: workflowUrl(context, found.id),
        name: found.name,
        ...(found.description ? { description: found.description } : {}),
        origin: found.origin,
        rev: found.rev,
        updated_at: found.updatedAt,
        steps: found.nodes.map((node) => ({ id: node.id, type: node.type, label: node.label })),
        inputs: found.inputs.map(briefInput),
        outputs: found.outputs.map((output) => output.label),
        cost: briefCost(found.cost, context.app !== true && found.usesHiggsfield),
        run_in_progress: Boolean(found.activeRun),
        ...(context.app === true && found.activeRun?.runId ? { run_id: found.activeRun.runId } : {}),
        latest_results: await resultsWithLinks(found.lastResults, context),
        ...(graph ? { graph: { nodes: graph.nodes, edges: graph.edges } } : {})
      };
    }
  });

  const estimateRun = defineTool({
    name: 'estimate_run',
    title: 'Estimate a run',
    description:
      'Estimates what a run of the workflow would cost now (the same estimate the app shows), which steps are paid and what would stop the run, including the limits of this key. ' +
      'Nothing is started. Use the estimate as the basis for max_usd in run_workflow.' + partialRunDescription,
    inputSchema: {
      type: 'object',
      properties: {
        ...runProperties,
        workflow_id: { ...schemaId, description: 'The id from list_workflows or create_from_template.' },
        max_usd: { type: 'number', minimum: 0, maximum: 100000, description: 'Optional: the amount you would accept; the answer then says whether the estimate fits.' }
      },
      required: ['workflow_id'],
      additionalProperties: false
    },
    right: 'read',
    handler: async (args, context) => {
      const { key, viewer } = context;
      const view = await svc().estimate(viewer, args.workflow_id, runOptions(args));
      if (context.app === true) return { workflow_id: view.workflowId, url: workflowUrl(context, view.workflowId), name: view.name, rev: view.rev,
        ...planSummary(view), credits: view.totals.credits, unknown_nodes: view.totals.unknownNodes,
        budget: view.budget, can_start: view.canStart, problems: view.blockers };
      const check = await checkRun(view, key, typeof args.max_usd === 'number' ? args.max_usd : null);
      return { workflow_id: view.workflowId, url: workflowUrl(context, view.workflowId), name: view.name, rev: view.rev, ...planSummary(view), agent: agentSummary(key, check, view) };
    }
  });

  const getRun = defineTool({
    name: 'get_run',
    title: 'Get a run',
    description:
      'Shows the state of a run: status, progress, the cost so far and, when it has finished, the results (files as download links valid for 24 hours, texts and numbers). ' +
      'With wait_seconds the call waits for the run to finish (at most 30 seconds) and returns as soon as it has.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { ...schemaId, description: 'The run_id that run_workflow returned.' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'Wait up to this long for the run to finish.' },
        text_chars: { type: 'integer', minimum: 1, maximum: 20000, description: 'How much of a text result to return (default 400 characters).' }
      },
      required: ['run_id'],
      additionalProperties: false
    },
    right: 'read',
    handler: async (args, context) => {
      const options = { ...(args.text_chars ? { textChars: args.text_chars } : {}) };
      let run = await svc().status(context.viewer, args.run_id, options);
      if (!run.finished && args.wait_seconds > 0) {
        const waiting = svc().waitForRun(context.viewer, args.run_id, options).catch(() => null);
        const controller = new AbortController();
        context.signal?.addEventListener('abort', () => controller.abort(), { once: true });
        await Promise.race([waiting, sleep(args.wait_seconds * 1000, controller.signal)]);
        controller.abort();
        run = await svc().status(context.viewer, args.run_id, options);
      }
      return {
        run_id: run.runId,
        workflow_id: run.workflowId,
        workflow_url: workflowUrl(context, run.workflowId),
        workflow_name: run.workflowName,
        status: run.status,
        finished: run.finished,
        started_at: run.startedAt,
        ...(run.finishedAt ? { finished_at: run.finishedAt } : {}),
        duration_ms: run.durationMs,
        progress: run.step,
        ...(run.running.length ? { running: run.running } : {}),
        cost_usd: run.cost.usd,
        ...(run.error ? { error: run.error } : {}),
        ...(run.failures.length ? { failures: run.failures.map((item) => ({ label: item.label, message: item.message, code: item.code })) } : {}),
        ...(run.status === 'awaiting_approval' && run.approval ? { approval: {
          node: run.approval.nodeId, label: run.nodes.find((node) => node.nodeId === run.approval.nodeId)?.label || run.approval.nodeId,
          estimated_usd: run.approval.estimatedUsd, required_usd: run.approval.requiredUsd, max_usd: run.approval.maxUsd
        }, next: 'Ask the person to approve the higher amount, then call resume_run with a higher max_usd, or cancel_run.' } : {}),
        ...(run.outputs ? { results: await resultsWithLinks(run.outputs, context) } : {})
      };
    }
  });

  const uploadAsset = defineTool({
    name: 'upload_asset',
    title: 'Upload a file',
    description:
      'Brings an image, a video, an audio file or a document (PDF, text) into the app so it can be an input of a workflow (create_from_template or run_workflow: give the asset_id as the value of a media or document input). ' +
      `Small files (up to ${BASE64_MAX_BYTES / (1024 * 1024)} MB): send data_base64. Larger files (up to ${LINK_MAX_BYTES / (1024 * 1024)} MB): leave data_base64 out and you get a one-time upload link; ` +
      'send the file as the body of an HTTP PUT to it within 15 minutes (for example curl -T file URL); the answer of the PUT carries the asset_id. ' +
      'Allowed: png, jpg, webp, gif, svg (becomes a PNG), mp4, webm, mp3, wav, m4a, aac, and the documents pdf, txt, md (up to 50 MB each; a PDF must start with %PDF-).',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', minLength: 1, maxLength: 200, description: 'The name of the file, with its extension.' },
        mime_type: { type: 'string', maxLength: 100, description: 'The media type, for example image/png (optional if the name has the extension).' },
        data_base64: { type: 'string', description: 'The file, base64-encoded. Leave out to get an upload link for a large file.' },
        size_bytes: { type: 'integer', minimum: 1, description: 'Optional, for the upload link: the size of the file, so a file that is too large is refused at once.' }
      },
      required: ['filename'],
      additionalProperties: false
    },
    right: 'start',
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (args, context) => {
      const { key, viewer } = context;
      try {
        if (typeof args.data_base64 !== 'string') {
          const resolved = uploads.resolveType(args.filename, args.mime_type);
          if (args.size_bytes > LINK_MAX_BYTES) throw new ToolError(`The file is larger than ${LINK_MAX_BYTES / (1024 * 1024)} MB, the limit for uploads.`);
          await uploads.checkQuota(key, args.size_bytes || 0); // no link for a key that has no room left
          const issued = uploadLinks.issue({ keyId: key.id, filename: args.filename, mimeType: args.mime_type || '' });
          if (issued.error) throw new ToolError('This key has too many upload links open. Use them or wait until they expire (15 minutes).');
          return {
            mode: 'upload_link',
            method: 'PUT',
            upload_url: linkUrl(context.publicBase, `/mcp/upload/${issued.token}`),
            expires_at: issued.expiresAt,
            max_bytes: uploads.limitFor(resolved, LINK_MAX_BYTES),
            single_use: true,
            instructions: 'Send the file as the body of a PUT to upload_url (for example: curl -T <file> <upload_url>). The JSON answer has the asset_id. The link works once; ask again for another file.'
          };
        }
        const text = args.data_base64.replace(/^data:[^,]{0,100};base64,/i, '');
        if (text.length > Math.ceil(BASE64_MAX_BYTES / 3) * 4 + 8) {
          throw new ToolError(`The file is larger than ${BASE64_MAX_BYTES / (1024 * 1024)} MB. Call upload_asset without data_base64 to get an upload link for larger files.`);
        }
        if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(text)) throw new ToolError('data_base64 is not valid base64.');
        const buffer = Buffer.from(text, 'base64');
        if (buffer.length > BASE64_MAX_BYTES) {
          throw new ToolError(`The file is larger than ${BASE64_MAX_BYTES / (1024 * 1024)} MB. Call upload_asset without data_base64 to get an upload link for larger files.`);
        }
        const saved = await uploads.save({
          key,
          viewer,
          filename: args.filename,
          mimeType: args.mime_type || '',
          limitBytes: BASE64_MAX_BYTES,
          expectedBytes: buffer.length,
          write: async (file) => {
            await fsp.writeFile(file, buffer, { flag: 'wx' });
            return buffer.length;
          }
        });
        return {
          mode: 'uploaded',
          asset_id: saved.assetId,
          type: saved.type,
          bytes: saved.bytes,
          ...(saved.rasterized ? { note: 'The SVG was made a PNG; the asset is the PNG.' } : {}),
          next: 'Give the asset_id as the value of a media input in create_from_template or run_workflow.'
        };
      } catch (err) {
        if (err instanceof UploadError) throw new ToolError(err.message);
        throw err;
      }
    }
  });

  const createFromTemplate = defineTool({
    name: 'create_from_template',
    title: 'Create a workflow from a template',
    description:
      'Makes a workflow of your own from a template and fills in its inputs (key = id or label of the input, value = text, number, true/false, a choice, or the asset_id of an uploaded file). ' +
      'Nothing runs and nothing is charged. The answer has the address of the workflow in the app (url) and the estimate; start it with run_workflow. ' +
      'Required inputs you leave out do not stop the creation: the workflow is made as a draft, the answer lists them in missing_inputs, and you give them later in run_workflow or replace them with edit_workflow ' +
      '(for example connect the output of another node where a file was expected). ' +
      'A language input has the choice "auto": the text is then written in the language of the topic, brief or document the person gave (leave it as it is unless another language is wanted).',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { ...schemaId, description: 'The id from list_templates.' },
        file_marks: { type: 'object', additionalProperties: { type: ['string', 'null'], enum: ['never', 'always', 'auto', null] }, description: 'Optional per-file AI marks for app inputs with marks: asset_id or session_id/asset_id (wf/asset_id for existing workflow files) to never or always. Use auto or null to clear a mark; omitted files stay unchanged. Unknown files are refused.' },
        inputs: { type: 'object', description: 'The values of the inputs.' },
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'A name for the new workflow (default: the name of the template).' },
        language: { type: 'string', enum: LANGUAGES, description: 'Language of the labels (default en).' }
      },
      required: ['template_id'],
      additionalProperties: false
    },
    right: 'start',
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (args, context) => {
      const { key, viewer } = context;
      if (args.inputs && Object.keys(args.inputs).length > MAX_INPUTS) throw new ToolError(`inputs has too many entries (at most ${MAX_INPUTS}).`);
      if (!accounting.mayCreateWorkflow(key.id)) {
        throw new ToolError('This key has made 30 workflows in the last hour. Reuse one (list_workflows, run_workflow with inputs) or wait.');
      }
      const prepared = await svc().prepare(viewer, {
        templateId: args.template_id,
        inputs: args.inputs || {},
        fileMarks: args.file_marks,
        sourceSessionId: uploads.peek(key.id) || undefined,
        ...(args.name ? { name: args.name } : {}),
        lang: args.language || 'en',
        requireStartable: true,
        allowMissing: true
      });
      accounting.noteWorkflowCreated(key.id);
      const check = await checkRun(prepared.plan, key);
      const missing = Array.isArray(prepared.missing) ? prepared.missing : [];
      const draft = missing.length > 0;
      return {
        workflow_id: prepared.workflowId,
        url: workflowUrl(context, prepared.workflowId),
        name: prepared.name,
        template_id: prepared.templateId,
        rev: prepared.rev,
        inputs: prepared.inputs.map((input) => ({
          ...briefInput(input),
          set: Boolean(input.applied),
          ...(input.type === 'text' && input.value ? { value: input.value.text } : {}),
          ...(['number', 'boolean', 'select', 'tags'].includes(input.type) ? { value: input.value } : {})
        })),
        outputs: prepared.outputs.map((output) => output.label),
        estimate: planSummary(prepared.plan),
        agent: agentSummary(key, check, prepared.plan),
        ...(draft ? { draft: true, missing_inputs: missing.map((item) => ({ id: item.id, label: item.label, type: item.type, ...(item.list ? { list: true } : {}) })) } : {}),
        next: draft
          ? 'The workflow is a draft: required inputs are missing (missing_inputs). Give them in "inputs" of run_workflow, or change the workflow with edit_workflow (get_workflow with include_graph shows the graph).'
          : 'Start it with run_workflow (workflow_id and max_usd of at least the estimate).'
      };
    }
  });

  const runWorkflow = defineTool({
    name: 'run_workflow',
    title: 'Run a workflow',
    description:
      'Starts a run of a workflow and returns its run_id; follow it with get_run. max_usd is required: the most you accept to pay for this run. ' +
      'The run is refused, and nothing is charged, when the estimate is above max_usd or above the limit per run of this key, when it would exceed the monthly limit of this key, ' +
      'when a paid step has no known price, when it contains Higgsfield steps, when this key already has two runs in progress, or when the budget of the person does not cover it. ' +
      'Optional inputs are set in the workflow before it starts (same format as create_from_template).' + partialRunDescription,
    inputSchema: {
      type: 'object',
      properties: {
        ...runProperties,
        workflow_id: { ...schemaId, description: 'The id from list_workflows or create_from_template.' },
        max_usd: { type: 'number', minimum: 0, maximum: 100000, description: 'The most you accept to pay, in USD (0 for a free workflow). Take it from estimate_run.' },
        file_marks: { type: 'object', additionalProperties: { type: ['string', 'null'], enum: ['never', 'always', 'auto', null] }, description: 'Optional per-file AI marks for app inputs with marks: asset_id or session_id/asset_id (wf/asset_id for existing workflow files) to never or always. Use auto or null to clear a mark; omitted files stay unchanged. Unknown files are refused.' },
        inputs: { type: 'object', description: 'Optional values for the inputs, saved in the workflow before the run.' }
      },
      required: ['workflow_id', 'max_usd'],
      additionalProperties: false
    },
    right: 'start',
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args, context) => {
      const { key, viewer } = context;
      const hasInputs = (args.inputs && Object.keys(args.inputs).length > 0) || args.file_marks !== undefined;
      if (args.inputs && Object.keys(args.inputs).length > MAX_INPUTS) throw new ToolError(`inputs has too many entries (at most ${MAX_INPUTS}).`);
      return accounting.serialize(key.id, async () => {
        // the checks and the start belong together: a second start of this key waits for them
        const service = svc();
        let view;
        if (hasInputs) {
          const prepared = await service.prepare(viewer, { workflowId: args.workflow_id, inputs: args.inputs, fileMarks: args.file_marks, sourceSessionId: uploads.peek(key.id) || undefined, requireStartable: (args.mode || 'all') === 'all' });
          view = args.force === true || (args.mode && args.mode !== 'all') ? await service.estimate(viewer, prepared.workflowId, runOptions(args)) : prepared.plan;
        } else {
          view = await service.estimate(viewer, args.workflow_id, runOptions(args));
        }
        const check = await checkRun(view, key, args.max_usd);
        if (check.problems.length) {
          throw new ToolError(problemsText(check.problems, hasInputs ? ' The inputs you gave were saved in the workflow.' : ''), { codes: check.problems.map((problem) => problem.code) });
        }
        const request = view.paid
          ? { maxUsd: Math.min(args.max_usd, key.maxRunUsd), maxCredits: 0, maxUnknownNodes: 0, rev: view.rev }
          : { requireFree: true, maxUsd: Math.min(args.max_usd, key.maxRunUsd), maxUnknownNodes: 0, rev: view.rev };
        Object.assign(request, runOptions(args));
        const reservationId = crypto.randomUUID();
        let origin;
        const started = await costs.withVia({ keyId: key.id, keyName: key.name, reservationId, reservationUsd: view.paid ? view.totals.usd : 0 }, () => {
          origin = costs.currentVia?.();
          return service.start(viewer, view.workflowId, request);
        });
        accounting.begin(key.id, started.runId, started.paid ? started.totals.usd : 0, reservationId, origin);
        service
          .waitForRun(viewer, started.runId)
          .then((run) => accounting.end(started.runId, run.status))
          .catch(() => accounting.end(started.runId, 'error'));
        return {
          run_id: started.runId,
          workflow_id: started.workflowId,
          url: workflowUrl(context, started.workflowId),
          name: started.name,
          status: 'running',
          mode: started.mode,
          node_ids: started.targets,
          paid: started.paid,
          estimate_usd: started.totals.usd,
          max_usd: args.max_usd,
          next: 'Follow it with get_run (wait_seconds lets the call wait for the end). Results come as download links.'
        };
      });
    }
  });

  const cancelRun = defineTool({
    name: 'cancel_run',
    title: 'Cancel a run',
    description:
      'Asks a run that this key started to stop. Steps already paid for are charged; provider jobs already submitted may still be billed when they finish.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { ...schemaId, description: 'The run_id that run_workflow returned.' } },
      required: ['run_id'],
      additionalProperties: false
    },
    right: 'start',
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (args, { key, viewer }) => {
      if (accounting.startedBy(args.run_id) !== key.id) {
        throw new ToolError('This run was not started with this key (or the app restarted since). A key cancels only its own runs; use the app for others.');
      }
      const result = await svc().cancel(viewer, args.run_id);
      return {
        run_id: result.runId,
        workflow_id: result.workflowId,
        cancel_requested: result.cancelled,
        status: result.status,
        ...(result.cancelled ? {} : { note: 'The run was not active any more.' })
      };
    }
  });

  /* ----- editing ----- */

  // What stands in the way of a run after a change: the plan of the workflow, as estimate_run gives it (never an error of the edit).
  async function stateAfterEdit(context, workflowId) {
    try {
      const view = await readWithSignal(context, () => svc().estimate(context.viewer, workflowId));
      const check = context.app === true ? { problems: view.blockers } : await checkRun(view, context.key);
      return {
        valid: view.valid,
        estimate_usd: view.totals.usd,
        estimate_complete: view.totals.usdKnown,
        can_start: check.problems.length === 0,
        ...(view.issues.length ? { issues: view.issues.filter((issue) => issue.level === 'error').slice(0, 10).map((issue) => ({ ...(issue.nodeId ? { node: issue.nodeId } : {}), message: issue.message })) } : {}),
        ...(check.problems.length ? { problems: check.problems.map((problem) => problem.message) } : {})
      };
    } catch (err) {
      return { valid: false, can_start: false, problems: [describeError(err) || 'The plan of the workflow could not be made.'] };
    }
  }

  const listNodeTypes = defineTool({
    name: 'list_node_types',
    title: 'List node types',
    description:
      'Lists the node types you can add to a workflow with edit_workflow: type id, label, category, whether it is paid, and its inputs and outputs (port id and type). ' +
      'Give "types" (up to 12 type ids) to also get the params of those types (id, kind, options, range, default) and how params change the ports. ' +
      'An output fits an input of the same base type (a list fits a single value and the other way round), "any" fits everything and a number fits a text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 80, description: 'Only types whose id, label, keywords or description contain this text.' },
        category: { type: 'string', enum: NODE_CATEGORIES, description: 'Only types of this category.' },
        types: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Type ids to describe in full (with params).' }
      },
      additionalProperties: false
    },
    right: 'read',
    handler: async (args, context) => {
      const found = await svc().nodeCatalog(context.viewer, { ...(args.query ? { query: args.query } : {}), ...(args.category ? { category: args.category } : {}), ...(args.types ? { types: args.types } : {}), agent: context.app !== true });
      return {
        node_types: found.nodeTypes,
        count: found.nodeTypes.length,
        ...(found.total > found.nodeTypes.length ? { more: true } : {}),
        ...(found.unknown && found.unknown.length ? { unknown: found.unknown } : {})
      };
    }
  });

  const createWorkflow = defineTool({
    name: 'create_workflow',
    title: 'Create an empty workflow',
    description:
      'Makes an empty workflow of your own and returns its id and its address in the app (url). Build it with edit_workflow. Nothing runs and nothing is charged. ' +
      'To start from something that works, use create_from_template instead and change the result.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 120, description: 'A name for the workflow.' } },
      additionalProperties: false
    },
    right: 'start',
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (args, context) => {
      const { key, viewer } = context;
      if (!accounting.mayCreateWorkflow(key.id)) {
        throw new ToolError('This key has made 30 workflows in the last hour. Reuse one (list_workflows) or wait.');
      }
      const created = await svc().createBlank(viewer, { ...(args.name ? { name: args.name } : {}) });
      accounting.noteWorkflowCreated(key.id);
      return { workflow_id: created.workflowId, url: workflowUrl(context, created.workflowId), name: created.name, rev: created.rev, next: 'Add nodes and connections with edit_workflow (list_node_types shows what there is).' };
    }
  });

  const editWorkflow = defineTool({
    name: 'edit_workflow',
    title: 'Edit a workflow',
    description:
      'Changes the graph of a workflow of the person (or one shared with them), with the rules of the editor in the app: add and remove nodes, connect and disconnect ports, set params and labels, ' +
      'and choose which params are inputs of the workflow. The operations are applied in order and saved together; if one is refused, nothing is changed. Nothing runs and nothing is charged. ' +
      'Read the graph first (get_workflow with include_graph) and the node types (list_node_types). Operations: ' +
      '{"op":"add_node","type":"…","ref":"a","params":{…},"label":"…"} (ref names the new node for later operations of this call; the answer maps it to its id); ' +
      '{"op":"remove_node","node":"n3"} (with its connections); {"op":"set_params","node":"n3","params":{…}}; {"op":"set_label","node":"n3","label":"…"}; ' +
      '{"op":"connect","from":{"node":"a","port":"audio"},"to":{"node":"n5","port":"audio"},"replace":true} (replace rewires an input that takes one connection and is taken); ' +
      '{"op":"disconnect","edge":"e4"} or with "from" and "to", or "to" alone for everything into that input; ' +
      '{"op":"expose_input","node":"n3","param":"text","label":"…"} and {"op":"unexpose_input",…} (the param becomes, or stops being, an input you can set in run_workflow). ' +
      'File params cannot be set here: expose them and give the file in "inputs" of run_workflow. Node types priced in credits (Higgsfield) cannot be added through agent access. ' +
      'The answer says whether the workflow can run now and what is still missing.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { ...schemaId, description: 'The id from list_workflows, create_workflow or create_from_template.' },
        rev: { type: 'integer', minimum: 1, description: 'Optional: the rev you read. The call is refused when the workflow was changed since.' },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 60,
          description: 'The changes, applied in order.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add_node', 'remove_node', 'set_params', 'set_label', 'connect', 'disconnect', 'expose_input', 'unexpose_input'] },
              type: { type: 'string', maxLength: 64, description: 'add_node: the type id from list_node_types.' },
              ref: { type: 'string', maxLength: 32, description: 'add_node: a name for the new node within this call.' },
              node: { type: 'string', maxLength: 32, description: 'Id of a node, or the ref of a node added in this call.' },
              params: { type: 'object', description: 'add_node, set_params: values by param id.' },
              label: { type: 'string', maxLength: 120, description: 'add_node, set_label: the title of the node; expose_input: the label of the input.' },
              x: { type: 'number', description: 'add_node: position on the canvas (optional).' },
              y: { type: 'number', description: 'add_node: position on the canvas (optional).' },
              from: schemaEndpoint,
              to: schemaEndpoint,
              replace: { type: 'boolean', description: 'connect: take the place of the connection of an input that takes one.' },
              edge: { type: 'string', maxLength: 32, description: 'disconnect: the id of the connection.' },
              param: { type: 'string', maxLength: 32, description: 'expose_input, unexpose_input: the id of the param.' },
              optional: { type: 'boolean', description: 'expose_input: the input may stay empty.' }
            },
            required: ['op'],
            additionalProperties: false
          }
        }
      },
      required: ['workflow_id', 'operations'],
      additionalProperties: false
    },
    right: 'start',
    annotations: { destructiveHint: true, idempotentHint: false },
    handler: async (args, context) => {
      const { viewer } = context;
      return serialized(context, accounting, async () => {
        const result = await svc().editWorkflow(viewer, args.workflow_id, { ...(args.rev ? { rev: args.rev } : {}), operations: args.operations, agent: context.app !== true });
        return {
          workflow_id: result.workflowId,
          url: workflowUrl(context, result.workflowId),
          rev: result.rev,
          changed: result.changed,
          ...(Object.keys(result.created).length ? { created_nodes: result.created } : {}),
          ...(result.removedNodes.length ? { removed_nodes: result.removedNodes } : {}),
          ...(result.addedEdges.length ? { added_edges: result.addedEdges } : {}),
          ...(result.removedEdges.length ? { removed_edges: result.removedEdges } : {}),
          ...(result.notes.length ? { notes: result.notes } : {}),
          state: await stateAfterEdit(context, result.workflowId),
          next: 'Check the result with get_workflow (include_graph), then estimate_run and run_workflow.'
        };
      });
    }
  });

  const resumeRun = defineTool({
    name: 'resume_run', title: 'Resume a run',
    description: 'Continues a run started with this key that is waiting for approval. Ask the person to approve the higher max_usd first. The per-run and monthly key limits still apply.',
    inputSchema: { type: 'object', properties: { run_id: schemaId, max_usd: { type: 'number', minimum: 0, maximum: 100000 } }, required: ['run_id', 'max_usd'], additionalProperties: false },
    right: 'start', annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args, context) => accounting.serialize(context.key.id, async () => {
      const { key, viewer } = context;
      // Load first: a stranger's workflow stays invisible even for keys that did not initiate this run.
      const run = await svc().status(viewer, args.run_id);
      if (accounting.startedBy(args.run_id) !== key.id) throw new ToolError('This run was not started with this key (or the app restarted since). A key resumes only its own runs.');
      if (run.status !== 'awaiting_approval') throw new ToolError('The run is not waiting for approval.');
      if (args.max_usd > key.maxRunUsd + COST_EPSILON) throw new ToolError(`max_usd exceeds the limit of ${usd(key.maxRunUsd)} per run set for this key.`);
      const required = run.approval?.requiredUsd;
      if (!Number.isFinite(required)) throw new ToolError('The waiting step has no known USD price. Agent access cannot resume it; use the app.');
      if (args.max_usd + COST_EPSILON < Math.max(required, run.maxUsd || 0)) throw new ToolError(`max_usd must be at least ${usd(Math.max(required, run.maxUsd || 0))} to cover the amount the engine requires.`);
      const usage = await accounting.monthUsage(key.id);
      const reservation = accounting.reservationFor(args.run_id);
      if (!reservation?.canRaise) throw new ToolError('The reservation cannot be raised safely while provider jobs with the previous reservation are open, or its cost context is unavailable. The run stays paused; use the app or cancel_run.');
      // Reserve the full approved ceiling, conservatively counting booked costs as well. Replace this run's hold,
      // rather than adding it twice, and change the originating async context before waking any engine work.
      if (usage.spentUsd + usage.reservedUsd - reservation.usd + args.max_usd > key.maxMonthUsd + COST_EPSILON) throw new ToolError(`The higher reservation would exceed the limit of ${usd(key.maxMonthUsd)} per month set for this key.`);
      accounting.raiseReservation(args.run_id, args.max_usd);
      // A failed status read after resume may already have woken the engine: keep the higher hold on any error.
      const resumed = await svc().resume(viewer, args.run_id, { maxUsd: args.max_usd, workflowId: run.workflowId });
      return { run_id: resumed.runId, workflow_id: resumed.workflowId, url: workflowUrl(context, resumed.workflowId), status: resumed.status, max_usd: args.max_usd, next: 'Follow it with get_run.' };
    })
  });

  const getWorkflowResults = defineTool({
    name: 'get_workflow_results', title: 'Get workflow result history',
    description: 'Shows the result history of workflow nodes, newest entries first, with the selected entry and variant, text previews and file download links valid for 24 hours. File asset_id identifies the asset in this workflow.',
    inputSchema: { type: 'object', properties: { workflow_id: schemaId, node_id: schemaId, text_chars: { type: 'integer', minimum: 1, maximum: 20000 }, history_limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['workflow_id'], additionalProperties: false },
    right: 'read',
    handler: async (args, context) => {
      const found = await svc().workflowResults(context.viewer, args.workflow_id, { nodeId: args.node_id, textChars: args.text_chars, historyLimit: args.history_limit });
      const nodes = [];
      for (const node of found.nodes) {
        const history = [];
        for (const entry of node.history) {
          const variants = [];
          for (const [index, variant] of entry.variants.entries()) variants.push({ variant: index, selected: node.selected?.entry === entry.entryId && (node.selected.variant || 0) === index, items: await withLinks(variant.items, context) });
          history.push({ entry_id: entry.entryId, created_at: entry.createdAt, selected: node.selected?.entry === entry.entryId,
            ...(Number.isFinite(entry.cost?.usd) ? { cost_usd: entry.cost.usd } : {}), ...(Number.isFinite(entry.cost?.credits) ? { cost_credits: entry.cost.credits } : {}), variants });
        }
        nodes.push({ node_id: node.nodeId, label: node.label, type: node.type, selected: node.selected ? { entry_id: node.selected.entry, variant: node.selected.variant || 0 } : null, history });
      }
      return { workflow_id: found.workflowId, url: workflowUrl(context, found.workflowId), nodes };
    }
  });

  const getWorkflowCosts = defineTool({
    name: 'get_workflow_costs', title: 'Get workflow costs',
    description: 'Shows all costs booked for this workflow across its runs, including pruned result history and late provider charges, with totals and breakdowns by type and model.',
    inputSchema: { type: 'object', properties: { workflow_id: schemaId }, required: ['workflow_id'], additionalProperties: false },
    right: 'read',
    handler: async (args, context) => {
      const cost = await svc().workflowCosts(context.viewer, args.workflow_id);
      return { workflow_id: args.workflow_id, url: workflowUrl(context, args.workflow_id), total_usd: cost.totalUsd, credits: cost.credits, count: cost.count, first_at: cost.firstAt, last_at: cost.lastAt, by_type: cost.byType, by_model: cost.byModel };
    }
  });

  const deleteResultEntry = defineTool({
    name: 'delete_result_entry', title: 'Delete a result entry',
    description: 'Permanently deletes one result history entry and releases files no longer in use. Ask the person first, then set confirm to true. Deletion is refused while the workflow has an active run.',
    inputSchema: { type: 'object', properties: { workflow_id: schemaId, node_id: schemaId, entry_id: schemaId, confirm: { type: 'boolean' } }, required: ['workflow_id', 'node_id', 'entry_id'], additionalProperties: false },
    right: 'start', annotations: { destructiveHint: true, idempotentHint: false },
    handler: async (args, context) => {
      if (args.confirm !== true) throw new ToolError('Nothing was deleted. Ask the person to approve this permanent deletion, then call again with confirm: true.');
      const result = await svc().deleteResultEntry(context.viewer, args.workflow_id, args.node_id, args.entry_id);
      return { ok: result.ok, workflow_id: args.workflow_id, url: workflowUrl(context, args.workflow_id), node_id: result.nodeId, removed: result.removed, selected: result.node.selected ? { entry_id: result.node.selected.entry, variant: result.node.selected.variant } : null, files: result.files };
    }
  });

  const duplicateWorkflow = defineTool({
    name: 'duplicate_workflow', title: 'Duplicate a workflow',
    description: 'Copies a workflow you can use into a workflow owned by you, with its graph and input files and no result history. Counts toward the limit of 30 created workflows per key and hour. Nothing runs.',
    inputSchema: { type: 'object', properties: { workflow_id: schemaId, name: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['workflow_id'], additionalProperties: false },
    right: 'start', annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (args, context) => accounting.serialize(context.key.id, async () => {
      if (!accounting.mayCreateWorkflow(context.key.id)) throw new ToolError('This key has made 30 workflows in the last hour. Reuse one (list_workflows) or wait.');
      const created = await svc().duplicateWorkflow(context.viewer, args.workflow_id, { name: args.name });
      accounting.noteWorkflowCreated(context.key.id);
      return { workflow_id: created.workflowId, url: workflowUrl(context, created.workflowId), name: created.name, rev: created.rev };
    })
  });

  return [listTemplates, listWorkflows, getWorkflow, listNodeTypes, estimateRun, getRun, uploadAsset, createFromTemplate, createWorkflow, editWorkflow, runWorkflow, cancelRun, resumeRun, getWorkflowResults, getWorkflowCosts, deleteResultEntry, duplicateWorkflow];
}

module.exports = { createWorkflowTools, describeError, MAX_ACTIVE_RUNS, MAX_WAIT_SECONDS };
