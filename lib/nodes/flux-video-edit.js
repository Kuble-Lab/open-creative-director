'use strict';

// FLUX Video Edit [fast] (black-forest-labs/flux-video-edit) through OpenRouter: edits an EXISTING video by a text instruction. The second
// model of its kind in the node "Edit video with references" (fal.video_edit) after Runway Aleph 2.0, and built the same way: this file is
// the ONE place where everything about the model is written down (the pattern of lib/nodes/aleph-edit.js), split in two:
//
//   FACTS         read on 2026-10-08 from the OpenRouter model list (GET /api/v1/videos/models), the metadata of the model (GET
//                 /api/v1/models/black-forest-labs/flux-video-edit/endpoints), its page on openrouter.ai and the documentation of the maker
//                 (docs.bfl.ml: the page "FLUX Video Edit", the API reference of the video edit tool, the price list). The live list wins
//                 where the app can read it (the price is taken from it when it is loaded; the numbers here are the fallback).
//   ASSUMPTIONS   what the app does with the model. NOTHING of it was tried with a paid run yet, so every line is marked "per live test": the
//                 list or the documentation of the maker says it (or nothing does), but nobody has seen OpenRouter hand it on that way. A
//                 paid test confirms or corrects each of them; until then the node works with them and says so in its notes.
//
// Still open until that test: the way the video travels (the same as for Aleph, input_references / video_url, which was proven for Aleph
// only), whether OpenRouter adds fields of its own to the request (the maker answers 422 to any it does not know), the limits as OpenRouter
// applies them, whether a run is billed by the length of the result (the maker) or for at least 5 s (Aleph), what comes back (length, size, 24 fps,
// the sound of the source) and what a moderated run costs.
//
// Nothing else in the code may know a limit or a field name of this model: lib/nodes/nodes-fal.js reads LIMITS and FACTS, lib/tools.js (the tool
// edit_video_openrouter) reads videoReference() and requestExtras().

const MB = 1024 * 1024;

const MODEL = 'black-forest-labs/flux-video-edit';
const NAME = 'FLUX Video Edit';

// FACTS (OpenRouter metadata and list, 2026-10-08)
//   inputs      text and video; the result is an edited video. The list names no image input (supported_frame_images null, no image
//               reference), and the maker says so: no image, no mask, no video as a style or motion reference, no extension of a clip
//   list        no resolutions, aspect ratios or durations (all null: the result follows the source); generate_audio false (the switch
//               for sound that is MADE; the sound of the source is carried through, see below) and seed false; passthrough
//               safety_tolerance (0 to 4, not used)
//   pricing     cents_per_second_output 3 and no minimum_cents_per_generation: 0.03 USD per second of the result. The maker's price list says
//               the same (0.03 USD per second, the result is as long as the source, so 10 s cost 0.30 USD whatever the edit)
// FACTS (documentation of the maker, 2026-10-08; the request that OpenRouter hands on is not known)
//   request     video (a URL or a base64 MP4), prompt (1 to 4096 characters) and safety_tolerance (optional). mode, version, seed, duration,
//               resolution, aspect_ratio and generate_audio are answered with HTTP 422
//   source      at most 15 s (a longer video is rejected, not cut), at most 50 MiB, each side at least 160 px, at least 17 frames after
//               the conversion to 24 fps (about 0.7 s); an MP4
//   result      as long as the source, the aspect ratio of the source, 24 fps whatever the source; a source over 720p is scaled down to
//               720p (a clip of 1920 x 1088 came back as 1248 x 704); the sound of the source is carried through unless the prompt asks
//               for a change of dialogue or sound, and a silent source gives a silent result
//   precedent   Runway Aleph 2.0 has the same shape in the list (no durations) and OpenRouter billed 3 s and 8 s alike, for 5 s (lib/nodes/
//               aleph-edit.js). That may be OpenRouter's default length where none is sent, so the same pattern cannot be ruled out here
const FACTS = Object.freeze({
  fetched: '2026-10-08',
  perSecondUsd: 0.03,
  minimumUsd: 0
});

