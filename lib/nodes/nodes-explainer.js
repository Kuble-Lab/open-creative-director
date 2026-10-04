'use strict';

// Nodes for the explainer video (WP37a): the script and what it is made from.
//   llm.research      a topic -> research notes with numbered evidence and the list of sources (web search of OpenRouter, paid by tokens)
//   input.branding    a branding of the app -> the brand profile as JSON text, and the logo (free)
//   explainer.plan    documents / text / research / brand / brief -> the script (JSON), the narration by scene, the briefs, the prompts for
//                     stills and clips, the shot list and the sources; checks every statement against the sources (paid by tokens)
// The rules of the script live in lib/explainer-plan.js (pure, tested on its own); this module is the adapter to the engine: inputs and
// parameters, the model call (with the PDFs as files where the model reads them), costs, logs and the codes of the errors.
// The lists follow the scenes; shots says where each scene sits in them (SPEC §9.6: lists meet by index).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const or = require('../openrouter');
const falLib = require('../fal');
const access = require('../access');
const brandings = require('../brandings');
const discovery = require('../discovery');
const documentsLib = require('../documents');
const planLib = require('../explainer-plan');
const languageLib = require('../language-detect');
const llm = require('./llm');
const assets = require('./assets');
const generate = require('./nodes-generate');
const { textValue, listValue, sha256Hex, canonicalJson } = require('./types');

const { askModel, usdCost, llmAvailable, openRouterAvailable, itemsOf, MODEL_PARAM, LANGUAGES } = generate;

// The model of the planning nodes when the node names none (see chooseModel).
const DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
const PLAN_MAX_TOKENS = 24000;
const RESEARCH_MAX_TOKENS = 8000;
// PDFs go to the model as files up to this much in all and this many pages each. The providers take about 32 MB per request and the
// files travel as base64 (a third larger) next to the text with the page marks: 22 MB of PDF are about 29 MB on the wire.
const MAX_FILE_BYTES = 22 * 1024 * 1024;
const MAX_FILE_PAGES = 300;
const MAX_DOMAINS = 20;
const MAX_BRAND_GUIDELINES = 8000;
const RASTER_LOGO = /\.(png|jpe?g|webp|gif)$/i;

// The option "same as input" of the parameter language (WP38d): the node decides from the text it gets (lib/language-detect.js, no model
// call). It is the value of NEW nodes (param.initial); a saved node that has no language keeps the default "en", so its language and
// its cache key do not change. Everything below the node (the plan, the subtitles, the scenes) reads the real code from the script.
const AUTO_LANGUAGE = 'auto';
const LANGUAGE_OPTIONS = [AUTO_LANGUAGE, ...Object.keys(LANGUAGES)];
const LANGUAGE_LABELS = { de: 'German', en: 'English', es: 'Spanish' };
const SOURCE_LABELS = {
  own_text: 'your own text',
  topic: 'the topic',
  focus: 'the focus',
  brief: 'the brief',
  text: 'the text input',
  notes: 'the research notes',
  sources: 'the list of sources',
  documents: 'the titles of the documents',
  script: 'the script'
};

// The language a node writes in. A language named in the node is used as it is. "auto" is decided from `sources` ([{ id, text }], what
// the person wrote first, then documents and notes): the first source with a clear result, else the first with a single hint, else
// English. The log says which language and why. Returns a code of the app (de, en, es).
function resolveLanguage(ctx, requested, sources) {
  if (requested !== AUTO_LANGUAGE) return requested;
  const found = languageLib.resolveLanguage(sources);
  const name = LANGUAGE_LABELS[found.language];
  if (!found.source) ctx.log(`Language: ${name} (no hint in the input: English is the default)`);
  else ctx.log(`Language: ${name} (from ${SOURCE_LABELS[found.source] || found.source}${found.strength === 'weak' ? ', few hints' : ''})`);
  return found.language;
}

// The language of the planner. An edited script (phase two) already has its language: with "auto" that one is kept, so the check does not
// depend on the inputs that may have changed since. Otherwise as resolveLanguage, with what the person wrote first: the topic, the brief,
// the text input; after that the research notes, the list of sources and the titles of the documents.
function planLanguage(ctx, requested, { edited, ownText = '', topic, brief, documentsText, notes, sourcesText, documentList }) {
  if (requested !== AUTO_LANGUAGE) return requested;
  const own = edited ? planLib.parseJsonAnswer(edited) : null;
  if (own && planLib.LANGUAGES.includes(own.language)) {
    ctx.log(`Language: ${LANGUAGE_LABELS[own.language]} (from ${SOURCE_LABELS.script})`);
    return own.language;
  }
  return resolveLanguage(ctx, requested, [
    ...(ownText ? [{ id: 'own_text', text: ownText }] : []),
    { id: 'topic', text: topic },
    { id: 'brief', text: brief },
    { id: 'text', text: documentsText },
    { id: 'notes', text: notes },
    { id: 'sources', text: sourcesText },
    { id: 'documents', text: documentList.map((doc) => doc.title || '').join('\n') }
  ]);
}

function explainerError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data) err.data = data;
  return err;
}

const textOf = (inputs, portId) => (inputs[portId] ? String(inputs[portId].value || '') : '');

// The model of a planning node. A model named in the node is used as it is (llm.completeText refuses one the person may not use).
// A blank model is Claude Opus 5.5 over OpenRouter when this person may use it (config.restrictedBrainModels limits participants and
// guests) and OpenRouter is set up; else the model that any other node would use for them (the default of the app, or of their list);
// the log says so.
function personalDefaultModel(ctx) {
  const restrictedModels = ctx.config?.restrictedBrainModels || [];
  const viewer = access.viewerOf({ kubleUser: ctx.user });
  const configured = ctx.config?.defaultBrain || '';
  return access.brainModelFor(viewer, configured, { restrictedModels, defaultBrain: configured }).model || configured;
}

