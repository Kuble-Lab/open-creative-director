'use strict';

// Interface of the teams (trainings with a USD budget per person), admin part. Server: lib/teams.js, routes /api/teams.
// Only active with user management (public/access-client.js says so) and only for admins; in the local mode nothing
// is mounted and this file does nothing.
//
//   OCTeams.attach({ openSettingsTab, settingsAvailable })  wires the menu entry "Manage teams"
//   OCTeams.mount(slot)              builds the section "Teams" inside the settings (slot: #settingsTeamsSlot)
//   OCTeams.load()                   reads the teams (call when the settings open)
//   OCTeams.rerender()               language change
//   OCTeams.userPaste({...})         "paste several addresses" for the team list of the settings (shares the paste box)
//   OCTeams.pasteBox({...})          the paste box itself: textarea, preview "N new · M already in the team · K invalid",
//                                    one button "Add N people"
//
// The parser is public/email-list.js (also used by the server), so the preview and the server read a paste the same way.
// Everything that comes from the server is written as text, never as HTML; there are no native dialogs.
(function (global) {
  const tr = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);
  const access = () => global.OCAccess;
  const emailList = () => global.OCEmailList;

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

  function formatDate(iso) {
    if (!iso) return '';
    const time = new Date(iso);
    if (Number.isNaN(time.getTime())) return '';
    const lang = typeof global.getLang === 'function' ? global.getLang() : 'de';
    return time.toLocaleString(lang === 'de' ? 'de-CH' : lang, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function people(count) {
    return count === 1 ? tr('teams.peopleOne') : tr('teams.peopleMany', { count });
  }

  // A readable sentence for a failed request: the code of the server first, then the network, then its own text.
  function errorText(error, limits) {
    if (!error) return tr('teams.err.generic', { error: '' });
    if (!error.status && !error.code) return tr('common.networkError');
    const key = `teams.err.${error.code}`;
    const text = error.code ? tr(key, { max: (limits && (error.code === 'TOO_MANY_EMAILS' ? limits.maxBulk : limits.maxBudgetUsd)) || '' }) : key;
    if (error.code && text !== key) return text;
    return tr('teams.err.generic', { error: error.message || '' });
  }

  /* ---------- the paste box (team members and team list) ---------- */

  let pasteCounter = 0;

  // options: max (addresses at once), alreadyKey (text key for "already there"), existing() -> lower case addresses,
  // add(emails) -> Promise of the answer of the server ({ added, already, invalid }), onResult(answer, info).
  function pasteBox({ max = 500, alreadyKey = 'paste.alreadyTeam', existing = () => [], add, onResult, errorLimits }) {
    pasteCounter += 1;
    const inputId = `pasteInput${pasteCounter}`;
    const hintId = `pasteHint${pasteCounter}`;
    const textarea = h('textarea', {
      id: inputId,
      class: 'settings-input paste-input',
      rows: '4',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      'aria-describedby': hintId,
      placeholder: tr('paste.placeholder')
    });
    const hint = h('p', { class: 'settings-hint paste-hint', id: hintId, text: tr('paste.hint', { max }) });
    const preview = h('div', { class: 'paste-preview', role: 'status', 'aria-live': 'polite' });
    const button = h('button', { type: 'button', class: 'branding-manager-action primary paste-add', disabled: true });
    const result = h('div', { class: 'paste-result settings-feedback hidden', role: 'status' });
    const element = h('div', { class: 'paste-box' }, h('label', { class: 'render-node-field', for: inputId }, h('span', { text: tr('paste.label') }), textarea), hint, preview, h('div', { class: 'paste-actions' }, button), result);
    let busy = false;
    let current = { fresh: [], already: [], parsed: { emails: [], invalid: [], found: 0, duplicates: 0 } };

    function analyse() {
      const parser = emailList();
      const parsed = parser.parse(textarea.value);
      const { fresh, already } = parser.classify(parsed, new Set(existing()));
      return { parsed, fresh, already };
    }

    function update() {
      current = analyse();
      const { parsed, fresh, already } = current;
      const empty = !textarea.value.trim();
      preview.replaceChildren();
      if (empty) {
        preview.append(h('span', { class: 'paste-muted', text: tr('paste.empty') }));
      } else {
        const parts = [h('span', { class: 'paste-count is-fresh', text: tr('paste.fresh', { count: fresh.length }) }), h('span', { class: 'paste-count', text: tr(alreadyKey, { count: already.length }) })];
        if (parsed.invalid.length) {
          parts.push(
            h('details', { class: 'paste-invalid' }, h('summary', { class: 'paste-count is-invalid', text: tr('paste.invalid', { count: parsed.invalid.length }) }), h('ul', {}, parsed.invalid.map((piece) => h('li', { text: piece }))))
          );
        } else {
          parts.push(h('span', { class: 'paste-count', text: tr('paste.invalid', { count: 0 }) }));
        }
        parts.forEach((part, index) => {
          if (index > 0) preview.append(h('span', { class: 'paste-sep', 'aria-hidden': 'true', text: '·' }));
          preview.append(part);
        });
        if (parsed.duplicates > 0) preview.append(h('span', { class: 'paste-muted paste-dups', text: `(${tr('paste.duplicates', { count: parsed.duplicates })})` }));
        if (fresh.length > max) preview.append(h('div', { class: 'paste-warn', text: tr('paste.tooMany', { max }) }));
      }
      const count = fresh.length;
      button.textContent = count === 0 ? tr('paste.addNone') : count === 1 ? tr('paste.addOne') : tr('paste.addMany', { count });
      button.disabled = busy || count === 0 || count > max;
    }

    function showResult(message, error) {
      result.textContent = message;
      result.classList.toggle('hidden', !message);
      result.classList.toggle('error', Boolean(error));
    }

    textarea.addEventListener('input', () => {
      showResult('', false);
      update();
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !button.disabled) {
        event.preventDefault();
        button.click();
      }
    });
    button.addEventListener('click', async () => {
      if (busy || button.disabled) return;
      const snapshot = current;
      busy = true;
      update();
      try {
        const answer = await add(snapshot.fresh);
        textarea.value = '';
        const added = Array.isArray(answer && answer.added) ? answer.added.length : 0;
        const alreadyThere = snapshot.already.length + (Array.isArray(answer && answer.already) ? answer.already.length : 0);
        showResult(tr('paste.result', { added, already: alreadyThere, invalid: snapshot.parsed.invalid.length }), false);
        if (typeof onResult === 'function') onResult(answer, { added, already: alreadyThere, invalid: snapshot.parsed.invalid });
      } catch (error) {
        showResult(tr('paste.failed', { error: errorText(error, errorLimits && errorLimits()) }), true);
        if (typeof onResult === 'function') onResult(null, { error });
      } finally {
        busy = false;
        update();
      }
    });

    update();
    return {
      element,
      textarea,
      update,
      // Texts follow the language: rebuild the static parts, keep what was typed.
      retranslate() {
        hint.textContent = tr('paste.hint', { max });
        textarea.placeholder = tr('paste.placeholder');
        element.querySelector('label > span').textContent = tr('paste.label');
        update();
      },
      focus: () => textarea.focus()
    };
  }

  /* ---------- state ---------- */

  const state = {
    mounted: false,
    available: false,
    root: null,
    list: null,
    createForm: null,
    syncBox: null,
    problemBox: null,
    domainBox: null,
    domainsMissing: false,
    feedback: null,
    teams: [],
    details: new Map(),
    ui: new Map(), // per team: { open, filter, editing }
    pastes: new Map(),
    sync: null,
    limits: { maxBulk: 500, maxBudgetUsd: 10000, maxNameLength: 80, maxDescriptionLength: 400 },
    problem: null,
    loaded: false,
    loading: false,
    pending: null,
    hooks: { openSettingsTab: null, settingsAvailable: null }
  };

  const uiOf = (id) => {
    if (!state.ui.has(id)) state.ui.set(id, { open: false, filter: '', editing: null, focusEditor: false });
    return state.ui.get(id);
  };

  function feedback(message, { error = false } = {}) {
    if (!state.feedback) return;
    state.feedback.textContent = message || '';
    state.feedback.classList.toggle('hidden', !message);
    state.feedback.classList.toggle('error', Boolean(message && error));
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

  function parseAmount(text) {
    const value = String(text || '').trim().replace(',', '.');
    if (!value) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  /* ---------- data ---------- */

  function applySync(sync) {
    if (sync !== undefined) state.sync = sync;
    renderSync();
  }

  function summaryOf(detail) {
    const { members, ...summary } = detail;
    return summary;
  }

  function storeDetail(detail) {
    state.details.set(detail.id, detail);
    const summary = summaryOf(detail);
    const index = state.teams.findIndex((team) => team.id === detail.id);
    if (index >= 0) state.teams[index] = summary;
    else state.teams.push(summary);
  }

  async function load({ quiet = false } = {}) {
    if (!state.mounted || state.loading) return;
    const me = access() && access().me();
    if (!me || !me.active || !me.isAdmin) return;
    state.loading = true;
    if (!quiet && !state.loaded) state.list.replaceChildren(h('p', { class: 'settings-hint', text: tr('teams.loading') }));
    try {
      const data = await request('GET', '/api/teams');
      state.teams = Array.isArray(data.teams) ? data.teams : [];
      state.limits = { ...state.limits, ...(data.limits || {}) };
      state.domainsMissing = data.internalDomainsMissing === true;
      state.problem = typeof data.problem === 'string' && data.problem ? data.problem : data.problem ? String(data.problem) : null;
      state.loaded = true;
      applySync(data.sync);
      state.root.classList.remove('hidden');
      renderProblem();
      renderDomains();
      renderList();
      // Open teams show current figures.
      await Promise.all(state.teams.filter((team) => uiOf(team.id).open).map((team) => loadDetail(team.id, { quiet: true })));
    } catch (error) {
      if (error.status === 400 && error.code === 'USER_MANAGEMENT_INACTIVE') {
        state.root.classList.add('hidden');
      } else {
        state.list.replaceChildren(h('p', { class: 'settings-feedback error', text: tr('teams.loadFailed', { error: errorText(error, state.limits) }) }));
      }
    } finally {
      state.loading = false;
    }
  }

  async function loadDetail(id, { quiet = false } = {}) {
    try {
      const data = await request('GET', `/api/teams/${encodeURIComponent(id)}`);
      storeDetail(data.team);
      applySync(data.sync);
      renderCard(id);
    } catch (error) {
      if (error.code === 'TEAM_NOT_FOUND') {
        feedback(errorText(error, state.limits), { error: true });
        await load({ quiet: true });
        return;
      }
      if (!quiet) feedback(errorText(error, state.limits), { error: true });
    }
  }

  // Runs one change: shows the answer, keeps the figures in step, explains a failure.
  async function run(work, { onDone, focus } = {}) {
    feedback('');
    try {
      const data = await work();
      if (data && data.team) storeDetail(data.team);
      if (data && data.sync !== undefined) applySync(data.sync);
      if (typeof onDone === 'function') onDone(data);
      return data;
    } catch (error) {
      feedback(errorText(error, state.limits), { error: true });
      if (error.code === 'TEAM_NOT_FOUND' || error.code === 'MEMBER_NOT_FOUND') await load({ quiet: true });
      return null;
    } finally {
      if (focus) focus();
    }
  }

  /* ---------- rendering ---------- */

  function renderSync() {
    if (!state.syncBox) return;
    const sync = state.sync;
    state.syncBox.replaceChildren();
    state.syncBox.classList.toggle('hidden', !(sync && sync.enabled));
    if (!sync || !sync.enabled) return;
    const warning = sync.ok === false || Boolean(sync.warning);
    state.syncBox.className = `teams-notice ${warning ? 'is-warning' : 'is-ok'}`;
    state.syncBox.setAttribute('role', warning ? 'alert' : 'status');
    state.syncBox.append(
      warning
        ? tr('teams.syncWarning', { warning: String(sync.warning || '').replace(/\s+$/, '') })
        : tr('teams.syncOk', { route: sync.route || '', count: sync.syncedCount || 0 })
    );
  }

  function renderProblem() {
    if (!state.problemBox) return;
    state.problemBox.classList.toggle('hidden', !state.problem);
    state.problemBox.textContent = state.problem ? tr('teams.problem', { problem: state.problem }) : '';
  }

  function renderDomains() {
    if (!state.domainBox) return;
    state.domainBox.classList.toggle('hidden', !state.domainsMissing);
    state.domainBox.textContent = state.domainsMissing ? tr('teams.noInternalDomains') : '';
  }

  function renderList() {
    clearPending();
    state.list.replaceChildren();
    if (!state.teams.length) {
      state.list.append(h('p', { class: 'context-empty', text: tr('teams.empty') }));
      return;
    }
    for (const team of state.teams) state.list.append(teamCard(team.id));
  }

  function renderCard(id, { focus } = {}) {
    clearPending();
    const old = [...state.list.querySelectorAll('[data-team]')].find((node) => node.dataset.team === id);
    if (!old) return;
    const next = teamCard(id);
    old.replaceWith(next);
    if (focus) {
      const target = typeof focus === 'function' ? focus(next) : next.querySelector(focus);
      if (target) target.focus();
    }
  }

  function summaryLine(team) {
    return [people(team.memberCount), tr('teams.perPerson', { amount: fmt(team.budgetUsd) }), tr('teams.spentTotal', { amount: fmt(team.spentUsd) })].join(' · ');
  }

  function teamCard(id) {
    const team = state.teams.find((entry) => entry.id === id);
    const detail = state.details.get(id);
    const view = uiOf(id);
    const bodyId = `teamBody-${id}`;
    const card = h('article', { class: `team-card${team.archived ? ' is-archived' : ''}${view.open ? ' is-open' : ''}`, dataset: { team: id } });
    const head = h(
      'button',
      { type: 'button', class: 'team-head', 'aria-expanded': String(view.open), 'aria-controls': bodyId, title: tr('teams.toggle', { name: team.name }) },
      h('span', { class: 'team-chevron', 'aria-hidden': 'true', text: '›' }),
      h('span', { class: 'team-name', text: team.name }),
      team.archived ? h('span', { class: 'admin-source-badge', text: tr('teams.archivedBadge') }) : null,
      h('span', { class: 'team-meta', text: summaryLine(team) })
    );
    head.addEventListener('click', async () => {
      view.open = !view.open;
      if (view.open && !state.details.has(id)) {
        renderCard(id, { focus: '.team-head' });
        await loadDetail(id);
        return;
      }
      renderCard(id, { focus: '.team-head' });
      if (view.open) loadDetail(id, { quiet: true });
    });
    card.append(head);
    if (!view.open) return card;

    const body = h('div', { class: 'team-body', id: bodyId });
    card.append(body);
    if (!detail) {
      body.append(h('p', { class: 'settings-hint', text: tr('teams.loading') }));
      return card;
    }
    body.append(editForm(team), h('div', { class: 'team-paste' }, pasteFor(id).element), membersBlock(team, detail));
    return card;
  }

  function editForm(team) {
    const id = team.id;
    const suffix = `${id}`;
    const name = h('input', { id: `teamName-${suffix}`, class: 'settings-input', type: 'text', maxlength: String(state.limits.maxNameLength || 80), required: true, autocomplete: 'off', value: team.name });
    const budget = h('input', { id: `teamBudget-${suffix}`, class: 'settings-input', type: 'text', inputmode: 'decimal', required: true, autocomplete: 'off', value: String(team.budgetUsd) });
    const description = h('input', { id: `teamDesc-${suffix}`, class: 'settings-input', type: 'text', maxlength: String(state.limits.maxDescriptionLength || 400), autocomplete: 'off', value: team.description || '' });
    const save = actionButton(tr('teams.save'), { primary: true, type: 'submit' });
    const archive = actionButton(team.archived ? tr('teams.unarchive') : tr('teams.archive'), { title: tr('teams.archiveHint') });
    const refresh = actionButton(tr('teams.refresh'));
    const remove = actionButton(tr('teams.delete'), { danger: true });
    const form = h(
      'form',
      { class: 'team-edit', novalidate: true },
      h('label', { class: 'render-node-field', for: name.id }, h('span', { text: tr('teams.name') }), name),
      h('label', { class: 'render-node-field', for: budget.id }, h('span', { text: tr('teams.budget') }), budget),
      h('label', { class: 'render-node-field team-edit-wide', for: description.id }, h('span', { text: tr('teams.description') }), description),
      h('div', { class: 'team-edit-actions' }, save, archive, refresh, remove)
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const amount = parseAmount(budget.value);
      if (amount === null || Number.isNaN(amount)) {
        feedback(tr('teams.err.INVALID_BUDGET', { max: state.limits.maxBudgetUsd }), { error: true });
        return;
      }
      save.disabled = true;
      run(() => request('PATCH', `/api/teams/${encodeURIComponent(id)}`, { name: name.value, budgetUsd: amount, description: description.value }), {
        onDone: () => {
          feedback(tr('teams.saved'));
          renderCard(id, { focus: '.team-head' });
        }
      }).finally(() => {
        save.disabled = false;
      });
    });
    archive.addEventListener('click', () => {
      archive.disabled = true;
      const archived = !team.archived;
      run(() => request('PATCH', `/api/teams/${encodeURIComponent(id)}`, { archived }), {
        onDone: () => {
          feedback(tr(archived ? 'teams.archived' : 'teams.unarchived'));
          renderCard(id, { focus: '.team-head' });
        }
      }).finally(() => {
        archive.disabled = false;
      });
    });
    refresh.addEventListener('click', () => loadDetail(id));
    twoStep(`delete:${id}`, remove, tr('common.reallyDelete'), () => {
      run(() => request('DELETE', `/api/teams/${encodeURIComponent(id)}`), {
        onDone: () => {
          state.teams = state.teams.filter((entry) => entry.id !== id);
          state.details.delete(id);
          state.ui.delete(id);
          state.pastes.delete(id);
          feedback(tr('teams.deleted'));
          renderList();
        }
      });
    });
    return form;
  }

  function pasteFor(id) {
    let box = state.pastes.get(id);
    if (!box) {
      box = pasteBox({
        max: state.limits.maxBulk || 500,
        alreadyKey: 'paste.alreadyTeam',
        existing: () => (state.details.get(id) ? state.details.get(id).members.map((member) => member.email) : []),
        errorLimits: () => state.limits,
        add: async (emails) => {
          const data = await request('POST', `/api/teams/${encodeURIComponent(id)}/members`, { emails });
          if (data.team) storeDetail(data.team);
          if (data.sync !== undefined) applySync(data.sync);
          return data;
        },
        onResult: (answer) => {
          if (answer) renderCard(id);
        }
      });
      state.pastes.set(id, box);
    }
    return box;
  }

  function membersBlock(team, detail) {
    const id = team.id;
    const view = uiOf(id);
    const block = h('div', { class: 'team-members' });
    block.append(h('h4', { class: 'team-members-title', text: `${tr('teams.members')} (${detail.members.length})` }));
    if (!detail.members.length) {
      block.append(h('p', { class: 'context-empty', text: tr('teams.noMembers') }));
      return block;
    }
    let search = null;
    if (detail.members.length > 10) {
      search = h('input', { class: 'settings-input team-search', type: 'search', autocomplete: 'off', placeholder: tr('teams.search'), 'aria-label': tr('teams.search'), value: view.filter });
      block.append(search);
    }
    const table = h('table', { class: 'team-table' });
    table.append(
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ['teams.colPerson', 'teams.colSeen', 'teams.colSpent', 'teams.colRemaining', 'teams.colBudget', 'teams.colActions'].map((key, index) => h('th', { scope: 'col', class: index >= 2 && index <= 4 ? 'num' : '', text: tr(key) }))
        )
      )
    );
    const body = h('tbody');
    table.append(body);
    const wrap = h('div', { class: 'team-table-wrap', tabindex: '0', role: 'region', 'aria-label': tr('teams.members') }, table);
    block.append(wrap);

    function fill() {
      body.replaceChildren();
      const needle = view.filter.trim().toLowerCase();
      for (const member of detail.members) {
        if (needle && !member.email.includes(needle)) continue;
        body.append(memberRow(team, member));
        if (view.editing === member.email) body.append(overrideRow(team, member));
      }
    }
    fill();
    if (search) {
      search.addEventListener('input', () => {
        view.filter = search.value;
        fill();
      });
    }
    return block;
  }

  function memberRow(team, member) {
    const id = team.id;
    const view = uiOf(id);
    const row = h('tr', { class: 'team-row' });
    const person = h('td', { 'data-label': tr('teams.colPerson') }, h('span', { class: 'team-email', text: member.email, title: member.email }));
    if (member.budgetOverrideUsd !== null && member.budgetOverrideUsd !== undefined) person.append(h('span', { class: 'admin-source-badge', text: tr('teams.overrideBadge') }));
    const remaining = Math.max(0, member.remainingUsd || 0);
    const exhausted = remaining < 0.005;
    const low = !exhausted && member.limitUsd > 0 && remaining / member.limitUsd <= 0.15;
    const left = h('td', { class: `num team-left${exhausted ? ' is-exhausted' : low ? ' is-low' : ''}`, 'data-label': tr('teams.colRemaining'), text: fmt(remaining) });
    if (member.reservedUsd >= 0.005) left.title = tr('teams.reservedHint', { amount: fmt(member.reservedUsd) });
    const overrideBtn = actionButton(tr('teams.overrideEdit'));
    overrideBtn.dataset.act = 'override';
    overrideBtn.dataset.email = member.email;
    overrideBtn.setAttribute('aria-expanded', String(view.editing === member.email));
    overrideBtn.addEventListener('click', () => {
      view.editing = view.editing === member.email ? null : member.email;
      view.focusEditor = view.editing !== null;
      renderCard(id, { focus: (card) => [...card.querySelectorAll('[data-act="override"]')].find((node) => node.dataset.email === member.email) });
    });
    const resetBtn = actionButton(tr('teams.reset'), { title: tr('teams.resetHint') });
    twoStep(`reset:${id}:${member.email}`, resetBtn, tr('teams.resetConfirm'), () => {
      run(() => request('PATCH', `/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(member.email)}`, { resetBudget: true }), {
        onDone: () => {
          feedback(tr('teams.resetDone', { email: member.email }));
          renderCard(id, { focus: '.team-head' });
        }
      });
    });
    const removeBtn = actionButton(tr('teams.remove'), { danger: true });
    twoStep(`remove:${id}:${member.email}`, removeBtn, tr('common.reallyDelete'), () => {
      run(() => request('DELETE', `/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(member.email)}`), {
        onDone: () => {
          if (view.editing === member.email) view.editing = null;
          feedback(tr('teams.removed', { email: member.email }));
          renderCard(id, { focus: '.team-head' });
        }
      });
    });
    row.append(
      person,
      h('td', { 'data-label': tr('teams.colSeen'), text: member.lastSeen ? formatDate(member.lastSeen) : tr('teams.neverSeen') }),
      h('td', { class: 'num', 'data-label': tr('teams.colSpent'), text: fmt(member.spentUsd) }),
      left,
      h('td', { class: 'num', 'data-label': tr('teams.colBudget'), text: fmt(member.limitUsd) }),
      h('td', { class: 'team-actions', 'data-label': tr('teams.colActions') }, overrideBtn, resetBtn, removeBtn)
    );
    return row;
  }

  function overrideRow(team, member) {
    const id = team.id;
    const view = uiOf(id);
    const input = h('input', {
      class: 'settings-input team-override-input',
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      'aria-label': tr('teams.overrideAmount', { email: member.email }),
      value: String(member.budgetOverrideUsd ?? member.teamLimitUsd ?? team.budgetUsd)
    });
    const set = actionButton(tr('teams.overrideSet'), { primary: true, type: 'submit' });
    const clear = actionButton(tr('teams.overrideClear'), { title: tr('teams.overrideClear') + ': ' + fmt(team.budgetUsd) });
    clear.disabled = member.budgetOverrideUsd === null || member.budgetOverrideUsd === undefined;
    const cancel = actionButton(tr('common.cancel'));
    const form = h('form', { class: 'team-override', novalidate: true }, input, set, clear, cancel);
    const cell = h('td', { colspan: '6' }, form);
    const close = () => {
      view.editing = null;
      renderCard(id, { focus: (card) => [...card.querySelectorAll('[data-act="override"]')].find((node) => node.dataset.email === member.email) });
    };
    const send = (value, okText) => {
      set.disabled = true;
      clear.disabled = true;
      run(() => request('PATCH', `/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(member.email)}`, { budgetOverrideUsd: value }), {
        onDone: () => {
          feedback(okText);
          view.editing = null;
          renderCard(id, { focus: '.team-head' });
        }
      }).finally(() => {
        set.disabled = false;
      });
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const amount = parseAmount(input.value);
      if (amount === null || Number.isNaN(amount)) {
        feedback(tr('teams.err.INVALID_BUDGET', { max: state.limits.maxBudgetUsd }), { error: true });
        input.focus();
        return;
      }
      send(amount, tr('teams.overrideSaved', { email: member.email, amount: fmt(amount) }));
    });
    clear.addEventListener('click', () => send(null, tr('teams.overrideCleared', { email: member.email })));
    cancel.addEventListener('click', close);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    });
    if (view.focusEditor) {
      view.focusEditor = false;
      queueMicrotask(() => input.focus());
    }
    return h('tr', { class: 'team-override-row' }, cell);
  }

  /* ---------- the section in the settings ---------- */

  function mount(slot) {
    if (!slot || state.mounted) return;
    const nameInput = h('input', { id: 'teamCreateName', class: 'settings-input', type: 'text', maxlength: '80', required: true, autocomplete: 'off', placeholder: tr('teams.namePlaceholder') });
    const budgetInput = h('input', { id: 'teamCreateBudget', class: 'settings-input', type: 'text', inputmode: 'decimal', required: true, autocomplete: 'off', placeholder: '20' });
    const descInput = h('input', { id: 'teamCreateDesc', class: 'settings-input', type: 'text', maxlength: '400', autocomplete: 'off' });
    const create = actionButton(tr('teams.create'), { primary: true, type: 'submit' });
    const form = h(
      'form',
      { class: 'team-create', novalidate: true },
      h('div', { class: 'render-node-form-heading', text: tr('teams.newTitle') }),
      h('label', { class: 'render-node-field', for: nameInput.id }, h('span', { text: tr('teams.name') }), nameInput),
      h('label', { class: 'render-node-field', for: budgetInput.id }, h('span', { text: tr('teams.budget') }), budgetInput),
      h('label', { class: 'render-node-field team-edit-wide', for: descInput.id }, h('span', { text: tr('teams.description') }), descInput),
      h('p', { class: 'settings-hint team-edit-wide team-budget-hint', text: tr('teams.budgetHint', { max: state.limits.maxBudgetUsd }) }),
      h('div', { class: 'team-edit-actions' }, create)
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const amount = parseAmount(budgetInput.value);
      if (amount === null || Number.isNaN(amount)) {
        feedback(tr('teams.err.INVALID_BUDGET', { max: state.limits.maxBudgetUsd }), { error: true });
        budgetInput.focus();
        return;
      }
      create.disabled = true;
      const data = await run(() => request('POST', '/api/teams', { name: nameInput.value, budgetUsd: amount, description: descInput.value }));
      create.disabled = false;
      if (!data || !data.team) return;
      form.reset();
      uiOf(data.team.id).open = true;
      feedback(tr('teams.created', { name: data.team.name }));
      renderList();
      const box = state.pastes.get(data.team.id);
      if (box) box.focus();
    });

    state.feedback = h('div', { class: 'settings-feedback hidden', role: 'status', 'aria-live': 'polite' });
    state.syncBox = h('div', { class: 'teams-notice hidden' });
    state.problemBox = h('div', { class: 'teams-notice is-warning hidden', role: 'alert' });
    state.domainBox = h('div', { class: 'teams-notice is-warning hidden', role: 'alert' });
    state.list = h('div', { class: 'teams-list' });
    state.createForm = form;
    const titleId = 'teamsTitle';
    state.root = h(
      'section',
      { class: 'settings-teams', 'aria-labelledby': titleId },
      h('h3', { id: titleId, class: 'settings-section-title', text: tr('teams.title') }),
      h('p', { class: 'settings-hint', text: tr('teams.hint') }),
      state.syncBox,
      state.problemBox,
      state.domainBox,
      state.list,
      form,
      state.feedback
    );
    slot.replaceChildren(state.root);
    state.mounted = true;
  }

  function rerender() {
    if (!state.mounted) return;
    const create = state.createForm;
    const values = create ? [...create.querySelectorAll('input')].map((input) => input.value) : [];
    state.root.querySelector('.settings-section-title').textContent = tr('teams.title');
    state.root.querySelector('.settings-hint').textContent = tr('teams.hint');
    if (create) {
      const labels = create.querySelectorAll('label > span');
      ['teams.name', 'teams.budget', 'teams.description'].forEach((key, index) => {
        if (labels[index]) labels[index].textContent = tr(key);
      });
      create.querySelector('.render-node-form-heading').textContent = tr('teams.newTitle');
      create.querySelector('.team-budget-hint').textContent = tr('teams.budgetHint', { max: state.limits.maxBudgetUsd });
      create.querySelector('button[type="submit"]').textContent = tr('teams.create');
      create.querySelector('#teamCreateName').placeholder = tr('teams.namePlaceholder');
      [...create.querySelectorAll('input')].forEach((input, index) => {
        input.value = values[index];
      });
    }
    for (const box of state.pastes.values()) box.retranslate();
    renderSync();
    renderProblem();
    if (state.loaded) renderList();
  }

  // "Manage teams" in the menu: opens the settings on the tab that holds the teams.
  function attach(hooks) {
    Object.assign(state.hooks, hooks || {});
    if (state.attached || !global.OCShell) return;
    state.attached = true;
    global.OCShell.addSection('account', (ctx) => {
      if (!ctx.me.active || !ctx.me.isAdmin || !state.hooks.openSettingsTab) return [];
      if (typeof state.hooks.settingsAvailable === 'function' && !state.hooks.settingsAvailable()) return [];
      return [{ id: 'teams', label: tr('teams.menu'), onSelect: () => state.hooks.openSettingsTab('people') }];
    });
  }

  /* ---------- paste several addresses into the team list ---------- */

  // options: existing() lower case addresses of the list, add(emails) -> answer of POST /api/users, onResult(answer).
  function userPaste({ existing, add, onResult }) {
    const box = pasteBox({ max: 500, alreadyKey: 'paste.alreadyList', existing, add, onResult });
    const summary = h('summary', { class: 'paste-summary', text: tr('paste.summary') });
    const details = h('details', { class: 'paste-details' }, summary, box.element);
    return {
      element: details,
      retranslate() {
        summary.textContent = tr('paste.summary');
        box.retranslate();
      }
    };
  }

  global.OCTeams = { attach, mount, load, rerender, userPaste, pasteBox, errorText, setAvailable: (value) => (state.available = Boolean(value)) };
})(window);
