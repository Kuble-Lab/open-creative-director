'use strict';

// Assistant of the node view (WP25, part 2: the panel). It answers questions about nodes and, when asked, adds nodes and
// connects them, adopts saved edits with undo and prepares runs and actions that require an explicit click.
//
// Part 1 is pure and UMD (module.exports in Node tests, window.OCDNodes.assistant in the browser):
//   summarizeCanvas   the canvas as the endpoint wants it (ids, types, titles, short plain params, connections, selection,
//                     warnings; no media, no results)
//   buildSubgraph     the proposal of the server -> a sub graph for graphLib.insertSubgraph (temporary ids, a layout, links
//                     that are checked one by one against the graph as it is now)
//   adjustedLines     the "adjusted" notes of the server as sentences
//   costOfInserted    the price of the inserted nodes from the engine plan (a node without an estimate is "unknown", never 0)
//   requestHistory    the last turns for the next question
//   failure           an error of the endpoint -> { kind, text }
//   modelChoices      the language models of the chat -> the options of the list in the panel
//   pickModel         the model for the next question: the saved one while it is on the list, else the default
// Part 2 (createAssistant) is the browser glue: the panel in place of the inspector (a sheet on a phone), the list of the
// language models (the choice is kept by deps.modelStore, the conversation is never saved), the conversation per workflow
// (kept until the page reloads), links to the node help, the card "N nodes inserted" with undo
// and the cost, keyboard use. Everything is built with el() and textContent; no HTML from strings.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.assistant = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const LIMITS = Object.freeze({
    canvasNodes: 500,
    canvasEdges: 2000,
    paramsPerNode: 24,
    paramText: 300,
    title: 120,
    warnings: 15,
    warningText: 160,
    historyTurns: 6,
    historyText: 4000,
    question: 10000,
    namesShown: 6,
    keptMessages: 80
  });
  // Layout of the new nodes: one column per step of the flow, one row per node in a step.
  const COLUMN = 380;
  const ROW = 340;
  const ADJUST_REASONS = Object.freeze(['unknown_param', 'clamped', 'clipped', 'media_param', 'unverifiable', 'not_a_number']);
  const QUOTA_NOTE_AT = 5;

  const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function clip(value, max) {
    const text = String(value ?? '');
    return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
  }

  /* ---------- the canvas as data ---------- */

  // Plain values only: text, numbers, yes / no. A media object (an uploaded file, a result) is not sent, nor is an empty
  // text. The server cuts the amount down again; this keeps the request small.
  function plainParams(params) {
    const out = {};
    if (!isPlain(params)) return out;
    let count = 0;
    for (const [key, value] of Object.entries(params)) {
      if (count >= LIMITS.paramsPerNode) break;
      if (typeof value === 'string') {
        if (!value.trim()) continue;
        out[key] = clip(value, LIMITS.paramText);
      } else if (isNumber(value) || typeof value === 'boolean') out[key] = value;
      else continue;
      count += 1;
    }
    return out;
  }

  // options: { selected: [nodeId], warnings: [{ node?, message }] }
  function summarizeCanvas(graph, options = {}) {
    const source = isPlain(graph) ? graph : {};
    const nodes = (Array.isArray(source.nodes) ? source.nodes : []).slice(0, LIMITS.canvasNodes).map((node) => {
      const entry = { id: node.id, type: node.type };
      if (typeof node.title === 'string' && node.title.trim()) entry.title = clip(node.title.trim(), LIMITS.title);
      const params = plainParams(node.params);
      if (Object.keys(params).length) entry.params = params;
      return entry;
    });
    const ids = new Set(nodes.map((node) => node.id));
    const edges = (Array.isArray(source.edges) ? source.edges : [])
      .filter((edge) => edge && edge.from && edge.to && ids.has(edge.from.node) && ids.has(edge.to.node))
      .slice(0, LIMITS.canvasEdges)
      .map((edge) => ({ from: { node: edge.from.node, port: edge.from.port }, to: { node: edge.to.node, port: edge.to.port } }));
    const summary = { nodes, edges };
    const selected = (Array.isArray(options.selected) ? options.selected : []).filter((id) => ids.has(id));
    if (selected.length) summary.selected = selected;
    const warnings = (Array.isArray(options.warnings) ? options.warnings : [])
      .filter((item) => item && typeof item.message === 'string' && item.message.trim())
      .slice(0, LIMITS.warnings)
      .map((item) => ({ ...(typeof item.node === 'string' && ids.has(item.node) ? { node: item.node } : {}), message: clip(item.message.trim(), LIMITS.warningText) }));
    if (warnings.length) summary.warnings = warnings;
    return summary;
  }

  // The last turns of the conversation (text only, no errors, nothing pending), oldest first.
  function requestHistory(messages) {
    const turns = (Array.isArray(messages) ? messages : [])
      .filter((message) => message && !message.pending && !message.error && typeof message.text === 'string' && message.text.trim())
      .map((message) => ({ role: message.role === 'user' ? 'user' : 'assistant', text: clip(message.text.trim(), LIMITS.historyText) }));
    return turns.slice(-LIMITS.historyTurns);
  }

  /* ---------- the proposal -> a sub graph ---------- */

  // Step of the flow of every new node (0 = nothing new in front of it), from the connections between the new nodes.
  function stepsOf(ids, pairs) {
    const step = new Map(ids.map((id) => [id, 0]));
    for (let round = 0; round < ids.length; round += 1) {
      let changed = false;
      for (const [from, to] of pairs) {
        if (step.get(to) < step.get(from) + 1 && step.get(from) + 1 < ids.length) {
          step.set(to, step.get(from) + 1);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return step;
  }

  // insert: the `insert` of the answer { nodes: [{ ref, type, params, label? }], edges: [{ from: { ref|node, port }, to }] }.
  // options.labelOf(type): the name of a node type. Returns
  //   { sub: { nodes: [{ id, type, x, y, params, title? }], links: [{ from: { node, port, existing? }, to }] },
  //     names: [{ id, type, label }], existingLinks, skipped }
  // `id` is temporary (a1, a2, ...); a ref the proposal never defined makes its connection `skipped`. Positions only
  // order the new nodes among themselves: insertSubgraph puts the block beside the existing content.
  function buildSubgraph(insert, options = {}) {
    const labelOf = typeof options.labelOf === 'function' ? options.labelOf : (type) => type;
    const source = isPlain(insert) ? insert : {};
    const rawNodes = (Array.isArray(source.nodes) ? source.nodes : []).filter((node) => isPlain(node) && typeof node.type === 'string' && typeof node.ref === 'string');
    const temp = new Map();
    rawNodes.forEach((node, index) => {
      if (!temp.has(node.ref)) temp.set(node.ref, `a${index + 1}`);
    });
    const side = (end) => {
      if (!isPlain(end) || typeof end.port !== 'string') return null;
      if (typeof end.ref === 'string') return temp.has(end.ref) ? { node: temp.get(end.ref), port: end.port } : null;
      if (typeof end.node === 'string' && end.node) return { node: end.node, port: end.port, existing: true };
      return null;
    };
    const links = [];
    let skipped = 0;
    for (const edge of Array.isArray(source.edges) ? source.edges : []) {
      const from = side(edge && edge.from);
      const to = side(edge && edge.to);
      if (from && to) links.push({ from, to });
      else skipped += 1;
    }
    const ids = rawNodes.filter((node, index) => temp.get(node.ref) === `a${index + 1}`).map((node) => temp.get(node.ref));
    const pairs = links.filter((link) => !link.from.existing && !link.to.existing).map((link) => [link.from.node, link.to.node]);
    const step = stepsOf(ids, pairs);
    const rowOf = new Map();
    const nodes = [];
    const names = [];
    rawNodes.forEach((node, index) => {
      const id = `a${index + 1}`;
      if (temp.get(node.ref) !== id) return; // a ref used twice: the first one counts
      const column = step.get(id) || 0;
      const row = rowOf.get(column) || 0;
      rowOf.set(column, row + 1);
      const title = typeof node.label === 'string' && node.label.trim() ? clip(node.label.trim(), LIMITS.title) : '';
      nodes.push({ id, type: node.type, x: column * COLUMN, y: row * ROW, params: isPlain(node.params) ? { ...node.params } : {}, ...(title ? { title } : {}) });
      names.push({ id, type: node.type, label: title || labelOf(node.type) });
    });
    return {
      sub: { nodes, links },
      names,
      existingLinks: links.filter((link) => link.from.existing || link.to.existing).length,
      skipped
    };
  }

  // refName: ref -> the name shown for it. adjusted: [{ ref, param, reason }]. T(key, vars), paramLabel(id).
  function adjustedLines(adjusted, refName, T, paramLabel) {
    const lines = [];
    for (const entry of Array.isArray(adjusted) ? adjusted : []) {
      if (!isPlain(entry) || typeof entry.param !== 'string') continue;
      const reason = ADJUST_REASONS.includes(entry.reason) ? entry.reason : 'other';
      const node = (refName && refName.get && refName.get(entry.ref)) || '';
      lines.push(T(`nodes.assistant.adjusted.${reason}`, { node, param: paramLabel ? paramLabel(entry.param) : entry.param }));
    }
    return lines;
  }

  const EDIT_OPS = Object.freeze(['add_node', 'remove_node', 'set_params', 'set_label', 'connect', 'disconnect', 'expose_input', 'unexpose_input']);
  const ACTION_TOOLS = Object.freeze(['publish_influencer_site', 'delete_result_entry', 'remove_influencer_site_item', 'update_influencer_site', 'add_influencer_site_item', 'update_influencer', 'create_influencer']);
  const FACT_KEYS = Object.freeze(['influencerName', 'siteUrl', 'slug', 'visibility', 'itemTitle', 'nodeLabel', 'name']);

  function changeLines(edit, T, paramLabel = (id) => id) {
    const changes = Array.isArray(edit && edit.changes) ? edit.changes : [];
    const name = (node) => node && (node.label || node.id || node.type) || '';
    const lines = changes.filter((change) => change && EDIT_OPS.includes(change.op)).map((change) => T(`nodes.assistant.change.${change.op}`, {
      node: name(change.node), from: name(change.from && change.from.node), to: name(change.to && change.to.node),
      params: (Array.isArray(change.params) ? change.params : []).map(paramLabel).join(', '),
      param: change.param ? paramLabel(change.param) : ''
    }));
    const hidden = Math.max(0, lines.length - LIMITS.namesShown) + (Number.isFinite(edit && edit.more) ? edit.more : 0);
    return [...lines.slice(0, LIMITS.namesShown), ...(hidden ? [T('nodes.assistant.change.more', { count: hidden })] : edit && edit.more ? [T('nodes.assistant.change.moreUnknown')] : [])];
  }

  function runIsPaid(run) {
    return !run.estimate || Boolean(Array.isArray(run.estimate.paid) ? run.estimate.paid.length : run.estimate.paid);
  }

  function runLines(run, T, formatAmount) {
    const names = (Array.isArray(run.nodes) ? run.nodes : []).map((node) => node.label || node.id).filter(Boolean);
    const targets = names.length ? names.join(', ') : (run.nodeIds || [run.nodeId]).filter(Boolean).join(', ');
    const estimate = run.estimate;
    const unknown = !estimate || (Array.isArray(estimate.unknownNodes) ? estimate.unknownNodes.length : estimate.unknownNodes) ||
      (runIsPaid(run) && !isNumber(estimate.usd) && !isNumber(estimate.credits));
    return [
      T(run.mode === 'all' ? 'nodes.assistant.run.all' : 'nodes.assistant.run.nodes', { names: targets }),
      ...(run.force ? [T('nodes.assistant.run.force')] : []),
      T(!estimate || (runIsPaid(run) && unknown) ? 'nodes.assistant.run.unknown' : runIsPaid(run) ? 'nodes.assistant.run.cost' : 'nodes.assistant.run.free', { amount: estimate && formatAmount ? formatAmount(estimate) : '' }),
      T('nodes.assistant.run.notStarted')
    ];
  }

  function confirmationText(action, T) {
    const facts = isPlain(action.facts) ? action.facts : {};
    const title = T(`nodes.assistant.confirm.${action.tool}.title`, { name: facts.influencerName || facts.name || T('nodes.assistant.confirm.figure') });
    const lines = Object.entries(facts).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) =>
      `${FACT_KEYS.includes(key) ? T(`nodes.assistant.fact.${key}`) : key}: ${String(value)}`);
    if (action.tool === 'publish_influencer_site') lines.push(T(facts.visibility === 'public' ? 'nodes.assistant.confirm.public' : 'nodes.assistant.confirm.visible'));
    if (['delete_result_entry', 'remove_influencer_site_item'].includes(action.tool)) lines.push(T('nodes.assistant.confirm.irreversible'));
    if (action.tool === 'create_influencer') lines.push(T('nodes.assistant.confirm.consent'));
    return { title, lines, verb: T(`nodes.assistant.confirm.${action.tool}.verb`) };
  }

  function safeActionUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch (_) { return null; }
  }

  /* ---------- costs from the engine plan ---------- */

  // nodes: [{ id, type }] the inserted nodes; plan: the answer of POST .../runs/plan (or null); isPaid(type): boolean.
  // Returns { paid, unknown, usd, credits }. A paid node counts as known only with an estimate and a known number of
  // executions in a state that will run; everything else is unknown (also when the plan has no entry for it yet).
  function costOfInserted(nodes, plan, isPaid) {
    const entries = (plan && plan.nodes) || {};
    const out = { paid: 0, unknown: 0, usd: 0, credits: 0 };
    for (const node of nodes) {
      if (!isPaid(node.type)) continue;
      out.paid += 1;
      const entry = has(entries, node.id) ? entries[node.id] : null;
      const executions = entry && isNumber(entry.executions) ? entry.executions : null;
      const runs = entry && (entry.status === 'stale' || entry.status === 'forced');
      if (!entry || !runs || !entry.estimate || executions === null) {
        out.unknown += 1;
        continue;
      }
      out.usd += (isNumber(entry.estimate.usd) ? entry.estimate.usd : 0) * executions;
      out.credits += (isNumber(entry.estimate.credits) ? entry.estimate.credits : 0) * executions;
    }
    return out;
  }

  /* ---------- failures ---------- */

  // The endpoint answers with finished sentences in the language of the interface; a network failure or a proxy page
  // has none. kind: 'budget' (the budget is used up or too small), 'limit' (too many questions), 'error'.
  function failure(error, T) {
    const status = error && Number.isInteger(error.status) ? error.status : 0;
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (code === 'BUDGET_EXHAUSTED' || code === 'BUDGET_INSUFFICIENT') return { kind: 'budget', text: error.message, retry: false };
    if (code === 'RATE_LIMITED') return { kind: 'limit', text: error.message, retry: false };
    if (!status) return { kind: 'error', text: T('nodes.assistant.error.network'), retry: true };
    if (code && error.message) return { kind: 'error', text: error.message, retry: status >= 500 || code === 'LOGIN_UNCONFIRMED' };
    return { kind: 'error', text: T('nodes.assistant.error.generic', { error: (error && error.message) || `HTTP ${status}` }), retry: true };
  }

  /* ---------- the model of the panel ---------- */

  // choices: { models: [id], defaultModel, labelOf(id) } (the models of the chat, already filtered for the role). Returns
  // { options: [{ value, label }], defaultModel }: ids once each, a name from labelOf (else the id), and a default that is on the list.
  function modelChoices(choices) {
    const source = isPlain(choices) ? choices : {};
    const seen = new Set();
    const options = [];
    for (const model of Array.isArray(source.models) ? source.models : []) {
      if (typeof model !== 'string' || !model || seen.has(model)) continue;
      seen.add(model);
      let label = '';
      try {
        label = typeof source.labelOf === 'function' ? String(source.labelOf(model) || '') : '';
      } catch (_) {
        label = '';
      }
      options.push({ value: model, label: label || model });
    }
    const wanted = typeof source.defaultModel === 'string' ? source.defaultModel : '';
    return { options, defaultModel: seen.has(wanted) ? wanted : options.length ? options[0].value : '' };
  }

  // The model for the next question: the saved choice while it is still on the list, else the default (the model of a new
  // chat), '' when there is no list at all (then the request carries no model and the server decides, as before).
  function pickModel(saved, choices) {
    const { options, defaultModel } = modelChoices(choices);
    return typeof saved === 'string' && options.some((option) => option.value === saved) ? saved : defaultModel;
  }

  const pure = {
    LIMITS,
    COLUMN,
    ROW,
    ADJUST_REASONS,
    QUOTA_NOTE_AT,
    plainParams,
    summarizeCanvas,
    requestHistory,
    buildSubgraph,
    adjustedLines,
    EDIT_OPS, ACTION_TOOLS, FACT_KEYS, changeLines, runIsPaid, runLines, confirmationText, safeActionUrl,
    costOfInserted,
    failure,
    modelChoices,
    pickModel,
    clip
  };

  /* ---------- browser glue ---------- */

  // deps: { OCD, host (the <aside>), help (node-help.js: openPopover(type, anchor)), getWorkflowId(), getGraph(), getReg(),
  //   getSelection() -> [nodeId], getWarnings() -> [{ node?, message }], canInsert(), insert(sub, options) -> result | null
  //   (main.js insertSubgraph), historyRevision(), undo(), flushSave(), plan() -> Promise<plan>, showNodes(ids),
  //   savedRev() -> number|null, holdExternalSaves(workflowId) -> release(adoptedRev|null),
  //   adoptServerEdit(edit, workflowId) -> Promise<{ok}>, startRun(request), isRunActive(),
  //   getLang(), onToggle(open, options),
  //   getModelChoices() -> { models, defaultModel, labelOf } (the models of the chat; none: no list in the panel),
  //   modelStore: { read() -> id | '', write(id) } (the saved choice of this person; every access guarded by the owner) }
  function createAssistant(deps) {
    const OCD = deps.OCD;
    const ui = OCD.ui;
    const api = OCD.api;
    const graphLib = OCD.graph;
    const { el, icon, T } = ui;
    const host = deps.host;

    const threads = new Map();
    const view = {};
    const shown = new Map(); // message id -> element
    let open = false;
    let nextId = 1;
    let budget = null;
    let chosenModel = ''; // the model picked in the panel since the page loaded

    const access = () => (typeof window !== 'undefined' ? window.OCAccess : null);
    const restricted = () => {
      const a = access();
      return Boolean(a && a.isActive && a.isActive() && a.me && a.me().restricted);
    };
    const money = (value) => {
      const a = access();
      return a && a.formatUsd ? a.formatUsd(value) : `$${Number(value || 0).toFixed(2)}`;
    };

    function thread() {
      const id = deps.getWorkflowId();
      if (!id) return null;
      if (!threads.has(id)) threads.set(id, { id, messages: [], draft: '', busy: false, quota: null });
      return threads.get(id);
    }

    const typeLabelOf = (type) => {
      const reg = deps.getReg();
      const def = reg && reg.types.get(type);
      return def ? ui.typeLabel(def) : type;
    };

    /* ----- frame ----- */

    function build() {
      host.textContent = '';
      for (const key of Object.keys(view)) delete view[key];
      shown.clear();
      const title = el('h2', { class: 'nv-asst-title' }, icon('sparkle', 16), el('span', { text: T('nodes.assistant.title') }));
      const fresh = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-asst-new', title: T('nodes.assistant.newTitle') }, icon('refresh', 13), el('span', { class: 'nv-btn-text', text: T('nodes.assistant.new') }));
      fresh.setAttribute('aria-label', T('nodes.assistant.newTitle'));
      fresh.addEventListener('click', startOver);
      const close = el('button', { type: 'button', class: 'nv-icon-btn nv-asst-close', title: T('nodes.common.close'), 'aria-label': T('nodes.common.close') }, icon('x', 16));
      close.addEventListener('click', () => setOpen(false, { focus: true }));
      const head = el('header', { class: 'nv-asst-head' }, title, el('span', { class: 'nv-asst-spacer' }), fresh, close);
      const budgetLine = el('div', { class: 'nv-asst-budget hidden' });
      const list = el('div', { class: 'nv-asst-scroll', role: 'log', 'aria-live': 'polite', 'aria-label': T('nodes.assistant.title') });
      const input = el('textarea', { class: 'nv-input nv-asst-input', rows: 1, maxlength: LIMITS.question, placeholder: T('nodes.assistant.input'), 'aria-label': T('nodes.assistant.inputLabel'), spellcheck: 'true' });
      const send = el('button', { type: 'submit', class: 'nv-btn nv-btn-primary nv-asst-send', title: T('nodes.assistant.sendTitle') }, icon('arrowUp', 15), el('span', { class: 'nv-btn-text', text: T('nodes.assistant.send') }));
      send.setAttribute('aria-label', T('nodes.assistant.send'));
      const form = el('form', { class: 'nv-asst-form' }, input, send);
      const hint = el('p', { class: 'nv-asst-hint', text: T('nodes.assistant.hint') });
      const modelSelect = el('select', { class: 'nv-input nv-select nv-asst-model-select', 'aria-label': T('nodes.assistant.modelLabel'), title: T('nodes.assistant.modelTitle') });
      const modelRow = el('div', { class: 'nv-asst-modelrow hidden' }, el('span', { class: 'nv-asst-model-label', text: T('nodes.assistant.model') }), modelSelect);
      const foot = el('footer', { class: 'nv-asst-foot' }, modelRow, form, hint);
      host.append(head, budgetLine, list, foot);
      Object.assign(view, { head, fresh, close, budgetLine, list, input, send, form, hint, modelRow, modelSelect });
      modelSelect.addEventListener('change', () => {
        const wanted = modelSelect.value;
        if (!wanted) return;
        chosenModel = wanted; // holds for this page even when the browser keeps nothing
        try {
          if (deps.modelStore && typeof deps.modelStore.write === 'function') deps.modelStore.write(wanted);
        } catch (_) {
          /* the choice stays for this page */
        }
        paintModels();
      });

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submit();
      });
      input.addEventListener('input', () => {
        const current = thread();
        if (current) current.draft = input.value;
        autosize();
        paintSend();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          submit();
        }
      });
      paintBudget();
      paintModels();
    }

    // The panel is a typing place: its keys never reach the canvas shortcuts (delete, space, arrows ...), except Escape,
    // which closes it. Tab and the like still work, because only the bubbling to the document is stopped.
    host.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false, { focus: true });
      }
    });
    host.addEventListener('keyup', (event) => event.stopPropagation());

    function autosize() {
      const input = view.input;
      if (!input) return;
      // an empty field keeps the height of its style (while the panel slides open it is still narrow and would wrap its hint)
      input.style.height = 'auto';
      if (!input.value) {
        input.style.height = '';
        return;
      }
      input.style.height = `${Math.min(input.scrollHeight + 2, 140)}px`;
    }

    function paintSend() {
      const current = thread();
      const busy = Boolean(current && current.busy);
      if (view.send) view.send.disabled = busy || !view.input.value.trim();
      if (view.input) view.input.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    /* ----- the model of the next question ----- */

    function readModelChoices() {
      try {
        return typeof deps.getModelChoices === 'function' ? deps.getModelChoices() : null;
      } catch (_) {
        return null;
      }
    }

    function savedModel() {
      try {
        return deps.modelStore && typeof deps.modelStore.read === 'function' ? String(deps.modelStore.read() || '') : '';
      } catch (_) {
        return '';
      }
    }

    // The model that answers the next question ('' = none to name: the server takes the model of a new chat).
    function currentModel() {
      return pickModel(chosenModel || savedModel(), readModelChoices());
    }

    // The list shows the models of the chat; the saved choice if it is still on the list, else the default. The list is
    // read again every time the panel opens (the configuration may have loaded since, or the role may have changed).
    function paintModels() {
      const select = view.modelSelect;
      const row = view.modelRow;
      if (!select || !row) return;
      const { options } = modelChoices(readModelChoices());
      row.classList.toggle('hidden', !options.length);
      select.textContent = '';
      for (const option of options) select.append(el('option', { value: option.value, text: option.label }));
      select.value = currentModel();
      // a single model: nothing to choose, but the person still sees which one answers
      select.disabled = options.length < 2;
    }

    function modelName(model) {
      const found = modelChoices(readModelChoices()).options.find((option) => option.value === model);
      if (found) return found.label;
      const text = String(model || '');
      return text.split('/').pop() || text;
    }

    function paintBudget() {
      const line = view.budgetLine;
      if (!line) return;
      const a = access();
      const snapshot = restricted() ? budget || (a && a.budget ? a.budget() : null) : null;
      line.textContent = '';
      line.classList.toggle('hidden', !snapshot);
      if (!snapshot) return;
      const lines = a && a.budgetLines ? a.budgetLines(snapshot) : null;
      line.classList.toggle('is-low', Boolean(lines && lines.low));
      line.classList.toggle('is-empty', Boolean(lines && lines.exhausted));
      line.append(icon(lines && lines.exhausted ? 'warning' : 'clock', 13), el('span', { text: T('nodes.assistant.budget', { remaining: money(Math.max(0, snapshot.remainingUsd)), limit: money(snapshot.limitUsd) }) }));
    }

    /* ----- messages ----- */

    function scrollDown() {
      if (view.list) view.list.scrollTop = view.list.scrollHeight;
    }

    // A new answer: to the bottom, unless it is longer than the list; then its beginning is what the person reads first.
    function reveal(element) {
      const list = view.list;
      if (!list || !element) return;
      if (element.offsetHeight > list.clientHeight - 24) list.scrollTop = Math.max(0, element.offsetTop - 8);
      else scrollDown();
    }

    function paintAll() {
      if (!view.list) return;
      view.list.textContent = '';
      shown.clear();
      const current = thread();
      if (!current) return;
      if (!current.messages.length) view.list.append(emptyState());
      for (const message of current.messages) place(message);
      view.input.value = current.draft || '';
      autosize();
      paintSend();
      scrollDown();
    }

    function emptyState() {
      const box = el('div', { class: 'nv-asst-empty' });
      box.append(el('div', { class: 'nv-asst-mark' }, icon('sparkle', 22)), el('p', { class: 'nv-asst-intro', text: T('nodes.assistant.intro') }), el('p', { class: 'nv-asst-safe', text: T('nodes.assistant.introSafe') }));
      if (restricted()) box.append(el('p', { class: 'nv-asst-safe', text: T('nodes.assistant.budgetNote') }));
      const list = el('div', { class: 'nv-asst-suggest' }, el('span', { class: 'nv-asst-suggest-title', text: T('nodes.assistant.suggestTitle') }));
      for (const index of [1, 2, 3]) {
        const text = T(`nodes.assistant.suggest.${index}`);
        const chip = el('button', { type: 'button', class: 'nv-asst-chip', text });
        chip.addEventListener('click', () => ask(text));
        list.append(chip);
      }
      box.append(list);
      return box;
    }

    // Puts the element of a message into the list (replacing the one it had).
    function place(message) {
      if (!view.list) return;
      const empty = view.list.querySelector('.nv-asst-empty');
      if (empty) empty.remove();
      const element = render(message);
      const before = shown.get(message.id);
      if (before && before.isConnected) before.replaceWith(element);
      else view.list.append(element);
      shown.set(message.id, element);
    }

    function render(message) {
      const mine = message.role === 'user';
      const wrap = el('div', { class: `nv-asst-msg ${mine ? 'is-user' : 'is-bot'}`, dataset: { id: String(message.id) } });
      wrap.append(el('span', { class: 'nv-asst-who', text: mine ? T('nodes.assistant.you') : T('nodes.assistant.bot') }));
      if (mine) {
        wrap.append(el('div', { class: 'nv-asst-bubble', text: message.text }));
        return wrap;
      }
      if (message.pending) {
        wrap.append(el('div', { class: 'nv-asst-bubble is-pending' }, el('span', { class: 'nv-asst-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')), el('span', { text: T('nodes.assistant.thinking') })));
        return wrap;
      }
      if (message.error) {
        const bubble = el('div', { class: `nv-asst-bubble is-${message.error.kind}` }, icon('warning', 14), el('span', { class: 'nv-asst-text', text: message.error.text }));
        wrap.append(bubble);
        if (message.error.retry) {
          const retry = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-asst-retry' }, icon('refresh', 13), el('span', { text: T('nodes.assistant.error.retry') }));
          retry.addEventListener('click', () => retryAfterError(message));
          wrap.append(retry);
        }
        return wrap;
      }
      const bubble = el('div', { class: 'nv-asst-bubble' });
      for (const paragraph of String(message.text).split(/\n{2,}/)) {
        if (paragraph.trim()) bubble.append(el('p', { class: 'nv-asst-text', text: paragraph.trim() }));
      }
      wrap.append(bubble);
      if (message.mentions && message.mentions.length) {
        const links = el('div', { class: 'nv-asst-mentions' });
        for (const type of message.mentions) {
          const name = typeLabelOf(type);
          const button = el('button', { type: 'button', class: 'nv-asst-mention' }, icon('help', 13), el('span', { text: T('nodes.assistant.help', { name }) }));
          button.addEventListener('click', () => deps.help.openPopover(type, button));
          links.append(button);
        }
        wrap.append(links);
      }
      if (message.steps && message.steps.length) {
        const names = message.steps.map((step) => {
          const key = `nodes.assistant.tool.${step.tool}`;
          const label = T(key);
          return label === key ? step.tool : label;
        });
        wrap.append(el('p', { class: 'nv-asst-steps', text: T('nodes.assistant.steps', { tools: names.join(', ') }) }));
      }
      if (message.editCard) wrap.append(renderEditCard(message));
      if (message.card) wrap.append(renderCard(message));
      if (message.runCard) wrap.append(renderRunCard(message));
      for (const action of message.confirmations || []) wrap.append(renderConfirmation(message, action));
      for (const note of message.notes || []) wrap.append(el('div', { class: `nv-asst-note is-${note.kind || 'info'}` }, icon(note.kind === 'warn' ? 'warning' : 'check', 13), el('span', { text: note.text })));
      if (message.adjusted && message.adjusted.length) {
        const list = el('ul', { class: 'nv-asst-adjusted' });
        for (const line of message.adjusted) list.append(el('li', { text: line }));
        wrap.append(el('div', { class: 'nv-asst-note is-warn' }, icon('warning', 13), el('div', {}, el('strong', { text: T('nodes.assistant.adjusted.title') }), list)));
      }
      if (message.modelLine) wrap.append(el('p', { class: 'nv-asst-model', text: message.modelLine }));
      if (message.meta && message.meta.length) wrap.append(el('p', { class: 'nv-asst-meta', text: message.meta.join(' · ') }));
      return wrap;
    }

    /* ----- the card "N nodes inserted" ----- */

    // 'ready' (undo possible: the history has not changed since the insertion), 'later' (edited since), 'gone' (the items are
    // not on the canvas any more). "Not changed" is the revision counter of history.js, which every commit, undo, redo, reset and
    // clear moves on; the position in the stack would stay the same once the stack is full or after the workflow is opened again.
    function cardState(card) {
      if (card.kind === 'edit') {
        if (card.undone) return 'gone';
        if (!card.adopted) return 'later';
        return deps.historyRevision() === card.revision ? 'ready' : 'later';
      }
      const graph = deps.getGraph();
      const present = card.nodeIds.length
        ? card.nodeIds.every((id) => graph.nodes.some((node) => node.id === id))
        : card.edgeIds.length > 0 && card.edgeIds.every((id) => graph.edges.some((edge) => edge.id === id));
      if (!present) return 'gone';
      return deps.historyRevision() === card.revision ? 'ready' : 'later';
    }

    function titleOfCard(card) {
      if (card.nodeIds.length) return T(card.nodeIds.length === 1 ? 'nodes.assistant.inserted.one' : 'nodes.assistant.inserted.many', { count: card.nodeIds.length });
      return T(card.edgeIds.length === 1 ? 'nodes.assistant.connected.one' : 'nodes.assistant.connected.many', { count: card.edgeIds.length });
    }

    function costText(cost) {
      if (!cost || cost.state === 'checking') return T('nodes.assistant.cost.checking');
      if (cost.state === 'failed') return T('nodes.assistant.cost.failed');
      if (cost.state === 'none') return T('nodes.assistant.cost.none');
      const amount = amountText(cost);
      if (cost.state === 'known') return T('nodes.assistant.cost.known', { amount });
      if (cost.state === 'partial') return T('nodes.assistant.cost.knownPartial', { amount, count: cost.unknown });
      return T('nodes.assistant.cost.unknown', { count: cost.unknown });
    }

    function amountText(cost) {
      const parts = OCD.run.costParts({ usd: cost.usd, credits: cost.credits });
      const pieces = [];
      if (parts.usd) pieces.push(parts.usd);
      if (parts.credits) pieces.push(T('nodes.cost.credits', { credits: parts.credits }));
      return pieces.join(' · ');
    }

    function renderCard(message) {
      const card = message.card;
      const state = cardState(card);
      card.lastState = state;
      const box = el('section', { class: `nv-asst-card is-${state}`, 'aria-label': titleOfCard(card) });
      box.append(el('h3', { class: 'nv-asst-card-title' }, icon('check', 15), el('span', { text: titleOfCard(card) })));
      if (card.names.length) {
        const names = el('ul', { class: 'nv-asst-names' });
        for (const item of card.names.slice(0, LIMITS.namesShown)) {
          const reg = deps.getReg();
          const def = reg && reg.types.get(item.type);
          names.append(el('li', { class: 'nv-asst-name' }, el('span', { class: 'nv-node-icon', dataset: { cat: def ? def.category : 'unknown' } }, ui.categoryIcon(def ? def.category : 'unknown', 13)), el('span', { text: item.label })));
        }
        if (card.names.length > LIMITS.namesShown) names.append(el('li', { class: 'nv-asst-name is-more', text: `+${card.names.length - LIMITS.namesShown}` }));
        box.append(names);
      }
      const linkCount = card.edgeIds.length;
      box.append(
        el('p', { class: 'nv-asst-card-line', text: !linkCount ? T('nodes.assistant.links.none') : card.existingLinks ? T('nodes.assistant.links.someExisting', { count: linkCount, existing: card.existingLinks }) : T('nodes.assistant.links.some', { count: linkCount }) })
      );
      if (card.skipped) box.append(el('p', { class: 'nv-asst-card-line is-warn', text: T('nodes.assistant.skipped', { count: card.skipped }) }));
      // only new nodes can cost something; a connection never does
      if (card.nodeIds.length) box.append(el('p', { class: `nv-asst-card-line nv-asst-cost is-${card.cost ? card.cost.state : 'checking'}`, title: T('nodes.cost.estimateHint'), text: costText(card.cost) }));
      box.append(el('p', { class: 'nv-asst-card-line is-faint', text: T('nodes.assistant.notStarted', { all: T('nodes.run.all'), selection: T('nodes.run.selection') }) }));
      box.append(renderUndoActions(message, card, state));
      return box;
    }

    // Both insertion and saved-edit cards use the same history guard and undo controls.
    function renderUndoActions(message, card, state) {
      const actions = el('div', { class: 'nv-asst-card-actions' });
      if (card.undone) actions.append(el('span', { class: 'nv-asst-undone', text: T('nodes.assistant.undone') }));
      else if (state !== 'gone' && card.adopted !== false) {
        const undo = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-asst-undo', disabled: state !== 'ready' }, icon('undo', 13), el('span', { text: T('nodes.assistant.undo') }));
        undo.title = T(state === 'ready' ? 'nodes.assistant.undoTitle' : 'nodes.assistant.undoLater');
        undo.addEventListener('click', () => {
          if (deps.getWorkflowId() !== message.workflowId || cardState(card) !== 'ready') return;
          card.undone = true;
          deps.undo();
          if (deps.getWorkflowId() === message.workflowId) place(message);
        });
        actions.append(undo);
      }
      if (state !== 'gone' && card.nodeIds.length) {
        const show = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-asst-show', title: T('nodes.assistant.showTitle') }, icon('fit', 13), el('span', { text: T('nodes.assistant.show') }));
        show.addEventListener('click', () => {
          if (deps.getWorkflowId() === message.workflowId) deps.showNodes(card.nodeIds.filter((id) => deps.getGraph().nodes.some((node) => node.id === id)));
        });
        actions.append(show);
      }
      return actions;
    }

    function renderEditCard(message) {
      const card = message.editCard;
      const state = cardState(card);
      card.lastState = state;
      const box = el('section', { class: 'nv-asst-card nv-asst-edit' });
      box.append(el('h3', { class: 'nv-asst-card-title', text: T('nodes.assistant.changed', { count: card.edit.changes.length + (Number.isFinite(card.edit.more) ? card.edit.more : 0) }) }));
      const list = el('ul', { class: 'nv-asst-adjusted' });
      for (const line of changeLines(card.edit, T, ui.paramLabel)) list.append(el('li', { text: line }));
      box.append(list);
      if (!card.adopted) box.append(el('p', { class: 'nv-asst-card-line is-warn', text: T('nodes.assistant.editConflict') }));
      else box.append(renderUndoActions(message, card, state));
      return box;
    }

    function runDisabled(message) {
      return message.runCard.used || deps.getWorkflowId() !== message.workflowId || Boolean(deps.isRunActive && deps.isRunActive());
    }

    function renderRunCard(message) {
      const card = message.runCard;
      const box = el('section', { class: 'nv-asst-card nv-asst-run' });
      box.append(el('h3', { class: 'nv-asst-card-title', text: T('nodes.assistant.run.title') }));
      for (const line of runLines(card.request, T, (cost) => amountText(cost) || money(cost.usd))) box.append(el('p', { class: 'nv-asst-card-line', text: line }));
      card.lastDisabled = runDisabled(message);
      const start = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-asst-start', disabled: card.lastDisabled,
        text: T(card.used ? 'nodes.assistant.run.handed' : runIsPaid(card.request) ? 'nodes.assistant.run.checkStart' : 'nodes.assistant.run.start') });
      start.addEventListener('click', () => {
        if (runDisabled(message) || !deps.startRun) return;
        card.used = true;
        place(message);
        const { mode, nodeIds, nodeId, items, force } = card.request;
        // The run controller owns all gates, including costs, automatic approval and active runs.
        Promise.resolve(deps.startRun({ mode, nodeIds, nodeId, items, force })).catch(() => {});
      });
      box.append(start);
      return box;
    }

    function renderConfirmation(message, action) {
      const text = confirmationText(action, T);
      const box = el('section', { class: 'nv-asst-card nv-asst-confirm' });
      box.append(el('h3', { class: 'nv-asst-card-title', text: text.title }));
      for (const line of text.lines) box.append(el('p', { class: 'nv-asst-card-line', text: line }));
      const status = el('p', { class: 'nv-asst-action-status', role: 'status', tabindex: '-1', text: action.error || (action.state ? T(`nodes.assistant.confirm.${action.state}`) : '') });
      box.append(status);
      const url = safeActionUrl(action.result && action.result.url);
      if (url) box.append(el('a', { class: 'nv-asst-result-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: action.result.url }));
      if (['done', 'discarded', 'expired'].includes(action.state)) return box;
      const controls = el('div', { class: 'nv-asst-card-actions' });
      const accept = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-asst-accept', disabled: action.state === 'busy', text: text.verb });
      const discard = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-asst-discard', disabled: action.state === 'busy', text: T('nodes.assistant.confirm.discard') });
      const perform = async (remove) => {
        if (action.state === 'busy' || ['done', 'discarded', 'expired'].includes(action.state)) return;
        action.state = 'busy';
        action.error = '';
        accept.disabled = discard.disabled = true;
        status.textContent = T('nodes.assistant.confirm.busy');
        status.focus({ preventScroll: true });
        try {
          if (remove) await api.discardAssistantAction(message.workflowId, action.id);
          else {
            const answer = await api.assistantAction(message.workflowId, action.id);
            action.result = answer.result;
          }
          action.state = remove ? 'discarded' : 'done';
        } catch (error) {
          action.state = error.code === 'ACTION_EXPIRED' ? 'expired' : '';
          if (!action.state) action.error = error.message;
        }
        if (deps.getWorkflowId() === message.workflowId) {
          const focused = typeof document !== 'undefined' && box.contains(document.activeElement);
          place(message);
          // Restore focus only if it was still in this action, never while someone types elsewhere.
          if (focused) shown.get(message.id)?.querySelectorAll('.nv-asst-action-status')[message.confirmations.indexOf(action)]?.focus({ preventScroll: true });
        }
      };
      accept.addEventListener('click', () => perform(false));
      discard.addEventListener('click', () => perform(true));
      controls.append(accept, discard);
      box.append(controls);
      return box;
    }

    // The cards follow the canvas: undo is offered only while nothing was done after the insertion.
    function repaintCards() {
      const current = thread();
      if (!current || !view.list) return;
      for (const message of current.messages) {
        const cards = [message.card, message.editCard].filter(Boolean);
        if (cards.some((card) => card.lastState !== cardState(card)) ||
            (message.runCard && message.runCard.lastDisabled !== runDisabled(message))) place(message);
      }
    }

    async function loadCost(current, message) {
      const card = message.card;
      try {
        await deps.flushSave();
        const plan = await deps.plan();
        const reg = deps.getReg();
        const graph = deps.getGraph();
        const nodes = card.nodeIds.map((id) => graph.nodes.find((node) => node.id === id)).filter(Boolean);
        const result = costOfInserted(nodes, plan, (type) => {
          const def = reg && reg.types.get(type);
          return Boolean(def && def.paid);
        });
        const known = OCD.run.costParts({ usd: result.usd, credits: result.credits });
        const hasAmount = Boolean(known.usd || known.credits);
        let state;
        if (!result.paid) state = 'none';
        else if (!result.unknown) state = hasAmount ? 'known' : 'none';
        else state = hasAmount ? 'partial' : 'unknown';
        card.cost = { state, usd: result.usd, credits: result.credits, unknown: result.unknown };
      } catch (_) {
        card.cost = { state: 'failed' };
      }
      if (threads.get(current.id) === current && deps.getWorkflowId() === current.id) {
        // the card grows by the cost line: whoever read down to it keeps seeing its end
        const list = view.list;
        const atEnd = list ? list.scrollHeight - list.scrollTop - list.clientHeight < 140 : false;
        place(message);
        if (atEnd) scrollDown();
      }
    }

    /* ----- asking ----- */

    function newMessage(fields) {
      return { id: nextId++, ...fields };
    }

    function submit() {
      const current = thread();
      if (!current || current.busy) return;
      const text = view.input.value.trim();
      if (!text) return;
      ask(text);
    }

    function ask(text) {
      const current = thread();
      if (!current || current.busy) return;
      const question = String(text).trim().slice(0, LIMITS.question);
      if (!question) return;
      const history = requestHistory(current.messages);
      const mine = newMessage({ role: 'user', text: question });
      current.messages.push(mine);
      // a very long conversation does not grow without end: the oldest messages go
      for (const gone of current.messages.splice(0, Math.max(0, current.messages.length - LIMITS.keptMessages))) {
        const element = shown.get(gone.id);
        if (element) element.remove();
        shown.delete(gone.id);
      }
      current.draft = '';
      if (view.input) {
        view.input.value = '';
        autosize();
      }
      place(mine);
      run(current, question, history);
    }

    function retryAfterError(message) {
      const current = thread();
      if (!current || current.busy) return;
      const index = current.messages.indexOf(message);
      if (index < 1) return;
      const question = current.messages[index - 1];
      if (question.role !== 'user') return;
      const history = requestHistory(current.messages.slice(0, index - 1));
      current.messages.splice(index, 1);
      const element = shown.get(message.id);
      if (element) element.remove();
      shown.delete(message.id);
      run(current, question.text, history);
    }

    async function run(current, question, history) {
      const pending = newMessage({ role: 'assistant', pending: true, text: '' });
      current.messages.push(pending);
      current.busy = true;
      place(pending);
      scrollDown();
      paintSend();
      let answer = null;
      let problem = null;
      let message;
      let adoptedRev = null;
      const release = deps.holdExternalSaves ? deps.holdExternalSaves(current.id) : () => {};
      try {
        await deps.flushSave();
        const body = {
          question,
          canvas: summarizeCanvas(deps.getGraph(), { selected: deps.getSelection(), warnings: deps.getWarnings() }),
          history, lang: deps.getLang(), tools: true,
          rev: deps.getWorkflowId() === current.id && deps.savedRev ? deps.savedRev() : null
        };
        if (deps.getWorkflowId() !== current.id) throw new Error(T('nodes.assistant.notInserted'));
        const model = currentModel();
        if (model) body.model = model;
        answer = await api.assistant(current.id, body);
        let adopted = false;
        if (answer.edit && deps.adoptServerEdit) {
          const result = await deps.adoptServerEdit(answer.edit, current.id);
          adopted = Boolean(result && result.ok);
          if (adopted) adoptedRev = answer.edit.rev;
        }
        message = answerMessage(current, answer, adopted);
      } catch (error) {
        problem = error;
      } finally {
        await release(adoptedRev);
      }
      current.busy = false;
      const index = current.messages.indexOf(pending);
      if (index < 0) return; // the conversation was cleared meanwhile
      if (problem) message = errorMessage(problem);
      message.id = pending.id;
      current.messages[index] = message;
      if (deps.getWorkflowId() === current.id) {
        place(message);
        reveal(shown.get(message.id));
        paintBudget();
        paintSend();
        if (message.card && message.card.nodeIds.length) loadCost(current, message);
      }
    }

    function errorMessage(error) {
      const info = failure(error, T);
      if (info.kind === 'budget' && error.body && error.body.budget) setBudget(error.body.budget);
      return { role: 'assistant', text: '', error: { kind: info.kind, text: info.text, retry: info.retry } };
    }

    function setBudget(snapshot) {
      if (snapshot && typeof snapshot === 'object') budget = { limitUsd: Number(snapshot.limitUsd) || 0, spentUsd: Number(snapshot.spentUsd) || 0, reservedUsd: Number(snapshot.reservedUsd) || 0, remainingUsd: Number(snapshot.remainingUsd) || 0 };
      const a = access();
      if (a && a.refreshMe) Promise.resolve(a.refreshMe()).catch(() => {});
    }

    // The answer of the server -> the message; an insert proposal is applied right here (one step in the history).
    function answerMessage(current, answer, adopted = false) {
      const reg = deps.getReg();
      const mentions = (Array.isArray(answer.mentions) ? answer.mentions : []).filter((type, index, all) => typeof type === 'string' && reg && reg.types.has(type) && all.indexOf(type) === index);
      const message = { role: 'assistant', workflowId: current.id, text: String(answer.answer || ''), mentions, notes: [], meta: [], modelLine: '', adjusted: [] };
      if (answer.budget) setBudget(answer.budget);
      const usage = isPlain(answer.usage) ? answer.usage : {};
      if (usage.replaced) {
        message.notes.push({ kind: 'warn', text: isNumber(usage.usd) ? T('nodes.assistant.replaced', { amount: OCD.run.formatUsd(usage.usd) }) : T('nodes.assistant.replacedUnknown') });
      }
      // which model answered, small under the answer; a replacement for the subscription is said again in the note above
      if (typeof usage.model === 'string' && usage.model) message.modelLine = T(usage.replaced ? 'nodes.assistant.answeredByReplaced' : 'nodes.assistant.answeredBy', { model: modelName(usage.model) });
      if (usage.billing === 'usd' && !usage.replaced) message.meta.push(isNumber(usage.usd) ? T('nodes.assistant.questionCost', { amount: OCD.run.formatUsd(usage.usd) }) : T('nodes.assistant.questionCostUnknown'));
      const quota = isPlain(answer.quota) ? answer.quota : null;
      if (quota && isNumber(quota.remaining) && quota.remaining <= QUOTA_NOTE_AT) message.meta.push(T('nodes.assistant.quotaLow', { remaining: quota.remaining, minutes: Math.max(1, Math.round((Number(quota.windowSeconds) || 600) / 60)) }));
      if (answer.insertRejected) message.notes.push({ kind: 'warn', text: T('nodes.assistant.rejected') });
      message.steps = (Array.isArray(answer.steps) ? answer.steps : []).filter((step) => step && typeof step.tool === 'string');
      if (answer.edit) {
        const changes = Array.isArray(answer.edit.changes) ? answer.edit.changes : [];
        const nodeIds = [...new Set(changes.flatMap((change) => [change.node?.id, change.from?.node?.id, change.to?.node?.id]).filter(Boolean))];
        message.editCard = { kind: 'edit', edit: { ...answer.edit, changes }, nodeIds, adopted, revision: deps.historyRevision(), undone: false };
      }
      if (answer.insert) {
        if (answer.edit && !adopted) message.notes.push({ kind: 'warn', text: T('nodes.assistant.notInsertedEdit') });
        else applyInsert(current, answer, message);
      }
      if (answer.run) message.runCard = { request: answer.run, used: false };
      message.confirmations = (Array.isArray(answer.confirm) ? answer.confirm : []).filter((action) => action && ACTION_TOOLS.includes(action.tool)).map((action) => ({ ...action, state: '', error: '' }));
      return message;
    }

    function applyInsert(current, answer, message) {
      if (deps.getWorkflowId() !== current.id || !deps.canInsert()) {
        message.notes.push({ kind: 'warn', text: T('nodes.assistant.notInserted') });
        return;
      }
      const built = buildSubgraph(answer.insert, { labelOf: typeLabelOf });
      const refNames = new Map();
      for (const item of Array.isArray(answer.insert.nodes) ? answer.insert.nodes : []) {
        if (item && typeof item.ref === 'string') refNames.set(item.ref, (typeof item.label === 'string' && item.label.trim()) || typeLabelOf(item.type));
      }
      const result = deps.insert(built.sub, { history: 'insert-assistant', fresh: true });
      if (!result) {
        message.notes.push({ kind: 'warn', text: T('nodes.assistant.insertFailed') });
        return;
      }
      const skippedLinks = (result.skippedLinks || []).length + built.skipped;
      const nodeIds = result.ids.nodes.slice();
      const edgeIds = result.ids.edges.slice();
      if (!nodeIds.length && !edgeIds.length) {
        message.notes.push({ kind: 'warn', text: T('nodes.assistant.insertFailed') });
        return;
      }
      const tempToId = result.idMap || {};
      const names = built.names.filter((item) => has(tempToId, item.id)).map((item) => ({ id: tempToId[item.id], type: item.type, label: item.label }));
      const skippedAt = new Set((result.skippedLinks || []).map((item) => item.index));
      const existingLinks = built.sub.links.filter((link, index) => (link.from.existing || link.to.existing) && !skippedAt.has(index)).length;
      message.card = {
        nodeIds,
        edgeIds,
        names,
        existingLinks,
        skipped: skippedLinks,
        revision: deps.historyRevision(),
        undone: false,
        lastState: 'ready',
        cost: { state: 'checking' }
      };
      message.adjusted = adjustedLines(answer.adjusted, refNames, T, ui.paramLabel);
      ui.toast(`${titleOfCard(message.card)}. ${T('nodes.assistant.toastNotStarted')}`);
    }

    function startOver() {
      const current = thread();
      if (!current || current.busy) return;
      current.messages = [];
      current.draft = '';
      paintAll();
      view.input.focus({ preventScroll: true });
    }

    /* ----- opening and closing ----- */

    function setOpen(next, options = {}) {
      if (next && !deps.getWorkflowId()) next = false;
      const changed = open !== next;
      open = next;
      host.classList.toggle('is-open', open);
      if (open) {
        if (changed) paintAll();
        paintBudget();
        paintModels();
        if (options.focus !== false) view.input.focus({ preventScroll: true });
      }
      if (changed && deps.onToggle) deps.onToggle(open, options);
    }

    function relabel() {
      build();
      paintAll();
    }

    // Another workflow is open (or none): the panel shows that conversation.
    function workflowChanged() {
      if (!deps.getWorkflowId()) {
        if (open) setOpen(false);
        return;
      }
      if (open) paintAll();
    }

    for (const event of ['graph', 'sse', 'reconcile']) OCD.bus.on(event, () => {
      if (open) repaintCards();
    });

    build();

    return {
      open: (options) => setOpen(true, options),
      close: (options) => setOpen(false, options),
      toggle: (options) => setOpen(!open, options),
      isOpen: () => open,
      relabel,
      workflowChanged,
      ask,
      focus: () => view.input && view.input.focus({ preventScroll: true })
    };
  }

  return { ...pure, createAssistant };
});
