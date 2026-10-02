'use strict';

// Hover help for ports: an own tooltip for the whole port row (dot and label, inputs and outputs) instead of a
// native title. It is rendered in the screen layer (ui.root(), position: fixed), not inside the zoomed world layer,
// so the text has the same size at every zoom level. The content comes from graphLib.describePort(): a structured
// description (label, type, required, description key, facts, connections in engine order) that is turned into DOM
// nodes here with the DOM API only. Touch devices have no hover; nothing here depends on it.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const graphLib = OCD.graph;
  const ui = OCD.ui;
  const { el, T, tr } = ui;

  const SHOW_DELAY = 300; // dwell time before the first tooltip
  const SWITCH_DELAY = 120; // moving from one port to the next while a tooltip is showing
  const GAP = 10; // distance between the port dot and the tooltip
  const MARGIN = 8; // distance to the window edge
  const HEAD_OFFSET = 16; // the tooltip starts this far above the centre of the dot
  const ROW = '.nv-port-row';

  let counter = 0;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // First key of the lookup chain (see graphLib.portDescriptionKeys) that has a text in the current language.
  function resolveDescription(description) {
    for (const key of graphLib.portDescriptionChain(description.text)) {
      const value = T(key);
      if (value && value !== key) return value;
    }
    return '';
  }

  // Screen position of the tooltip: beside the dot, on the side facing away from the card (inputs to the left,
  // outputs to the right), flipped when there is no room, then kept inside the window.
  function place(tip, anchor, direction) {
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const viewWidth = global.innerWidth;
    const viewHeight = global.innerHeight;
    let left;
    if (direction === 'in') {
      left = anchor.left - GAP - width;
      if (left < MARGIN) left = anchor.right + GAP;
    } else {
      left = anchor.right + GAP;
      if (left + width > viewWidth - MARGIN) left = anchor.left - GAP - width;
    }
    left = clamp(left, MARGIN, Math.max(MARGIN, viewWidth - width - MARGIN));
    const top = clamp(anchor.top + anchor.height / 2 - HEAD_OFFSET, MARGIN, Math.max(MARGIN, viewHeight - height - MARGIN));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  // options: { container, getReg(), getGraph(), isBusy() }
  function createPortTip(options) {
    const { container } = options;
    const tip = el('div', { class: 'nv-porttip', role: 'tooltip', id: `nv-porttip-${(counter += 1)}` });
    let timer = null;
    let pendingRow = null; // row the timer is armed for
    let shownRow = null; // row the tooltip is showing for
    let shownDot = null;
    let suppressedRow = null; // hidden by a click / Esc / wheel: stays hidden until the pointer leaves the row

    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingRow = null;
    }

    // Hides the tooltip and cancels a pending one. suppress: do not show it again for the row under the pointer.
    function hide(settings = {}) {
      const row = shownRow || pendingRow;
      clearTimer();
      if (settings.suppress && row) suppressedRow = row;
      if (shownDot) {
        shownDot.removeAttribute('aria-describedby');
        shownDot = null;
      }
      shownRow = null;
      tip.classList.remove('is-visible');
      tip.remove();
    }

    function connectionTitle(connection, reg) {
      if (connection.titled) return connection.nodeTitle;
      const def = connection.nodeType ? reg.types.get(connection.nodeType) : null;
      return def ? ui.typeLabel(def) : connection.nodeTitle;
    }

    function fill(description, reg) {
      tip.textContent = '';
      const head = el('div', { class: 'nv-porttip-head' });
      head.append(
        el('span', { class: 'nv-porttip-name', text: tr(description.labelKey, description.label) }),
        el(
          'span',
          { class: `nv-porttip-type nv-port-${description.base}` },
          el('i', { class: `nv-porttip-swatch ${description.list ? 'is-list' : ''}`.trim() }),
          `${tr(description.typeKey, description.base)}${description.list ? ' []' : ''}`
        )
      );
      if (description.required === null) {
        head.append(el('span', { class: 'nv-porttip-flag', text: T('nodes.porttip.output') }));
      } else {
        head.append(el('span', { class: `nv-porttip-flag ${description.required ? 'is-required' : ''}`.trim(), text: T(description.required ? 'nodes.porttip.required' : 'nodes.porttip.optional') }));
      }
      tip.append(head);

      const text = resolveDescription(description);
      if (text) tip.append(el('p', { class: 'nv-porttip-text', text }));

      if (description.facts.length) {
        const facts = el('ul', { class: 'nv-porttip-facts' });
        for (const fact of description.facts) facts.append(el('li', { class: fact.error ? 'is-error' : '', text: T(fact.key, fact.vars) }));
        // the roles the chosen model names for its reference slots ("start image, end image")
        if (description.limit && description.limit.known && description.limit.roles.length) {
          facts.append(el('li', { class: 'nv-porttip-roles', text: T('nodes.porttip.roles', { roles: description.limit.roles.map((role) => ui.roleLabel(role)).join(', ') }) }));
        }
        tip.append(facts);
      }

      if (description.direction === 'in') {
        const box = el('div', { class: 'nv-porttip-conns' });
        if (description.connections.length) {
          box.append(el('div', { class: 'nv-porttip-conns-title', text: T('nodes.porttip.connectedTo') }));
          const list = el('ol', { class: 'nv-porttip-conn-list' });
          for (const connection of description.connections) {
            const item = el('li', {}, el('span', { class: 'nv-porttip-order', text: connection.order === null ? '\u2013' : `${connection.order}.` }), el('span', { class: 'nv-porttip-conn-title', text: connectionTitle(connection, reg) }));
            if (connection.multiOutput) item.append(el('span', { class: 'nv-porttip-conn-port', text: ui.portLabel(connection.port) }));
            list.append(item);
          }
          box.append(list);
          if (description.moreConnections > 0) box.append(el('div', { class: 'nv-porttip-more', text: T('nodes.porttip.more', { count: description.moreConnections }) }));
        } else {
          box.append(el('div', { class: 'nv-porttip-conns-title', text: T('nodes.porttip.notConnected') }));
        }
        tip.append(box);
      }
    }

    function show(row) {
      const reg = options.getReg();
      const graph = options.getGraph();
      const dot = row.querySelector('.nv-port');
      const card = row.closest('.nv-node');
      if (!reg || !graph || !dot || !card || !row.isConnected) return;
      const description = graphLib.describePort(reg, graph, card.dataset.id, dot.dataset.dir, dot.dataset.port);
      if (!description) return;
      fill(description, reg);
      tip.classList.remove('is-visible');
      ui.root().append(tip);
      place(tip, dot.getBoundingClientRect(), description.direction);
      tip.classList.add('is-visible');
      dot.setAttribute('aria-describedby', tip.id);
      shownDot = dot;
      shownRow = row;
    }

    function arm(row, delay) {
      clearTimer();
      pendingRow = row;
      timer = setTimeout(() => {
        timer = null;
        const target = pendingRow;
        pendingRow = null;
        if (target === row && !options.isBusy()) show(row);
      }, delay);
    }

    function rowOf(target) {
      const row = target && typeof target.closest === 'function' ? target.closest(ROW) : null;
      return row && container.contains(row) ? row : null;
    }

    function onPointerMove(event) {
      if (event.pointerType === 'touch') return;
      if (options.isBusy() || event.buttons) {
        if (shownRow || pendingRow) hide();
        return;
      }
      const row = rowOf(event.target);
      if (row !== suppressedRow) suppressedRow = null;
      if (!row) {
        if (shownRow || pendingRow) hide();
        return;
      }
      if (row === suppressedRow || row === shownRow || row === pendingRow) return;
      const wasShowing = Boolean(shownRow);
      hide();
      arm(row, wasShowing ? SWITCH_DELAY : SHOW_DELAY);
    }

    const suppress = () => hide({ suppress: true });
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && (shownRow || pendingRow)) suppress();
    };
    const onLeave = () => {
      suppressedRow = null;
      hide();
    };

    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onLeave);
    container.addEventListener('pointerdown', suppress, true);
    container.addEventListener('wheel', suppress, { passive: true });
    container.addEventListener('contextmenu', suppress);
    document.addEventListener('keydown', onKeyDown, true);
    global.addEventListener('blur', onLeave);

    function destroy() {
      hide();
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onLeave);
      container.removeEventListener('pointerdown', suppress, true);
      container.removeEventListener('wheel', suppress);
      container.removeEventListener('contextmenu', suppress);
      document.removeEventListener('keydown', onKeyDown, true);
      global.removeEventListener('blur', onLeave);
    }

    return { hide, destroy, isVisible: () => Boolean(shownRow), element: tip };
  }

  OCD.portTip = { createPortTip, resolveDescription, place, SHOW_DELAY, SWITCH_DELAY };
})(window);
