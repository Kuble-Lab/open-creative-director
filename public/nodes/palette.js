'use strict';

// Command palette of the node view (SPEC §12.4): centred overlay with search, category chips,
// keyboard navigation and an optional type filter (drag-to-empty: only nodes that can take the
// dragged port). Entries come from the registry; Higgsfield models are added dynamically. Search and order live in
// graph.js (rankPaletteEntries): names, translated synonyms (nodes.type.<type>.keywords) and English keywords are
// searched, models never push nodes out of the list. The "Templates" chip (not while a port is dragged) lists the
// starter templates instead of nodes; picking one inserts it into the open workflow (onPickTemplate).
// Help (node-help.js): on a wide window a detail area next to the list explains the highlighted entry (keyboard or
// hover), on a narrow one a "?" button on the row opens the same help as a sheet over the list. Shift+Enter inserts the
// highlighted node together with a node in front of each required input.
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
  const TEMPLATE_CATEGORY = 'templates';
  const ANCHORED_WIDTH = 380;
  const ANCHORED_MAX_HEIGHT = 440;
  // From this width of the node view on the palette gets a detail area (help of the highlighted entry) beside the list.
  const DETAIL_MIN_VIEW = 900;
  const DETAIL_WIDTH = 330;
  const HIGGSFIELD_SOURCES = [
    { type: 'image.higgsfield', source: 'higgsfield-image-models', kind: 'image' },
    { type: 'video.higgsfield', source: 'higgsfield-video-models', kind: 'video' }
  ];

  function createPalette({ host, getReg, onPick, getTemplates = null, onPickTemplate = null, help = null, onPickWithInputs = null }) {
    let root = null;
    let previousFocus = null;
    let state = null;
    let unsubscribeOptions = null;

    function baseOf(type) {
      return graphLib.parseType(type)?.base || 'any';
    }

    // Translated name of a node type, for the node names a template is searched by.
    function typeLabelOf(type) {
      const def = getReg() && getReg().types.get(type);
      return def ? ui.typeLabel(def) : type;
    }

    function hasTemplates() {
      return Boolean(getTemplates && onPickTemplate && state && !state.filter);
    }

    // Is there room for the detail area beside the list?
    function isWide() {
      return Boolean(root) && root.clientWidth >= DETAIL_MIN_VIEW;
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

    /* ----- help: detail area (wide) and sheet (narrow) ----- */

    // "?" on a row: on a wide window it highlights the row (the detail area shows it), on a narrow one it opens the sheet.
    function helpButton(index) {
      const button = el('button', { type: 'button', class: 'nv-pal-help', tabindex: '-1', title: ui.T('nodes.help.open'), 'aria-label': ui.T('nodes.help.open') }, ui.icon('help', 13));
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        state.index = index;
        paintActive();
        if (isWide()) paintDetail();
        else openSheet();
        state.input.focus();
      });
      return button;
    }

    // Summary of a template in the detail area: the same reading line and cost as its gallery card.
    function templateDetail(template) {
      const box = el('div', { class: 'nv-help' });
      const flow = OCD.templatesUi.flowText(template, typeLabelOf);
      const cost = OCD.templatesUi.costInfo(template);
      box.append(el('p', { class: 'nv-help-what', text: template.description }));
      if (flow) box.append(el('div', { class: 'nv-help-block' }, el('span', { class: 'nv-help-label', text: ui.T('nodes.template.flowLabel') }), el('p', { text: flow })));
      box.append(el('div', { class: 'nv-help-block' }, el('span', { class: 'nv-help-label', text: ui.T('nodes.help.cost') }), el('p', { class: `nv-help-cost is-${cost.kind}`, text: cost.text })));
      if (!template.available) box.append(el('div', { class: 'nv-notice is-warn' }, ui.icon('warning', 14), el('span', { class: 'nv-notice-text', text: ui.T('nodes.template.unavailableNote', { missing: OCD.templatesUi.missingText(template) }) })));
      return box;
    }

    // The detail area follows the highlighted entry. Cheap: one small tree per entry, nothing while the entry stays.
    function paintDetail() {
      if (!state || !help || !state.detail) return;
      if (!state.sheet && !state.panel.classList.contains('has-detail')) return;
      const entry = state.results[state.index];
      const key = entry ? (entry.kind === 'template' ? `t:${entry.template.id}` : `n:${entry.key || entry.type}`) : '';
      if (state.detailKey === key && state.detail.body.firstChild) return;
      state.detailKey = key;
      state.detail.body.textContent = '';
      state.detail.head.textContent = '';
      if (!entry) return;
      if (entry.kind === 'template') {
        state.detail.head.append(el('span', { class: 'nv-pal-icon', dataset: { cat: 'template' } }, ui.icon('template', 15)), el('span', { class: 'nv-pal-detail-title', text: entry.template.name }));
        state.detail.body.append(templateDetail(entry.template));
        return;
      }
      const def = entry.def;
      const chip = el('span', { class: 'nv-pal-icon', dataset: { cat: entry.category } });
      chip.append(ui.categoryIcon(entry.category, 15));
      state.detail.head.append(chip, el('span', { class: 'nv-pal-detail-title', text: entry.label }), el('span', { class: 'nv-pal-cat', text: def ? ui.categoryLabel(entry.category) : '' }));
      state.detail.body.append(help.render(entry.type, { onDone: close, world: state.context && state.context.world, withInputs: !state.filter, templates: !state.filter }));
    }

    let detailFrame = 0;
    function scheduleDetail() {
      if (!help || !state || !state.detail || detailFrame) return;
      detailFrame = requestAnimationFrame(() => {
        detailFrame = 0;
        paintDetail();
      });
    }

    function openSheet() {
      if (!state || !state.detail) return;
      state.sheet = true;
      state.detailKey = '';
      state.detail.root.classList.add('is-sheet');
      state.panel.classList.add('has-sheet');
      paintDetail();
    }

    function closeSheet() {
      if (!state || !state.detail) return;
      state.sheet = false;
      state.detail.root.classList.remove('is-sheet');
      state.panel.classList.remove('has-sheet');
    }

    // The window was resized under an open palette: detail area or sheet, whichever fits.
    function relayout() {
      if (!state) return;
      const wide = isWide();
      state.panel.classList.toggle('has-detail', wide);
      if (wide) closeSheet();
      if (state.anchoredAt) placeAnchored(state.panel, state.anchoredAt);
      scheduleDetail();
    }

    function renderChips() {
      const reg = getReg();
      state.chips.textContent = '';
      state.input.placeholder = ui.T(state.category === TEMPLATE_CATEGORY ? 'nodes.template.search' : 'nodes.palette.placeholder');
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
      // Right after "All": at the end of the row it would hide behind the scrolling chips.
      if (hasTemplates()) make(TEMPLATE_CATEGORY, ui.T('nodes.template.galleryTitle'));
      const present = new Set(state.entries.map((entry) => entry.category));
      for (const category of reg.categories) if (present.has(category)) make(category, ui.categoryLabel(category));
    }

    // Templates start loading when the palette opens; the tab shows what has arrived.
    function loadTemplates() {
      if (!hasTemplates() || state.templates !== null || state.templatesLoading) return;
      const current = state;
      current.templatesLoading = true;
      Promise.resolve()
        .then(() => getTemplates())
        .then((list) => {
          current.templates = Array.isArray(list) ? list : [];
        })
        .catch((error) => {
          current.templates = [];
          current.templatesError = error && error.message ? error.message : String(error);
        })
        .finally(() => {
          current.templatesLoading = false;
          if (state === current && current.category === TEMPLATE_CATEGORY) renderList();
        });
    }

    // The rows of the "Templates" tab: name, description, size and what is missing on this server.
    function renderTemplateRows() {
      state.list.textContent = '';
      if (state.templates === null) {
        state.results = [];
        state.list.append(el('div', { class: 'nv-pal-empty', text: ui.T('nodes.template.paletteLoading') }));
        scheduleDetail();
        return;
      }
      const found = OCD.templatesUi.rank(state.templates, state.query, typeLabelOf).map((template) => ({ kind: 'template', template }));
      state.results = found;
      if (state.index >= found.length) state.index = Math.max(0, found.length - 1);
      if (!found.length) {
        state.list.append(el('div', { class: 'nv-pal-empty', text: state.templatesError ? ui.T('nodes.template.loadFailed', { error: state.templatesError }) : ui.T('nodes.template.paletteEmpty') }));
        scheduleDetail();
        return;
      }
      found.forEach(({ template }, index) => {
        const row = el('div', {
          class: `nv-pal-item is-template ${index === state.index ? 'is-active' : ''}`.trim(),
          role: 'option',
          'aria-selected': index === state.index ? 'true' : 'false',
          dataset: { index: String(index), cat: 'template' }
        });
        const chip = el('span', { class: 'nv-pal-icon', dataset: { cat: 'template' } }, ui.icon('template', 15));
        const text = el('span', { class: 'nv-pal-text' }, el('span', { class: 'nv-pal-label', text: template.name }), el('span', { class: 'nv-pal-meta nv-pal-desc', text: template.description }));
        const tags = el('span', { class: 'nv-pal-tags' });
        tags.append(el('span', { class: 'nv-badge', text: ui.T('nodes.template.nodeCount', { count: template.nodeCount }) }));
        if (template.batch) tags.append(el('span', { class: 'nv-badge is-batch', title: ui.T('nodes.app.batchHint'), text: ui.T('nodes.app.batch') }));
        if (!template.available) tags.append(el('span', { class: 'nv-badge is-warn', title: ui.T('nodes.template.unavailableNote', { missing: OCD.templatesUi.missingText(template) }), text: ui.T('nodes.palette.unavailable') }));
        row.append(chip, text, tags);
        row.addEventListener('mousemove', () => {
          if (state.index !== index) {
            state.index = index;
            paintActive();
          }
        });
        row.addEventListener('click', () => pick(index));
        state.list.append(row);
      });
      scheduleDetail();
    }

    function renderList() {
      if (state.category === TEMPLATE_CATEGORY && hasTemplates()) {
        renderTemplateRows();
        return;
      }
      const results = visibleEntries();
      state.results = results;
      if (state.index >= results.length) state.index = Math.max(0, results.length - 1);
      state.list.textContent = '';
      if (!results.length) {
        state.list.append(el('div', { class: 'nv-pal-empty', text: ui.T('nodes.palette.empty') }));
        scheduleDetail();
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
        if (help) row.append(helpButton(index));
        row.addEventListener('mousemove', () => {
          if (state.index !== index) {
            state.index = index;
            paintActive();
          }
        });
        row.addEventListener('click', () => pick(index));
        state.list.append(row);
      });
      scheduleDetail();
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
      scheduleDetail();
    }

    function pick(index) {
      const entry = state.results[index];
      if (!entry) return;
      const context = state.context;
      const filter = state.filter;
      close();
      if (entry.kind === 'template') onPickTemplate(entry.template, context);
      else onPick(entry, context, filter);
    }

    // Shift+Enter: the highlighted node plus a node in front of each required input (not for templates).
    function pickWithInputs(index) {
      const entry = state.results[index];
      // not while an input is being filled: the node would have to be connected to it as well
      if (!entry || entry.kind === 'template' || !onPickWithInputs || state.filter) return false;
      const context = state.context;
      close();
      onPickWithInputs(entry, context);
      return true;
    }

    function onKey(event) {
      if (!state) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        // the help sheet of a narrow window closes first
        if (state.sheet) closeSheet();
        else close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const n = state.results.length;
        if (n) state.index = (state.index + (event.key === 'ArrowDown' ? 1 : -1) + n) % n;
        paintActive();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.shiftKey || !pickWithInputs(state.index)) pick(state.index);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const reg = getReg();
        const cats = ['all', ...(hasTemplates() ? [TEMPLATE_CATEGORY] : []), ...reg.categories.filter((c) => state.entries.some((entry) => entry.category === c))];
        const at = cats.indexOf(state.category);
        state.category = cats[(at + (event.shiftKey ? -1 : 1) + cats.length) % cats.length];
        state.index = 0;
        renderChips();
        renderList();
      }
    }

    // Anchored mode (drag to empty canvas): a compact popover at the release point instead of the centred overlay.
    function placeAnchored(panel, at, withDetail = panel.classList.contains('has-detail')) {
      const bounds = root.getBoundingClientRect();
      const width = Math.min(ANCHORED_WIDTH + (withDetail ? DETAIL_WIDTH : 0), Math.max(240, bounds.width - 16));
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
      const hints = [['↑↓', ui.T('nodes.palette.navigate')], ['↵', ui.T('nodes.palette.insert')]];
      if (onPickWithInputs && !filter) hints.push(['⇧↵', ui.T('nodes.palette.insertWithInputs')]);
      hints.push(['Tab', ui.T('nodes.palette.category')], ['Esc', ui.T('nodes.common.close')]);
      for (const [key, label] of hints) {
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
      const main = el('div', { class: 'nv-pal-main' }, chips, list);
      // Help of the highlighted entry: beside the list on a wide window, a sheet over it on a narrow one.
      let detail = null;
      if (help) {
        const detailHead = el('div', { class: 'nv-pal-detail-head' });
        const back = el('button', { type: 'button', class: 'nv-pal-detail-back', tabindex: '-1' }, ui.icon('chevron-left', 14), el('span', { text: ui.T('nodes.help.back') }));
        back.addEventListener('mousedown', (event) => event.preventDefault());
        back.addEventListener('click', () => {
          closeSheet();
          state.input.focus();
        });
        const detailBody = el('div', { class: 'nv-pal-detail-body' });
        detail = { root: el('aside', { class: 'nv-pal-detail', 'aria-label': ui.T('nodes.help.title') }, back, detailHead, detailBody), head: detailHead, body: detailBody };
      }
      panel.append(el('div', { class: 'nv-pal-body' }, main, detail && detail.root), foot);
      root.append(panel);
      host.append(root);
      const wide = Boolean(detail) && isWide();
      panel.classList.toggle('has-detail', wide);
      if (anchored) {
        // the quick pick at the release point grows by the detail area when there is room
        panel.style.setProperty('--detail-w', `${DETAIL_WIDTH}px`);
        placeAnchored(panel, at, wide);
      }
      state = { panel, input, chips, list, filter, context, query: '', category: 'all', index: 0, results: [], entries: buildEntries(), templates: null, templatesLoading: false, templatesError: '', detail, detailKey: '', sheet: false, anchoredAt: anchored ? at : null };
      renderChips();
      renderList();
      loadTemplates();
      input.addEventListener('input', () => {
        state.query = input.value;
        state.index = 0;
        renderList();
      });
      root.addEventListener('pointerdown', (event) => {
        if (event.target === root) close();
      });
      document.addEventListener('keydown', onKey, true);
      global.addEventListener('resize', relayout);
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
      global.removeEventListener('resize', relayout);
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
