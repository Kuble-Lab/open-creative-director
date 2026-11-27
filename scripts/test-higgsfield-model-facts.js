'use strict';

// Documented facts for Higgsfield models whose catalogue record leaves them out (lib/higgsfield-model-facts.js): MAGI-2
// takes up to 10 reference images and 5 audio files, costs 2.5 credits per second, and an image next to audio goes out as
// a reference, not as the start frame.

const assert = require('node:assert/strict');
const { withFacts } = require('../lib/higgsfield-model-facts');
const catalog = require('../lib/nodes/higgsfield-catalog');
const { referenceRoleFromModel, audioSlotFromModel } = require('../lib/tools/higgsfield');

// The record as models_explore returned it on 2026-11-27: one slot with all roles, no max, no credits.
const LIVE_MAGI = Object.freeze({
  id: 'magi_2',
  name: 'MAGI-2',
  type: 'video',
  credits_per_unit: null,
  medias: [{ type: 'image', roles: ['start_image', 'end_image', 'image_references', 'audio_references'] }]
});

function testFacts() {
  const before = catalog.capabilitiesOf(LIVE_MAGI, { type: 'video' });
  assert.equal(before.references.max, 1, 'without the facts the slot counts as one image');

  const magi = withFacts(LIVE_MAGI);
  assert.notEqual(magi, LIVE_MAGI, 'a new record, the cached one stays as it was');
  const caps = catalog.capabilitiesOf(magi, { type: 'video' });
  assert.equal(caps.references.max, 10);
  assert.ok(caps.references.roles.includes('image_references'));
  assert.equal(caps.audio.max, 5);
  assert.deepEqual(audioSlotFromModel(magi), { role: 'audio_references', max: 5 });
  assert.equal(catalog.creditsFor(magi, { duration: 10 }), 25, '25 credits per 10 seconds');
  assert.equal(catalog.creditsFor(magi, { duration: 30 }), 75);

  // Once Higgsfield publishes limits or a price, the live values win.
  const published = { ...LIVE_MAGI, credits_per_unit: 3, credit_unit: 'per_second', medias: [{ type: 'image', roles: ['image_references'], max: 4 }] };
  assert.equal(withFacts(published), published);
  // Other models and list entries without a media list are not touched.
  const other = { id: 'kling3_0', medias: [{ roles: ['start_image'] }] };
  assert.equal(withFacts(other), other);
  const listEntry = withFacts({ id: 'magi_2', credits_per_unit: null });
  assert.equal(listEntry.medias, undefined);
  assert.equal(listEntry.credits_per_unit, 2.5);
}

function testRoles() {
  const magi = withFacts(LIVE_MAGI);
  assert.equal(referenceRoleFromModel(magi, 'video'), 'start_image', 'one image alone animates the start frame');
  assert.equal(referenceRoleFromModel(magi, 'video', { count: 1 }), 'start_image');
  assert.equal(referenceRoleFromModel(magi, 'video', { count: 3 }), 'image_references', 'several images are references');
  assert.equal(referenceRoleFromModel(magi, 'video', { count: 1, audio: true }), 'image_references', 'an image next to audio is a reference');
  const startOnly = { id: 'x', medias: [{ roles: ['start_image'] }, { roles: ['audio'] }] };
  assert.equal(referenceRoleFromModel(startOnly, 'video', { count: 1, audio: true }), 'start_image', 'without a reference role nothing changes');
  assert.equal(referenceRoleFromModel(magi, 'image', { count: 3 }), 'image_references', 'image models keep their own order');
}

testFacts();
testRoles();
console.log('test-higgsfield-model-facts.js: ok');
