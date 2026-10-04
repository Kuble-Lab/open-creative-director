'use strict';

// Runway Aleph 2.0 (runway/aleph-2) through OpenRouter: edits an EXISTING video by a text instruction ("in-context editing").
// WP41. This file is the ONE place where everything about the model is written down, split in two:
//
//   FACTS         read from the OpenRouter model list (GET /api/v1/videos/models) on 2026-10-04 and measured in the paid live test of the
//                 same day. The live list wins where the app can read it (the price is taken from it when it is loaded; the numbers
//                 here are the fallback).
//   ASSUMPTIONS   what the app does with the model. A line marked "confirmed" was proven by the live test of 2026-10-04. A line marked
//                 "per live test" is NOT proven: the list does not say it, and nothing was paid to find out. A further paid test
//                 confirms or corrects each of them; until then the node works with them and says so in its notes.
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
// FACTS (live test, 2026-10-04, one paid run, read from usage.cost)
//   sent        model, prompt and one video_url reference, nothing else; an MP4 of 3.0 s, 720 x 1280, 30 fps, without sound
//   came back   an edited MP4 that did what the prompt asked, as long as the input (3.0 s = 90 frames at 30 fps), SMALLER than the input
//               (612 x 1088, the 9:16 of the input was kept), without sound
//   billed      1.40 USD, not the 0.84 that 3 s would cost by the list: that is 5 s x 0.28. OpenRouter bills at least 5 s (it probably
//               takes its default of 5 s where no duration is sent). Proven is only that 3 s cost 1.40 USD. billedMinimumSeconds is that
//               5 s: priceFor() counts every run as at least that long (at 0.28 USD per second the list's minimum of 0.56 USD is then
//               never reached).
const FACTS = Object.freeze({
  fetched: '2026-10-04',
  perSecondUsd: 0.28,
  minimumUsd: 0.56,
  billedMinimumSeconds: 5
});

// ASSUMPTIONS. Where a number is that of the provider Runware for the same model (2 to 30 s, at most 16 MB, up to 1080p), it says so:
// OpenRouter publishes none of them.
const ASSUMPTIONS = Object.freeze({
  // confirmed (live test 2026-10-04): the video goes in `input_references` as { type: 'video_url', video_url: { url } } (like the Seedance
  // references), the address is a public one of this server (PUBLIC_BASE_URL), not an upload to the provider
  videoReferenceType: 'video_url',
  // per live test: the way to hand over images (an input_references entry of type image_url, or frame_images with keyframes) is not
  // known, so the node refuses images before the run (like Gemini Omni) instead of paying for a request that may ignore them
  imagesSupported: false,
  // confirmed (live test 2026-10-04): the request holds model, prompt and the video reference only. No duration (the result is as long as
  // the video), no resolution and no aspect ratio (both follow the video): the list names none of them for this model. Whether a duration
  // in the request would lower the bill (3 s instead of 5 s) is not tried: the list names no durations for the model.
  extraFields: Object.freeze({}),
  // per live test: the shortest video. 3.0 s went through; 2 s is the number of Runware.
  minSeconds: 2,
  // per live test: the longest video of ONE run. Only 3 s was tried (it came back as long as it went in and was billed as 5 s, see FACTS), so
  // a run takes 5 s at the most: nothing is known about a longer video (whether all of it is edited, how it is billed), and Runway's own
  // API used to limit Aleph to 5 s. A longer video is edited in parts of at most 5 s ("Edit longer videos in parts"), each paid as a run
  // of its own. Runware names 30 s for the same model: this number goes up only after a paid run with a longer video.
  maxSeconds: 5,
  // per live test: size and resolution of the input video (the long side; 1920 x 1080 and 1080 x 1920 pass). Tried: 720 x 1280. The result
  // can be smaller than the input (612 x 1088): edited parts are joined at the size of the first part.
  maxBytes: 16 * MB,
  maxEdge: 1920,
  // per live test: the formats the app can hand over as a public address (the app stores MP4 and WebM). Tried: MP4.
  formats: Object.freeze(['.mp4', '.webm']),
  // per live test: what happens to an input video whose aspect ratio is not one of FACTS.aspect (16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16,
  // 21:9): it may be cropped, stretched or refused after payment. The app does NOT check the ratio of the video before the run (as it
  // does for the start image of Gen-4.5): nobody knows yet what the model does with it, and the common formats are all in the list.
  // Tried: 9:16, which came back as 9:16. If a live test shows that a video is cropped or refused, the check belongs next to the size
  // check of the node (checkEditVideo).
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

// The seconds a run is billed for: its length, but at least FACTS.billedMinimumSeconds (live test: 3 s were billed as 5 s). Every price
// of Aleph, with the live list or without it, counts these seconds, so the plan, the reservation and the job never differ.
function billedSeconds(seconds) {
  return Math.max(seconds, FACTS.billedMinimumSeconds);
}

// The price of a run: the price per second times the billed seconds, never below the minimum. Rounded to micro dollars.
function priceFor(seconds, { perSecondUsd = FACTS.perSecondUsd, minimumUsd = FACTS.minimumUsd } = {}) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(Math.max(perSecondUsd * billedSeconds(seconds), minimumUsd) * 1e6) / 1e6;
}

// The entry of input_references that carries the video.
function videoReference(url) {
  return { type: ASSUMPTIONS.videoReferenceType, [ASSUMPTIONS.videoReferenceType]: { url } };
}

// Fields of the request besides model, prompt and the references.
function requestExtras() {
  return { ...ASSUMPTIONS.extraFields };
}

module.exports = { MODEL, NAME, FACTS, ASSUMPTIONS, LIMITS, billedSeconds, priceFor, videoReference, requestExtras };
