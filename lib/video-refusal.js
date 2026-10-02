'use strict';

// A video provider refuses an input image that may show a real person (Seedance of ByteDance, through OpenRouter).
//
// The refusal comes with the start of the job (HTTP 400 on POST /videos): the provider has no job then, nothing is billed,
// and the budget reservation of the call is released by the caller (lib/tools.js executeTool). OpenRouter wraps the
// provider answer, so the readable part ends up nested in the message:
//
//   OpenRouter 400: HTTP 400: {"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation","message":"The
//   request failed because the input image 'content[1]' may contain real person. Request id: ...","type":"BadRequest"}}
//
// isRealPersonRefusal() is the one place that recognises it. refusalOf() turns the raw error into a VideoRefusalError with
// a stable code (VIDEO_REAL_PERSON), a German sentence for the interface fallback, an English one for the logs and the
// node view, and the text the Director gets back. The raw provider text is kept off every message.
//
// The sentences name Seedance. So refusalOf() only takes the error of a Seedance model (the ByteDance provider) or of a
// call whose model is not known; the same wording from another provider stays that provider's own error and is not
// attributed to Seedance.
//
// A job that is refused only later, while it is polled, is another case (jobRefusalOf): the job exists then, and whether
// anything was charged is not known. It has its own code (VIDEO_REAL_PERSON_JOB) and sentences without that claim.

const CODE = 'VIDEO_REAL_PERSON';
// A click on a model the request already marked as refusing the image (checked on the server, lib/video-models.js).
const MODEL_REFUSED_CODE = 'VIDEO_MODEL_REFUSED';
// The refusal came while the job was polled, after the start (lib/poller.js).
const JOB_CODE = 'VIDEO_REAL_PERSON_JOB';
// The providers whose models the sentences are about (the part of the model id before the slash).
const SEEDANCE_PROVIDERS = Object.freeze(['bytedance']);

const CODE_PREFIX = 'InputImageSensitiveContentDetected';
const MESSAGE_PATTERN = /may contain real person/i;
// "code": "..." in plain or escaped (nested) JSON text.
const CODE_FIELD = /\\*"code\\*"\s*:\s*\\*"([^"\\]+)/g;

const MESSAGE_EN =
  'Seedance rejects images that may show a real person (safety rule of the provider). Nothing was charged for this request. ' +
  'Choose another model or an image without a real person.';
const MESSAGE_DE =
  'Seedance lehnt Bilder ab, auf denen eine echte Person zu sehen sein könnte (Schutzregel des Anbieters). ' +
  'Für diese Anfrage wurde nichts berechnet. Wähle ein anderes Modell oder ein Bild ohne reale Person.';

const MESSAGE_JOB_DE =
  'Seedance hat das Bild dieses Videos abgelehnt, weil darauf eine echte Person zu sehen sein könnte (Schutzregel des Anbieters). ' +
  'Wähle ein anderes Modell oder ein Bild ohne reale Person.';

class VideoRefusalError extends Error {
  constructor({ model = '', cause = null } = {}) {
    super(MESSAGE_EN);
    this.name = 'VideoRefusalError';
    this.code = CODE;
    this.status = 422;
    this.messageDe = MESSAGE_DE;
    this.model = String(model || '');
    this.provider = providerOf(model);
    this.cause = cause;
  }

  // What the Director reads in the tool result: the facts and what to do next.
  get directorText() {
    return directorText(this.model);
  }
}

function providerOf(model) {
  const id = String(model || '').trim().toLowerCase();
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : '';
}

function textsOf(error) {
  const found = [];
  const add = (value) => {
    if (typeof value === 'string') found.push(value);
    else if (value && typeof value === 'object') {
      try {
        found.push(JSON.stringify(value));
      } catch (_) {
        /* not serialisable: nothing to inspect */
      }
    }
  };
  if (typeof error === 'string') {
    add(error);
  } else if (error) {
    add(error.message);
    add(error.body);
    if (typeof error.code === 'string') found.push(`"code":"${error.code}"`);
  }
  return found;
}

