'use strict';

// The plan of a music video (WP34, node "Plan music video"): where the cuts are, which scenes show the singer, and what a language
// model is asked to write for each scene. The cuts are made here, deterministically, from the analysis of the song (beats, sections)
// and the lyric lines with their times: a model writes words, it does not choose seconds. Pure functions, no network, no files.
//
//   planScenes()       the cut grid: contiguous scenes from 0 to the end of the song, each 1.5 s up to the clip length, at most 50
//                      (the limit of a list in the engine); the scenes for the singer are windows of the sung lines of 5 to 10 s
//                      (5 s is the shortest audio the lip sync takes), chosen from the chorus and the loud parts, spread over the song
//   promptFor()/sceneRows()   what the model is told
//   readContent()      the answer of the model, checked scene by scene (JSON, one entry per scene, a prompt each)
//   fallbackContent()  plain prompts for the scenes the model did not deliver
//   buildShots()       the plan as the JSON the cutting node reads (music_video.edit)

const MIN_SCENE_SEC = 1.5;
const MAX_SCENES = 50;
// the shortest sound the lip sync takes is 5 s (fal.h3_lipsync); a scene for the singer is a window of sung lines of at least that
// length, plus a margin so that the times rounded to milliseconds and the length of the WAV file never end up below the limit
const LIPSYNC_MIN_SEC = 5;
const PERFORMANCE_MIN_SEC = LIPSYNC_MIN_SEC + 0.05;
// two lines of two bars at 120 BPM with their pauses are about 8.5 s: the window has to take them
const PERFORMANCE_MAX_SEC = 10;
// a window must be mostly sung, not mostly a pause between two lines
const SUNG_COVERAGE = 0.7;
// the picture of the singer may begin a moment before the voice
const LEAD_IN_SEC = 0.1;
// a window that reaches into a pause keeps this distance from the next or the previous line (the times of the words are not exact to the frame)
const LINE_MARGIN_SEC = 0.15;
// a story clip that is a little too short can be slowed down to 0.8 (see music_video.edit): a scene may be this much longer than the clip
const CLIP_STRETCH = 1.25;
const CUT_MODES = Object.freeze(['lines', 'beats', 'sections']);
const ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
const MAX_PROMPT_CHARS = 1500;
const CHORUS = /chorus|refrain|hook|ritornell/i;

const round3 = (value) => Math.round(value * 1000) / 1000;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/* ---------- reading the inputs ---------- */

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// The analysis as the node "Analyze song" writes it (JSON text or object); null where it cannot be used.
function parseAnalysis(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (_) {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || !finite(data.duration) || data.duration <= 0) return null;
  const duration = data.duration;
  const beats = (Array.isArray(data.beats) ? data.beats : []).filter((time) => finite(time) && time > 0 && time < duration).sort((a, b) => a - b);
  let sections = (Array.isArray(data.sections) ? data.sections : [])
    .filter((section) => section && finite(section.start) && finite(section.end) && section.end > section.start)
    .map((section, index) => ({
      name: typeof section.name === 'string' && section.name.trim() ? section.name.trim() : `Part ${index + 1}`,
      start: clamp(section.start, 0, duration),
      end: clamp(section.end, 0, duration),
      energy: finite(section.energy) ? section.energy : 0
    }))
    .filter((section) => section.end > section.start)
    .sort((a, b) => a.start - b.start);
  if (!sections.length) sections = [{ name: 'Song', start: 0, end: duration, energy: 0 }];
  const energy = (Array.isArray(data.energy) ? data.energy : []).map((value) => (finite(value) ? value : 0));
  return { duration, bpm: finite(data.bpm) ? data.bpm : null, beats, sections, energy };
}

// The lyric lines of the timing (JSON text or object) inside the song, in order, without overlaps.
function readLines(timing, duration) {
  let data = timing;
  if (typeof timing === 'string') {
    try {
      data = JSON.parse(timing);
    } catch (_) {
      return [];
    }
  }
  const raw = data && Array.isArray(data.lines) ? data.lines : [];
  const lines = [];
  for (const line of raw.slice().sort((a, b) => (a?.start ?? 0) - (b?.start ?? 0))) {
    if (!line || typeof line.text !== 'string' || !finite(line.start) || !finite(line.end)) continue;
    const start = Math.max(0, lines.length ? Math.max(line.start, lines[lines.length - 1].end) : line.start);
    const end = Math.min(duration, line.end);
    if (end - start >= 0.3) lines.push({ text: line.text.trim(), start, end });
  }
  return lines;
}

