'use strict';

// Command palette of the node view (SPEC §12.4): centred overlay with search, category chips,
// keyboard navigation and an optional type filter (drag-to-empty: only nodes that can take the
// dragged port). Entries come from the registry; Higgsfield models are added dynamically. Search and order live in
// graph.js (rankPaletteEntries): names, translated synonyms (nodes.type.<type>.keywords) and English keywords are
// searched, models never push nodes out of the list.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const ui = OCD.ui;
  const { el } = ui;

  // Nodes are all shown (there are fewer than this); the Higgsfield models have a list of their own. In their own chip
  // there is room for more of them, because that chip is the way to browse them.
  const MAX_NODES = 150;
  const MAX_MODELS = 30;
  const MAX_MODELS_IN_CHIP = 90;
  const MODEL_CATEGORY = 'higgsfield';
  const ANCHORED_WIDTH = 380;
  const ANCHORED_MAX_HEIGHT = 440;
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
      const text = { label: ui.typeLabel, keywords: ui.typeKeywords, categoryLabel: ui.categoryLabel };
      const entries = [];
      for (const def of reg.list) {
        // Not available for this account (participants and guests, marked by the server): no way in, no dead end.
        if (def.restricted === true) continue;
        entries.push(graphLib.paletteEntry(def, text));
      }
      // One palette entry per Higgsfield model (fetched from the catalogue when connected).
      for (const spec of HIGGSFIELD_SOURCES) {
        const def = reg.types.get(spec.type);
        if (!def || def.restricted === true) continue;
        const source = ui.optionsFor({ optionsSource: spec.source });
        for (const option of source.options) {
          if (!option.value) continue;
          entries.push(graphLib.paletteModelEntry(def, option, spec, text));
        }
      }
      return entries;
    }

    function visibleEntries() {
      return graphLib.rankPaletteEntries(getReg(), state.entries, {
        query: state.query,
        category: state.category,
        filter: state.filter,
        limit: MAX_NODES,
        modelLimit: state.category === MODEL_CATEGORY ? MAX_MODELS_IN_CHIP : MAX_MODELS
      });
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
      // The same test as the ranking: a text of only separators ("-", "  .") is no search.
      const searching = Boolean(graphLib.normalizeSearch(state.query));
      results.forEach((entry, index) => {
        if (!searching && entry.category !== lastCategory) {
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
        if (searching) meta.append(el('span', { class: 'nv-pal-cat', text: ui.categoryLabel(entry.category) }));
        text.append(meta);
        row.append(chip, text);
        const tags = el('span', { class: 'nv-pal-tags' });
        if (entry.model) tags.append(el('span', { class: 'nv-badge', text: ui.T('nodes.palette.model') }));
        if (def.experimental) tags.append(el('span', { class: 'nv-badge is-experimental', text: ui.T('nodes.badge.experimental') }));
        if (def.paid) tags.append(el('span', { class: 'nv-badge is-paid', title: ui.T('nodes.badge.paidHint'), text: '$' }));
        if (def.available !== true) {
          tags.append(el('span', { class: 'nv-badge is-warn', title: typeof def.available === 'string' ? ui.availabilityReason(def.available) : '', text: ui.T('nodes.palette.unavailable') }));
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
      // Models that did not fit: say so, and where the rest is (not an entry, the keyboard skips it).
      if (results.hiddenModels > 0) {
        const key = state.category === MODEL_CATEGORY ? 'nodes.palette.moreModelsSearch' : 'nodes.palette.moreModels';
        state.list.append(el('div', { class: 'nv-pal-more', text: ui.T(key, { count: results.hiddenModels }) }));
      }
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

    // Anchored mode (drag to empty canvas): a compact popover at the release point instead of the centred overlay.
    function placeAnchored(panel, at) {
      const bounds = root.getBoundingClientRect();
      const width = Math.min(ANCHORED_WIDTH, Math.max(240, bounds.width - 16));
      const height = Math.min(ANCHORED_MAX_HEIGHT, Math.max(200, bounds.height - 16));
      const left = Math.min(Math.max(at.x - bounds.left, 8), Math.max(8, bounds.width - width - 8));
      const top = Math.min(Math.max(at.y - bounds.top, 8), Math.max(8, bounds.height - height - 8));
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${height}px`;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    }

    function open({ filter = null, context = null, at = null } = {}) {
      if (state) close();
      previousFocus = document.activeElement;
      const reg = getReg();
      if (!reg) return;
      const anchored = Boolean(filter && at && Number.isFinite(at.x) && Number.isFinite(at.y));
      root = el('div', { class: `nv-palette-backdrop ${anchored ? 'is-anchored' : ''}`.trim() });
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
        const line = el('span', { class: 'nv-pal-filter-text', text: ui.T(filter.dir === 'out' ? 'nodes.palette.filterOut' : 'nodes.palette.filterIn', { type: ui.tr(`nodes.ptype.${base}`, base) }) });
        // Dragged from a multi-input of a media type: say how several files are handed over.
        if (filter.multiple && filter.dir === 'in' && ['image', 'video', 'audio'].includes(base)) {
          line.append(el('span', { class: 'nv-pal-filter-hint', text: ui.T('nodes.palette.filterMulti') }));
        }
        banner.append(el('i', { class: `nv-pal-dot nv-port-${base}` }), line);
        panel.append(banner);
      }
      panel.append(chips, list, foot);
      root.append(panel);
      host.append(root);
      if (anchored) placeAnchored(panel, at);
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

    // The registry or the model lists changed under an open palette (a node became available, Higgsfield got
    // connected in another tab): rebuild the entries, keep search text and chip.
    function refresh() {
      if (!state || !getReg()) return;
      state.entries = buildEntries();
      renderChips();
      renderList();
    }

    return { open, close, refresh, isOpen: () => Boolean(state) };
  }

  OCD.palette = { createPalette };
})(window);
