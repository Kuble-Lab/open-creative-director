'use strict';

// The nine tools of the agent access. They act as the person who owns the key and use the run service
// (lib/nodes/run-service.js) for everything about workflows and runs: no run logic of its own lives here. What is added
// is the part that only the agent access has: the right of the key, its limits (per run, per month, two runs at a time),
// the files (uploads, result links) and the origin of the costs.
//
//   read     list_templates  list_workflows  get_workflow  estimate_run  get_run
//   start    upload_asset  create_from_template  run_workflow  cancel_run
//
// Everything a tool returns is data for the agent. Names, descriptions and texts in it come from workflows (and from the
// people who made them): they are not instructions.

const fsp = require('fs/promises');

const costsLib = require('../costs');
const nodeAssets = require('../nodes/assets');
const nodeRegistry = require('../nodes/registry');
const { ToolError, defineTool } = require('./tools');
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
    case 'INVALID_REQUEST':
      return `The request is not valid: ${err.message}`;
    case 'NODE_UNAVAILABLE':
    case 'INVALID_GRAPH':
      return `The workflow cannot run: ${err.message}`;
    case 'FORBIDDEN_FOR_ROLE':
      return 'The workflow contains Higgsfield steps, which are not available through agent access.';
    case 'COST_CHANGED':
      return `The cost of the run changed (now about ${usd(err.estimateUsd ?? 0)}) and is higher than the amount that was accepted. Call estimate_run and run_workflow again with a new max_usd. Nothing was started.`;
    case 'CONFIRMATION_REQUIRED':
      return 'The run has paid steps and needs max_usd. Nothing was started.';
    case 'RUN_ACTIVE':
      return 'A run of this workflow is already active. Wait for it (get_run) or cancel it (cancel_run).';
    case 'RUN_LIMIT':
      return 'The app is running as many runs as it allows at the moment. Try again in a few minutes.';
    case 'REV_CONFLICT':
      return 'The workflow was changed after it was estimated. Call estimate_run and run_workflow again.';
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
        try {
          const value = await assets.valueFromAsset(item.sessionId, item.assetId);
          signed = fileLinks.sign({ sessionId: item.sessionId, file: value.file });
        } catch (_) {
          signed = null;
        }
        out.push({
          type: item.type,
          ...(signed ? { url: linkUrl(context.publicBase, `/mcp/files/${signed.token}`), expires_at: signed.expiresAt } : { available: false }),
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
        if (!higgsfield.length) add('HIGGSFIELD_BLOCKED', 'The workflow contains Higgsfield steps. Higgsfield is not available through agent access.');
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
      valid: view.valid,
      paid: view.paid,
      estimate_usd: view.totals.usd,
      estimate_complete: view.totals.usdKnown,
      steps_to_run: view.totals.runSteps,
      steps_cached: view.totals.cachedSteps,
      paid_steps: view.steps.filter((step) => step.runs && step.paid).map((step) => ({ label: step.label, type: step.type, estimate_usd: step.usd })),
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
    handler: async (args, { viewer }) => {
      const list = await svc().listRunnable(viewer, { ...(args.query ? { query: args.query } : {}), lang: 'en', limit: 100 });
      const limit = args.limit || 50;
      const all = list.items.filter((item) => item.kind === 'workflow');
      return { workflows: all.slice(0, limit).map((item) => briefItem(item)), count: Math.min(all.length, limit), more: all.length > limit || list.truncated };
    }
  });

  const getWorkflow = defineTool({
    name: 'get_workflow',
    title: 'Get a workflow',
    description:
      'Shows one workflow: its steps (nodes), the inputs you can set, the outputs it makes and the results it holds now (as download links, valid for 24 hours).',
    inputSchema: {
      type: 'object',
      properties: { workflow_id: { ...schemaId, description: 'The id from list_workflows or create_from_template.' } },
      required: ['workflow_id'],
      additionalProperties: false
    },
    right: 'read',
    handler: async (args, context) => {
      const found = await svc().describeWorkflow(context.viewer, args.workflow_id);
      return {
        id: found.id,
        name: found.name,
        ...(found.description ? { description: found.description } : {}),
        origin: found.origin,
        rev: found.rev,
        updated_at: found.updatedAt,
        steps: found.nodes.map((node) => ({ id: node.id, type: node.type, label: node.label })),
        inputs: found.inputs.map(briefInput),
        outputs: found.outputs.map((output) => output.label),
        cost: briefCost(found.cost, found.usesHiggsfield),
        run_in_progress: Boolean(found.activeRun),
        latest_results: await resultsWithLinks(found.lastResults, context)
      };
    }
  });

  const estimateRun = defineTool({
    name: 'estimate_run',
    title: 'Estimate a run',
    description:
      'Estimates what a run of the workflow would cost now (the same estimate the app shows), which steps are paid and what would stop the run, including the limits of this key. ' +
      'Nothing is started. Use the estimate as the basis for max_usd in run_workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { ...schemaId, description: 'The id from list_workflows or create_from_template.' },
        max_usd: { type: 'number', minimum: 0, maximum: 100000, description: 'Optional: the amount you would accept; the answer then says whether the estimate fits.' }
      },
      required: ['workflow_id'],
      additionalProperties: false
    },
    right: 'read',
    handler: async (args, { key, viewer }) => {
      const view = await svc().estimate(viewer, args.workflow_id);
      const check = await checkRun(view, key, typeof args.max_usd === 'number' ? args.max_usd : null);
      return { workflow_id: view.workflowId, name: view.name, rev: view.rev, ...planSummary(view), agent: agentSummary(key, check, view) };
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
      'Nothing runs and nothing is charged. The answer has the estimate; start it with run_workflow. ' +
      'A language input has the choice "auto": the text is then written in the language of the topic, brief or document the person gave (leave it as it is unless another language is wanted).',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { ...schemaId, description: 'The id from list_templates.' },
        inputs: { type: 'object', description: 'The values of the inputs.' },
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'A name for the new workflow (default: the name of the template).' },
        language: { type: 'string', enum: LANGUAGES, description: 'Language of the labels (default en).' }
      },
      required: ['template_id'],
      additionalProperties: false
    },
    right: 'start',
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (args, { key, viewer }) => {
      if (args.inputs && Object.keys(args.inputs).length > MAX_INPUTS) throw new ToolError(`inputs has too many entries (at most ${MAX_INPUTS}).`);
      if (!accounting.mayCreateWorkflow(key.id)) {
        throw new ToolError('This key has made 30 workflows in the last hour. Reuse one (list_workflows, run_workflow with inputs) or wait.');
      }
      const prepared = await svc().prepare(viewer, {
        templateId: args.template_id,
        inputs: args.inputs || {},
        sourceSessionId: uploads.peek(key.id) || undefined,
        ...(args.name ? { name: args.name } : {}),
        lang: args.language || 'en',
        requireStartable: true
      });
      accounting.noteWorkflowCreated(key.id);
      const check = await checkRun(prepared.plan, key);
      return {
        workflow_id: prepared.workflowId,
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
        next: 'Start it with run_workflow (workflow_id and max_usd of at least the estimate).'
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
      'Optional inputs are set in the workflow before it starts (same format as create_from_template).',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { ...schemaId, description: 'The id from list_workflows or create_from_template.' },
        max_usd: { type: 'number', minimum: 0, maximum: 100000, description: 'The most you accept to pay, in USD (0 for a free workflow). Take it from estimate_run.' },
        inputs: { type: 'object', description: 'Optional values for the inputs, saved in the workflow before the run.' }
      },
      required: ['workflow_id', 'max_usd'],
      additionalProperties: false
    },
    right: 'start',
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args, { key, viewer }) => {
      const hasInputs = args.inputs && Object.keys(args.inputs).length > 0;
      if (hasInputs && Object.keys(args.inputs).length > MAX_INPUTS) throw new ToolError(`inputs has too many entries (at most ${MAX_INPUTS}).`);
      return accounting.serialize(key.id, async () => {
        // the checks and the start belong together: a second start of this key waits for them
        const service = svc();
        let view;
        if (hasInputs) {
          const prepared = await service.prepare(viewer, { workflowId: args.workflow_id, inputs: args.inputs, sourceSessionId: uploads.peek(key.id) || undefined, requireStartable: true });
          view = prepared.plan;
        } else {
          view = await service.estimate(viewer, args.workflow_id);
        }
        const check = await checkRun(view, key, args.max_usd);
        if (check.problems.length) {
          throw new ToolError(problemsText(check.problems, hasInputs ? ' The inputs you gave were saved in the workflow.' : ''));
        }
        const request = view.paid
          ? { maxUsd: Math.min(args.max_usd, key.maxRunUsd), maxCredits: 0, maxUnknownNodes: 0, rev: view.rev }
          : { requireFree: true, maxUnknownNodes: 0, rev: view.rev };
        const started = await costs.withVia({ keyId: key.id, keyName: key.name }, () => service.start(viewer, view.workflowId, request));
        accounting.begin(key.id, started.runId, started.paid ? started.totals.usd : 0);
        service
          .waitForRun(viewer, started.runId)
          .then((run) => accounting.end(started.runId, run.status))
          .catch(() => accounting.end(started.runId, 'error'));
        return {
          run_id: started.runId,
          workflow_id: started.workflowId,
          name: started.name,
          status: 'running',
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

  return [listTemplates, listWorkflows, getWorkflow, estimateRun, getRun, uploadAsset, createFromTemplate, runWorkflow, cancelRun];
}

module.exports = { createWorkflowTools, describeError, MAX_ACTIVE_RUNS, MAX_WAIT_SECONDS };
