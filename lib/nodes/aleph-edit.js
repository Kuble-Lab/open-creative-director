'use strict';

// Runway Aleph 2.0 (runway/aleph-2) through OpenRouter: edits an EXISTING video by a text instruction ("in-context editing").
// WP41. This file is the ONE place where everything about the model is written down, split in two:
//
//   FACTS         read from the OpenRouter model list (GET /api/v1/videos/models) on 2026-10-04 and measured in the two paid live tests of
//                 the same day. The live list wins where the app can read it (the price is taken from it when it is loaded; the numbers
//                 here are the fallback).
//   ASSUMPTIONS   what the app does with the model. A line marked "confirmed" was proven by the live tests of 2026-10-04. A line marked
//                 "per live test" is NOT proven, or only for what was tried (the line says what): the list does not say it, and nothing
//                 was paid to find out. A further paid test confirms or corrects each of them; until then the node works with them and
//                 says so in its notes.
//
// Still open after the two tests: a video over 8 s (is all of it edited, how is it billed), images, the size limits (16 MB, 1920 px),
// WebM, aspect ratios other than 9:16, and whether a `duration` in the request would lower the bill.
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
// FACTS (live tests, 2026-10-04, two paid runs, read from usage.cost)
//   sent        both times model, prompt and one video_url reference, nothing else; an MP4 of 720 x 1280, 30 fps, without sound:
//               3.0 s in the first run, 8.0 s in the control run of the same evening
//   came back   an edited MP4 as long as the input (3.0 s = 90 frames, 8.0 s = 240 frames at 30 fps), SMALLER than the input (612 x 1088,
//               the 9:16 of the input was kept), without sound. The first run did what the prompt asked. In the control run the WHOLE
//               video was edited, not only its first seconds: frames at 1, 4, 5.5 and 7.8 s all show the change
//   billed      1.40 USD both times, not the 0.84 (3 s) and 2.24 USD (8 s) that the list price gives: that is a flat 5 s x 0.28, whatever
//               the length of those two. OpenRouter probably takes its default of 5 s where no duration is sent. Proven is only that 3 s
//               and 8 s each cost 1.40 USD; nothing is known about 8 to 30 s, and OpenRouter may bill by length at any time.
//   price       billedMinimumSeconds is the 5 s that a run is counted for at least; priceFor() takes the longer of the video and these 5 s
//               times the price per second (at 0.28 USD per second the list's minimum of 0.56 USD is then never reached). That is an
//               UPPER bound, not the observed bill: a video over 5 s is planned by its length (8 s = 2.24 USD) although 8 s were billed
//               1.40 USD. The plan and the reservation stay on the side of more on purpose: if OpenRouter starts to bill by length, the
//               reservation must not lie below the bill. What is booked always comes from usage.cost, so the difference is not charged.
const FACTS = Object.freeze({
  fetched: '2026-10-04',
  perSecondUsd: 0.28,
  minimumUsd: 0.56,
  billedMinimumSeconds: 5
});

// ASSUMPTIONS. Where a number is that of the providers of the model (Runware: 2 to 30 s, at most 16 MB, up to 1080p), it says so:
// OpenRouter publishes none of them.
const ASSUMPTIONS = Object.freeze({
  // confirmed (live tests 2026-10-04): the video goes in `input_references` as { type: 'video_url', video_url: { url } } (like the Seedance
  // references), the address is a public one of this server (PUBLIC_BASE_URL), not an upload to the provider
  videoReferenceType: 'video_url',
  // per live test: the way to hand over images (an input_references entry of type image_url, or frame_images with keyframes) is not
  // known, so the node refuses images before the run (like Gemini Omni) instead of paying for a request that may ignore them. Not tried.
  imagesSupported: false,
  // confirmed (live tests 2026-10-04): the request holds model, prompt and the video reference only. No duration (the result is as long as
  // the video), no resolution and no aspect ratio (both follow the video): the list names none of them for this model. Whether a duration
  // in the request would change the bill (now a flat 5 s x 0.28 for 3 s and for 8 s) is not tried: the list names no durations.
  extraFields: Object.freeze({}),
  // per live test: the shortest video. 3.0 s and 8.0 s went through, nothing shorter was tried; 2 s is the number of the providers.
  minSeconds: 2,
  // confirmed up to 8 s, per live test beyond: the longest video of ONE run. 30 s is the number the providers of the model name (Runware:
  // 2 to 30 s; Runway's own API used to limit Aleph to 5 s). The live tests proved 3.0 s and 8.0 s: both came back as long as they went
  // in, the 8 s from the first to the last second edited (see FACTS). Not tried: everything between 8 s and 30 s (is all of it edited, does
  // it come back as long as it went in, is it billed by length: the price assumes the worst, see FACTS). A longer video is edited in parts
  // of at most 30 s ("Edit longer videos in parts"), each paid as a run of its own. Lower this number if a paid run with a longer video
  // shows that only a part of it is edited.
  maxSeconds: 30,
  // per live test: size and resolution of the input video (the long side; 1920 x 1080 and 1080 x 1920 pass). Tried: 720 x 1280 (3 s and
  // 8 s); a video nearer to 16 MB or 1920 px was not. The result can be smaller than the input (612 x 1088): edited parts are joined at
  // the size of the first part.
  maxBytes: 16 * MB,
  maxEdge: 1920,
  // per live test: the formats the app can hand over as a public address (the app stores MP4 and WebM). Tried: MP4. WebM was not.
  formats: Object.freeze(['.mp4', '.webm']),
  // per live test: what happens to an input video whose aspect ratio is not one of FACTS.aspect (16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16,
  // 21:9): it may be cropped, stretched or refused after payment. The app does NOT check the ratio of the video before the run (as it
  // does for the start image of Gen-4.5): nobody knows yet what the model does with it, and the common formats are all in the list.
  // Tried: 9:16 (3 s and 8 s), which came back as 9:16; no other ratio. If a live test shows that a video is cropped or refused, the
  // check belongs next to the size check of the node (checkEditVideo).
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

// The seconds a run is priced for: its length, but at least FACTS.billedMinimumSeconds (live tests: 3 s and 8 s were both billed as 5 s).
// Above 5 s that is an upper bound, not what was observed (see FACTS). Every price of Aleph, with the live list or without it, counts
// these seconds, so the plan, the reservation and the job never differ.
function billedSeconds(seconds) {
  return Math.max(seconds, FACTS.billedMinimumSeconds);
}

// The price of a run: the price per second times the billed seconds, never below the minimum. Rounded to micro dollars. A video over 5 s
// is priced by its length (8 s = 2.24 USD) although 8 s cost 1.40 USD in the live test: the reservation is meant to be too high rather
// than too low should OpenRouter start to bill by length.
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
