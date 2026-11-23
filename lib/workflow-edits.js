'use strict';

// Chat edit receipts live with the session. Snapshots never leave the server or enter the Director's history.
const crypto = require('crypto');
const store = require('./store');
const access = require('./access');
const { oneLine, userOf } = require('./workflow-runs');
const { allowed } = require('./chat-workflow-tools');
const { workflowContentKey } = require('./nodes/workflows-store');
const MAX_SNAPSHOTS = 20;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const service = () => require('./nodes/run-service').runService();
const fail = (code, status) => Object.assign(new Error(code), { code, status });
// 'lokal' is the one person of an install without user management (workflow-runs.userOf).
const mine = (entry, viewer) => access.normalizeEmail(entry.createdBy) === access.normalizeEmail(userOf(viewer));

function publicEdit(entry, viewer) {
  return { id: entry.id, workflowId: entry.workflowId, title: entry.name, kind: entry.kind,
    url: `/#w=${encodeURIComponent(entry.workflowId)}`, baseRev: entry.baseRev, rev: entry.rev,
    changes: entry.changes, createdAt: entry.createdAt, status: entry.status, reason: entry.reason || null,
    canUndo: mine(entry, viewer) && entry.kind === 'edit' && entry.status === 'applied' && Boolean(entry.before) };
}

function attachEdits(messages, session, viewer) {
  const entries = new Map((session.workflowEdits || []).map((entry) => [entry.id, entry]));
  return messages.map((message) => entries.has(message.workflowEditId)
    ? { ...message, workflowEdit: publicEdit(entries.get(message.workflowEditId), viewer) } : message);
}

async function record({ sessionId, viewer, kind, result, before, after, operations = [], name }) {
  const unchanged = kind === 'edit' && result.changed === false;
  const snapshot = before && !unchanged ? JSON.parse(JSON.stringify({ graph: before.graph, app: before.app })) : null;
  const tooLarge = snapshot && Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES;
  const entry = {
    id: `wfe-${crypto.randomUUID()}`, workflowId: result.workflow_id, name: oneLine(name || result.name || 'Workflow', 200), kind,
    baseRev: before?.rev ?? null, rev: result.rev, createdAt: new Date().toISOString(), createdBy: userOf(viewer),
    changes: operations.slice(0, 40).map((op) => oneLine([
      op.op, op.node || op.ref, op.type, op.param, op.params && Object.keys(op.params).join(', '), op.edge,
      op.from && `${op.from.node}.${op.from.port}`, op.to && `${op.to.node}.${op.to.port}`
    ].filter(Boolean).join(' · '), 200)),
    status: kind === 'edit' && (tooLarge || unchanged) ? 'undo_unavailable' : 'applied',
    ...(kind === 'edit' && snapshot && !tooLarge ? { before: snapshot } : {}),
    ...(kind === 'edit' && snapshot && !tooLarge && after ? { afterKey: crypto.createHash('sha256').update(workflowContentKey(after)).digest('hex') } : {}),
    ...(unchanged ? { reason: 'NO_CHANGE' } : tooLarge ? { reason: 'SNAPSHOT_TOO_LARGE' } : {})
  };
  await store.mutateSession(sessionId, (session) => {
    const entries = session.workflowEdits || [];
    entries.push(entry);
    const snapshots = entries.filter((item) => item.before);
    for (const old of snapshots.slice(0, Math.max(0, snapshots.length - MAX_SNAPSHOTS))) {
      delete old.before;
      delete old.afterKey;
      old.status = 'undo_unavailable';
      old.reason = 'SNAPSHOT_EXPIRED';
    }
    session.workflowEdits = entries;
  });
  return entry;
}

async function undo({ sessionId, editId, viewer }) {
  if (!allowed(viewer)) throw fail('FORBIDDEN', 403);
  let result;
  // One session lock covers the restore and receipt update, including simultaneous clicks.
  await store.mutateSession(sessionId, async (session) => {
    const entry = (session.workflowEdits || []).find((item) => item.id === editId);
    if (!entry) throw fail('NOT_FOUND', 404);
    if (!mine(entry, viewer)) throw fail('FORBIDDEN', 403);
    // Recheck the workflow permission even for an idempotent repeat.
    await service().workflowEditSnapshot(viewer, entry.workflowId);
    if (entry.status === 'undone') { result = publicEdit(entry, viewer); return; }
    if (entry.kind !== 'edit' || !entry.before) throw fail('UNDO_UNAVAILABLE', 410);
    const restored = await service().restoreWorkflowEdit(viewer, entry.workflowId, { rev: entry.rev, before: entry.before, afterKey: entry.afterKey });
    entry.status = 'undone';
    entry.undoRev = restored.rev;
    delete entry.before;
    delete entry.afterKey;
    for (const message of session.messages || []) if (message.workflowEditId === entry.id) {
      message.content += '\nThe person undid this workflow edit. Its previous graph and workflow inputs have been restored.';
    }
    session.messages.push({ role: 'assistant', hidden: true, content: `[System] Workflow edit ${entry.id} was undone by the person. The workflow now has revision ${restored.rev}.`, ts: new Date().toISOString() });
    result = publicEdit(entry, viewer);
  });
  return result;
}
module.exports = { MAX_SNAPSHOTS, MAX_SNAPSHOT_BYTES, publicEdit, attachEdits, record, undo };
