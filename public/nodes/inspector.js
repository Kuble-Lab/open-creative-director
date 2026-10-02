'use strict';

// Right-hand inspector (SPEC §12.2): auto-generated parameter form of the selected node, dynamic
// Higgsfield model parameters, connection overview, notes / groups / edges and workflow info.
// Everything is generated from the registry descriptors; no per-type code except the generic
// `dynamic: 'higgsfield-model'` param convention of the Higgsfield nodes.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const ui = OCD.ui;
  const api = OCD.api;
  const { el } = ui;

  const DYNAMIC = 'higgsfield-model';

  function createInspector({ host, getReg, callbacks }) {
    const cb = callbacks || {};
    let lastKey = null;
    let widgets = new Map();
    let dynamicWidgets = [];
    let actionsSlot = null;
    let current = null;
    let runRefs = null; // { nodeId?, runEl, histEl? } containers refreshed by refreshRun() without rebuilding the form
    const modelCache = new Map();

    function clearWidgets() {
      for (const widget of widgets.values()) widget.dispose && widget.dispose();
      for (const widget of dynamicWidgets) widget.dispose && widget.dispose();
      widgets = new Map();
      dynamicWidgets = [];
    }

    /* ---------- Higgsfield model descriptions ---------- */

    function modelState(modelId, refresh) {
      let entry = modelCache.get(modelId);
      if (!entry) {
        entry = { state: 'loading', data: null, error: null };
        modelCache.set(modelId, entry);
        api
          .higgsfieldModel(modelId)
          .then((data) => {
            entry.data = data;
            entry.state = 'ready';
          })
          .catch((error) => {
            entry.state = 'error';
            entry.error = error.message;
          })
          .finally(() => {
            if (current && lastKey && current.node?.params?.model === modelId) {
              lastKey = null;
              refresh();
            }
          });
      }
      return entry;
    }

    function parseExtra(text) {
      try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (_) {
        return {};
      }
    }

    function dynamicValue(descriptor, params) {
      if (descriptor.target === 'extra_params') return parseExtra(params.extra_params)[descriptor.id];
      const raw = params[descriptor.target];
      return raw === '' ? undefined : raw;
    }

    function dynamicPatch(descriptor, value, params) {
      if (descriptor.target === 'extra_params') {
        const extra = parseExtra(params.extra_params);
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) delete extra[descriptor.id];
        else extra[descriptor.id] = value;
        return { extra_params: JSON.stringify(extra) };
      }
      if (descriptor.target === 'duration') return { duration: value === undefined || value === '' ? null : Number(value) };
      return { [descriptor.target]: value === undefined || value === null ? '' : String(value) };
    }

    function dynamicField(descriptor, node, onChange) {
      const values = descriptor.options || [];
      const numeric = values.length > 0 && values.every((option) => typeof option === 'number');
      const spec = { id: descriptor.id, kind: descriptor.kind, min: descriptor.min, max: descriptor.max, optional: true };
      if (descriptor.kind === 'select') {
        spec.options = [{ value: '', label: ui.T('nodes.option.default') }, ...values.map((option) => ({ value: String(option), label: String(option) }))];
      }
      if (descriptor.kind === 'boolean') spec.kind = 'boolean';
      const raw = dynamicValue(descriptor, node.params);
      const initial = descriptor.kind === 'select' ? (raw === undefined || raw === null ? '' : String(raw)) : raw;
      const widget = ui.paramWidget(spec, initial === undefined ? (descriptor.kind === 'boolean' ? false : null) : initial, {
        node,
        compact: false,
        onChange: (value, meta) => {
          let next = value;
          if (descriptor.kind === 'select') next = value === '' ? undefined : numeric ? Number(value) : value;
          if ((descriptor.kind === 'number' || descriptor.kind === 'integer') && (value === null || value === undefined)) next = undefined;
          onChange(descriptor, next, meta);
        },
        uploadFile: () => Promise.reject(new Error('n/a'))
      });
      dynamicWidgets.push(widget);
      const label = descriptor.label + (descriptor.required ? ' *' : '');
      return ui.field(label, widget.el, { hint: descriptor.description || '' });
    }


    /* ---------- run section and history (WP6) ---------- */

    function statusLine(info) {
      const line = el('div', { class: 'nv-run-line' });
      const status = info.status;
      line.dataset.status = status || '';
      line.append(el('span', { class: 'nv-status-dot' }));
      line.append(el('span', { class: 'nv-run-line-text', text: status ? ui.statusLabel(status) : ui.T('nodes.run.idle') }));
      const run = info.run;
      if (run && run.startedAt && (status === 'running' || status === 'waiting_job')) {
        line.append(el('span', { class: 'nv-status-time', dataset: { since: String(run.startedAt) }, text: cb.run.formatDuration(Date.now() - run.startedAt) }));
      } else if (run && run.startedAt && run.endedAt) {
        line.append(el('span', { class: 'nv-run-line-meta', text: cb.run.formatDuration(run.endedAt - run.startedAt) }));
      }
      return line;
    }

    function renderNodeRun(container, nodeId) {
      const info = cb.run && cb.run.info(nodeId);
      container.textContent = '';
      if (!info || !info.def) return;
      const body = el('div', { class: 'nv-run-body' });
      body.append(statusLine(info));
      const buttons = el('div', { class: 'nv-insp-buttons' });
      const runBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-btn-primary', disabled: info.busy || !info.canRun }, ui.icon('play', 12), el('span', { text: ui.T('nodes.run.node') }));
      runBtn.addEventListener('click', () => cb.run.runNode(nodeId));
      const fromBtn = el('button', { type: 'button', class: 'nv-btn nv-btn-sm', disabled: info.busy || !info.canRun, title: ui.T('nodes.run.fromHint') }, ui.icon('skip', 13), el('span', { text: ui.T('nodes.run.from') }));
      fromBtn.addEventListener('click', () => cb.run.runFrom(nodeId));
      buttons.append(runBtn, fromBtn);
      body.append(buttons);
      if (info.status === 'error') {
        const box = el('div', { class: 'nv-notice is-error' }, ui.icon('warning', 14), el('span', { class: 'nv-notice-text nv-scroll', text: info.message || ui.T('nodes.run.failedNode') }));
        const retry = el('button', { type: 'button', class: 'nv-btn nv-btn-sm', disabled: info.busy }, ui.icon('refresh', 13), el('span', { text: ui.T('nodes.common.retry') }));
        retry.addEventListener('click', () => cb.run.runNode(nodeId));
        body.append(box, retry);
      } else if ((info.status === 'invalid' || info.status === 'unavailable' || info.status === 'skipped' || info.status === 'cancelled') && info.message) {
        body.append(el('div', { class: 'nv-notice is-warn' }, ui.icon('warning', 14), el('span', { class: 'nv-notice-text', text: info.message })));
        // the remedy of the card ("Put the Motion HTML writer in front", "Choose a suitable node …") as a button here too
        if (info.status === 'invalid' && info.fix && cb.onFix) {
          const fix = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-insp-fix', title: info.fix.title || '', dataset: { fix: info.fix.id } }, ui.icon(info.fix.icon || 'sparkle', 13), el('span', { text: info.fix.label }));
          fix.addEventListener('click', () => cb.onFix(nodeId, info.fix.id, info.fix));
          body.append(fix);
        }
      } else if (info.status === 'invalid') {
        body.append(el('div', { class: 'nv-notice is-warn' }, ui.icon('warning', 14), el('span', { class: 'nv-notice-text', text: ui.T('nodes.statusHint.invalid') })));
      }
      if (info.log.length && (info.status === 'running' || info.status === 'waiting_job' || info.status === 'error')) {
        const log = el('ul', { class: 'nv-run-log' });
        for (const label of info.log.slice(-4)) log.append(el('li', { text: label }));
        body.append(log);
      }
      container.append(body);
    }

    function entryPrompt(entry) {
      const params = entry.params || {};
      for (const key of ['prompt', 'text', 'brief', 'notes', 'template']) {
        if (typeof params[key] === 'string' && params[key].trim()) return params[key].trim();
      }
      return '';
    }

    function primaryValue(variant, info) {
      const order = [...info.outputOrder.filter((id) => id in variant), ...Object.keys(variant).filter((id) => !info.outputOrder.includes(id))];
      const visible = order.filter((id) => info.isOutput || !info.hiddenPorts.has(id));
      return variant[visible[0]] || variant[order[0]] || null;
    }

    function renderHistory(container, nodeId) {
      const info = cb.run && cb.run.info(nodeId);
      container.textContent = '';
      if (!info || !info.def) return;
      const history = (info.results && info.results.history) || [];
      const wrap = el('section', { class: 'nv-insp-section nv-history' });
      wrap.append(el('h3', { class: 'nv-insp-heading', text: `${ui.T('nodes.history.title')}${history.length ? ` · ${history.length}` : ''}` }));
      if (!history.length) {
        wrap.append(el('div', { class: 'nv-hint', text: ui.T('nodes.history.empty') }));
        container.append(wrap);
        return;
      }
      if (info.selected) {
        const tools = el('div', { class: 'nv-insp-buttons nv-history-tools' });
        const open = el('button', { type: 'button', class: 'nv-btn nv-btn-sm' }, ui.icon('fullscreen', 13), el('span', { text: ui.T('nodes.run.menu.open') }));
        open.addEventListener('click', () => cb.run.openResult(nodeId));
        const save = el('button', { type: 'button', class: 'nv-btn nv-btn-sm' }, ui.icon('download', 13), el('span', { text: ui.T('nodes.preview.download') }));
        save.addEventListener('click', () => cb.run.downloadResult(nodeId));
        tools.append(open, save);
        if (cb.run.sendToChat) {
          const send = el('button', { type: 'button', class: 'nv-btn nv-btn-sm' }, ui.icon('send', 13), el('span', { text: ui.T('nodes.send.button') }));
          send.addEventListener('click', () => cb.run.sendToChat(nodeId));
          tools.append(send);
        }
        wrap.append(tools);
      }
      const list = el('div', { class: 'nv-history-list' });
      for (const entry of history) {
        const selectedEntry = Boolean(info.selected && info.selected.entry === entry.id);
        const item = el('div', { class: `nv-history-entry ${selectedEntry ? 'is-selected' : ''}`.trim() });
        const meta = el('div', { class: 'nv-history-meta' });
        const when = entry.createdAt ? new Date(entry.createdAt) : null;
        meta.append(el('span', { class: 'nv-history-time', text: when && !Number.isNaN(when.getTime()) ? when.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '' }));
        if (entry.user) meta.append(el('span', { class: 'nv-history-user', text: ui.T('nodes.history.by', { user: entry.user }), title: entry.user }));
        if (Number.isFinite(entry.durationMs)) meta.append(el('span', { text: cb.run.formatDuration(entry.durationMs) }));
        const cost = cb.run.costText(entry.cost);
        if (cost) meta.append(el('span', { class: 'nv-history-cost', text: cost }));
        item.append(meta);
        const prompt = entryPrompt(entry);
        if (prompt) item.append(el('div', { class: 'nv-history-prompt', text: OCD.preview.shortText(prompt, 90), title: prompt }));
        const variants = el('div', { class: 'nv-history-variants' });
        (entry.variants || []).forEach((variant, index) => {
          const chosen = selectedEntry && info.selected.variant === index;
          const button = el('button', {
            type: 'button',
            class: `nv-history-variant ${chosen ? 'is-selected' : ''}`.trim(),
            title: ui.T('nodes.history.select', { n: index + 1 }),
            'aria-label': ui.T('nodes.history.select', { n: index + 1 }),
            'aria-pressed': chosen ? 'true' : 'false',
            disabled: info.busy
          });
          button.append(OCD.preview.thumb(primaryValue(variant, info)));
          if ((entry.variants || []).length > 1) button.append(el('span', { class: 'nv-history-index', text: String(index + 1) }));
          button.addEventListener('click', () => cb.run.selectVariant(nodeId, entry.id, index));
          variants.append(button);
        });
        item.append(variants);
        if (selectedEntry) item.append(el('span', { class: 'nv-history-badge', text: ui.T('nodes.history.selected') }));
        list.append(item);
      }
      wrap.append(list);
      container.append(wrap);
    }

    function renderWorkflowRun(container) {
      const info = cb.run && cb.run.workflow();
      container.textContent = '';
      if (!info) return;
      const wrap = el('section', { class: 'nv-insp-section' });
      wrap.append(el('h3', { class: 'nv-insp-heading', text: ui.T('nodes.run.section') }));
      const buttons = el('div', { class: 'nv-insp-buttons' });
      const all = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-btn-primary', disabled: info.active }, ui.icon('play', 12), el('span', { text: ui.T('nodes.run.all') }));
      all.addEventListener('click', () => cb.run.runAll());
      const zip = el('button', { type: 'button', class: 'nv-btn nv-btn-sm', disabled: !info.hasOutputs }, ui.icon('zip', 13), el('span', { text: ui.T('nodes.run.menu.zip') }));
      zip.addEventListener('click', () => cb.run.downloadZip());
      buttons.append(all, zip);
      wrap.append(buttons);
      if (info.recent.length) {
        wrap.append(el('h3', { class: 'nv-insp-heading nv-insp-subheading', text: ui.T('nodes.run.recent') }));
        const list = el('div', { class: 'nv-runs' });
        for (const run of info.recent) {
          const row = el('div', { class: 'nv-run-row', dataset: { status: run.status } });
          const when = run.startedAt ? new Date(run.startedAt) : null;
          row.append(el('span', { class: 'nv-status-dot' }));
          row.append(el('span', { class: 'nv-run-row-main', text: `${ui.T(`nodes.run.result.${run.status}`)}${when ? ` · ${when.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}`, title: run.user || '' }));
          const cost = cb.run.costText(run.cost);
          if (cost) row.append(el('span', { class: 'nv-run-row-cost', text: cost }));
          const download = el('button', { type: 'button', class: 'nv-icon-btn', title: ui.T('nodes.run.menu.zip'), 'aria-label': ui.T('nodes.run.menu.zip') }, ui.icon('zip', 13));
          download.addEventListener('click', () => cb.run.downloadZip(run.id));
          row.append(download);
          list.append(row);
        }
        wrap.append(list);
      }
      container.append(wrap);
    }

    function refreshRun() {
      if (!runRefs || !cb.run) return;
      if (runRefs.nodeId) {
        renderNodeRun(runRefs.runEl, runRefs.nodeId);
        renderHistory(runRefs.histEl, runRefs.nodeId);
      } else {
        renderWorkflowRun(runRefs.runEl);
      }
    }

    /* ---------- sections ---------- */

    function section(title, ...children) {
      const wrap = el('section', { class: 'nv-insp-section' });
      if (title) wrap.append(el('h3', { class: 'nv-insp-heading', text: title }));
      wrap.append(...children);
      return wrap;
    }

    function actionButton(iconName, label, onClick, options = {}) {
      const button = el('button', { type: 'button', class: `nv-btn nv-btn-sm ${options.danger ? 'nv-btn-danger-ghost' : ''}`.trim() }, ui.icon(iconName, 14), el('span', { text: label }));
      button.addEventListener('click', onClick);
      return button;
    }

    function nodeTitle(node, reg) {
      const def = reg.types.get(node.type);
      return node.title || (def ? ui.typeLabel(def) : node.type);
    }

    function connectionRows(node, ctx, reg) {
      const wrap = el('div', { class: 'nv-conn-list' });
      const ports = graphLib.portsFor(reg, node);
      const visibleInputs = ports.inputs.filter((port) => !port.hidden);
      if (!visibleInputs.length) return null;
      for (const port of visibleInputs) {
        const edges = graphLib.incomingEdges(ctx.graph, node.id, port.id);
        const base = graphLib.parseType(port.type)?.base || 'any';
        const row = el('div', { class: 'nv-conn-row' });
        row.append(el('i', { class: `nv-pal-dot nv-port-${base}` }), el('span', { class: 'nv-conn-port', text: ui.portLabel(port.id) }));
        const targets = el('span', { class: 'nv-conn-targets' });
        if (!edges.length) {
          targets.append(el('span', { class: 'nv-conn-empty', text: port.required ? ui.T('nodes.inspector.required') : ui.T('nodes.inspector.notConnected') }));
        }
        for (const edge of edges) {
          const source = ctx.graph.nodes.find((n) => n.id === edge.from.node);
          const chip = el('span', { class: 'nv-conn-chip' });
          chip.append(el('span', { text: source ? `${nodeTitle(source, reg)} · ${ui.portLabel(edge.from.port)}` : edge.from.node }));
          const drop = el('button', { type: 'button', class: 'nv-icon-btn', title: ui.T('nodes.inspector.disconnect'), 'aria-label': ui.T('nodes.inspector.disconnect') }, ui.icon('x', 11));
          drop.addEventListener('click', () => cb.onDisconnect && cb.onDisconnect(edge.id));
          chip.append(drop);
          targets.append(chip);
        }
        row.append(targets);
        wrap.append(row);
      }
      return wrap;
    }

    /* ---------- Design App (WP7) ---------- */

    function switchRow(labelText, on, onToggle, hintText) {
      const button = el('button', { type: 'button', class: `nv-switch nv-nodrag ${on ? 'is-on' : ''}`.trim(), role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': labelText });
      button.append(el('span', { class: 'nv-switch-knob' }));
      button.addEventListener('click', onToggle);
      const row = el('div', { class: 'nv-app-switch' }, el('div', { class: 'nv-app-switch-text' }, el('span', { class: 'nv-field-label', text: labelText }), hintText ? el('span', { class: 'nv-field-hint', text: hintText }) : null), button);
      return row;
    }

    // Output node: expose its result as an output of the Design App.
    function appOutputSection(node) {
      const exposed = cb.app.isOutput(node.id);
      const wrap = section(ui.T('nodes.app.section'), switchRow(ui.T('nodes.app.outputToggle'), exposed, () => cb.app.toggleOutput(node.id), ui.T('nodes.app.outputHint')));
      return wrap;
    }

    function appRow(kind, entry, index, total, ctx) {
      const reg = getReg();
      const node = ctx.graph.nodes.find((n) => n.id === entry.node);
      const def = node && reg.types.get(node.type);
      const title = node ? nodeTitle(node, reg) : entry.node;
      const row = el('div', { class: 'nv-app-row', dataset: { kind, index: String(index) } });
      const input = el('input', { class: 'nv-input', type: 'text', maxlength: 120, 'aria-label': ui.T('nodes.app.label'), placeholder: kind === 'inputs' ? ui.paramLabel(entry.param) : title });
      input.value = entry.label || '';
      input.addEventListener('input', () => cb.app.setLabel(kind, index, input.value, { commit: false }));
      input.addEventListener('change', () => cb.app.setLabel(kind, index, input.value, { commit: true }));
      const sub = el('div', { class: 'nv-app-row-sub' });
      sub.append(el('span', { text: kind === 'inputs' ? `${title} · ${ui.paramLabel(entry.param)}` : title }));
      const batch = kind === 'inputs' && def && (node.type === 'input.text_list' || node.type === 'input.media_list');
      if (batch) sub.append(el('span', { class: 'nv-badge is-batch', title: ui.T('nodes.app.batchHint'), text: ui.T('nodes.app.batch') }));
      const tools = el('div', { class: 'nv-app-row-tools' });
      const up = el('button', { type: 'button', class: 'nv-icon-btn', title: ui.T('nodes.app.moveUp'), 'aria-label': ui.T('nodes.app.moveUp'), disabled: index === 0 }, ui.icon('arrowUp', 13));
      const down = el('button', { type: 'button', class: 'nv-icon-btn', title: ui.T('nodes.app.moveDown'), 'aria-label': ui.T('nodes.app.moveDown'), disabled: index === total - 1 }, ui.icon('arrowDown', 13));
      const drop = el('button', { type: 'button', class: 'nv-icon-btn', title: ui.T('nodes.app.remove'), 'aria-label': ui.T('nodes.app.remove') }, ui.icon('x', 12));
      up.addEventListener('click', () => cb.app.move(kind, index, -1));
      down.addEventListener('click', () => cb.app.move(kind, index, 1));
      drop.addEventListener('click', () => cb.app.remove(kind, index));
      tools.append(up, down, drop);
      const focus = el('button', { type: 'button', class: 'nv-app-row-title', title: ui.T('nodes.app.showNode') }, sub);
      focus.addEventListener('click', () => cb.app.focusNode(entry.node));
      row.append(el('div', { class: 'nv-app-row-main' }, input, focus), tools);
      return row;
    }

    // Workflow level panel: switch, title, description, exposed inputs / outputs, open / copy link.
    function appPanel(ctx) {
      const app = cb.app.get();
      const wrap = el('section', { class: 'nv-insp-section nv-app-panel' });
      wrap.append(el('h3', { class: 'nv-insp-heading', text: ui.T('nodes.app.section') }));
      wrap.append(switchRow(ui.T('nodes.app.enabled'), app.enabled, () => cb.app.setEnabled(!app.enabled), ui.T('nodes.app.enabledHint')));
      const title = el('input', { class: 'nv-input', type: 'text', maxlength: 120, 'aria-label': ui.T('nodes.app.title'), placeholder: ctx.workflow ? ctx.workflow.name : '' });
      title.value = app.title || '';
      title.addEventListener('input', () => cb.app.setMeta({ title: title.value }, { commit: false }));
      title.addEventListener('change', () => cb.app.setMeta({ title: title.value }, { commit: true }));
      const description = el('textarea', { class: 'nv-input nv-textarea', rows: 2, maxlength: 2000, 'aria-label': ui.T('nodes.app.description'), placeholder: ui.T('nodes.app.descriptionPlaceholder') });
      description.value = app.description || '';
      description.addEventListener('input', () => cb.app.setMeta({ description: description.value }, { commit: false }));
      description.addEventListener('change', () => cb.app.setMeta({ description: description.value }, { commit: true }));
      wrap.append(el('div', { class: 'nv-insp-fields nv-app-meta' }, ui.field(ui.T('nodes.app.title'), title), ui.field(ui.T('nodes.app.description'), description)));

      const block = (kind, headingKey, emptyKey) => {
        const list = el('div', { class: 'nv-app-list' });
        const entries = app[kind] || [];
        entries.forEach((entry, index) => list.append(appRow(kind, entry, index, entries.length, ctx)));
        if (!entries.length) list.append(el('div', { class: 'nv-hint nv-app-empty', text: ui.T(emptyKey) }));
        return el('div', { class: 'nv-app-block' }, el('h4', { class: 'nv-app-subheading', text: `${ui.T(headingKey)}${entries.length ? ` · ${entries.length}` : ''}` }), list);
      };
      wrap.append(block('inputs', 'nodes.app.inputs', 'nodes.app.noInputs'), block('outputs', 'nodes.app.outputs', 'nodes.app.noOutputs'));
      if (app.enabled && (!(app.inputs || []).length || !(app.outputs || []).length)) {
        wrap.append(el('div', { class: 'nv-notice is-warn nv-app-warn' }, ui.icon('warning', 14), el('span', { text: ui.T('nodes.app.incomplete') })));
      }
      const buttons = el('div', { class: 'nv-insp-buttons' });
      const openApp = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-btn-primary', disabled: !app.enabled || !(app.inputs || []).length || !(app.outputs || []).length }, ui.icon('external', 13), el('span', { text: ui.T('nodes.app.open') }));
      openApp.addEventListener('click', () => cb.app.open());
      const copy = el('button', { type: 'button', class: 'nv-btn nv-btn-sm', disabled: !app.enabled }, ui.icon('link', 13), el('span', { text: ui.T('nodes.app.copyLink') }));
      copy.addEventListener('click', () => cb.app.copyLink());
      buttons.append(openApp, copy);
      wrap.append(buttons);
      return wrap;
    }

    function nodeView(ctx, refresh) {
      const reg = getReg();
      const node = ctx.graph.nodes.find((n) => n.id === [...ctx.selection.nodes][0]);
      const def = reg.types.get(node.type);
      const frag = el('div', { class: 'nv-insp-body' });
      const head = el('div', { class: 'nv-insp-head' });
      const chip = el('span', { class: 'nv-node-icon', dataset: { cat: def?.category || 'unknown' } });
      chip.append(ui.categoryIcon(def ? def.category : 'unknown', 16));
      const titleWrap = el('div', { class: 'nv-insp-titlewrap' });
      const titleInput = el('input', {
        class: 'nv-input nv-insp-title',
        type: 'text',
        maxlength: 120,
        'aria-label': ui.T('nodes.inspector.title'),
        placeholder: def ? ui.typeLabel(def) : node.type
      });
      titleInput.value = node.title || '';
      titleInput.addEventListener('input', () => cb.onTitle && cb.onTitle(node.id, titleInput.value, { commit: false }));
      titleInput.addEventListener('change', () => cb.onTitle && cb.onTitle(node.id, titleInput.value, { commit: true }));
      titleWrap.append(titleInput, el('div', { class: 'nv-insp-sub', text: def ? `${ui.categoryLabel(def.category)} · ${node.type}` : node.type }));
      head.append(chip, titleWrap);
      frag.append(head);
      widgets.set('__title', { set: (value) => { if (document.activeElement !== titleInput) titleInput.value = value || ''; } });

      runRefs = null;
      if (!def) {
        frag.append(el('div', { class: 'nv-notice is-warn' }, ui.icon('warning', 14), el('span', { text: ui.T('nodes.card.unknownType', { type: node.type }) })));
      } else {
        if (cb.run) {
          const runEl = el('section', { class: 'nv-insp-section nv-insp-run' });
          const histEl = el('div', { class: 'nv-insp-history' });
          runRefs = { nodeId: node.id, runEl, histEl };
          frag.append(runEl, histEl);
          refreshRun();
        }
        if (def.available !== true) {
          frag.append(el('div', { class: 'nv-notice is-warn' }, ui.icon('warning', 14), el('span', { text: `${ui.T('nodes.inspector.unavailable')} ${typeof def.available === 'string' ? ui.availabilityReason(def.available) : ''}`.trim() })));
        }
        if (def.experimental) frag.append(el('div', { class: 'nv-notice' }, ui.icon('sparkle', 14), el('span', { text: ui.T('nodes.inspector.experimental') })));

        const effective = graphLib.effectiveParams(def, node);
        const connectedPorts = new Set(graphLib.incomingEdges(ctx.graph, node.id).map((edge) => edge.to.port));
        const ports = graphLib.portsFor(reg, node);
        const fields = el('div', { class: 'nv-insp-fields' });

        const hasDynamic = def.params.some((param) => param.dynamic === DYNAMIC);
        const modelId = hasDynamic ? String(effective.model || '') : '';
        const model = modelId ? modelState(modelId, refresh) : null;
        const useDynamic = Boolean(model && model.state === 'ready' && model.data);

        for (const param of def.params) {
          if (!graphLib.isVisible(param.showIf, node, def, connectedPorts)) continue;
          if (param.dynamic === DYNAMIC && useDynamic) continue;
          if (param.dynamic === DYNAMIC && param.id === 'extra_params' && modelId && !useDynamic && model && model.state === 'loading') continue;
          const linked = ports.inputs.find((port) => port.param === param.id && connectedPorts.has(port.id));
          if (linked) {
            fields.append(ui.field(ui.paramLabel(param.id), el('div', { class: 'nv-param-linked' }, ui.icon('link', 13), el('span', { text: ui.T('nodes.card.fromInput', { name: ui.portLabel(linked.id) }) }))));
            continue;
          }
          const widget = ui.paramWidget(param, effective[param.id], {
            node,
            compact: false,
            ...ui.promptFieldOptions(node, param, ports.inputs),
            onChange: (value, meta) => cb.onParam && cb.onParam(node.id, param.id, value, meta),
            uploadFile: (file, options) => (cb.uploadFile ? cb.uploadFile(node.id, file, options) : Promise.reject(new Error('Upload unavailable')))
          });
          widgets.set(param.id, widget);
          const inlineField = ['boolean'].includes(param.kind);
          const fieldOptions = { inline: inlineField };
          const extractPort = param.kind === 'textarea' && cb.onExtractPrompt && reg.types.has('input.prompt')
            ? ports.inputs.find((port) => port.param === param.id && port.type === 'text' && !port.hidden && !connectedPorts.has(port.id))
            : null;
          if (extractPort) {
            fieldOptions.action = { icon: 'extract', label: ui.T('nodes.prompt.extractShort'), title: ui.T('nodes.prompt.extract'), onClick: () => cb.onExtractPrompt(node.id, extractPort.id) };
          }
          if (cb.app) {
            const active = cb.app.isExposed(node.id, param.id);
            fieldOptions.expose = {
              active,
              title: ui.T(active ? 'nodes.app.unexpose' : 'nodes.app.expose'),
              onToggle: () => cb.app.toggleInput(node.id, param.id)
            };
          }
          // HTML field of a Motion graphics node: "Convert to HTML with AI" next to the label. The button exists while the
          // input is unconnected and is shown only when the field holds free text (syncValues toggles it while typing,
          // so the inspector is not rebuilt and the field keeps its focus).
          if (param.id === 'html' && node.type === 'video.motion_graphics' && cb.onConvertMotionHtml && !connectedPorts.has('html')) {
            fieldOptions.action = {
              icon: 'sparkle',
              label: ui.T('nodes.motion.convert'),
              title: ui.T('nodes.motion.convertTitle'),
              onClick: () => cb.onConvertMotionHtml(node.id),
              dataset: { motionConvert: '1' },
              hidden: !graphLib.canConvertMotionHtml(reg, ctx.graph, node.id)
            };
          }
          fields.append(ui.field(ui.paramLabel(param.id), widget.el, fieldOptions));
        }

        if (hasDynamic && modelId) {
          const block = el('div', { class: 'nv-insp-model' });
          if (!model || model.state === 'loading') {
            block.append(el('div', { class: 'nv-hint', text: ui.T('nodes.inspector.modelLoading') }));
          } else if (model.state === 'error') {
            block.append(el('div', { class: 'nv-notice is-warn' }, ui.icon('warning', 14), el('span', { text: ui.T('nodes.inspector.modelUnavailable', { error: model.error || '' }) })));
          } else {
            const data = model.data;
            const info = el('div', { class: 'nv-model-info' });
            info.append(el('strong', { text: data.name }));
            if (data.provider) info.append(el('span', { class: 'nv-hint', text: ` · ${data.provider}` }));
            if (data.credits && data.credits.perUnit !== null && data.credits.perUnit !== undefined) {
              const unit = data.credits.unit === 'per_second' ? ui.T('nodes.inspector.perSecond') : ui.T('nodes.inspector.perImage');
              info.append(el('div', { class: 'nv-hint', text: ui.T('nodes.inspector.credits', { credits: data.credits.perUnit, unit }) }));
            }
            block.append(info);
            for (const descriptor of data.params) {
              block.append(
                dynamicField(descriptor, node, (desc, value, meta) => {
                  const latest = ctx.graph.nodes.find((n) => n.id === node.id) || node;
                  cb.onParams && cb.onParams(node.id, dynamicPatch(desc, value, latest.params), meta, `dyn:${desc.id}`);
                })
              );
            }
          }
          fields.append(block);
        }
        frag.append(section(ui.T('nodes.inspector.params'), fields.children.length ? fields : el('div', { class: 'nv-hint', text: ui.T('nodes.inspector.noParams') })));

        if (cb.app && node.type === 'output.result') frag.append(appOutputSection(node));

        // What the node is for, an example, tips, ports and cost (node-help.js); collapsible, the state is remembered.
        if (cb.help) frag.append(cb.help.section(node.type));

        const conn = connectionRows(node, ctx, reg);
        if (conn) frag.append(section(ui.T('nodes.inspector.inputs'), conn));

        const outputs = ports.outputs.filter((port) => !port.hidden);
        if (outputs.length) {
          const list = el('div', { class: 'nv-conn-list' });
          for (const port of outputs) {
            const base = graphLib.parseType(port.type)?.base || 'any';
            const count = graphLib.outgoingEdges(ctx.graph, node.id, port.id).length;
            list.append(
              el(
                'div',
                { class: 'nv-conn-row' },
                el('i', { class: `nv-pal-dot nv-port-${base} ${graphLib.parseType(port.type)?.list ? 'is-list' : ''}`.trim() }),
                el('span', { class: 'nv-conn-port', text: ui.portLabel(port.id) }),
                el('span', { class: 'nv-conn-targets' }, el('span', { class: 'nv-conn-empty', text: count ? ui.T('nodes.inspector.usedBy', { count }) : ui.T('nodes.inspector.unused') }))
              )
            );
          }
          frag.append(section(ui.T('nodes.inspector.outputs'), list));
        }
      }

      actionsSlot = el('div', { class: 'nv-inspector-actions', dataset: { slot: 'actions' } });
      frag.append(actionsSlot);
      frag.append(
        section(
          null,
          el(
            'div',
            { class: 'nv-insp-buttons' },
            actionButton('duplicate', ui.T('nodes.action.duplicate'), () => cb.onDuplicate && cb.onDuplicate()),
            actionButton('trash', ui.T('nodes.action.delete'), () => cb.onDelete && cb.onDelete(), { danger: true })
          )
        )
      );
      return frag;
    }

    function multiView(ctx) {
      const total = ctx.selection.nodes.size + ctx.selection.notes.size + ctx.selection.groups.size;
      const frag = el('div', { class: 'nv-insp-body' });
      frag.append(
        el('div', { class: 'nv-insp-empty' }, el('div', { class: 'nv-insp-count', text: String(total) }), el('div', { text: ui.T('nodes.inspector.multi', { count: total }) }))
      );
      actionsSlot = el('div', { class: 'nv-inspector-actions', dataset: { slot: 'actions' } });
      frag.append(actionsSlot);
      frag.append(
        section(
          null,
          el(
            'div',
            { class: 'nv-insp-buttons' },
            actionButton('duplicate', ui.T('nodes.action.duplicate'), () => cb.onDuplicate && cb.onDuplicate()),
            actionButton('group', ui.T('nodes.action.group'), () => cb.onGroupSelection && cb.onGroupSelection()),
            actionButton('trash', ui.T('nodes.action.delete'), () => cb.onDelete && cb.onDelete(), { danger: true })
          )
        )
      );
      return frag;
    }

    function noteView(ctx) {
      const note = ctx.graph.notes.find((n) => n.id === [...ctx.selection.notes][0]);
      const frag = el('div', { class: 'nv-insp-body' });
      const area = el('textarea', { class: 'nv-input nv-textarea', rows: 8, 'aria-label': ui.T('nodes.note.title'), placeholder: ui.T('nodes.note.placeholder') });
      area.value = note.text;
      area.addEventListener('input', () => cb.onNote && cb.onNote(note.id, { text: area.value }, { commit: false }));
      area.addEventListener('change', () => cb.onNote && cb.onNote(note.id, { text: area.value }, { commit: true }));
      widgets.set('__note', { set: (value) => { if (document.activeElement !== area) area.value = value || ''; } });
      frag.append(section(ui.T('nodes.note.title'), area));
      frag.append(section(null, el('div', { class: 'nv-insp-buttons' }, actionButton('trash', ui.T('nodes.action.delete'), () => cb.onDelete && cb.onDelete(), { danger: true }))));
      return frag;
    }

    function groupView(ctx) {
      const group = ctx.graph.groups.find((g) => g.id === [...ctx.selection.groups][0]);
      const frag = el('div', { class: 'nv-insp-body' });
      const title = el('input', { class: 'nv-input', type: 'text', maxlength: 120, 'aria-label': ui.T('nodes.group.title'), placeholder: ui.T('nodes.group.untitled') });
      title.value = group.title;
      title.addEventListener('input', () => cb.onGroup && cb.onGroup(group.id, { title: title.value }, { commit: false }));
      title.addEventListener('change', () => cb.onGroup && cb.onGroup(group.id, { title: title.value }, { commit: true }));
      widgets.set('__groupTitle', { set: (value) => { if (document.activeElement !== title) title.value = value || ''; } });
      const colors = el('div', { class: 'nv-swatches', role: 'radiogroup', 'aria-label': ui.T('nodes.group.color') });
      for (const color of graphLib.GROUP_COLORS) {
        const swatch = el('button', {
          type: 'button',
          class: `nv-swatch ${group.color === color ? 'is-active' : ''}`.trim(),
          dataset: { color },
          role: 'radio',
          'aria-checked': group.color === color ? 'true' : 'false',
          title: ui.T(`nodes.color.${color}`),
          'aria-label': ui.T(`nodes.color.${color}`)
        });
        swatch.addEventListener('click', () => cb.onGroup && cb.onGroup(group.id, { color }, { commit: true }));
        colors.append(swatch);
      }
      frag.append(section(ui.T('nodes.group.title'), ui.field(null, title)), section(ui.T('nodes.group.color'), colors));
      frag.append(
        section(
          null,
          el(
            'div',
            { class: 'nv-insp-buttons' },
            actionButton('x', ui.T('nodes.action.ungroup'), () => cb.onDelete && cb.onDelete()),
          )
        )
      );
      return frag;
    }

    function edgeView(ctx) {
      const reg = getReg();
      const edge = ctx.graph.edges.find((e) => e.id === ctx.selection.edge);
      const frag = el('div', { class: 'nv-insp-body' });
      const from = ctx.graph.nodes.find((n) => n.id === edge.from.node);
      const to = ctx.graph.nodes.find((n) => n.id === edge.to.node);
      const list = el('div', { class: 'nv-conn-list' });
      list.append(
        el('div', { class: 'nv-conn-row' }, el('span', { class: 'nv-conn-port', text: ui.T('nodes.inspector.from') }), el('span', { class: 'nv-conn-targets', text: from ? `${nodeTitle(from, reg)} · ${ui.portLabel(edge.from.port)}` : edge.from.node })),
        el('div', { class: 'nv-conn-row' }, el('span', { class: 'nv-conn-port', text: ui.T('nodes.inspector.to') }), el('span', { class: 'nv-conn-targets', text: to ? `${nodeTitle(to, reg)} · ${ui.portLabel(edge.to.port)}` : edge.to.node }))
      );
      frag.append(section(ui.T('nodes.inspector.connection'), list));
      frag.append(section(null, el('div', { class: 'nv-insp-buttons' }, actionButton('trash', ui.T('nodes.inspector.disconnect'), () => cb.onDisconnect && cb.onDisconnect(edge.id), { danger: true }))));
      return frag;
    }

    function workflowView(ctx) {
      const frag = el('div', { class: 'nv-insp-body' });
      if (!ctx.workflow) return frag;
      if (cb.run) {
        const runEl = el('div', { class: 'nv-insp-run-wrap' });
        runRefs = { runEl };
        frag.append(runEl);
        renderWorkflowRun(runEl);
      }
      const desc = el('textarea', { class: 'nv-input nv-textarea', rows: 4, maxlength: 2000, 'aria-label': ui.T('nodes.inspector.description'), placeholder: ui.T('nodes.inspector.descriptionPlaceholder') });
      desc.value = ctx.workflow.description || '';
      desc.addEventListener('input', () => cb.onWorkflowMeta && cb.onWorkflowMeta({ description: desc.value }, { commit: false }));
      desc.addEventListener('change', () => cb.onWorkflowMeta && cb.onWorkflowMeta({ description: desc.value }, { commit: true }));
      widgets.set('__desc', { set: (value) => { if (document.activeElement !== desc) desc.value = value || ''; } });
      const stats = el('div', { class: 'nv-stats' });
      const stat = (label, value) => el('div', { class: 'nv-stat' }, el('span', { class: 'nv-stat-value', text: String(value) }), el('span', { class: 'nv-stat-label', text: label }));
      stats.append(stat(ui.T('nodes.inspector.statNodes'), ctx.graph.nodes.length), stat(ui.T('nodes.inspector.statEdges'), ctx.graph.edges.length), stat(ui.T('nodes.inspector.statNotes'), ctx.graph.notes.length));
      const meta = [];
      if (ctx.workflow.updatedBy) meta.push(ui.T('nodes.inspector.updatedBy', { name: ctx.workflow.updatedBy }));
      frag.append(section(ui.T('nodes.inspector.workflow'), stats, meta.length ? el('div', { class: 'nv-hint', text: meta.join(' · ') }) : null));
      frag.append(section(ui.T('nodes.inspector.description'), desc));
      if (cb.app) frag.append(appPanel(ctx));
      const tips = el('ul', { class: 'nv-tips' });
      for (const key of ['nodes.tip.palette', 'nodes.tip.connect', 'nodes.tip.pan', 'nodes.tip.zoom', 'nodes.tip.undo']) tips.append(el('li', { text: ui.T(key) }));
      frag.append(section(ui.T('nodes.inspector.tips'), tips));
      return frag;
    }

    /* ---------- render ---------- */

    function signature(ctx) {
      const reg = getReg();
      const sel = ctx.selection;
      const parts = [ctx.workflow?.id || '', sel.nodes.size, sel.notes.size, sel.groups.size, sel.edge || ''];
      if (sel.nodes.size === 1 && !sel.notes.size && !sel.groups.size) {
        const node = ctx.graph.nodes.find((n) => n.id === [...sel.nodes][0]);
        if (node) {
          const def = reg.types.get(node.type);
          const connected = graphLib.incomingEdges(ctx.graph, node.id).map((edge) => `${edge.to.port}<${edge.from.node}.${edge.from.port}`).sort();
          const visible = def ? def.params.filter((p) => graphLib.isVisible(p.showIf, node, def, new Set(connected.map((c) => c.split('<')[0])))).map((p) => p.id) : [];
          const model = def && def.params.some((p) => p.dynamic === DYNAMIC) ? node.params.model : '';
          const variant = def?.portVariants ? node.params[def.portVariants.param] : '';
          const titleOf = (id) => {
            const n = ctx.graph.nodes.find((x) => x.id === id);
            return n ? n.title || n.type : '';
          };
          const sources = connected.map((c) => titleOf(c.split('<')[1].split('.')[0]));
          const outCount = graphLib.outgoingEdges(ctx.graph, node.id).length;
          const modelReady = model ? modelCache.get(model)?.state : '';
          const exposure = cb.app ? cb.app.signature(node.id) : '';
          parts.push(node.id, node.type, visible.join(','), connected.join(','), model, variant, modelReady, outCount, sources.join(','), exposure);
        }
      } else if (sel.notes.size === 1 && sel.nodes.size === 0) {
        parts.push([...sel.notes][0]);
      } else if (sel.groups.size === 1 && sel.nodes.size === 0) {
        const group = ctx.graph.groups.find((g) => g.id === [...sel.groups][0]);
        parts.push(group?.id, group?.color);
      } else if (sel.edge) {
        const edge = ctx.graph.edges.find((e) => e.id === sel.edge);
        parts.push(JSON.stringify(edge));
      } else if (!sel.nodes.size && !sel.notes.size && !sel.groups.size) {
        parts.push(ctx.graph.nodes.length, ctx.graph.edges.length, ctx.graph.notes.length, cb.app ? cb.app.signature() : '');
      }
      return parts.join('|');
    }

    function syncValues(ctx) {
      const reg = getReg();
      const sel = ctx.selection;
      if (sel.nodes.size === 1 && !sel.notes.size && !sel.groups.size) {
        const node = ctx.graph.nodes.find((n) => n.id === [...sel.nodes][0]);
        if (!node) return;
        const def = reg.types.get(node.type);
        const effective = def ? graphLib.effectiveParams(def, node) : {};
        for (const [id, widget] of widgets) {
          if (id === '__title') widget.set(node.title);
          else widget.set(effective[id]);
        }
        const convert = host.querySelector('[data-motion-convert]');
        if (convert) convert.hidden = !graphLib.canConvertMotionHtml(reg, ctx.graph, node.id);
        const model = def && def.params.some((p) => p.dynamic === DYNAMIC) ? modelCache.get(String(effective.model || '')) : null;
        if (model && model.state === 'ready') {
          // Dynamic widgets keep their own state; values are re-read only on rebuild (signature change).
        }
      } else if (sel.notes.size === 1) {
        const note = ctx.graph.notes.find((n) => n.id === [...sel.notes][0]);
        widgets.get('__note')?.set(note?.text);
      } else if (sel.groups.size === 1) {
        const group = ctx.graph.groups.find((g) => g.id === [...sel.groups][0]);
        widgets.get('__groupTitle')?.set(group?.title);
      } else if (!sel.nodes.size && !sel.notes.size && !sel.groups.size && !sel.edge) {
        widgets.get('__desc')?.set(ctx.workflow?.description);
      }
    }

    function render(ctx, options = {}) {
      current = { ...ctx, node: ctx.graph.nodes.find((n) => n.id === [...ctx.selection.nodes][0]) };
      if (!getReg()) return;
      const key = signature(ctx);
      if (!options.force && key === lastKey) {
        syncValues(ctx);
        return;
      }
      lastKey = key;
      clearWidgets();
      actionsSlot = null;
      runRefs = null;
      host.textContent = '';
      const sel = ctx.selection;
      const refresh = () => render(current, { force: true });
      let view;
      if (sel.edge && !sel.nodes.size && !sel.notes.size && !sel.groups.size && ctx.graph.edges.some((e) => e.id === sel.edge)) view = edgeView(ctx);
      else if (sel.nodes.size === 1 && !sel.notes.size && !sel.groups.size) view = nodeView(ctx, refresh);
      else if (sel.notes.size === 1 && !sel.nodes.size && !sel.groups.size) view = noteView(ctx);
      else if (sel.groups.size === 1 && !sel.nodes.size && !sel.notes.size) view = groupView(ctx);
      else if (sel.nodes.size + sel.notes.size + sel.groups.size > 1) view = multiView(ctx);
      else view = workflowView(ctx);
      host.append(view);
      if (callbacksRendered) callbacksRendered(actionsSlot, ctx);
    }

    let callbacksRendered = cb.onRendered || null;

    return {
      render,
      refreshRun,
      getActionsSlot: () => actionsSlot,
      invalidate: () => {
        lastKey = null;
      },
      dispose: clearWidgets
    };
  }

  OCD.inspector = { createInspector };
})(window);
