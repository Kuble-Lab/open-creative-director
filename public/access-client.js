'use strict';

// Browser side of the user management (server: lib/access.js). Shared by the chat view (app.js) and the node
// view (nodes/*.js). Everything here is inactive unless GET /api/me says `active: true`, which is the case if and
// only if the server has AUTH_WHOAMI_URL. In the local mode the app looks and behaves as it always has.
//
//   OCAccess.ready            promise of the /api/me answer (never rejects)
//   OCAccess.me()             { active, identified, email, role, isAdmin, isSuperAdmin, logoutUrl, restricted, participant, teams, budget, loginUnconfirmed }
//   OCAccess.loginUnconfirmed()  true while the server could not confirm the login (401 LOGIN_UNCONFIRMED): the banner asks for a reload
//   OCAccess.renderLoginBanner() draws / removes that banner (also called when the language changes)
//   OCAccess.canAdminister()  local mode or admin: may use the admin-only parts of the interface
//   OCAccess.badge(entry)     shared badge of a list entry (team / number of people), or null
//   OCAccess.ownerName(entry) short owner name of somebody else's entry, or null
//   OCAccess.ownerChip(entry) breadcrumb element of somebody else's entry: initials, "von <name>", ADMIN badge, or null
//   OCAccess.shareForm(...)   the sharing form (used inside the chat modal and the node view dialog): private, all internal
//                             people, teams (participants: their own teams only) or selected people
//   OCAccess.refreshMe()      reads /api/me again (the budget of a participant changes with every paid action)
//   OCAccess.budget()         { limitUsd, spentUsd, reservedUsd, remainingUsd, since } of a participant or guest, else null
//   OCAccess.onChange(fn)     fn(me) runs whenever the identity or the budget was read again
//   OCAccess.accountRuleMessage(error)  readable text for a refused paid action (402) or feature (403), else null
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
    logoutUrl: null,
    restricted: false,
    participant: false,
    teams: Object.freeze([]),
    budget: null,
    loginUnconfirmed: false
  });

  let me = DEFAULT_ME;
  let unconfirmedSeen = false; // a request answered 401 LOGIN_UNCONFIRMED (after a start that was fine)
  let startedUnconfirmed = false; // the first /api/me already said so: nothing was loaded, a confirmed login reloads the page
  let loginBanner = null;
  let recheckTimer = null;
  let rechecks = 0;
  let team = null;
  let ownTeams = null;
  let formCounter = 0;
  const listeners = new Set();

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
      error.body = payload;
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

  function budgetOf(value) {
    if (!value || typeof value !== 'object') return null;
    const number = (input) => (typeof input === 'number' && Number.isFinite(input) ? input : 0);
    return Object.freeze({
      limitUsd: number(value.limitUsd),
      spentUsd: number(value.spentUsd),
      reservedUsd: number(value.reservedUsd),
      remainingUsd: number(value.remainingUsd),
      since: typeof value.since === 'string' ? value.since : null
    });
  }

  function meFrom(data) {
    const role = typeof data.role === 'string' ? data.role : 'anonymous';
    const restricted = role === 'participant' || role === 'guest';
    return Object.freeze({
      active: true,
      identified: Boolean(data.identified),
      email: typeof data.email === 'string' ? data.email : null,
      role,
      isAdmin: Boolean(data.isAdmin),
      isSuperAdmin: Boolean(data.isSuperAdmin),
      logoutUrl: typeof data.logoutUrl === 'string' && data.logoutUrl ? data.logoutUrl : null,
      restricted,
      participant: role === 'participant',
      teams: Object.freeze(Array.isArray(data.teams) ? data.teams.filter((entry) => entry && typeof entry.id === 'string').map((entry) => Object.freeze({ id: entry.id, name: String(entry.name || entry.id) })) : []),
      budget: restricted ? budgetOf(data.budget) : null,
      loginUnconfirmed: data.loginUnconfirmed === true
    });
  }

  function notify() {
    renderLoginBanner();
    for (const listener of [...listeners]) {
      try {
        listener(me);
      } catch (_) {
        /* one broken listener never blocks the others */
      }
    }
  }

  // Reads /api/me. A failure keeps what is known (the local mode has nothing to show).
  async function loadMe() {
    try {
      const data = await request('GET', '/api/me');
      if (data && typeof data === 'object' && data.active === true) me = meFrom(data);
    } catch (_) {
      /* the local mode (or an old server) has nothing to show */
    }
    return me;
  }

  /* ---------- unconfirmed login ---------- */

  // The login could not be confirmed (the server answers 401 LOGIN_UNCONFIRMED on every API route but /api/me and a
  // few public ones). One banner for both views with a button that reloads the page. No error message per request.
  const isUnconfirmed = () => Boolean(me.loginUnconfirmed || unconfirmedSeen);

  function renderLoginBanner() {
    if (typeof document === 'undefined' || !document.body) return;
    if (loginBanner) {
      loginBanner.remove();
      loginBanner = null;
    }
    if (!isUnconfirmed()) return;
    const reload = h('button', { type: 'button', class: 'login-banner-btn', text: tr('login.reload') });
    reload.addEventListener('click', () => global.location.reload());
    loginBanner = h('div', { class: 'login-banner', id: 'loginBanner', role: 'alert' }, h('span', { class: 'login-banner-text', text: tr('login.unconfirmed') }), reload);
    document.body.append(loginBanner);
  }

  // Looks at /api/me a few times: a short outage ends by itself. A page that started without any data reloads once the
  // login is confirmed; a page that was working just drops the banner.
  function scheduleRecheck() {
    if (recheckTimer || rechecks >= 6) return;
    recheckTimer = setTimeout(async () => {
      recheckTimer = null;
      rechecks += 1;
      let confirmed = false;
      try {
        const data = await request('GET', '/api/me');
        confirmed = Boolean(data && data.active === true && data.loginUnconfirmed !== true);
        if (confirmed) me = meFrom(data);
      } catch (_) {
        /* still unknown: try again later */
      }
      if (confirmed) {
        if (startedUnconfirmed) {
          global.location.reload();
          return;
        }
        unconfirmedSeen = false;
        rechecks = 0;
        notify();
        return;
      }
      if (isUnconfirmed()) scheduleRecheck();
    }, rechecks === 0 ? 4000 : 10000);
    if (recheckTimer && typeof recheckTimer.unref === 'function') recheckTimer.unref();
  }

  function markUnconfirmed() {
    if (!me.active && !unconfirmedSeen) {
      // The local mode never answers this; an old server neither. Only an active mode can be unconfirmed.
      return;
    }
    if (!unconfirmedSeen) {
      unconfirmedSeen = true;
      notify();
    }
    scheduleRecheck();
  }

  // Every API answer 401 LOGIN_UNCONFIRMED turns on the banner, wherever the request came from (chat, nodes, menu).
  if (typeof global.fetch === 'function' && !global.fetch.__ocUnconfirmed) {
    const nativeFetch = global.fetch.bind(global);
    const wrapped = async function (...args) {
      const response = await nativeFetch(...args);
      if (response && response.status === 401) {
        response
          .clone()
          .json()
          .then((payload) => {
            if (payload && payload.code === 'LOGIN_UNCONFIRMED') markUnconfirmed();
          })
          .catch(() => {});
      }
      return response;
    };
    wrapped.__ocUnconfirmed = true;
    global.fetch = wrapped;
  }

  const ready = loadMe().then((value) => {
    if (value.loginUnconfirmed) {
      startedUnconfirmed = true;
      scheduleRecheck();
    }
    renderLoginBanner();
    return value;
  });

  // The budget of a participant changes with every paid action: read it again and tell the listeners (the menu).
  async function refreshMe() {
    if (!me.active) return me;
    await loadMe();
    notify();
    return me;
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const currentMe = () => me;
  const isActive = () => me.active;
  const canAdminister = () => !me.active || me.isAdmin;
  const currentBudget = () => me.budget;

  /* ---------- money and account rules ---------- */

  function formatUsd(value) {
    const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return `$${number.toFixed(2)}`;
  }

  // "$12.40 left of $20.00" and friends. Rounds down what is left so that "$0.00" never shows for a sliver.
  function budgetLines(budget) {
    if (!budget) return null;
    const remaining = Math.max(0, budget.remainingUsd);
    const exhausted = remaining < 0.005;
    const limit = budget.limitUsd;
    const fraction = limit > 0 ? Math.min(1, Math.max(0, remaining / limit)) : 0;
    return { remaining, exhausted, low: !exhausted && limit > 0 && fraction <= 0.15, fraction, limit };
  }

  const FEATURES = ['gts', 'higgsfield', 'chatgpt', 'roles', 'context', 'models'];

  // A refused paid action (402) or a feature the account does not have (403) as a sentence in the interface language.
  // `error` is an Error of request()/api() (code, body) or an event of the chat stream ({ code, message }).
  function accountRuleMessage(error) {
    if (!error) return null;
    const code = error.code || (error.body && error.body.code);
    const body = error.body || error;
    if (code === 'BUDGET_EXHAUSTED') return tr('budget.exhausted');
    if (code === 'BUDGET_JOBS_OPEN') return tr('budget.jobsOpen');
    if (code === 'BUDGET_INSUFFICIENT') {
      const remaining = typeof body.remainingUsd === 'number' ? body.remainingUsd : me.budget ? me.budget.remainingUsd : 0;
      const estimate = typeof body.estimateUsd === 'number' ? body.estimateUsd : null;
      return estimate === null
        ? tr('budget.insufficientPlain', { remaining: formatUsd(remaining) })
        : tr('budget.insufficient', { remaining: formatUsd(remaining), estimate: formatUsd(estimate) });
    }
    if (code === 'FORBIDDEN_FOR_ROLE') {
      const feature = typeof body.feature === 'string' && FEATURES.includes(body.feature) ? tr(`role.feature.${body.feature}`) : '';
      return feature ? tr('role.forbiddenFeature', { feature }) : tr('role.forbidden');
    }
    return null;
  }

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
    if (entry.shareMode === 'teams') {
      const names = teamNames(entry);
      const count = Number.isInteger(entry.sharedTeamCount) ? entry.sharedTeamCount : names.length;
      if (count > 0) {
        const first = names[0] || tr('sharing.badgeTeams', { count });
        return { label: `👥 ${count > 1 && names.length ? `${first} +${count - 1}` : first}`, title: `${stateTeams(entry)}${foreign}` };
      }
    }
    if (entry.shareMode === 'specific') {
      const count = Number.isInteger(entry.sharedCount) ? entry.sharedCount : Array.isArray(entry.sharedWith) ? entry.sharedWith.length : 0;
      if (count > 0) return { label: `👥 ${count}`, title: `${tr('sharing.stateSpecific', { count })}${foreign}` };
    }
    return null;
  }

  function teamNames(entry) {
    return (Array.isArray(entry && entry.sharedTeams) ? entry.sharedTeams : []).map((team) => team && team.name).filter(Boolean);
  }

  function stateTeams(entry) {
    const names = teamNames(entry);
    const count = Number.isInteger(entry.sharedTeamCount) ? entry.sharedTeamCount : names.length;
    return names.length ? tr('sharing.stateTeams', { names: names.join(', ') }) : tr('sharing.stateTeamsCount', { count });
  }

  // Text of the share button tooltip: the current state.
  function stateText(entry) {
    if (!entry || entry.unowned) return tr('sharing.unownedHint');
    if (entry.shareMode === 'team') return tr('sharing.stateTeam');
    if (entry.shareMode === 'teams') return stateTeams(entry);
    if (entry.shareMode === 'specific') {
      const count = Number.isInteger(entry.sharedCount) ? entry.sharedCount : Array.isArray(entry.sharedWith) ? entry.sharedWith.length : 0;
      return tr('sharing.stateSpecific', { count });
    }
    return tr('sharing.statePrivate');
  }

  // Owner in the breadcrumb of the open chat or workflow: only in somebody else's entry (in your own the account
  // avatar already is you). Initials, "von <name>", and ADMIN as a text badge instead of a star.
  function ownerChip(entry) {
    if (!me.active || !entry || entry.unowned || !entry.owner || entry.mine !== false) return null;
    const title = [usernameOf(entry.owner), entry.ownerIsAdmin ? tr('account.roleAdmin') : '', tr('context.ownerOfChat')].filter(Boolean).join(' · ');
    const chip = h(
      'span',
      { class: 'owner-chip', title },
      h('span', { class: 'owner-chip-avatar', 'aria-hidden': 'true', text: initialsOf(entry.owner) }),
      h('span', { class: 'owner-chip-name', text: tr('context.ownerBy', { name: usernameOf(entry.owner) }) })
    );
    if (entry.ownerIsAdmin) chip.append(h('span', { class: 'owner-chip-admin', text: 'ADMIN' }));
    return chip;
  }

  /* ---------- team list ---------- */

  async function loadTeam({ refresh = false } = {}) {
    if (team && !refresh) return team;
    const data = await request('GET', '/api/team');
    team = Array.isArray(data.members) ? data.members : [];
    return team;
  }

  // The teams (trainings) the person may share with: participants their own, everybody else every active team.
  // Older servers do not know the route; then there are no teams to offer.
  async function loadOwnTeams({ refresh = false } = {}) {
    if (ownTeams && !refresh) return ownTeams;
    try {
      const data = await request('GET', '/api/teams/mine');
      ownTeams = Array.isArray(data.teams) ? data.teams.filter((entry) => entry && typeof entry.id === 'string') : [];
    } catch (_) {
      ownTeams = [];
    }
    return ownTeams;
  }

  /* ---------- sharing form ---------- */

  const MODES = [
    ['private', 'sharing.private', 'sharing.privateHint'],
    ['team', 'sharing.team', 'sharing.teamHint'],
    ['teams', 'sharing.teams', 'sharing.teamsHint'],
    ['specific', 'sharing.specific', 'sharing.specificHint']
  ];

  // Which modes the account may choose (the server enforces the same): participants share with their teams and the
  // people of those teams, never with "everybody internal"; a guest keeps everything private.
  function allowedModes(info = me) {
    if (info.role === 'guest') return ['private'];
    if (info.role === 'participant') return ['private', 'teams', 'specific'];
    return ['private', 'team', 'teams', 'specific'];
  }

  // The form for the sharing of one entry. `entry` carries the describe fields (owner, unowned, shareMode,
  // sharedWith and sharedTeams when the caller may see them). `members` is the team list, `teams` the teams to offer.
  // Returns { element, read(), focus() }.
  function shareForm({ entry, members, teams }) {
    formCounter += 1;
    const group = `share-mode-${formCounter}`;
    const unowned = !entry || entry.unowned === true;
    const offered = Array.isArray(teams) ? teams : [];
    // The mode of the entry stays visible even when the account could not pick it any more (an archived team).
    const shown = MODES.filter(([value]) => {
      if (!allowedModes().includes(value)) return value === (entry && entry.shareMode) && !unowned;
      return value !== 'teams' || offered.length > 0 || (entry && entry.shareMode === 'teams');
    });
    // An entry without an owner is visible to everybody today; "all internal" is the closest starting point.
    const fallback = shown.some(([value]) => value === 'team') ? 'team' : 'private';
    const initialMode = unowned ? fallback : shown.some(([value]) => value === entry.shareMode) ? entry.shareMode : 'private';
    const selected = new Set(Array.isArray(entry && entry.sharedWith) ? entry.sharedWith : []);
    const selectedTeams = new Set((Array.isArray(entry && entry.sharedTeams) ? entry.sharedTeams : []).map((item) => item && item.id).filter(Boolean));
    // The owner (or, for an entry without owner, the acting admin who becomes owner) never needs to be picked.
    const skip = unowned ? me.email : entry.owner;
    const people = (members || []).filter((member) => member.email !== skip);
    for (const email of selected) {
      if (email !== skip && !people.some((member) => member.email === email)) people.push({ email, role: 'user', me: false });
    }
    const groups = offered.map((item) => ({ id: item.id, name: item.name || item.id, memberCount: item.memberCount }));
    for (const item of Array.isArray(entry && entry.sharedTeams) ? entry.sharedTeams : []) {
      if (item && item.id && !groups.some((known) => known.id === item.id)) groups.push({ id: item.id, name: item.name || item.id, memberCount: null });
    }

    const radios = [];
    const modes = h('fieldset', { class: 'share-modes' }, h('legend', { class: 'share-legend', text: tr('sharing.modes') }));
    for (const [value, labelKey, hintKey] of shown) {
      const input = h('input', { type: 'radio', name: group, value });
      input.checked = value === initialMode;
      input.addEventListener('change', renderPeople);
      radios.push(input);
      modes.append(
        h('label', { class: 'share-mode' }, input, h('span', { class: 'share-mode-copy' }, h('span', { class: 'share-mode-name', text: tr(labelKey) }), h('span', { class: 'share-mode-hint', text: tr(hintKey) })))
      );
    }
    const list = h('div', { class: 'share-people', role: 'group', 'aria-label': tr('sharing.people') });
    const teamList = h('div', { class: 'share-people share-teams', role: 'group', 'aria-label': tr('sharing.teamsList') });
    const element = h('div', { class: 'share-form' });
    if (unowned) element.append(h('p', { class: 'share-note', text: tr('sharing.hintUnowned') }));
    if (me.role === 'guest') element.append(h('p', { class: 'share-note', text: tr('sharing.guestNote') }));
    element.append(modes, teamList, list);

    const mode = () => (radios.find((radio) => radio.checked) || {}).value || 'private';

    function renderPeople() {
      // Keep what was ticked while the lists are redrawn.
      for (const box of list.querySelectorAll('input[type="checkbox"]')) {
        if (box.checked) selected.add(box.value);
        else selected.delete(box.value);
      }
      for (const box of teamList.querySelectorAll('input[type="checkbox"]')) {
        if (box.checked) selectedTeams.add(box.value);
        else selectedTeams.delete(box.value);
      }
      list.textContent = '';
      teamList.textContent = '';
      list.classList.toggle('hidden', mode() !== 'specific');
      teamList.classList.toggle('hidden', mode() !== 'teams');
      if (mode() === 'teams') {
        if (!groups.length) teamList.append(h('p', { class: 'share-empty', text: tr('sharing.noTeams') }));
        for (const item of groups) {
          const box = h('input', { type: 'checkbox', value: item.id });
          box.checked = selectedTeams.has(item.id);
          const count = Number.isInteger(item.memberCount) ? tr('sharing.teamPeople', { count: item.memberCount }) : '';
          teamList.append(h('label', { class: 'share-person' }, box, h('span', { class: 'share-person-mail', text: item.name }), h('small', { class: 'share-person-role', text: count })));
        }
      }
      if (mode() !== 'specific') return;
      if (!people.length) {
        list.append(h('p', { class: 'share-empty', text: tr(me.role === 'participant' ? 'sharing.noTeammates' : 'sharing.noMembers') }));
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
      const value = { shareMode, sharedWith: shareMode === 'specific' ? [...selected].filter((email) => people.some((person) => person.email === email)) : [] };
      if (shareMode === 'teams') value.sharedTeams = [...selectedTeams].filter((id) => groups.some((item) => item.id === id));
      return value;
    }

    return { element, read, focus: () => (radios.find((radio) => radio.checked) || radios[0]).focus() };
  }

  // Human readable message for a failed sharing request (and whether the entry vanished for the caller).
  function sharingError(error) {
    if (error && error.status === 404) return { message: tr('sharing.gone'), gone: true };
    if (error && error.status === 403) return { message: tr('sharing.forbidden') };
    if (error && error.code === 'UNKNOWN_TEAM_MEMBERS') return { message: tr('sharing.unknownMembers'), reloadTeam: true };
    if (error && error.code === 'UNKNOWN_TEAMS') return { message: tr('sharing.unknownTeams'), reloadTeams: true };
    if (error && error.code === 'SHARE_MODE_FORBIDDEN') return { message: tr('sharing.modeForbidden') };
    return { message: tr('sharing.saveFailed', { error: error && error.message ? error.message : '' }) };
  }

  // Saves the sharing. Resolves the updated entry fields (`session` / `workflow` of the answer), rejects with an
  // Error that carries `userMessage`, `gone`, `reloadTeam` and `reloadTeams`.
  async function saveSharing(kind, id, value) {
    if (value.shareMode === 'specific' && !value.sharedWith.length) {
      const error = new Error('empty selection');
      error.userMessage = tr('sharing.selectOne');
      throw error;
    }
    if (value.shareMode === 'teams' && !(value.sharedTeams && value.sharedTeams.length)) {
      const error = new Error('empty selection');
      error.userMessage = tr('sharing.selectTeam');
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
      error.reloadTeams = Boolean(info.reloadTeams);
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
    let teams;
    try {
      [members, teams] = await Promise.all([loadTeam({ refresh: true }), allowedModes().includes('teams') ? loadOwnTeams({ refresh: true }) : []]);
    } catch (error) {
      throw Object.assign(new Error(tr('sharing.loadFailed', { error: error.message })), { userMessage: tr('sharing.loadFailed', { error: error.message }) });
    }
    const form = shareForm({ entry, members, teams });
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
        if (error.reloadTeams) loadOwnTeams({ refresh: true }).catch(() => {});
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
    loadOwnTeams,
    allowedModes,
    budget: currentBudget,
    budgetLines,
    formatUsd,
    accountRuleMessage,
    refreshMe,
    loginUnconfirmed: isUnconfirmed,
    renderLoginBanner,
    onChange,
    shareForm,
    saveSharing,
    sharingError,
    openShareModal,
    closeShareModal,
    request
  };
})(window);
