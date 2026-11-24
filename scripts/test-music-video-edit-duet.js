'use strict';

// Duet performance clips have their own input list, but keep the timing of a solo performance: each starts with its scene, a longer clip
// is trimmed and a shorter one holds its last frame without slowing the lips. The real node adapter and the pure edit builders run here;
// only the disk/render boundary is replaced, so no files, provider calls or network access are needed. The existing edit test also holds
// fingerprints of the pre-duet ffmpeg plans; this test covers the adapter's file order, log and cache key with an unwired duet input.

const assert = require('assert/strict');
const planLib = require('../lib/music-video-plan');
const editLib = require('../lib/music-video-edit');
const ops = require('../lib/nodes/ffmpeg-ops');
const assets = require('../lib/nodes/assets');
const nodesEdit = require('../lib/nodes/nodes-edit');
const { textValue, listValue } = require('../lib/nodes/types');

const PARAMS = { transition: 'cut', resolution: '720p', fps: '25', fit: 'crop', fade_out: 0, captions: 'off' };
const song = { type: 'audio', file: 'song.wav', duration: 100 };
const clip = (name, duration = 6) => ({ type: 'video', file: `${name}.mp4`, duration });
const makeShot = (index, kind, number, voice) => ({
  start: 10 + index * 5.2,
  end: 10 + (index + 1) * 5.2,
  kind,
  clip: number,
  ...(voice ? { voice } : {})
});
const mixed = {
  aspect_ratio: '16:9',
  shots: [
    makeShot(0, 'story', 0),
    makeShot(1, 'performance', 0, 'duet'),
    makeShot(2, 'performance', 0, 'lead'),
    makeShot(3, 'still', 0),
    makeShot(4, 'performance', 1, 'duet'),
    makeShot(5, 'performance', 1, 'guest'),
    makeShot(6, 'story', 1)
  ]
};

function testParseShots() {
  const parsed = planLib.parseShots(JSON.stringify({ ...mixed, performance: 99, duet: 99 }));
  assert.deepEqual([parsed.story, parsed.performance, parsed.still, parsed.duet], [2, 2, 1, 2], 'counts come from the scenes, not the supplied totals');
  assert.deepEqual(parsed.shots.filter((shot) => shot.voice === 'duet').map((shot) => shot.clip), [0, 1]);
  assert.deepEqual(parsed.shots.filter((shot) => shot.kind === 'performance' && shot.voice !== 'duet').map((shot) => shot.clip), [0, 1]);
  const refuse = (position, number, message) => {
    const changed = structuredClone(mixed);
    changed.shots[position].clip = number;
    assert.throws(() => planLib.parseShots(changed), (err) => err.code === 'MUSICVIDEO_SHOTS_INVALID' && message.test(err.message));
  };
  refuse(4, 0, /valid clip number/);
  refuse(4, 2, /The duet clips are not numbered 0 to 1 \(clip 1 is missing\)/);
  refuse(1, 2, /The duet clips are not numbered 0 to 1 \(clip 0 is missing\)/);
  refuse(1, -1, /valid clip number/);
  refuse(1, 0.5, /valid clip number/);
  refuse(5, 0, /valid clip number/);
  refuse(5, 2, /The performance clips are not numbered 0 to 1 \(clip 1 is missing\)/);
  const onlyDuet = planLib.parseShots({ shots: [makeShot(0, 'performance', 0, 'duet')] });
  assert.deepEqual([onlyDuet.story, onlyDuet.performance, onlyDuet.still, onlyDuet.duet], [0, 0, 0, 1]);
  const storyVoice = planLib.parseShots({ shots: [makeShot(0, 'story', 0, 'duet')] });
  assert.deepEqual([storyVoice.story, storyVoice.duet], [1, 0], 'voice alone does not turn a story into a duet');
  assert.deepEqual(planLib.SHOT_KINDS, ['story', 'performance', 'still'], 'duet remains a performance voice, not a new shot kind');
}

