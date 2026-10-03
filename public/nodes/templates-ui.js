'use strict';

// Starter templates in the node view (SPEC §15): the store behind GET /api/workflow-templates (list and localized
// documents), the texts of a card (reading line, cost, search) and the gallery dialog. The same store and texts serve
// the gallery, the "Templates" tab of the palette and the empty canvas, so a template reads the same everywhere.
// Inserting into the open workflow lives in main.js (insertTemplate) on top of graph.js insertSubgraph.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const ui = OCD.ui;
  const { el } = ui;

  const REQUIREMENT_LABELS = Object.freeze({ openrouter: 'OpenRouter', ffmpeg: 'ffmpeg', poppler: 'Poppler', elevenlabs: 'ElevenLabs', rendernode: 'Render node', higgsfield: 'Higgsfield', fal: 'fal.ai' });
  // From this many templates on the gallery gets a search field.
  const SEARCH_MIN = 8;
  const CACHE_MS = 5 * 60 * 1000;

  const requirementLabel = (key) => REQUIREMENT_LABELS[key] || key;

  /* ---------- store ---------- */

  // List and documents of the templates in the interface language. The list is cached for a few minutes (it holds the
  // availability on this server); `withType` answers from that cache, so it is empty until list() has run once.
  function createStore({ api, getLang, now = Date.now }) {
    let cache = null;
    let pending = null;

    function list(options = {}) {
      const lang = getLang();
      if (!options.refresh && cache && cache.lang === lang && now() - cache.at < CACHE_MS) return Promise.resolve(cache.templates);
      if (pending && pending.lang === lang) return pending.promise;
      const promise = api
        .templates(lang)
        .then((payload) => {
          const templates = Array.isArray(payload && payload.templates) ? payload.templates : [];
          cache = { lang, templates, at: now() };
          return templates;
        })
        .finally(() => {
          if (pending && pending.promise === promise) pending = null;
        });
      pending = { lang, promise };
      return promise;
    }

    // The localized `ocd.workflow` document of one template ({ name, description, graph, app }).
    async function document(id) {
      const payload = await api.template(id, getLang());
      return payload.document;
    }

    // Cached templates that contain a node of this type ("templates with this node").
    function withType(type) {
      return cache ? cache.templates.filter((template) => (template.nodeTypes || []).includes(type)) : [];
    }

    return { list, document, withType, cached: () => (cache ? cache.templates : null), invalidate: () => { cache = null; } };
  }

  /* ---------- texts of a card ---------- */

  // "Text + Image → LLM → 3× Dubbing → Result": the steps of the graph (template.flow) with the translated type names.
  function flowText(template, labelOf) {
    const label = typeof labelOf === 'function' ? labelOf : (type) => type;
    return (template.flow || [])
      .map((step) => step.map((entry) => (entry.count > 1 ? `${entry.count}× ${label(entry.type)}` : label(entry.type))).join(' + '))
      .join(' → ');
  }

  // { usd, credits } of a cost summary as "$0.2000 · 12 Credits" (the notation of the node cards), '' without amount.
  function amountText(cost) {
    const run = OCD.run;
    const parts = run && run.costParts ? run.costParts({ usd: cost.usd, credits: cost.credits }) : { usd: null, credits: null };
    const pieces = [];
    if (parts.usd) pieces.push(parts.usd);
    if (parts.credits) pieces.push(ui.T('nodes.cost.credits', { credits: parts.credits }));
    return pieces.join(' · ');
  }

  // What one run costs, from template.cost (computed by the server from the nodes): { kind, text, title }.
  // free -> "free (local)", estimate -> "about $0.20 per run" ("per row" for a list), partial -> "from ...",
  // unknown -> "depends on model and length"; the paid services follow after a dot.
  function costInfo(template) {
    const cost = template.cost || { kind: 'unknown', providers: [] };
    const services = (cost.providers || []).map(requirementLabel).join(', ');
    const amount = cost.kind === 'estimate' || cost.kind === 'partial' ? amountText(cost) : '';
    // An estimate without an amount says nothing: it reads as unknown.
    const kind = cost.kind === 'free' ? 'free' : amount ? cost.kind : 'unknown';
    let main;
    if (kind === 'free') main = ui.T('nodes.template.cost.free');
    else if (kind === 'unknown') main = ui.T('nodes.template.cost.unknown');
    else main = ui.T(`nodes.template.cost.${kind === 'partial' ? 'from' : 'estimate'}${template.batch ? 'Row' : ''}`, { amount });
    return { kind, text: services ? `${main} · ${services}` : main, title: kind === 'free' ? '' : ui.T('nodes.template.costHint') };
  }

  // Templates matching a search, best first: every word must occur in the name (3), the node names (2) or the
  // description (1). Without a search the list stays as it is.
  function rank(templates, query, labelOf) {
    const tokens = graphLib.parseSearchQuery(query).tokens.filter(Boolean);
    if (!graphLib.normalizeSearch(query) || !tokens.length) return templates.slice();
    const label = typeof labelOf === 'function' ? labelOf : (type) => type;
    const scored = [];
    templates.forEach((template, index) => {
      const name = graphLib.normalizeSearch(template.name);
      const description = graphLib.normalizeSearch(template.description);
      const nodes = graphLib.normalizeSearch((template.nodeTypes || []).map((type) => `${label(type)} ${type}`).join(' '));
      let score = 0;
      for (const token of tokens) {
        const hit = name.includes(token) ? 3 : nodes.includes(token) ? 2 : description.includes(token) ? 1 : 0;
        if (!hit) return;
        score += hit;
      }
      scored.push({ template, score, index });
    });
    return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.template);
  }

  function missingText(template) {
    return (template.missing || []).map((item) => requirementLabel(item.key)).join(', ');
  }

  // Badges of a template: "Batch" for a list, one per requirement (amber when this server lacks it).
  function badges(template) {
    const tags = el('span', { class: 'nv-tpl-tags' });
    if (template.batch) tags.append(el('span', { class: 'nv-badge is-batch', title: ui.T('nodes.app.batchHint'), text: ui.T('nodes.app.batch') }));
    for (const key of template.requires || []) {
      const missing = (template.missing || []).find((item) => item.key === key);
      tags.append(el('span', { class: `nv-badge ${missing ? 'is-warn' : ''}`.trim(), title: missing ? missing.reason : ui.T('nodes.template.ready'), text: requirementLabel(key) }));
    }
    return tags;
  }

  /* ---------- card ---------- */

  function createCard(template, labelOf) {
    const flow = flowText(template, labelOf);
    const cost = costInfo(template);
    const card = el('button', {
      type: 'button',
      class: `nv-tpl-card ${template.available ? '' : 'is-unavailable'}`.trim(),
      role: 'option',
      'aria-selected': 'false',
      tabindex: '-1',
      dataset: { id: template.id }
    });
    card.append(
      el('span', { class: 'nv-tpl-head' }, el('span', { class: 'nv-tpl-icon' }, ui.icon('template', 16)), el('span', { class: 'nv-tpl-name', text: template.name })),
      el('span', { class: 'nv-tpl-desc', text: template.description }),
      el('span', { class: 'nv-tpl-flow', title: flow }, el('span', { class: 'nv-tpl-flow-text', text: flow })),
      el(
        'span',
        { class: 'nv-tpl-meta' },
        el('span', { class: 'nv-tpl-count', text: ui.T('nodes.template.nodeCount', { count: template.nodeCount }) }),
        el('span', { class: `nv-tpl-cost is-${cost.kind}`, title: cost.title, text: cost.text })
      ),
      badges(template)
    );
    return card;
  }

  /* ---------- gallery ---------- */

  // The gallery dialog. Resolves { action: 'new' | 'insert', template, folder } or null when it was closed.
  //   canInsert  an open workflow can take the template (shows "Insert into this workflow")
  //   primary    which of the two actions is the main button ('insert' for the empty canvas, else 'new')
  //   select     the project select of the caller (read for 'new'), or null
  function openGallery({ templates, labelOf, canInsert = false, primary = 'new', select = null }) {
    let chosen = null;
    let panel = null;
    let visible = templates.slice();
    const cards = new Map();
    const grid = el('div', { class: 'nv-tpl-grid', role: 'listbox', 'aria-label': ui.T('nodes.template.galleryTitle') });
    for (const template of templates) {
      const card = createCard(template, labelOf);
      card.addEventListener('click', () => choose(template));
      cards.set(template.id, card);
      grid.append(card);
    }
    const empty = el('p', { class: 'nv-hint nv-tpl-empty hidden', text: ui.T('nodes.template.noMatch') });
    const note = el('p', { class: 'nv-hint nv-tpl-note', text: ui.T('nodes.template.note') });
    const search = templates.length > SEARCH_MIN ? el('input', { class: 'nv-input nv-tpl-search', type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: ui.T('nodes.template.search'), 'aria-label': ui.T('nodes.template.search') }) : null;
    const projectRow = select ? el('div', { class: 'nv-tpl-project' }, el('label', { class: 'nv-field-label', text: ui.T('nodes.project.label') }), select) : null;

    // One tab stop for the grid: the chosen card, else the first visible one; arrows move between cards.
    function paintTabStops() {
      const stop = chosen && visible.includes(chosen) ? chosen : visible[0];
      for (const [id, card] of cards) card.tabIndex = stop && stop.id === id ? 0 : -1;
    }

    function update() {
      const buttons = panel ? [...panel.querySelectorAll('.nv-dialog-actions .nv-btn')] : [];
      for (const button of buttons.slice(1)) button.disabled = !chosen;
      for (const [id, card] of cards) {
        card.classList.toggle('is-selected', Boolean(chosen && chosen.id === id));
        card.setAttribute('aria-selected', chosen && chosen.id === id ? 'true' : 'false');
      }
      note.classList.toggle('is-warn', Boolean(chosen && !chosen.available));
      note.textContent = chosen && !chosen.available ? ui.T('nodes.template.unavailableNote', { missing: missingText(chosen) }) : ui.T('nodes.template.note');
      paintTabStops();
    }

    function choose(template) {
      chosen = template;
      update();
    }

    function applyFilter() {
      visible = rank(templates, search ? search.value : '', labelOf);
      const shown = new Set(visible.map((template) => template.id));
      for (const [id, card] of cards) card.classList.toggle('hidden', !shown.has(id));
      grid.append(...visible.map((template) => cards.get(template.id)));
      grid.scrollTop = 0;
      empty.classList.toggle('hidden', visible.length > 0);
      if (chosen && !shown.has(chosen.id)) chosen = null;
      update();
    }

    function moveFocus(from, step) {
      const index = visible.findIndex((template) => template.id === from);
      const next = visible[Math.min(visible.length - 1, Math.max(0, index + step))];
      if (!next) return;
      cards.get(next.id).tabIndex = 0;
      for (const [id, card] of cards) if (id !== next.id) card.tabIndex = -1;
      cards.get(next.id).focus();
    }

    grid.addEventListener('keydown', (event) => {
      const card = event.target.closest('.nv-tpl-card');
      if (!card) return;
      const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (keys[event.key]) {
        event.preventDefault();
        moveFocus(card.dataset.id, keys[event.key]);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        moveFocus(card.dataset.id, event.key === 'Home' ? -visible.length : visible.length);
      }
    });
    if (search) {
      search.addEventListener('input', applyFilter);
      search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && visible.length) {
          event.preventDefault();
          choose(visible[0]);
          cards.get(visible[0].id).focus();
        } else if (event.key === 'ArrowDown' && visible.length) {
          event.preventDefault();
          cards.get((chosen && visible.includes(chosen) ? chosen : visible[0]).id).focus();
        }
      });
    }

    const mainAction = canInsert && primary === 'insert' ? 'insert' : 'new';
    const buttons = [{ label: ui.T('nodes.common.cancel'), value: false, cancel: true }];
    if (canInsert) buttons.push({ label: ui.T('nodes.template.insert'), value: 'insert', primary: mainAction === 'insert', enter: false });
    buttons.push({ label: ui.T('nodes.template.createNew'), value: 'new', primary: mainAction === 'new', enter: false });

    return ui
      .dialog({
        title: ui.T('nodes.template.galleryTitle'),
        body: el('div', { class: 'nv-tpl' }, search, grid, empty, note, projectRow),
        width: 860,
        buttons,
        onOpen: (dialogPanel) => {
          panel = dialogPanel;
          dialogPanel.classList.add('is-wide', 'is-gallery');
          update();
          const first = search || (visible[0] && cards.get(visible[0].id));
          if (first) first.focus({ preventScroll: true });
        }
      })
      .then((action) => (chosen && (action === 'new' || action === 'insert') ? { action, template: chosen, folder: select ? select.value || null : null } : null));
  }

  OCD.templatesUi = {
    REQUIREMENT_LABELS,
    SEARCH_MIN,
    requirementLabel,
    createStore,
    flowText,
    amountText,
    costInfo,
    rank,
    missingText,
    badges,
    createCard,
    openGallery
  };
})(window);
