'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const models = require('../lib/timeline/models');
const { registry } = require('../lib/nodes/registry');
const { textValue, listValue } = require('../lib/nodes/types');

const json = (value) => textValue(JSON.stringify(value));
const videos = (...durations) => listValue('video', durations.map((duration) => ({ type: 'video', duration })));

function testMusicVideo() {
  const plan = { shots: [
    { start: 0, end: 2, kind: 'performance', voice: 'duet', clip: 0, section: 'Verse', line: 'Together' },
    { start: 2, end: 4, kind: 'performance', clip: 0, section: 'Verse', line: 'Lead' },
    { start: 4, end: 6, kind: 'performance', voice: 'guest', clip: 1, section: 'Chorus', line: 'Guest' },
    { start: 6, end: 8, kind: 'story', clip: 0, section: 'Chorus' },
    { start: 8, end: 10, kind: 'still', clip: 0, section: 'End' }
  ] };
  const inputs = { shots: json(plan) }, snapshot = JSON.stringify(inputs);
  const model = models.musicVideo({ inputs });
  assert.deepEqual(model.audio, { port: 'song', item: null });
  assert.equal(model.duration, 10);
  assert.deepEqual(model.clips.map(({ key, kind, port, item, lipsync }) => [key, kind, port, item, lipsync]), [
    ['duet:0', 'duet', 'duet', 0, true], ['performance:0', 'performance', 'performance', 0, true],
    ['performance:1', 'guest', 'performance', 1, true], ['story:0', 'story', 'story', 0, false], ['still:0', 'still', 'still_clips', 0, false]
  ]);
  assert.deepEqual(model.sections, [{ start: 0, end: 4, name: 'Verse' }, { start: 4, end: 8, name: 'Chorus' }, { start: 8, end: 10, name: 'End' }]);
  assert.equal(model.lines[2].voice, 'guest');
  const lines = [{ start: 0.1, end: 1.9, text: 'We sing', voice: 'lead' }, { start: 2.1, end: 3.5, text: 'I sing', voice: 'guest' }];
  assert.deepEqual(models.musicVideo({ inputs: { ...inputs, captions: json({ lines }) } }).lines, lines);
  assert.deepEqual(models.musicVideo({ inputs: { ...inputs, captions: json({ lines: [null, ...lines] }) } }).lines, lines);
  assert.equal(JSON.stringify(inputs), snapshot, 'adapters do not mutate inputs');
  assert.equal(models.musicVideo({ inputs: { shots: textValue('broken') } }), null);
  // Both ad-spot templates and every HUD template use the same cutting node/adapter.
  const templates = path.join(__dirname, '../lib/nodes/templates');
  for (const name of fs.readdirSync(templates).filter((name) => /^(music-video-hud|ad-spot).*\.json$/.test(name))) {
    const template = JSON.parse(fs.readFileSync(path.join(templates, name), 'utf8'));
    const graph = template.graph || template;
    assert.ok(graph.nodes.some((node) => node.type === 'music_video.edit'), name);
  }
  const adPlan = { shots: [{ start: 0, end: 7, kind: 'story', clip: 0, section: 'hook' }, { start: 7, end: 10, kind: 'still', clip: 0, section: 'endcard' }] };
  assert.equal(models.musicVideo({ inputs: { shots: json(adPlan) } }).clips[1].port, 'still_clips');
}

function testExplainer() {
  const inputs = { shots: json({ scenes: [{ id: 's1', title: 'Start', narration: 'Hello' }, { id: 's2', kind: 'clip', clip: 0 }] }),
    scenes: videos(3, 6), clips: videos(9), timing: listValue('text', [json({ duration: 2.6, words: [] }), json({ duration: 3.6, words: [] })]),
    intro: { type: 'video', duration: 2 }, outro: { type: 'video', duration: 1 } };
  const model = models.explainer({ inputs, params: { transition: 'cut', fps: 30 } });
  assert.equal(model.audio, null);
  assert.deepEqual(model.clips.map((clip) => [clip.key, clip.start, clip.duration, clip.port, clip.item]), [
    ['intro', 0, 2, 'intro', null], ['scene:s1', 2, 3, 'scenes', 0], ['scene:s2', 5, 4, 'clips', 0], ['outro', 9, 1, 'outro', null]
  ]);
  assert.deepEqual(model.clips[2].sound, { port: 'audio', item: 1 });
  assert.equal(model.duration, 10);
  const faded = models.explainer({ inputs: { ...inputs, intro: undefined, outro: undefined }, params: { fps: 30 } });
  assert.equal(faded.clips[1].start, 82 / 30, 'crossfade owns eight frames at 30 fps');
  const fallback = models.explainer({ inputs: { ...inputs, clips: undefined }, params: { transition: 'cut' } });
  assert.equal(fallback.clips[2].port, 'scenes', 'the cutter keeps a plain scene when no replacement clip arrived');
  assert.equal(fallback.clips[2].duration, 6);
  const planned = models.explainer({ inputs: { ...inputs, scenes: undefined, intro: undefined, outro: undefined }, params: { transition: 'cut' } });
  assert.equal(planned.clips[0].duration, 3, 'timing supplies slots before the scene is rendered');
  assert.equal(models.explainer({ inputs: {} }), null);
  assert.equal(models.explainer({ inputs: { shots: json({ scenes: [null] }) } }), null);
}

function testConcatAndEvent() {
  const model = models.concat({ inputs: { clips: videos(1.7, 2.2, 4.1) } });
  assert.deepEqual(model.clips.map((clip) => clip.start), [0, 1.7, 3.9000000000000004]);
  assert.equal(model.duration, 8);
  assert.equal(model.audio, null);
  assert.equal(models.concat({ inputs: { clips: videos(1, undefined) } }), null, 'unknown lengths never become invented times');
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'support/event-video/shots-60.json'), 'utf8'));
  const event = models.eventVideo({ inputs: { shots: json(plan) } });
  assert.equal(event.duration, plan.duration);
  assert.equal(event.clips.length, plan.shots.length);
  assert.equal(event.clips[0].key, `scene:${plan.shots[0].id}`);
  assert.ok(event.clips.every((clip) => clip.duration > 0 && Number.isInteger(clip.item)));
  assert.equal(models.eventVideo({ inputs: { shots: json({ shots: [] }) } }), null);
  for (const [type, adapter] of [['music_video.edit', models.musicVideo], ['explainer.edit', models.explainer], ['video.concat', models.concat], ['event_video.cut', models.eventVideo]]) {
    assert.equal(registry.get(type).timeline, adapter);
  }
}

testMusicVideo();
testExplainer();
testConcatAndEvent();
console.log('test-timeline-models.js: ok');
