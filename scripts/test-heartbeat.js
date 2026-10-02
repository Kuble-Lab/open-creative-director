'use strict';

const assert = require('node:assert/strict');

const { app } = require('../server');
const store = require('../lib/store');
const rendernode = require('../lib/rendernode');
const { handleCompleted } = require('../lib/poller');

function routeHandler(path, method = 'get') {
  const layer = app._router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeJobs(sessionId) {
  const handler = routeHandler('/api/sessions/:id/jobs');
  return new Promise((resolve, reject) => {
    const result = { status: 200, body: null };
    const res = {
      status(code) {
        result.status = code;
        return this;
      },
      json(body) {
        result.body = body;
        resolve(result);
      }
    };
    Promise.resolve(handler({ params: { id: sessionId } }, res)).catch(reject);
  });
}

async function main() {
  const session = await store.createSession();
  const originalDownload = rendernode.download;
  try {
    const asset = await store.reserveAsset(session.id, {
      kind: 'video',
      ext: '.mp4',
      prompt: 'Heartbeat-Test'
    });
    const createdAt = new Date(Date.now() - 28000).toISOString();
    const startedAt = new Date(Date.now() - 25000).toISOString();
    const job = {
      jobId: `heartbeat-${Date.now()}`,
      assetId: asset.id,
      file: asset.file,
      status: 'running',
      prompt: 'Heartbeat-Test',
      source: 'rendernode',
      provider: 'rendernode',
      renderNodeId: 'node-heartbeat',
      submittedAt: createdAt,
      createdAt,
      startedAt,
      cost: null,
      error: null
    };
    await store.mutateSession(session.id, (saved) => saved.jobs.push(job));

    const jobsResponse = await invokeJobs(session.id);
    assert.equal(jobsResponse.status, 200);
    const payloadJob = jobsResponse.body.jobs.find((entry) => entry.jobId === job.jobId);
    assert.ok(payloadJob, 'Job fehlt in /jobs-Payload');
    assert.equal(payloadJob.createdAt, createdAt);
    assert.equal(payloadJob.startedAt, startedAt);
    assert.equal(payloadJob.provider, 'rendernode');
    assert.equal(payloadJob.nodeId, 'node-heartbeat');
    assert.ok(Object.prototype.hasOwnProperty.call(payloadJob, 'nodeName'));

    rendernode.download = async () => Buffer.from('heartbeat-test-video');
    await handleCompleted(session.id, job, {});

    const completed = await store.readSession(session.id);
    const update = completed.messages.find(
      (message) => message.role === 'assistant' && message.type === 'job_update' && message.content.includes(asset.id)
    );
    assert.ok(update, 'Poller hat keine sichtbare Fertig-Meldung geschrieben');
    assert.equal(update.hidden, false);
    assert.match(update.content, /fertig gerendert/);
    assert.match(update.content, /✅/);
    assert.equal(completed.jobs.find((entry) => entry.jobId === job.jobId)?.status, 'completed');
  } finally {
    rendernode.download = originalDownload;
    await store.deleteSession(session.id);
  }

  console.log('heartbeat ok: sichtbare Poller-Meldung und erweiterte /jobs-Payload');
  console.log('test-heartbeat.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
