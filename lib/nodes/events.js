'use strict';

// Per-workflow event bus feeding the SSE stream (SPEC §11.4). Events are plain objects
// { type, ...payload }; listeners never throw into the emitter.

function createEventBus() {
  const listeners = new Map();

  function subscribe(workflowId, listener) {
    let set = listeners.get(workflowId);
    if (!set) {
      set = new Set();
      listeners.set(workflowId, set);
    }
    set.add(listener);
    return function unsubscribe() {
      const current = listeners.get(workflowId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) listeners.delete(workflowId);
    };
  }

  function emit(workflowId, event) {
    const set = listeners.get(workflowId);
    if (!set) return 0;
    let delivered = 0;
    for (const listener of [...set]) {
      try {
        listener(event);
        delivered += 1;
      } catch (err) {
        console.warn(`[nodes] event listener failed: ${err.message}`);
      }
    }
    return delivered;
  }

  function listenerCount(workflowId) {
    return listeners.get(workflowId)?.size || 0;
  }

  return { subscribe, emit, listenerCount };
}

const defaultBus = createEventBus();

module.exports = {
  createEventBus,
  bus: defaultBus,
  subscribe: defaultBus.subscribe,
  emit: defaultBus.emit,
  listenerCount: defaultBus.listenerCount
};
