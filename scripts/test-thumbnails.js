'use strict';

// Small copies of asset images (lib/thumbnails.js) and the cached workflow list (lib/nodes/workflows-store.js listWorkflows).
// Needs ffmpeg for the first part; without it that part is skipped.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ffmpeg = require('../lib/ffmpeg');
const thumbnails = require('../lib/thumbnails');
const store = require('../lib/store');
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore } = require('../lib/nodes/workflows-store');

async function probeWidth(file) {
  const { stdout } = await ffmpeg.runProcess(ffmpeg.binaries().ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]);
  const stream = JSON.parse(stdout).streams[0];
  return { width: stream.width, height: stream.height };
}

function testPickWidth() {
  assert.equal(thumbnails.pickWidth(undefined), null);
  assert.equal(thumbnails.pickWidth('abc'), null);
  assert.equal(thumbnails.pickWidth('0'), null);
  assert.equal(thumbnails.pickWidth('1'), 96);
  assert.equal(thumbnails.pickWidth('96'), 96);
  assert.equal(thumbnails.pickWidth('300'), 320);
  assert.equal(thumbnails.pickWidth('5000'), 640, 'never larger than the largest width');
  assert.ok(thumbnails.isImageFile('a/b.PNG'));
  assert.ok(!thumbnails.isImageFile('a/b.mp4'));
}

async function testThumbnailer() {
  const { ffmpeg: bin, available } = ffmpeg.binaries();
  if (!available) {
    console.log('  (ffmpeg missing: thumbnailer part skipped)');
    return;
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-thumbs-'));
  const assetsDir = path.join(root, 'assets');
  const cacheDir = path.join(root, 'cache');
  try {
    await fsp.mkdir(path.join(assetsDir, 'sess-1'), { recursive: true });
    const source = path.join(assetsDir, 'sess-1', 'big.png');
    await ffmpeg.runProcess(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1600x900', '-frames:v', '1', '-y', source]);
    const small = path.join(assetsDir, 'sess-1', 'small.jpg');
    await ffmpeg.runProcess(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=200x100', '-frames:v', '1', '-y', small]);
    await fsp.writeFile(path.join(assetsDir, 'sess-1', 'broken.png'), 'not an image');

    let runs = 0;
    const realRun = ffmpeg.runProcess;
    ffmpeg.runProcess = (...args) => { runs += 1; return realRun(...args); };
    try {
      const thumbs = thumbnails.createThumbnailer({ assetsDir, cacheDir });
      const [a, b] = await Promise.all([thumbs.get('sess-1/big.png', '320'), thumbs.get('sess-1/big.png', '300')]);
      assert.ok(a && b, 'a copy is made');
      assert.equal(a.file, b.file, 'both requests get the same copy');
      assert.ok(a.file.startsWith(cacheDir), 'the copy lives in the cache, not in the assets');
      assert.equal(runs, 1, 'one ffmpeg run for both requests');
      const dims = await probeWidth(a.file);
      assert.equal(dims.width, 320);
      assert.equal(dims.height, 180, 'the side ratio stays');
      assert.ok((await fsp.stat(a.file)).size < (await fsp.stat(source)).size);
      const generated = runs;
      const again = await thumbs.get('sess-1/big.png', 320);
      assert.equal(again.file, a.file);
      assert.equal(runs, generated, 'a second request reads the cache');

      // never enlarged
      const tiny = await thumbs.get('sess-1/small.jpg', 640);
      assert.equal((await probeWidth(tiny.file)).width, 200);

      // a newer original makes a new copy
      const later = new Date(Date.now() + 5000);
      await fsp.utimes(source, later, later);
      await thumbs.get('sess-1/big.png', 320);
      assert.ok(runs > generated, 'a changed original is copied again');

      // no copy for what is no image, is missing or cannot be read: the caller sends the original
      assert.equal(await thumbs.get('sess-1/big.png', undefined), null);
      assert.equal(await thumbs.get('sess-1/clip.mp4', 320), null);
      assert.equal(await thumbs.get('sess-1/missing.png', 320), null);
      const warn = console.warn;
      console.warn = () => {};
      try {
        assert.equal(await thumbs.get('sess-1/broken.png', 320), null);
        const before = runs;
        assert.equal(await thumbs.get('sess-1/broken.png', 320), null);
        assert.equal(runs, before, 'an unreadable image is not tried again');
      } finally {
        console.warn = warn;
      }
      assert.deepEqual((await fsp.readdir(path.join(cacheDir, 'sess-1'))).filter((name) => name.includes('.tmp.')), [], 'no temp files left');
    } finally {
      ffmpeg.runProcess = realRun;
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function testListCache() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-wf-list-'));
  const wfStore = createWorkflowsStore({ dir, events: createEventBus() });
  const created = [];
  try {
    const one = await wfStore.createWorkflow({ name: 'Alpha', owner: 'anna@example.com' });
    const two = await wfStore.createWorkflow({ name: 'Beta' });
    created.push(one.workflow, two.workflow);

    const first = await wfStore.listWorkflows({ includeSharing: true });
    assert.equal(first.length, 2);
    const alpha = first.find((item) => item.id === one.workflow.id);
    assert.equal(alpha.owner, 'anna@example.com');
    assert.equal(alpha.shareMode, 'private');

    // the caller changes its copy: the next list is not affected
    alpha.name = 'changed by a caller';
    alpha.app.enabled = true;
    alpha.sharedWith.push('x@example.com');
    const second = await wfStore.listWorkflows({ includeSharing: true });
    const alphaAgain = second.find((item) => item.id === one.workflow.id);
    assert.equal(alphaAgain.name, 'Alpha');
    assert.equal(alphaAgain.app.enabled, false);
    assert.deepEqual(alphaAgain.sharedWith, []);

    // without includeSharing there are no sharing fields
    const plain = await wfStore.listWorkflows();
    for (const item of plain) {
      for (const key of ['owner', 'shareMode', 'sharedWith', 'createdAt', 'teamId']) assert.ok(!(key in item), `${key} not in the plain list`);
    }

    // a change on disk shows at once
    const { workflow } = await wfStore.getWorkflow(two.workflow.id);
    await wfStore.saveGraph(two.workflow.id, { baseRev: workflow.rev, graph: workflow.graph, name: 'Beta renamed' });
    const renamed = (await wfStore.listWorkflows()).find((item) => item.id === two.workflow.id);
    assert.equal(renamed.name, 'Beta renamed');
    assert.deepEqual((await wfStore.listWorkflows({ q: 'renamed' })).map((item) => item.id), [two.workflow.id]);

    // a deleted workflow leaves the list
    await wfStore.deleteWorkflow(one.workflow.id);
    created.shift();
    assert.deepEqual((await wfStore.listWorkflows()).map((item) => item.id), [two.workflow.id]);
  } finally {
    for (const workflow of created) {
      await wfStore.deleteWorkflow(workflow.id).catch(() => {});
      await store.deleteSession(workflow.sessionId).catch(() => {});
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  testPickWidth();
  await testThumbnailer();
  await testListCache();
  console.log('test-thumbnails.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
