'use strict';

// Design App view of the node view (SPEC §14, WP7): `#app=<workflowId>` renders a clean page without
// canvas. The form is generated from workflow.app.inputs with the same param widgets as the inspector,
// the run sends the form values as `overrides` (the saved graph is never changed), live status comes from
// the SSE stream through the pure reducer of run.js, and the outputs of the app are shown as a result
// gallery with download, viewer and "send to chat". Lists (text list, media list) make the run a batch:
// the engine maps the flow once per item. Only in-app dialogs, texts of users and LLMs via textContent.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const ui = OCD.ui;
  const api = OCD.api;
  const runLib = OCD.run;
  const { el, icon, T } = ui;

  const enc = encodeURIComponent;
  const LS_PREFIX = 'ocd-nodes-app-';
  const PLAN_DELAY = 900;
  const MAX_LIST_ITEMS = 50;

  function lsGet(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      global.localStorage.setItem(key, value);
    } catch (_) {
      /* storage may be unavailable */
    }
  }

  // Mirrors parseTextList of lib/nodes/nodes-basic.js: lines, or blocks separated by a line `---`.
  function countTextItems(text) {
    const lines = String(text || '').split(/\r?\n/);
    let items;
    if (lines.some((line) => line.trim() === '---')) {
      items = [];
      let block = [];
      for (const line of lines) {
        if (line.trim() === '---') {
          items.push(block.join('\n'));
          block = [];
        } else {
          block.push(line);
        }
      }
      items.push(block.join('\n'));
    } else {
      items = lines;
    }
    return items.map((item) => item.trim()).filter(Boolean).length;
  }

  function costText(cost, options = {}) {
    const p = runLib.costParts(cost);
    const pieces = [];
    if (p.usd) pieces.push(options.estimate ? T('nodes.cost.estimate', { amount: p.usd }) : p.usd);
    if (p.credits) pieces.push(options.estimate ? T('nodes.cost.creditsEstimate', { credits: p.credits }) : T('nodes.cost.credits', { credits: p.credits }));
    return pieces.join(' · ');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return date.toLocaleString();
    }
  }

  const isAssetKind = (kind) => kind === 'asset' || kind === 'assets';

  function createAppView({ host, callbacks }) {
    const cb = callbacks || {};
    let reg = null;
    let s = null; // state of the opened app
    let token = 0;

    const bar = el('header', { class: 'nv-appbar' });
    const backBtn = el('button', { type: 'button', class: 'nv-btn nv-back' }, icon('back', 15), el('span', { class: 'nv-btn-text' }));
    backBtn.addEventListener('click', () => cb.onBack && cb.onBack());
    const crumb = el('div', { class: 'nv-appbar-crumb' }, el('span', { class: 'nv-appbar-mark' }, icon('app', 14)), el('span', { class: 'nv-appbar-label' }));
    const editBtn = el('button', { type: 'button', class: 'nv-btn' }, icon('workflow', 14), el('span', { class: 'nv-btn-text' }));
    editBtn.addEventListener('click', () => s && cb.onEdit && cb.onEdit(s.id));
    const copyBtn = el('button', { type: 'button', class: 'nv-btn' }, icon('link', 14), el('span', { class: 'nv-btn-text' }));
    copyBtn.addEventListener('click', copyLink);
    // The same menu as in the other headers (costs, settings, help, language, sign-out).
    const accountMenu = global.OCShell ? global.OCShell.accountMenu({ variant: 'nodes' }) : null;
    bar.append(backBtn, crumb, el('div', { class: 'nv-topbar-spacer' }), copyBtn, editBtn);
    if (accountMenu) bar.append(accountMenu.element);
    const scroll = el('div', { class: 'nv-appscroll' });
    const wrap = el('div', { class: 'nv-appwrap' });
    scroll.append(wrap);
    host.append(bar, scroll);

    function labelBar() {
      backBtn.querySelector('.nv-btn-text').textContent = T('nodes.topbar.back');
      backBtn.title = T('nodes.topbar.backTitle');
      crumb.querySelector('.nv-appbar-label').textContent = T('nodes.app.viewLabel');
      editBtn.querySelector('.nv-btn-text').textContent = T('nodes.app.editWorkflow');
      editBtn.title = T('nodes.app.editWorkflowHint');
      copyBtn.querySelector('.nv-btn-text').textContent = T('nodes.app.copyLink');
    }
    labelBar();

    async function copyLink() {
      if (!s) return;
      const url = new URL(`#app=${enc(s.id)}`, `${global.location.origin}${global.location.pathname}`).href;
      const ok = await OCD.preview.copyText(url);
      // A private workflow: the link only works for others after it has been shared.
      const wf = s.workflow;
      const isPrivate = Boolean(global.OCAccess && global.OCAccess.isActive() && wf && wf.unowned === false && wf.shareMode === 'private');
      if (ok && isPrivate) ui.toast(T('nodes.app.linkCopiedPrivate'), { kind: 'warn', timeout: 8000 });
      else ui.toast(ok ? T('nodes.app.linkCopied') : T('nodes.preview.copyFailed'), { kind: ok ? undefined : 'warn' });
    }

    /* ---------- lifecycle ---------- */

    function stopTimers() {
      if (!s) return;
      clearTimeout(s.planTimer);
      clearInterval(s.ticker);
      s.ticker = null;
    }

    function closeEvents() {
      if (s && s.events) {
        s.events.close();
        s.events = null;
      }
    }

    function close() {
      token += 1;
      stopTimers();
      closeEvents();
      s = null;
      wrap.textContent = '';
    }

    function message(kind, text, actions = []) {
      wrap.textContent = '';
      const box = el('div', { class: `nv-appmsg is-${kind}` }, ui.icon(kind === 'error' ? 'warning' : 'app', 26), el('h2', { text }));
      const row = el('div', { class: 'nv-appmsg-actions' });
      for (const action of actions) {
        const button = el('button', { type: 'button', class: `nv-btn ${action.primary ? 'nv-btn-primary' : ''}`.trim(), text: action.label });
        button.addEventListener('click', action.onClick);
        row.append(button);
      }
      if (actions.length) box.append(row);
      wrap.append(box);
    }

    function showError(text) {
      close();
      message('error', text, [{ label: T('nodes.topbar.backTitle'), onClick: () => cb.onBack && cb.onBack() }]);
    }

    async function open(id, registry) {
      close();
      reg = registry || reg;
      labelBar();
      const mine = ++token;
      message('info', T('nodes.app.loading'));
      let payload;
      try {
        payload = await api.getWorkflow(id);
      } catch (error) {
        if (mine !== token) return;
        message('error', error.status === 404 ? T('nodes.toast.notFound') : T('nodes.toast.loadFailed', { error: error.message }), [{ label: T('nodes.topbar.backTitle'), onClick: () => cb.onBack && cb.onBack() }]);
        return;
      }
      if (mine !== token) return;
      s = {
        id,
        workflow: payload.workflow,
        results: payload.results,
        values: new Map(),
        fields: [],
        run: runLib.createRunState(),
        plan: null,
        planError: null,
        planTimer: null,
        planToken: 0,
        ticker: null,
        starting: false,
        events: null,
        refs: null,
        sseBroken: false
      };
      if (payload.activeRun) s.run = { ...runLib.createRunState(), runId: typeof payload.activeRun === 'string' ? payload.activeRun : payload.activeRun.runId, active: true, status: 'running' };
      build();
      openEvents();
      refreshPlan(0);
      if (s.run.active) startTicker();
    }

    function openEvents() {
      const id = s.id;
      s.events = api.openEvents(id, {
        onEvent: (event) => {
          if (!s || s.id !== id) return;
          dispatch(event);
        },
        onError: () => {
          if (s) s.sseBroken = true;
          checkAccess();
        },
        onOpen: () => {
          if (s && s.sseBroken) {
            s.sseBroken = false;
            reconcile();
          }
        }
      });
    }

    // The owner can take the sharing back at any time: the app then answers 404 and the stream must not linger.
    async function checkAccess() {
      if (!s || !global.OCAccess || !global.OCAccess.isActive()) return;
      const id = s.id;
      try {
        await api.getWorkflow(id);
      } catch (error) {
        if (error.status === 404 && s && s.id === id) {
          close();
          message('error', T('nodes.access.lost'), [{ label: T('nodes.topbar.backTitle'), onClick: () => cb.onBack && cb.onBack() }]);
        }
      }
    }

    async function reconcile() {
      if (!s) return;
      const id = s.id;
      try {
        const payload = await api.getWorkflow(id);
        if (!s || s.id !== id) return;
        s.results = payload.results;
        if (!payload.activeRun && s.run.active) dispatch({ type: 'snapshot', activeRun: null });
        renderResults();
      } catch (_) {
        /* the browser reconnects the stream on its own */
      }
    }

    /* ---------- definition helpers ---------- */

    function nodeOf(id) {
      return s.workflow.graph.nodes.find((node) => node.id === id) || null;
    }

    function titleOf(id) {
      const node = nodeOf(id);
      if (!node) return id;
      const def = reg.types.get(node.type);
      return node.title || (def ? ui.typeLabel(def) : node.type);
    }

    function appDef() {
      const app = s.workflow.app || {};
      return {
        enabled: app.enabled === true,
        title: app.title || s.workflow.name,
        description: app.description || '',
        inputs: Array.isArray(app.inputs) ? app.inputs : [],
        outputs: Array.isArray(app.outputs) ? app.outputs : []
      };
    }

    function storageKey() {
      return `${LS_PREFIX}${s.id}`;
    }

    function readStored() {
      try {
        const parsed = JSON.parse(lsGet(storageKey()) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (_) {
        return {};
      }
    }

    function writeStored() {
      const out = {};
      for (const field of s.fields) if (!isAssetKind(field.param.kind)) out[field.key] = s.values.get(field.key);
      lsSet(storageKey(), JSON.stringify(out));
    }

    /* ---------- build ---------- */

    function build() {
      const app = appDef();
      wrap.textContent = '';
      const usable = app.enabled && app.inputs.length && app.outputs.length;
      if (!usable) {
        message('info', app.enabled ? T('nodes.app.incompleteView') : T('nodes.app.disabledView'), [{ label: T('nodes.app.editWorkflow'), primary: true, onClick: () => cb.onEdit && cb.onEdit(s.id) }]);
        return;
      }
      const stored = readStored();
      const previous = s.values;
      s.values = new Map();
      s.fields = [];

      const grid = el('div', { class: 'nv-appgrid' });
      const formCard = el('section', { class: 'nv-appcard nv-appform', 'aria-label': app.title });
      formCard.append(el('h1', { class: 'nv-apptitle', text: app.title }));
      if (app.description) formCard.append(el('p', { class: 'nv-appdesc', text: app.description }));
      const fieldsBox = el('div', { class: 'nv-appfields' });
      formCard.append(fieldsBox);

      for (const entry of app.inputs) buildField(entry, fieldsBox, previous, stored);
      if (!s.fields.length) fieldsBox.append(el('div', { class: 'nv-hint', text: T('nodes.app.noFields') }));

      const actions = el('div', { class: 'nv-appactions' });
      const runBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-primary nv-apprun' }, icon('play', 13), el('span', { class: 'nv-apprun-label' }));
      runBtn.addEventListener('click', () => startRun());
      const cancelBtn = el('button', { type: 'button', class: 'nv-btn nv-appcancel hidden' }, icon('stop', 12), el('span', { text: T('nodes.run.cancel') }));
      cancelBtn.addEventListener('click', cancelRun);
      const hint = el('div', { class: 'nv-apphint', role: 'status' });
      actions.append(el('div', { class: 'nv-appactions-row' }, runBtn, cancelBtn), hint);
      formCard.append(actions);
      const statusBox = el('div', { class: 'nv-appstatus hidden', role: 'status' });
      formCard.append(statusBox);

      const results = el('section', { class: 'nv-appresults', 'aria-label': T('nodes.app.results') });
      const resultsHead = el('div', { class: 'nv-appresults-head' });
      const outputsBox = el('div', { class: 'nv-appoutputs' });
      results.append(resultsHead, outputsBox);

      grid.append(formCard, results);
      wrap.append(grid);
      s.refs = { fieldsBox, runBtn, cancelBtn, hint, statusBox, resultsHead, outputsBox };
      refreshVisibility();
      renderRunButton();
      renderStatus();
      renderResults();
    }

    function buildField(entry, container, previous, stored) {
      const node = nodeOf(entry.node);
      if (!node) return;
      const def = reg.types.get(node.type);
      const param = def && def.params.find((item) => item.id === entry.param);
      if (!param) return;
      const connected = new Set(graphLib.incomingEdges(s.workflow.graph, node.id).map((edge) => edge.to.port));
      const ports = graphLib.portsFor(reg, node);
      if (ports.inputs.some((port) => port.param === param.id && connected.has(port.id))) return; // driven by a connection
      const key = `${node.id}.${param.id}`;
      const effective = graphLib.effectiveParams(def, node);
      let initial = previous.has(key) ? previous.get(key) : stored[key] !== undefined ? stored[key] : effective[param.id];
      if (isAssetKind(param.kind)) {
        if (previous.has(key)) initial = previous.get(key);
        else if (param.kind === 'asset') initial = initial && !initial.missing ? initial : null;
        else initial = Array.isArray(initial) ? initial.filter((item) => item && !item.missing) : [];
      }
      s.values.set(key, initial);
      const field = { key, entry, node, def, param, connected, wrap: null, error: null, counter: null };
      const widget = ui.paramWidget(param, initial, {
        node,
        compact: false,
        workflowId: s.id,
        onChange: (value, meta) => {
          s.values.set(key, value);
          field.error = null;
          updateFieldMeta(field);
          refreshVisibility();
          if (!meta || meta.commit !== false) writeStored();
          schedulePlan();
        },
        uploadFile: (file, options) => api.upload(s.id, file, options).then((result) => result.value)
      });
      field.widget = widget;
      const batch = node.type === 'input.text_list' || node.type === 'input.media_list';
      const label = entry.label || (def.category === 'input' ? ui.typeLabel(def) : ui.paramLabel(param.id));
      const fieldEl = ui.field(label, widget.el, { hint: param.kind === 'textarea' && node.type === 'input.text_list' ? T('nodes.app.listHint') : '' });
      field.wrap = fieldEl;
      if (batch) {
        field.counter = el('div', { class: 'nv-batch-count' });
        fieldEl.append(field.counter);
      }
      field.errorEl = el('div', { class: 'nv-field-error hidden', role: 'alert' });
      fieldEl.append(field.errorEl);
      updateFieldMeta(field);
      container.append(fieldEl);
      s.fields.push(field);
    }

    // Batch counter and validation message of one field.
    function updateFieldMeta(field) {
      if (field.counter) {
        const value = s.values.get(field.key);
        const count = field.node.type === 'input.text_list' ? countTextItems(value) : Array.isArray(value) ? value.length : 0;
        const limit = field.node.type === 'input.text_list' ? Math.min(MAX_LIST_ITEMS, Number(field.node.params.max) || MAX_LIST_ITEMS) : MAX_LIST_ITEMS;
        field.counter.textContent = count > limit ? T('nodes.app.batchTruncated', { count, max: limit }) : T('nodes.app.batchCount', { count });
        field.counter.classList.toggle('is-warn', count > limit || count === 0);
      }
      field.errorEl.textContent = field.error || '';
      field.errorEl.classList.toggle('hidden', !field.error);
      field.wrap.classList.toggle('has-error', Boolean(field.error));
    }

    // showIf conditions of exposed params depend on the current form values of the same node.
    function virtualNode(field) {
      const params = { ...field.node.params };
      for (const other of s.fields) if (other.node.id === field.node.id) params[other.param.id] = s.values.get(other.key);
      return { ...field.node, params };
    }

    function refreshVisibility() {
      for (const field of s.fields) {
        field.visible = graphLib.isVisible(field.param.showIf, virtualNode(field), field.def, field.connected);
        field.wrap.classList.toggle('hidden', !field.visible);
      }
    }

    /* ---------- overrides, validation ---------- */

    function buildOverrides() {
      const overrides = {};
      for (const field of s.fields) {
        if (!field.visible) continue;
        const value = s.values.get(field.key);
        if (value === undefined || (isAssetKind(field.param.kind) && (value === null || (Array.isArray(value) && !value.length)))) continue;
        (overrides[field.node.id] = overrides[field.node.id] || {})[field.param.id] = value;
      }
      return overrides;
    }

    // Client side checks that give better messages than the plan issues; returns the first invalid field.
    function validateForm() {
      let first = null;
      for (const field of s.fields) {
        field.error = null;
        if (field.visible) {
          const value = s.values.get(field.key);
          if (field.param.kind === 'asset' && (!value || value.missing)) field.error = T('nodes.app.needAsset');
          else if (field.param.kind === 'assets' && (!Array.isArray(value) || !value.length)) field.error = T('nodes.app.needAssets');
          else if (field.node.type === 'input.text_list' && countTextItems(value) === 0) field.error = T('nodes.app.needItems');
        }
        updateFieldMeta(field);
        if (field.error && !first) first = field;
      }
      return first;
    }

    /* ---------- plan (cost hint) ---------- */

    function schedulePlan() {
      clearTimeout(s.planTimer);
      s.planTimer = setTimeout(() => refreshPlan(0), PLAN_DELAY);
    }

    async function refreshPlan(delay = 0) {
      if (!s) return;
      clearTimeout(s.planTimer);
      const id = s.id;
      const mine = ++s.planToken;
      const run = async () => {
        if (!s || s.id !== id || mine !== s.planToken) return;
        try {
          const plan = await api.plan(id, { mode: 'all', overrides: buildOverrides() });
          if (!s || s.id !== id || mine !== s.planToken) return;
          s.plan = plan;
          s.planError = null;
        } catch (error) {
          if (!s || s.id !== id || mine !== s.planToken) return;
          s.plan = null;
          s.planError = error;
        }
        renderRunButton();
      };
      if (delay) s.planTimer = setTimeout(run, delay);
      else await run();
    }

    function allCached(plan) {
      const nodes = plan && plan.nodes ? Object.values(plan.nodes) : [];
      return nodes.length > 0 && nodes.every((node) => node.status === 'cached');
    }

    function issueMessages(issues) {
      return (issues || []).filter((issue) => issue.level === 'error').map((issue) => ({ title: issue.nodeId ? titleOf(issue.nodeId) : '', message: ui.issueText(issue, 'app') }));
    }

    function renderRunButton() {
      if (!s || !s.refs) return;
      const { runBtn, cancelBtn, hint } = s.refs;
      const active = s.run.active || s.starting;
      const rerun = !active && allCached(s.plan);
      runBtn.disabled = active;
      const working = s.run.active || (s.starting && !s.asking);
      runBtn.classList.toggle('is-working', working);
      runBtn.querySelector('.nv-apprun-label').textContent = working ? T('nodes.app.running') : rerun ? T('nodes.app.runAgain') : T('nodes.app.run');
      cancelBtn.classList.toggle('hidden', !s.run.active);
      hint.textContent = '';
      hint.className = 'nv-apphint';
      if (active) return;
      if (s.planError) {
        const issues = issueMessages(s.planError.issues);
        hint.classList.add('is-warn');
        hint.append(icon('warning', 13), el('span', { text: issues.length ? `${issues[0].title ? `${issues[0].title}: ` : ''}${issues[0].message}` : s.planError.message }));
        return;
      }
      const plan = s.plan;
      if (!plan) return;
      const info = runLib.describePlan(plan, titleOf);
      if (!info.valid) {
        const issues = issueMessages(plan.issues);
        hint.classList.add('is-warn');
        hint.append(icon('warning', 13), el('span', { text: issues.length ? `${issues[0].title ? `${issues[0].title}: ` : ''}${issues[0].message}` : T('nodes.run.invalid.body') }));
        return;
      }
      if (rerun) {
        hint.append(icon('check', 13), el('span', { text: T('nodes.app.upToDate') }));
        return;
      }
      const gate = runLib.gateOf(info);
      if (gate) {
        hint.classList.add('is-warn');
        hint.append(icon('warning', 13), el('span', { text: gateText(gate) }));
        return;
      }
      if (!info.needsConfirm) {
        hint.append(icon('check', 13), el('span', { text: info.willRun ? T('nodes.app.hintFree', { count: info.willRun }) : T('nodes.app.upToDate') }));
        return;
      }
      const totals = info.totals;
      const amount = costText({ usd: totals.usd, credits: totals.credits }, { estimate: true });
      const parts = [T('nodes.app.hintPaid', { count: info.paid.length })];
      if (amount) parts.push(amount);
      if (totals.unknownNodes) parts.push(T('nodes.run.confirm.unknownCount', { count: totals.unknownNodes }));
      hint.classList.add('is-paid');
      hint.append(el('span', { class: 'nv-badge is-paid', text: '$' }), el('span', { text: parts.join(' · ') }));
    }

    /* ---------- run ---------- */

    function issueList(issues) {
      const list = el('ul', { class: 'nv-confirm-list is-issues' });
      for (const issue of issues) {
        const item = el('li', {});
        if (issue.title) item.append(el('strong', { text: issue.title }), ': ');
        item.append(el('span', { text: issue.message }));
        list.append(item);
      }
      return list;
    }

    async function showIssues(issues) {
      await ui.dialog({
        title: T('nodes.run.invalid.title'),
        message: T('nodes.run.invalid.body'),
        body: issueList(issues),
        buttons: [{ label: T('nodes.common.close'), value: true, primary: true, cancel: true }]
      });
    }

    // Dollar amounts of the budget (participants) as the account menu shows them.
    const money = (value) => (global.OCAccess && global.OCAccess.formatUsd ? global.OCAccess.formatUsd(value) : `$${Number(value || 0).toFixed(2)}`);
    const accountRuleText = (error) => (global.OCAccess && global.OCAccess.accountRuleMessage ? global.OCAccess.accountRuleMessage(error) : null);
    const refreshBudget = () => {
      if (global.OCAccess && global.OCAccess.me().restricted) global.OCAccess.refreshMe().catch(() => {});
    };

    // The words for a participant's run that cannot start (budget used up or too small, nodes of a blocked feature).
    function gateText(gate) {
      if (gate.kind === 'blocked') return T('nodes.run.blocked.body');
      if (gate.kind === 'exhausted') return T('nodes.run.budget.exhausted');
      return T('nodes.run.budget.insufficient', { estimate: money(gate.budget.estimateUsd), remaining: money(Math.max(0, gate.budget.remainingUsd)) });
    }

    async function showGate(gate) {
      const body = el('div', { class: 'nv-confirm' });
      if (gate.kind === 'blocked') {
        const list = el('ul', { class: 'nv-confirm-list is-issues' });
        for (const nodeId of gate.nodeIds) list.append(el('li', {}, el('span', { text: titleOf(nodeId) })));
        body.append(list);
      }
      await ui.dialog({
        title: T(gate.kind === 'blocked' ? 'nodes.run.blocked.title' : 'nodes.run.budget.title'),
        message: gateText(gate),
        body,
        buttons: [{ label: T('nodes.common.close'), value: true, primary: true, cancel: true }]
      });
    }

    async function confirmPaid(info) {
      const body = el('div', { class: 'nv-confirm' });
      body.append(el('p', { class: 'nv-confirm-intro', text: T('nodes.run.confirm.intro') }));
      const list = el('ul', { class: 'nv-confirm-list' });
      for (const row of info.paid) {
        const item = el('li', {});
        item.append(el('span', { class: 'nv-confirm-name', text: row.title }));
        if (row.executions && row.executions > 1) item.append(el('span', { class: 'nv-confirm-times', text: `× ${row.executions}` }));
        const amount = row.unknown ? T('nodes.run.confirm.unknown') : costText({ usd: row.usd ?? undefined, credits: row.credits ?? undefined }, { estimate: true }) || T('nodes.run.confirm.unknown');
        item.append(el('span', { class: `nv-confirm-cost ${row.unknown ? 'is-unknown' : ''}`.trim(), text: amount }));
        list.append(item);
      }
      body.append(list);
      const totals = info.totals;
      const summary = [];
      const totalCost = costText({ usd: totals.usd, credits: totals.credits }, { estimate: true });
      if (totalCost) summary.push(T('nodes.run.confirm.total', { amount: totalCost }));
      if (totals.unknownNodes) summary.push(T('nodes.run.confirm.unknownCount', { count: totals.unknownNodes }));
      if (summary.length) body.append(el('p', { class: 'nv-confirm-total', text: summary.join(' · ') }));
      body.append(el('p', { class: 'nv-confirm-note', text: T('nodes.run.confirm.estimateNote') }));
      if (totals.credits > 0) body.append(el('p', { class: 'nv-confirm-note', text: T('nodes.run.confirm.creditsNote') }));
      body.append(el('p', { class: 'nv-confirm-note', text: T('nodes.run.confirm.noRefund') }));
      const budgetText = runLib.budgetLine(info, T, money);
      if (budgetText) body.append(el('p', { class: 'nv-confirm-budget', text: budgetText }));
      return ui.dialog({
        title: T('nodes.run.confirm.title', { count: info.paid.length }),
        body,
        width: 480,
        focus: 'cancel',
        buttons: [
          { label: T('nodes.common.cancel'), value: false, cancel: true },
          { label: T('nodes.run.confirm.start'), value: true, primary: true, enter: false }
        ]
      });
    }

    async function startRun() {
      if (!s || s.starting || s.run.active) return;
      const bad = validateForm();
      if (bad) {
        bad.wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      const id = s.id;
      s.starting = true;
      renderRunButton();
      try {
        const overrides = buildOverrides();
        // Unchanged inputs would be answered from the cache: "run again" forces fresh results. The cached state is
        // asked from the server right now (s.plan is debounced and may be stale after a quick edit).
        let force = false;
        let planned;
        try {
          force = allCached(await api.plan(id, { mode: 'all', force: false, overrides }));
          if (!s || s.id !== id) return;
          planned = await api.plan(id, { mode: 'all', force, overrides });
        } catch (error) {
          if (error.issues) await showIssues(issueMessages(error.issues));
          else ui.toast(T('nodes.run.startFailed', { error: error.message }), { kind: 'error' });
          return;
        }
        const info = runLib.describePlan(planned, titleOf);
        if (!info.valid) {
          await showIssues(issueMessages(planned.issues));
          return;
        }
        const gate = runLib.gateOf(info);
        if (gate) {
          await showGate(gate);
          return;
        }
        if (info.needsConfirm) {
          s.asking = true;
          renderRunButton();
          const confirmed = await confirmPaid(info);
          if (s) s.asking = false;
          if (!confirmed) return;
        }
        if (!s || s.id !== id) return;
        try {
          const started = await api.startRun(id, { mode: 'all', force, overrides });
          if (s && s.id === id && !s.run.active) {
            dispatch({ type: 'run_started', runId: started.runId, mode: 'all', targets: planned.targets || [], plan: Object.fromEntries((planned.order || []).map((nodeId) => [nodeId, 'queued'])) });
          }
        } catch (error) {
          if (error.status === 409 && error.code === 'RUN_ACTIVE') ui.toast(T('nodes.run.alreadyRunning'), { kind: 'warn' });
          else if (error.status === 429) ui.toast(T('nodes.run.limit'), { kind: 'warn' });
          else if (accountRuleText(error)) {
            ui.toast(accountRuleText(error), { kind: 'warn' });
            refreshBudget();
          } else if (error.issues) await showIssues(issueMessages(error.issues));
          else ui.toast(T('nodes.run.startFailed', { error: error.message }), { kind: 'error' });
        }
      } finally {
        if (s) {
          s.starting = false;
          renderRunButton();
        }
      }
    }

    async function cancelRun() {
      if (!s || !s.run.active || !s.run.runId) return;
      const flight = runLib.inFlightNodes(s.run, (nodeId) => {
        const node = nodeOf(nodeId);
        const def = node && reg.types.get(node.type);
        return Boolean(def && def.paid);
      });
      if (flight.length) {
        const confirmed = await ui.confirmDialog({
          title: T('nodes.run.cancelWarn.title'),
          message: T('nodes.run.cancelWarn.message'),
          confirmLabel: T('nodes.run.cancelWarn.confirm'),
          cancelLabel: T('nodes.run.cancelWarn.keep'),
          danger: true
        });
        if (!confirmed) return;
      }
      try {
        const result = await api.cancelRun(s.id, s.run.runId);
        if (!result.ok) ui.toast(T('nodes.run.cancelGone'), { kind: 'warn' });
      } catch (error) {
        ui.toast(T('nodes.run.cancelFailed', { error: error.message }), { kind: 'error' });
      }
    }

    /* ---------- events ---------- */

    let resultsTimer = null;

    function dispatch(event) {
      if (!s) return;
      if (event.type === 'workflow_saved') {
        if (!s.run.active && event.rev > (s.workflow.rev || 0)) reloadDefinition();
        return;
      }
      const wasActive = s.run.active;
      s.run = runLib.reduce(s.run, event);
      if (s.run.active && !s.ticker) startTicker();
      if (!s.run.active && s.ticker) {
        clearInterval(s.ticker);
        s.ticker = null;
      }
      renderStatus();
      renderRunButton();
      if (event.type === 'node_result' || event.type === 'run_finished' || (wasActive && !s.run.active) || s.run.resync) {
        clearTimeout(resultsTimer);
        resultsTimer = setTimeout(refreshResults, event.type === 'run_finished' ? 0 : 250);
      }
      if (event.type === 'run_finished' || (wasActive && !s.run.active)) {
        refreshPlan(0);
        refreshBudget();
      }
    }

    async function refreshResults() {
      if (!s) return;
      const id = s.id;
      try {
        const payload = await api.getWorkflow(id);
        if (!s || s.id !== id) return;
        s.results = payload.results;
        s.run = runLib.clearResync(s.run);
        renderResults();
        renderStatus();
      } catch (_) {
        /* the next event or reconnect refreshes again */
      }
    }

    // The builder saved a new version while the app is open: rebuild the form, keep the entered values.
    async function reloadDefinition() {
      if (!s) return;
      const id = s.id;
      try {
        const payload = await api.getWorkflow(id);
        if (!s || s.id !== id) return;
        s.workflow = payload.workflow;
        s.results = payload.results;
        build();
        refreshPlan(0);
      } catch (_) {
        /* keep the current form */
      }
    }

    function startTicker() {
      clearInterval(s.ticker);
      s.ticker = setInterval(() => {
        if (!s) return;
        const time = s.refs && s.refs.statusBox.querySelector('.nv-status-time');
        if (time && s.run.startedAt) time.textContent = runLib.formatDuration(Date.now() - s.run.startedAt);
      }, 1000);
    }

    /* ---------- status ---------- */

    function nodeStatusRows() {
      const order = s.workflow.graph.nodes.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      const rows = [];
      for (const node of order) {
        const info = s.run.nodes[node.id];
        if (!info) continue;
        rows.push({ node, info });
      }
      return rows;
    }

    function renderStatus() {
      if (!s || !s.refs) return;
      const box = s.refs.statusBox;
      const run = s.run;
      box.textContent = '';
      box.dataset.status = run.active ? 'running' : run.status;
      const hasRun = run.runId || run.active;
      box.classList.toggle('hidden', !hasRun);
      if (!hasRun) return;
      const progress = runLib.progressOf(run);
      const head = el('div', { class: 'nv-appstatus-head' });
      head.append(el('span', { class: 'nv-status-dot' }));
      if (run.active) {
        const current = runLib.activeNodeIds(run).map(titleOf);
        head.append(el('span', { class: 'nv-appstatus-text', text: T('nodes.app.statusRunning', { done: progress.done, total: progress.total || 1 }) }));
        head.append(el('span', { class: 'nv-status-time', text: run.startedAt ? runLib.formatDuration(Date.now() - run.startedAt) : '' }));
        box.append(head);
        const bar = el('div', { class: 'nv-appprogress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(progress.total || 1), 'aria-valuenow': String(progress.done) });
        bar.append(el('i', { style: `width:${Math.round((progress.total ? progress.done / progress.total : 0) * 100)}%` }));
        box.append(bar);
        if (current.length) box.append(el('div', { class: 'nv-appstatus-now', text: current.join(' · ') }));
      } else {
        const failed = Object.entries(run.nodes).filter(([, info]) => info.status === 'error');
        const text = run.status === 'completed' ? T('nodes.app.statusDone') : run.status === 'cancelled' ? T('nodes.run.result.cancelled') : run.status === 'interrupted' ? T('nodes.run.result.interrupted') : run.status === 'failed' ? T('nodes.app.statusFailed') : T('nodes.run.result.finished');
        head.append(el('span', { class: 'nv-appstatus-text', text }));
        if (run.startedAt && run.finishedAt) head.append(el('span', { class: 'nv-status-time', text: runLib.formatDuration(run.finishedAt - run.startedAt) }));
        const cost = costText(run.cost);
        if (cost) head.append(el('span', { class: 'nv-appstatus-cost', text: cost }));
        box.append(head);
        for (const [nodeId, info] of failed.slice(0, 3)) {
          box.append(el('div', { class: 'nv-notice is-error' }, icon('warning', 14), el('span', { class: 'nv-notice-text', text: `${titleOf(nodeId)}: ${info.message || T('nodes.run.failedNode')}` })));
        }
        if (run.error && !failed.length) box.append(el('div', { class: 'nv-notice is-error' }, icon('warning', 14), el('span', { class: 'nv-notice-text', text: run.error })));
      }
      const rows = nodeStatusRows();
      if (rows.length > 1) {
        const details = el('details', { class: 'nv-appsteps' });
        if (run.active) details.open = true;
        details.append(el('summary', { text: T('nodes.app.steps', { count: rows.length }) }));
        const list = el('ul', {});
        for (const row of rows) {
          const item = el('li', { dataset: { status: row.info.status } });
          item.append(el('span', { class: 'nv-status-dot' }), el('span', { class: 'nv-appstep-name', text: titleOf(row.node.id) }), el('span', { class: 'nv-appstep-status', text: ui.statusLabel(row.info.status) }));
          if (row.info.progress && row.info.progress.total > 1) item.append(el('span', { class: 'nv-status-progress', text: `${row.info.progress.done}/${row.info.progress.total}` }));
          list.append(item);
        }
        details.append(list);
        box.append(details);
      }
    }

    /* ---------- results ---------- */

    function outputValue(nodeId) {
      const result = s.results && s.results.nodes && s.results.nodes[nodeId];
      if (!result || !result.selected) return null;
      const entry = (result.history || []).find((item) => item.id === result.selected.entry);
      if (!entry) return null;
      const variant = (entry.variants || [])[result.selected.variant || 0] || (entry.variants || [])[0];
      if (!variant) return null;
      const value = variant.result !== undefined ? variant.result : Object.values(variant)[0];
      return value ? { value, entry } : null;
    }

    function leafList(value) {
      const out = [];
      const walk = (item) => {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'list' && Array.isArray(item.items)) item.items.forEach(walk);
        else out.push(item);
      };
      walk(value);
      return out;
    }

    function leafCell(leaf, index, onOpen) {
      const cell = el('div', { class: `nv-appleaf is-${leaf.type}` });
      if (OCD.preview.isMedia(leaf)) {
        const frame = el('div', { class: 'nv-appleaf-frame' });
        frame.append(OCD.preview.mediaNode(leaf));
        if (leaf.type === 'image') {
          frame.classList.add('is-clickable');
          frame.addEventListener('click', () => onOpen(index));
        }
        cell.append(frame);
        const tools = el('div', { class: 'nv-appleaf-tools' });
        const expand = el('button', { type: 'button', class: 'nv-pv-tool', title: T('nodes.preview.open'), 'aria-label': T('nodes.preview.open') }, icon('fullscreen', 13));
        expand.addEventListener('click', () => onOpen(index));
        tools.append(expand, OCD.preview.downloadLink(leaf));
        cell.append(tools);
      } else if (leaf.type === 'text') {
        const text = el('div', { class: 'nv-appleaf-text nv-scroll', text: leaf.value });
        cell.append(text, el('div', { class: 'nv-appleaf-tools' }, OCD.preview.copyButton(() => leaf.value)));
      } else if (leaf.type === 'number') {
        cell.append(el('div', { class: 'nv-appleaf-number', text: String(leaf.value) }));
      }
      return cell;
    }

    function renderResults() {
      if (!s || !s.refs) return;
      const { outputsBox, resultsHead } = s.refs;
      const app = appDef();
      outputsBox.textContent = '';
      resultsHead.textContent = '';
      resultsHead.append(el('h2', { class: 'nv-appresults-title', text: T('nodes.app.results') }));
      let any = false;
      for (const entry of app.outputs) {
        const node = nodeOf(entry.node);
        if (!node) continue;
        const found = outputValue(entry.node);
        const card = el('article', { class: 'nv-appout', dataset: { node: entry.node } });
        const head = el('header', { class: 'nv-appout-head' });
        head.append(el('h3', { class: 'nv-appout-title', text: entry.label || titleOf(entry.node) }));
        if (!found) {
          card.append(head, el('div', { class: 'nv-appout-empty' }, icon('image', 22), el('span', { text: s.run.active ? T('nodes.app.waitingResult') : T('nodes.app.noResultYet') })));
          outputsBox.append(card);
          continue;
        }
        any = true;
        const leaves = leafList(found.value).filter((leaf) => OCD.preview.isViewable(leaf));
        const meta = [formatDate(found.entry.createdAt), found.entry.user].filter(Boolean).join(' · ');
        const tools = el('div', { class: 'nv-appout-tools' });
        if (leaves.length > 1) tools.append(el('span', { class: 'nv-badge is-batch', text: T('nodes.app.batchCount', { count: leaves.length }) }));
        const send = el('button', { type: 'button', class: 'nv-btn nv-btn-sm' }, icon('send', 13), el('span', { text: T('nodes.send.button') }));
        send.addEventListener('click', () => OCD.assetPicker.sendToChat({ workflowId: s.id, nodeId: entry.node }));
        tools.append(send);
        head.append(tools);
        card.append(head);
        if (meta) card.append(el('div', { class: 'nv-appout-meta', text: T('nodes.app.resultFrom', { info: meta }) }));
        const open = (index) => OCD.preview.openViewer(leaves.map((leaf) => ({ value: leaf, label: entry.label || titleOf(entry.node) })), index, { title: entry.label || titleOf(entry.node) });
        const body = el('div', { class: `nv-appout-body ${leaves.length > 1 ? 'is-grid' : ''}`.trim() });
        leaves.forEach((leaf, index) => {
          const cell = leafCell(leaf, index, open);
          if (leaves.length > 1) cell.prepend(el('span', { class: 'nv-appleaf-index', text: String(index + 1) }));
          body.append(cell);
        });
        card.append(body);
        outputsBox.append(card);
      }
      if (any) {
        const zip = el('a', { class: 'nv-btn nv-btn-sm', href: api.outputsZipUrl(s.id), download: '' }, icon('zip', 13), el('span', { text: T('nodes.run.menu.zip') }));
        resultsHead.append(zip);
      }
    }

    function relabel() {
      labelBar();
      if (!s) return;
      if (s.refs) build();
    }

    return { open, close, showError, relabel };
  }

  OCD.appMode = { createAppView, countTextItems };
})(window);
