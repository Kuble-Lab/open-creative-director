'use strict';

// The fonts for captions (WP35). libass draws a character with the font that fontconfig finds for it; where no installed font has the
// script of the text (Japanese, Chinese, Korean, Arabic, Hebrew), the text shows as empty boxes. This asks fontconfig (`fc-list :lang=xx`)
// for every script that lib/captions-ass.js found in a script and returns sentences for the log. It never aborts anything: the captions
// are made in any case. The fonts-noto packages are those of Debian and Ubuntu, where the render server runs.

const { execFile } = require('child_process');

const SCRIPT_NAMES = Object.freeze({ ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ar: 'Arabic', he: 'Hebrew' });
const PACKAGES = Object.freeze({ ja: 'fonts-noto-cjk', zh: 'fonts-noto-cjk', ko: 'fonts-noto-cjk', ar: 'fonts-noto-core', he: 'fonts-noto-core' });
const TIMEOUT_MS = 5000;

// The fonts fontconfig has for a language: the output of `fc-list :lang=xx family` ('' where there are none). Rejects where fc-list cannot
// be run (not installed, no time).
function fcList(lang) {
  return new Promise((resolve, reject) => {
    execFile('fc-list', [`:lang=${lang}`, 'family'], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
  });
}

// Sentences for the log, one per script without a font; [] where all have one. `scripts` come from captionsAss.buildAss().scripts.
// `list(lang)` is what asks fontconfig (replaceable for a test).
async function fontWarnings(scripts, { list = fcList } = {}) {
  const warnings = [];
  for (const id of scripts || []) {
    if (!SCRIPT_NAMES[id]) continue;
    let output;
    try {
      output = await list(id);
    } catch (error) {
      warnings.push(`Captions in ${SCRIPT_NAMES[id]}: fc-list is not available, so the fonts could not be checked; the text needs a font with this script (${PACKAGES[id]})`);
      continue;
    }
    if (!String(output).trim()) {
      warnings.push(`Captions in ${SCRIPT_NAMES[id]}: no font for it was found (fc-list :lang=${id} is empty), so the text would show as empty boxes. Install ${PACKAGES[id]} on the machine that renders`);
    }
  }
  return warnings;
}

// What the log gets for a caption script: the notes of the script and the warnings about fonts
async function captionNotes(script, options) {
  if (!script) return [];
  return [...(script.notes || []), ...(await fontWarnings(script.scripts, options))];
}

module.exports = { SCRIPT_NAMES, PACKAGES, fcList, fontWarnings, captionNotes };
