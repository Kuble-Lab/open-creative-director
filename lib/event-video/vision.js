'use strict';

const fs = require('fs/promises');
const contract = require('./contract');
const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
const SYSTEM = `Describe only visible evidence in these event keyframes. Do not invent identities or event facts.
Return one JSON object with exactly these fields:
subject (nonempty English description, <=160 characters), people (${contract.PEOPLE.join('|')}),
faces_visible (boolean), emotion (${contract.EMOTIONS.join('|')}), action (${contract.ACTIONS.join('|')}),
framing (${contract.FRAMINGS.join('|')}), stage (boolean), text_in_image (up to 20 verbatim strings, <=120 characters each),
risk (unique tags from ${contract.RISKS.join('|')}), fit (unique tags from ${contract.FITS.join('|')}), score (integer 1..5).
The sheet is in chronological reading order. Report risks conservatively. Never add prose outside the JSON.`;

function readVision(text) {
  const value = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  // Reuse the contract's vision checks without requiring a second schema implementation.
  const checked = contract.checkInfo({ version: 1, id: 'vision-check', kind: 'photo', usable: true, reason: null,
    meta: { seconds: 0, width: 1, height: 1, fps: 0, rotation: 0, hdr: false, has_audio: false, taken_at: null },
    scenes: [{ i: 0, in: 0, out: 0, quality: 5, reasons: ['ok'], luma: 0.5, sharp: 1, shake: 0, motion: 'static',
      faces: { count: 0, x: null, y: null, size: null } }], speech: null, vision: value });
  if (!checked.ok) throw new Error(`Invalid vision JSON: ${checked.problems.join('; ')}`);
  return Object.fromEntries(['subject', 'people', 'faces_visible', 'emotion', 'action', 'framing', 'stage', 'text_in_image', 'risk', 'fit', 'score'].map((k) => [k, value[k]]));
}

async function analyzeVision(ctx, sheet, { model = DEFAULT_MODEL, kind, scenes }) {
  try {
    const complete = ctx.eventVideo?.completeText || require('../nodes/llm').completeText;
    const image = `data:image/png;base64,${(await fs.readFile(sheet)).toString('base64')}`;
    const answer = await complete({ model, system: SYSTEM,
      prompt: `Analyze this ${kind === 'photo' ? 'photo' : 'chronological keyframe sheet'}. Scene spans in source seconds: ${JSON.stringify(scenes.map((s) => [s.in, s.out]))}.`,
      images: [image], json: true, temperature: 0, maxTokens: 1200, sessionId: ctx.sessionId, user: ctx.user,
      budgetKey: ctx.toolCtx?.budgetKey || null, restrictedModels: ctx.config?.restrictedBrainModels || [], unknownCostUsd: 0.006 });
    if (ctx.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    return { vision: readVision(answer.text), usd: answer.usd ?? answer.bookedUsd ?? null };
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || ctx.signal?.aborted) throw err;
    throw Object.assign(new Error(`Vision analysis failed: ${String(err?.message || err).slice(0, 200)}`),
      { code: 'EVENTMEDIA_VISION_FAILED', cause: err });
  }
}

module.exports = { DEFAULT_MODEL, SYSTEM, readVision, analyzeVision };
