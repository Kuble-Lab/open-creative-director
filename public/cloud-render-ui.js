'use strict';

// Interface of the render servers in the cloud (WP54) in the settings, tab «Rendering» (admins). Server: lib/cloud-render.js
// through GET/PUT /api/cloud-render and POST /api/cloud-render/delete-servers.
//
//   OCCloudRender.mount(slot, { onFeedback })   builds the section into the slot and loads the status
//   OCCloudRender.load()                        loads the status again (when the settings open)
//   OCCloudRender.rerender()                    language change
//
// The section shows the status (phase, the servers with their age, state and cost, the month against the cap, the last
// error, an outdated snapshot, servers of another installation in the project) and the settings: on/off, the Hetzner API token (only written: the page shows «set» or «not set», never the token),
// server type, location, snapshot id, SSH key, mode, servers at most and the monthly cap; and «Delete servers now».
// Everything from the server is written as text, never as HTML.
(function (global) {
  const tr = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);
  const REFRESH_MS = 10000;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function request(method, path, body) {
    if (global.OCAccess && typeof global.OCAccess.request === 'function') return global.OCAccess.request(method, path, body);
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path.replace(/^\//, ''), init);
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error((payload && payload.error) || `HTTP ${res.status}`);
      error.code = payload && payload.code;
      throw error;
    }
    return payload;
  }

  /* ---------- pure helpers ---------- */

  function euro(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)} €` : '–';
  }

  // "12 min", "1 h 05 min"
  function ageText(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) / 60));
    if (total < 60) return tr('cloud.minutes', { count: total });
    return tr('cloud.hours', { hours: Math.floor(total / 60), minutes: String(total % 60).padStart(2, '0') });
  }

  function phaseText(status) {
    const phase = status && status.phase ? status.phase : 'off';
    if (phase === 'not_configured') {
      const missing = (status.problems || []).map((name) => tr(`cloud.problem.${name}`)).join(', ');
      return tr('cloud.phase.not_configured', { missing: missing || '–' });
    }
    return tr(`cloud.phase.${phase}`);
  }

  // The notice when the snapshot is outdated (status.snapshot of lib/cloud-render.js): one line per version that differs, or
  // one when the snapshot is older than the report of its versions.
  function snapshotLines(status) {
    const snapshot = status && status.snapshot;
    if (!snapshot || !snapshot.found) return [];
    const lines = (snapshot.problems || []).map((item) => tr('cloud.snapshotOutdated', { name: item.name, found: item.found, expected: item.expected }));
    if (!lines.length && snapshot.unknown) lines.push(tr('cloud.snapshotUnknown'));
    return lines;
  }

  function serverLine(server) {
    const parts = [tr(`cloud.server.${server.status}`) || server.status, ageText(server.ageSeconds), euro(server.costEur)];
    if (server.rendering) parts.push(tr('cloud.server.rendering'));
    return parts.join(' · ');
  }

  /* ---------- state ---------- */

  const state = { slot: null, onFeedback: null, status: null, timer: null, busy: false, armed: null };

  function feedback(message, options) {
    if (typeof state.onFeedback === 'function') state.onFeedback(message, options);
  }

  function errorText(error) {
    return error && error.message ? error.message : tr('cloud.loadFailed');
  }

  /* ---------- the section ---------- */

  function field(id, label, input, hint) {
    input.id = id;
    return h('label', { class: 'render-node-field', for: id }, h('span', { text: label }), input, hint ? h('small', { class: 'settings-hint', text: hint }) : null);
  }

  function renderStatus(box, status) {
    box.replaceChildren();
    const live = (status.servers || []).length;
    const dotClass = status.phase === 'running' ? ' rendering' : status.phase === 'ready' || status.phase === 'starting' ? ' online' : '';
    box.append(
      h(
        'div',
        { class: 'cloud-render-status-head' },
        h('span', { class: `render-node-manager-dot${dotClass}` }),
        h('span', { class: 'cloud-render-phase', text: phaseText(status) }),
        h('span', { class: 'cloud-render-month', text: tr('cloud.month', { spent: euro(status.month && status.month.spentEur), cap: euro(status.month && status.month.capEur) }) })
      )
    );
    if (status.month && status.month.priceHourlyEur) box.append(h('div', { class: 'settings-hint', text: tr('cloud.price', { price: euro(status.month.priceHourlyEur), type: status.settings.serverType }) }));
    if (status.lastError) {
      const at = new Date(status.lastError.at);
      const when = Number.isNaN(at.getTime()) ? '' : at.toLocaleString(typeof global.getLang === 'function' && global.getLang() === 'de' ? 'de-CH' : undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      box.append(h('div', { class: 'cloud-render-error', role: 'status', text: tr('cloud.lastError', { when, message: status.lastError.message || status.lastError.code || '' }) }));
    }
    for (const line of snapshotLines(status)) box.append(h('div', { class: 'cloud-render-error cloud-render-snapshot', role: 'status', text: line }));
    const foreign = status.foreign || [];
    if (foreign.length) {
      const names = foreign.map((server) => `${server.name} (${ageText(server.ageSeconds)})`).join(', ');
      box.append(h('div', { class: 'cloud-render-error', role: 'status', text: tr('cloud.foreign', { count: foreign.length, names }) }));
    }
    if (status.backoffUntil) {
      const until = new Date(status.backoffUntil);
      if (!Number.isNaN(until.getTime())) box.append(h('div', { class: 'settings-hint', text: tr('cloud.backoffUntil', { time: until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }) }));
    }
    const list = h('div', { class: 'render-nodes-list cloud-render-servers' });
    if (!live) list.append(h('div', { class: 'render-nodes-empty', text: tr('cloud.noServers') }));
    for (const server of status.servers || []) {
      const dot = h('span', { class: `render-node-manager-dot${server.rendering ? ' rendering' : server.online ? ' online' : ''}` });
      list.append(
        h(
          'div',
          { class: 'render-node-manager-row', dataset: { server: server.key } },
          dot,
          h(
            'div',
            { class: 'render-node-manager-copy' },
            h('div', { class: 'render-node-manager-name', text: server.name }),
            h('div', { class: 'render-node-manager-url', text: `${server.serverType || ''} · ${server.location || ''}${server.serverId ? ` · #${server.serverId}` : ''}` }),
            h('div', { class: 'render-node-manager-meta', text: serverLine(server) })
          )
        )
      );
    }
    box.append(list);
    if (live) {
      const remove = h('button', { type: 'button', class: 'branding-manager-action danger', text: tr('cloud.deleteAll') });
      remove.addEventListener('click', () => {
        if (!state.armed) {
          remove.textContent = tr('cloud.deleteConfirm');
          remove.classList.add('is-confirming');
          state.armed = setTimeout(() => {
            state.armed = null;
            if (remove.isConnected) {
              remove.textContent = tr('cloud.deleteAll');
              remove.classList.remove('is-confirming');
            }
          }, 3500);
          return;
        }
        clearTimeout(state.armed);
        state.armed = null;
        deleteAll(remove);
      });
      box.append(h('div', { class: 'settings-actions cloud-render-actions' }, remove));
    }
  }

  function buildForm(status) {
    const settings = status.settings || {};
    const enabled = h('input', { type: 'checkbox', role: 'switch', checked: settings.enabled === true });
    const token = h('input', { class: 'settings-input', type: 'password', maxlength: '128', autocomplete: 'new-password', placeholder: tr('cloud.tokenPlaceholder') });
    const serverType = h('input', { class: 'settings-input', type: 'text', maxlength: '30', autocomplete: 'off', value: settings.serverType || 'cpx42' });
    const location = h('input', { class: 'settings-input', type: 'text', maxlength: '20', autocomplete: 'off', value: settings.location || 'nbg1' });
    const snapshot = h('input', { class: 'settings-input', type: 'text', inputmode: 'numeric', maxlength: '20', autocomplete: 'off', value: settings.snapshotId || '', placeholder: '123456789' });
    const sshKey = h('input', { class: 'settings-input', type: 'text', maxlength: '64', autocomplete: 'off', value: settings.sshKey || '' });
    const mode = h('select', { class: 'settings-input' }, h('option', { value: 'reserve', text: tr('cloud.modeReserve') }), h('option', { value: 'first', text: tr('cloud.modeFirst') }));
    mode.value = settings.mode === 'first' ? 'first' : 'reserve';
    const maxServers = h('input', { class: 'settings-input', type: 'number', min: '1', max: '10', step: '1', value: String(settings.maxServers || 1) });
    const cap = h('input', { class: 'settings-input', type: 'number', min: '0', max: '10000', step: '1', value: String(settings.monthlyCapEur ?? 30) });
    const save = h('button', { class: 'branding-manager-action', type: 'submit', text: tr('cloud.save') });
    const tokenState = h('span', { class: `cloud-render-token${settings.tokenSet ? ' is-set' : ''}`, text: settings.tokenSet ? tr('cloud.tokenSet') : tr('cloud.tokenNotSet') });
    // while servers exist the token stays (they can only be deleted with it); the server says so as well
    const clearToken = settings.tokenSet && !(status.servers || []).length ? h('button', { type: 'button', class: 'branding-manager-action danger', text: tr('cloud.tokenRemove') }) : null;
    const form = h(
      'form',
      { class: 'render-node-form cloud-render-form', novalidate: true },
      h('div', { class: 'render-node-form-heading', text: tr('cloud.settings') }),
      h(
        'label',
        { class: 'settings-switch cloud-render-wide', for: 'cloudRenderEnabled' },
        enabled,
        h('span', { class: 'settings-switch-copy' }, h('span', { class: 'settings-switch-label', text: tr('cloud.enabled') }), h('small', { class: 'settings-hint', text: tr('cloud.enabledHint') }))
      ),
      h('div', { class: 'cloud-render-wide cloud-render-token-row' }, field('cloudRenderToken', tr('cloud.token'), token), tokenState, clearToken),
      field('cloudRenderType', tr('cloud.serverType'), serverType),
      field('cloudRenderLocation', tr('cloud.location'), location),
      field('cloudRenderSnapshot', tr('cloud.snapshot'), snapshot),
      field('cloudRenderSsh', tr('cloud.sshKey'), sshKey),
      field('cloudRenderMode', tr('cloud.mode'), mode),
      field('cloudRenderMax', tr('cloud.maxServers'), maxServers),
      field('cloudRenderCap', tr('cloud.cap'), cap),
      h('div', { class: 'cloud-render-wide settings-hint', text: settings.mode === 'first' ? tr('cloud.modeFirstHint') : tr('cloud.modeReserveHint') }),
      save
    );
    enabled.id = 'cloudRenderEnabled';
    mode.addEventListener('change', () => {
      const hint = form.querySelector('.cloud-render-wide.settings-hint');
      if (hint) hint.textContent = mode.value === 'first' ? tr('cloud.modeFirstHint') : tr('cloud.modeReserveHint');
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const patch = {
        enabled: enabled.checked,
        serverType: serverType.value.trim(),
        location: location.value.trim(),
        snapshotId: snapshot.value.trim(),
        sshKey: sshKey.value.trim(),
        mode: mode.value,
        maxServers: Number(maxServers.value),
        monthlyCapEur: Number(cap.value)
      };
      // the token is only sent when one was typed: an empty field keeps the stored one
      if (token.value.trim()) patch.token = token.value.trim();
      await saveSettings(patch, save);
      token.value = '';
    });
    if (clearToken) {
      clearToken.addEventListener('click', () => saveSettings({ token: '' }, clearToken));
    }
    return form;
  }

  function render() {
    if (!state.slot) return;
    state.slot.replaceChildren();
    const status = state.status;
    if (!status) {
      state.slot.append(h('div', { class: 'render-nodes-empty', text: tr('cloud.loading') }));
      return;
    }
    const box = h('div', { class: 'cloud-render-status' });
    renderStatus(box, status);
    state.slot.append(box, buildForm(status));
  }

  // Only the status part is drawn again by the timer, so a half typed form is not lost.
  function refreshStatus() {
    const box = state.slot && state.slot.querySelector('.cloud-render-status');
    if (box && state.status) renderStatus(box, state.status);
  }

  async function load({ full = true } = {}) {
    if (!state.slot) return;
    try {
      state.status = await request('GET', '/api/cloud-render');
      if (full || !state.slot.querySelector('.cloud-render-status')) render();
      else refreshStatus();
    } catch (error) {
      if (full) {
        state.slot.replaceChildren(h('div', { class: 'render-nodes-empty', text: tr('cloud.loadFailed') }));
      }
    }
    schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      // only while the section is on screen
      if (state.slot && state.slot.isConnected && state.slot.offsetParent !== null) load({ full: false });
      else schedule();
    }, REFRESH_MS);
  }

  async function saveSettings(patch, button) {
    if (state.busy) return;
    state.busy = true;
    if (button) button.disabled = true;
    try {
      state.status = await request('PUT', '/api/cloud-render', patch);
      render();
      feedback(tr('cloud.saved'));
    } catch (error) {
      feedback(tr('cloud.saveFailed', { error: errorText(error) }), { error: true });
    } finally {
      state.busy = false;
      if (button && button.isConnected) button.disabled = false;
    }
  }

  async function deleteAll(button) {
    button.disabled = true;
    try {
      state.status = await request('POST', '/api/cloud-render/delete-servers', {});
      render();
      feedback(tr('cloud.deleted'));
    } catch (error) {
      if (button.isConnected) button.disabled = false;
      feedback(tr('cloud.saveFailed', { error: errorText(error) }), { error: true });
    }
  }

  function mount(slot, { onFeedback } = {}) {
    if (!slot) return;
    state.slot = slot;
    state.onFeedback = onFeedback || null;
    render();
    load();
  }

  function rerender() {
    if (state.slot && state.status) render();
  }

  global.OCCloudRender = { mount, load: () => load(), rerender, helpers: { euro, ageText, phaseText, serverLine, snapshotLines } };
})(window);
