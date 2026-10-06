'use strict';

// Browser side of the grouping by team (server: lib/team-groups.js). Shared by the chat list (app.js) and the workflow
// list of the node view (nodes/workflow-list.js). The switch "Projects | Teams" exists for admins of the user
// management only; in the local mode and for everybody else nothing here is active and the lists look as they always did.
//
//   OCTeamGroups.available()        true for an admin with user management
//   OCTeamGroups.mode(view)         'projects' (default) or 'teams'; view is 'chats' or 'workflows'; always 'projects' unless available()
//   OCTeamGroups.setMode(view, m)   remembers the choice per view (localStorage, optional)
//   OCTeamGroups.isOpen(view, g)    is the group open? Active groups default to open, archived ones to closed
//   OCTeamGroups.setOpen(view, id, open)
//   OCTeamGroups.label(group)       team name, "Internal" for the group without a team
//   OCTeamGroups.counts(group, kind)  "12 chats · 3 people" (kind: 'chats' | 'workflows')
//   OCTeamGroups.ownerLabel(email)  { text, title } short owner name (part before the @, cut) with the address as title, or null
//   OCTeamGroups.switcher({ view, onChange })  { element, refresh } the segmented switch; buttons with aria-pressed
//   OCTeamGroups.sidebarTitleKey(view)  text key of the heading above the chat list ("Projects", or "Chats" in the team view)
//   OCTeamGroups.preserveFocus(root, rebuild)  runs rebuild() and puts the keyboard focus back on the element that had it
//   OCTeamGroups.groupWorkflows(list, heads)   the groups of the workflow list: counts, latest activity, order
//   OCTeamGroups.ownerGroups(workflows)  the subgroups of one team group, one per owner: count, latest activity, order
//   OCTeamGroups.createGroupPages({ fetchPage, pageSize, onChange })  per group: the chats read page by page; answers that
//                                   are out of date (the heads were read again meanwhile) are dropped and read anew
//   OCTeamGroups.coalesce(fn, delay)   fn at most once per delay, however often the returned function is called
//
// Everything that comes from the server is written as text (never as HTML). The browser storage is optional: every
// access is wrapped, the choices then only last for this visit.
(function (global) {
  const tr = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);
  const KEY_PREFIX = 'ocd.teamGroups.';
  const MAX_OWNER_CHARS = 24;
  const memory = { modes: {}, open: {} };

  function readStorage(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      global.localStorage.setItem(key, value);
    } catch (_) {
      /* The lists work without storage. */
    }
  }

  function available() {
    const access = global.OCAccess;
    return Boolean(access && access.isActive() && access.me().isAdmin);
  }

  function mode(view) {
    if (!available()) return 'projects';
    const value = memory.modes[view] !== undefined ? memory.modes[view] : readStorage(`${KEY_PREFIX}mode.${view}`);
    return value === 'teams' ? 'teams' : 'projects';
  }

  function setMode(view, next) {
    if (next !== 'projects' && next !== 'teams') return;
    memory.modes[view] = next;
    writeStorage(`${KEY_PREFIX}mode.${view}`, next);
  }

  function openStates(view) {
    if (!memory.open[view]) {
      let saved = {};
      try {
        const parsed = JSON.parse(readStorage(`${KEY_PREFIX}open.${view}`) || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
      } catch (_) {
        /* unreadable: start from the defaults */
      }
      memory.open[view] = Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'boolean'));
    }
    return memory.open[view];
  }

  function isOpen(view, group) {
    const saved = openStates(view)[group.id];
    return typeof saved === 'boolean' ? saved : !group.archived;
  }

  function setOpen(view, id, open) {
    openStates(view)[id] = Boolean(open);
    writeStorage(`${KEY_PREFIX}open.${view}`, JSON.stringify(openStates(view)));
  }

  function label(group) {
    if (!group || group.internal) return tr('teamGroups.noTeam');
    return group.name || group.id;
  }

  const plural = (count, one, many) => (count === 1 ? tr(one) : tr(many, { count }));

  function counts(group, kind) {
    const entries = kind === 'workflows' ? plural(group.count, 'teamGroups.workflowsOne', 'teamGroups.workflowsMany') : plural(group.count, 'teamGroups.chatsOne', 'teamGroups.chatsMany');
    return [entries, plural(group.people, 'teamGroups.peopleOne', 'teamGroups.peopleMany')].join(' · ');
  }

  // The name of the person: no names exist besides the addresses, so the part before the @; long ones are cut.
  function ownerLabel(email) {
    if (typeof email !== 'string' || !email.trim()) return null;
    const user = email.split('@')[0] || email;
    const characters = [...user];
    const text = characters.length > MAX_OWNER_CHARS ? `${characters.slice(0, MAX_OWNER_CHARS - 1).join('')}…` : user;
    return { text, title: email };
  }

  function switcher({ view, onChange } = {}) {
    const element = document.createElement('div');
    element.className = 'team-switch';
    element.setAttribute('role', 'group');
    const buttons = {};
    for (const key of ['projects', 'teams']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'team-switch-btn';
      button.dataset.mode = key;
      button.addEventListener('click', () => {
        if (mode(view) === key) return;
        setMode(view, key);
        refresh();
        if (typeof onChange === 'function') onChange(key);
      });
      buttons[key] = button;
      element.append(button);
    }
    function refresh() {
      element.setAttribute('aria-label', tr('teamGroups.switchLabel'));
      element.classList.toggle('hidden', !available());
      const current = mode(view);
      for (const [key, button] of Object.entries(buttons)) {
        button.textContent = tr(key === 'teams' ? 'teamGroups.teams' : 'teamGroups.projects');
        button.setAttribute('aria-pressed', String(key === current));
        button.classList.toggle('is-active', key === current);
      }
    }
    refresh();
    return { element, refresh };
  }

  // The heading above the chat list: "Projects" while the list is grouped by project, a neutral "Chats" by team.
  function sidebarTitleKey(view) {
    return mode(view) === 'teams' ? 'teamGroups.sidebarTitle' : 'sidebar.projects';
  }

  /* ----- keyboard focus across a rebuilt list ----- */

  // The lists are built anew after every change (open, close, load more). An element that carries data-focus-key is found
  // again by that key, so a keyboard user stays where they were. data-focus-fallback names the key to use when the
  // element is gone afterwards (a "load more" button that was the last page: the head of its group).
  function preserveFocus(root, rebuild) {
    const doc = (root && root.ownerDocument) || global.document;
    const active = doc ? doc.activeElement : null;
    const data = active && active !== root && root.contains(active) && active.dataset ? active.dataset : null;
    const keys = data ? [data.focusKey, data.focusFallback].filter(Boolean) : [];
    const result = rebuild();
    if (keys.length) {
      const nodes = [...root.querySelectorAll('[data-focus-key]')];
      for (const key of keys) {
        const target = nodes.find((node) => node.dataset.focusKey === key);
        if (target) {
          target.focus({ preventScroll: true });
          break;
        }
      }
    }
    return result;
  }

  /* ----- groups of the workflow list ----- */

  // `list`: workflows with `team` ({ id, name, archived } or null = internal). `heads`: the groups of the server (people).
  // Count and latest activity are taken from the list, so a workflow created or deleted in the meantime counts at once.
  // Order: active teams (latest activity first), archived teams, then internal.
  function groupWorkflows(list, heads) {
    const known = new Map((Array.isArray(heads) ? heads : []).map((group) => [group.id, group]));
    const map = new Map();
    for (const workflow of list) {
      const id = workflow.team ? workflow.team.id : 'none';
      if (!map.has(id)) {
        const head = known.get(id);
        map.set(id, {
          id,
          internal: id === 'none',
          name: workflow.team ? workflow.team.name : null,
          archived: Boolean(workflow.team && workflow.team.archived),
          people: head && Number.isInteger(head.people) ? head.people : 0,
          count: 0,
          lastActivity: '',
          workflows: []
        });
      }
      const group = map.get(id);
      group.workflows.push(workflow);
      group.count += 1;
      if (String(workflow.updatedAt || '') > group.lastActivity) group.lastActivity = String(workflow.updatedAt || '');
    }
    const rank = (group) => (group.internal ? 2 : group.archived ? 1 : 0);
    return [...map.values()].sort(
      (a, b) => rank(a) - rank(b) || b.lastActivity.localeCompare(a.lastActivity) || String(a.name || '').localeCompare(String(b.name || ''))
    );
  }

  // The subgroups of one team: one per owner (the person who created the workflows). Order: latest activity first, the
  // workflows without an owner last. The id is the address, or 'none'; it is also the key of the open state.
  function ownerGroups(workflows) {
    const map = new Map();
    for (const workflow of Array.isArray(workflows) ? workflows : []) {
      const owner = typeof workflow.owner === 'string' && workflow.owner.trim() ? workflow.owner.trim() : null;
      const id = owner ? owner.toLowerCase() : 'none';
      if (!map.has(id)) map.set(id, { id, owner, count: 0, lastActivity: '', workflows: [] });
      const group = map.get(id);
      group.workflows.push(workflow);
      group.count += 1;
      if (String(workflow.updatedAt || '') > group.lastActivity) group.lastActivity = String(workflow.updatedAt || '');
    }
    return [...map.values()].sort(
      (a, b) => Number(!a.owner) - Number(!b.owner) || b.lastActivity.localeCompare(a.lastActivity) || String(a.owner || '').localeCompare(String(b.owner || ''))
    );
  }

  /* ----- the chats of the groups, page by page ----- */

  // fetchPage(id, { offset, limit }) answers { sessions, total }. Every group keeps its own state. invalidate() is called when
  // the heads were read again: what each group shows stays until its new answer comes, but an answer to a request started
  // before is out of date (a chat may be new or gone) and is dropped; the group is then read again.
  function createGroupPages({ fetchPage, pageSize = 20, onChange } = {}) {
    const entries = new Map();
    const notify = () => {
      if (typeof onChange === 'function') onChange();
    };

    function entry(id) {
      if (!entries.has(id)) entries.set(id, { sessions: [], total: 0, loading: false, loaded: false, error: null, generation: 0 });
      return entries.get(id);
    }

    function invalidate(knownIds) {
      const known = new Set(knownIds);
      for (const id of [...entries.keys()]) if (!known.has(id)) entries.delete(id);
      for (const state of entries.values()) {
        state.generation += 1;
        state.loaded = false;
      }
    }

    async function load(id, { more = false } = {}) {
      const state = entry(id);
      if (state.loading) return;
      state.loading = true;
      state.error = null;
      const generation = state.generation;
      const offset = more ? state.sessions.length : 0;
      const limit = more ? pageSize : Math.min(100, Math.max(pageSize, state.sessions.length));
      try {
        const data = await fetchPage(id, { offset, limit });
        if (generation === state.generation) {
          const received = Array.isArray(data && data.sessions) ? data.sessions : [];
          const seen = new Set(state.sessions.map((session) => session.id));
          state.sessions = more ? state.sessions.concat(received.filter((session) => !seen.has(session.id))) : received;
          state.total = (data && data.total) || 0;
          state.loaded = true;
        }
      } catch (err) {
        if (generation === state.generation) {
          state.error = err && err.message ? err.message : String(err);
          state.loaded = true;
        }
      } finally {
        state.loading = false;
      }
      notify();
    }

    return { entry, invalidate, load, all: () => [...entries.values()] };
  }

  // fn runs at most once per `delay` ms however often the returned function is called (many groups answer at once).
  function coalesce(fn, delay = 40, timers = global) {
    let handle = null;
    return () => {
      if (handle !== null) return;
      handle = timers.setTimeout(() => {
        handle = null;
        fn();
      }, delay);
    };
  }

  global.OCTeamGroups = { available, mode, setMode, isOpen, setOpen, label, counts, ownerLabel, switcher, sidebarTitleKey, preserveFocus, groupWorkflows, ownerGroups, createGroupPages, coalesce };
})(window);