/* ---------- the cut grid ---------- */

function energyBetween(energy, start, end) {
  if (!energy.length) return 0;
  let sum = 0;
  let count = 0;
  for (let second = Math.floor(start); second < Math.ceil(end) && second < energy.length; second += 1) {
    sum += energy[second];
    count += 1;
  }
  return count ? sum / count : 0;
}

function sectionAt(sections, time) {
  return sections.find((section) => time >= section.start && time < section.end) || sections[sections.length - 1];
}

// How much of [start, end] is sung (the lines overlapping it), 0..1.
function sungShare(lines, start, end) {
  let sung = 0;
  for (const line of lines) sung += Math.max(0, Math.min(end, line.end) - Math.max(start, line.start));
  return end > start ? sung / (end - start) : 0;
}

// Windows of sung lines of PERFORMANCE_MIN_SEC to PERFORMANCE_MAX_SEC, mostly sung: from every line the shortest run of lines that is
// long enough. A run that is a little too short (one line of 4.5 s) reaches into the pauses before and after it, as far as the
// neighbouring lines allow, as long as it stays mostly sung.
function performanceCandidates(lines, analysis, duration) {
  const out = [];
  for (let first = 0; first < lines.length; first += 1) {
    for (let last = first; last < lines.length; last += 1) {
      let start = Math.max(first ? lines[first - 1].end : 0, lines[first].start - LEAD_IN_SEC);
      let end = lines[last].end;
      if (end - start > PERFORMANCE_MAX_SEC) break;
      let reached = false;
      if (end - start < PERFORMANCE_MIN_SEC) {
        const missing = PERFORMANCE_MIN_SEC - (end - start);
        const after = Math.max(0, Math.min(duration, last + 1 < lines.length ? lines[last + 1].start - LINE_MARGIN_SEC : duration) - end);
        const before = Math.max(0, start - (first ? lines[first - 1].end + LINE_MARGIN_SEC : 0));
        if (after + before < missing - 1e-9) continue;
        // half of what is missing on each side, the rest on the side that has room
        const behind = Math.min(after, Math.max(missing / 2, missing - before));
        end += behind;
        start -= missing - behind;
        reached = true;
      }
      if (sungShare(lines.slice(first, last + 1), start, end) < SUNG_COVERAGE) {
        // a run that only reached the minimum by its pauses may still be a window together with the next line
        if (reached) continue;
        break;
      }
      // no sliver of a scene is left before the first or after the last window: it reaches the end of the song or keeps its distance
      if (start < MIN_SCENE_SEC) {
        if (start > 0.3) break;
        start = 0;
      }
      if (duration - end < MIN_SCENE_SEC) {
        if (duration - end > 0.3) break;
        end = duration;
      }
      const section = sectionAt(analysis.sections, (start + end) / 2);
      out.push({ start, end, first, last, score: energyBetween(analysis.energy, start, end) + (CHORUS.test(section.name) ? 0.25 : 0) });
      break;
    }
  }
  return out;
}

// The windows for the singer: `count` of them, the loudest and the choruses first, not overlapping, spread over the song (a second
// round without the spreading when the song has too few).
function pickWindows(candidates, count, duration) {
  if (count <= 0) return [];
  const picked = [];
  // between two windows there is room for a story scene
  const free = (candidate, spacing) =>
    picked.every((other) => candidate.start >= other.end + MIN_SCENE_SEC || candidate.end <= other.start - MIN_SCENE_SEC) &&
    picked.every((other) => Math.abs((candidate.start + candidate.end) / 2 - (other.start + other.end) / 2) >= spacing);
  const ordered = candidates.slice().sort((a, b) => b.score - a.score || a.start - b.start);
  for (const spacing of [duration / (2 * count), 0]) {
    for (const candidate of ordered) {
      if (picked.length >= count) break;
      if (!picked.includes(candidate) && free(candidate, spacing)) picked.push(candidate);
    }
  }
  return picked.sort((a, b) => a.start - b.start).map((window) => ({ start: round3(window.start), end: round3(window.end) }));
}