function chooseModel(ctx, params) {
  const named = String(params.model || '').trim();
  if (named) return named;
  const restrictedModels = ctx.config?.restrictedBrainModels || [];
  const viewer = access.viewerOf({ kubleUser: ctx.user });
  // an installation with only the ChatGPT subscription has no OpenRouter key: Opus would fail there
  if (!or.hasKey()) {
    const fallback = personalDefaultModel(ctx);
    if (fallback && fallback !== DEFAULT_MODEL) {
      ctx.log?.(`OPENROUTER_API_KEY is not set, so ${DEFAULT_MODEL} cannot be used: ${fallback} is used instead`);
      return fallback;
    }
    return DEFAULT_MODEL;
  }
  if (access.brainModelAllowed(viewer, DEFAULT_MODEL, restrictedModels)) return DEFAULT_MODEL;
  const fallback = personalDefaultModel(ctx);
  ctx.log?.(`${DEFAULT_MODEL} is not available for your account: ${fallback} is used instead`);
  return fallback;
}

// Cache stamp of the planner (WP38g, review): chooseModel falls back to the default model of the settings when OpenRouter is not set up.
// That setting is not a parameter, so it is part of the key then (the setting only, never what a person may use: the results of a
// workflow are shared). Nothing to add when the node names its model or OpenRouter is there. (llm.research needs OpenRouter for its web
// search, so it never takes the fallback; explainer.scene takes it too but is left as it is, see IMPLEMENTATION-NOTES.)
function fallbackBrainStamp(params, ctx) {
  if (String(params.model || '').trim() || or.hasKey()) return undefined;
  return { fallbackBrain: String(ctx?.config?.defaultBrain || '').trim() };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------- llm.research ---------- */

// Domains typed as a list ("a.com, https://www.b.org/x"): lower case host names, each once.
function parseDomains(text) {
  const found = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    let domain = raw.trim().toLowerCase();
    if (!domain) continue;
    domain = domain.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    found.push(domain);
  }
  return [...new Set(found)];
}

const DOMAIN_PATTERN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

