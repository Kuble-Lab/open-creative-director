'use strict';

// Interface of the agent access (MCP): the dialog "Agent access (MCP)". Server: lib/mcp/key-routes.js, routes /api/mcp/keys.
// For admins and internal people (and in the local mode without user management); everybody else does not see the menu entry
// and the server refuses the routes anyway (403 FORBIDDEN_FOR_ROLE).
//
//   OCMcp.attach()      adds the menu entry "Agent access (MCP)" (section 'account' of the shell menu)
//   OCMcp.open()        opens the dialog and reads the keys
//   OCMcp.close()
//   OCMcp.rerender()    language change
//
// The dialog shows: the address of the endpoint (to copy), the keys of the person (admins: all keys) with right, limits,
// usage this month, last use, expiry and "Revoke", the form "New key", the one-time display of a new key and a short
// guide. The secret of a key exists only in the answer of the creation request: it is held in this file's memory until the
// person closes the display, never written to storage, a log or the address bar. Everything that comes from the server is
// written as text, never as HTML; there are no native dialogs.
(function (global) {
  const tr = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);
  const access = () => global.OCAccess;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_LIMITS = { nameChars: 80, maxRunUsd: 1000, maxMonthUsd: 10000, maxExpiresInDays: 365 };
  const KNOWN_ERRORS = ['INVALID_NAME', 'INVALID_RIGHT', 'INVALID_LIMIT', 'INVALID_EXPIRY', 'TOO_MANY_KEYS', 'KEY_NOT_FOUND', 'KEY_REVOKED', 'KEY_STORE_UNAVAILABLE', 'FORBIDDEN_FOR_ROLE'];

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

  const fmt = (value) => (access() ? access().formatUsd(value) : `$${Number(value || 0).toFixed(2)}`);
  const request = (method, path, body) => access().request(method, path, body);

  /* ---------- pure helpers ---------- */

  // "2", "2,5", " 1.50 " -> number; empty -> null; anything else -> NaN.
  function parseAmount(text) {
    const value = String(text === undefined || text === null ? '' : text).trim().replace(',', '.');
    if (!value) return null;
    if (!/^\d+(?:\.\d+)?$/.test(value)) return NaN;
    return Number(value);
  }

  function parseDays(text) {
    const value = String(text === undefined || text === null ? '' : text).trim();
    if (!value) return null;
    return /^\d+$/.test(value) ? Number(value) : NaN;
  }

  function formatDate(iso, { time = false } = {}) {
    if (!iso) return '';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const lang = typeof global.getLang === 'function' ? global.getLang() : 'de';
    const locale = lang === 'de' ? 'de-CH' : lang;
    return time
      ? at.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : at.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function daysLeft(iso, at = Date.now()) {
    const time = Date.parse(iso);
    return Number.isFinite(time) ? Math.max(0, Math.ceil((time - at) / DAY_MS)) : 0;
  }

  // The command for Claude Code. `secret` is the placeholder unless the key was just created.
  function claudeCommand(address, secret) {
    return `claude mcp add --transport http open-creator ${address} --header "Authorization: Bearer ${secret}"`;
  }

  // A readable sentence for a failed request: the code of the server first, then the network, then its own text.
  function errorText(error, limits) {
    if (!error) return tr('mcp.err.generic', { error: '' });
    if (!error.status && !error.code) return tr('common.networkError');
    if (error.code && KNOWN_ERRORS.includes(error.code)) {
      const bounds = { ...DEFAULT_LIMITS, ...(limits || {}) };
      return tr(`mcp.err.${error.code}`, { nameChars: bounds.nameChars, maxRun: bounds.maxRunUsd, maxMonth: bounds.maxMonthUsd, maxDays: bounds.maxExpiresInDays, maxKeys: 25 });
    }
    return tr('mcp.err.generic', { error: error.message || '' });
  }

  // Menu entry and dialog are for admins and internal people; the local mode has no roles.
  function allowed(me) {
    if (!me || !me.active) return true;
    return Boolean(me.isAdmin || me.role === 'user');
  }

  /* ---------- state ---------- */

  const state = {
    attached: false,
    isOpen: false,
    loading: false,
    loaded: false,
    loadError: null,
    data: null, // answer of GET /api/mcp/keys
    secret: null, // { value, key } of a key created in this dialog, until it is dismissed
    revealed: false,
    pending: null, // two-step confirmation { key, button, original, timer }
    trigger: null,
    refs: {}
  };

  const limitsOf = () => ({ ...DEFAULT_LIMITS, ...((state.data && state.data.limits) || {}) });
  const defaultsOf = () => ({ maxRunUsd: 2, maxMonthUsd: 20, expiresInDays: 90, ...((state.data && state.data.defaults) || {}) });
  const addressOf = () => (state.data && state.data.endpoint) || '';

  function feedback(message, { error = false } = {}) {
    const box = state.refs.feedback;
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('hidden', !message);
    box.classList.toggle('error', Boolean(message && error));
  }

  function clearPending() {
    const pending = state.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.button.isConnected) {
      pending.button.textContent = pending.original;
      pending.button.classList.remove('is-confirming');
    }
    state.pending = null;
  }

  // Two clicks for anything that cannot be undone: the first changes the button text, the second acts.
  function twoStep(key, button, confirmLabel, action) {
    button.addEventListener('click', () => {
      if (state.pending && state.pending.key === key) {
        clearPending();
        action(button);
        return;
      }
      clearPending();
      state.pending = { key, button, original: button.textContent, timer: setTimeout(clearPending, 3500) };
      button.textContent = confirmLabel;
      button.classList.add('is-confirming');
    });
  }

  function actionButton(label, { danger = false, primary = false, title, type = 'button' } = {}) {
    return h('button', { type, class: `branding-manager-action${danger ? ' danger' : ''}${primary ? ' primary' : ''}`, title, text: label });
  }

  /* ---------- copy ---------- */

  // The clipboard API needs a secure context and a focused page. Without it a hidden text field is selected and copied the
  // old way. Answers 'copied', 'selected' (the text is marked, the person presses Ctrl+C) or 'failed'.
  async function copyText(text, getSource) {
    try {
      if (global.navigator && global.navigator.clipboard && global.isSecureContext !== false) {
        await global.navigator.clipboard.writeText(text);
        return 'copied';
      }
    } catch (_) {
      /* fall through to the selection */
    }
    let source = typeof getSource === 'function' ? getSource() : null;
    let temporary = null;
    if (!source || typeof source.select !== 'function') {
      temporary = h('textarea', { class: 'mcp-offscreen', readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
      temporary.value = text;
      (document.getElementById('mcpModal') || document.body).append(temporary);
      source = temporary;
    }
    try {
      source.focus();
      source.select();
      if (typeof source.setSelectionRange === 'function') source.setSelectionRange(0, String(text).length);
      if (document.execCommand('copy') === true) return 'copied';
      return temporary ? 'failed' : 'selected';
    } catch (_) {
      return temporary ? 'failed' : 'selected';
    } finally {
      if (temporary) temporary.remove();
    }
  }

  // A button that copies `getText()` and says so for two seconds.
  function copyButton(label, getText, getSource) {
    const button = actionButton(label);
    let timer = null;
    button.addEventListener('click', async () => {
      const outcome = await copyText(getText(), getSource);
      button.textContent = outcome === 'copied' ? tr('mcp.copied') : outcome === 'selected' ? tr('mcp.copyManual') : tr('mcp.copyFailed');
      button.classList.toggle('is-done', outcome === 'copied');
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = label;
        button.classList.remove('is-done');
      }, 2600);
    });
    return button;
  }

  /* ---------- data ---------- */

  async function load({ quiet = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    state.loadError = null;
    if (!quiet && !state.loaded) renderList();
    try {
      const data = await request('GET', '/api/mcp/keys');
      state.data = data;
      state.loaded = true;
      applyDefaults();
    } catch (error) {
      state.loadError = errorText(error, null);
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  // The form starts with the defaults of the server; a value the person already typed stays.
  function applyDefaults() {
    const form = state.refs.form;
    if (!form || form.dataset.filled === 'true') return;
    const defaults = defaultsOf();
    form.elements.maxRunUsd.value = String(defaults.maxRunUsd);
    form.elements.maxMonthUsd.value = String(defaults.maxMonthUsd);
    form.elements.expiresInDays.value = String(defaults.expiresInDays);
    form.dataset.filled = 'true';
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    if (!state.refs.body) return;
    renderAddress();
    renderSecret();
    renderList();
    renderGuide();
    renderFormTexts();
  }

  function renderAddress() {
    const slot = state.refs.address;
    slot.replaceChildren();
    if (!state.data) {
      slot.append(h('p', { class: 'settings-hint', text: state.loadError ? tr('mcp.loadFailed', { error: state.loadError }) : tr('mcp.loading') }));
      return;
    }
    const input = h('input', { id: 'mcpAddress', class: 'settings-input mcp-address', type: 'text', readonly: true, value: addressOf(), spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'mcpAddressHint' });
    input.addEventListener('focus', () => input.select());
    const copy = copyButton(tr('mcp.copyAddress'), () => addressOf(), () => input);
    slot.append(h('label', { class: 'render-node-field', for: 'mcpAddress' }, h('span', { text: tr('mcp.address') }), h('div', { class: 'mcp-copy-row' }, input, copy)));
    const local = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?\//i.test(addressOf());
    slot.append(h('p', { class: 'settings-hint mcp-hint', id: 'mcpAddressHint', text: local ? tr('mcp.addressLocal') : tr('mcp.addressHint') }));
  }

  // The one-time display of a new key.
  function renderSecret() {
    const slot = state.refs.secret;
    slot.replaceChildren();
    slot.classList.toggle('hidden', !state.secret);
    if (!state.secret) return;
    const { value, key } = state.secret;
    const input = h('input', { id: 'mcpSecret', class: 'settings-input mcp-secret-input', type: state.revealed ? 'text' : 'password', readonly: true, value, spellcheck: 'false', autocomplete: 'off', 'aria-label': tr('mcp.secretLabel') });
    input.addEventListener('focus', () => input.select());
    const reveal = actionButton(tr(state.revealed ? 'mcp.hide' : 'mcp.show'));
    reveal.setAttribute('aria-pressed', String(state.revealed));
    reveal.addEventListener('click', () => {
      state.revealed = !state.revealed;
      renderSecret();
      state.refs.secret.querySelector('#mcpReveal').focus();
    });
    reveal.id = 'mcpReveal';
    const copy = copyButton(tr('mcp.copyKey'), () => value, () => {
      // the field must show text to be selected for the fallback
      input.type = 'text';
      return input;
    });
    const done = actionButton(tr('mcp.secretDone'), { primary: true });
    done.addEventListener('click', () => {
      state.secret = null;
      state.revealed = false;
      renderSecret();
      renderGuide();
      if (state.refs.name) state.refs.name.focus();
    });
    slot.append(
      h('div', { class: 'mcp-secret-head' }, h('strong', { id: 'mcpSecretHeading', text: tr('mcp.secretTitle', { name: key.name }) })),
      h('p', { class: 'mcp-secret-warning', role: 'alert', text: tr('mcp.secretWarning') }),
      h('div', { class: 'mcp-copy-row' }, input, reveal, copy),
      h('div', { class: 'mcp-secret-actions' }, copyButton(tr('mcp.copyCommand'), () => claudeCommand(addressOf(), value)), done)
    );
  }

  function statusOf(key) {
    if (key.status === 'revoked') return { id: 'revoked', label: tr('mcp.status.revoked') };
    if (key.status === 'expired') return { id: 'expired', label: tr('mcp.status.expired') };
    if (key.ownerValid === false) return { id: 'owner', label: tr('mcp.status.ownerInvalid') };
    return { id: 'active', label: tr('mcp.status.active') };
  }

  function fact(label, value, extra) {
    return h('div', { class: 'mcp-fact' }, h('dt', { text: label }), h('dd', {}, value, extra));
  }

  function keyCard(key, { showOwner }) {
    const status = statusOf(key);
    const dead = status.id !== 'active';
    const card = h('article', { class: `mcp-key${dead ? ' is-dead' : ''}`, dataset: { key: key.id, status: status.id } });
    const titleId = `mcpKeyName-${key.id}`;
    card.setAttribute('aria-labelledby', titleId);
    card.append(
      h(
        'div',
        { class: 'mcp-key-head' },
        h('h4', { class: 'mcp-key-name', id: titleId, text: key.name }),
        h('span', { class: `mcp-badge is-${key.right === 'start' ? 'start' : 'read'}`, text: tr(`mcp.right.${key.right === 'start' ? 'start' : 'read'}`) }),
        h('span', { class: `mcp-badge is-status-${status.id}`, text: status.label })
      ),
      h('div', { class: 'mcp-key-sub' }, h('code', { class: 'mcp-prefix', text: `${key.prefix}…` }), showOwner ? h('span', { class: 'mcp-owner', title: key.owner, text: tr('mcp.owner', { owner: key.owner }) }) : null)
    );

    const used = typeof key.monthUsedUsd === 'number' && Number.isFinite(key.monthUsedUsd) ? key.monthUsedUsd : null;
    const limit = key.maxMonthUsd;
    let usage = null;
    if (used !== null) {
      const fraction = limit > 0 ? Math.min(1, used / limit) : used > 0 ? 1 : 0;
      const bar = h('span', { class: `mcp-bar${fraction >= 1 ? ' is-full' : fraction >= 0.85 ? ' is-high' : ''}`, role: 'progressbar', 'aria-label': tr('mcp.monthUsed'), 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(Math.round(used * 100) / 100) }, h('span', { style: `width:${Math.round(fraction * 100)}%` }));
      usage = [h('span', { text: tr('mcp.usedOf', { used: fmt(used), limit: fmt(limit) }) }), bar];
    }
    const expires = key.status === 'active' ? formatDate(key.expiresAt) + ' · ' + (daysLeft(key.expiresAt) === 1 ? tr('mcp.dayLeftOne') : tr('mcp.daysLeft', { count: daysLeft(key.expiresAt) })) : formatDate(key.expiresAt);
    const facts = h(
      'dl',
      { class: 'mcp-facts' },
      fact(tr('mcp.limitRun'), fmt(key.maxRunUsd)),
      fact(tr('mcp.limitMonth'), fmt(key.maxMonthUsd)),
      usage ? fact(tr('mcp.monthUsed'), usage) : null,
      fact(tr('mcp.lastUsed'), key.lastUsedAt ? formatDate(key.lastUsedAt, { time: true }) : tr('mcp.neverUsed')),
      fact(tr(key.status === 'expired' ? 'mcp.expiredOn' : 'mcp.expires'), expires),
      key.status === 'revoked' && key.revokedAt ? fact(tr('mcp.revokedOn'), formatDate(key.revokedAt)) : null
    );
    card.append(facts);
    if (status.id === 'owner') card.append(h('p', { class: 'mcp-note', text: tr('mcp.ownerInvalidHint') }));
    if (key.status === 'active') {
      const revoke = actionButton(tr('mcp.revoke'), { danger: true, title: tr('mcp.revokeHint') });
      revoke.dataset.act = 'revoke';
      revoke.setAttribute('aria-label', tr('mcp.revokeNamed', { name: key.name }));
      twoStep(`revoke:${key.id}`, revoke, tr('mcp.revokeConfirm'), () => revokeKey(key));
      card.append(h('div', { class: 'mcp-key-actions' }, revoke));
    }
    return card;
  }

  function renderList() {
    const slot = state.refs.list;
    if (!slot) return;
    clearPending();
    slot.replaceChildren();
    const titleText = state.data && state.data.scope === 'all' ? tr('mcp.keysAll') : tr('mcp.keys');
    state.refs.listTitle.textContent = titleText;
    if (state.loadError && !state.data) {
      slot.append(h('p', { class: 'settings-feedback error', text: tr('mcp.loadFailed', { error: state.loadError }) }));
      return;
    }
    if (!state.data) {
      slot.append(h('p', { class: 'settings-hint', text: tr('mcp.loading') }));
      return;
    }
    const keys = Array.isArray(state.data.keys) ? state.data.keys : [];
    if (!keys.length) {
      slot.append(h('p', { class: 'context-empty', text: tr('mcp.empty') }));
      return;
    }
    const showOwner = state.data.scope === 'all' && keys.some((key) => key.owner !== 'lokal');
    const live = keys.filter((key) => key.status === 'active');
    const gone = keys.filter((key) => key.status !== 'active');
    for (const key of live) slot.append(keyCard(key, { showOwner }));
    if (gone.length) {
      const details = h('details', { class: 'mcp-gone', open: !live.length }, h('summary', { class: 'mcp-gone-summary', text: tr('mcp.inactive', { count: gone.length }) }));
      for (const key of gone) details.append(keyCard(key, { showOwner }));
      slot.append(details);
    }
  }

  function renderGuide() {
    const slot = state.refs.guide;
    if (!slot) return;
    slot.replaceChildren();
    const address = addressOf() || tr('mcp.guide.addressPlaceholder');
    const placeholder = tr('mcp.guide.keyPlaceholder');
    const command = claudeCommand(address, placeholder);
    const pre = h('pre', { class: 'mcp-code', tabindex: '0', 'aria-label': tr('mcp.guide.commandLabel') }, h('code', { text: command }));
    slot.append(
      h('h3', { class: 'settings-section-title', id: 'mcpGuideTitle', text: tr('mcp.guide.title') }),
      h('ol', { class: 'mcp-steps' }, h('li', { text: tr('mcp.guide.step1') }), h('li', { text: tr('mcp.guide.step2') }), h('li', { text: tr('mcp.guide.step3') })),
      h('h4', { class: 'mcp-sub', text: tr('mcp.guide.claudeCode') }),
      pre,
      h('div', { class: 'mcp-guide-actions' }, copyButton(tr('mcp.copyCommand'), () => command)),
      h('h4', { class: 'mcp-sub', text: tr('mcp.guide.other') }),
      h(
        'dl',
        { class: 'mcp-spec' },
        h('div', {}, h('dt', { text: tr('mcp.guide.transport') }), h('dd', { text: tr('mcp.guide.transportValue') })),
        h('div', {}, h('dt', { text: tr('mcp.address') }), h('dd', {}, h('code', { text: address }))),
        h('div', {}, h('dt', { text: tr('mcp.guide.header') }), h('dd', {}, h('code', { text: `Authorization: Bearer ${placeholder}` })))
      ),
      h('p', { class: 'settings-hint mcp-hint', text: tr('mcp.guide.note') })
    );
  }

  // Static texts of the form follow the language.
  function renderFormTexts() {
    const form = state.refs.form;
    if (!form) return;
    const limits = limitsOf();
    form.querySelector('.render-node-form-heading').textContent = tr('mcp.new.title');
    const labels = {
      name: 'mcp.new.name',
      right: 'mcp.new.right',
      maxRunUsd: 'mcp.new.limitRun',
      maxMonthUsd: 'mcp.new.limitMonth',
      expiresInDays: 'mcp.new.expires'
    };
    for (const [field, key] of Object.entries(labels)) form.querySelector(`[data-field="${field}"] > span`).textContent = tr(key);
    form.elements.name.placeholder = tr('mcp.new.namePlaceholder');
    form.elements.name.maxLength = limits.nameChars;
    const select = form.elements.right;
    select.options[0].textContent = tr('mcp.right.read');
    select.options[1].textContent = tr('mcp.right.start');
    form.querySelector('.mcp-right-hint').textContent = tr(select.value === 'start' ? 'mcp.new.rightStartHint' : 'mcp.new.rightReadHint');
    form.querySelector('.mcp-limits-hint').textContent = tr('mcp.new.limitsHint', { maxRun: limits.maxRunUsd, maxMonth: limits.maxMonthUsd, maxDays: limits.maxExpiresInDays });
    form.querySelector('button[type="submit"]').textContent = tr('mcp.new.create');
  }

  /* ---------- actions ---------- */

  async function revokeKey(key) {
    feedback('');
    try {
      await request('DELETE', `/api/mcp/keys/${encodeURIComponent(key.id)}`);
      feedback(tr('mcp.revoked', { name: key.name }));
    } catch (error) {
      feedback(errorText(error, limitsOf()), { error: true });
    }
    await load({ quiet: true });
  }

  async function createKey(event) {
    event.preventDefault();
    const form = state.refs.form;
    const limits = limitsOf();
    const name = form.elements.name.value.replace(/\s+/g, ' ').trim();
    if (!name || [...name].length > limits.nameChars) {
      feedback(errorText({ status: 400, code: 'INVALID_NAME' }, limits), { error: true });
      form.elements.name.focus();
      return;
    }
    const run = parseAmount(form.elements.maxRunUsd.value);
    const month = parseAmount(form.elements.maxMonthUsd.value);
    const days = parseDays(form.elements.expiresInDays.value);
    if (Number.isNaN(run) || (run !== null && run > limits.maxRunUsd)) {
      feedback(errorText({ status: 400, code: 'INVALID_LIMIT' }, limits), { error: true });
      form.elements.maxRunUsd.focus();
      return;
    }
    if (Number.isNaN(month) || (month !== null && month > limits.maxMonthUsd)) {
      feedback(errorText({ status: 400, code: 'INVALID_LIMIT' }, limits), { error: true });
      form.elements.maxMonthUsd.focus();
      return;
    }
    if (Number.isNaN(days) || (days !== null && (days < 1 || days > limits.maxExpiresInDays))) {
      feedback(errorText({ status: 400, code: 'INVALID_EXPIRY' }, limits), { error: true });
      form.elements.expiresInDays.focus();
      return;
    }
    const body = { name, right: form.elements.right.value };
    if (run !== null) body.maxRunUsd = run;
    if (month !== null) body.maxMonthUsd = month;
    if (days !== null) body.expiresInDays = days;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    feedback('');
    try {
      const created = await request('POST', '/api/mcp/keys', body);
      state.secret = { value: created.secret, key: created.key };
      state.revealed = false;
      form.elements.name.value = '';
      form.elements.right.value = 'read';
      form.dataset.filled = 'false';
      applyDefaults();
      await load({ quiet: true });
      renderFormTexts();
      const display = state.refs.secret;
      if (display && typeof display.scrollIntoView === 'function') display.scrollIntoView({ block: 'nearest' });
      const copy = display && display.querySelector('.mcp-copy-row .branding-manager-action:last-child');
      if (copy) copy.focus();
    } catch (error) {
      feedback(errorText(error, limits), { error: true });
      if (error.code === 'FORBIDDEN_FOR_ROLE') await load({ quiet: true });
    } finally {
      submit.disabled = false;
    }
  }

  /* ---------- the dialog ---------- */

  function buildBody() {
    const body = state.refs.body;
    const name = h('input', { id: 'mcpKeyName', name: 'name', class: 'settings-input', type: 'text', required: true, autocomplete: 'off', maxlength: String(DEFAULT_LIMITS.nameChars) });
    const right = h('select', { id: 'mcpKeyRight', name: 'right', class: 'settings-input' }, h('option', { value: 'read' }), h('option', { value: 'start' }));
    const run = h('input', { id: 'mcpKeyRun', name: 'maxRunUsd', class: 'settings-input', type: 'text', inputmode: 'decimal', autocomplete: 'off' });
    const month = h('input', { id: 'mcpKeyMonth', name: 'maxMonthUsd', class: 'settings-input', type: 'text', inputmode: 'decimal', autocomplete: 'off' });
    const days = h('input', { id: 'mcpKeyDays', name: 'expiresInDays', class: 'settings-input', type: 'text', inputmode: 'numeric', autocomplete: 'off' });
    const field = (id, control, extra) => h('label', { class: `render-node-field${extra ? ` ${extra}` : ''}`, for: control.id, dataset: { field: id } }, h('span'), control);
    const form = h(
      'form',
      { class: 'mcp-form', novalidate: true, id: 'mcpForm' },
      h('div', { class: 'render-node-form-heading' }),
      field('name', name, 'mcp-wide'),
      field('right', right, 'mcp-wide'),
      h('p', { class: 'settings-hint mcp-wide mcp-right-hint' }),
      field('maxRunUsd', run),
      field('maxMonthUsd', month),
      field('expiresInDays', days),
      h('p', { class: 'settings-hint mcp-wide mcp-limits-hint' }),
      h('div', { class: 'team-edit-actions mcp-wide' }, h('button', { type: 'submit', class: 'branding-manager-action primary' }))
    );
    form.addEventListener('submit', createKey);
    right.addEventListener('change', renderFormTexts);

    state.refs.form = form;
    state.refs.name = name;
    state.refs.address = h('div', { class: 'mcp-address-block' });
    state.refs.secret = h('section', { class: 'mcp-secret hidden', 'aria-labelledby': 'mcpSecretHeading' });
    state.refs.listTitle = h('h3', { class: 'settings-section-title', id: 'mcpKeysTitle' });
    state.refs.list = h('div', { class: 'mcp-list' });
    state.refs.guide = h('section', { class: 'mcp-guide', 'aria-labelledby': 'mcpGuideTitle' });
    state.refs.feedback = h('div', { class: 'settings-feedback hidden', role: 'status', 'aria-live': 'polite' });
    state.refs.intro = h('p', { class: 'settings-hint' });
    body.replaceChildren(
      state.refs.intro,
      state.refs.address,
      state.refs.secret,
      h('section', { class: 'mcp-keys', 'aria-labelledby': 'mcpKeysTitle' }, state.refs.listTitle, state.refs.list),
      h('section', { class: 'mcp-new', 'aria-label': tr('mcp.new.title') }, form),
      state.refs.feedback,
      state.refs.guide
    );
    state.refs.intro.textContent = tr('mcp.intro');
  }

  function open(trigger) {
    const modal = document.getElementById('mcpModal');
    if (!modal || !allowed(access() && access().me())) return;
    state.trigger = trigger && typeof trigger.focus === 'function' ? trigger : document.activeElement;
    state.refs.modal = modal;
    state.refs.body = document.getElementById('mcpBody');
    if (!state.refs.form) buildBody();
    state.isOpen = true;
    modal.classList.remove('hidden');
    renderAll();
    applyI18nShell();
    const close = document.getElementById('mcpClose');
    if (close) close.focus();
    load();
  }

  function close() {
    const modal = document.getElementById('mcpModal');
    if (!modal) return;
    clearPending();
    // The secret is gone with the dialog: it cannot be shown a second time.
    state.secret = null;
    state.revealed = false;
    state.isOpen = false;
    if (state.refs.secret) renderSecret();
    feedback('');
    modal.classList.add('hidden');
    if (state.trigger && state.trigger.isConnected) state.trigger.focus();
    state.trigger = null;
  }

  function applyI18nShell() {
    if (typeof global.applyI18n === 'function') global.applyI18n();
  }

  function rerender() {
    if (!state.refs.form) return;
    state.refs.intro.textContent = tr('mcp.intro');
    renderAll();
  }

  function wire() {
    const modal = document.getElementById('mcpModal');
    if (!modal || modal.dataset.wired === 'true') return;
    modal.dataset.wired = 'true';
    document.getElementById('mcpClose').addEventListener('click', close);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.isOpen) {
        event.preventDefault();
        close();
      }
    });
  }

  // The menu entry "Agent access (MCP)": for admins and internal people.
  function attach() {
    wire();
    if (state.attached || !global.OCShell) return;
    state.attached = true;
    global.OCShell.addSection('account', (ctx) => {
      if (!allowed(ctx.me)) return [];
      return [{ id: 'mcp', label: tr('mcp.menu'), title: tr('mcp.menuTitle'), onSelect: () => open(document.querySelector('.account-chip')) }];
    });
  }

  global.OCMcp = { attach, open, close, rerender, helpers: { parseAmount, parseDays, claudeCommand, errorText, allowed, daysLeft } };
})(window);