// Boundaries that must stay, in order of importance: the edges of the windows for the singer (their audio is cut there), the
// section boundaries, then (cut on lines) the starts of the lyric lines. None inside a window; one that would leave a scene
// shorter than MIN_SCENE_SEC next to a more important one is dropped.
function mandatoryCuts(duration, windows, sections, lines) {
  const cuts = [0, duration];
  for (const window of windows) for (const edge of [window.start, window.end]) if (!cuts.includes(round3(edge))) cuts.push(round3(edge));
  const inside = (at) => windows.some((window) => at > window.start + 0.001 && at < window.end - 0.001);
  const add = (time) => {
    const at = round3(time);
    if (at > 0 && at < duration && !inside(at) && cuts.every((other) => Math.abs(other - at) >= MIN_SCENE_SEC)) cuts.push(at);
  };
  for (const section of sections.slice(1)) add(section.start);
  for (const line of lines) add(line.start);
  return cuts.sort((a, b) => a - b);
}

// Cuts inside a stretch of story: `count` scenes of about the same length, each cut moved to the nearest beat when one is close.
function splitStretch(start, end, count, beats, snap) {
  const cuts = [];
  const step = (end - start) / count;
  for (let index = 1; index < count; index += 1) {
    let at = start + index * step;
    if (snap && beats.length) {
      let best = null;
      for (const beat of beats) if (Math.abs(beat - at) <= 0.35 * step && (best === null || Math.abs(beat - at) < Math.abs(best - at))) best = beat;
      if (best !== null) at = best;
    }
    const previous = cuts.length ? cuts[cuts.length - 1] : start;
    if (at - previous >= MIN_SCENE_SEC && end - at >= MIN_SCENE_SEC) cuts.push(round3(at));
  }
  return cuts;
}

// Plans the scenes. Returns { scenes, warnings, cutOn, target } with
//   scenes   [{ index, start, end, duration, kind: 'story'|'performance', section, line, energy }]
//   warnings codes: NO_TIMING (cut on lines without times: cut on beats), NO_LYRICS_FOR_PERFORMANCE, SCENES_LONGER_THAN_CLIP
// options: shotsPerMinute (6-30), performanceShare (0-1, share of the scenes), cutOn, clipSeconds.
function planScenes(analysisInput, timingInput, options = {}) {
  const analysis = parseAnalysis(analysisInput);
  if (!analysis) throw Object.assign(new Error('The analysis of the song is missing or unreadable'), { code: 'MUSICVIDEO_ANALYSIS_INVALID' });
  const duration = analysis.duration;
  const warnings = [];
  const shotsPerMinute = clamp(Number(options.shotsPerMinute) || 14, 1, 120);
  const share = clamp(Number.isFinite(Number(options.performanceShare)) ? Number(options.performanceShare) : 0.3, 0, 1);
  const clipSeconds = Math.max(MIN_SCENE_SEC, Number(options.clipSeconds) || 5);
  let cutOn = CUT_MODES.includes(options.cutOn) ? options.cutOn : 'lines';
  const lines = readLines(timingInput, duration);
  if (cutOn === 'lines' && !lines.length) {
    cutOn = 'beats';
    warnings.push('NO_TIMING');
  }

  // how many scenes, and how long a story scene may be
  const target = clamp(Math.round((duration / 60) * shotsPerMinute), 1, MAX_SCENES);
  let maxLength = clipSeconds;
  if (duration / MAX_SCENES > maxLength * CLIP_STRETCH) maxLength = (duration / MAX_SCENES) * 1.02;
  const average = clamp(duration / target, MIN_SCENE_SEC, maxLength);

  // the singer
  let windows = [];
  if (share > 0) {
    if (!lines.length) {
      warnings.push('NO_LYRICS_FOR_PERFORMANCE');
    } else {
      const count = Math.min(Math.max(1, Math.round(share * target)), Math.floor(duration / PERFORMANCE_MIN_SEC));
      windows = pickWindows(performanceCandidates(lines, analysis, duration), count, duration);
      if (!windows.length) warnings.push('NO_LYRICS_FOR_PERFORMANCE');
    }
  }

  // the grid
  const cuts = mandatoryCuts(duration, windows, analysis.sections, cutOn === 'lines' ? lines : []);
  const isWindow = (start, end) => windows.some((window) => Math.abs(window.start - start) < 0.002 && Math.abs(window.end - end) < 0.002);
  let scenes = [];
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const start = cuts[index];
    const end = cuts[index + 1];
    if (isWindow(start, end)) {
      scenes.push({ start, end, kind: 'performance' });
      continue;
    }
    const length = end - start;
    const most = Math.max(1, Math.floor(length / MIN_SCENE_SEC));
    const count = clamp(Math.round(length / average), Math.min(most, Math.ceil(length / maxLength - 1e-9)), most);
    const inner = splitStretch(start, end, count, analysis.beats, cutOn !== 'sections');
    const edges = [start, ...inner, end];
    for (let part = 0; part + 1 < edges.length; part += 1) scenes.push({ start: edges[part], end: edges[part + 1], kind: 'story' });
  }

  // never more than 50: the two shortest neighbours among the story scenes grow together
  while (scenes.length > MAX_SCENES) {
    let best = -1;
    let bestLength = Infinity;
    for (let index = 0; index + 1 < scenes.length; index += 1) {
      if (scenes[index].kind !== 'story' || scenes[index + 1].kind !== 'story') continue;
      const merged = scenes[index + 1].end - scenes[index].start;
      if (merged < bestLength) {
        bestLength = merged;
        best = index;
      }
    }
    if (best < 0) {
      // only singer scenes next to each other: the shortest of them becomes a story scene and merges in the next round
      const shortest = scenes.reduce((low, scene, index) => (scene.kind === 'performance' && scene.end - scene.start < (scenes[low]?.end - scenes[low]?.start || Infinity) ? index : low), -1);
      if (shortest < 0) break;
      scenes[shortest].kind = 'story';
      continue;
    }
    scenes.splice(best, 2, { start: scenes[best].start, end: scenes[best + 1].end, kind: 'story' });
  }
  // a story scene longer than its clip can be stretched to (slowed to 0.8, see music_video.edit) holds the last frame
  if (scenes.some((scene) => scene.kind === 'story' && scene.end - scene.start > clipSeconds * CLIP_STRETCH + 0.01)) warnings.push('SCENES_LONGER_THAN_CLIP');

  scenes = scenes.map((scene, index) => {
    const middle = (scene.start + scene.end) / 2;
    const heard = lines.filter((line) => Math.min(scene.end, line.end) - Math.max(scene.start, line.start) >= 0.4);
    return {
      index,
      start: round3(scene.start),
      end: round3(scene.end),
      duration: round3(scene.end - scene.start),
      kind: scene.kind,
      section: sectionAt(analysis.sections, middle).name,
      line: heard.slice(0, 2).map((line) => line.text).join(' / ').slice(0, 240) || null,
      energy: round3(energyBetween(analysis.energy, scene.start, scene.end))
    };
  });
  return { scenes, warnings: Array.from(new Set(warnings)), cutOn, target, analysis, lines };
}