// True when the error is the refusal of an input image that may show a real person: the provider code starts with
// InputImageSensitiveContentDetected, or the message says "may contain real person".
function isRealPersonRefusal(error) {
  for (const text of textsOf(error)) {
    if (MESSAGE_PATTERN.test(text)) return true;
    for (const match of text.matchAll(CODE_FIELD)) {
      if (match[1].startsWith(CODE_PREFIX)) return true;
    }
  }
  return false;
}

// True when the sentences of this module fit the model: a Seedance model, or no model given.
function isSeedanceModel(model) {
  const provider = providerOf(model);
  return !provider || SEEDANCE_PROVIDERS.includes(provider);
}

// The refusal as an error with the stable code, or null for any other error. `model`: the model the job was meant for.
function refusalOf(error, { model = '' } = {}) {
  if (error instanceof VideoRefusalError) return error;
  return isRealPersonRefusal(error) && isSeedanceModel(model) ? new VideoRefusalError({ model, cause: error }) : null;
}

// The refusal of a job that was already started and failed while it was polled: { code, message, directorText } or null.
// No statement about the bill: the job existed, and what the provider charged for it is not known here.
function jobRefusalOf(error, { model = '' } = {}) {
  if (!isRealPersonRefusal(error) || !isSeedanceModel(model)) return null;
  const name = model ? ` (${model})` : '';
  return {
    code: JOB_CODE,
    message: MESSAGE_JOB_DE,
    directorText:
      `Seedance${name} hat das Bild dieses Videos abgelehnt, weil darauf eine echte Person zu sehen sein könnte ` +
      '(Schutzregel des Anbieters, Ablehnung nach dem Start; ob dafür etwas berechnet wurde, steht nicht fest). ' +
      'Schlage Seedance (alle ByteDance-Modelle) mit diesem Bild nicht erneut vor. ' +
      'Biete dem User andere passende Videomodelle an oder bitte ihn um ein Bild ohne reale Person.'
  };
}

function directorText(model) {
  const name = model ? ` (${model})` : '';
  return (
    `Fehler bei generate_video: Seedance${name} hat dieses Bild abgelehnt, weil darauf eine echte Person zu sehen sein könnte ` +
    '(Schutzregel des Anbieters, Ablehnung beim Start). Es wurde nichts berechnet und kein Job gestartet. ' +
    'Schlage Seedance (alle ByteDance-Modelle) mit diesem Bild nicht erneut vor. ' +
    'Biete dem User andere passende Videomodelle an oder bitte ihn um ein Bild ohne reale Person. ' +
    'Rufst du generate_video mit demselben Bild erneut auf, bekommt der User eine Modellwahl, auf der die Seedance-Modelle für dieses Bild gesperrt sind.'
  );
}

// The text that replaces the waiting message of a request in the Director history after the refusal.
function requestWaitingText(requestId, model) {
  const name = model ? ` (${model})` : '';
  return (
    `Video-Modellwahl ${requestId} wartet weiter auf den User. Seedance${name} hat das Bild abgelehnt, weil darauf eine echte Person ` +
    'zu sehen sein könnte (Schutzregel des Anbieters, Ablehnung beim Start); es wurde nichts berechnet. Die Karte sperrt die ' +
    'Modelle dieses Anbieters für diese Anfrage. Schlage Seedance mit diesem Bild nicht erneut vor. Rufe generate_video nicht ' +
    'erneut auf, solange die Auswahl wartet. Weise den User auf andere passende Modelle der Karte oder auf ein Bild ohne reale ' +
    'Person hin.'
  );
}

module.exports = {
  CODE,
  JOB_CODE,
  MODEL_REFUSED_CODE,
  MESSAGE_EN,
  MESSAGE_DE,
  MESSAGE_JOB_DE,
  VideoRefusalError,
  directorText,
  isRealPersonRefusal,
  jobRefusalOf,
  providerOf,
  refusalOf,
  requestWaitingText
};
