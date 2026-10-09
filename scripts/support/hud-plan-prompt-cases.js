'use strict';

// Test support (not a test): what the planner of the HUD music video sends to the language model, and what it gives back, for fixed songs with a
// GIVEN idea (lib/music-video-hud/plan.js runPlanner with a scripted model), plus the grids of the two planners and the timing of lyrics without
// marks (lib/lyrics-timing.js). hud-plan-before-wp48.json holds the SHA-256 of every text as the code before WP48 made it (the brief from the song
// and the lines of a choir); scripts/test-music-video-hud-brief.js checks that the code of now makes the same, byte for byte.
//
//   cases()   { name: text } for every case; the texts are JSON or prompts, compared by their hash

const crypto = require('crypto');

const planLib = require('../../lib/music-video-plan');
const hudPlan = require('../../lib/music-video-hud/plan');
const lyricsTiming = require('../../lib/lyrics-timing');
const { FIGURE_TEXT, FIGURE_NO_SHORT, makeSong, goodAnswer, scriptedModel } = require('./hud-plan-fixtures');

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

// the prices the node reads (made up, fixed): every part of the estimate is known
const PRICES = {
  image: 0.034,
  lipsync: (seconds) => Math.round(seconds * 0.07 * 1000) / 1000,
  clipPerSecond: 0.045,
  depth: 0.01,
  llm: { inputPerMillion: 4, outputPerMillion: 20, charsPerToken: 3 }
};

const BRIEFS = {
  en: 'A woman keeps a lamp on all night, and the moths of the whole city come to see it.',
  de: 'Eine Frau lässt die Lampe die ganze Nacht brennen, und die Motten der ganzen Stadt kommen vorbei.',
  es: 'Una mujer deja la lámpara encendida toda la noche y las polillas de la ciudad vienen a verla.'
};

// A planner run with a given idea: the requests to the model, the board, the sheet prompt and the estimate.
async function plannerCase({ song, figureText, theme, hudLanguage, style, brief, steps }) {
  const figure = hudPlan.parseFigure(figureText);
  const grid = hudPlan.planGrid(song.analysis, song.timing);
  const model = scriptedModel(steps(grid, figure));
  const result = await hudPlan.runPlanner({
    analysis: JSON.stringify(song.analysis),
    timing: JSON.stringify(song.timing),
    brief,
    figureText,
    style,
    theme,
    hudLanguage,
    ask: model.ask,
    prices: PRICES
  });
  return {
    requests: JSON.stringify(model.calls),
    board: result.board,
    sheet: result.sheetPrompt,
    cost: JSON.stringify(result.cost),
    graphics: JSON.stringify(result.plan.graphics),
    shots: JSON.stringify(result.plan.shots)
  };
}

// The timing of a text without marks: the alignment (by order) and the transcript (by the words that agree), each with the quirks of the real answers.
function timingCases() {
  const text = [
    '[Intro]',
    '(ahhh)',
    '(hm-mm)',
    '',
    '[Verse 1]',
    'Paper boats on a silver stream',
    'Chasing lanterns through a dream',
    '',
    '[Chorus]',
    'Sail on, sail on, into the light',
    'Hold the morning, hold it tight (yeah)',
    '(ooh-ooh)',
    '[Outro]',
    'So far, so bright'
  ].join('\r\n');
  const lines = lyricsTiming.sungLines(text);
  const words = [];
  let time = 12.4;
  for (const line of lines) {
    for (const token of line.split(/\s+/)) {
      words.push({ text: token, start: Math.round(time * 1000) / 1000, end: Math.round((time + 0.36) * 1000) / 1000, type: 'word' });
      words.push({ text: ' ', start: Math.round((time + 0.36) * 1000) / 1000, end: Math.round((time + 0.4) * 1000) / 1000, type: 'spacing' });
      time += 0.42;
    }
    time += 1.6;
  }
  const alignment = { words: words.filter((word) => word.type === 'word').map(({ text: word, start, end }) => ({ text: word, start, end })), loss: 0.0421 };
  alignment.words[0].start = 0.12;
  const heard = words.map((word) => ({ ...word, text: word.type === 'word' ? word.text.toLowerCase().replace(/[,]/g, '') : word.text }));
  heard.splice(6, 2);
  const plan = [
    '[Intro | 12 s]',
    '+ 100 BPM, warm synths',
    '(ahhh)',
    '[Verse | 20 s]',
    'Paper boats on a silver stream',
    'Chasing lanterns through a dream',
    '[Chorus | 20 s]',
    'Sail on, sail on, into the light'
  ].join('\n');
  return {
    sung: JSON.stringify(lines),
    sungPlan: JSON.stringify(lyricsTiming.sungLines(plan)),
    alignment: JSON.stringify(lyricsTiming.fromAlignment(alignment, text, { duration: 60 })),
    transcript: JSON.stringify(lyricsTiming.fromTranscript({ words: heard }, text, { duration: 60 })),
    pauses: JSON.stringify(lyricsTiming.fromTranscript({ words: heard }, '', { duration: 60 }))
  };
}