/* ---------- what the model is told ---------- */

function energyWord(value, peak) {
  const share = peak > 0 ? value / peak : 0;
  return share >= 0.75 ? 'high' : share >= 0.4 ? 'medium' : 'low';
}

// One row per scene for the prompt: no more than the model needs.
function sceneRows(plan) {
  const peak = Math.max(0, ...plan.scenes.map((scene) => scene.energy));
  return plan.scenes.map((scene) => ({
    index: scene.index,
    kind: scene.kind,
    seconds: Math.round(scene.duration * 10) / 10,
    section: scene.section,
    energy: energyWord(scene.energy, peak),
    ...(scene.line ? { lyrics: scene.line } : {})
  }));
}

function systemPrompt() {
  return [
    'You are the director of an AI-generated music video. You plan the shots of one song, scene by scene.',
    'Answer with one JSON object and nothing else: {"scenes":[{"index":0,"image_prompt":"...","motion":"...","character":"..."}]}',
    'Rules:',
    '- One entry for every scene you are given, with the same index. Do not leave one out and do not add one.',
    '- image_prompt: the first frame of the scene as ONE still image: subject, setting, composition, camera, lighting, colours, mood. English, 30 to 70 words. No text in the image, no logos, no song title.',
    '- Scenes of kind "performance": a close or medium portrait of the singer facing the camera, the face and the mouth fully visible, steady framing, no sunglasses, nothing in front of the mouth. The picture is lip-synced to the sung line.',
    '- Scenes of kind "story": show the story and the mood of the song, follow the brief, vary shot sizes and angles from scene to scene, keep one consistent look (the style).',
    '- motion: what moves during the scene (camera move and subject action), 1 or 2 sentences, English, for a clip of the given length. For scenes of kind "performance" write an empty string.',
    '- character: the name of the person from the character list who is the main subject of the scene, or an empty string.',
    '- Lyrics are only for the meaning and the mood: never write them into the image.',
    '- Energy follows the song: calm shots where the energy is low, dynamic ones where it is high.'
  ].join('\n');
}

