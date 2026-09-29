'use strict';

// Undo/redo snapshot stack (SPEC §12.6). Pure: stores JSON-cloned snapshots, knows nothing about
// the graph. Usage: reset(initial) once, commit(snapshot) after every committed action,
// undo()/redo() return the snapshot to restore (or null).
// UMD: module.exports in Node (tests), window.OCDNodes.history in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.history = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_LIMIT = 100;
  const DEFAULT_COALESCE_MS = 500;

  function createHistory(options = {}) {
    const limit = Math.max(2, Number(options.limit) || DEFAULT_LIMIT);
    const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    let entries = [];
    let index = -1;
    let lastKey = null;
    let lastAt = 0;

    const serialize = (snapshot) => JSON.stringify(snapshot);

    function reset(snapshot) {
      entries = [{ json: serialize(snapshot), label: 'initial' }];
      index = 0;
      lastKey = null;
      lastAt = 0;
    }

    // Records the state after an action. Returns true when the stack changed.
    // Identical snapshots are ignored. A commit with the same coalesceKey within coalesceMs of the
    // previous one replaces it (typing in a field is one undo step), unless redo history exists.
    function commit(snapshot, meta = {}) {
      if (index < 0) {
        reset(snapshot);
        return true;
      }
      const json = serialize(snapshot);
      if (json === entries[index].json) return false;
      const time = now();
      const key = meta.coalesceKey || null;
      const coalesce = Boolean(key) && key === lastKey && time - lastAt <= coalesceMs && index === entries.length - 1 && index > 0;
      if (coalesce) {
        entries[index] = { json, label: meta.label || entries[index].label };
      } else {
        entries = entries.slice(0, index + 1);
        entries.push({ json, label: meta.label || '' });
        if (entries.length > limit) entries.shift();
        index = entries.length - 1;
      }
      lastKey = key;
      lastAt = time;
      return true;
    }

    function canUndo() {
      return index > 0;
    }

    function canRedo() {
      return index >= 0 && index < entries.length - 1;
    }

    function undo() {
      if (!canUndo()) return null;
      index -= 1;
      lastKey = null;
      return JSON.parse(entries[index].json);
    }

    function redo() {
      if (!canRedo()) return null;
      index += 1;
      lastKey = null;
      return JSON.parse(entries[index].json);
    }

    function current() {
      return index >= 0 ? JSON.parse(entries[index].json) : null;
    }

    function clear() {
      entries = [];
      index = -1;
      lastKey = null;
      lastAt = 0;
    }

    return {
      reset,
      commit,
      undo,
      redo,
      canUndo,
      canRedo,
      current,
      clear,
      get size() {
        return entries.length;
      },
      get position() {
        return index;
      }
    };
  }

  return { createHistory, DEFAULT_LIMIT, DEFAULT_COALESCE_MS };
});