// ASSUMPTIONS. Where a number is the maker's (BFL), it says so: OpenRouter publishes none of these limits.
const ASSUMPTIONS = Object.freeze({
  // per live test: the video goes in `input_references` as { type: 'video_url', video_url: { url } }, the address is a public one of this
  // server (PUBLIC_BASE_URL), not an upload to the provider. Proven for Aleph (live tests 2026-10-04), not tried with this model: the metadata
  // names video as an input, the documentation of OpenRouter says that video references are honoured only by providers that support them.
  videoReferenceType: 'video_url',
  // per live test: the request holds model, prompt and the video reference only. The maker accepts no other field (duration, resolution,
  // aspect ratio, seed, sound and mode are answered with HTTP 422), and the list names none of them. Whether OpenRouter adds a field of its
  // own on the way, which the maker would then answer with 422, is not known.
  extraFields: Object.freeze({}),
  // per live test: the shortest video. The maker needs 17 frames at 24 fps (0.71 s); 1 s keeps a margin for the conversion to 24 fps.
  minSeconds: 1,
  // per live test: the longest video of ONE run, 15 s (the maker: longer videos are rejected, not cut). A longer video is edited in parts of
  // at most that ("Edit longer videos in parts"), each paid as a run of its own, or cut to its first 15 s.
  maxSeconds: 15,
  // per live test: size of the file, 50 MiB (the maker)
  maxBytes: 50 * MB,
  // per live test: the smallest side of the video, 160 px (the maker). There is NO largest side: the maker scales a source over 720p down
  // itself, so a video of 1920 x 1080 or 3840 x 2160 is not refused here.
  minEdge: 160,
  // per live test: the longest prompt, 4096 characters (the maker; the prompt is checked before anything is uploaded)
  maxPrompt: 4096,
  // per live test: the format. The maker names MP4 (a URL or base64); the app can hand over MP4 and WebM as a public address, and WebM is
  // not offered: nobody knows whether the maker reads it.
  formats: Object.freeze(['.mp4']),
  // per live test: a run is priced for at least this many seconds, however short the video (Aleph: 3 s and 8 s were each billed for 5 s). The
  // list and the maker bill by the length of the result with no minimum, and this number is not measured here: it makes the plan and the
  // reservation of a short clip 0.15 USD instead of 0.09 USD, so that they never lie below the bill if OpenRouter does the same as for Aleph.
  // What is booked is always the usage.cost of the job, so a lower bill costs less than was reserved. Lower it (or take it away) when a paid
  // test shows what a short clip costs.
  billedMinimumSeconds: 5,
  // per live test: what happens to the aspect ratio and the frame rate of the source. The maker keeps the ratio and gives 24 fps whatever the
  // source has (30 fps stays as long, with fewer frames). The app does NOT check the ratio of the video before the run: the maker names
  // no list of ratios.
  aspectRatioChecked: false
});

// The limits in the shape of EDIT_MODELS (lib/nodes/nodes-fal.js). maxImages is 0 for a reason of the model, not of this app: it takes no image.
const LIMITS = Object.freeze({
  minSeconds: ASSUMPTIONS.minSeconds,
  maxSeconds: ASSUMPTIONS.maxSeconds,
  maxBytes: ASSUMPTIONS.maxBytes,
  minEdge: ASSUMPTIONS.minEdge,
  maxPrompt: ASSUMPTIONS.maxPrompt,
  formats: ASSUMPTIONS.formats,
  maxImages: 0
});

// The seconds a run is priced for: its length, but at least ASSUMPTIONS.billedMinimumSeconds. Every price of this model, with the live list or
// without it, counts these seconds, so the plan, the reservation and the job never differ.
function billedSeconds(seconds) {
  return Math.max(seconds, ASSUMPTIONS.billedMinimumSeconds);
}

// The price of a run: the price per second times the billed seconds, never below the minimum (none in the list). Rounded to micro dollars.
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
