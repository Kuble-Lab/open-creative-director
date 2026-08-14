'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_LENGTH = 8000;
const MAX_STDOUT_LENGTH = 1024 * 1024;

function executableExtensions(env, platform) {
  if (platform !== 'win32') return [''];
  const values = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ['', ...values];
}

function isExecutable(file, platform = process.platform) {
  try {
    fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function resolveBinary(name, { env = process.env, platform = process.platform } = {}) {
  const overrideName = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  const override = String(env[overrideName] || '').trim();
  if (override) return isExecutable(override, platform) ? override : null;

  const extensions = executableExtensions(env, platform);
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function binaries(options = {}) {
  const ffmpeg = resolveBinary('ffmpeg', options);
  const ffprobe = resolveBinary('ffprobe', options);
  return { ffmpeg, ffprobe, available: Boolean(ffmpeg && ffprobe) };
}

function parseRate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(text);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2] || 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const rate = numerator / denominator;
  return rate > 0 ? rate : null;
}

function normaliseProbe(data) {
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (!video) throw new Error('Videostream fehlt');
  const audio = streams.find((stream) => stream?.codec_type === 'audio');
  const duration = Number(data?.format?.duration ?? video.duration);
  return {
    video: {
      codec: String(video.codec_name || ''),
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate)
    },
    audio: audio
      ? {
          codec: String(audio.codec_name || ''),
          sampleRate: Number(audio.sample_rate) || 0,
          channels: Number(audio.channels) || 0,
          channelLayout: String(audio.channel_layout || '')
        }
      : null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null
  };
}

function sameNumber(left, right, tolerance = 0.001) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function sameAudio(left, right) {
  if (!left || !right) return left === right;
  return left.codec === right.codec &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels &&
    left.channelLayout === right.channelLayout;
}

function concatStrategy(probes) {
  if (!Array.isArray(probes) || probes.length < 2) throw new Error('Mindestens zwei Video-Probes sind erforderlich');
  const first = probes[0];
  const copy = probes.slice(1).every((probe) =>
    probe?.video?.codec === first?.video?.codec &&
    probe?.video?.width === first?.video?.width &&
    probe?.video?.height === first?.video?.height &&
    sameNumber(probe?.video?.fps, first?.video?.fps) &&
    sameAudio(probe?.audio, first?.audio)
  );
  return copy ? 'copy' : 'reencode';
}

function runProcess(command, args, { timeoutMs = PROCESS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT_LENGTH) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-TAIL_LENGTH);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffmpeg hat nach ${Math.round(timeoutMs / 60000)} Minuten das Zeitlimit erreicht.`));
      } else if (code !== 0) {
        const detail = stderr.split(/\r?\n/).filter(Boolean).slice(-8).join(' | ');
        reject(new Error(`ffmpeg ist fehlgeschlagen (Exit ${(code ?? signal) || 'unbekannt'}): ${detail}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function probeVideo(file, { ffprobePath, timeoutMs = 30000 } = {}) {
  const command = ffprobePath || binaries().ffprobe;
  if (!command) throw new Error('ffprobe wurde nicht gefunden');
  const { stdout } = await runProcess(command, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    file
  ], { timeoutMs });
  try {
    return normaliseProbe(JSON.parse(stdout));
  } catch (err) {
    throw new Error(`ffprobe-Ausgabe fuer ${path.basename(file)} ist ungueltig: ${err.message}`);
  }
}

function escapeConcatPath(file) {
  return String(file).replace(/'/g, "'\\''");
}

function copyConcatArgs(listFile, outputFile) {
  return ['-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-y', outputFile];
}

function reencodeConcatArgs(files, probes, outputFile) {
  const first = probes[0];
  const width = first.video.width;
  const height = first.video.height;
  const fps = first.video.fps || 30;
  if (!width || !height) throw new Error('Aufloesung des ersten Clips konnte nicht ermittelt werden');

  const args = ['-nostdin', '-v', 'error'];
  for (const file of files) args.push('-i', file);
  const filters = [];
  const concatInputs = [];
  probes.forEach((probe, index) => {
    filters.push(
      `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps.toFixed(6)},format=yuv420p[v${index}]`
    );
    if (probe.audio) {
      filters.push(`[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
    } else {
      if (!probe.duration) throw new Error(`Dauer von Clip ${index + 1} konnte nicht ermittelt werden`);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${probe.duration.toFixed(6)}[a${index}]`);
    }
    concatInputs.push(`[v${index}][a${index}]`);
  });
  filters.push(`${concatInputs.join('')}concat=n=${files.length}:v=1:a=1[v][a]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-shortest', '-y', outputFile
  );
  return args;
}

async function concatVideos({ files, probes, outputFile, listFile, strategy, ffmpegPath, timeoutMs = PROCESS_TIMEOUT_MS }) {
  const command = ffmpegPath || binaries().ffmpeg;
  if (!command) throw new Error('ffmpeg wurde nicht gefunden');
  if (strategy === 'copy') {
    const content = files.map((file) => `file '${escapeConcatPath(file)}'`).join('\n') + '\n';
    await fs.promises.writeFile(listFile, content, 'utf8');
    await runProcess(command, copyConcatArgs(listFile, outputFile), { timeoutMs });
  } else {
    await runProcess(command, reencodeConcatArgs(files, probes, outputFile), { timeoutMs });
  }
}

module.exports = {
  PROCESS_TIMEOUT_MS,
  resolveBinary,
  binaries,
  normaliseProbe,
  concatStrategy,
  probeVideo,
  concatVideos,
  copyConcatArgs,
  reencodeConcatArgs
};
