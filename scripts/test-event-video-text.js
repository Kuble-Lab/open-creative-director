'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const plan = require('../lib/event-video/plan');
const composition = require('../lib/event-video/composition');
const view = require('../lib/event-video/view');
const contract = require('../lib/event-video/contract');
const { planVariant } = require('../lib/nodes/nodes-event-video');
const { rows } = require('../public/nodes/i18n-nodes');
const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'support/event-video', name), 'utf8'));
const material = load('material-60.json');
const input = {
  brief: material.brief, videos: material.videos, photos: material.photos,
  style: load('style-corporate-fresh.json'), analysis: load('beats-60.json'), musicSeconds: 62,
  options: { photoMotion: 'ai', voiceover: false, lowerThirds: true, soundbites: 'auto' }
};
function contentOf(extra = {}) {
  const request = plan.planRequest({ ...input, ...extra });
  const read = plan.validateAnswer(load('answer-ok.json'), request.ctx);
  assert.ok(read.ok, read.problems.join('; '));
  return { content: read.content, ctx: request.ctx };
}

function testAi() {
  const baseline = contentOf();
  const ref = baseline.content.aiPhotos[0].ref;
  const index = Number(ref.slice(1));
  const photos = structuredClone(input.photos);
  photos[index].vision.text = 'prominent';
  const protectedPlan = contentOf({ photos });
  assert.ok(!protectedPlan.content.aiPhotos.some((item) => item.ref === ref), 'Text is excluded from Auto');
  assert.ok(protectedPlan.content.aiPhotos.length > 0, 'Other candidates remain available');
  const made = plan.toShots(protectedPlan.content, protectedPlan.ctx);
  const item = plan.switchItems(protectedPlan.content, made, protectedPlan.ctx.material, input.options).find((item) => item.ref === ref);
  assert.ok(item && !item.on && !item.auto && !item.locked && item.textWarning, 'Text photo defaults off and remains switchable');
  const variant = planVariant({
    shots: made.shots, graphics: {}, board: '', aiPhotos: [], aiPrompts: [], parallaxPhotos: [], voLines: [],
    switches: [item], sources: made.sources, kept: { text: '{}', plain: null }
  }, photos.map((_, index) => ({ type: 'image', assetId: `photo-${index}` })), { key: 'text-protection', selection: null });
  assert.equal(JSON.parse(variant.ai_switches.value).items[0].textWarning, true, 'Approval receives the text warning');
  for (const key of ['nodes.app.switchTextWarning', 'nodes.app.photoFormats']) {
    const row = rows.find((row) => row[0] === key);
    assert.ok(row && row.slice(1).every((text) => typeof text === 'string' && text.length > 20), `${key}: DE/EN/ES available`);
  }
  for (const options of [
    { ...input.options, aiMarks: { [index]: 'always' } },
    { ...input.options, aiChoice: { [index]: 'on' } }
  ]) {
    assert.ok(contentOf({ photos, options }).content.aiPhotos.some((item) => item.ref === ref), 'Explicit choice overrides text protection');
  }
  const never = contentOf({ photos, options: { ...input.options, aiMarks: { [index]: 'never' }, aiChoice: { [index]: 'on' } } });
  assert.ok(!never.content.aiPhotos.some((item) => item.ref === ref), 'Never stays hard');
  photos[index].vision.text = 'some';
  assert.deepEqual(contentOf({ photos }).content.aiPhotos, baseline.content.aiPhotos, 'Some text keeps existing Auto behaviour');
  delete photos[index].vision.text;
  assert.deepEqual(contentOf({ photos }).content.aiPhotos, baseline.content.aiPhotos, 'Unknown text keeps existing Auto behaviour');
  // an analysis from before the field text: the risk screen_readable (a slide or screen with readable text) stands in for it
  photos[index].vision.risk = [...(photos[index].vision.risk || []), 'screen_readable'];
  assert.ok(!contentOf({ photos }).content.aiPhotos.some((item) => item.ref === ref), 'screen_readable of an older analysis is excluded from Auto');
  photos[index].vision.text = 'none';
  assert.deepEqual(contentOf({ photos }).content.aiPhotos, baseline.content.aiPhotos, 'The field text wins over the risk');
}

function testTitles() {
  const { content, ctx } = contentOf();
  content.title = null;
  content.soundbites = [];
  content.lowerThirds = [];
  content.intertitles = [{ act: 'programme', text: 'Neue Ideen' }];
  const refs = [...ctx.material.byRef.keys()].filter((ref) => ref.startsWith('p')).slice(0, 4);
  const shots = refs.map((ref, i) => ({ ref, act: 'programme', kind: ref.startsWith('v') ? 'video' : 'photo', start: 10 + i * 4, end: 14 + i * 4 }));
  const made = { shots: { shots }, biteOrder: [], pageTransitions: [], notes: [] };
  ctx.material.byRef.get(refs[1]).prominentText = true;
  shots[1].ref += '*';
  let graphics = plan.toGraphics(content, made, ctx);
  assert.equal(graphics.intertitles.length, 1);
  assert.ok(graphics.intertitles[0].start >= shots[2].start && graphics.intertitles[0].end <= shots[2].end, 'Title moves to next clean shot in its act');
  for (const ref of refs) ctx.material.byRef.get(ref).prominentText = true;
  graphics = plan.toGraphics(content, made, ctx);
  assert.equal(graphics.intertitles[0].surface, true, 'All text shots use a solid title surface');
  const chunk = { start: 10, duration: 16 };
  const data = composition.pageData({ graphics, format: '9:16', chunk });
  assert.equal(data.intertitles[0].surface, true);
  const html = view.render(data, data.intertitles[0].start + 0.6).inter;
  assert.match(html, /inset:0;background:#111214/, 'Title surface fully covers the source text');
  assert.match(html, /Neue Ideen/);
  const full = contentOf();
  const fullMade = plan.toShots(full.content, full.ctx);
  for (const unit of full.ctx.material.units) unit.prominentText = true;
  const fullGraphics = plan.toGraphics(full.content, fullMade, full.ctx);
  assert.equal(fullGraphics.title.surface, true, 'Opening title also avoids source text');
  const titleData = composition.pageData({ graphics: fullGraphics, format: '9:16', chunk: { start: 0, duration: 10 } });
  assert.match(view.render(titleData, fullGraphics.title.start + 0.6).title, /inset:0;background:#111214/);
  assert.ok(contract.checkGraphics(fullGraphics).ok, contract.checkGraphics(fullGraphics).problems.join('; '));
}

testAi();
testTitles();
console.log('test-event-video-text.js: ok');
