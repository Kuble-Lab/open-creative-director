'use strict';

// Shared frame of the two views (chat header in app.js, node view in nodes/main.js): the menu behind the
// avatar (or, in the local mode, behind the "more" icon) with costs, settings, help, monitoring, language and
// sign-out. One place, one look, the same items in both views.
//
//   OCShell.register({ openCosts, openSettings, settingsAvailable, costsText })   the chat page tells the shell what the items do
//   OCShell.addSection(name, builder)                           extend the menu; name: 'workspace' | 'account' | 'system'
//                                                               builder(ctx) returns an array of items (or nothing)
//                                                               item: { id, label, value, href, external, onSelect }
//   OCShell.accountMenu({ variant })                            -> { element, render, close }
//   OCShell.refresh()                                           re-render every menu (language, costs, sign-in state)
//
// The section 'account' is the place for the team entries of the teams interface (public/teams-ui.js registers
// "Teams" for admins there); its items appear below the costs. For participants and guests the menu shows the
// budget block (what is left, what was used since the budget started, the teams) and no costs line. Everything that comes from the server is written as text, never as HTML.
(function (global) {
  const tr = (key, vars) => (typeof global.t === 'function' ? global.t(key, vars) : key);
  const actions = { openCosts: null, openSettings: null, settingsAvailable: null, costsText: null };
  const sections = { workspace: [], account: [], system: [] };
  const menus = new Set();
  let counter = 0;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function svgIcon(paths, size = 16, strokeWidth = 1.8) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', String(strokeWidth));
      path.setAttribute('stroke-linecap', 'round');
      svg.append(path);
    }
    return svg;
  }

  const access = () => global.OCAccess;
  const me = () => (access() ? access().me() : { active: false, isAdmin: true, isSuperAdmin: false, logoutUrl: null });

  function register(next) {
    Object.assign(actions, next || {});
    refresh();
  }

  function addSection(name, builder) {
    if (!sections[name] || typeof builder !== 'function') return;
    sections[name].push(builder);
    refresh();
  }

  function roleLabel(info) {
    if (info.role === 'superadmin') return tr('account.roleSuperadmin');
    if (info.role === 'admin') return tr('account.roleAdmin');
    if (info.role === 'user') return tr('account.roleUser');
    if (info.role === 'participant') return tr('account.roleParticipant');
    if (info.role === 'guest') return tr('account.roleGuest');
    return tr('account.roleAnonymous');
  }

  // Participants and guests: what is left of the budget, as text and as a bar, and their teams.
  function budgetBlock(info) {
    if (!info.active || !info.restricted || !info.budget || !access()) return null;
    const lines = access().budgetLines(info.budget);
    const fmt = access().formatUsd;
    const block = h('div', { class: `account-budget${lines.exhausted ? ' is-exhausted' : lines.low ? ' is-low' : ''}`, 'data-budget': lines.exhausted ? 'exhausted' : lines.low ? 'low' : 'ok' });
    block.append(h('div', { class: 'account-budget-row' }, h('span', { text: tr('budget.menuLabel') }), h('strong', { text: fmt(lines.remaining) })));
    if (info.role === 'guest') {
      block.append(h('div', { class: 'account-budget-note', text: tr('budget.guestNote') }));
    } else {
      const bar = h('div', { class: 'account-budget-bar', role: 'progressbar', 'aria-label': tr('budget.menuLabel'), 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(lines.limit * 100) / 100), 'aria-valuenow': String(Math.round(lines.remaining * 100) / 100) });
      bar.append(h('span', { style: `width:${Math.round(lines.fraction * 100)}%` }));
      block.append(bar);
      const detail = [tr('budget.menuOf', { limit: fmt(lines.limit), spent: fmt(info.budget.spentUsd) })];
      if (info.budget.reservedUsd >= 0.005) detail.push(tr('budget.menuReserved', { reserved: fmt(info.budget.reservedUsd) }));
      block.append(h('div', { class: 'account-budget-note', text: detail.join(' · ') }));
      if (lines.exhausted) block.append(h('div', { class: 'account-budget-note strong', text: tr('budget.menuExhausted') }));
    }
    if (info.teams.length) block.append(h('div', { class: 'account-budget-teams', text: tr('budget.menuTeams', { teams: info.teams.map((entry) => entry.name).join(', ') }) }));
    return block;
  }

  function collect(name, ctx) {
    const items = [];
    for (const builder of sections[name]) {
      try {
        for (const item of builder(ctx) || []) if (item) items.push(item);
      } catch (_) {
        /* one broken extension never breaks the menu */
      }
    }
    return items;
  }

  function builtIn(ctx) {
    const info = ctx.me;
    const account = [];
    // Participants and guests see what they have used in the budget block (since the start of their budget). A second
    // line with the costs of the calendar month would show a different number for the same thing, so it stays out.
    if (!(info.active && info.restricted)) {
      account.push({
        id: 'costs',
        label: tr(info.active ? 'account.costsMonth' : 'menu.costs'),
        value: actions.costsText ? actions.costsText() : '',
        title: tr('account.costsOpen'),
        onSelect: actions.openCosts
      });
    }
    const system = [];
    if (actions.openSettings && (!info.active || info.isAdmin) && (!actions.settingsAvailable || actions.settingsAvailable())) {
      system.push({ id: 'settings', label: tr('menu.settings'), onSelect: actions.openSettings });
    }
    system.push({ id: 'help', label: tr('menu.help'), title: tr('menu.helpTitle'), href: 'help.html', external: true });
    if (info.isSuperAdmin) system.push({ id: 'monitoring', label: tr('account.monitoring'), href: 'monitoring.html' });
    return { account, system };
  }

  function createAccountMenu({ variant = 'chat' } = {}) {
    counter += 1;
    const id = `accountDropdown${counter}`;
    const root = h('div', { class: 'account-menu', 'data-variant': variant });
    const button = h('button', { type: 'button', class: 'account-chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id });
    if (variant === 'chat') button.id = 'accountBtn';
    const dropdown = h('div', { class: 'account-dropdown hidden', id, role: 'menu' });
    root.append(button, dropdown);

    const entry = { element: root, render, close: () => setOpen(false), button, dropdown };

    function isOpen() {
      return !dropdown.classList.contains('hidden');
    }

    function setOpen(open, { focus = false } = {}) {
      const next = Boolean(open);
      if (next === isOpen()) return;
      if (next) render();
      dropdown.classList.toggle('hidden', !next);
      button.setAttribute('aria-expanded', String(next));
      if (next && focus) {
        const first = dropdown.querySelector('[role="menuitem"]');
        if (first) first.focus();
      }
    }

    function itemNode(item) {
      const label = h('span', { class: 'account-item-label', text: item.label });
      const value = item.value ? h('strong', { text: item.value }) : null;
      const node = item.href
        ? h('a', { class: 'account-dropdown-item', role: 'menuitem', href: item.href, target: item.external ? '_blank' : null, rel: item.external ? 'noopener' : null }, label, value)
        : h('button', { class: 'account-dropdown-item', type: 'button', role: 'menuitem', disabled: item.disabled }, label, value);
      if (item.id) node.dataset.item = item.id;
      if (item.title) node.title = item.title;
      node.addEventListener('click', () => {
        setOpen(false);
        if (typeof item.onSelect === 'function') item.onSelect();
      });
      return node;
    }

    function separator() {
      return h('div', { class: 'account-dropdown-sep', role: 'separator' });
    }

    function render() {
      const info = me();
      const ctx = { me: info, variant };
      const base = builtIn(ctx);
      // The trigger: initials when somebody is signed in, the "more" icon in the local mode.
      button.textContent = '';
      let label;
      if (info.active) {
        button.append(info.email && access() ? access().initialsOf(info.email) : '?');
        label = info.email ? tr('account.signedInAs', { email: info.email }) : tr('account.roleAnonymous');
        button.classList.remove('is-local');
      } else {
        button.append(svgIcon(['M12 5.5h.01', 'M12 12h.01', 'M12 18.5h.01'], 18, 3));
        label = tr('menu.trigger');
        button.classList.add('is-local');
      }
      button.title = label;
      button.setAttribute('aria-label', label);

      const groups = [];
      const head = [];
      if (info.active) {
        head.push(
          h('div', { class: 'account-dropdown-head' }, h('div', { class: 'account-dropdown-email', id: variant === 'chat' ? 'accountEmail' : null, text: info.email || tr('account.roleAnonymous') }), h('span', { class: `account-role${info.isAdmin ? ' admin' : ''}`, id: variant === 'chat' ? 'accountRole' : null, text: roleLabel(info) }))
        );
        if (!info.identified) head.push(h('div', { class: 'account-dropdown-note', text: tr('account.anonymousHint') }));
        else if (info.role === 'participant') head.push(h('div', { class: 'account-dropdown-note', text: tr('account.participantHint') }));
        else if (info.role === 'guest') head.push(h('div', { class: 'account-dropdown-note', text: tr('account.guestHint') }));
      }
      const budgetView = budgetBlock(info);
      if (budgetView) head.push(budgetView);
      const workspace = collect('workspace', ctx);
      const account = base.account.concat(collect('account', ctx));
      const system = base.system.concat(collect('system', ctx));
      for (const items of [workspace, account, system]) if (items.length) groups.push(items);

      const nodes = [...head];
      groups.forEach((items, index) => {
        if (index > 0 || head.length) nodes.push(separator());
        for (const item of items) nodes.push(itemNode(item));
      });
      if (info.logoutUrl) {
        nodes.push(separator());
        nodes.push(itemNode({ id: 'logout', label: tr('account.logout'), href: info.logoutUrl }));
      }
      // Language: one switch for both views.
      const current = typeof global.getLang === 'function' ? global.getLang() : 'de';
      const langs = h('div', { class: 'lang-switch', role: 'group', 'aria-label': tr('lang.selector') });
      ['de', 'en', 'es'].forEach((code, index) => {
        if (index > 0) langs.append(h('span', { 'aria-hidden': 'true', text: '|' }));
        const langButton = h('button', { type: 'button', 'data-lang': code, title: tr(`lang.${code}`), 'aria-label': tr(`lang.${code}`), 'aria-pressed': String(code === current), text: code.toUpperCase() });
        if (code === current) langButton.classList.add('active');
        langButton.addEventListener('click', (event) => {
          event.stopPropagation();
          if (typeof global.setLang === 'function') global.setLang(code);
        });
        langs.append(langButton);
      });
      nodes.push(separator());
      nodes.push(h('div', { class: 'account-dropdown-lang' }, h('span', { text: tr('menu.language') }), langs));
      dropdown.replaceChildren(...nodes);
    }

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setOpen(!isOpen(), { focus: event.detail === 0 });
    });
    dropdown.addEventListener('click', (event) => event.stopPropagation());
    dropdown.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [...dropdown.querySelectorAll('[role="menuitem"]')];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next].focus();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true, { focus: true });
      }
    });
    document.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) {
        setOpen(false);
        button.focus();
      }
    });

    menus.add(entry);
    render();
    return entry;
  }

  function refresh() {
    for (const menu of menus) menu.render();
  }

  global.OCShell = { register, addSection, accountMenu: createAccountMenu, refresh, closeAll: () => menus.forEach((menu) => menu.close()) };

  // The sign-in state arrives after the page has been built.
  if (global.OCAccess && global.OCAccess.ready) global.OCAccess.ready.then(refresh);
  // The budget changes with every paid action; the menu shows the current one.
  if (global.OCAccess && typeof global.OCAccess.onChange === 'function') global.OCAccess.onChange(refresh);
})(window);
