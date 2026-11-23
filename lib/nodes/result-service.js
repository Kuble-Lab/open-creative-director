'use strict';

// Shared by the HTTP routes (their own guard, including the admin override) and the viewer-based run service.
// The idle check belongs inside deleteResults' lock, before the result or any file is removed.
async function deleteWorkflowResults({ store, engine, workflowId, nodeId, entryId = null, user }) {
  const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), { code, ...details }); };
  if (typeof nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(nodeId)) fail('INVALID_ID', 'Invalid node id');
  if (entryId !== null && (typeof entryId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entryId))) fail('INVALID_ID', 'Invalid entry id');
  await store.readWorkflow(workflowId);
  const outcome = await store.deleteResults(workflowId, nodeId, {
    entry: entryId, user,
    assertIdle: () => {
      // isBusy includes the start before it has read the results.
      if (engine.isBusy(workflowId)) fail('RUN_ACTIVE', 'A run is active for this workflow; wait for it or cancel it first', { runId: engine.activeRun(workflowId)?.runId || null });
    }
  });
  return { ok: true, nodeId, removed: outcome.removed, node: outcome.node, files: { deleted: outcome.files.deleted.length, kept: outcome.files.kept.length } };
}

module.exports = { deleteWorkflowResults };
