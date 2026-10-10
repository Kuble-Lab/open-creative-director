'use strict';

const fs = require('fs/promises');
const contract = require('./contract');
// The default vision model; callers may select another allowed brain model.
const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
// The request budget: 1200 response tokens, a USD 0.006 booking fallback and bounded error text.
const MAX_RESPONSE_TOKENS = 1200;
// Fallback booking in USD when the model price is unknown.
const UNKNOWN_COST_USD = 0.006;
// The number of texts in the image info v1 allows (MAX_TEXT_IN_IMAGE of the contract, which does not export it).
const MAX_TEXTS_IN_IMAGE = 20;
// Maximum diagnostic characters retained in provider error messages.
const ERROR_CHARS = 200;
// Visible-evidence prompt mirrors info v1's enums and limits; keep its wording stable for provider output. The risks are defined one by one:
// a live test on real event photos (2026-10-10) showed that «report risks conservatively» made the model tag every speaker as unflattering
// and every bottle on a shelf as alcohol_close, so the planner would have dropped the best keynote photos.
const SYSTEM = `Describe only visible evidence in these event keyframes. Do not invent identities or event facts.
Return one JSON object with exactly these fields:
subject (nonempty English description, at most 140 characters), people (one of the strings ${contract.PEOPLE.map((p) => `"${p}"`).join(', ')}),
faces_visible (boolean), emotion (${contract.EMOTIONS.join('|')}), action (${contract.ACTIONS.join('|')}),
framing (${contract.FRAMINGS.join('|')}), stage (boolean), text_in_image (up to 20 verbatim strings, <=120 characters each),
risk (unique tags from ${contract.RISKS.join('|')}), fit (unique tags from ${contract.FITS.join('|')}), score (integer 1..5).
Risks, each only when it is clearly visible (when in doubt, leave it out):
- child: a person who clearly looks younger than 16.
- unflattering: a clearly embarrassing moment of a person: eyes half closed in a blink, a mouth full of food, a grimace, a clothing mishap.
  Speaking with an open mouth, gesturing, a side or back view or a serious face are normal at an event and NOT unflattering.
- eating: a person in the foreground chewing or with food at the mouth.
- alcohol_close: a person in the foreground drinking or holding an alcoholic drink. Bottles on a shelf or a bar in the background do not count.
- badge_readable: a name on a badge can be read. screen_readable: a slide or screen has readable text.
The sheet is in chronological reading order. Never add prose outside the JSON.`;

// The model keeps the shape but not always the limits (a subject of 169 characters, people as the number 0): the reader repairs what can be
// repaired without changing the meaning (cut a text at a word, read a number as its string, drop unknown tags) and only then checks the shape.
function repairVision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const limits = contract.TEXT_LIMITS;
  const cut = (text, max) => {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if ([...clean].length <= max) return clean;
    const head = [...clean].slice(0, max).join('');
    const space = head.lastIndexOf(' ');
    return (space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '');
  };
  const known = (list, allowed) => [...new Set((Array.isArray(list) ? list : []).map((tag) => String(tag).trim()).filter((tag) => allowed.includes(tag)))];
  const out = { ...value };
  if (typeof out.subject === 'string') out.subject = cut(out.subject, limits.subject);
  if (typeof out.people === 'number') out.people = out.people >= 6 ? 'crowd' : out.people >= 2 ? '2-5' : String(Math.max(0, Math.round(out.people)));
  if (Array.isArray(out.text_in_image)) {
    out.text_in_image = out.text_in_image
      .map((text) => cut(text, limits.textInImage))
      .filter(Boolean)
      .slice(0, MAX_TEXTS_IN_IMAGE);
  }
  if (out.risk !== undefined) out.risk = known(out.risk, contract.RISKS);
  if (out.fit !== undefined) out.fit = known(out.fit, contract.FITS);
  if (typeof out.score === 'number') out.score = Math.min(5, Math.max(1, Math.round(out.score)));
  return out;
}

// Strip an optional JSON fence and reuse info v1 validation before keeping only its vision fields.
function readVision(text) {
  const raw = JSON.parse(
    String(text)
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
  );
  const value = repairVision(raw);
  // Reuse the contract's vision checks without requiring a second schema implementation.
  const checked = contract.checkInfo({
    version: 1,
    id: 'vision-check',
    kind: 'photo',
    usable: true,
    reason: null,
    meta: { seconds: 0, width: 1, height: 1, fps: 0, rotation: 0, hdr: false, has_audio: false, taken_at: null },
    scenes: [
      {
        i: 0,
        in: 0,
        out: 0,
        quality: 5,
        reasons: ['ok'],
        luma: 0.5,
        sharp: 1,
        shake: 0,
        motion: 'static',
        faces: { count: 0, x: null, y: null, size: null }
      }
    ],
    speech: null,
    vision: value
  });
  if (!checked.ok) throw new Error(`Invalid vision JSON: ${checked.problems.join('; ')}`);
  return Object.fromEntries(
    ['subject', 'people', 'faces_visible', 'emotion', 'action', 'framing', 'stage', 'text_in_image', 'risk', 'fit', 'score'].map((k) => [
      k,
      value[k]
    ])
  );
}

// Send only the reduced contact sheet, with scene spans in source seconds, and preserve provider failures.
async function analyzeVision(ctx, sheet, { model = DEFAULT_MODEL, kind, scenes }) {
  try {
    const complete = ctx.eventVideo?.completeText || require('../nodes/llm').completeText;
    const image = `data:image/png;base64,${(await fs.readFile(sheet)).toString('base64')}`;
    const answer = await complete({
      model,
      system: SYSTEM,
      prompt:
        `Analyze this ${kind === 'photo' ? 'photo' : 'chronological keyframe sheet'}. ` +
        `Scene spans in source seconds: ${JSON.stringify(scenes.map((s) => [s.in, s.out]))}.`,
      images: [image],
      json: true,
      temperature: 0,
      maxTokens: MAX_RESPONSE_TOKENS,
      sessionId: ctx.sessionId,
      user: ctx.user,
      budgetKey: ctx.toolCtx?.budgetKey || null,
      restrictedModels: ctx.config?.restrictedBrainModels || [],
      unknownCostUsd: UNKNOWN_COST_USD
    });
    if (ctx.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    return { vision: readVision(answer.text), usd: answer.usd ?? answer.bookedUsd ?? null };
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || ctx.signal?.aborted) throw err;
    throw Object.assign(new Error(`Vision analysis failed: ${String(err?.message || err).slice(0, ERROR_CHARS)}`), {
      code: 'EVENTMEDIA_VISION_FAILED',
      cause: err
    });
  }
}

module.exports = { DEFAULT_MODEL, SYSTEM, readVision, repairVision, analyzeVision };
