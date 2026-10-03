'use strict';

// Test support (not a test): the set-up that tests of editing nodes (lib/nodes/nodes-edit.js) need to run them on a real ffmpeg with
// clips made on the spot (lavfi sources): a registry with the basic and editing nodes, a workflow whose session holds the uploaded
// media, and small helpers to make clips and to read pixels and streams back. Nothing here is paid or reaches the network.
//
//   const h = await createEditHarness({ prefix: 'ocd-wave-' });      // { registry, dir, sessionId, def, run, upload, ... }
//   await h.ff([...ffmpeg args]);                                     // make a file in h.dir
//   const clip = await h.upload('clip.mp4', '.mp4');                  // a media value for the inputs of a node
//   const out = await h.run('video.soundwave', { video: clip }, { mode: 'line' });   // { video: value }
//   const frame = await h.frame(await h.fileOf(out.video), 1.0, 320, 180);          // rgb24 buffer of the frame at 1.0 s
//   h.count(frame, 320, { x0: 0, y0: 100, x1: 320, y1: 180 }, isRed)                // pixels of the area for which isRed(r, g, b)
//   await h.cleanup();

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const assert = require('assert/strict');

const store = require('../../lib/store');
const ffmpeg = require('../../lib/ffmpeg');
const assets = require('../../lib/nodes/assets');
const edit = require('../../lib/nodes/nodes-edit');
const nodesBasic = require('../../lib/nodes/nodes-basic');
const { createRegistry } = require('../../lib/nodes/registry');
const { createEventBus } = require('../../lib/nodes/events');
const { createWorkflowsStore } = require('../../lib/nodes/workflows-store');

const execFileAsync = promisify(execFile);

async function createEditHarness({ prefix = 'ocd-edit-', extraRegister } = {}) {
  const registry = createRegistry();
  nodesBasic.registerAll(registry);
  edit.registerAll(registry);
  if (extraRegister) extraRegister(registry);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const bus = createEventBus();
  const workflows = createWorkflowsStore({ dir, registry, events: bus });
  const created = [];
  const { workflow } = await workflows.createWorkflow({ name: prefix, graph: { nodes: [], edges: [] } });
  created.push(workflow.id);
  const sessionId = workflow.sessionId;

  const def = (type) => {
    const found = registry.get(type);
    assert.ok(found, `${type} is registered`);
    return found;
  };
  const harness = {
    registry,
    dir,
    bus,
    workflows,
    sessionId,
    created,
    def,
    params: (type, raw = {}) => registry.normalizeParams(def(type), raw),
    src: (name) => path.join(dir, name),

    async ff(args) {
      await execFileAsync(ffmpeg.binaries().ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
    },

    // width, height, duration, streams of a media file
    async probe(file) {
      const { stdout } = await execFileAsync(ffmpeg.binaries().ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
      const data = JSON.parse(stdout);
      const video = data.streams.find((stream) => stream.codec_type === 'video');
      const audio = data.streams.find((stream) => stream.codec_type === 'audio');
      return {
        width: video?.width,
        height: video?.height,
        videoCodec: video?.codec_name,
        audioCodec: audio?.codec_name,
        sampleRate: audio ? Number(audio.sample_rate) : null,
        hasAudio: Boolean(audio),
        audioDuration: audio ? Number(audio.duration) : null,
        videoDuration: video ? Number(video.duration) : null,
        duration: Number(data.format.duration)
      };
    },

    // A file of the folder as a media value (type from the extension) in the session of the workflow
    async upload(name, ext) {
      const saved = await store.saveAsset(sessionId, { kind: 'upload', buffer: await fsp.readFile(path.join(dir, name)), ext, prompt: name, cost: null });
      return assets.valueFromAsset(sessionId, saved.id);
    },

    fileOf: async (value) => assets.assetFilePath(value),

    makeCtx(signal) {
      return {
        workflowId: 'wf-test',
        runId: 'r-test',
        nodeId: 'n1',
        sessionId,
        user: 'tester',
        config: {},
        signal: signal || new AbortController().signal,
        log: () => {},
        saveOutputFile: (options) => assets.saveOutputFile(sessionId, options),
        withLocalSlot: (fn) => fn()
      };
    },

    // Runs the execute of a node type once; returns its only variant
    async run(type, inputs, raw = {}, signal) {
      const definition = def(type);
      const result = await definition.execute(harness.makeCtx(signal), inputs, registry.normalizeParams(definition, raw));
      assert.equal(result.variants.length, 1);
      return result.variants[0];
    },

    // One frame as RGB bytes, scaled to width x height (so the pixel positions are known)
    async frame(file, time, width, height) {
      const { stdout } = await execFileAsync(
        ffmpeg.binaries().ffmpeg,
        ['-nostdin', '-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:${height}:flags=neighbor`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
      );
      assert.equal(stdout.length, width * height * 3, `a frame of ${width}x${height} at ${time} s`);
      return stdout;
    },

    // Number of pixels of an area { x0, y0, x1, y1 } (x1 and y1 excluded) for which `test(r, g, b)` holds
    count(frame, width, area, test) {
      let found = 0;
      for (let y = area.y0; y < area.y1; y += 1) {
        for (let x = area.x0; x < area.x1; x += 1) {
          const at = (y * width + x) * 3;
          if (test(frame[at], frame[at + 1], frame[at + 2])) found += 1;
        }
      }
      return found;
    },

    async cleanup() {
      for (const id of created) await workflows.deleteWorkflow(id).catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };
  return harness;
}

module.exports = { createEditHarness, execFileAsync };