function userPrompt({ brief, style, characters, aspectRatio, plan, problems = [] }) {
  const analysis = plan.analysis;
  const parts = [
    `Brief:\n${String(brief || '').trim()}`,
    style && String(style).trim() ? `Style:\n${String(style).trim()}` : '',
    characters && String(characters).trim() ? `Characters:\n${String(characters).trim()}` : '',
    `Format: ${aspectRatio} video.`,
    `Song: ${Math.round(analysis.duration)} seconds${analysis.bpm ? `, ${Math.round(analysis.bpm)} BPM` : ''}. Sections: ${analysis.sections.map((section) => `${section.name} (${Math.round(section.start)}-${Math.round(section.end)} s)`).join(', ')}.`,
    `Scenes (${plan.scenes.length}):\n${sceneRows(plan).map((row) => JSON.stringify(row)).join('\n')}`
  ].filter(Boolean);
  if (problems.length) parts.push(`Your previous answer had these problems, fix them and answer with the complete JSON again:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  return parts.join('\n\n');
}

/* ---------- the answer of the model ---------- */

// JSON out of an answer: plain, in a code fence, or with words around it.
function parseJsonAnswer(text) {
  const raw = String(text || '').trim();
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(raw);
  const candidates = [raw, fenced ? fenced[1].trim() : ''];
  const open = raw.search(/[{[]/);
  if (open >= 0) {
    const close = raw[open] === '{' ? raw.lastIndexOf('}') : raw.lastIndexOf(']');
    if (close > open) candidates.push(raw.slice(open, close + 1));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (_) {
      /* the next candidate */
    }
  }
  return null;
}

function cleanLine(value, limit) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

// Checks the answer of the model against the scenes. Returns { items, problems }: items[i] = { image_prompt, motion, character } or
// null for a scene without a usable entry; problems lists what was wrong, for the second attempt.
function readContent(text, scenes) {
  const data = parseJsonAnswer(text);
  const list = Array.isArray(data) ? data : Array.isArray(data?.scenes) ? data.scenes : null;
  const items = scenes.map(() => null);
  const problems = [];
  if (!list) {
    problems.push('The answer is not a JSON object with a "scenes" list.');
    return { items, problems };
  }
  if (list.length !== scenes.length) problems.push(`The list has ${list.length} entries but there are ${scenes.length} scenes.`);
  list.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object') return;
    const index = Number.isInteger(entry.index) ? entry.index : position;
    if (index < 0 || index >= scenes.length) {
      problems.push(`The entry with index ${entry.index} does not belong to any scene.`);
      return;
    }
    if (items[index]) {
      problems.push(`The index ${index} appears twice.`);
      return;
    }
    const imagePrompt = cleanLine(entry.image_prompt ?? entry.imagePrompt ?? entry.prompt, MAX_PROMPT_CHARS);
    if (!imagePrompt) {
      problems.push(`Scene ${index} has no image_prompt.`);
      return;
    }
    const motion = cleanLine(entry.motion, MAX_PROMPT_CHARS);
    if (scenes[index].kind === 'story' && !motion) problems.push(`Scene ${index} (story) has no motion.`);
    items[index] = { image_prompt: imagePrompt, motion, character: cleanLine(entry.character, 80) };
  });
  scenes.forEach((scene, index) => {
    if (!items[index] && !problems.some((problem) => problem.includes(`Scene ${index} `) || problem.includes(`index ${index} `))) problems.push(`Scene ${index} is missing.`);
  });
  return { items, problems };
}

const SHOT_TYPES = [
  'wide establishing shot',
  'medium shot',
  'close-up on a detail',
  'low-angle shot',
  'over-the-shoulder shot',
  'high-angle shot',
  'tracking shot from the side',
  'silhouette against the light'
];
const MOTIONS = [
  'Slow push-in with gentle handheld movement.',
  'Smooth sideways dolly, the subject moves calmly through the frame.',
  'Slow pull-back that reveals the surroundings.',
  'Slight orbit around the subject, soft breeze in the scene.'
];

// Simple prompts for a scene the model did not deliver: the brief, the style, the part of the song and a changing kind of shot.
function fallbackContent(scene, { brief, style, characters }) {
  const subject = cleanLine(brief, 300) || 'a music video';
  const look = cleanLine(style, 200);
  const mood = scene.energy >= 0.75 ? 'energetic, vivid' : scene.energy >= 0.4 ? 'warm, flowing' : 'calm, intimate';
  const named = cleanLine(characters, 160);
  if (scene.kind === 'performance') {
    return {
      image_prompt: `${look ? `${look}. ` : ''}Close-up portrait of the singer facing the camera, face and mouth clearly visible, steady framing, ${mood} lighting. ${subject}.${named ? ` ${named}.` : ''}`.slice(0, MAX_PROMPT_CHARS),
      motion: '',
      character: ''
    };
  }
  return {
    image_prompt: `${look ? `${look}. ` : ''}${SHOT_TYPES[scene.index % SHOT_TYPES.length]}, ${subject}, ${scene.section} of the song, ${mood} mood.${named ? ` ${named}.` : ''}`.slice(0, MAX_PROMPT_CHARS),
    motion: MOTIONS[scene.index % MOTIONS.length],
    character: ''
  };
}

/* ---------- the plan for the next nodes ---------- */

// The scenes with their content as the JSON of the cutting node: every scene knows its list ('story' or 'performance') and its
// place in it, so the clips come back to their scene however many of each kind there are.
function buildShots(plan, contents, { aspectRatio = '16:9', brief = '' } = {}) {
  let story = 0;
  let performance = 0;
  const shots = plan.scenes.map((scene, index) => {
    const content = contents[index];
    const clip = scene.kind === 'performance' ? performance++ : story++;
    return {
      index: scene.index,
      start: scene.start,
      end: scene.end,
      duration: scene.duration,
      kind: scene.kind,
      clip,
      section: scene.section,
      line: scene.line,
      prompt: content.image_prompt,
      motion: content.motion,
      character: content.character || null
    };
  });
  return {
    version: 1,
    duration: plan.analysis.duration,
    bpm: plan.analysis.bpm,
    aspect_ratio: ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '16:9',
    cut_on: plan.cutOn,
    shots,
    story,
    performance,
    brief: cleanLine(brief, 300)
  };
}

// The shots JSON as the cutting node reads it, checked: contiguous scenes from the start, kind and clip number for each. Returns the
// object, or throws an error with a code.
function parseShots(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (_) {
      data = null;
    }
  }
  const bad = (message) => Object.assign(new Error(message), { code: 'MUSICVIDEO_SHOTS_INVALID' });
  if (!data || typeof data !== 'object' || !Array.isArray(data.shots) || !data.shots.length) throw bad('The shots are missing or unreadable');
  if (data.shots.length > MAX_SCENES) throw bad(`At most ${MAX_SCENES} scenes are allowed (got ${data.shots.length})`);
  let at = null;
  const seen = { story: new Set(), performance: new Set() };
  const shots = data.shots.map((shot, position) => {
    if (!shot || !finite(shot.start) || !finite(shot.end) || !(shot.end > shot.start)) throw bad(`Scene ${position + 1} has no usable times`);
    if (shot.kind !== 'story' && shot.kind !== 'performance') throw bad(`Scene ${position + 1} is neither story nor performance`);
    if (!Number.isInteger(shot.clip) || shot.clip < 0 || seen[shot.kind].has(shot.clip)) throw bad(`Scene ${position + 1} has no valid clip number`);
    seen[shot.kind].add(shot.clip);
    if (at !== null && Math.abs(shot.start - at) > 0.01) throw bad(`Scene ${position + 1} does not start where the scene before ends`);
    at = shot.end;
    return { ...shot, duration: round3(shot.end - shot.start) };
  });
  // the clips of each kind are numbered 0, 1, 2 ... without gaps: the clip lists of the cutting node are read by these numbers
  for (const kind of ['story', 'performance']) {
    for (let clip = 0; clip < seen[kind].size; clip += 1) if (!seen[kind].has(clip)) throw bad(`The ${kind} clips are not numbered 0 to ${seen[kind].size - 1} (clip ${clip} is missing)`);
  }
  return { ...data, shots, aspect_ratio: ASPECT_RATIOS.includes(data.aspect_ratio) ? data.aspect_ratio : '16:9', story: seen.story.size, performance: seen.performance.size };
}

module.exports = {
  MIN_SCENE_SEC,
  MAX_SCENES,
  LIPSYNC_MIN_SEC,
  PERFORMANCE_MIN_SEC,
  PERFORMANCE_MAX_SEC,
  CUT_MODES,
  ASPECT_RATIOS,
  parseAnalysis,
  readLines,
  planScenes,
  sceneRows,
  systemPrompt,
  userPrompt,
  parseJsonAnswer,
  readContent,
  fallbackContent,
  buildShots,
  parseShots
};
