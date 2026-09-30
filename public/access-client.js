'use strict';

// Browser side of the user management (server: lib/access.js). Shared by the chat view (app.js) and the node
// view (nodes/*.js). Everything here is inactive unless GET /api/me says `active: true`, which is the case if and
// only if the server has AUTH_WHOAMI_URL. In the local mode the app looks and behaves as it always has.
//
//   OCAccess.ready            promise of the /api/me answer (never rejects)
//   OCAccess.me()             { active, identified, email, role, isAdmin, isSuperAdmin, logoutUrl }
//   OCAccess.canAdminister()  local mode or admin: may use the admin-only parts of the interface
//   OCAccess.badge(entry)     shared badge of a list entry (team / number of people), or null
//   OCAccess.ownerName(entry) short owner name of somebody else's entry, or null
//   OCAccess.ownerChip(entry) breadcrumb element: owner name, gold star for admins, or null
//   OCAccess.shareForm(...)   the sharing form (used inside the chat modal and the node view dialog)
//   OCAccess.saveSharing(...) PATCH /api/sessions|workflows/:id/share with readable errors
//   OCAccess.openShareModal() chat view dialog
//
// Anything that comes from the server is written as text (never as HTML) and there are no native dialogs.
(function (global) {
  const DEFAULT_ME = Object.freeze({
    active: false,
    identified: false,
    email: null,
    role: 'local',
    isAdmin: true,
    isSuperAdmin: false,
    logoutUrl: null
  });

  let me = DEFAULT_ME;
  let team = null;
  let formCounter = 0;

  const tr = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);

  function rel(path) {
    return String(path).replace(/^\/+/, '');
  }

  async function request(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(rel(path), init);
    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      /* not JSON */
    }
    if (!res.ok) {
      const error = new Error((payload && payload.error) || `HTTP ${res.status}`);
      error.status = res.status;
      error.code = payload && payload.code;
      throw error;
    }
    return payload;
  }

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

  const ready = (async () => {
    try {
      const data = await request('GET', '/api/me');
      if (data && typeof data === 'object' && data.active === true) {
        me = Object.freeze({
          active: true,
          identified: Boolean(data.identified),
          email: typeof data.email === 'string' ? data.email : null,
          role: typeof data.role === 'string' ? data.role : 'anonymous',
          isAdmin: Boolean(data.isAdmin),
          isSuperAdmin: Boolean(data.isSuperAdmin),
          logoutUrl: typeof data.logoutUrl === 'string' && data.logoutUrl ? data.logoutUrl : null
        });
      }
    } catch (_) {
      /* the local mode (or an old server) has nothing to show */
    }
    return me;
  })();

  const currentMe = () => me;
  const isActive = () => me.active;
  const canAdminister = () => !me.active || me.isAdmin;

  /* ---------- names ---------- */

  function usernameOf(email) {
    return String(email || '').split('@')[0] || String(email || '');
  }

  function initialsOf(email) {
    const parts = usernameOf(email).split(/[._-]+/).filter(Boolean);
    const initials = parts.slice(0, 2).map((part) => [...part][0]).join('');
    return (initials || [...String(email || '?')].slice(0, 2).join('')).toUpperCase();
  }

  /* ---------- badges ---------- */

  // The owner of somebody else's entry (next to the date in a list): short name plus full address as title.
  function ownerName(entry) {
    if (!me.active || !entry || entry.unowned || !entry.owner || entry.mine !== false) return null;
    return { text: usernameOf(entry.owner), title: `${entry.owner} · ${tr('sharing.ownedBy', { name: entry.owner })}` };
  }

  // Shared badge of a list entry. Nothing for private entries and for entries without an owner (existing data).
  function badge(entry) {
    if (!me.active || !entry || entry.unowned || !entry.owner) return null;
    const foreign = entry.mine === false ? ` · ${tr('sharing.sharedBy', { name: entry.owner })}` : '';
    if (entry.shareMode === 'team') {
      return { label: `👥 ${tr('sharing.badgeTeam')}`, title: `${tr('sharing.stateTeam')}${foreign}` };
    }
    if (entry.shareMode === 'specific') {
      const count = Number.isInteger(entry.sharedCount) ? entry.sharedCount : Array.isArray(entry.sharedWith) ? entry.sharedWith.length : 0;
      if (count > 0) return { label: `👥 ${count}`, title: `${tr('sharing.stateSpecific', { count })}${foreign}` };
    }
    return null;
  }

  // Text of the share button tooltip: the current state.
  function stateText(entry) {
    if (!entry || entry.unowned) return tr('sharing.unownedHint');
    if (entry.shareMode === 'team') return tr('sharing.stateTeam');
    if (entry.shareMode === 'specific') {
      const count = Number.isInteger(entry.sharedCount) ? entry.sharedCount : Array.isArray(entry.sharedWith) ? entry.sharedWith.length : 0;
      return tr('sharing.stateSpecific', { count });
    }
    return tr('sharing.statePrivate');
  }

  // Owner in the breadcrumb of the open chat or workflow. Admins get a gold star.
  function ownerChip(entry) {
    if (!me.active || !entry || entry.unowned || !entry.owner) return null;
    const key = entry.mine ? 'sharing.ownedByYou' : 'sharing.ownedBy';
    const title = `${tr(key, { name: entry.owner })}${entry.ownerIsAdmin ? ` · ${tr('sharing.ownerIsAdmin')}` : ''}`;
    const chip = h('span', { class: `owner-chip${entry.mine ? ' mine' : ''}`, title }, h('span', { class: 'owner-chip-name', text: usernameOf(entry.owner) }));
    if (entry.ownerIsAdmin) chip.append(h('span', { class: 'owner-chip-star', 'aria-hidden': 'true', text: '★' }));
    return chip;
  }

  /* ---------- team list ---------- */

  async function loadTeam({ refresh = false } = {}) {
    if (team && !refresh) return team;
    const data = await request('GET', '/api/team');
    team = Array.isArray(data.members) ? data.members : [];
    return team;
  }

  /* ---------- sharing form ---------- */

  const MODES = [
    ['private', 'sharing.private', 'sharing.privateHint'],
    ['team', 'sharing.team', 'sharing.teamHint'],
    ['specific', 'sharing.specific', 'sharing.specificHint']
  ];

  // The form for the sharing of one entry. `entry` carries the describe fields (owner, unowned, shareMode,
  // sharedWith when the caller may see it). `members` is the team list. Returns { element, read(), focus() }.
  function shareForm({ entry, members }) {
    formCounter += 1;
    const group = `share-mode-${formCounter}`;
    const unowned = !entry || entry.unowned === true;
    // An entry without an owner is visible to everybody today; "team" is the closest starting point.
    const initialMode = unowned ? 'team' : ['private', 'team', 'specific'].includes(entry.shareMode) ? entry.shareMode : 'private';
    const selected = new Set(Array.isArray(entry && entry.sharedWith) ? entry.sharedWith : []);
    // The owner (or, for an entry without owner, the acting admin who becomes owner) never needs to be picked.
    const skip = unowned ? me.email : entry.owner;
    const people = (members || []).filter((member) => member.email !== skip);
    for (const email of selected) {
      if (email !== skip && !people.some((member) => member.email === email)) people.push({ email, role: 'user', me: false });
    }

    const radios = [];
    const modes = h('fieldset', { class: 'share-modes' }, h('legend', { class: 'share-legend', text: tr('sharing.modes') }));
    for (const [value, labelKey, hintKey] of MODES) {
      const input = h('input', { type: 'radio', name: group, value });
      input.checked = value === initialMode;
      input.addEventListener('change', renderPeople);
      radios.push(input);
      modes.append(
        h('label', { class: 'share-mode' }, input, h('span', { class: 'share-mode-copy' }, h('span', { class: 'share-mode-name', text: tr(labelKey) }), h('span', { class: 'share-mode-hint', text: tr(hintKey) })))
      );
    }
    const list = h('div', { class: 'share-people', role: 'group', 'aria-label': tr('sharing.people') });
    const element = h('div', { class: 'share-form' });
    if (unowned) element.append(h('p', { class: 'share-note', text: tr('sharing.hintUnowned') }));
    element.append(modes, list);

    const mode = () => (radios.find((radio) => radio.checked) || {}).value || 'private';

    function renderPeople() {
      // Keep what was ticked while the list is redrawn.
      for (const box of list.querySelectorAll('input[type="checkbox"]')) {
        if (box.checked) selected.add(box.value);
        else selected.delete(box.value);
      }
      list.textContent = '';
      list.classList.toggle('hidden', mode() !== 'specific');
      if (mode() !== 'specific') return;
      if (!people.length) {
        list.append(h('p', { class: 'share-empty', text: tr('sharing.noMembers') }));
        return;
      }
      for (const member of people) {
        const box = h('input', { type: 'checkbox', value: member.email });
        box.checked = selected.has(member.email);
        const role = member.role === 'admin' ? tr('sharing.admin') : tr('sharing.user');
        list.append(h('label', { class: 'share-person' }, box, h('span', { class: 'share-person-mail', text: member.email }), h('small', { class: 'share-person-role', text: role })));
      }
    }
    renderPeople();

    function read() {
      renderPeople();
      const shareMode = mode();
      return { shareMode, sharedWith: shareMode === 'specific' ? [...selected].filter((email) => people.some((person) => person.email === email)) : [] };
    }

    return { element, read, focus: () => (radios.find((radio) => radio.checked) || radios[0]).focus() };
  }

  // Human readable message for a failed sharing request (and whether the entry vanished for the caller).
  function sharingError(error) {
    if (error && error.status === 404) return { message: tr('sharing.gone'), gone: true };
    if (error && error.status === 403) return { message: tr('sharing.forbidden') };
    if (error && error.code === 'UNKNOWN_TEAM_MEMBERS') return { message: tr('sharing.unknownMembers'), reloadTeam: true };
    return { message: tr('sharing.saveFailed', { error: error && error.message ? error.message : '' }) };
  }

  // Saves the sharing. Resolves the updated entry fields (`session` / `workflow` of the answer), rejects with an
  // Error that carries `userMessage`, `gone` and `reloadTeam`.
  async function saveSharing(kind, id, value) {
    if (value.shareMode === 'specific' && !value.sharedWith.length) {
      const error = new Error('empty selection');
      error.userMessage = tr('sharing.selectOne');
      throw error;
    }
    const base = kind === 'workflow' ? 'workflows' : 'sessions';
    try {
      const data = await request('PATCH', `/api/${base}/${encodeURIComponent(id)}/share`, value);
      return kind === 'workflow' ? data.workflow : data.session;
    } catch (error) {
      const info = sharingError(error);
      error.userMessage = info.message;
      error.gone = Boolean(info.gone);
      error.reloadTeam = Boolean(info.reloadTeam);
      throw error;
    }
  }

  /* ---------- chat view dialog ---------- */

  let openModal = null;

  function closeShareModal() {
    if (!openModal) return;
    const { backdrop, onKey, previous } = openModal;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    openModal = null;
    if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
  }

  // kind: 'session' | 'workflow'. onSaved(entryFields) and onGone() are called by the caller's page.
  async function openShareModal({ kind = 'session', id, entry, onSaved, onGone }) {
    closeShareModal();
    let members;
    try {
      members = await loadTeam({ refresh: true });
    } catch (error) {
      throw Object.assign(new Error(tr('sharing.loadFailed', { error: error.message })), { userMessage: tr('sharing.loadFailed', { error: error.message }) });
    }
    const form = shareForm({ entry, members });
    const title = tr(kind === 'workflow' ? 'sharing.titleWorkflow' : 'sharing.title');
    const feedback = h('div', { class: 'settings-feedback error hidden', role: 'alert' });
    const cancel = h('button', { type: 'button', class: 'share-btn', text: tr('common.cancel') });
    const save = h('button', { type: 'button', class: 'share-btn primary', text: tr('sharing.save') });
    const close = h('button', { type: 'button', class: 'modal-close', title: tr('common.close'), 'aria-label': tr('common.close'), text: '×' });
    const titleId = `shareTitle${formCounter}`;
    const panel = h(
      'div',
      { class: 'modal-panel sharing-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'modal-head' }, h('h2', { id: titleId, text: title }), close),
      h('div', { class: 'modal-body' }, h('p', { class: 'settings-hint', text: tr('sharing.hint') }), form.element, feedback, h('div', { class: 'share-actions' }, cancel, save))
    );
    const backdrop = h('div', { class: 'modal share-modal' }, panel);
    const previous = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeShareModal();
      }
    };
    openModal = { backdrop, onKey, previous };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) closeShareModal();
    });
    close.addEventListener('click', closeShareModal);
    cancel.addEventListener('click', closeShareModal);
    save.addEventListener('click', async () => {
      feedback.classList.add('hidden');
      save.disabled = true;
      try {
        const fields = await saveSharing(kind, id, form.read());
        closeShareModal();
        if (onSaved) onSaved(fields);
      } catch (error) {
        if (error.gone) {
          closeShareModal();
          if (onGone) onGone();
          return;
        }
        feedback.textContent = error.userMessage || error.message;
        feedback.classList.remove('hidden');
        if (error.reloadTeam) loadTeam({ refresh: true }).catch(() => {});
      } finally {
        save.disabled = false;
      }
    });
    document.body.append(backdrop);
    form.focus();
  }

  global.OCAccess = {
    ready,
    me: currentMe,
    isActive,
    canAdminister,
    usernameOf,
    initialsOf,
    ownerName,
    badge,
    stateText,
    ownerChip,
    loadTeam,
    shareForm,
    saveSharing,
    sharingError,
    openShareModal,
    closeShareModal,
    request
  };
})(window);
