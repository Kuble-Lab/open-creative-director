'use strict';

// Help for node types (WP23): what a node is for, an example and tips, written by hand per type (i18n keys
// nodes.type.<type>.help / .example / .tip.1 to .tip.4), plus the parts that are generated from the registry so they
// cannot drift from the code: inputs and outputs, cost and availability. One presentation for every place that
// explains a node: the detail area of the palette and the quick pick, the popover behind the "?" of a card and the
// "Help" section of the inspector. A type without texts shows the generated parts only; nothing is made up.
// The pure part (describe, typeTexts, costKey) has no DOM and is tested in Node; everything else builds DOM nodes with
// the el() helper (never HTML from strings).
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const ui = OCD.ui;
  const { el, T, tr } = ui;

  const MAX_TIPS = 4;
  const LS_OPEN = 'ocd-nodes-help-open';
  const POPOVER_WIDTH = 348;
  const POPOVER_GAP = 10;
  const POPOVER_MARGIN = 8;

  /* ---------- the texts written by hand ---------- */

  // The translation behind `key`, or '' when there is none (t() returns the key itself for an unknown one).
  function textOf(key) {
    const value = T(key);
    return typeof value === 'string' && value && value !== key ? value : '';
  }

  // { what, example, tips: [] } of a node type in the interface language; a part that is not written is ''/[].
  function typeTexts(type) {
    const base = `nodes.type.${type}`;
    const tips = [];
    for (let index = 1; index <= MAX_TIPS; index += 1) {
      const tip = textOf(`${base}.tip.${index}`);
      if (!tip) break;
      tips.push(tip);
    }
    return { what: textOf(`${base}.help`), example: textOf(`${base}.example`), tips };
  }

  /* ---------- the parts generated from the registry ---------- */

  // Who bills the node, as the label of the service ('' without one).
  function providerLabel(key) {
    if (!key) return '';
    return OCD.templatesUi && OCD.templatesUi.requirementLabel ? OCD.templatesUi.requirementLabel(key) : key;
  }

  // How the node is paid, from the descriptor: 'free' (local), 'usd' or 'credits' (paid, the card shows the cost),
  // 'llm' (usd, a ChatGPT model runs through the subscription instead) or 'external' (free of cost in this app, a
  // service bills it elsewhere).
  function costKey(def) {
    const unit = def.cost && def.cost.unit;
    if (def.paid === true) return unit === 'credits' ? 'credits' : def.provider === 'llm' ? 'llm' : 'usd';
    return def.provider ? 'external' : 'free';
  }

  function portRow(port, direction) {
    const parsed = graphLib.parseType(port.type) || { base: 'any', list: false };
    const input = direction === 'in';
    return {
      id: port.id,
      label: ui.portLabel(port.id),
      base: parsed.base,
      list: parsed.list,
      typeLabel: `${tr(`nodes.ptype.${parsed.base}`, parsed.base)}${parsed.list ? ' []' : ''}`,
      required: input ? port.required === true : null,
      multiple: input && port.multiple === true,
      max: input && port.multiple === true && Number.isFinite(port.max) ? port.max : null,
      // a text or number input that can also be typed into the node itself
      orField: input && Boolean(port.param) && (parsed.base === 'text' || parsed.base === 'number')
    };
  }

  // Everything the help of one node type shows, without DOM: the texts, the ports of the registry (the first variant for
  // nodes whose ports follow a param), cost and availability. `def` is a registry descriptor (graphLib.indexRegistry).
  function describe(reg, def) {
    const ports = graphLib.portsFor(reg, { type: def.type, params: {} });
    const cost = costKey(def);
    const texts = typeTexts(def.type);
    return {
      type: def.type,
      label: ui.typeLabel(def),
      category: def.category,
      what: texts.what,
      example: texts.example,
      tips: texts.tips,
      hasTexts: Boolean(texts.what || texts.example || texts.tips.length),
      inputs: ports.inputs.filter((port) => !port.hidden).map((port) => portRow(port, 'in')),
      outputs: ports.outputs.filter((port) => !port.hidden).map((port) => portRow(port, 'out')),
      cost: { kind: cost, provider: providerLabel(def.provider === 'llm' ? 'openrouter' : def.provider) },
      available: def.available === true,
      unavailableReason: def.available === true ? '' : typeof def.available === 'string' ? ui.availabilityReason(def.available) : T('nodes.badge.unavailable'),
      experimental: def.experimental === true
    };
  }

  // The cost sentence of a described node.
  function costText(cost) {
    return T(`nodes.help.cost.${cost.kind}`, { provider: cost.provider });
  }

  function portFlags(row) {
    const flags = [];
    if (row.required !== null) flags.push({ text: T(row.required ? 'nodes.porttip.required' : 'nodes.porttip.optional'), required: row.required });
    if (row.multiple) flags.push({ text: row.max !== null ? T('nodes.help.multiMax', { max: row.max }) : T('nodes.help.multi'), required: false });
    if (row.orField) flags.push({ text: T('nodes.help.orField'), required: false });
    return flags;
  }

  /* ---------- storage (the open/closed state of the inspector section) ---------- */

  function readOpen() {
    try {
      return global.localStorage.getItem(LS_OPEN) === '1';
    } catch (_) {
      return false;
    }
  }

  function writeOpen(open) {
    try {
      global.localStorage.setItem(LS_OPEN, open ? '1' : '0');
    } catch (_) {
      /* storage may be unavailable */
    }
  }

  /* ---------- DOM ---------- */

  function label(text) {
    return el('span', { class: 'nv-help-label', text });
  }

  function portList(rows) {
    const list = el('ul', { class: 'nv-help-ports' });
    for (const row of rows) {
      const item = el('li', { class: 'nv-help-port' });
      item.append(
        el('i', { class: `nv-pal-dot nv-port-${row.base} ${row.list ? 'is-list' : ''}`.trim() }),
        el('span', { class: 'nv-help-port-name', text: row.label }),
        el('span', { class: 'nv-help-port-type', text: row.typeLabel })
      );
      for (const flag of portFlags(row)) item.append(el('span', { class: `nv-help-flag ${flag.required ? 'is-required' : ''}`.trim(), text: flag.text }));
      list.append(item);
    }
    return list;
  }

  // env: { getReg(), templates() -> store | null (list, withType), canInsert() -> boolean,
  //        insertWithInputs(type, options) -> result | null, insertTemplate(template) }
  function createHelp(env) {
    let popover = null;

    /* ----- the body ----- */

    // Block of the templates that contain this type; they arrive after the list is loaded, the body does not wait for it.
    function templateBlock(type, options) {
      const store = env.templates && env.templates();
      if (!store) return null;
      const block = el('div', { class: 'nv-help-block nv-help-templates hidden' });
      Promise.resolve()
        .then(() => store.list())
        .then(() => {
          const found = store.withType(type);
          if (!found.length) return;
          block.append(label(T('nodes.help.templates')));
          for (const template of found) {
            const row = el('div', { class: 'nv-help-tpl' }, el('span', { class: 'nv-help-tpl-name', text: template.name }));
            if (env.canInsert()) {
              const button = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-help-tpl-insert', title: T('nodes.help.insertTemplateTitle', { name: template.name }) }, ui.icon('plus', 12), el('span', { text: T('nodes.help.insertTemplate') }));
              button.addEventListener('click', () => {
                if (options.onDone) options.onDone();
                env.insertTemplate(template);
              });
              row.append(button);
            }
            block.append(row);
          }
          block.classList.remove('hidden');
          // the host (the popover) places itself again: the help grew after it was opened
          if (options.onLayout) options.onLayout();
        })
        .catch(() => {});
      return block;
    }

    // The help of one node type as an element. options: { onDone() (called before something is inserted, so the host
    // can close), onLayout() (the help grew later: the templates arrived), withInputs: false hides "insert with
    // inputs", templates: false hides the templates with this node, world (where the palette inserts) }.
    function render(type, options = {}) {
      const reg = env.getReg();
      const def = reg && reg.types.get(type);
      const body = el('div', { class: 'nv-help', dataset: { type } });
      if (!def) return body;
      const model = describe(reg, def);
      if (model.what) body.append(el('p', { class: 'nv-help-what', text: model.what }));
      if (model.example) body.append(el('div', { class: 'nv-help-block nv-help-example' }, label(T('nodes.help.example')), el('p', { text: model.example })));
      if (model.tips.length) {
        const tips = el('ul', { class: 'nv-help-tips' });
        for (const tip of model.tips) tips.append(el('li', { text: tip }));
        body.append(el('div', { class: 'nv-help-block' }, label(T('nodes.help.tips')), tips));
      }
      if (model.inputs.length) body.append(el('div', { class: 'nv-help-block' }, label(T('nodes.inspector.inputs')), portList(model.inputs)));
      if (model.outputs.length) body.append(el('div', { class: 'nv-help-block' }, label(T('nodes.inspector.outputs')), portList(model.outputs)));
      body.append(el('div', { class: 'nv-help-block' }, label(T('nodes.help.cost')), el('p', { class: `nv-help-cost is-${model.cost.kind}`, text: costText(model.cost) })));
      if (!model.available) body.append(el('div', { class: 'nv-notice is-warn' }, ui.icon('warning', 14), el('span', { class: 'nv-notice-text', text: T('nodes.help.unavailable', { reason: model.unavailableReason }) })));
      if (model.experimental) body.append(el('div', { class: 'nv-notice' }, ui.icon('sparkle', 14), el('span', { class: 'nv-notice-text', text: T('nodes.inspector.experimental') })));

      // "Insert with inputs": only when the node has required inputs that a node can be put in front of.
      if (options.withInputs !== false && env.canInsert()) {
        const built = graphLib.inputsSubgraph(reg, type);
        if (!built.error && built.nodes.length > 1) {
          const button = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-help-insert', title: T('nodes.help.withInputsTitle') }, ui.icon('plus', 13), el('span', { text: T('nodes.help.withInputs') }));
          button.addEventListener('click', () => {
            if (options.onDone) options.onDone();
            env.insertWithInputs(type, { world: options.world || null });
          });
          body.append(el('div', { class: 'nv-help-actions' }, button));
        }
      }
      // not while an input is being filled (the quick pick): a template does not fill it
      const templates = options.templates === false ? null : templateBlock(type, options);
      if (templates) body.append(templates);
      return body;
    }

    /* ----- popover (the "?" of a card) ----- */

    function closePopover(options = {}) {
      if (!popover) return;
      const current = popover;
      popover = null;
      document.removeEventListener('pointerdown', current.onDown, true);
      document.removeEventListener('keydown', current.onKey, true);
      document.removeEventListener('wheel', current.onWheel, true);
      global.removeEventListener('resize', current.onResize);
      current.panel.remove();
      if (options.restoreFocus !== false && current.anchor && current.anchor.isConnected && typeof current.anchor.focus === 'function') current.anchor.focus({ preventScroll: true });
    }

    function place(panel, anchor) {
      const rect = anchor.getBoundingClientRect();
      const viewWidth = global.innerWidth;
      const viewHeight = global.innerHeight;
      const width = panel.offsetWidth;
      const height = Math.min(panel.offsetHeight, viewHeight - 2 * POPOVER_MARGIN);
      let left = rect.right + POPOVER_GAP;
      if (left + width > viewWidth - POPOVER_MARGIN) left = rect.left - POPOVER_GAP - width;
      left = Math.min(Math.max(left, POPOVER_MARGIN), Math.max(POPOVER_MARGIN, viewWidth - width - POPOVER_MARGIN));
      const top = Math.min(Math.max(rect.top - 8, POPOVER_MARGIN), Math.max(POPOVER_MARGIN, viewHeight - height - POPOVER_MARGIN));
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    }

    // Help of a node type next to `anchor` (the "?" button). Clicking the same anchor again closes it.
    function openPopover(type, anchor) {
      const reg = env.getReg();
      const def = reg && reg.types.get(type);
      if (!def || !anchor) return null;
      if (popover && popover.anchor === anchor) {
        closePopover();
        return null;
      }
      closePopover({ restoreFocus: false });
      const close = el('button', { type: 'button', class: 'nv-icon-btn nv-help-pop-close', title: T('nodes.common.close'), 'aria-label': T('nodes.common.close') }, ui.icon('x', 13));
      const head = el('div', { class: 'nv-help-pop-head' }, el('span', { class: 'nv-node-icon', dataset: { cat: def.category } }, ui.categoryIcon(def.category, 15)), el('span', { class: 'nv-help-pop-title', text: ui.typeLabel(def) }), close);
      const panel = el('div', { class: 'nv-help-pop', role: 'dialog', 'aria-label': T('nodes.help.titleFor', { name: ui.typeLabel(def) }), tabindex: '-1' });
      panel.style.width = `${POPOVER_WIDTH}px`;
      const scroll = el('div', { class: 'nv-help-pop-body' }, render(type, { onDone: () => closePopover({ restoreFocus: false }), onLayout: () => popover && popover.panel === panel && place(panel, anchor) }));
      panel.append(head, scroll);
      ui.root().append(panel);
      place(panel, anchor);
      const current = {
        type,
        anchor,
        panel,
        onDown: (event) => {
          if (panel.contains(event.target) || anchor.contains(event.target)) return;
          closePopover({ restoreFocus: false });
        },
        onKey: (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          closePopover();
        },
        // zooming or panning the canvas moves the card away from the popover
        onWheel: (event) => {
          if (!panel.contains(event.target)) closePopover({ restoreFocus: false });
        },
        onResize: () => closePopover({ restoreFocus: false })
      };
      popover = current;
      close.addEventListener('click', () => closePopover());
      document.addEventListener('pointerdown', current.onDown, true);
      document.addEventListener('keydown', current.onKey, true);
      document.addEventListener('wheel', current.onWheel, { capture: true, passive: true });
      global.addEventListener('resize', current.onResize);
      panel.focus({ preventScroll: true });
      return panel;
    }

    /* ----- section of the inspector ----- */

    // The collapsible "Help" section. It is built when it is opened for the first time; open or closed is remembered.
    function section(type) {
      const wrap = el('section', { class: 'nv-insp-section nv-insp-help' });
      const toggle = el('button', { type: 'button', class: 'nv-insp-help-toggle' });
      const heading = el('h3', { class: 'nv-insp-heading' }, toggle);
      const body = el('div', { class: 'nv-insp-help-body' });
      let built = false;
      const paint = (open) => {
        toggle.textContent = '';
        toggle.append(ui.icon(open ? 'chevron-down' : 'chevron', 13), el('span', { text: T('nodes.help.title') }));
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        body.classList.toggle('hidden', !open);
        if (open && !built) {
          built = true;
          body.append(render(type, {}));
        }
      };
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        writeOpen(open);
        paint(open);
      });
      wrap.append(heading, body);
      paint(readOpen());
      return wrap;
    }

    return { render, openPopover, closePopover, section, isPopoverOpen: () => Boolean(popover) };
  }

  OCD.nodeHelp = { MAX_TIPS, LS_OPEN, typeTexts, costKey, costText, providerLabel, describe, portFlags, createHelp };
})(window);