async function testNode() {
  const calls = [];
  const output = clip('finished');
  const originalRunOp = nodesEdit.runOp;
  const originalPath = assets.assetFilePath;
  const originalFetch = global.fetch;
  // Patch before loading the adapter: it captures runOp once. The builder still receives probes in exactly the collected file order.
  nodesEdit.runOp = async (_ctx, operation) => {
    const infos = operation.files.map((file) => {
      const value = probes.get(file);
      assert.ok(value, `a probe exists for ${file}`);
      return value;
    });
    const built = await operation.build(infos, { scratch: '/unused' });
    calls.push({ files: operation.files, infos, built });
    return [output];
  };
  assets.assetFilePath = (value) => `/${value.file}`;
  global.fetch = () => { throw new Error('Network access is forbidden in the duet edit test'); };
  const probes = new Map();
  const probeInputs = (inputs) => {
    for (const value of Object.values(inputs)) {
      for (const item of value?.type === 'list' ? value.items : [value]) {
        if (item?.file) probes.set(`/${item.file}`, { duration: item.duration, audio: {}, video: item.type === 'video' ? {} : null });
      }
    }
  };
  try {
    const engine = require('../lib/nodes/engine');
    const definition = require('../lib/nodes/nodes-music-video').definitions.find((def) => def.type === 'music_video.edit');
    const port = definition.inputs.find((input) => input.id === 'duet');
    assert.deepEqual(port, { id: 'duet', type: 'video', multiple: true, max: planLib.MAX_SHOTS });
    assert.deepEqual(definition.inputs.map((input) => input.id), ['song', 'shots', 'story', 'performance', 'still_clips', 'duet', 'captions']);
    const run = async (inputs, params = PARAMS) => {
      probeInputs(inputs);
      const logs = [];
      const result = await definition.execute({ log: (line) => logs.push(line) }, inputs, params);
      assert.equal(result.variants[0].video, output);
      return { ...calls.at(-1), logs };
    };
    const inputs = {
      song,
      shots: textValue(JSON.stringify(mixed)),
      story: listValue('video', [clip('story-0', 7), clip('story-1', 5)]),
      performance: listValue('video', [clip('solo-0', 4), clip('solo-1', 6)]),
      still_clips: listValue('video', [clip('still-0', 4.5)]),
      duet: listValue('video', [clip('duet-0', 6), clip('duet-1', 3)])
    };
    const cut = await run(inputs);
    assert.deepEqual(cut.files, ['/song.wav', '/story-0.mp4', '/story-1.mp4', '/solo-0.mp4', '/solo-1.mp4', '/still-0.mp4', '/duet-0.mp4', '/duet-1.mp4']);
    assert.deepEqual(cut.built.batches.map((batch) => batch.inputs), [[1, 6, 3], [5, 7, 4], [2]], 'each scene reads its own list, including duets after stills');
    assert.ok(cut.logs[0].includes(', 2 duet scenes'));
    const order = [1, 6, 3, 5, 7, 4, 2];
    const shots = planLib.parseShots(mixed);
    for (const transition of editLib.TRANSITIONS) {
      const params = { ...PARAMS, transition };
      const built = (await run(inputs, params)).built;
      const single = editLib.buildEditPlan({ shots, order, infos: cut.infos, params, batchScenes: planLib.MAX_SHOTS });
      assert.deepEqual(built.summary, single.summary, `${transition}: batching preserves every scene's timing`);
      for (const index of [1, 4]) {
        assert.equal(built.summary[index].speed, 1, `${transition}: even a short duet is never slowed down`);
        assert.equal(built.summary[index].frames, 130, 'each scene ends at its boundary');
        const chain = single.spec.graph.split(';')[index];
        assert.ok(chain.startsWith(`[${order[index]}:v]setpts=PTS-STARTPTS,`), 'the duet begins at the start of its clip');
        assert.doesNotMatch(chain, /setpts=[\d.]+\*PTS/, 'the duet keeps its original playback speed');
        assert.match(chain, /tpad=stop=\d+:stop_mode=clone,trim=end_frame=/, 'short clips hold their last frame and long clips are trimmed');
        const frames = 130 + (transition === 'crossfade' ? 6 : 0);
        assert.ok(chain.includes(`trim=end_frame=${frames},`), 'only the existing crossfade tail runs beyond the scene boundary');
      }
      assert.deepEqual(single.spec.outputs[0].maps, ['[v]', '[a]']);
      assert.match(single.spec.graph, /\[0:a\]atrim=start=10:end=46.4/);
      assert.doesNotMatch(single.spec.graph, /\[[1-9]\d*:a\]/, 'clip audio never reaches the master song');
      assert.ok(built.batches.every((batch) => editLib.batchArgs(batch, cut.files).includes('-an')), 'batch clips are silent too');
    }

    const mismatch = async (values, expected, got) => {
      const before = calls.length;
      await assert.rejects(() => definition.execute({}, values, PARAMS), (err) => {
        assert.equal(err.code, 'MUSICVIDEO_DUET_MISMATCH');
        assert.deepEqual(err.data, { expected, got });
        return true;
      });
      assert.equal(calls.length, before, 'a mismatch is refused before probing or rendering');
    };
    await mismatch({ ...inputs, duet: undefined }, 2, 0);
    await mismatch({ ...inputs, duet: listValue('video', []) }, 2, 0);
    await mismatch({ ...inputs, duet: listValue('video', [clip('one')]) }, 2, 1);
    await mismatch({ ...inputs, duet: listValue('video', [clip('one'), clip('two'), clip('three')]) }, 2, 3);

    const legacyShots = { shots: [makeShot(0, 'story', 0), makeShot(1, 'performance', 0), makeShot(2, 'still', 0)] };
    const legacyInputs = {
      song,
      shots: textValue(JSON.stringify(legacyShots)),
      story: listValue('video', [clip('story')]),
      performance: listValue('video', [clip('solo')]),
      still_clips: listValue('video', [clip('still')])
    };
    await mismatch({ ...legacyInputs, duet: clip('extra') }, 0, 1);
    assert.equal(planLib.parseShots(legacyShots).duet, 0);
    const argsOf = (value) => ops.assembleArgs(value.built.spec, value.files, ['/out.mp4']);
    for (const transition of editLib.TRANSITIONS) {
      const params = { ...PARAMS, transition };
      const unwired = await run(legacyInputs, params);
      const empty = await run({ ...legacyInputs, duet: listValue('video', []) }, params);
      const omitted = await run({ ...legacyInputs, duet: undefined }, params);
      assert.deepEqual(unwired.files, ['/song.wav', '/story.mp4', '/solo.mp4', '/still.mp4']);
      const before = editLib.buildEditPlan({ shots: planLib.parseShots(legacyShots), order: [1, 2, 3], infos: unwired.infos, params });
      assert.deepEqual(unwired.built, before, 'a plan without duets keeps the original file indexes and edit plan');
      assert.deepEqual(empty.built, before);
      assert.deepEqual(omitted.built, before);
      assert.deepEqual(argsOf(empty), argsOf(unwired), 'an empty optional list leaves every ffmpeg argument unchanged');
      assert.deepEqual(argsOf(omitted), argsOf(unwired));
      assert.deepEqual(unwired.logs, ['3 scenes, 16 s at 25 fps, 1280x720'], 'the original log is unchanged without duets');
    }
    const edges = Object.keys(legacyInputs).map((id) => ({ from: { node: id, port: id }, to: { node: 'cut', port: id } }));
    const resolve = (inputs) => engine.resolveNodeInputs({ node: { id: 'cut' }, ports: { inputs }, params: PARAMS, edges, outputsOf: (id) => ({ [id]: legacyInputs[id] }), maxListItems: 50 }).inputs;
    const beforeInputs = resolve(definition.inputs.filter((input) => input.id !== 'duet'));
    const afterInputs = resolve(definition.inputs);
    assert.deepEqual(afterInputs, beforeInputs, 'an unwired optional port does not enter the resolved inputs');
    assert.equal(engine.computeCacheKey({ ...definition, version: 1 }, PARAMS, afterInputs), engine.computeCacheKey({ ...definition, version: 1 }, PARAMS, beforeInputs), 'existing workflows keep their cache keys');

    // The old "50 clips" description predates MAX_SHOTS=120 for the HUD planner. Matching each input count to its scenes enforces that
    // existing total limit across all lists; adding another port must neither multiply it nor reduce accepted legacy films to 50 scenes.
    const counters = { story: 0, performance: 0, still: 0, duet: 0 };
    const many = Array.from({ length: planLib.MAX_SHOTS }, (_unused, index) => {
      const kind = ['story', 'performance', 'still', 'duet'][index % 4];
      return makeShot(index, kind === 'duet' ? 'performance' : kind, counters[kind]++, kind === 'duet' ? 'duet' : undefined);
    });
    const manyInputs = { song, shots: textValue(JSON.stringify({ shots: many })) };
    for (const [kind, count] of Object.entries(counters)) manyInputs[kind === 'still' ? 'still_clips' : kind] = listValue('video', Array.from({ length: count }, (_unused, index) => clip(`${kind}-${index}`)));
    assert.equal((await run(manyInputs)).built.summary.length, planLib.MAX_SHOTS);
    await assert.rejects(() => definition.execute({}, { ...manyInputs, shots: textValue(JSON.stringify({ shots: [...many, makeShot(many.length, 'performance', counters.duet, 'duet')] })) }, PARAMS), (err) => err.code === 'MUSICVIDEO_SHOTS_INVALID' && /At most 120 scenes/.test(err.message));
    assert.ok(definition.description.includes(`Up to ${planLib.MAX_SHOTS} clips in total.`));
    const onlyDuetInputs = { song, shots: textValue(JSON.stringify({ shots: [makeShot(0, 'performance', 0, 'duet')] })), story: listValue('video', []), duet: clip('only-duet') };
    assert.deepEqual((await run(onlyDuetInputs)).files, ['/song.wav', '/only-duet.mp4'], 'a single value is accepted as a list of one duet');
  } finally {
    nodesEdit.runOp = originalRunOp;
    assets.assetFilePath = originalPath;
    global.fetch = originalFetch;
  }
}

async function main() {
  testParseShots();
  await testNode();
  console.log('test-music-video-edit-duet.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
