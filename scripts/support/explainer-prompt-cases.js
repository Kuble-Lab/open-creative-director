'use strict';

// The texts that the explainer video sends to the language models, for the visual modes that exist since WP37: motion, mix and ai_video.
// compute() was run on the code of the day before WP40 (the mode "typography") and written to
// scripts/support/explainer-prompts-before-wp40.json; test-explainer-typography.js computes it again with the code of the branch and
// compares: in the other modes every prompt, brief, shot list and fixed scene is the old one byte for byte.

const BRAND = {
  name: 'Example Brand',
  colors: [
    { name: 'Background', hex: '#101820', role: 'background' },
    { name: 'Text', hex: '#f2f2f2', role: 'text' },
    { name: 'Accent', hex: '#ff6b35', role: 'accent' },
    { name: 'Secondary', hex: '#00a6a6', role: 'secondary' }
  ],
  fonts: [
    { family: 'Example Sans', role: 'headline' },
    { family: 'Example Serif', role: 'body' }
  ],
  motion: { notes: 'Calm, precise movements.' }
};

const ANSWER = {
  title: 'Heat pumps',
  summary: 'How they work',
  scenes: [
    {
      kind: 'motion',
      role: 'hook',
      narration: 'A heat pump moves heat instead of making it, and that is why it needs so little power.',
      on_screen: { title: 'Heat, moved', bullets: ['Moves heat', 'Little power'], numbers: [{ value: '4 kWh', label: 'heat from 1 kWh of power' }], quote: null },
      elements: [{ type: 'title', content: 'Heat, moved', anchor: 'heat pump' }, { type: 'number', content: '4 kWh heat from 1 kWh of power', anchor: 'little power' }],
      source_refs: ['p. 1']
    },
    {
      kind: 'motion',
      role: 'point',
      narration: 'The seasonal performance factor tells you how much heat you get for each unit of electricity over a whole year.',
      on_screen: { title: 'Seasonal factor', bullets: [], numbers: [], quote: null },
      elements: [{ type: 'title', content: 'Seasonal factor', anchor: 'seasonal' }],
      source_refs: ['p. 2']
    },
    {
      kind: 'motion',
      role: 'summary',
      narration: 'So a good heat pump gives you about four units of heat for every unit of power you pay for.',
      on_screen: { title: 'Four to one', bullets: [], numbers: [], quote: null },
      elements: [{ type: 'title', content: 'Four to one', anchor: 'four' }],
      source_refs: ['p. 2']
    }
  ]
};

