#!/usr/bin/env node
'use strict';

/*
 * Installer of the render agent of Open Creative Director (WP46). The app serves this file at GET /api/render-agent/package
 * with the files of the package embedded below (lib/render-agent-routes.js); install.sh and install.ps1 fetch it and run it:
 *
 *   node setup.js --server <address of the app> --code <pairing code> [--dir <folder>] [--name <name>] [--no-start]
 *   node setup.js --update --dir <folder>        (what "node agent.js update" runs: new files, same token)
 *
 * It writes the files of the package (each checked against its SHA-256) into the folder (default: ocd-render-agent in the
 * home folder), pairs the computer, installs the pinned dependencies with npm ci (HyperFrames, and ffmpeg and ffprobe when
 * they can be installed), makes sure HyperFrames has its browser and starts the agent in the foreground.
 * The pairing comes first (WP54): the code lasts 10 minutes, the slow steps may take longer (it reports the versions of the
 * package; the agent reports the real ones, ffmpeg too, at its first poll). npm ci is left out when node_modules was
 * installed from the same lockfile (a render server in the cloud starts from a snapshot that has it); an update always runs it.
 * The browser check has a time limit, and on Linux it needs unzip (without it HyperFrames hangs and then fails).
 * The token of the computer goes into agent.json (mode 600) in that folder and is never printed.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PACKAGE = /*@@PACKAGE@@*/ null;

const MIN_NODE_MAJOR = 22;
// the browser of HyperFrames: about 10 s with unzip; a download that hangs is ended after this
const BROWSER_TIMEOUT_MS = 4 * 60 * 1000;
// in node_modules: the SHA-256 of the lockfile it was installed from (npm ci removes the folder, and with it this file)
const LOCK_MARKER = '.ocd-lock-sha256';
const FILE_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const TEXTS = {
  de: {
    nodeTooOld: 'Node.js {version} ist zu alt. Der Render-Agent braucht Node.js 22 oder neuer: https://nodejs.org/',
    noPackage: 'Diese Datei enthält kein Paket. Den Befehl zum Installieren zeigt die App unter «Meine Rechner».',
    usage: 'Aufruf: node setup.js --server <Adresse der App> --code <Code> [--dir <Ordner>] [--name <Name>] [--no-start]',
    writing: 'Installiere den Render-Agent in {dir} …',
    corrupt: 'Die Datei {file} ist beschädigt angekommen. Bitte den Befehl noch einmal ausführen.',
    npm: 'Installiere HyperFrames {hyperframes} und ffmpeg (npm ci, das dauert einen Moment) …',
    npmFailed: 'npm ci ist fehlgeschlagen (Code {code}). Ist npm installiert und das Internet erreichbar?',
    npmSkipped: 'HyperFrames {hyperframes} ist schon installiert (gleiche Lock-Datei).',
    browser: 'Prüfe den Browser von HyperFrames …',
    browserFailed: 'Der Browser von HyperFrames konnte noch nicht geladen werden; er wird beim ersten Render geladen.',
    browserTimeout: 'Der Browser von HyperFrames kam nicht innert {minutes} Minuten; er wird beim ersten Render geladen.',
    unzipMissing: 'unzip fehlt: Ohne unzip lädt HyperFrames seinen Browser nicht. Installieren (z. B. sudo apt-get install -y unzip), dann lädt ihn der erste Render.',
    pairedFirst: 'Gekoppelt. Fehlt noch etwas, nach der Korrektur starten mit: {command}',
    ffmpegBundled: 'ffmpeg {version} (mitgeliefert).',
    ffmpegSystem: 'ffmpeg {version} vom System (das mitgelieferte liess sich nicht installieren).',
    ffmpegConfigured: 'ffmpeg {version} aus HYPERFRAMES_FFMPEG_PATH.',
    ffmpegMissing: 'ffmpeg und ffprobe fehlen: Das Paket konnte sie nicht installieren und auf dem PATH gibt es sie nicht. Bitte ffmpeg installieren (https://ffmpeg.org/download.html) und den Befehl noch einmal ausführen.',
    updated: 'Aktualisiert in {dir}.',
    start: 'Starten: {command}',
    starting: 'Starte den Agent (Ctrl+C beendet ihn). Später wieder starten mit: {command}'
  },
  en: {
    nodeTooOld: 'Node.js {version} is too old. The render agent needs Node.js 22 or newer: https://nodejs.org/',
    noPackage: 'This file contains no package. The app shows the command to install it under “My computers”.',
    usage: 'Usage: node setup.js --server <address of the app> --code <code> [--dir <folder>] [--name <name>] [--no-start]',
    writing: 'Installing the render agent in {dir} …',
    corrupt: 'The file {file} arrived damaged. Please run the command again.',
    npm: 'Installing HyperFrames {hyperframes} and ffmpeg (npm ci, this takes a moment) …',
    npmFailed: 'npm ci failed (code {code}). Is npm installed and the internet reachable?',
    npmSkipped: 'HyperFrames {hyperframes} is installed already (same lockfile).',
    browser: 'Checking the browser of HyperFrames …',
    browserFailed: 'The browser of HyperFrames could not be loaded yet; it is loaded on the first render.',
    browserTimeout: 'The browser of HyperFrames did not arrive within {minutes} minutes; it is loaded on the first render.',
    unzipMissing: 'unzip is missing: without unzip HyperFrames cannot load its browser. Install it (e.g. sudo apt-get install -y unzip), then the first render loads it.',
    pairedFirst: 'Paired. If something is still missing, start it after the fix with: {command}',
    ffmpegBundled: 'ffmpeg {version} (bundled).',
    ffmpegSystem: 'ffmpeg {version} from the system (the bundled one could not be installed).',
    ffmpegConfigured: 'ffmpeg {version} from HYPERFRAMES_FFMPEG_PATH.',
    ffmpegMissing: 'ffmpeg and ffprobe are missing: the package could not install them and they are not on the PATH. Please install ffmpeg (https://ffmpeg.org/download.html) and run the command again.',
    updated: 'Updated in {dir}.',
    start: 'Start: {command}',
    starting: 'Starting the agent (Ctrl+C stops it). Start it again later with: {command}'
  },
  es: {
    nodeTooOld: 'Node.js {version} es demasiado antiguo. El agente de render necesita Node.js 22 o posterior: https://nodejs.org/',
    noPackage: 'Este archivo no contiene ningún paquete. La app muestra el comando de instalación en «Mis ordenadores».',
    usage: 'Uso: node setup.js --server <dirección de la app> --code <código> [--dir <carpeta>] [--name <nombre>] [--no-start]',
    writing: 'Instalando el agente de render en {dir} …',
    corrupt: 'El archivo {file} llegó dañado. Vuelve a ejecutar el comando.',
    npm: 'Instalando HyperFrames {hyperframes} y ffmpeg (npm ci, tarda un momento) …',
    npmFailed: 'npm ci falló (código {code}). ¿Está npm instalado y hay conexión a internet?',
    npmSkipped: 'HyperFrames {hyperframes} ya está instalado (mismo archivo de bloqueo).',
    browser: 'Comprobando el navegador de HyperFrames …',
    browserFailed: 'El navegador de HyperFrames aún no se pudo descargar; se descargará en el primer render.',
    browserTimeout: 'El navegador de HyperFrames no llegó en {minutes} minutos; se descargará en el primer render.',
    unzipMissing: 'Falta unzip: sin unzip HyperFrames no puede descargar su navegador. Instálalo (p. ej. sudo apt-get install -y unzip) y el primer render lo descargará.',
    pairedFirst: 'Vinculado. Si aún falta algo, inícialo después de corregirlo con: {command}',
    ffmpegBundled: 'ffmpeg {version} (incluido).',
    ffmpegSystem: 'ffmpeg {version} del sistema (el incluido no se pudo instalar).',
    ffmpegConfigured: 'ffmpeg {version} de HYPERFRAMES_FFMPEG_PATH.',
    ffmpegMissing: 'Faltan ffmpeg y ffprobe: el paquete no pudo instalarlos y no están en el PATH. Instala ffmpeg (https://ffmpeg.org/download.html) y vuelve a ejecutar el comando.',
    updated: 'Actualizado en {dir}.',
    start: 'Iniciar: {command}',
    starting: 'Iniciando el agente (Ctrl+C lo detiene). Para iniciarlo más tarde: {command}'
  }
};

