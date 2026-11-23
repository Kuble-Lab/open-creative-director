'use strict';

// Pending app actions are memory-only, person/workflow-bound and consumed before execution.
const crypto = require('crypto');
const { ToolError } = require('../mcp/tools');
const TTL_MS = 15 * 60 * 1000;
const MAX_OPEN = 20;
const identity = (viewer) => viewer?.active ? String(viewer.email || '').trim().toLowerCase() : 'local';
const expired = () => Object.assign(new ToolError('This action has expired or was already used.'), { code: 'ACTION_EXPIRED', status: 410 });

function createActions({ now = Date.now } = {}) {
  const entries = new Map();
  const sweep = () => { for (const [id, entry] of entries) if (entry.until <= now()) entries.delete(id); };
  const matches = (entry, viewer, workflowId) => entry && entry.owner === identity(viewer) && entry.workflowId === workflowId;
  return {
    issue({ viewer, workflowId, tool, args, facts }) {
      sweep();
      const owner = identity(viewer);
      const owned = [...entries].filter(([, entry]) => entry.owner === owner);
      while (owned.length >= MAX_OPEN) entries.delete(owned.shift()[0]);
      const id = crypto.randomBytes(24).toString('hex');
      const until = now() + TTL_MS;
      entries.set(id, { owner, workflowId, tool, args: JSON.parse(JSON.stringify(args)), until });
      return { id, tool, expiresAt: new Date(until).toISOString(), facts };
    },
    take(id, viewer, workflowId) {
      sweep();
      const entry = entries.get(id);
      if (!matches(entry, viewer, workflowId)) throw expired();
      entries.delete(id);
      return entry;
    },
    discard(id, viewer, workflowId) {
      sweep();
      if (matches(entries.get(id), viewer, workflowId)) entries.delete(id);
    }
  };
}
module.exports = { createActions, TTL_MS, MAX_OPEN };