function compute({ planLib, sceneLib }) {
  const out = {};
  const base = { language: 'en', lengthSeconds: 40, format: 'landscape', documents: [{ name: 'report.pdf', title: 'Report', pageCount: 4 }], capabilities: { image: true, fal: true } };
  // the planner: system and user prompt for the three modes, with and without a presenter, in two languages
  for (const mode of ['motion', 'mix', 'ai_video']) {
    out[`plan.system.${mode}`] = planLib.systemPrompt({ ...base, visualMode: mode });
    out[`plan.system.${mode}.de.presenter`] = planLib.systemPrompt({ ...base, language: 'de', visualMode: mode, presenter: 'intro_outro', tone: 'friendly', capabilities: { image: false, fal: false } });
    out[`plan.user.${mode}`] = planLib.userPrompt({ ...base, visualMode: mode, nonce: 'abc123', brief: 'Short and clear.', topic: 'Heat pumps', notes: 'Heat pumps move heat. [1]', sourcesText: '[1] Agency, https://example.org/a', documentsText: '[p. 1]\nHeat pumps move heat.', brand: { name: 'Example Brand', voice: { tone: 'warm' } } });
  }
  out['plan.system.default'] = planLib.systemPrompt({});
  out['plan.user.repair'] = planLib.userPrompt({ ...base, visualMode: 'mix', nonce: 'abc123', topic: 'Heat pumps', previous: '{"scenes":[]}', problems: ['The answer has no "scenes" list.'] });
  out['plan.verify.system'] = planLib.verifySystemPrompt(base);

  // the script, its lists and the brief of every scene
  for (const mode of ['motion', 'mix']) {
    const built = planLib.buildScript(JSON.parse(JSON.stringify(ANSWER)), { ...base, visualMode: mode });
    out[`plan.script.${mode}`] = JSON.stringify(built.script);
    out[`plan.issues.${mode}`] = JSON.stringify(built.issues);
    const lists = planLib.outputsOf(built.script, { date: '2026-10-03' });
    out[`plan.lists.${mode}`] = JSON.stringify(lists);
  }

  // the writer of a scene
  const tokens = sceneLib.brandTokens(BRAND);
  const neutral = sceneLib.brandTokens(null);
  const cues = [{ id: 'e1', type: 'title', anchor: 'Heat', at: 0.2 }, { id: 'e2', type: 'number', anchor: 'power', at: 3.4 }, { id: 'e3', type: 'bullet', anchor: '', at: 5.1 }];
  const brief = 'Scene s1 · role hook · kind motion · about 7.4 s · landscape · language en\nTitle: Heat, moved\nBullets:\n- Moves heat\nNarration (for timing and context, do NOT write it on screen): A heat pump moves heat.';
  for (const format of ['landscape', 'portrait']) {
    out[`scene.system.${format}.neutral`] = sceneLib.writerSystemPrompt({ format, duration: 7.4 });
    out[`scene.system.${format}.brand`] = sceneLib.writerSystemPrompt({ format, duration: 9.2, tokens, embeddedFonts: ['Example Sans'] });
    out[`scene.system.${format}.neutral.explicit`] = sceneLib.writerSystemPrompt({ format, duration: 7.4, tokens: neutral, embeddedFonts: [] });
  }
  out['scene.user'] = sceneLib.writerUserPrompt({ brief, duration: 7.4, cues });
  out['scene.user.assets'] = sceneLib.writerUserPrompt({ brief, duration: 7.4, cues, assets: [{ kind: 'still', ext: 'png', width: 1920, height: 1080 }, { kind: 'logo', ext: 'png' }] });
  out['scene.user.nocues'] = sceneLib.writerUserPrompt({ brief: 'free <text>', duration: 5 });
  out['scene.check.system'] = sceneLib.checkSystemPrompt();
  out['scene.check.user'] = sceneLib.checkUserPrompt({ brief, cues, times: [3.4, 7.25] });
  out['scene.check.times'] = JSON.stringify([sceneLib.checkTimes(7.4, cues), sceneLib.checkTimes(7.4, []), sceneLib.checkTimes(2, cues)]);
  out['scene.retry'] = ['code', 'render', 'look'].map((kind) => sceneLib.retryMessage(kind, ['one', 'two'])).join('\n---\n');
  out['scene.fixed'] = sceneLib.fallbackHtml({ format: 'landscape', duration: 7.4, tokens, scene: { title: 'Heat, moved', bullets: ['Moves heat', 'Little power'], numbers: [] }, elements: [{ id: 'e1', type: 'title' }, { id: 'e2', type: 'bullet' }], cues: [{ id: 'e1', at: 0.2 }, { id: 'e2', at: 3.4 }] });
  out['scene.fixed.portrait.bg'] = sceneLib.fallbackHtml({ format: 'portrait', duration: 6, scene: { title: 'Four to one', bullets: [], numbers: [{ value: '4', label: 'kWh' }] }, background: true });
  const fonts = sceneLib.fontFaces([{ family: 'Example Sans', ext: '.woff2', buffer: Buffer.from('abc'), weight: '700' }]);
  out['scene.fonts'] = JSON.stringify(fonts);
  out['scene.tokens'] = JSON.stringify([tokens, neutral]);
  return out;
}

module.exports = { compute, ANSWER, BRAND };
