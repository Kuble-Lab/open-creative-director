'use strict';

const assert = require('node:assert/strict');
const { createIsolatedApp } = require('./support/isolated-app');

function testPlan(kling4) {
  const text = kling4.plan({ prompt: '  A quiet lake.  ' });
  assert.deepEqual(text, {
    params: {
      model: 'kling4_0', prompt: 'A quiet lake.', use_unlim: false,
      mode: 'text-to-video', aspect_ratio: '16:9', resolution: '720p', duration: 5
    },
    frames: [],
    prompt: 'A quiet lake.'
  });
  assert.equal(kling4.plan({ prompt: 'Lake', aspect_ratio: 'unsupported' }).params.aspect_ratio, '16:9');
  assert.equal(kling4.plan({ prompt: 'Lake', aspect_ratio: '9:16' }).params.aspect_ratio, '9:16');

  const image = kling4.plan({ prompt: 'Lake', first_frame_asset_id: 'img-001', aspect_ratio: '16:9' });
  assert.equal(image.params.mode, 'image-to-video');
  assert.equal(image.params.aspect_ratio, 'auto');
  assert.deepEqual(image.frames, [{ assetId: 'img-001', role: 'start_image' }]);
  const frames = kling4.plan({ prompt: 'Lake', first_frame_asset_id: 'img-001', last_frame_asset_id: 'img-002' });
  assert.equal(frames.params.mode, 'image-to-video');
  assert.equal(frames.params.aspect_ratio, 'auto');
  assert.deepEqual(frames.frames, [
    { assetId: 'img-001', role: 'start_image' },
    { assetId: 'img-002', role: 'end_image' }
  ]);

  for (const key of ['reference_asset_ids', 'reference_video_asset_ids', 'reference_audio_asset_ids']) {
    assert.throws(() => kling4.plan({ prompt: 'Lake', [key]: ['ref-001'] }), {
      message: 'Kling 4.0 (Higgsfield): im Chat nur Start- und Endbild, keine Referenzdateien. Es wurde nichts eingereicht.'
    });
  }
  assert.throws(() => kling4.plan({ prompt: 'Lake', last_frame_asset_id: 'img-002' }), {
    message: 'Kling 4.0 (Higgsfield): ein Endbild braucht ein Startbild. Es wurde nichts eingereicht.'
  });
  assert.throws(() => kling4.plan({ prompt: 'Lake', mode: 'image_to_video' }), { message: 'first_frame_asset_id fehlt' });
  assert.throws(() => kling4.plan({ prompt: '  ' }), { message: 'prompt fehlt' });
  for (const duration of [2, 31, NaN]) {
    assert.throws(() => kling4.plan({ prompt: 'Lake', duration_seconds: duration }), {
      message: 'Kling 4.0 (Higgsfield): Dauer 3 bis 30 s. Es wurde nichts eingereicht.'
    });
  }
  for (const duration of [3, 30]) {
    for (const resolution of ['720p', '1080p']) {
      const { params } = kling4.plan({ prompt: 'Lake', duration_seconds: duration, resolution });
      assert.equal(params.duration, duration);
      assert.equal(params.resolution, resolution);
    }
  }
  for (const resolution of ['480p', '4k']) {
    assert.throws(() => kling4.plan({ prompt: 'Lake', resolution }), {
      message: 'Kling 4.0 (Higgsfield): Aufloesung 720p oder 1080p. Es wurde nichts eingereicht.'
    });
  }
}

async function testOptions(iso) {
  const higgsfield = iso.load('lib/higgsfield');
  const discovery = iso.load('lib/discovery');
  const videoModels = iso.load('lib/video-models');
  const originalStatus = higgsfield.status;
  const originalList = discovery.listVideoModels;
  const hasKling = async (args = {}) => {
    const { options } = await videoModels.listOptions({ prompt: 'Lake', ...args }, 'higgsfield/kling4_0');
    return options.some((option) => option.id === 'higgsfield/kling4_0');
  };
  try {
    // A provider catalogue entry must not make a disconnected synthetic model visible.
    discovery.listVideoModels = async () => ({ data: [{ id: 'higgsfield/kling4_0' }] });
    higgsfield.status = () => ({ connected: false });
    assert.equal(await hasKling(), false);
    higgsfield.status = () => ({ connected: true });
    assert.equal(await hasKling(), true);
    for (const key of ['reference_asset_ids', 'reference_video_asset_ids', 'reference_audio_asset_ids']) {
      assert.equal(await hasKling({ [key]: ['ref-001'] }), false, `${key}: Kling must not be offered`);
    }
  } finally {
    higgsfield.status = originalStatus;
    discovery.listVideoModels = originalList;
  }
}

async function testExecuteTool(iso) {
  const higgsfield = iso.load('lib/higgsfield');
  const store = iso.load('lib/store');
  const { executeTool } = iso.load('lib/tools');
  const originalStatus = higgsfield.status;
  const originalMcpCall = higgsfield.mcpCall;
  const calls = [];
  const events = [];
  let session;
  try {
    higgsfield.status = () => ({ connected: true });
    higgsfield.mcpCall = async (name, args, options) => {
      calls.push({ name, args, options });
      assert.equal(name, 'generate_video_batch');
      return 'Submitted 1/1 video generations.\n- index 0: 11111111-1111-4111-8111-111111111111 (pending)';
    };
    store.ensureDirs();
    session = await store.createSession();
    const result = await executeTool({
      sessionId: session.id,
      config: { videoModel: 'higgsfield/kling4_0' },
      selectedVideoModel: true,
      videoModelRequestId: 'request-kling4-test',
      user: 'test@example.test',
      emit: (event) => events.push(event)
    }, 'generate_video', { prompt: 'A quiet lake.', duration_seconds: 7, resolution: '1080p' });
    assert.deepEqual(calls, [{
      name: 'generate_video_batch',
      args: { requests: [{ index: 0, params: {
        model: 'kling4_0', prompt: 'A quiet lake.', use_unlim: false,
        mode: 'text-to-video', aspect_ratio: '16:9', resolution: '1080p', duration: 7
      } }] },
      options: { retry: 'submit' }
    }]);
    const saved = await store.readSession(session.id);
    assert.equal(saved.jobs.length, 1);
    const job = saved.jobs[0];
    assert.equal(job.jobId, '11111111-1111-4111-8111-111111111111');
    assert.equal(job.provider, 'higgsfield');
    assert.equal(job.model, 'kling4_0');
    assert.equal(job.kind, 'video');
    assert.equal(job.status, 'pending');
    assert.equal(job.videoModelRequestId, 'request-kling4-test');
    assert.deepEqual(result.job, job);
    assert.ok(events.some((event) => event.type === 'generation_job'));
  } finally {
    higgsfield.status = originalStatus;
    higgsfield.mcpCall = originalMcpCall;
    if (session) {
      // Close the fake pending jobs before deletion, just as terminal jobs are closed by the poller.
      await store.mutateSession(session.id, (saved) => {
        for (const job of saved.jobs) Object.assign(job, { status: 'cancelled', accountingStatus: 'booked' });
      });
      await store.deleteSession(session.id);
    }
  }
}

async function main() {
  // Keep sessions and the cost journal outside the repository; no server or real network calls.
  const iso = await createIsolatedApp({ loadServer: false, active: false });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network forbidden in test-higgsfield-kling4'); };
  try {
    testPlan(iso.load('lib/higgsfield-kling4'));
    await testOptions(iso);
    await testExecuteTool(iso);
  } finally {
    global.fetch = originalFetch;
    await iso.cleanup();
  }
  console.log('test-higgsfield-kling4.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
