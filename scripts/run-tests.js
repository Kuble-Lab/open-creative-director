#!/usr/bin/env node
'use strict';

/*
 * Runs every scripts/test-*.js as its own Node process.
 *
 * A test only counts as passed when
 *   1. it exits with code 0 AND
 *   2. its last non-empty stdout line is "<file name>: ok".
 *
 * The second rule catches a silent end: a promise that never settles empties the
 * event loop and Node exits with 0 although the rest of the test never ran.
 *
 * Usage:
 *   node scripts/run-tests.js [filter ...] [--timeout=<seconds>] [--jobs=<n>] [--keep]
 *   npm test -- nodes-generate --timeout=600
 *
 * A filter is a part of a file name ("nodes-" runs every node-view test).
 * Defaults: one test after another, 240 s per test. --jobs=<n> runs several at once; tests
 * that use the shared data folders of the copy can then get in each other's way.
 *
 * The tests run in a temporary copy of the repository, never in the checkout itself: many of them
 * write sessions and files into data/, projects/ and assets/, and some load server.js, which reads
 * .env and data/settings.json. The copy holds what git tracks or would track (new files too, nothing
 * ignored: no .env, no data); node_modules are linked. It is removed at the end, --keep keeps it.
 * A test started directly (node scripts/test-....js) still runs in place.
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS_DIR = __dirname;
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const DEFAULT_TIMEOUT_SECONDS = 240;
// Tests share the data folders of the copy (data/, projects/), so by default they run one after another.
const DEFAULT_JOBS = 1;
const OUTPUT_TAIL_LINES = 25;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
// Linked into the copy instead of copied
const LINKED_DIRS = ['node_modules', path.join('render-node', 'node_modules')];
// What a copy without git (an exported tree) leaves out besides LINKED_DIRS
const SKIPPED_WITHOUT_GIT = new Set(['.git', 'node_modules', 'data', 'projects', 'assets', '.env']);

function parseArgs(argv) {
  const options = { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, jobs: DEFAULT_JOBS, filters: [], keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let match;
    if ((match = /^--timeout(?:=(.*))?$/.exec(arg))) {
      const value = match[1] !== undefined ? match[1] : argv[++i];
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--timeout needs a number of seconds above 0, got "${value}"`);
      options.timeoutSeconds = seconds;
    } else if ((match = /^--jobs(?:=(.*))?$/.exec(arg))) {
      const value = match[1] !== undefined ? match[1] : argv[++i];
      const jobs = Number(value);
      if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs needs a whole number above 0, got "${value}"`);
      options.jobs = jobs;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.filters.push(arg);
    }
  }
  return options;
}

function listTests(scriptsDir, filters) {
  return fs
    .readdirSync(scriptsDir)
    .filter((name) => /^test-.*\.js$/.test(name))
    .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
    .sort();
}

// The files of the checkout that git tracks or would track (paths relative to ROOT), or null without git.
function checkoutFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch (_) {
    return null;
  }
}

// The temporary copy the tests run in (see the top of this file). Returns its path.
function createCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-tests-'));
  const files = checkoutFiles();
  if (files) {
    for (const file of files) {
      const from = path.join(ROOT, file);
      let stat;
      try {
        stat = fs.lstatSync(from);
      } catch (_) {
        continue; // deleted in the checkout, not yet in git
      }
      const to = path.join(dir, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else if (stat.isFile()) fs.copyFileSync(from, to);
    }
  } else {
    fs.cpSync(ROOT, dir, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(ROOT, source);
        return !relative || (!SKIPPED_WITHOUT_GIT.has(relative.split(path.sep)[0]) && !LINKED_DIRS.includes(relative));
      }
    });
  }
  for (const relative of LINKED_DIRS) {
    const target = path.join(ROOT, relative);
    const link = path.join(dir, relative);
    if (!fs.existsSync(target) || fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'dir');
  }
  return dir;
}

function removeCopy(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.error(`The temporary copy ${dir} could not be removed: ${error.message}`);
  }
}

// The test processes that are running, so that an interrupted run can end them before it removes the copy.
const running = new Set();

function lastNonEmptyLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i].trim();
  }
  return '';
}

function tail(text, count) {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-count).join('\n');
}

function runTest(name, timeoutSeconds, root) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;
    let killTimer = null;

    const child = spawn(process.execPath, [path.join('scripts', name)], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    running.add(child);

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    }, timeoutSeconds * 1000);

    const done = (code, signal, spawnError) => {
      if (finished) return;
      finished = true;
      running.delete(child);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const seconds = (Date.now() - started) / 1000;
      const expected = `${name}: ok`;
      let ok = false;
      let reason = '';
      if (spawnError) {
        reason = `could not start: ${spawnError.message}`;
      } else if (timedOut) {
        reason = `timeout after ${timeoutSeconds} s`;
      } else if (code !== 0) {
        reason = signal ? `ended by signal ${signal}` : `exit code ${code}`;
      } else if (lastNonEmptyLine(stdout) !== expected) {
        reason = `silent end: exit 0, but the last stdout line is not "${expected}"`;
      } else {
        ok = true;
      }
      resolve({ name, ok, reason, seconds, stdout, stderr });
    };

    child.on('error', (error) => done(null, null, error));
    child.on('close', (code, signal) => done(code, signal, null));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/run-tests.js [filter ...] [--timeout=<seconds>] [--jobs=<n>] [--keep]');
    return 0;
  }
  if (listTests(SCRIPTS_DIR, options.filters).length === 0) {
    console.error(`No test matches ${options.filters.length ? options.filters.map((f) => `"${f}"`).join(', ') : 'scripts/test-*.js'}.`);
    return 1;
  }

  const copy = createCopy();
  // Ctrl+C or a kill: end the tests that are running, then remove the copy
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      for (const child of running) child.kill('SIGKILL');
      if (!options.keep) removeCopy(copy);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  try {
    return await runAll(options, copy);
  } finally {
    if (options.keep) console.log(`The temporary copy stays in ${copy}`);
    else removeCopy(copy);
  }
}

async function runAll(options, copy) {
  const tests = listTests(path.join(copy, 'scripts'), options.filters);
  const startedAll = Date.now();
  console.log(`Running ${tests.length} test${tests.length === 1 ? '' : 's'}, ${Math.min(options.jobs, tests.length)} in parallel, timeout ${options.timeoutSeconds} s each, in a temporary copy of the repository.`);

  const results = [];
  let next = 0;
  async function worker() {
    while (next < tests.length) {
      const name = tests[next++];
      const result = await runTest(name, options.timeoutSeconds, copy);
      results.push(result);
      const duration = `${result.seconds.toFixed(1)} s`;
      if (result.ok) {
        console.log(`PASS ${result.name} (${duration})`);
      } else {
        console.log(`FAIL ${result.name} (${duration}): ${result.reason}`);
        const output = [tail(result.stdout, OUTPUT_TAIL_LINES), tail(result.stderr, OUTPUT_TAIL_LINES)].filter(Boolean);
        if (output.length) console.log(output.join('\n').split('\n').map((line) => `    ${line}`).join('\n'));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.jobs, tests.length) }, worker));

  const failed = results.filter((result) => !result.ok).sort((a, b) => a.name.localeCompare(b.name));
  const passed = results.length - failed.length;
  const totalSeconds = ((Date.now() - startedAll) / 1000).toFixed(1);
  console.log('');
  if (failed.length) {
    console.log('Failed:');
    for (const result of failed) console.log(`  ${result.name}: ${result.reason}`);
  }
  console.log(`${passed}/${results.length} passed (${totalSeconds} s)`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  }
);
