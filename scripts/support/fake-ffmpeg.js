'use strict';

// Test support (not a test): a stand-in for the ffmpeg binary, for tests of the code around it. It answers `-hide_banner -filters` with
// a list that has the filters it was given, and for anything else it copies the first input file to the last argument (the output) and
// writes down what it was called with - including the content of the caption script that a filter `ass=filename=...` points to, which
// is gone when the run is over. The picture is not changed: this checks the arguments, the scratch files and the refusals, not the
// result of libass. FFMPEG_PATH points the code at it.
//
//   const fake = await createFakeFfmpeg(dir, { filters: ['ass'] });   // { file, calls(), listCalls(), reset() }
//   process.env.FFMPEG_PATH = fake.file;
//   (run something that starts ffmpeg)
//   fake.calls()       // the calls that were not the list of filters: [{ argv, graph, assFile, ass }]
//   fake.listCalls()   // how often the list of filters was read
//
// createAssStandIn(dir, { real }) is the other kind: a stand-in for libass. It starts the real ffmpeg for everything, but lists the
// filter `ass` as present and takes `ass=filename=...` out of the graph (it becomes `null`), after writing down the script. So a whole
// run - batches, encoder, fade - goes through on a machine without libass, and the test sees which graph and which script ffmpeg got.

const fsp = require('fs/promises');
const path = require('path');

const PROGRAM = `
const fs = require('fs');
const argv = process.argv.slice(2);
const log = process.env.FAKE_FFMPEG_LOG;
const append = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + '\\n');
if (argv.includes('-filters')) {
  append({ kind: 'filters' });
  const names = JSON.parse(process.env.FAKE_FFMPEG_FILTERS || '[]');
  const lines = ['Filters:', '  T.. = Timeline support', '  .S. = Slice threading', '  ..C = Command support', '  | = Source or sink filter'];
  for (const name of ['overlay', 'scale', 'null', ...names]) lines.push(' T.C ' + name.padEnd(18) + ' V->V       A filter.');
  process.stdout.write(lines.join('\\n') + '\\n');
  process.exit(0);
}
// the two levels of escaping of a filter graph, undone
const unescape = (text) => text.replace(/\\\\(.)/g, '$1').replace(/\\\\(.)/g, '$1');
const entry = { kind: 'run', argv };
const at = argv.indexOf('-filter_complex');
if (at >= 0) {
  entry.graph = argv[at + 1];
  const found = /ass=filename=((?:\\\\.|[^\\[\\],;])+)/.exec(entry.graph);
  if (found) {
    entry.assFile = unescape(found[1]);
    try {
      entry.ass = fs.readFileSync(entry.assFile, 'utf8');
    } catch (err) {
      entry.assError = err.code || String(err);
    }
  }
}
append(entry);
const input = argv[argv.indexOf('-i') + 1];
fs.copyFileSync(input, argv[argv.length - 1]);
`;

const STAND_IN = `
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const argv = process.argv.slice(2);
const real = process.env.FAKE_FFMPEG_REAL;
const log = process.env.FAKE_FFMPEG_LOG;
const append = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + '\\n');
if (argv.includes('-filters')) {
  const out = spawnSync(real, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stdout || '';
  append({ kind: 'filters' });
  process.stdout.write(/^\\s*[TSC.]{2,3}\\s+ass\\s/m.test(out) ? out : out.replace(/\\n*$/, '\\n') + ' T.C ass               V->V       Render ASS subtitles (stand-in).\\n');
  process.exit(0);
}
const unescape = (text) => text.replace(/\\\\(.)/g, '$1').replace(/\\\\(.)/g, '$1');
const entry = { kind: 'run', argv, scripts: [] };
const args = argv.map((arg) => {
  if (!arg.includes('ass=filename=')) return arg;
  entry.graph = arg;
  return arg.replace(/ass=filename=((?:\\\\.|[^\\[\\],;])+)/g, (_match, escaped) => {
    const file = unescape(escaped);
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      text = null;
    }
    entry.scripts.push({ file, text });
    return 'null';
  });
});
append(entry);
const child = spawn(real, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
`;

async function createFakeFfmpeg(dir, { filters = [], name = 'ffmpeg-fake' } = {}) {
  const program = path.join(dir, `${name}.js`);
  const file = path.join(dir, name);
  const log = path.join(dir, `${name}.log`);
  await fsp.writeFile(program, PROGRAM);
  const env = `FAKE_FFMPEG_LOG=${JSON.stringify(log)} FAKE_FFMPEG_FILTERS=${JSON.stringify(JSON.stringify(filters))}`;
  await fsp.writeFile(file, `#!/bin/sh\n${env} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`, { mode: 0o755 });
  await fsp.writeFile(log, '');
  const read = async () =>
    (await fsp.readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    file,
    log,
    calls: async () => (await read()).filter((entry) => entry.kind === 'run'),
    listCalls: async () => (await read()).filter((entry) => entry.kind === 'filters').length,
    reset: () => fsp.writeFile(log, '')
  };
}

async function createAssStandIn(dir, { real, name = 'ffmpeg-ass-stand-in' }) {
  const program = path.join(dir, `${name}.js`);
  const file = path.join(dir, name);
  const log = path.join(dir, `${name}.log`);
  await fsp.writeFile(program, STAND_IN);
  const env = `FAKE_FFMPEG_LOG=${JSON.stringify(log)} FAKE_FFMPEG_REAL=${JSON.stringify(real)}`;
  await fsp.writeFile(file, `#!/bin/sh\n${env} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`, { mode: 0o755 });
  await fsp.writeFile(log, '');
  const read = async () =>
    (await fsp.readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    file,
    log,
    // the calls that ran (not the lists of filters): [{ argv, graph, scripts: [{ file, text }] }]
    calls: async () => (await read()).filter((entry) => entry.kind === 'run'),
    // the scripts that ffmpeg was asked to draw, in the order of the calls
    scripts: async () => (await read()).filter((entry) => entry.kind === 'run').flatMap((entry) => entry.scripts),
    reset: () => fsp.writeFile(log, '')
  };
}

module.exports = { createFakeFfmpeg, createAssStandIn };
