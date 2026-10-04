'use strict';

// Runway Aleph 2.0 (runway/aleph-2) through OpenRouter: edits an EXISTING video by a text instruction ("in-context editing").
// WP41. This file is the ONE place where everything about the model is written down, split in two:
//
//   FACTS         read from the OpenRouter model list (GET /api/v1/videos/models) on 2026-10-04. The live list wins where the app can
//                 read it (the price is taken from it when it is loaded; the numbers here are the fallback).
//   ASSUMPTIONS   NOT proven. The list does not say them, and nothing was paid to find out. A paid live test confirms or corrects
//                 each of them; until then the node works with them and says so in its notes. Every line is marked "per live test".
//
// Nothing else in the code may know a limit or a field name of Aleph: lib/nodes/nodes-fal.js reads LIMITS, lib/tools.js (the tool
// edit_video_openrouter) reads videoReference() and requestExtras().

const MB = 1024 * 1024;

const MODEL = 'runway/aleph-2';
const NAME = 'Runway Aleph 2.0';

// FACTS (OpenRouter metadata, 2026-10-04)
//   inputs      text, image and video; the result is an edited video (no sound: generate_audio is false)
//   aspect      16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16, 21:9
//   pricing     cents_per_second_output 28 and minimum_cents_per_generation 56: 0.28 USD per second, at least 0.56 USD per run
//   passthrough contentModeration and keyframes (not used)
const FACTS = Object.freeze({
  fetched: '2026-10-04',
  perSecondUsd: 0.28,
  minimumUsd: 0.56
});

// ASSUMPTIONS (per live test). The numbers of the lengths and sizes are those the provider Runware names for the same model: 2 to 30 s,
// at most 16 MB, up to 1080p. OpenRouter publishes none of them.
const ASSUMPTIONS = Object.freeze({
  // per live test: the video goes in `input_references` as { type: 'video_url', video_url: { url } } (like the Seedance references),
  // the address is a public one of this server (PUBLIC_BASE_URL), not an upload to the provider
  videoReferenceType: 'video_url',
  // per live test: the way to hand over images (an input_references entry of type image_url, or frame_images with keyframes) is not
  // known, so the node refuses images before the run (like Gemini Omni) instead of paying for a request that may ignore them
  imagesSupported: false,
  // per live test: the request holds model, prompt and the video reference only. No duration (the result is as long as the video), no
  // resolution and no aspect ratio (both follow the video): the list names none of them for this model
  extraFields: Object.freeze({}),
  // per live test: the length of the input video
  minSeconds: 2,
  maxSeconds: 30,
  // per live test: size and resolution of the input video (the long side; 1920 x 1080 and 1080 x 1920 pass)
  maxBytes: 16 * MB,
  maxEdge: 1920,
  // per live test: the formats the app can hand over as a public address (the app stores MP4 and WebM)
  formats: Object.freeze(['.mp4', '.webm']),
  // per live test: what happens to an input video whose aspect ratio is not one of FACTS.aspect (16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16,
  // 21:9): it may be cropped, stretched or refused after payment. The app does NOT check the ratio of the video before the run (as it
  // does for the start image of Gen-4.5): nobody knows yet what the model does with it, and the common formats are all in the list.
  // If the live test shows that a video is cropped or refused, the check belongs next to the size check of the node (checkEditVideo).
  aspectRatioChecked: false
});

// The limits in the shape of EDIT_MODELS (lib/nodes/nodes-fal.js).
const LIMITS = Object.freeze({
  minSeconds: ASSUMPTIONS.minSeconds,
  maxSeconds: ASSUMPTIONS.maxSeconds,
  maxBytes: ASSUMPTIONS.maxBytes,
  maxEdge: ASSUMPTIONS.maxEdge,
  formats: ASSUMPTIONS.formats,
  maxImages: ASSUMPTIONS.imagesSupported ? 4 : 0
});

// The least a run costs: the price per second times the length, never below the minimum. Rounded to micro dollars.
function priceFor(seconds, { perSecondUsd = FACTS.perSecondUsd, minimumUsd = FACTS.minimumUsd } = {}) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(Math.max(perSecondUsd * seconds, minimumUsd) * 1e6) / 1e6;
}

// The entry of input_references that carries the video.
function videoReference(url) {
  return { type: ASSUMPTIONS.videoReferenceType, [ASSUMPTIONS.videoReferenceType]: { url } };
}

// Fields of the request besides model, prompt and the references.
function requestExtras() {
  return { ...ASSUMPTIONS.extraFields };
}

module.exports = { MODEL, NAME, FACTS, ASSUMPTIONS, LIMITS, priceFor, videoReference, requestExtras };