function language(env = process.env) {
  let raw = String(env.RENDER_AGENT_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase();
  if (!raw) {
    try {
      raw = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    } catch (_) {
      raw = '';
    }
  }
  if (raw.startsWith('de')) return 'de';
  if (raw.startsWith('es')) return 'es';
  return 'en';
}

const t = (key, vars = {}) => {
  const table = TEXTS[language()] || TEXTS.en;
  return String(table[key] || TEXTS.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? '' : String(vars[name])));
};

function parseArgs(argv) {
  const options = { update: false, start: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => (inline !== undefined ? inline : argv[++index]);
    if (flag === '--server') options.server = value();
    else if (flag === '--code') options.code = value();
    else if (flag === '--dir') options.dir = value();
    else if (flag === '--name') options.name = value();
    else if (flag === '--update') options.update = true;
    else if (flag === '--no-start') options.start = false;
  }
  return options;
}

// Writes one file of the package (temporary file, then rename) after checking its SHA-256.
function writeFile(dir, file) {
  const name = String(file.path || '');
  if (!FILE_PATH.test(name)) throw new Error(t('corrupt', { file: name || '-' }));
  const data = Buffer.from(String(file.base64 || ''), 'base64');
  if (crypto.createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(t('corrupt', { file: name }));
  const target = path.join(dir, ...name.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, target);
}

function startCommand(dir) {
  const agent = path.join(dir, 'agent.js');
  return /\s/.test(agent) ? `node "${agent}"` : `node ${agent}`;
}

const lockHash = (dir) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex');
  } catch (_) {
    return null;
  }
};

