'use strict';

// Command palette of the node view (SPEC §12.4): centred overlay with search, category chips,
// keyboard navigation and an optional type filter (drag-to-empty: only nodes that can take the
// dragged port). Entries come from the registry; Higgsfield models are added dynamically.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const ui = OCD.ui;
  const { el } = ui;

  const MAX_RESULTS = 90;
  const HIGGSFIELD_SOURCES = [
    { type: 'image.higgsfield', source: 'higgsfield-image-models', kind: 'image' },
    { type: 'video.higgsfield', source: 'higgsfield-video-models', kind: 'video' }
  ];

  function createPalette({ host, getReg, onPick }) {
    let root = null;
    let previousFocus = null;
    let state = null;
    let unsubscribeOptions = null;

    function baseOf(type) {
      return graphLib.parseType(type)?.base || 'any';
    }

    function dots(ports) {
      const wrap = el('span', { class: 'nv-pal-dots' });
      for (const port of ports.filter((p) => !p.hidden).slice(0, 5)) {
        const parsed = graphLib.parseType(port.type);
        wrap.append(el('i', { class: `nv-pal-dot nv-port-${parsed?.base || 'any'} ${parsed?.list ? 'is-list' : ''}`.trim() }));
      }
      return wrap;
    }

    function buildEntries() {
      const reg = getReg();
      const entries = [];
      for (const def of reg.list) {
        entries.push({
          key: def.type,
          type: def.type,
          params: null,
          def,
          category: def.category,
          label: ui.typeLabel(def),
          search: [ui.typeLabel(def), def.label, ui.categoryLabel(def.category), ...(def.keywords || []), def.type].join(' ')
        });
      }
      // One palette entry per Higgsfield model (fetched from the catalogue when connected).
      for (const spec of HIGGSFIELD_SOURCES) {
        const def = reg.types.get(spec.type);
        if (!def) continue;
        const source = ui.optionsFor({ optionsSource: spec.source });
        for (const option of source.options) {
          if (!option.value) continue;
          entries.push({
            key: `${spec.type}:${option.value}`,
            type: spec.type,
            params: { model: option.value },
            def,
            category: 'higgsfield',
            label: option.label,
            model: true,
            search: [option.label, option.value, 'higgsfield', spec.kind, ui.categoryLabel('higgsfield')].join(' ')
          });
        }
      }
      return entries;
    }

    function visibleEntries() {
      const reg = getReg();
      let entries = state.entries;
      let compat = null;
      if (state.filter) {
        compat = new Map(graphLib.compatibleTargets(reg, state.filter.dir, state.filter.type).map((item) => [item.type, item]));
        entries = entries.filter((entry) => compat.has(entry.type));
      }
      if (state.category !== 'all') entries = entries.filter((entry) => entry.category === state.category);
      const query = state.query.trim();
      const categoryOrder = new Map(reg.categories.map((category, index) => [category, index]));
      const scored = entries
        .map((entry) => {
          const match = graphLib.fuzzyScore(query, entry.search);
          const rank = compat ? compat.get(entry.type).rank : 0;
          return { entry, score: match, rank };
        })
        .filter((item) => item.score > 0);
      scored.sort((a, b) => {
        if (query) return b.score - a.score || b.rank - a.rank || a.entry.label.localeCompare(b.entry.label);
        if (compat && b.rank !== a.rank) return b.rank - a.rank;
        const ca = categoryOrder.get(a.entry.category) ?? 99;
        const cb = categoryOrder.get(b.entry.category) ?? 99;
        return ca - cb || Number(Boolean(a.entry.model)) - Number(Boolean(b.entry.model)) || a.entry.label.localeCompare(b.entry.label);
      });
      return scored.slice(0, MAX_RESULTS).map((item) => ({ ...item.entry, compat: compat ? compat.get(item.entry.type) : null }));
    }

    function renderChips() {
      const reg = getReg();
      state.chips.textContent = '';
      const make = (value, label) => {
        const chip = el('button', { type: 'button', class: `nv-chip ${state.category === value ? 'is-active' : ''}`.trim(), text: label, tabindex: '-1', 'data-cat': value });
        chip.addEventListener('mousedown', (event) => event.preventDefault());
        chip.addEventListener('click', () => {
          state.category = value;
          state.index = 0;
          renderChips();
          renderList();
          state.input.focus();
        });
        state.chips.append(chip);
      };
      make('all', ui.T('nodes.palette.all'));
      const present = new Set(state.entries.map((entry) => entry.category));
      for (const category of reg.categories) if (present.has(category)) make(category, ui.categoryLabel(category));
    }

    function renderList() {
      const results = visibleEntries();
      state.results = results;
      if (state.index >= results.length) state.index = Math.max(0, results.length - 1);
      state.list.textContent = '';
      if (!results.length) {
        state.list.append(el('div', { class: 'nv-pal-empty', text: ui.T('nodes.palette.empty') }));
        return;
      }
      let lastCategory = null;
      results.forEach((entry, index) => {
        if (!state.query.trim() && entry.category !== lastCategory) {
          lastCategory = entry.category;
          state.list.append(el('div', { class: 'nv-pal-group', text: ui.categoryLabel(entry.category) }));
        }
        const def = entry.def;
        const row = el('div', {
          class: `nv-pal-item ${index === state.index ? 'is-active' : ''} ${def.available !== true ? 'is-unavailable' : ''}`.trim(),
          role: 'option',
          'aria-selected': index === state.index ? 'true' : 'false',
          dataset: { index: String(index), cat: entry.category }
        });
        const chip = el('span', { class: 'nv-pal-icon', dataset: { cat: entry.category } });
        chip.append(ui.categoryIcon(entry.category, 15));
        const text = el('span', { class: 'nv-pal-text' });
        text.append(el('span', { class: 'nv-pal-label', text: entry.label }));
        const meta = el('span', { class: 'nv-pal-meta' });
        meta.append(dots(def.inputs || []), el('i', { class: 'nv-pal-arrow', text: '→' }), dots(def.outputs || []));
        if (state.query.trim()) meta.append(el('span', { class: 'nv-pal-cat', text: ui.categoryLabel(entry.category) }));
        text.append(meta);
        row.append(chip, text);
        const tags = el('span', { class: 'nv-pal-tags' });
        if (entry.model) tags.append(el('span', { class: 'nv-badge', text: ui.T('nodes.palette.model') }));
        if (def.experimental) tags.append(el('span', { class: 'nv-badge is-experimental', text: ui.T('nodes.badge.experimental') }));
        if (def.paid) tags.append(el('span', { class: 'nv-badge is-paid', title: ui.T('nodes.badge.paidHint'), text: '$' }));
        if (def.available !== true) {
          tags.append(el('span', { class: 'nv-badge is-warn', title: typeof def.available === 'string' ? def.available : '', text: ui.T('nodes.palette.unavailable') }));
        }
        row.append(tags);
        row.addEventListener('mousemove', () => {
          if (state.index !== index) {
            state.index = index;
            paintActive();
          }
        });
        row.addEventListener('click', () => pick(index));
        state.list.append(row);
      });
    }

    function paintActive() {
      for (const row of state.list.querySelectorAll('.nv-pal-item')) {
        const active = Number(row.dataset.index) === state.index;
        row.classList.toggle('is-active', active);
        row.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) row.scrollIntoView({ block: 'nearest' });
      }
    }

    function pick(index) {
      const entry = state.results[index];
      if (!entry) return;
      const context = state.context;
      const filter = state.filter;
      close();
      onPick(entry, context, filter);
    }

    function onKey(event) {
      if (!state) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const n = state.results.length;
        if (n) state.index = (state.index + (event.key === 'ArrowDown' ? 1 : -1) + n) % n;
        paintActive();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        pick(state.index);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const reg = getReg();
        const cats = ['all', ...reg.categories.filter((c) => state.entries.some((entry) => entry.category === c))];
        const at = cats.indexOf(state.category);
        state.category = cats[(at + (event.shiftKey ? -1 : 1) + cats.length) % cats.length];
        state.index = 0;
        renderChips();
        renderList();
      }
    }

    function open({ filter = null, context = null } = {}) {
      if (state) close();
      previousFocus = document.activeElement;
      const reg = getReg();
      if (!reg) return;
      root = el('div', { class: 'nv-palette-backdrop' });
      const panel = el('div', { class: 'nv-palette', role: 'dialog', 'aria-label': ui.T('nodes.palette.title') });
      const input = el('input', {
        class: 'nv-pal-input',
        type: 'text',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': 'nvPaletteList',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: ui.T('nodes.palette.placeholder')
      });
      const head = el('div', { class: 'nv-pal-head' }, ui.icon('search', 16), input);
      const chips = el('div', { class: 'nv-pal-chips' });
      const list = el('div', { class: 'nv-pal-list', id: 'nvPaletteList', role: 'listbox' });
      const foot = el('div', { class: 'nv-pal-foot' });
      for (const [key, label] of [['↑↓', ui.T('nodes.palette.navigate')], ['↵', ui.T('nodes.palette.insert')], ['Tab', ui.T('nodes.palette.category')], ['Esc', ui.T('nodes.common.close')]]) {
        foot.append(el('span', {}, el('kbd', { class: 'nv-kbd', text: key }), ` ${label}`));
      }
      panel.append(head);
      if (filter) {
        const base = baseOf(filter.type);
        const banner = el('div', { class: 'nv-pal-filter' });
        banner.append(
          el('i', { class: `nv-pal-dot nv-port-${base}` }),
          el('span', { text: ui.T(filter.dir === 'out' ? 'nodes.palette.filterOut' : 'nodes.palette.filterIn', { type: ui.tr(`nodes.ptype.${base}`, base) }) })
        );
        panel.append(banner);
      }
      panel.append(chips, list, foot);
      root.append(panel);
      host.append(root);
      state = { input, chips, list, filter, context, query: '', category: 'all', index: 0, results: [], entries: buildEntries() };
      renderChips();
      renderList();
      input.addEventListener('input', () => {
        state.query = input.value;
        state.index = 0;
        renderList();
      });
      root.addEventListener('pointerdown', (event) => {
        if (event.target === root) close();
      });
      document.addEventListener('keydown', onKey, true);
      // Higgsfield model options arrive asynchronously: refresh the entry list when they land.
      unsubscribeOptions = ui.onOptionsChange((source) => {
        if (!state || !HIGGSFIELD_SOURCES.some((spec) => spec.source === source)) return;
        state.entries = buildEntries();
        renderChips();
        renderList();
      });
      input.focus();
    }

    function close() {
      if (!state) return;
      document.removeEventListener('keydown', onKey, true);
      if (unsubscribeOptions) unsubscribeOptions();
      unsubscribeOptions = null;
      const hadFocus = !document.activeElement || document.activeElement === document.body || root.contains(document.activeElement);
      root.remove();
      root = null;
      state = null;
      // give the keyboard back to where it was, so shortcuts keep working after the palette closes
      if (hadFocus && previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
      previousFocus = null;
    }

    return { open, close, isOpen: () => Boolean(state) };
  }

  OCD.palette = { createPalette };
})(window);
