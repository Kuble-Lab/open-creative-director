'use strict';

// Interface of the own computers as render nodes (WP46): the dialog "My computers" and the admin list in the settings.
// Server: lib/render-agent-routes.js (routes /api/render-agents, the computers themselves use /api/render-agent/).
//
//   OCRenderAgents.attach()                   adds the menu entry "My computers" (section 'account' of the shell menu)
//   OCRenderAgents.open() / close()
//   OCRenderAgents.rerender()                 language change
//   OCRenderAgents.renderAdminList(el, list, { onChanged })   the computers of all people in the render-node settings (admins)
//
// The dialog shows a pairing code with the two commands that install and pair a computer (bash for macOS and Linux,
// PowerShell for Windows), and the person's computers: name (editable), online or offline and last seen, what it renders,
// finished jobs, "also for my teams", "for everybody" (admins) and "Remove". Everything from the server is written as
// text, never as HTML; there are no native dialogs. The token of a computer never reaches the browser.
(function (global) {
  const tr = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);
  const access = () => global.OCAccess;
  const REFRESH_MS = 5000;
  const KNOWN_ERRORS = ['TOO_MANY_AGENTS', 'TOO_MANY_CODES', 'PACKAGE_MISSING', 'AGENT_NOT_FOUND', 'INVALID_NAME', 'FORBIDDEN'];

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

  const request = (method, path, body) => access().request(method, path, body);

  /* ---------- pure helpers ---------- */

  function locale() {
    const lang = typeof global.getLang === 'function' ? global.getLang() : 'de';
    return lang === 'de' ? 'de-CH' : lang;
  }

  function formatTime(iso) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    return at.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  }

  // "just now", "5 min ago", "3 h ago", else the date and time.
  function lastSeenText(iso, at = Date.now()) {
    const time = Date.parse(iso || '');
    if (!Number.isFinite(time)) return tr('agents.neverSeen');
    const seconds = Math.max(0, Math.round((at - time) / 1000));
    if (seconds < 60) return tr('agents.seenNow');
    if (seconds < 3600) return tr('agents.seenMinutes', { count: Math.round(seconds / 60) });
    if (seconds < 86400) return tr('agents.seenHours', { count: Math.round(seconds / 3600) });
    const date = new Date(time);
    return tr('agents.seenOn', { date: date.toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) });
  }

  // "macOS", "Windows", "Linux" (and the processor) from "darwin-arm64".
  function platformText(platform) {
    const [system, arch] = String(platform || '').split('-');
    const name = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[system] || tr('agents.platformUnknown');
    return arch ? `${name} (${arch})` : name;
  }

  function versionsText(versions) {
    const value = versions || {};
    const parts = [];
    if (value.hyperframes) parts.push(`HyperFrames ${value.hyperframes}`);
    if (value.ffmpeg) parts.push(`ffmpeg ${value.ffmpeg}`);
    if (value.node) parts.push(`Node ${value.node}`);
    return parts.join(' · ');
  }

  function renderingText(entry) {
    const percent = Math.round(Math.max(0, Math.min(1, Number(entry.progress) || 0)) * 100);
    if (entry.own && entry.label) return tr('agents.rendering', { label: entry.label, percent });
    return tr('agents.renderingOther', { percent });
  }

  function errorText(error) {
    if (!error) return tr('agents.err.generic', { error: '' });
    if (!error.status && !error.code) return tr('common.networkError');
    if (error.code && KNOWN_ERRORS.includes(error.code)) return tr(`agents.err.${error.code}`);
    return tr('agents.err.generic', { error: error.message || '' });
  }

  // Everybody who is logged in (and the local mode); an anonymous visitor does not see the entry.
  function allowed(me) {
    if (!me || !me.active) return true;
    return Boolean(me.identified);
  }

  /* ---------- copy ---------- */

  async function copyText(text, source) {
    try {
      if (global.navigator && global.navigator.clipboard && global.isSecureContext !== false) {
        await global.navigator.clipboard.writeText(text);
        return 'copied';
      }
    } catch (_) {
      /* fall through to the selection */
    }
    try {
      source.focus();
      source.select();
      if (document.execCommand('copy') === true) return 'copied';
      return 'selected';
    } catch (_) {
      return 'failed';
    }
  }

  function copyButton(label, getText, getSource) {
    const button = h('button', { type: 'button', class: 'branding-manager-action', text: label });
    let timer = null;
    button.addEventListener('click', async () => {
      const outcome = await copyText(getText(), getSource());
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

  // Two clicks for anything that cannot be undone: the first changes the button text, the second acts.
  function twoStep(button, confirmLabel, action) {
    let armed = null;
    const disarm = () => {
      clearTimeout(armed);
      armed = null;
      if (button.isConnected) {
        button.textContent = button.dataset.label;
        button.classList.remove('is-confirming');
      }
    };
    button.dataset.label = button.textContent;
    button.addEventListener('click', () => {
      if (armed) {
        disarm();
        action(button);
        return;
      }
      armed = setTimeout(disarm, 3500);
      button.textContent = confirmLabel;
      button.classList.add('is-confirming');
    });
  }

  /* ---------- state ---------- */

  const state = {
    attached: false,
    isOpen: false,
    data: null, // answer of GET /api/render-agents
    loadError: null,
    pairing: null, // answer of POST /api/render-agents/pairing-code, until it expires or the dialog closes
    editing: new Set(), // ids whose name field has focus or unsaved text: the refresh leaves them alone
    timer: null,
    trigger: null,
    refs: {}
  };

  function feedback(message, { error = false } = {}) {
    const box = state.refs.feedback;
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('hidden', !message);
    box.classList.toggle('error', Boolean(message && error));
  }

  async function load() {
    try {
      state.data = await request('GET', '/api/render-agents');
      state.loadError = null;
    } catch (error) {
      state.loadError = errorText(error);
    }
    if (state.isOpen) renderAll();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (!state.isOpen) return;
    state.timer = setTimeout(async () => {
      await load();
      schedule();
    }, REFRESH_MS);
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    if (!state.refs.body) return;
    state.refs.intro.textContent = tr('agents.intro');
    renderConnect();
    renderList();
  }

  function commandBlock(id, title, command) {
    const area = h('textarea', { id, class: 'settings-input agents-command', rows: '3', readonly: true, spellcheck: 'false', autocomplete: 'off', 'aria-label': title });
    area.value = command;
    area.addEventListener('focus', () => area.select());
    return h('div', { class: 'agents-command-block' }, h('h4', { class: 'mcp-sub', text: title }), area, h('div', { class: 'mcp-guide-actions' }, copyButton(tr('agents.connect.copy'), () => command, () => area)));
  }

  function renderConnect() {
    const slot = state.refs.connect;
    slot.replaceChildren(h('h3', { class: 'settings-section-title', id: 'agentsConnectTitle', text: tr('agents.connect.title') }));
    if (state.data && state.data.packageAvailable === false) {
      slot.append(h('p', { class: 'settings-feedback error', text: tr('agents.err.PACKAGE_MISSING') }));
      return;
    }
    slot.append(h('p', { class: 'settings-hint', text: tr('agents.connect.requirement') }));
    const pairing = state.pairing;
    const expired = pairing && Date.parse(pairing.expiresAt) <= Date.now();
    if (pairing && !expired) {
      slot.append(
        h('div', { class: 'agents-code' }, h('span', { class: 'agents-code-label', text: tr('agents.connect.code') }), h('strong', { class: 'agents-code-value', text: pairing.code })),
        h('p', { class: 'settings-hint', text: tr('agents.connect.validUntil', { time: formatTime(pairing.expiresAt) }) }),
        commandBlock('agentsCommandBash', tr('agents.connect.mac'), pairing.commands.bash),
        commandBlock('agentsCommandPs', tr('agents.connect.windows'), pairing.commands.powershell),
        h('p', { class: 'settings-hint', text: tr('agents.connect.after') })
      );
    } else if (expired) {
      slot.append(h('p', { class: 'settings-hint', text: tr('agents.connect.expired') }));
    }
    const button = h('button', { type: 'button', class: 'branding-manager-action primary', text: tr(pairing ? 'agents.connect.again' : 'agents.connect.button') });
    button.addEventListener('click', () => createCode(button));
    slot.append(h('div', { class: 'team-edit-actions' }, button));
  }

  function toggle(label, checked, onChange) {
    const input = h('input', { type: 'checkbox' });
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked, input));
    return h('label', { class: 'render-node-toggle agents-toggle' }, input, h('span', { text: label }));
  }

  function agentCard(agent) {
    const data = state.data || {};
    const titleId = `agentName-${agent.id}`;
    const card = h('article', { class: `mcp-key agents-card${agent.online ? '' : ' is-offline'}`, dataset: { agent: agent.id }, 'aria-labelledby': titleId });
    const status = h('span', { class: `mcp-badge ${agent.online ? 'is-status-active' : 'is-status-expired'}`, text: tr(agent.online ? 'agents.online' : 'agents.offline') });
    card.append(h('div', { class: 'mcp-key-head' }, h('h4', { class: 'mcp-key-name', id: titleId, text: agent.name }), status, agent.shareAll ? h('span', { class: 'mcp-badge is-start', text: tr('agents.badgeShared') }) : null));
    const doing = Array.isArray(agent.rendering) && agent.rendering.length ? agent.rendering.map(renderingText).join(' · ') : tr(agent.online ? 'agents.idle' : 'agents.notConnected');
    card.append(
      h(
        'dl',
        { class: 'mcp-facts' },
        h('div', { class: 'mcp-fact' }, h('dt', { text: tr('agents.now') }), h('dd', { text: doing })),
        h('div', { class: 'mcp-fact' }, h('dt', { text: tr('agents.lastSeen') }), h('dd', { text: agent.online ? tr('agents.seenNow') : lastSeenText(agent.lastSeenAt) })),
        h('div', { class: 'mcp-fact' }, h('dt', { text: tr('agents.completed') }), h('dd', { text: String(agent.completed || 0) })),
        h('div', { class: 'mcp-fact' }, h('dt', { text: tr('agents.system') }), h('dd', { text: [platformText(agent.platform), versionsText(agent.versions)].filter(Boolean).join(' · ') }))
      )
    );
    if (agent.outdated) card.append(h('p', { class: 'mcp-note', text: tr('agents.outdated') }));

    // the name
    const nameInput = h('input', { class: 'settings-input', type: 'text', maxlength: String((data.limits && data.limits.nameChars) || 40), value: agent.name, autocomplete: 'off', 'aria-label': tr('agents.renameLabel', { name: agent.name }) });
    nameInput.addEventListener('focus', () => state.editing.add(agent.id));
    nameInput.addEventListener('blur', () => {
      if (nameInput.value.trim() === agent.name) state.editing.delete(agent.id);
    });
    const save = h('button', { type: 'button', class: 'branding-manager-action', text: tr('agents.save') });
    save.addEventListener('click', () => change(agent, { name: nameInput.value.replace(/\s+/g, ' ').trim() }, save));
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save.click();
      }
    });
    card.append(h('div', { class: 'mcp-copy-row agents-rename' }, nameInput, save));

    const options = h('div', { class: 'agents-options' });
    if (data.canShareTeams) options.append(toggle(tr('agents.shareTeams'), agent.shareTeams, (value, input) => change(agent, { shareTeams: value }, input)));
    if (data.canShareAll) options.append(toggle(tr('agents.shareAll'), agent.shareAll, (value, input) => change(agent, { shareAll: value }, input)));
    if (options.childNodes.length) card.append(options);

    const remove = h('button', { type: 'button', class: 'branding-manager-action danger', text: tr('agents.remove'), 'aria-label': tr('agents.removeNamed', { name: agent.name }) });
    twoStep(remove, tr('agents.removeConfirm'), () => removeAgent(agent));
    card.append(h('div', { class: 'mcp-key-actions' }, remove));
    return card;
  }

  function renderList() {
    const slot = state.refs.list;
    // a name being typed is kept: the list is drawn again only when nobody types
    if (state.editing.size && slot.childNodes.length) return;
    slot.replaceChildren(h('h3', { class: 'settings-section-title', id: 'agentsListTitle', text: tr('agents.list.title') }));
    if (!state.data) {
      slot.append(h('p', { class: state.loadError ? 'settings-feedback error' : 'settings-hint', text: state.loadError ? tr('agents.loadFailed', { error: state.loadError }) : tr('agents.loading') }));
      return;
    }
    const agents = Array.isArray(state.data.agents) ? state.data.agents : [];
    if (!agents.length) {
      slot.append(h('p', { class: 'context-empty', text: tr('agents.list.empty') }));
      return;
    }
    for (const agent of agents) slot.append(agentCard(agent));
  }

  /* ---------- actions ---------- */

  async function createCode(button) {
    button.disabled = true;
    feedback('');
    try {
      state.pairing = await request('POST', '/api/render-agents/pairing-code');
      renderConnect();
      const area = document.getElementById(/Win/.test(global.navigator && global.navigator.userAgent) ? 'agentsCommandPs' : 'agentsCommandBash');
      if (area && typeof area.scrollIntoView === 'function') area.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      feedback(errorText(error), { error: true });
      button.disabled = false;
    }
  }

  async function change(agent, patch, control) {
    if (patch.name !== undefined && !patch.name) {
      feedback(tr('agents.err.INVALID_NAME'), { error: true });
      return;
    }
    control.disabled = true;
    feedback('');
    try {
      await request('PATCH', `/api/render-agents/${encodeURIComponent(agent.id)}`, patch);
      state.editing.delete(agent.id);
      feedback(tr('agents.saved'));
    } catch (error) {
      feedback(errorText(error), { error: true });
    }
    control.disabled = false;
    await load();
  }

  async function removeAgent(agent) {
    feedback('');
    try {
      await request('DELETE', `/api/render-agents/${encodeURIComponent(agent.id)}`);
      state.editing.delete(agent.id);
      feedback(tr('agents.removed', { name: agent.name }));
    } catch (error) {
      feedback(errorText(error), { error: true });
    }
    await load();
  }

  /* ---------- the dialog ---------- */

  function buildBody() {
    const body = state.refs.body;
    state.refs.intro = h('p', { class: 'settings-hint' });
    state.refs.connect = h('section', { class: 'agents-connect', 'aria-labelledby': 'agentsConnectTitle' });
    state.refs.list = h('section', { class: 'mcp-list agents-list', 'aria-labelledby': 'agentsListTitle' });
    state.refs.feedback = h('div', { class: 'settings-feedback hidden', role: 'status', 'aria-live': 'polite' });
    body.replaceChildren(state.refs.intro, state.refs.connect, state.refs.feedback, state.refs.list);
  }

  function open(trigger) {
    const modal = document.getElementById('renderAgentsModal');
    if (!modal || !allowed(access() && access().me())) return;
    state.trigger = trigger && typeof trigger.focus === 'function' ? trigger : document.activeElement;
    state.refs.body = document.getElementById('renderAgentsBody');
    if (!state.refs.intro) buildBody();
    state.isOpen = true;
    modal.classList.remove('hidden');
    renderAll();
    if (typeof global.applyI18n === 'function') global.applyI18n();
    const close = document.getElementById('renderAgentsClose');
    if (close) close.focus();
    load().then(schedule);
  }

  function close() {
    const modal = document.getElementById('renderAgentsModal');
    if (!modal) return;
    clearTimeout(state.timer);
    state.isOpen = false;
    // the code is not shown a second time: a new one is made when it is needed
    state.pairing = null;
    state.editing.clear();
    feedback('');
    modal.classList.add('hidden');
    if (state.trigger && state.trigger.isConnected) state.trigger.focus();
    state.trigger = null;
  }

  function rerender() {
    if (state.isOpen) renderAll();
  }

  function wire() {
    const modal = document.getElementById('renderAgentsModal');
    if (!modal || modal.dataset.wired === 'true') return;
    modal.dataset.wired = 'true';
    document.getElementById('renderAgentsClose').addEventListener('click', close);
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

  function attach() {
    wire();
    if (state.attached || !global.OCShell) return;
    state.attached = true;
    global.OCShell.addSection('account', (ctx) => {
      if (!allowed(ctx.me)) return [];
      return [{ id: 'render-agents', label: tr('agents.menu'), title: tr('agents.menuTitle'), onSelect: () => open(document.querySelector('.account-chip')) }];
    });
  }

  /* ---------- the admin list (settings, render nodes) ---------- */

  function renderAdminList(container, agents, { onChanged } = {}) {
    if (!container) return;
    container.replaceChildren();
    const list = Array.isArray(agents) ? agents : [];
    if (!list.length) {
      container.append(h('div', { class: 'render-nodes-empty', text: tr('agents.admin.empty') }));
      return;
    }
    for (const agent of list) {
      const dot = h('span', { class: `render-node-manager-dot${agent.online ? (agent.rendering && agent.rendering.length ? ' rendering' : ' online') : ''}`, title: tr(agent.online ? 'agents.online' : 'agents.offline') });
      const meta = [
        tr(agent.online ? 'agents.online' : 'agents.offline'),
        agent.online ? null : lastSeenText(agent.lastSeenAt),
        agent.rendering && agent.rendering.length ? tr('agents.admin.rendering', { count: agent.rendering.length }) : null,
        tr('agents.admin.completed', { count: agent.completed || 0 }),
        agent.shareAll ? tr('agents.badgeShared') : agent.shareTeams ? tr('agents.badgeTeams') : null,
        agent.outdated ? tr('agents.badgeOutdated') : null
      ].filter(Boolean).join(' · ');
      const remove = h('button', { type: 'button', class: 'branding-manager-action danger', text: tr('agents.remove'), 'aria-label': tr('agents.removeNamed', { name: agent.name }) });
      twoStep(remove, tr('agents.removeConfirm'), async () => {
        remove.disabled = true;
        try {
          await request('DELETE', `/api/render-agents/${encodeURIComponent(agent.id)}`);
          if (typeof onChanged === 'function') onChanged(tr('agents.removed', { name: agent.name }));
        } catch (error) {
          remove.disabled = false;
          if (typeof onChanged === 'function') onChanged(errorText(error), { error: true });
        }
      });
      container.append(
        h(
          'div',
          { class: 'render-node-manager-row', dataset: { agent: agent.id } },
          dot,
          h(
            'div',
            { class: 'render-node-manager-copy' },
            h('div', { class: 'render-node-manager-name', text: agent.name }),
            h('div', { class: 'render-node-manager-url', title: agent.owner || '', text: `${agent.owner || ''} · ${platformText(agent.platform)}` }),
            h('div', { class: 'render-node-manager-meta', text: `${meta}${versionsText(agent.versions) ? ` · ${versionsText(agent.versions)}` : ''}` })
          ),
          h('div', { class: 'settings-actions' }, remove)
        )
      );
    }
  }

  global.OCRenderAgents = { attach, open, close, rerender, renderAdminList, helpers: { lastSeenText, platformText, versionsText, renderingText, errorText, allowed } };
})(window);