async function cases() {
  const out = {};
  const songA = makeSong();
  const songB = makeSong({ seconds: 96, seed: 3, pace: 1.3 });
  const songC = makeSong({ seconds: 130, bpm: 104, seed: 11 });

  const a = await plannerCase({
    song: songA,
    figureText: FIGURE_TEXT,
    theme: 'hud',
    hudLanguage: 'en',
    style: '',
    brief: BRIEFS.en,
    steps: (grid, figure) => [goodAnswer(grid, figure)]
  });
  // the first answer lacks two units and has a counter that falls: the second request carries the problems
  const b = await plannerCase({
    song: songB,
    figureText: FIGURE_NO_SHORT,
    theme: 'kuble',
    hudLanguage: 'de',
    style: 'grainy 16 mm film, warm practical lights',
    brief: BRIEFS.de,
    steps: (grid, figure) => [
      goodAnswer(grid, figure, {
        mutate: (answer) => {
          answer.units = answer.units.slice(2);
          answer.hud.counter_values = answer.hud.counter_values.slice().reverse();
          return answer;
        }
      }),
      goodAnswer(grid, figure)
    ]
  });
  // the first answer is empty at the limit of tokens: the second request thinks less
  const empty = Object.assign(new Error('The model returned an empty answer (finish_reason length)'), { emptyAnswer: true, finishReason: 'length', usd: 0.4 });
  const c = await plannerCase({
    song: songC,
    figureText: FIGURE_TEXT,
    theme: 'hud',
    hudLanguage: 'es',
    style: '',
    brief: BRIEFS.es,
    steps: (grid, figure) => [empty, goodAnswer(grid, figure)]
  });
  for (const [name, result] of Object.entries({ a, b, c })) for (const [part, text] of Object.entries(result)) out[`planner.${name}.${part}`] = text;

  // the prompts themselves, for every look and language
  const grid = hudPlan.planGrid(songA.analysis, songA.timing);
  const figure = hudPlan.parseFigure(FIGURE_TEXT);
  for (const theme of ['hud', 'kuble']) for (const hudLanguage of ['en', 'de', 'es']) out[`system.${theme}.${hudLanguage}`] = hudPlan.systemPrompt({ theme, hudLanguage, needShort: false });
  out['system.needShort'] = hudPlan.systemPrompt({ theme: 'hud', hudLanguage: 'en', needShort: true });
  out['user.a'] = hudPlan.userPrompt({ brief: BRIEFS.en, style: 'neon', figure, grid });
  out['user.a.retry'] = hudPlan.userPrompt({ brief: BRIEFS.en, style: 'neon', figure, grid, problems: ['unit 3: the plate is missing'], previous: '{"treatment":"x"}' });

  // the grids of both planners on songs without marks
  for (const [name, song] of Object.entries({ a: songA, b: songB, c: songC })) {
    out[`grid.${name}`] = JSON.stringify(hudPlan.planGrid(song.analysis, song.timing));
    out[`grid.${name}.low`] = JSON.stringify(hudPlan.planGrid(song.analysis, song.timing, { motionShare: 0.3, lipsyncSecondsPerMinute: 30 }));
    out[`scenes.${name}`] = JSON.stringify(planLib.planScenes(song.analysis, song.timing, { performanceShare: 0.4 }).scenes);
  }

  for (const [name, text] of Object.entries(timingCases())) out[`timing.${name}`] = text;
  for (const [name, text] of Object.entries(nodeCases(songA))) out[`node.${name}`] = text;
  return out;
}

// The nodes as a workflow saved before WP48 has them: the cache keys of the planner with an idea and of the timing (a key that changed would make a
// saved film run again and be paid again), and the estimate of the planner with an idea.
function nodeCases(song) {
  const engine = require('../../lib/nodes/engine');
  const { registry } = require('../../lib/nodes/registry');
  const hudNodes = require('../../lib/nodes/nodes-music-video-hud');
  const { textValue } = require('../../lib/nodes/types');
  const planDef = registry.get('music_video.hud_plan');
  const timingDef = registry.get('audio.lyrics_timing');
  const saved = {
    model: '',
    brief: BRIEFS.de,
    figure: FIGURE_TEXT,
    style: '',
    theme: 'hud',
    accent: '#3B82F6',
    hud_language: 'en',
    cuts_per_minute: 24,
    max_units: 50,
    lipsync_seconds_per_minute: 22,
    motion_share: 1,
    clip_seconds: 5
  };
  const planParams = engine.effectiveParams(registry, planDef, { id: 'n4', type: planDef.type, params: saved });
  const inputs = { analysis: textValue(JSON.stringify(song.analysis)), timing: textValue(JSON.stringify(song.timing)), brief: textValue(BRIEFS.de), figure: textValue(FIGURE_TEXT) };
  const audio = { type: 'audio', sessionId: 's-golden', assetId: 'a-golden', duration: 72 };
  const timingParams = engine.effectiveParams(registry, timingDef, { id: 'n3', type: timingDef.type, params: { lyrics: '', method: 'auto' } });
  const named = { ...planParams, model: 'anthropic/claude-opus-5.5' };
  return {
    planKey: engine.computeCacheKey(planDef, planParams, inputs),
    timingKey: engine.computeCacheKey(timingDef, timingParams, { audio }),
    timingKeyLyrics: engine.computeCacheKey(timingDef, { ...timingParams, lyrics: 'Paper boats on a silver stream' }, { audio, lyrics: textValue('Paper boats on a silver stream') }),
    estimate: JSON.stringify(hudNodes.hudPlanEstimate(named, { inputs, connected: new Set(['analysis', 'timing']) }))
  };
}

// { name: { sha256, length } } of every case
async function fingerprints() {
  const out = {};
  for (const [name, text] of Object.entries(await cases())) out[name] = { sha256: sha(text), length: String(text).length };
  return out;
}

module.exports = { cases, fingerprints, sha, PRICES, BRIEFS };
