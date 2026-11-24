'use strict';

// Shared by input resolution and the inspector. No mutation or logging here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.itemEdits = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function applyItemEdit(value, edit) {
    if (value?.type !== 'text' || typeof edit?.text !== 'string' || typeof edit.was !== 'string') return { value, edited: false, stale: false };
    if (edit.was !== value.value) return { value, edited: false, stale: true };
    return { value: { ...value, value: edit.text }, edited: true, stale: false };
  }

  function applyItemEdits(value, edits) {
    const edited = [];
    const stale = [];
    if (!edits || value?.type !== 'list' || !Array.isArray(value.items)) return { value, edited, stale };
    const items = value.items.map((item, index) => {
      const edit = Object.hasOwn(edits, index) ? edits[index] : null;
      const applied = applyItemEdit(item, edit);
      if (applied.stale) stale.push(index);
      if (applied.edited) edited.push(index);
      return applied.value;
    });
    return { value: edited.length ? { ...value, items } : value, edited, stale };
  }

  function withoutItemEdit(node, portId, index) {
    const itemEdits = { ...node.itemEdits };
    const entries = { ...itemEdits[portId] };
    delete entries[index];
    if (Object.keys(entries).length) itemEdits[portId] = entries;
    else delete itemEdits[portId];
    const next = { ...node };
    if (Object.keys(itemEdits).length) next.itemEdits = itemEdits;
    else delete next.itemEdits;
    return next;
  }

  return { applyItemEdit, applyItemEdits, withoutItemEdit };
});
