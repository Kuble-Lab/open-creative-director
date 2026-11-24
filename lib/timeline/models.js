'use strict';

// Pure adapters: only resolved values and stored metadata, never execution or probing.
const musicPlan = require('../music-video-plan');
const explainerEdit = require('../explainer-edit');
const cues = require('../explainer-cues');
const eventContract = require('../event-video/contract');
const eventCut = require('../event-video/cut');

const itemsOf = (value) => value?.type === 'list' ? value.items : value ? [value] : [];
const secondsOf = (value) => Number.isFinite(value?.duration) && value.duration > 0 ? value.duration : null;
function jsonOf(value) {
  try { return typeof value?.value === 'string' ? JSON.parse(value.value) : null; } catch (_) { return null; }
}

function sectionsOf(shots) {
  const sections = [];
  for (const shot of shots) {
    if (!shot.section) continue;
    const previous = sections.at(-1);
    if (previous?.name === shot.section && Math.abs(previous.end - shot.start) < 0.01) previous.end = shot.end;
    else sections.push({ start: shot.start, end: shot.end, name: shot.section });
  }
  return sections;
}

function musicVideo({ inputs = {} }) {
  let plan;
  try { plan = musicPlan.parseShots(inputs.shots?.value); } catch (_) { return null; }
  const clips = plan.shots.map((shot) => {
    const performance = shot.kind === 'performance';
    const kind = performance && ['duet', 'guest'].includes(shot.voice) ? shot.voice : shot.kind;
    const port = kind === 'duet' ? 'duet' : performance ? 'performance' : kind === 'still' ? 'still_clips' : 'story';
    // Guest and solo clips share the performance list and its numbering.
    const keyKind = performance && kind !== 'duet' ? 'performance' : kind;
    return { key: `${keyKind}:${shot.clip}`, start: shot.start, duration: shot.duration, kind,
      label: shot.section || '', text: typeof shot.line === 'string' ? shot.line : '', port, item: shot.clip, lipsync: performance };
  });
  const timed = jsonOf(inputs.captions)?.lines || plan.lines;
  const lines = Array.isArray(timed) ? timed.filter((line) => line && Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start && typeof line.text === 'string')
    .map(({ start, end, text, voice }) => ({ start, end, text, ...(voice ? { voice } : {}) })) : [];
  if (!lines.length) for (const shot of plan.shots) if (typeof shot.line === 'string' && shot.line) {
    lines.push({ start: shot.start, end: shot.end, text: shot.line, ...(shot.voice ? { voice: shot.voice } : {}) });
  }
  return { duration: plan.shots.at(-1).end, audio: { port: 'song', item: null }, sections: sectionsOf(plan.shots), lines, clips };
}

function explainer({ inputs = {}, params = {} }) {
  const plan = jsonOf(inputs.shots);
  if (!Array.isArray(plan?.scenes) || !plan.scenes.length || plan.scenes.some((scene) => !scene || typeof scene !== 'object')) return null;
  const scenes = itemsOf(inputs.scenes), generated = itemsOf(inputs.clips), timings = itemsOf(inputs.timing).map(jsonOf);
  const clips = [];
  const durations = [];
  function add(clip, duration) { clips.push(clip); durations.push(duration); }
  if (inputs.intro) add({ key: 'intro', kind: 'intro', label: '', text: '', port: 'intro', item: null, lipsync: false }, secondsOf(inputs.intro));
  plan.scenes.forEach((scene, index) => {
    const usesClip = scene.kind === 'clip' && Number.isInteger(scene.clip) && Boolean(generated[scene.clip]);
    const duration = usesClip ? (timings[index] && cues.sceneDuration(timings[index].duration))
      : secondsOf(scenes[index]) || (timings[index] && cues.sceneDuration(timings[index].duration));
    add({ key: `scene:${scene.id || index}`, kind: usesClip ? 'clip' : 'scene', label: scene.title || scene.id || '',
      text: scene.narration || '', port: usesClip ? 'clips' : 'scenes', item: usesClip ? scene.clip : index,
      lipsync: false, sound: { port: 'audio', item: index } }, duration);
  });
  if (inputs.outro) add({ key: 'outro', kind: 'outro', label: '', text: '', port: 'outro', item: null, lipsync: false }, secondsOf(inputs.outro));
  if (durations.some((duration) => !Number.isFinite(duration) || duration <= 0)) return null;
  const hard = clips.map((clip) => ['intro', 'outro'].includes(clip.kind));
  const timeline = explainerEdit.planTimeline({ durations, fps: Number(params.fps) || 30, transition: params.transition || 'crossfade',
    hardCuts: hard.map((value, index) => value || (index > 0 && clips[index - 1].kind === 'intro')) });
  return { duration: timeline.total, audio: null, clips: clips.map((clip, index) => ({ ...clip,
    start: timeline.starts[index] / timeline.fps, duration: timeline.owns[index] / timeline.fps })) };
}

function concat({ inputs = {} }) {
  const values = itemsOf(inputs.clips);
  if (!values.length || values.some((value) => secondsOf(value) === null)) return null;
  let duration = 0;
  const clips = values.map((value, item) => {
    const clip = { key: `clip:${item}`, start: duration, duration: value.duration, kind: 'clip', label: '', text: '', port: 'clips', item, lipsync: false };
    duration += value.duration;
    return clip;
  });
  return { duration, audio: null, clips };
}

function eventVideo({ inputs = {} }) {
  const plan = jsonOf(inputs.shots);
  if (!eventContract.checkShots(plan).ok) return null;
  return { duration: plan.duration, audio: null, clips: plan.shots.map((shot) => {
    const source = eventCut.sourceOf(shot);
    return { key: `scene:${shot.id}`, start: Math.round(shot.start * eventContract.FPS) / eventContract.FPS,
      duration: eventCut.shotSeconds(shot), kind: shot.kind === 'photo' ? 'still' : 'clip', label: shot.id, text: shot.text || '',
      port: source.list, item: source.index, lipsync: false };
  }) };
}

module.exports = { musicVideo, explainer, concat, eventVideo };
