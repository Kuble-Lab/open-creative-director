'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const ffmpeg = require('./ffmpeg');

async function validateRenderResult(file, { log = console } = {}) {
  const ffprobePath = ffmpeg.binaries().ffprobe;
  if (!ffprobePath) {
    log.warn?.('[render] ffprobe fehlt; das Ergebnis kann nicht auf einen lesbaren Videostream geprüft werden.');
    return;
  }
  let probe;
  try {
    probe = await ffmpeg.probeVideo(file, { ffprobePath });
  } catch (err) {
    throw Object.assign(new Error(`Ungültiges Render-Ergebnis: ${err.message}`), { code: 'INVALID_RESULT' });
  }
  if (!probe.video?.codec || !(probe.video.width > 0) || !(probe.video.height > 0) || !(probe.duration > 0)) {
    throw Object.assign(new Error('Das Ergebnis enthält keinen lesbaren Videostream mit positiver Dauer.'), { code: 'INVALID_RESULT' });
  }
}

async function validateRenderBuffer(buffer) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'render-result-'));
  try {
    const file = path.join(dir, 'result.mp4');
    await fsp.writeFile(file, buffer, { mode: 0o600 });
    await validateRenderResult(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { validateRenderResult, validateRenderBuffer };