function normaliseUrl(url) {
  try {
    const parsed = new URL(String(url).trim());
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) if (/^utm_/i.test(key)) parsed.searchParams.delete(key);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${pathname}${parsed.search}`;
  } catch (_) {
    return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
  }
}

const FURTHER_SOURCES = Object.freeze({ de: 'Weitere Belege', en: 'Further evidence', es: 'Más fuentes' });
const RETRIEVED = Object.freeze({ de: 'abgerufen', en: 'retrieved', es: 'consultado' });

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return String(url);
  }
}

// The answer of the web search as notes and sources. The model cites with markdown links; every link to a source the search
// returned becomes the number of that source ([1], [2] ... in the order of the sources), a link to anything else is dropped to its
// words, and a source the text does not mention is named at the end. Returns { notes, sources: [{ n, title, url }], text }.
function processResearch(answer, citations, { language = 'en', date = today(), spans = [] } = {}) {
  const numbers = new Map();
  const sources = [];
  for (const citation of citations) {
    const key = normaliseUrl(citation.url);
    if (numbers.has(key)) continue;
    numbers.set(key, sources.length + 1);
    sources.push({ n: sources.length + 1, title: citation.title || hostOf(citation.url), url: citation.url });
  }
  const used = new Set();
  let notes = String(answer || '').replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
    const n = numbers.get(normaliseUrl(url));
    if (!n) return label;
    used.add(n);
    return `[${n}]`;
  });
  // bare URLs of known sources in the text become numbers too
  notes = notes.replace(/(?<![\w(\[])(https?:\/\/[^\s)\]]+)/g, (match) => {
    const n = numbers.get(normaliseUrl(match.replace(/[.,;:]+$/, '')));
    if (!n) return match;
    used.add(n);
    return `[${n}]`;
  });
  // an answer without links: the numbers are put where the search says the source was cited (end_index in the original text)
  if (!used.size && spans.length) {
    const original = String(answer || '');
    const marks = new Map();
    for (const span of spans) {
      const n = numbers.get(normaliseUrl(span.url));
      if (!n) continue;
      const at = Math.min(original.length, span.end);
      if (!marks.has(at)) marks.set(at, []);
      if (!marks.get(at).includes(n)) marks.get(at).push(n);
      used.add(n);
    }
    let out = '';
    let last = 0;
    for (const at of [...marks.keys()].sort((a, b) => a - b)) {
      out += original.slice(last, at) + marks.get(at).map((n) => `[${n}]`).join('');
      last = at;
    }
    notes = out + original.slice(last);
  }
  notes = notes.replace(/(\[\d+\])(\s*\1)+/g, '$1').trim();
  const unused = sources.filter((source) => !used.has(source.n));
  if (unused.length) notes += `\n\n${FURTHER_SOURCES[language] || FURTHER_SOURCES.en}: ${unused.map((source) => `[${source.n}]`).join(' ')}`;
  const retrieved = RETRIEVED[language] || RETRIEVED.en;
  const text = sources.map((source) => `[${source.n}] ${source.title.replace(/\s+/g, ' ')} — ${source.url} (${retrieved} ${date})`).join('\n');
  return { notes, sources, text };
}

function researchSystem({ language, date }) {
  return [
    'You are a careful research assistant. Use the web search results you are given to research the topic.',
    `Today is ${date}. Prefer recent, primary and official sources.`,
    'Rules:',
    '- Write only what the search results support. Do not invent anything, do not fill gaps from memory. If you cannot find something, say so.',
    '- Numbers only with a source: every number, date, name and claim needs one. Give the date of the source (publication or last update) next to figures that can age.',
    '- Where sources contradict each other, say so and name both with their figures. Do not pick one silently.',
    '- Cite each statement with a markdown link to its source straight after it: [short title](https://...). Use no other numbering and no list of sources.',
    '- Structure: short sections with headings and bullet points; plain facts, no marketing words; keep it under about 700 words.',
    `- Write in ${LANGUAGES[language] || LANGUAGES.en}.`
  ].join('\n');
}

const researchDefinition = {
  type: 'llm.research',
  category: 'llm',
  label: 'Research a topic',
  keywords: ['research', 'web', 'search', 'sources', 'facts', 'topic', 'notes', 'citations', 'llm'],
  description:
    'Researches a topic on the web with a language model (the web search of OpenRouter): research notes in which every fact carries a number ' +
    '[1], [2] ... and the list of sources (title, address, date of retrieval). Numbers only with a source, contradictions are named, nothing is invented. ' +
    'Paid by tokens plus about 0.7 cent per search.',
  inputs: [
    { id: 'topic', type: 'text', required: true, param: 'topic' },
    { id: 'focus', type: 'text', param: 'focus' }
  ],
  outputs: [
    { id: 'notes', type: 'text' },
    { id: 'sources', type: 'text' }
  ],
  params: [
    MODEL_PARAM,
    { id: 'topic', kind: 'textarea', default: '', inline: true },
    { id: 'focus', kind: 'textarea', default: '' },
    { id: 'max_results', kind: 'integer', min: 1, max: 20, default: 8 },
    { id: 'language', kind: 'select', options: LANGUAGE_OPTIONS, default: 'en', initial: AUTO_LANGUAGE },
    { id: 'include_domains', kind: 'text', default: '' },
    { id: 'exclude_domains', kind: 'text', default: '' }
  ],
  paid: true,
  provider: 'openrouter',
  // no estimate of its own: the price depends on what the search finds (a template names the order of magnitude); history: false, because
  // the price of an earlier topic says nothing about the next one
  cost: { unit: 'usd', history: false },
  // the web search is a plugin of OpenRouter: the ChatGPT subscription cannot do it
  available: openRouterAvailable,
  validate: (params) => {
    const issues = [];
    for (const field of ['include_domains', 'exclude_domains']) {
      const domains = parseDomains(params[field]);
      if (domains.length > MAX_DOMAINS) issues.push({ code: 'RESEARCH_BAD_DOMAIN', port: null, message: `${field}: at most ${MAX_DOMAINS} domains are allowed`, data: { field } });
      else if (domains.some((domain) => !DOMAIN_PATTERN.test(domain))) issues.push({ code: 'RESEARCH_BAD_DOMAIN', port: null, message: `${field}: write domain names such as example.com, separated by commas`, data: { field } });
    }
    return issues;
  },
  execute: async (ctx, inputs, params) => {
    const topic = textOf(inputs, 'topic').trim();
    if (!topic) throw explainerError('RESEARCH_NO_TOPIC', 'topic: name the topic to research');
    const focus = textOf(inputs, 'focus').trim();
    const model = chooseModel(ctx, params);
    if (llm.isChatGPTModel(model)) throw explainerError('RESEARCH_NEEDS_OPENROUTER', 'The web search needs an OpenRouter model; the ChatGPT subscription cannot search the web', { model });
    const plugin = { id: 'web', max_results: params.max_results };
    const include = parseDomains(params.include_domains);
    const exclude = parseDomains(params.exclude_domains);
    if (include.length) plugin.include_domains = include;
    if (exclude.length) plugin.exclude_domains = exclude;
    const date = today();
    const language = resolveLanguage(ctx, params.language, [{ id: 'topic', text: topic }, { id: 'focus', text: focus }]);
    const result = await askModel(ctx, { ...params, model }, {
      system: researchSystem({ language, date }),
      prompt: [`Topic:\n${topic}`, focus ? `Focus (what matters most):\n${focus}` : ''].filter(Boolean).join('\n\n'),
      plugins: [plugin],
      maxTokens: RESEARCH_MAX_TOKENS
    });
    const processed = processResearch(result.text, result.citations || [], { language, date, spans: result.citationSpans || [] });
    if (processed.sources.length) ctx.log(`${processed.sources.length} ${processed.sources.length === 1 ? 'source' : 'sources'} found (${model})`);
    else ctx.log('The search returned no sources: the notes carry no evidence. Use them with care or search again with other words.');
    return { variants: [{ notes: textValue(processed.notes), sources: textValue(processed.text) }], cost: usdCost([result.usd]) };
  }
};

/* ---------- input.branding ---------- */

const NEUTRAL_BRAND = Object.freeze({
  neutral: true,
  id: '',
  name: 'Neutral',
  description: 'Dark background, one accent colour, system font',
  colors: [
    { role: 'background', name: 'Night', hex: '#0f1115', usage: 'background' },
    { role: 'text', name: 'Snow', hex: '#f4f4f5', usage: 'text' },
    { role: 'accent', name: 'Blue', hex: '#4f8cff', usage: 'accent' }
  ],
  fonts: [
    { role: 'headline', family: 'system-ui', weights: '700', source: 'system', usage: 'titles', asset: null },
    { role: 'body', family: 'system-ui', weights: '400', source: 'system', usage: 'text', asset: null }
  ],
  voice: { tone: '', language: '', dos: '', donts: '' },
  imagery: { style: '' },
  motion: { notes: '', outro: null },
  logos: [],
  guidelines: ''
});

function brandProfile(branding) {
  const file = (reference) => (reference ? path.basename(String(reference)) : null);
  const guidelines = [...String(branding.guidelines || '')].slice(0, MAX_BRAND_GUIDELINES).join('');
  return {
    neutral: false,
    id: branding.id,
    name: branding.name,
    description: branding.description || '',
    colors: (branding.colors || []).map((color) => ({ role: color.role || '', name: color.name || '', hex: color.hex, usage: color.usage || '' })),
    fonts: (branding.typography || []).map((font) => ({
      role: font.role || '',
      family: font.family || '',
      weights: font.weights || '',
      source: font.source || '',
      usage: font.usage || '',
      asset: font.file ? { branding: branding.id, file: file(font.file) } : null
    })),
    voice: { tone: branding.voice?.tone || '', language: branding.voice?.language || '', dos: branding.voice?.dos || '', donts: branding.voice?.donts || '' },
    imagery: { style: branding.imagery?.style || '' },
    motion: { notes: branding.motion?.notes || '', outro: branding.motion?.outro ? { branding: branding.id, file: file(branding.motion.outro) } : null },
    logos: (branding.logos || []).map((logo) => ({ variant: logo.variant || '', file: file(logo.file), usage: logo.usage || '' })),
    guidelines
  };
}

// The logo of a profile: the first one in a format an image port takes (an SVG is not one).
function rasterLogoOf(profile) {
  return profile.logos.find((entry) => entry.file && RASTER_LOGO.test(entry.file)) || null;
}

function speakerIdOf(branding) {
  return branding.speaker && typeof branding.speaker.voiceId === 'string' ? branding.speaker.voiceId.trim() : '';
}

// What the node puts into its cache key besides the branding it names (WP38g): a hash of everything it gives out, so a changed branding
// (tone, colours, fonts, guidelines, logo, speaker voice) makes it run again and what depends on its outputs follows through the keys of
// their inputs: the profile text -> the planner and everything after it, the logo file -> the scenes, the voice -> the speaker and the
// cut. The logo counts by its bytes (an asset of the same bytes is the same logo, see earlierLogo). No branding (the neutral profile
// never changes) and no right to brandings: nothing to add.
function brandingStamp(profileText, logoHash, voice) {
  return { profile: profileText, logo: logoHash || null, voice: voice || '' };
}

async function brandingCacheStamp(params, ctx) {
  const chosen = String(params.branding || '').trim();
  if (!chosen) return undefined;
  if (access.isRestricted(access.viewerOf({ kubleUser: ctx.user }))) return undefined;
  let id;
  let branding;
  try {
    id = await brandings.resolveBrandingId(chosen);
    branding = await brandings.readBranding(id);
  } catch (err) {
    if (err.code === 'BRANDING_NOT_FOUND') return { missing: chosen };
    throw err;
  }
  const profile = brandProfile(branding);
  const logo = rasterLogoOf(profile);
  let logoHash = null;
  if (logo) {
    try {
      logoHash = sha256Hex(await brandings.readBrandingAsset(id, logo.file));
    } catch (_) {
      logoHash = null;
    }
  }
  return brandingStamp(JSON.stringify(profile, null, 2), logoHash, speakerIdOf(branding));
}

// An entry from before the node had a stamp stands for the branding of now when its outputs say the same: the profile text, the bytes of
// the logo asset it holds (hashed from the file, an old entry stores no hash) and the voice. Then the node need not run again and nothing
// after it does.
async function brandingEntryIsCurrent(entry, { stamp }) {
  const variant = entry?.variants?.[0];
  if (!variant || variant.brand?.type !== 'text') return false;
  let logoHash = null;
  if (variant.logo) {
    try {
      logoHash = sha256Hex(await fsp.readFile(assets.assetFilePath(variant.logo)));
    } catch (_) {
      return false;
    }
  }
  const stored = brandingStamp(variant.brand.value, logoHash, variant.voice?.type === 'text' ? variant.voice.value : '');
  return canonicalJson(stored) === canonicalJson(stamp);
}

// The asset an earlier run of this node made of the same logo bytes, or null. A node run again with an unchanged logo keeps its asset
// (the same sessionId and assetId), so what takes the logo as an input (a scene that is paid for) is not made again for nothing. The
// files of the earlier results are hashed, so entries from before the hash was kept count as well.
async function earlierLogo(ctx, hash) {
  const tried = new Set();
  for (const variant of ctx.earlierVariants ? ctx.earlierVariants() : []) {
    const logo = variant && variant.logo;
    if (!logo || logo.type !== 'image' || logo.sessionId !== ctx.sessionId || tried.has(logo.assetId)) continue;
    tried.add(logo.assetId);
    if (tried.size > 10) break;
    try {
      const value = await assets.valueFromAsset(ctx.sessionId, logo.assetId);
      if (sha256Hex(await fsp.readFile(assets.assetFilePath(value))) === hash) return value;
    } catch (_) {
      // the asset is gone or not readable: not this one
    }
  }
  return null;
}

// What the node gives when it runs now, said before it runs (def.cacheStampOutputs): the stamp holds the profile text and the voice, and
// the logo is the asset of an earlier result with the same bytes. A logo that no earlier result holds is a new asset that exists only
// after the run: that output is named as unknown, and what depends on the logo is planned as out of date. This lets the plan show only
// what a changed branding really changes (a new voice: the speaker and the cut; a new tone: the planner and what follows it).
async function brandingStampOutputs(raw, { ctx, nodeResults }) {
  if (!raw || raw.missing || typeof raw.profile !== 'string') return null;
  const outputs = { brand: textValue(raw.profile) };
  const unknown = [];
  if (raw.voice) outputs.voice = textValue(raw.voice);
  if (raw.logo) {
    const earlier = await earlierLogo({
      sessionId: ctx.sessionId,
      earlierVariants: () => (nodeResults?.history || []).slice(0, 50).flatMap((entry) => entry.variants || [])
    }, raw.logo);
    if (earlier) outputs.logo = earlier;
    else unknown.push('logo');
  }
  return { outputs, unknown };
}

const brandingDefinition = {
  type: 'input.branding',
  category: 'input',
  label: 'Branding',
  keywords: ['branding', 'brand', 'colors', 'fonts', 'logo', 'design', 'style', 'corporate identity'],
  description:
    'Gives a branding of the app to the next nodes: the brand profile as a JSON text (name, colours, fonts with their file, tone of voice, ' +
    'guidelines), the logo as an image and the ID of the speaker voice as a text (connect it to the input Voice of a speech node: the voice ' +
    'of the brand replaces the choice there; a branding without a speaker voice leaves it empty). Without a branding: a neutral profile ' +
    '(dark background, one accent colour, system font), no logo and no voice. A changed branding is noticed: the node runs again and ' +
    'what depends on the changed part follows (an unchanged logo keeps its file).',
  inputs: [],
  outputs: [
    { id: 'brand', type: 'text' },
    { id: 'logo', type: 'image' },
    { id: 'voice', type: 'text' }
  ],
  params: [{ id: 'branding', kind: 'select', optionsSource: 'brandings', default: '', inline: true }],
  cost: { unit: 'local' },
  // without a branding there is no logo and no voice: an input that waits for it is told before anything runs
  emptyOutputs: (params) => (String(params.branding || '').trim() ? [] : ['logo', 'voice']),
  emptyOutputsSwitched: true,
  // the content of the branding is part of the key (see brandingStamp); the node is free, so an old entry is only taken when it says
  // the same as the branding of now
  cacheStamp: brandingCacheStamp,
  cacheStampAdopts: brandingEntryIsCurrent,
  cacheStampOutputs: brandingStampOutputs,
  execute: async (ctx, _inputs, params) => {
    const chosen = String(params.branding || '').trim();
    if (!chosen) {
      ctx.log('No branding chosen: the neutral profile is used');
      return { variants: [{ brand: textValue(JSON.stringify(NEUTRAL_BRAND, null, 2)) }] };
    }
    // brandings are internal resources: participants and guests have none
    if (access.isRestricted(access.viewerOf({ kubleUser: ctx.user }))) {
      throw new access.RoleRestrictedError('brandings', 'Brandings are not available for your account', 'Brandings sind für dein Konto nicht verfügbar.');
    }
    let id;
    let branding;
    try {
      id = await brandings.resolveBrandingId(chosen);
      branding = await brandings.readBranding(id);
    } catch (err) {
      if (err.code === 'BRANDING_NOT_FOUND') throw explainerError('BRANDING_NOT_FOUND', `The branding "${chosen}" does not exist (any more); choose another`, { branding: chosen });
      throw err;
    }
    const profile = brandProfile(branding);
    const variant = { brand: textValue(JSON.stringify(profile, null, 2)) };
    // The speaker voice is an output of its own, never part of the profile (the profile is the text that the keys of the planner and of
    // every scene are made of: a voice must not renew them). A branding without one leaves the output empty; a node that waits for
    // it (an optional input) runs without it and takes its own choice.
    const speaker = speakerIdOf(branding);
    if (speaker) {
      variant.voice = textValue(speaker);
      ctx.log(`Speaker voice of the branding: ${branding.speaker.name || speaker}`);
    }
    // the logo: the first one in a format an image port takes (an SVG is not one)
    const logo = rasterLogoOf(profile);
    if (logo) {
      try {
        const buffer = await brandings.readBrandingAsset(id, logo.file);
        // the same bytes as in an earlier result of this node: the same asset (stable keys for everything that takes the logo)
        const earlier = await earlierLogo(ctx, sha256Hex(buffer));
        if (earlier) {
          variant.logo = earlier;
          ctx.log('The logo is unchanged: the file of the earlier result is used');
        } else {
          const scratch = await assets.createScratchDir(ctx.sessionId);
          try {
            const ext = path.extname(logo.file).toLowerCase().replace('.jpeg', '.jpg');
            const target = path.join(scratch, `logo${ext}`);
            await fsp.writeFile(target, buffer);
            variant.logo = await ctx.saveOutputFile({ kind: 'image', ext, sourceFile: target, prompt: `Logo: ${branding.name}`, cost: 0 });
          } finally {
            await assets.removeScratchDir(scratch);
          }
        }
      } catch (err) {
        ctx.log(`The logo ${logo.file} could not be read (${String(err.message || err).slice(0, 120)}): no logo`);
      }
    } else if (profile.logos.length) ctx.log('The branding has no logo as PNG, JPG, WebP or GIF (an SVG is not used): no logo');
    else ctx.log('The branding has no logo');
    ctx.log(`Branding ${branding.name}: ${profile.colors.length} colours, ${profile.fonts.length} fonts`);
    return { variants: [variant] };
  }
};

/* ---------- explainer.plan ---------- */

// What the text from "Read documents" says about its documents: "=== D1: name.pdf (12 pages) ===" -> [{ name, title, pageCount }].
// `info` is the info text of the same node (JSON): the title of a document there is the title of the PDF (its metadata) where it has
// one, else the name of the file without its ending; the title is what the sources card and the source lines show.
function documentsFromText(text, info) {
  const found = [];
  const pattern = /^=== D(\d+): (.+?) \((\d+) pages?(?:, only the first \d+ read)?\) ===$/gm;
  for (const match of String(text || '').matchAll(pattern)) {
    found[Number.parseInt(match[1], 10) - 1] = { name: match[2], title: match[2].replace(/\.[A-Za-z0-9]{1,5}$/, ''), pageCount: Number.parseInt(match[3], 10) };
  }
  const listed = Array.isArray(info?.documents) ? info.documents : [];
  const merged = Array.from(found, (doc, index) => doc || { name: `document-${index + 1}`, title: `document-${index + 1}`, pageCount: null });
  merged.forEach((doc, index) => {
    const title = typeof listed[index]?.title === 'string' ? listed[index].title.replace(/\s+/g, ' ').trim() : '';
    if (title) doc.title = title;
  });
  return merged;
}

function capabilities(ctx) {
  return { image: or.hasKey() && Boolean(ctx.config?.imageModel), fal: falLib.hasKey() };
}

function parseJsonText(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

// The PDFs among the documents as files for the model: [{ filename, dataUrl }] up to the byte limit; the rest is named in `skipped`.
async function pdfFiles(documents) {
  const files = [];
  const skipped = [];
  let bytes = 0;
  for (const value of documents) {
    const name = value.name || value.file;
    if (path.extname(String(value.file || '')).toLowerCase() !== '.pdf') continue;
    if (Number.isInteger(value.pages) && value.pages > MAX_FILE_PAGES) {
      skipped.push(`${name}: ${value.pages} pages`);
      continue;
    }
    const file = assets.assetFilePath(value);
    const size = (await fsp.stat(file)).size;
    if (bytes + size > MAX_FILE_BYTES) {
      skipped.push(`${name}: ${Math.round(size / (1024 * 1024))} MB`);
      continue;
    }
    bytes += size;
    files.push({ filename: String(name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document.pdf', dataUrl: `data:application/pdf;base64,${(await fsp.readFile(file)).toString('base64')}` });
  }
  return { files, skipped, bytes };
}

function planEstimate(params, context) {
  if (String(params.script || '').trim()) return { usd: 0 };
  const model = String(params.model || '').trim() || DEFAULT_MODEL;
  const restricted = context.config?.restrictedBrainModels || [];
  // a participant whose list lacks Opus gets another model, whose price is not known here
  if (!String(params.model || '').trim() && restricted.length && !restricted.includes(DEFAULT_MODEL)) return null;
  // without OpenRouter the blank model is the default of the app, whose price is not known here
  if (!String(params.model || '').trim() && !or.hasKey()) return null;
  const inputs = context.inputs || {};
  const connected = context.connected || new Set();
  // an input whose node has not run yet: the size of the material is not known
  for (const port of ['documents', 'text', 'own_text', 'notes', 'sources', 'topic', 'brief', 'brand']) if (connected.has(port) && !inputs[port]) return null;
  const list = inputs.documents ? (inputs.documents.type === 'list' ? inputs.documents.items : [inputs.documents]) : [];
  let pdfPages = 0;
  let pdfUnknown = false;
  for (const value of list) {
    if (path.extname(String(value?.file || '')).toLowerCase() !== '.pdf') continue;
    if (Number.isInteger(value.pages)) pdfPages += Math.min(value.pages, MAX_FILE_PAGES);
    else pdfUnknown = true;
  }
  const chars = ['text', 'own_text', 'notes', 'sources', 'topic', 'brief', 'brand'].reduce((sum, id) => sum + String(inputs[id]?.value ?? params[id] ?? '').length, 0);
  const usd = planLib.estimateUsd({ model, pdfPages, pdfUnknown, textChars: chars, verify: params.verify !== false && !inputs.own_text });
  return usd === null ? null : { usd };
}

// What the script owes to the providers of this installation, in one line per reason: "2 scenes: clip -> still (fal_unavailable)".
function downgradeLines(downgrades) {
  const groups = new Map();
  for (const note of downgrades) {
    const key = `${note.from} -> ${note.to} (${note.reason})`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups].map(([key, count]) => `${count} ${count === 1 ? 'scene' : 'scenes'}: ${key}`);
}

const planDefinition = {
  type: 'explainer.plan',
  category: 'llm',
  label: 'Plan explainer video',
  keywords: ['explainer', 'video', 'script', 'plan', 'scenes', 'pdf', 'document', 'research', 'narration', 'storyboard', 'llm'],
  description:
    'Plans an explainer video from documents (PDF, TXT, MD) and/or a topic with research notes: the script with scenes, narration, text on screen, ' +
    'numbers, a source for every statement, and a pass that checks every statement against the sources. Outputs are lists by scene. The script can ' +
    'be edited and fed back in without another model call. With the visual mode "typography" every scene is kinetic typography (the words to stress, a layout ' +
    'and a camera hint for each scene, no pictures and no clips). With a text on the input "Own text" the narration is that text, word for word: the model only ' +
    'cuts it into scenes. Paid by tokens.',
  inputs: [
    { id: 'documents', type: 'document[]' },
    { id: 'text', type: 'text' },
    { id: 'own_text', type: 'text' },
    { id: 'topic', type: 'text', param: 'topic' },
    { id: 'notes', type: 'text' },
    { id: 'sources', type: 'text' },
    { id: 'info', type: 'text' },
    { id: 'brand', type: 'text' },
    { id: 'brief', type: 'text', param: 'brief' }
  ],
  outputs: [
    { id: 'script', type: 'text' },
    { id: 'narration', type: 'text[]' },
    { id: 'narration_context', type: 'text[]' },
    { id: 'briefs', type: 'text[]' },
    { id: 'image_prompts', type: 'text[]' },
    { id: 'clip_prompts', type: 'text[]' },
    { id: 'shots', type: 'text' },
    { id: 'sources', type: 'text' },
    { id: 'presenter', type: 'text[]' }
  ],
  params: [
    MODEL_PARAM,
    { id: 'topic', kind: 'textarea', default: '' },
    { id: 'brief', kind: 'textarea', default: '', inline: true },
    { id: 'length_seconds', kind: 'integer', min: planLib.LIMITS.minLengthSeconds, max: planLib.LIMITS.maxLengthSeconds, default: 120 },
    { id: 'language', kind: 'select', options: LANGUAGE_OPTIONS, default: 'en', initial: AUTO_LANGUAGE },
    { id: 'audience', kind: 'text', default: '' },
    { id: 'tone', kind: 'select', options: planLib.TONES, default: 'factual' },
    { id: 'visual_mode', kind: 'select', options: planLib.VISUAL_MODES, default: 'mix' },
    { id: 'format', kind: 'select', options: planLib.FORMATS, default: 'landscape' },
    { id: 'max_still_share', kind: 'slider', min: 0, max: 0.5, step: 0.05, default: 0.35, showIf: { param: 'visual_mode', equals: 'mix' } },
    // off: no scene is planned as a generated video clip (a workflow without a clip chain, or without fal.ai: the scenes become motion graphics)
    { id: 'clips', kind: 'boolean', default: true, showIf: { param: 'visual_mode', in: ['mix', 'ai_video'] } },
    { id: 'presenter', kind: 'select', options: planLib.PRESENTER_MODES, default: 'off' },
    { id: 'verify', kind: 'boolean', default: true },
    { id: 'script', kind: 'textarea', default: '' }
  ],
  paid: true,
  provider: 'llm',
  // The kinds of pictures the planner may plan (generated images, clips) depend on the settings and the keys of the app, which are no
  // parameters: a setting that is set or removed makes the planner run again. With them the model of the settings when OpenRouter is
  // missing (fallbackBrainStamp). An entry from before is taken once for the state of now, so a deploy costs nothing.
  cacheStamp: async (params, ctx) => {
    const kinds = capabilities(ctx);
    if (params.clips === false) kinds.fal = false;
    return { images: kinds, ...fallbackBrainStamp(params, ctx) };
  },
  cacheStampAdopts: true,
  // history: false: a price from an earlier run says nothing about the next document
  cost: { unit: 'usd', estimate: planEstimate, history: false },
  available: llmAvailable,
  validate: (params, ports) => {
    const script = String(params.script || '').trim();
    if (script) {
      return planLib.parseJsonAnswer(script) ? [] : [{ code: 'EXPLAINER_SCRIPT_INVALID', port: null, message: 'script: the text is not a JSON script; paste the output "Script" of this node' }];
    }
    const material = ['documents', 'text', 'own_text', 'notes', 'topic'].some((id) => ports[id]?.connected) || String(params.topic || '').trim();
    return material ? [] : [{ code: 'EXPLAINER_NO_MATERIAL', port: 'documents', message: 'Give the planner something to work from: a document, a text, research notes or a topic' }];
  },
  execute: async (ctx, inputs, params) => {
    const documents = itemsOf(inputs, 'documents').filter((value) => value && value.type === 'document');
    // an own text (WP40): it is the narration, word for word; the planner cuts it into scenes and does not write it
    const ownText = textOf(inputs, 'own_text').trim();
    const verbatim = Boolean(ownText);
    const documentsText = textOf(inputs, 'text').trim();
    const notes = textOf(inputs, 'notes').trim();
    const sourcesText = textOf(inputs, 'sources').trim();
    const topic = textOf(inputs, 'topic').trim();
    const brief = textOf(inputs, 'brief').trim();
    const brandText = textOf(inputs, 'brand').trim();
    let brand = null;
    if (brandText) {
      brand = parseJsonText(brandText);
      if (!brand) ctx.log('The brand input is not a JSON profile: it is ignored');
    }

    const infoText = textOf(inputs, 'info').trim();
    const documentList = documentsFromText(documentsText, infoText ? parseJsonText(infoText) : null);
    if (!documentList.length) documents.forEach((value) => documentList.push({ name: value.name || value.file, title: String(value.name || value.file).replace(/\.[A-Za-z0-9]{1,5}$/, ''), pageCount: Number.isInteger(value.pages) ? value.pages : null }));
    const researchSources = planLib.parseSourcesText(sourcesText);
    const caps = capabilities(ctx);
    if (params.clips === false) caps.fal = false;
    const edited = String(params.script || '').trim();
    const language = planLanguage(ctx, params.language, { edited, ownText, topic, brief, documentsText, notes, sourcesText, documentList });
    const settings = {
      language,
      format: params.format,
      visualMode: params.visual_mode,
      audience: params.audience,
      tone: params.tone,
      lengthSeconds: params.length_seconds,
      maxStillShare: params.max_still_share,
      presenter: params.presenter,
      documents: documentList,
      sources: researchSources,
      hasNotes: Boolean(notes),
      verbatim,
      verbatimText: ownText,
      capabilities: caps
    };
    if (verbatim && !edited) {
      const seconds = planLib.secondsFor(ownText, language);
      if (seconds > planLib.LIMITS.verbatimMaxSeconds) {
        throw explainerError('EXPLAINER_TEXT_TOO_LONG', `The own text is about ${Math.round(seconds)} s when spoken; at most ${planLib.LIMITS.verbatimMaxSeconds} s (${planLib.wordsFor(planLib.LIMITS.verbatimMaxSeconds, language)} words) are possible. Shorten the text or make two videos.`, { seconds: Math.round(seconds), max: planLib.LIMITS.verbatimMaxSeconds });
      }
    }
    const costs = [];

    /* phase 2 of the two-step way: the script was edited and is only checked */
    let script;
    let model = null;
    if (edited) {
      // an edited script is the person's second word: its narration is not held against the own text any more
      const parsed = planLib.parseScriptText(edited, { ...settings, verbatimText: '' });
      if (parsed.error) throw explainerError('EXPLAINER_SCRIPT_INVALID', `script: ${parsed.error}`);
      script = parsed.script;
      ctx.log('The script of the parameter "script" is checked and used: no model call, no cost');
      if (parsed.editedAfterCheck) ctx.log('The script was edited after the check against the sources: it is not verified any more');
    } else {
      if (!documents.length && !documentsText && !notes && !topic && !verbatim) throw explainerError('EXPLAINER_NO_MATERIAL', 'Give the planner something to work from: a document, a text, research notes or a topic');
      model = chooseModel(ctx, params);

      // the PDFs go along as files where the model reads them; every model gets the text with the page marks
      let files = [];
      if (documents.length) {
        if (llm.isChatGPTModel(model)) ctx.log(`${model} cannot read files: only the text is sent`);
        else if (!(await discovery.brainSupportsFiles(model))) ctx.log(`${model} cannot read files: only the text is sent`);
        else {
          const prepared = await pdfFiles(documents);
          files = prepared.files;
          if (prepared.skipped.length) ctx.log(`Not sent as files (too large): ${prepared.skipped.join('; ')}`);
        }
        if (!documentsText) ctx.log('No text input: connect "Read documents" for the page marks and for the check of every statement');
      }
      const request = { ...settings, brief, topic, brand, notes, sourcesText, documentsText, filesSent: files.length > 0 };
      const system = planLib.systemPrompt(settings);
      const callModel = (prompt) =>
        askModel(ctx, { ...params, model }, {
          system,
          prompt,
          files,
          json: true,
          maxTokens: PLAN_MAX_TOKENS,
          onFilesSkipped: (info) => ctx.log(`${info.model} cannot read files: only the text is sent`)
        });

      // a: the plan, read and checked; one repair where the answer cannot be used as it is
      let built = null;
      let previous = '';
      let problems = [];
      let lastIssues = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await callModel(planLib.userPrompt({ ...request, previous, problems }));
        costs.push(result.usd);
        const data = planLib.parseJsonAnswer(result.text);
        const next = data ? planLib.buildScript(data, settings) : { script: null, issues: [{ severity: 'error', code: 'NOT_JSON', message: 'The answer is not a JSON object.' }], hasErrors: true };
        // a usable script of an earlier attempt is better than an unusable later one
        if (next.script || !built) built = next.script ? next : built || next;
        lastIssues = next.issues;
        if (!next.hasErrors) break;
        const errors = next.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
        if (attempt === 0) {
          ctx.log(`The plan had ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'}: asking once more (${errors.slice(0, 2).join(' ').slice(0, 200)})`);
          previous = result.text;
          problems = errors;
        } else if (next.script) {
          ctx.log(`Still ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} after the repair; corrected by the node where possible`);
        }
      }
      if (!built || !built.script) throw explainerError('EXPLAINER_PLAN_INVALID', `The model did not deliver a usable plan: ${(built?.issues || []).map((issue) => issue.message).join(' ').slice(0, 300)}`);
      script = built.script;
      // the model changed words of the own text even after the repair: the app cut the text itself, and the person is told
      const changed = verbatim ? lastIssues.find((issue) => issue.code === 'VERBATIM_CHANGED') : null;
      if (changed) ctx.log(`Own text: ${changed.message} The scenes were cut from your text by the app, your words are unchanged`);
    }

    /* b: the check of every statement against the sources (not for an edited script, which is not paid for) */
    const material = Boolean(documentsText || notes);
    if (!edited) {
      if (verbatim) {
        // the narration is the person's own: there is nothing the sources could correct
        ctx.log('Own text: the narration is your text word for word, so it is not checked against sources');
      } else if (params.verify && material) {
        try {
          const result = await askModel(ctx, { ...params, model }, {
            system: planLib.verifySystemPrompt(settings),
            prompt: planLib.verifyUserPrompt(script, { documentsText, notes, sourcesText }),
            json: true,
            maxTokens: PLAN_MAX_TOKENS
          });
          costs.push(result.usd);
          const applied = planLib.applyVerification(script, result.text, settings);
          script = applied.script;
          // the problems are always told: a check that skipped scenes does not make the script verified
          if (applied.problems.length) {
            const lead = applied.rejected ? 'The check pass was not applied' : script.unverified_scenes?.length ? 'The check pass is incomplete' : 'The check pass could not be read';
            ctx.log(`${lead}: ${applied.problems.slice(0, 3).join(' ')}${applied.problems.length > 3 ? ` (and ${applied.problems.length - 3} more)` : ''}`);
          }
          const removed = script.removed_claims.filter((claim) => claim.action === 'removed').length;
          const softened = script.removed_claims.filter((claim) => claim.action === 'softened').length;
          if (script.verified) ctx.log(`Checked against the sources: ${removed} ${removed === 1 ? 'statement' : 'statements'} removed, ${softened} softened`);
          else if (script.unverified_scenes?.length) {
            ctx.log(`Checked against the sources: ${removed} ${removed === 1 ? 'statement' : 'statements'} removed, ${softened} softened; not checked: ${script.unverified_scenes.join(', ')}. The script is not verified`);
          }
        } catch (err) {
          if (ctx.signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
          ctx.log(`The check pass failed (${String(err.message || err).slice(0, 160)}): the script is not verified`);
        }
      } else if (params.verify) {
        ctx.log('Nothing to check the statements against (no document text, no research): the script is not verified');
      } else {
        ctx.log('The check pass is switched off: the script is not verified');
      }
    }

    if (verbatim && !edited) {
      const text = planLib.alignNarration(ownText, script.scenes.map((scene) => scene.narration));
      if (!text.ok) ctx.log(`Own text: ${text.message}`);
      else ctx.log(`Own text: ${script.scenes.filter((scene) => scene.narration).length} scenes, your words unchanged`);
    }
    for (const line of downgradeLines(script.downgrades)) ctx.log(line);
    for (const warning of script.warnings.slice(0, 5)) ctx.log(`Note: ${warning}`);
    const lists = planLib.outputsOf(script, { date: planLib.retrievedDateOf(sourcesText) });
    ctx.log(`${script.scenes.length} scenes, about ${lists.shots.duration} s, ${lists.shots.counts.images} stills, ${lists.shots.counts.clips} clips${script.verified ? ', verified' : ''}`);
    return {
      variants: [
        {
          script: textValue(JSON.stringify(script, null, 2)),
          narration: listValue('text', lists.narration.map(textValue)),
          narration_context: listValue('text', lists.narrationContext.map(textValue)),
          briefs: listValue('text', lists.briefs.map(textValue)),
          image_prompts: listValue('text', lists.imagePrompts.map(textValue)),
          clip_prompts: listValue('text', lists.clipPrompts.map(textValue)),
          shots: textValue(JSON.stringify(lists.shots, null, 2)),
          sources: textValue(lists.sourcesText),
          presenter: listValue('text', lists.presenter.map(textValue))
        }
      ],
      cost: edited ? { usd: 0 } : usdCost(costs)
    };
  }
};

const definitions = [researchDefinition, brandingDefinition, planDefinition];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = {
  DEFAULT_MODEL,
  definitions,
  registerAll,
  chooseModel,
  processResearch,
  parseDomains,
  brandProfile,
  NEUTRAL_BRAND,
  documentsFromText,
  planEstimate,
  // for the tests
  fs
};
