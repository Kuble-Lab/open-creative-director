'use strict';

// What Higgsfield documents for a model but its catalogue (models_explore) leaves out. Applied to every model record the
// app reads (node catalogue and tools), and only where the live record says nothing itself: once Higgsfield publishes a
// limit or a price, the live value wins.
//
// MAGI-2 (Sand AI, added 2026-11-25): the catalogue lists one media slot with the roles start_image, end_image,
// image_references and audio_references, without a max, and no credits. Higgsfield's guide
// (https://higgsfield.ai/blog/higgsfield-magi-2) says: References up to 10 images, 5 videos and 5 audio files; Frames a
// start frame with an optional end frame; 25 credits per 10 seconds (web app), 4 to 30 seconds, 1080p only.
const FACTS = Object.freeze({
  magi_2: Object.freeze({
    credits: { perUnit: 2.5, unit: 'per_second' },
    medias: [
      { type: 'image', roles: ['image_references', 'start_image', 'end_image'], max: 10 },
      { type: 'audio', roles: ['audio_references'], max: 5 }
    ]
  })
});

const hasMax = (media) => Number.isFinite(media?.max) && media.max > 0;

// The record with the documented facts filled in; the same object when nothing is known or nothing is missing.
function withFacts(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return model;
  const facts = FACTS[String(model.id || '')];
  if (!facts) return model;
  const out = { ...model };
  let changed = false;
  const priceMissing = out.credits_per_unit === null || out.credits_per_unit === undefined || out.credits_per_unit === '';
  if (facts.credits && priceMissing) {
    out.credits_per_unit = facts.credits.perUnit;
    out.credit_unit = facts.credits.unit;
    changed = true;
  }
  // Only a full record (with a media list) is completed: a list entry without medias stays "unknown" until it is read.
  if (facts.medias && Array.isArray(out.medias) && !out.medias.some(hasMax)) {
    out.medias = facts.medias.map((media) => ({ ...media, roles: media.roles.slice() }));
    changed = true;
  }
  return changed ? out : model;
}

module.exports = { withFacts, FACTS };
