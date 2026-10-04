'use strict';

// The scene table of the inspector (WP35): for a node whose selected result is a list, one row per item with its number, a preview,
// the main text of the item and its length, and the choice of items to make again (run mode 'items', SPEC §9.1).
// Pure and UMD (module.exports in Node tests, window.OCDNodes.sceneTable in the browser): no DOM here, the rows are data. The
// inspector (inspector.js) draws them and run.js (inspectorApi.scenes / runItems) hands in the state and starts the run.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.sceneTable = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Nodes whose list is their setting or their destination: no table
  const NO_TABLE_CATEGORIES = Object.freeze(['input', 'output']);
  // Where the text of an item may also come from where no text input is connected: the settings of the entry
  const TEXT_PARAMS = Object.freeze(['prompt', 'text', 'brief', 'notes', 'template']);
  const MAX_ROWS = 400;

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isList = (value) => isObject(value) && value.type === 'list' && Array.isArray(value.items);
  const textOf = (value) => (isObject(value) && value.type === 'text' && typeof value.value === 'string' ? value.value : null);

  // 'text' and 'text[]' are text ports; a port that takes several connections (`multiple`) is a whole list, not the text of one item
  const isTextPort = (port) => Boolean(port) && !port.multiple && /^text(\[\])?$/.test(String(port.type || ''));

  // The text an item gets in: the first text input (in the order of the ports) with a connection whose value has text for this item.
  // A list from upstream gives its item of the same number, a single text is the same for all items.
  function mainText({ index, inputPorts, edges, upstreamVariant, entry }) {
    for (const port of inputPorts || []) {
      if (!isTextPort(port)) continue;
      const edge = (edges || []).find((item) => item.to && item.to.port === port.id && item.to.node === port.nodeId);
      if (!edge) continue;
      const variant = upstreamVariant ? upstreamVariant(edge.from.node) : null;
      const value = variant ? variant[edge.from.port] : null;
      const text = isList(value) ? textOf(value.items[index]) : textOf(value);
      if (text && text.trim()) return text.trim();
    }
    const params = (entry && entry.params) || {};
    for (const key of TEXT_PARAMS) {
      if (typeof params[key] === 'string' && params[key].trim()) return params[key].trim();
    }
    return '';
  }

  // The kind of preview a value gets: image and video as a tile (a click opens it), audio with a player, text shortened.
  function kindOf(value) {
    if (!isObject(value)) return 'none';
    if (['image', 'video', 'audio', 'text', 'number', 'model3d', 'document'].includes(value.type)) return value.type;
    return 'other';
  }

  const durationOf = (value) => (isObject(value) && Number.isFinite(value.duration) && value.duration > 0 ? value.duration : null);

  // The table of a node, or null where there is none: an input or output node, no result, no list among the visible outputs.
  //   nodeId, category   the node and its category
  //   entry, variant     the selected history entry and its selected variant
  //   order              ids of the output ports in the order of the node; hidden: ids that are not shown
  //   inputPorts         the input ports [{ id, type, multiple? }] of the node
  //   edges              the connections of the graph; upstreamVariant(nodeId) the selected variant of another node (or null)
  // Returns { port, count, aligned, rows: [{ index, number, value, kind, text, duration }] }. `aligned` is true where the entry
  // knows the key of every item (itemKeys, made by a run of the node per item): only then are single items made again without the
  // others; an older result or a node that makes its list as a whole cannot be.
  function sceneTable({ nodeId, category, entry, variant, order, hidden, inputPorts, edges, upstreamVariant }) {
    if (NO_TABLE_CATEGORIES.includes(category) || !isObject(variant)) return null;
    const hide = hidden instanceof Set ? hidden : new Set(hidden || []);
    const ids = [...(order || []).filter((id) => id in variant), ...Object.keys(variant).filter((id) => !(order || []).includes(id))].filter((id) => !hide.has(id));
    const port = ids.find((id) => isList(variant[id]) && variant[id].items.length > 0);
    if (!port) return null;
    const items = variant[port].items.slice(0, MAX_ROWS);
    const ports = (inputPorts || []).map((item) => ({ ...item, nodeId }));
    const rows = items.map((value, index) => ({
      index,
      number: index + 1,
      value,
      kind: kindOf(value),
      text: mainText({ index, inputPorts: ports, edges, upstreamVariant, entry }),
      duration: durationOf(value)
    }));
    const aligned = Boolean(entry) && Array.isArray(entry.itemKeys) && entry.itemKeys.length === variant[port].items.length;
    return { port, count: variant[port].items.length, aligned, rows };
  }

  // The request of the run mode 'items': the numbers (from 0) of the rows, once each and in order
  function itemsRequest(nodeId, indexes) {
    const items = [...new Set((indexes || []).filter((value) => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b);
    return { mode: 'items', nodeId, items };
  }

  // What one item costs to make again, from the plan of the node: { paid, usd, credits, unknown }. The plan lags behind an edit by a
  // moment and a node that is not paid has no estimate; the confirmation of the run shows the exact sum before anything is spent.
  function itemCost(planNode, def) {
    const paid = Boolean((planNode && planNode.paid) || (def && def.paid));
    const estimate = planNode && isObject(planNode.estimate) ? planNode.estimate : null;
    const usd = estimate && Number.isFinite(estimate.usd) ? estimate.usd : null;
    const credits = estimate && Number.isFinite(estimate.credits) ? estimate.credits : null;
    return { paid, usd, credits, unknown: paid && usd === null && credits === null };
  }

  // The same for several items: the sum of the known amounts, `unknown` where one is missing
  function selectionCost(cost, count) {
    if (!cost.paid) return { paid: false, usd: null, credits: null, unknown: false };
    return {
      paid: true,
      usd: cost.usd === null ? null : cost.usd * count,
      credits: cost.credits === null ? null : cost.credits * count,
      unknown: cost.unknown
    };
  }

  // The clock for a length in seconds: "0:07", "1:05"
  function clock(seconds) {
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  return { sceneTable, itemsRequest, itemCost, selectionCost, mainText, kindOf, clock, MAX_ROWS };
});