// Was node_modules installed from exactly this lockfile (and is HyperFrames there)?
function installedFromLock(dir) {
  const hash = lockHash(dir);
  try {
    return Boolean(hash) && fs.readFileSync(path.join(dir, 'node_modules', LOCK_MARKER), 'utf8').trim() === hash && fs.existsSync(path.join(dir, 'node_modules', 'hyperframes', 'package.json'));
  } catch (_) {
    return false;
  }
}

function markInstalled(dir) {
  const hash = lockHash(dir);
  try {
    if (hash) fs.writeFileSync(path.join(dir, 'node_modules', LOCK_MARKER), `${hash}\n`);
  } catch (_) {
    /* the next run installs again */
  }
}

// Without unzip the browser download of HyperFrames (puppeteer) hangs and fails on Linux; macOS and Windows have their own.
function unzipMissing(platform = process.platform, run = spawnSync) {
  if (platform !== 'linux') return false;
  const probe = run('unzip', ['-v'], { stdio: 'ignore' });
  return Boolean(probe.error) || probe.status !== 0;
}

async function main(argv = process.argv.slice(2)) {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!(major >= MIN_NODE_MAJOR)) {
    console.error(t('nodeTooOld', { version: process.versions.node }));
    return 1;
  }
  if (!PACKAGE || !Array.isArray(PACKAGE.files) || !PACKAGE.files.length) {
    console.error(t('noPackage'));
    return 1;
  }
  const options = parseArgs(argv);
  if (!options.update && (!options.server || !options.code)) {
    console.error(t('usage'));
    return 2;
  }
  const dir = path.resolve(options.dir || path.join(os.homedir(), 'ocd-render-agent'));
  console.log(t('writing', { dir }));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of PACKAGE.files) writeFile(dir, file);
  // agent.js needs nothing but Node itself, so it can pair before npm ci
  const agent = require(path.join(dir, 'agent.js'));

  // the pairing first, while the code is fresh: with the versions of the package (the app checks protocol and HyperFrames)
  if (!options.update) {
    const versions = { protocol: PACKAGE.protocol, agent: agent.AGENT_VERSION, hyperframes: PACKAGE.hyperframes, node: process.versions.node };
    const paired = await agent.pair({ server: options.server, code: options.code, name: options.name, base: dir, startHint: false, versions });
    if (paired !== 0) return paired;
  }

  if (!options.update && installedFromLock(dir)) {
    console.log(t('npmSkipped', { hyperframes: PACKAGE.hyperframes || '' }));
  } else {
    console.log(t('npm', { hyperframes: PACKAGE.hyperframes || '' }));
    const windows = process.platform === 'win32';
    const npm = spawnSync(windows ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: dir,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: windows
    });
    if (npm.status !== 0) {
      console.error(t('npmFailed', { code: npm.status === null ? npm.error?.code || 'signal' : npm.status }));
      if (!options.update) console.error(t('pairedFirst', { command: startCommand(dir) }));
      return 1;
    }
    markInstalled(dir);
  }

  if (unzipMissing()) {
    console.warn(t('unzipMissing'));
  } else {
    console.log(t('browser'));
    const browser = spawnSync(process.execPath, [path.join(dir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'), 'browser', 'ensure'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1', HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_SKIP_SKILLS: '1' },
      timeout: BROWSER_TIMEOUT_MS,
      killSignal: 'SIGKILL'
    });
    if (browser.error && browser.error.code === 'ETIMEDOUT') console.warn(t('browserTimeout', { minutes: Math.round(BROWSER_TIMEOUT_MS / 60000) }));
    else if (browser.status !== 0) console.warn(t('browserFailed'));
  }

  const ffmpeg = await agent.prepareFfmpeg({ base: dir, env: { ...process.env } });
  if (!ffmpeg) {
    console.error(t('ffmpegMissing'));
    if (!options.update) console.error(t('pairedFirst', { command: startCommand(dir) }));
    return 1;
  }
  console.log(t({ bundled: 'ffmpegBundled', configured: 'ffmpegConfigured' }[ffmpeg.source] || 'ffmpegSystem', { version: ffmpeg.version }));

  if (options.update) {
    console.log(t('updated', { dir }));
    return 0;
  }

  if (!options.start) {
    console.log(t('start', { command: startCommand(dir) }));
    return 0;
  }
  console.log(t('starting', { command: startCommand(dir) }));
  // The agent runs in the foreground of this terminal; Ctrl+C reaches it directly, this process only waits for it.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', ignore);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'agent.js')], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code === null ? 130 : code));
  });
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code || 0),
    (err) => {
      console.error(err?.message || err);
      process.exit(1);
    }
  );
}

module.exports = { main, parseArgs, writeFile, language, installedFromLock, markInstalled, unzipMissing, BROWSER_TIMEOUT_MS, LOCK_MARKER, TEXTS };
