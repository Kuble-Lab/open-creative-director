'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');
const brandings = require('../lib/brandings');
const discovery = require('../lib/discovery');
const gts = require('../lib/gts');
const { buildSystemPrompt, mergeBrandingIds } = require('../lib/brain');

async function main() {
  store.ensureDirs();
  const session = await store.createSession();
  const first = await brandings.createBranding({ name: 'Promptmarke', description: 'Verbindliches Design-System' });
  const second = await brandings.createBranding({ name: 'Projektmarke' });
  await brandings.updateBranding(first.id, {
    colors: [{ role: 'primary', name: 'Petrol', hex: '#0A4A55', usage: 'Hintergruende' }],
    typography: [{ role: 'headline', family: 'Suisse Intl', weights: '700', source: 'system', file: null, usage: 'Titel' }],
    voice: { tone: 'Direkt', language: 'de-CH', dos: 'Aktiv', donts: 'Floskeln' },
    formats: [{ name: 'Story/Reel', aspect_ratio: '9:16', notes: '' }],
    guidelines: 'Logo nie verzerren.'
  });

  const originalCapabilities = discovery.videoCapabilities;
  const originalGetBrain = gts.getBrain;
  const originalListAssets = gts.listAssets;
  discovery.videoCapabilities = async () => ({
    resolutions: ['720p'],
    aspectRatios: ['16:9'],
    durations: { min: 4, max: 30 },
    frameImages: ['first_frame']
  });
  gts.getBrain = async (id) => ({ id, title: 'GTS-Test', body: 'Nachgelagerter Wissenskontext' });
  gts.listAssets = async () => [];

  try {
    const effective = mergeBrandingIds([first.id], [first.id, second.id, 'drittes-branding']);
    assert.deepEqual(effective, [first.id, second.id]);
    const prompt = await buildSystemPrompt(
      session.id,
      { imageModel: 'image-test', videoModel: 'video-test', brainSeesImages: true },
      [],
      [{ id: 'gts-test', title: 'GTS-Test' }],
      { guidelines: 'Produktionsprofil', brandings: [second.id] },
      'Testprojekt',
      effective
    );
    assert.match(prompt, /# Brand system: Promptmarke/);
    assert.match(prompt, /# Brand system: Projektmarke/);
    assert.match(prompt, /#0A4A55/);
    assert.match(prompt, /Suisse Intl/);
    assert.match(prompt, /Story\/Reel: 9:16/);
    assert.match(prompt, /Logo nie verzerren/);
    assert.match(prompt, /import_branding_asset/);
    assert.ok(prompt.indexOf('# Production profile') < prompt.indexOf('# Brand system: Promptmarke'));
    assert.ok(prompt.indexOf('# Brand system: Projektmarke') < prompt.indexOf('# ATTACHED KNOWLEDGE CONTEXT'));
    console.log('Brain-Prompt: Session- und Projekt-Brandings werden dedupliziert und als Brand-system-Bloecke injiziert.');
  } finally {
    discovery.videoCapabilities = originalCapabilities;
    gts.getBrain = originalGetBrain;
    gts.listAssets = originalListAssets;
    await store.deleteSession(session.id);
    await brandings.deleteBranding(first.id).catch(() => {});
    await brandings.deleteBranding(second.id).catch(() => {});
  }
  console.log('test-branding-brain.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
